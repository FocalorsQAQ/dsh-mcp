import type { ApiEntry } from './credential-contract.ts';
import type { ModelDraft } from './model-config-contract.ts';

export function probeRequest(api: Pick<ApiEntry, 'protocol' | 'base_url'>, draft: ModelDraft) {
  const first = draft.reasoning_levels?.[0] ?? null; // Preserve the user's order, never sort it.
  const base = api.base_url.replace(/\/+$/, '');
  const body: Record<string, unknown> = { model: draft.model_id, stream: false };
  if (api.protocol === 'openai_responses') {
    Object.assign(body, { input: '.', max_output_tokens: 16, store: false });
    if (first) body.reasoning = { effort: first };
    return { url: base + '/responses', body, output_limit: 16, reasoning: first };
  }
  body.messages = [{ role: 'user', content: '.' }];
  if (api.protocol === 'anthropic') {
    // Current Messages schema accepts zero for an input-only access/cache probe.
    Object.assign(body, { max_tokens: 0, thinking: { type: !first || first === 'none' ? 'disabled' : 'adaptive' } });
    if (first && first !== 'none') body.output_config = { effort: first };
    return { url: base + (base.endsWith('/v1') ? '/messages' : '/v1/messages'), body, output_limit: 0, reasoning: first };
  }
  if (api.protocol === 'deepseek') Object.assign(body, { max_tokens: 1, thinking: { type: 'disabled' } });
  else { body.max_completion_tokens = 1; if (first) body.reasoning_effort = first; }
  return { url: base + '/chat/completions', body, output_limit: 1, reasoning: api.protocol === 'deepseek' ? 'none' : first };
}
export interface ProbeResult { status: 'verified' | 'failed' | 'unknown'; input_tokens: number | null; output_tokens: number | null;
  error_code: string | null; http_status: number | null }
const count = (value: unknown): number | null => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;

/** Exactly one HTTP request; never redirect, retry or increase the token cap. No response text leaves this module. */
export async function probeModel(api: ApiEntry, draft: ModelDraft, key: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<ProbeResult> {
  const result: ProbeResult = { status: 'unknown', input_tokens: null, output_tokens: null, error_code: 'MODEL_VERIFY_UNKNOWN', http_status: null };
  const request = probeRequest(api, draft);
  try {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (api.protocol === 'anthropic') { headers['x-api-key'] = key; headers['anthropic-version'] = '2026-10-21'; }
    else headers.authorization = 'Bearer ' + key;
    const response = await fetcher(request.url, { method: 'POST', headers, body: JSON.stringify(request.body), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    result.http_status = response.status;
    if (!response.ok) { await response.body?.cancel(); return { ...result, status: 'failed', error_code: 'MODEL_VERIFY_HTTP' }; }
    if (!response.body) return result;
    let text = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > 262144) throw new Error('Probe response too large');
    }
    const data = JSON.parse(text);
    if (!data || data.error) return { ...result, status: 'failed', error_code: 'MODEL_VERIFY_RESPONSE' };
    let valid = false;
    if (api.protocol === 'openai_responses') {
      valid = data.object === 'response' && (data.status === 'completed' || (data.status === 'incomplete' && data.incomplete_details?.reason === 'max_output_tokens')) && Array.isArray(data.output);
      result.input_tokens = count(data.usage?.input_tokens); result.output_tokens = count(data.usage?.output_tokens);
    } else if (api.protocol === 'anthropic') {
      valid = data.type === 'message' && data.role === 'assistant' && Array.isArray(data.content);
      const input = count(data.usage?.input_tokens), cacheRead = count(data.usage?.cache_read_input_tokens ?? 0), cacheWrite = count(data.usage?.cache_creation_input_tokens ?? 0);
      result.input_tokens = input !== null && cacheRead !== null && cacheWrite !== null ? count(input + cacheRead + cacheWrite) : null;
      result.output_tokens = count(data.usage?.output_tokens);
    } else {
      valid = data.object === 'chat.completion' && Array.isArray(data.choices) && data.choices.length > 0 && data.choices[0]?.message?.role === 'assistant';
      result.input_tokens = count(data.usage?.prompt_tokens); result.output_tokens = count(data.usage?.completion_tokens);
    }
    return { ...result, status: valid ? 'verified' : 'failed', error_code: valid ? null : 'MODEL_VERIFY_RESPONSE' };
  } catch { return result; }
}
