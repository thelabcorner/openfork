export * as ExchangeRefactor from "./refactor"

import { RefactorEngine } from "@/refactor/engine"

/**
 * Protocol-neutral public facade for the Refactor domain engine.
 *
 * RefactorEngine owns planning, stale checks, rollback and apply semantics.
 * Native/OXP/OFXP adapters own only authority, root projection, process
 * ownership, receipts and public result shaping.
 */
export const Parameters = RefactorEngine.Parameters
export type Input = RefactorEngine.RefactorInput
export type Access = RefactorEngine.RefactorAccess
export type Metadata = RefactorEngine.Metadata

export const execute = RefactorEngine.executeRefactor

export {
  applyTextEdits,
  assertPlanFresh,
  changeDiff,
  fingerprintText,
  isGeneratedPath,
  loadPlan,
  planCacheDir,
  safeResolve,
  savePlan,
} from "@/refactor/engine"
