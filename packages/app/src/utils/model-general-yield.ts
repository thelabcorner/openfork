// Generalized usage-yield repricing for the renderer.
//
// The implementation lives in `@opencode-ai/schema/model-select/general-yield` so
// the pure pricing math stays shared with the server Capacity projection and the
// Usage Yield ranking engine instead of drifting into UI components. This module
// is kept as the renderer's import path, mirroring `model-usage-yield.ts`.
export * from "@opencode-ai/schema/model-select/general-yield"