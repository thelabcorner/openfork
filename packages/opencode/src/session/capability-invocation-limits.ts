import { CODE_RUN_TRACE_MAX_FRAMES } from "@opencode-ai/schema/session-v1"

export const CAPABILITY_INVOCATION_LIMITS = {
  maxCalls: 256,
  maxDepth: 16,
  maxConcurrency: 8,
  maxTraceFrames: CODE_RUN_TRACE_MAX_FRAMES,
  maxTraceMetadataBytes: 8 * 1024,
} as const