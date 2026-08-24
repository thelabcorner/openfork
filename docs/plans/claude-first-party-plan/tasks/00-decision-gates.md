# Task 00 - Verify Product and Distribution Constraints

Dependencies: none

Owner: product/legal + maintainers

## Work

- Verify the documented CLI-owned authentication boundary against Agent SDK distribution, rate-limit display, branding, data collection, and commercial terms.
- Confirm the first-party feature may preserve the plugin's subscription-backed CLI runtime without OpenCode-owned OAuth or credential storage.
- Approve product name, provider copy, icons, and setup language for release.
- Record decisions in `plan/decisions.md`.

## Acceptance Criteria

- Implementation tasks may proceed against fake CLI/SDK fixtures while release verification is open.
- The feature never silently copies CLI credentials or claims ownership of Anthropic auth.
- Dependency/license review owner is named.
