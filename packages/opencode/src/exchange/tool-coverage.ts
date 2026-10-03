export * as ExternalToolCoverage from "./tool-coverage"

import type { Ofxp } from "@opencode-ai/schema/ofxp"

export type CoverageKind = "augmentation" | "supervision" | "delegation" | "parent-native" | "transport"
export type OfxpMode = "capability" | "semantic" | "alias" | "intrinsic"
export type OfxpPlane = Ofxp.Plane | "intrinsic"

export interface OfxpEquivalent {
  readonly surface: string
  readonly mode: OfxpMode
  readonly plane: OfxpPlane
  readonly authorities: readonly Ofxp.CapabilityClass[]
}

/**
 * Canonical disposition of OpenFork's provider-facing native tools onto every
 * first-party external-agent transport.
 *
 * The native ToolRegistry remains the source of truth for which tools exist.
 * This table answers a different question: what is the semantically-correct
 * external equivalent?  It intentionally permits aliases and higher-order
 * supervision/delegation mappings where blindly invoking the native Tool.Def
 * would invent a backing Session or duplicate an owner.
 */
export interface Entry {
  readonly native: string
  readonly kind: CoverageKind
  readonly oxp?: string
  readonly ofxp: OfxpEquivalent
  readonly note: string
}

const eq = (
  surface: string,
  mode: OfxpMode,
  plane: OfxpPlane,
  authorities: readonly Ofxp.CapabilityClass[],
): OfxpEquivalent => Object.freeze({ surface, mode, plane, authorities: Object.freeze([...authorities]) })

const entries = [
  { native: "invalid", kind: "transport", ofxp: eq("protocol.validation", "intrinsic", "intrinsic", []), note: "Malformed calls are rejected by the transport/schema boundary before leaf execution." },
  { native: "question", kind: "parent-native", oxp: "openfork_request", ofxp: eq("request.question", "semantic", "supervision", ["requestSupervision"]), note: "Questions belong to an explicitly supervised target Session; OFXP never invents a Session merely to ask one." },
  { native: "bash", kind: "augmentation", oxp: "process", ofxp: eq("process", "alias", "augmentation", ["process"]), note: "The external process owner is the typed equivalent of the native bash/shell surface." },
  { native: "read", kind: "augmentation", oxp: "read", ofxp: eq("read", "capability", "augmentation", ["read"]), note: "Approved-root file inspection." },
  { native: "find", kind: "augmentation", oxp: "find", ofxp: eq("find", "capability", "augmentation", ["read"]), note: "Approved-root name/content discovery." },
  { native: "edit", kind: "augmentation", oxp: "edit", ofxp: eq("edit", "capability", "augmentation", ["write"]), note: "Stale-safe precision editing under explicit write authority." },
  { native: "write", kind: "augmentation", oxp: "write", ofxp: eq("write", "capability", "augmentation", ["write"]), note: "Atomic create/full-replace with commit-boundary protection." },
  { native: "task", kind: "delegation", oxp: "openfork_worker", ofxp: eq("worker", "semantic", "delegation", ["delegation"]), note: "Subagent work is explicit remote delegation, not a fabricated parent Session tool call." },
  { native: "web", kind: "augmentation", oxp: "web", ofxp: eq("web", "capability", "augmentation", ["integrations"]), note: "Session-independent remote fetch/search integration." },
  { native: "todowrite", kind: "supervision", oxp: "openfork_session.todo", ofxp: eq("session.todo", "semantic", "supervision", ["sessionSupervision"]), note: "Todo state is Session-owned and mutates only an explicitly supervised Session." },
  { native: "skill", kind: "augmentation", oxp: "skill", ofxp: eq("skill", "capability", "augmentation", ["read"]), note: "Approved-root project skill discovery/loading." },
  { native: "archive", kind: "augmentation", oxp: "archive", ofxp: eq("archive", "capability", "augmentation", ["read", "write", "process"]), note: "Archive inspection/create/extract; stronger actions are gated at call time." },
  { native: "json", kind: "augmentation", oxp: "json", ofxp: eq("json", "capability", "augmentation", ["read", "write"]), note: "Bounded JSON-family analysis and guarded commit operations." },
  { native: "background", kind: "augmentation", oxp: "process", ofxp: eq("process", "alias", "augmentation", ["process"]), note: "Background jobs are process handles/lifecycle; delegated model work uses worker delegation." },
  { native: "memory", kind: "augmentation", oxp: "memory", ofxp: eq("memory", "capability", "augmentation", ["read", "write"]), note: "Explicit-root project/workspace memory with action-specific authority." },
  { native: "sqlite", kind: "augmentation", oxp: "sqlite", ofxp: eq("sqlite", "capability", "augmentation", ["read", "write"]), note: "Approved-root SQLite inspect/query/run/export with action-specific authority." },
  { native: "git", kind: "augmentation", oxp: "git", ofxp: eq("git", "capability", "augmentation", ["git"]), note: "Typed Git remains a dedicated authority domain and never falls through to shell." },
  { native: "checkpoint", kind: "supervision", oxp: "openfork_session.checkpoint", ofxp: eq("session.checkpoint", "semantic", "supervision", ["read", "write", "sessionSupervision"]), note: "Checkpoint/recovery state is Session/worktree-owned; restore also requires write authority." },
  { native: "goal", kind: "supervision", oxp: "openfork_session.goal", ofxp: eq("goal", "semantic", "supervision", ["automation", "sessionSupervision"]), note: "Goals are durable Session-owned automation." },
  { native: "scheduled_task", kind: "augmentation", oxp: "schedule", ofxp: eq("schedule", "capability", "augmentation", ["automation"]), note: "Durable scheduled automation is independently grantable and does not require a backing parent Session." },
  { native: "swarm", kind: "delegation", oxp: "openfork_swarm", ofxp: eq("swarm", "semantic", "delegation", ["delegation", "sessionSupervision"]), note: "Native Swarm is higher-order durable collaboration/delegation, not filesystem augmentation." },
  { native: "swarm_create", kind: "delegation", oxp: "openfork_swarm", ofxp: eq("swarm", "alias", "delegation", ["delegation", "sessionSupervision"]), note: "Direct creation-only facade over the same native Swarm owner; broad admin/read/recovery remains lazy." },
  { native: "swarm_member", kind: "supervision", oxp: "openfork_swarm", ofxp: eq("swarm", "alias", "supervision", ["sessionSupervision"]), note: "Session-derived worker collaboration (settle/send/inbox/shared state/publish) is the same Swarm owner observed through the caller's own binding. It never invents a Swarm or member identity for an external principal; remote peers use the swarm delegation surface instead." },
  { native: "session", kind: "supervision", oxp: "openfork_session", ofxp: eq("session", "semantic", "supervision", ["sessionSupervision"]), note: "Inspect/control explicitly authorized existing native Sessions." },
  { native: "typecheck", kind: "augmentation", oxp: "typecheck", ofxp: eq("typecheck", "capability", "augmentation", ["read", "process"]), note: "Explain is read-only; actual compiler/package checks execute processes and require process authority." },
  { native: "project", kind: "augmentation", oxp: "project", ofxp: eq("project", "capability", "augmentation", ["read"]), note: "Bounded project/toolchain/structure inspection." },
  { native: "symbols", kind: "augmentation", oxp: "symbols", ofxp: eq("symbols", "capability", "augmentation", ["read"]), note: "AST-aware symbol inspection under approved-root read authority." },
  { native: "test", kind: "augmentation", oxp: "test", ofxp: eq("test", "capability", "augmentation", ["read", "process"]), note: "Test listing is read-only; test execution runs project code and requires process authority plus non-replay receipt semantics." },
  { native: "tool", kind: "augmentation", oxp: "capability", ofxp: eq("capability", "intrinsic", "intrinsic", []), note: "Both external transports have their own stable lazy list/describe/call broker; the local broker is never nested." },
  { native: "refactor", kind: "augmentation", oxp: "refactor", ofxp: eq("refactor", "capability", "augmentation", ["read", "write", "process"]), note: "Approved-root stale-safe source refactoring; source probes require read, durable previews/applies require write, and the optional diagnostic gate requires process authority." },
  { native: "sympy", kind: "augmentation", oxp: "sympy", ofxp: eq("sympy", "capability", "augmentation", ["process"]), note: "Bounded symbolic-computation subprocess capability." },
  { native: "patch", kind: "augmentation", oxp: "patch", ofxp: eq("patch", "capability", "augmentation", ["write"]), note: "Canonical guarded multi-file patch capability." },
  { native: "apply_patch", kind: "augmentation", oxp: "patch", ofxp: eq("patch", "alias", "augmentation", ["write"]), note: "Provider-specific apply_patch spelling projects to the same patch owner." },
  { native: "browser", kind: "augmentation", oxp: "browser", ofxp: eq("browser", "capability", "augmentation", ["browser"]), note: "Shared Desktop browser with external-principal isolation and explicit browser authority." },
  { native: "ofxp", kind: "augmentation", oxp: "ofxp", ofxp: eq("peer", "intrinsic", "intrinsic", []), note: "OFXP is the peer broker itself and is never recursively re-exported through a peer." },
  { native: "execute", kind: "parent-native", oxp: "capability", ofxp: eq("capability", "intrinsic", "intrinsic", []), note: "Code-mode is model-side orchestration; external parents already orchestrate through their stable capability broker." },
  { native: "lsp", kind: "augmentation", oxp: "lsp", ofxp: eq("lsp", "capability", "augmentation", ["read"]), note: "Approved-root LSP inspection." },
  { native: "plan_exit", kind: "parent-native", ofxp: eq("session.plan_exit", "semantic", "supervision", ["sessionSupervision"]), note: "Local plan mode belongs to its Session; remote control targets an explicitly supervised Session." },
] as const satisfies readonly Entry[]

export const ENTRIES: readonly Entry[] = entries
export const BY_NATIVE: ReadonlyMap<string, Entry> = new Map(entries.map((entry) => [entry.native, entry]))

export function assertNativeCovered(nativeToolIDs: readonly string[]) {
  const missing = [...new Set(nativeToolIDs)].filter((id) => !BY_NATIVE.has(id)).sort()
  if (missing.length > 0) {
    throw new Error(`External native-tool parity is incomplete. Add an explicit semantic disposition for: ${missing.join(", ")}`)
  }
}

export function ofxpCapabilityTargets() {
  return new Set(
    entries
      .filter((entry) => entry.ofxp.mode === "capability" || entry.ofxp.mode === "alias")
      .map((entry) => entry.ofxp.surface),
  )
}

export interface OfxpExecutionReport {
  readonly executableSurfaces: readonly string[]
  readonly pendingSurfaces: readonly string[]
  readonly unmappedExecutable: readonly string[]
  readonly nativeImplemented: readonly string[]
  readonly nativePending: readonly string[]
}

/**
 * Compare semantic parity against the real OFXP runtime catalog.
 *
 * This deliberately accepts the executable set from the OFXP dispatcher. The
 * parity ledger is not allowed to declare itself implemented.
 */
export function ofxpExecutionReport(executable: Iterable<string>): OfxpExecutionReport {
  const runtime = new Set(executable)
  const mappedCapabilitySurfaces = ofxpCapabilityTargets()
  const executableSurfaces = [...runtime].filter((surface) => mappedCapabilitySurfaces.has(surface)).sort()
  const pendingSurfaces = [...mappedCapabilitySurfaces].filter((surface) => !runtime.has(surface)).sort()
  const unmappedExecutable = [...runtime].filter((surface) => !mappedCapabilitySurfaces.has(surface)).sort()
  const nativeImplemented = entries
    .filter((entry) =>
      (entry.ofxp.mode === "capability" || entry.ofxp.mode === "alias") && runtime.has(entry.ofxp.surface),
    )
    .map((entry) => entry.native)
    .sort()
  const nativePending = entries
    .filter((entry) =>
      (entry.ofxp.mode === "capability" || entry.ofxp.mode === "alias") && !runtime.has(entry.ofxp.surface),
    )
    .map((entry) => entry.native)
    .sort()
  return Object.freeze({
    executableSurfaces: Object.freeze(executableSurfaces),
    pendingSurfaces: Object.freeze(pendingSurfaces),
    unmappedExecutable: Object.freeze(unmappedExecutable),
    nativeImplemented: Object.freeze(nativeImplemented),
    nativePending: Object.freeze(nativePending),
  })
}

