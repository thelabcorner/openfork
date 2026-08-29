# Session-Level UX Friction Analysis — `opencode-main.db`

Source DB: `C:\Users\slooshied\.local\share\opencode\opencode-main.db`
Cross-reference: `docs/plans/01-toolcall-error-analysis.md`

---

## 1. DB Scope Verification (REAL DATA — NO INVENTION)

- **DB exists**: 42 tables, 190 `session` rows, 19,211 `message` rows.
- **No `tool_call` table**: There is NO explicit tool-level tracking schema. Tool usage patterns must be inferred from `message.data` (JSON, truncated in query output) and `event` records.
- **Event types present** (REAL): `message.part.updated.1` (163,756), `message.removed.1` (57), `message.updated.1` (97,832), `session.created.1` (190), `session.next.model.switched.1` (20), `session.updated.1` (20,552).
- **No error-rate column or table**: Error statistics for tool calls DO NOT EXIST in this DB. Any error analysis must reference `01-toolcall-error-analysis.md`.

---

## 2. Session Efficiency Overview (REAL QUERY RESULTS)

Query: `SELECT AVG(tokens_input), AVG(tokens_output), AVG(tokens_reasoning), SUM(...), MAX(...), COUNT(*) FROM session`

| Metric | Value |
|--------|-------|
| Session count | **190** |
| Avg tokens_input / session | **1,053,313** |
| Avg tokens_output / session | **31,668** |
| Avg tokens_reasoning / session | **13,965** |
| Total tokens_input | **200,129,383** |
| Total tokens_output | **6,016,922** |
| Total tokens_reasoning | **2,653,372** |
| Max tokens_input (single session) | **10,963,869** (`ses_fc0bcded...`) |
| Max tokens_output (single session) | **309,889** (`ses_fd074a...`) |
| Avg cost / session | Not uniformly set (many 0.0) |

**Critical observation**: The average input-to-output ratio is ~33:1. That is extreme. Typical agent sessions with healthy tool flows should show ratios closer to 3:1–8:1. A 33:1 ratio strongly suggests either:
- Long context buildup with minimal agent response (high read-tax / compaction cycles), or
- Repeated context injection without productive tool-driven resolution.

---

## 3. Top Sessions by Message Volume (REAL DATA)

| session_id | msg_count |
|------------|-----------|
| `ses_fd074...` | **1,117** |
| `ses_fce9a...` | 623 |
| `ses_fc9bb...` | 574 |
| `ses_fc82e...` | 523 |
| `ses_fc80e...` | 461 |

The top session (`ses_fd074...`) has 1,117 messages and 10,807,888 input tokens / 309,889 output tokens — again confirming the 35:1 input/output ratio. This session alone represents ~5.4% of all session input tokens across the DB.

---

## 4. Token Waste Recommendations (INFERRED FROM REAL DATA)

Since `tool_call` is absent, we derive inefficiency from session-level token ratios:

1. **Compaction debt**: 20 `session.next.model.switched.1` events + 20,552 `session.updated.1` events. High update frequency without proportional output suggests context churn rather than progress.
2. **Input bloat**: Sessions with >5M input tokens and <150K output tokens (`ses_fc990ed...`: 5.29M in / 32.6K out; `ses_fbbce...`: 5.11M in / 109K out) are prime candidates for context-trimming or task-boundary splitting.
3. **Cost anomalies**: `ses_fbbce...` cost = **17.73** (highest in DB), with 5.1M input tokens, 107K reasoning tokens. This session consumed disproportionate resources. Without tool-level granularity, we cannot confirm whether this cost came from repeated bash retries, redundant read loops, or provider overhead.

---

## 5. Tool Usage Distribution — ABSENT / MUST BE CROSS-REFERENCED

**CRITICAL GAP**: No `tool_call` table exists. We cannot compute:
- `SELECT tool_name, COUNT(*), error_rate FROM tool_call GROUP BY tool_name`
- Read vs. grep vs. bash ratios
- Read→read→read friction patterns
- Average tool call count per session

**What WOULD emerge if `tool_call` existed** (projected patterns based on session token profiles):

Based on the 33:1 input/output ratio and 1,117-message peak session:
- **Read Tax estimate**: If each message includes ~2–4 read/grep calls (common in code-heavy sessions), the top session could have 2,000–4,500 file-read operations, representing significant token overhead in context windows.
- **Bash bypass likelihood**: High reasoning-token sessions (e.g., `ses_fbbce...` with 107K reasoning tokens) often correlate with complex bash-based debugging loops rather than targeted native-tool workflows.
- **Cross-tool friction**: The DB's event stream (`message.part.updated.1`) shows frequent partial message updates. In agent workflows, this typically maps to streaming tool outputs being split/reassembled — a friction point for discoverability (agent doesn't know if the tool finished) and token efficiency (repeated partial context injection).

---

## 6. Discoverability Gaps — INFERRED FROM SCHEMA + EVENTS

- **Agent tracking**: `session.agent` column exists, but no linkage to which skills/tools were actually attempted.
- **Permission tracking**: `session.permission` exists but is mostly empty (many NULL / empty strings based on query behavior).
- **No skill/tool registry integration**: There is no foreign key from `message.data` to a tool registry. Agents using native `read`, `grep`, `edit`, `bash` tools leave no durable audit trail beyond the session message JSON.

**Implication**: If an agent fails to discover a native tool (e.g., uses `bash` to grep instead of `grep` tool, or uses `bash` to edit instead of `edit`), there is zero database-level telemetry to detect that inefficiency. Only message-level JSON parsing would reveal it, which is not happening here.

---

## 7. Cross-Tool Workflow Friction (PROJECTED PATTERNS)

Based on session-level patterns that WOULD emerge from a `tool_call` table:

| Pattern | Evidence in DB | Impact |
|---------|---------------|--------|
| Read→Read→Read loops | High message count + high input tokens with low output tokens (e.g., `ses_fd074...`) | Token waste; agent reads same files repeatedly instead of caching or using `grep` |
| Bash bypass of native tools | High reasoning tokens (e.g., `ses_fbbce...`: 107K reasoning) suggest complex reasoning chains that could be replaced by targeted native tool calls | Inefficiency; bash produces unstructured output that must be re-parsed by agent |
| Repeated partial message updates | 163,756 `message.part.updated.1` events vs. 97,832 `message.updated.1` | Streaming fragmentation; agent may receive partial tool results without clear termination, leading to redundant continuation prompts |

---

## 8. Critical Findings (REAL DATA + HONEST GAPS)

### Confirmed (REAL DATA):
1. **190 sessions**, 19,211 messages, ~163K partial message updates.
2. **Average input/output ratio ~33:1** — extremely high.
3. **Peak session (`ses_fd074...`)**: 1,117 messages, 10.8M input tokens, 309K output tokens, cost 0.35.
4. **Highest-cost session (`ses_fbbce...`)**: cost 17.73, 5.1M input tokens, 107K reasoning tokens.
5. **20 model-switch events** — suggests agent/model switching mid-session, which can break context continuity and increase token overhead.

### Not Confirmed (DB MISSING):
- No `tool_call` table = no direct tool-usage statistics.
- No error-rate field = no failure pattern analysis.
- Message `data` is JSON but truncated; full parsing would be required for granular tool audit.

### Action (LINKED):
See `docs/plans/01-toolcall-error-analysis.md` for combined action on tool-level error patterns. Without that file's tool-level analysis, this session-level report can only describe structural inefficiency (token ratios, session length, cost outliers) rather than root-cause tool workflow friction.

---

## 9. Token Waste Recommendations (ACTIONABLE FROM REAL DATA)

1. **Split sessions at ~5M input tokens**: Sessions above this threshold (`ses_fc0bc...`: 10.96M, `ses_fd074...`: 10.81M, `ses_fbabe...`: 10.29M) should trigger automatic compaction or subtask splitting.
2. **Investigate cost outlier `ses_fbbce...`** (cost 17.73): Without tool-level logs, the only action possible is to flag this session ID for manual message-log review or to add `tool_call` tracking going forward.
3. **Reduce partial-update overhead**: 163,756 `message.part.updated.1` events suggest excessive streaming updates. If these correlate with tool-output streaming, enforcing complete-tool-output settlement before message promotion would cut redundant context updates.
4. **Add `tool_call` audit table**: This is the single biggest discoverability and efficiency gap. Without it, no automated analysis of read-tax, bash-bypass, or error patterns is possible.

---

## 10. Conclusion

The DB provides **robust session-level telemetry** (tokens, messages, events, cost) but **zero tool-level telemetry**. The critical UX friction patterns — read loops, bash bypass, error rates, discoverability gaps — **CANNOT BE QUANTIFIED FROM THIS DB ALONE**. They require either:
- A `tool_call` schema addition, or
- Parsing `message.data` JSON at scale (not performed here due to truncation and lack of structured schema), or
- Cross-reference with `docs/plans/01-toolcall-error-analysis.md`.

**Recommendation**: Treat this analysis as structural (token ratios, session scale, event frequency) and combine with `01-toolcall-error-analysis.md` for root-cause tool-level action.
