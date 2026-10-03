// Sensitivity band for a published full-window request capacity.
//
// The pure math lives in `@opencode-ai/schema/model-select/capacity-window-range`
// so it stays shared with the server Capacity projection and the Usage Yield
// pricing engine instead of drifting into a UI component. This module is the
// renderer's import path, mirroring `model-general-yield.ts`.
export * from "@opencode-ai/schema/model-select/capacity-window-range"