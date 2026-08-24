# Task 07 - Quota and Observability Integration

Dependencies: `02-auth-and-availability`, `06-provider-models-and-ui`, `00-decision-gates`

Owner: quota/telemetry maintainer

## Work

- Keep quota as advisory and separate from inference authorization.
- Reconcile the existing Claude quota adapter with CLI-backed status and usage without making it the inference authority.
- Preserve the five-minute upstream usage cache and the plugin's rate-limit endpoint/fast-fail behavior.
- Add redacted runtime/turn/resume/tool diagnostics and a support report.
- Keep product/legal verification visible in release metadata, but do not replace the parity implementation with API-key-only behavior.

## Acceptance Criteria

- Quota reads do not gate or interrupt inference.
- Upstream usage requests are bounded and cached.
- Telemetry contains categories/counts/latencies only, never prompts, tool arguments, paths, or tokens.
- UI copy accurately states whether a value is CLI/Anthropic usage, cached, stale, rate-limited, or unavailable.
