# Claude subscription runtime — upstream synchronization audit (2026-10-16)

Scope: first-party OpenFork provider `claude`, **not** the external `claude-code` plugin or the `claude-api` API-key route. Baseline: OpenChamber `openchamber/opencode-claude` tag `v1.4.1` (2026-10-13), with the SDK package metadata from npm on 2026-10-16. Source of truth remains OpenFork's V1 production session architecture and `AGENTS.md`.

## Dependency and architecture

- `packages/opencode/src/claude/models.ts`: passive, zero-spawn bootstrap model catalog and the SDK-account-scoped authoritative model list; `model-discovery.ts`: SDK `supportedModels()` refresh and single-flight caching. Do **not** spawn a Claude process merely to render the model picker.
- `packages/opencode/src/claude/availability.ts`, `process.ts`: CLI path discovery, authentication-process launching and health checks. CLI owns credentials; OpenFork does not write or parse them.
- `packages/opencode/src/session/llm.ts` -> `session/llm/claude-runtime.ts` -> `claude/runtime.ts`: host LLM events, tool permissions/scope/BridgeStore, runtime Agent SDK lifecycle, interrupt/drain, and exact terminal outcomes.
- `packages/opencode/src/claude/sessions.ts`: external transcript binding, verified leaves, history transfer. Distinct session ownership is mandatory for maintenance calls and main chat continuations.
- `packages/opencode/package.json` and `bun.lock`: `@anthropic-ai/claude-agent-sdk` requirement and lock bumped from `^0.3.224` / resolved `0.3.286` to an **exact-pinned** `0.3.301` / resolved `0.3.301`. The official npm registry supplied platform-variant integrity metadata for the lock. Verified the new SDK's declarations still include `supportedModels()`, `pathToClaudeCodeExecutable`, `executable`, `resumeSessionAt`, `persistSession`, and thinking-token metadata.

## Implemented alignment and regression gates

1. Bootstrap uses concrete Opus 5.5, Sonnet 5.5 (base and optional 1M), Haiku 5.5 **fixed 1M**, Fable 5.1, Sonnet 5, Opus 4.8 and Haiku 4.5. These rows are bootstrap only; a nonempty account-scoped SDK list wins. Legacy selections still have identity aliases. 1M numbers are nominal window limits; do not apply a second artificial reservation on top of the host's reserve.
2. Windows: direct Agent SDK child launch never receives an npm `.cmd`/`.bat` shim. Prefer native `claude.exe`, unwrap older installs to `cli.js` with SDK `executable: "node"`, search subsequent PATH entries if a shim cannot unwrap, and retain ComSpec-aware authentication subprocess behavior. Resolution performs no subprocess probing.
3. Runtime: a pre-aborted turn cannot create a Claude process. An SDK stream that closes without a terminal result is a failure even if it emitted init/assistant text; no synthetic success is persisted.
4. Transfer: when transcript continuity is unavailable, include the names, IDs, errors and bounded outputs of already-completed tool calls. Mark transferred tool results as **already executed**. Favor the latest messages when bounded by character budget. This is lossy text history only, not a replacement for native structured transcript resume.
5. Tools: enforce a finite execution deadline from the bridge entry. Combine SDK and Session cancellation, signal the executing tool, terminalize an unresponsive tool even if its promise never settles, and reject an abort that races before the scheduled tool microtask. An uncooperative operation may continue underlying external side effects; cancellation is cooperative below this boundary.
6. Custom instructions: pass explicit OpenFork agent prompt and user system instruction through dedicated structured fields into the Agent SDK's preset append, rather than concatenating `prepared.system` and duplicating Claude Code's own preset or CLAUDE.md imports.
7. Usage: retain cache-read, cache-write and noncached input components from the terminal SDK result; report inclusive input once through the canonical `Usage` contract. Preserve thinking tokens as a subset of output.

## Verification

- Final scoped Bun suite (`test/claude`, `src/claude/tests/models.test.ts`, `src/claude/tests/discovery.test.ts`): **167 passed, 0 failed; 734 expectations across 12 files**, using native Linux Bun 1.3.14 in the WSL tunnel after the final code changes.
- Tests cover the static catalog and SDK refresh, interrupted tool execution, terminal-acknowledgement failures, Windows `.cmd` vs executable resolution, JS-only Node fallback, completed tool-transfer text, bounded recent history, and custom agent prompts.
- A real authenticated Windows CLI/Agent SDK smoke, full production build, and clean frozen-lockfile install have **not** been demonstrated by the WSL tunnel. The native repo tools installed for Windows cannot be run directly inside that tunnel. Do not classify these as passed.
- Final native TypeScript Go typecheck (`tsgo --noEmit --project packages/opencode/tsconfig.json`) completed with **0 compiler diagnostics**, after fixing 8 initially caught history-transfer discriminant/narrowing errors. The conventional JS `tsc` path was prohibitively slow in this WSL tunnel and was terminated; it is not claimed as a separate successful check. `git diff --check` completed without patch whitespace errors.

## Remaining high-value investigation

- **Context accounting:** the SDK's terminal `result.usage` may aggregate multiple Anthropic calls within a single tool-heavy turn; an OpenCode context estimate should reflect the latest *context window*, not the sum of repeatedly included prompt tokens. Validate an actual multi-call trace and separate billing totals from the last-call context footprint before changing normalization.
- **Mid-tool compaction:** add a fully integrated compaction-and-recovery fixture in which one or more tools are pending. The saved summary must distinguish host interruption from user refusal and preserve settled tool results.
- **Approval latency:** tool execution is bounded, but a human approval request intentionally remains outside the execution timer. If approvals need lease/timeouts, implement them at the permission owner to avoid mislabeling human delay as tool failure.
- **Performance characterization:** measure cold CLI discovery (expected no child process), SDK first-turn spawn, large-turn transfer conversions, and parallel tool scheduling on the actual Windows host. No performance increase is claimed without those measurements.
- **Windows integration:** native `claude.exe` and JS-only `cli.js` branches have fixture coverage; authenticated real CLI startup, login renewal, process-tree teardown and updates still need Windows runtime evidence. No credentials or CLI-owned transcript files should be modified by tests.

Upstream: https://github.com/openchamber/opencode-claude/tree/v1.4.1 and https://github.com/openchamber/opencode-claude/blob/main/CHANGELOG.md
