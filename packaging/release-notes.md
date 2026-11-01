Settings can now be edited before any agent runs. Codex captures an immutable outsourcing configuration when a task is submitted: enablement, top-level concurrency, delegation limits, budgets, and selected models/efforts. Later edits apply to future submissions; running agents and their descendants retain their original requirements.

The floating panel no longer selects a chat or shows spending/token cards. It aggregates online subagents across works; expand the count for work names, agent names, models and reasoning efforts. The orb uses the same aggregate count. Chinese and English remain supported.

**Upgrade setup:** restart Codex and open `Review task hook.cmd`. Enter `/hooks` in the Codex CLI to review and trust the dsh `UserPromptSubmit` hook before submitting a new task. Installation only registers the hook; it does not bypass trust. Missing snapshots block outsourcing. This integration is validated for local Codex execution, not cloud orchestration. Turning the default switch off now disables future submissions, rather than stopping existing tasks.

Budgets remain independent `[USD,CNY]` balances. Models are frozen per turn; deleting or changing an API source still revokes it. Existing task ledgers and API credentials are preserved. The new `Dashboard` adapter is available for custom UIs.

The Windows x64 installer downloads the compiled application and matching DeepSeek Harness CLI core from this dsh GitHub release and verifies SHA-256. Manual ZIP installation requires **both ZIP files**, extracted to the same folder, followed by `Initialize.cmd` and `Connect to Codex.cmd`. Project source is MIT; upstream components retain their licenses.

Validation uses local mock model services only: unit tests, real Codex submission hooks and MCP routing, real Harness CLI tasks, independent chat ledgers, dashboard controls, bilingual windows, orb dragging/restoration, and upgrade/uninstall checks. No paid API requests are made.
