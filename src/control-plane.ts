import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { DshError } from './types.ts';
import { ModelCatalog } from './models.ts';
import { PythonBilling } from './billing.ts';
import type { RuntimeModels } from './runtime-models.ts';
import type { OutsourcingSwitch } from './global-control.ts';
import { DEEPSEEK_SCHEDULE_ID, pricingSchedule, requestPricePeriod } from './pricing-time.ts';
import { controlStateSchema, policyPatchSchema, policySchema, tokenUsageSchema,
  type ControlPolicy, type ControlState, type Money, type RequestCharge, type TokenUsage, type AgentPolicyView } from './control-contract.ts';

const ZERO = (): Money => [0, 0];
const zeroTokens = (): TokenUsage => ({ input_cache_miss: 0, input_cache_hit: 0, output: 0 });
const nano = (money: Money): Money => money.map(value => Math.floor(value * 1e9)) as Money;
const wire = (money: Money): Money => money.map(value => value / 1e9) as Money;
const add = (a: Money, b: Money): Money => a.map((value, i) => {
  const sum = value + b[i]!;
  if (!Number.isSafeInteger(sum)) throw new DshError('ACCOUNTING', 'Accounting integer range exceeded.');
  return sum;
}) as Money;
const min = (a: Money | null, b: Money | null): Money | null => !a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1])];
const remaining = (limit: Money | null, used: Money): Money | null => limit === null ? null :
  nano(limit).map((value, i) => Math.max(0, value - used[i]!)) as Money;

/** Trusted application service. UI adapters use it; model-facing tools never receive its mutations. */
export class ControlPlane {
  private state: ControlState;
  private changes = new EventEmitter();
  selection?: RuntimeModels;
  constructor(initial: ControlPolicy, saved: ControlState | undefined, private readonly persist: () => void,
    private readonly now: () => number = () => Date.now(), private readonly billing = new PythonBilling(), readonly models = new ModelCatalog(),
    readonly globalControl?: OutsourcingSwitch) {
    this.changes.setMaxListeners(0);
    const round = randomUUID();
    this.state = saved ? controlStateSchema.parse(saved) : {
      version: 1, revision: 0, task_id: randomUUID(), policy: policySchema.parse(initial),
      current_round_id: round, rounds: [{ id: round, spent_nano: ZERO() }], task_spent_nano: ZERO(),
      tokens: zeroTokens(), requests: [], last_request: null, accounting_blocked: false,
    };
    // Crash recovery never refunds a request whose remote outcome is unknown.
    for (const request of this.state.requests.filter(item => item.status === 'reserved')) this.finish(request, null, 'unknown');
  }
  exportState(): ControlState { return structuredClone(this.state); }
  get policy(): ControlPolicy { return { ...structuredClone(this.state.policy), ...(this.globalControl ? { enabled: this.globalControl.enabled } : {}) }; }
  globalControlChanged(): void { this.changes.emit('change'); }
  get currentRound(): string { return this.state.current_round_id; }
  subscribe(listener: () => void): () => void {
    const safe = () => { try { listener(); } catch { /* Observer errors cannot refund or bypass reservations. */ } };
    this.changes.on('change', safe); return () => this.changes.off('change', safe);
  }
  private commit(): void { this.state.revision++; this.persist(); this.changes.emit('change'); }
  private cas(revision: number): void {
    if (revision !== this.state.revision) throw new DshError('CONTROL_CONFLICT', 'Control state changed; refresh the snapshot before updating.');
  }
  updatePolicy(patch: unknown, expectedRevision: number) {
    this.cas(expectedRevision);
    const parsed = policyPatchSchema.parse(patch);
    if (this.globalControl && parsed.enabled !== undefined) throw new DshError('GLOBAL_CONTROL_SCOPE', 'Use setOutsourcingEnabled with the global revision to change the shared switch.');
    this.state.policy = policySchema.parse({ ...this.state.policy, ...parsed });
    this.commit(); return this.snapshot();
  }
  beginRound(id: string, expectedRevision: number) {
    this.cas(expectedRevision);
    if (!id.trim() || id.length > 200) throw new DshError('INPUT', 'A host-supplied round ID of 1–200 characters is required.');
    if (!this.state.rounds.some(round => round.id === id)) this.state.rounds.push({ id, spent_nano: ZERO() });
    if (id !== this.state.current_round_id) { this.state.current_round_id = id; this.commit(); }
    return this.snapshot();
  }
  windowIntent(window: 'api_keys' | 'models') {
    if (!['api_keys', 'models'].includes(window)) throw new DshError('INPUT', 'Unknown management window.');
    return { contract_version: 1, type: 'open_window', window, implemented: true } as const;
  }
  async refreshModels() {
    const result = await this.models.refresh({ apiKey: process.env.DEEPSEEK_API_KEY ?? '' });
    this.commit(); return result;
  }
  assertEnabled(): void {
    if (this.globalControl) this.globalControl.assertEnabled();
    else if (!this.state.policy.enabled) throw new DshError('OUTSOURCING_DISABLED', '外包已禁用');
  }
  private round(id: string) {
    const round = this.state.rounds.find(item => item.id === id);
    if (!round) throw new DshError('ROUND_REQUIRED', 'The host must establish a budget round before dispatch.');
    return round;
  }
  private reserved(roundId?: string): Money {
    return this.state.requests.filter(item => item.status === 'reserved' && (!roundId || item.round_id === roundId))
      .reduce((sum, item) => add(sum, item.reserved_nano), ZERO());
  }
  private available(roundId: string): Money | null {
    const policy = this.state.policy;
    return min(remaining(policy.task_budget, add(this.state.task_spent_nano, this.reserved())),
      remaining(policy.round_budget, add(this.round(roundId).spent_nano, this.reserved(roundId))));
  }
  assertDispatch(roundId: string, model: string) {
    this.assertEnabled(); this.round(roundId);
    if (this.state.accounting_blocked) throw new DshError('ACCOUNTING_BLOCKED', 'Provider usage exceeded its reviewed limits; new API calls are blocked.');
    const info = this.models.get(model);
    if (info?.pricing_error) throw new DshError('PRICING_INVALID', info.pricing_error);
    if (!info?.pricing || !info.context_window || !info.max_output_tokens) throw new DshError('MODEL_UNPRICED', 'No reviewed request limit and price for model: ' + model);
    if (this.now() >= Date.parse(info.pricing.valid_until)) throw new DshError('PRICING_EXPIRED', 'Refresh the reviewed price catalog before making paid requests.');
    const available = this.available(roundId);
    const billingCurrency = this.selection?.currency(model) ?? this.state.policy.billing_currency;
    if (info.billing_currencies && !info.billing_currencies.includes(billingCurrency)) throw new DshError('MODEL_UNPRICED', 'No reviewed price for this billing currency.');
    const currency = billingCurrency === 'USD' ? 0 : 1;
    if (available && available[currency] <= 0) throw new DshError('BUDGET_EXHAUSTED', 'The shared main-agent round or task budget is exhausted.');
    return info;
  }
  reserve(agentId: string, roundId: string, model: string, maxTokens: number) {
    const info = this.assertDispatch(roundId, model);
    if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new DshError('INPUT', 'Invalid API max_tokens.');
    const currency = this.selection?.currency(model) ?? this.state.policy.billing_currency;
    const available = this.available(roundId);
    const startedAt = new Date(this.now()).toISOString();
    const quote = this.billing.quote({ model, currency, rates: info.pricing![currency], input_limit: info.context_window!,
      max_tokens: Math.min(maxTokens, info.max_output_tokens!), available_nano: available, started_at: startedAt });
    const { max_tokens: output, reserved_nano: reserved, rates } = quote;
    if (available && reserved.some((value, i) => value > available[i]!)) throw new DshError('BUDGET_RESERVATION', 'Insufficient shared budget for the next API request.');
    add(add(this.state.task_spent_nano, this.reserved()), reserved); // Check integer capacity before committing.
    const request: RequestCharge = { id: randomUUID(), agent_id: agentId, round_id: roundId, model,
      started_at: startedAt, finished_at: null, status: 'reserved', reserved_nano: reserved, cost_nano: ZERO(),
      billing_context: quote.context, billing_rules_hash: quote.rules_hash, billing_error: null,
      pricing_schedule_id: info.pricing!.schedule_id, pricing_period: null, cost_basis: 'peak_upper_bound', settled_rates: null,
      usage: null, currency, rates, input_limit: info.context_window!, output_limit: output };
    this.state.requests.push(request);
    this.commit(); // Durable reservation BEFORE any upstream bytes are sent.
    return { id: request.id, max_tokens: output };
  }
  settle(id: string, usage: TokenUsage | null, outcome: 'complete' | 'unknown' | 'rejected'): void {
    const request = this.state.requests.find(item => item.id === id);
    if (!request) throw new DshError('ACCOUNTING', 'Unknown API reservation.');
    if (request.status !== 'reserved') return; // Duplicate end callbacks cannot double charge.
    this.finish(request, usage, outcome); this.commit();
  }
  private finish(request: RequestCharge, usage: TokenUsage | null, outcome: 'complete' | 'unknown' | 'rejected'): void {
    const parsed = usage === null ? null : tokenUsageSchema.safeParse(usage);
    const valid = parsed?.success ? parsed.data : null;
    request.status = outcome === 'complete' && valid ? 'settled' : outcome === 'rejected' ? 'rejected' : 'unknown';
    request.usage = request.status === 'settled' ? valid : null;
    request.finished_at = new Date(this.now()).toISOString();
    request.cost_nano = request.status === 'rejected' ? ZERO() : request.reserved_nano;
    if (request.status === 'settled') {
      const period = request.pricing_schedule_id === DEEPSEEK_SCHEDULE_ID
        ? requestPricePeriod(request.started_at, request.finished_at) : 'unknown';
      try {
        const result = this.billing.settle(request, valid!, request.finished_at, period);
        add(this.state.task_spent_nano, result.cost_nano);
        add(this.round(request.round_id).spent_nano, result.cost_nano);
        Object.assign(request, result);
      } catch {
        request.status = 'unknown'; request.usage = null; request.billing_error = 'BILLING_ENGINE';
        this.state.accounting_blocked = true; // Never refund a paid call because customization failed.
      }
    } else if (request.status === 'rejected') request.cost_basis = 'no_charge';
    if (request.cost_nano.some((value, i) => value > request.reserved_nano[i]!) ||
      (request.usage && (request.usage.input_cache_miss + request.usage.input_cache_hit > request.input_limit || request.usage.output > request.output_limit))) this.state.accounting_blocked = true;
    this.state.task_spent_nano = add(this.state.task_spent_nano, request.cost_nano);
    const round = this.round(request.round_id);
    round.spent_nano = add(round.spent_nano, request.cost_nano);
    if (request.usage) for (const key of Object.keys(this.state.tokens) as Array<keyof TokenUsage>) this.state.tokens[key] += request.usage[key];
    this.state.last_request = structuredClone(request);
    const retained = this.state.requests.filter(item => item.status !== 'reserved').slice(-100);
    this.state.requests = this.state.requests.filter(item => item.status === 'reserved' || retained.includes(item));
  }
  agentInfo(roundId = this.currentRound): AgentPolicyView {
    const policy = this.policy;
    const effective = min(policy.round_budget === null ? null : nano(policy.round_budget), remaining(policy.task_budget, this.state.task_spent_nano));
    const available = this.available(roundId);
    return { enabled: policy.enabled, message: policy.enabled ? '外包可用；预算由服务端强制执行。' : '外包已禁用',
      max_root_agents: policy.max_root_agents, allow_secondary: policy.allow_secondary,
      max_depth_user: policy.max_depth_user, max_children_user: policy.max_children_user,
      round_id: roundId, budget: effective === null ? null : wire(effective), available_budget: available === null ? null : wire(available),
      selected_models: this.selection?.managed ? this.selection.selected().map(row => row.model_id) : null,
      model_selection_available: !!this.selection?.managed };
  }
  snapshot() {
    const last = this.state.last_request;
    return { contract_version: 1, revision: this.state.revision, task_id: this.state.task_id, round_id: this.currentRound,
      settings: this.policy, agent: this.agentInfo(), global_control: this.globalControl?.status() ?? null,
      metrics: { task_cost: wire(this.state.task_spent_nano), round_cost: wire(this.round(this.currentRound).spent_nano),
        last_api_cost: last ? wire(last.cost_nano) : ZERO(), reserved_cost: wire(this.reserved()),
        last_api_tokens: structuredClone(last?.usage ?? null), tokens: structuredClone(this.state.tokens),
        last_api_status: last?.status ?? null, last_api_request_id: last?.id ?? null,
        cost_basis: 'estimated' as const, last_api_cost_basis: last?.cost_basis ?? null,
        last_api_price_period: last?.pricing_period ?? null, accounting_blocked: this.state.accounting_blocked },
      pricing: { ...structuredClone(pricingSchedule), current_period: requestPricePeriod(this.now(), this.now()), catalog: this.models.pricingStatus() },
      windows: { api_keys: { implemented: true }, models: { implemented: true } },
      capabilities: { model_selection: !!this.selection?.managed, model_discovery: true, host_round_binding: true },
      models: this.models.list(),
    };
  }
}
