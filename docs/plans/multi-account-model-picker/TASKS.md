# Multi-account model picker — verification matrix

**Status:** Prior multi-policy task plan superseded by [the canonical specification](../../architecture/model-picker-account-routing.md).

Active acceptance criteria:

1. Exactly Adaptive and Round Robin are shown for hosted account-routing choice.
2. Adaptive prioritizes eligible account quota pressure and actual usage; Round Robin rotates without utilization preference.
3. Explicit account selection persists a pin and cannot silently change to another credential.
4. Old saved unpinned selections decode to Adaptive; new writes encode the canonical strategy type.
5. Zero-account and stale-roster cases do not fabricate credentials; all connected account rows remain selectable independent of exhaustion/cooldown.
6. Test execution through Schema, Core, V1 provider, OXP, picker, and generated clients. Preserve unrelated scheduled-task Session policies and external provider contract semantics.
