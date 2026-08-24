# Task 05 - Session Binding and Resume

Dependencies: `03-agent-runtime`, `04-tool-permission-bridge`

Owner: session/storage maintainer

## Work

- Define the OpenCode-owned binding schema and lifecycle.
- Replace the external plugin's global short-hash JSON map as the long-term source.
- Validate project/worktree, cwd, model family, settings digest, and transcript existence before resume.
- Implement stale-binding invalidation and bounded history-transfer fallback.
- Test concurrent turns, retries, interruption, and process restart.

## Acceptance Criteria

- Project A cannot resume project B's Claude transcript.
- Missing or mismatched external sessions produce an honest fresh-session/history-transfer result.
- Resume state survives the supported restart path without becoming a second transcript authority.
- Binding cleanup does not delete user-owned Claude files.
