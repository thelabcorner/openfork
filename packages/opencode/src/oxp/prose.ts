import { OxpCode } from "./code"

/**
 * Canonical model-facing prose for OXP tools and brokered capabilities.
 *
 * Keep descriptions decision-useful and compact: say what the capability does,
 * when it is the right surface, and the most important execution boundary.
 * Argument-level mechanics belong in schemas/results, not repeated here.
 */
export const CAPABILITY_DESCRIPTIONS = Object.freeze({
  archive:
    "Inspect archive contents or read entries without extraction; create/extract verified formats when authorized. External codecs run only through OXP-owned processes.",
  browser:
    "Control the shared Desktop browser through OXP without creating a Session. Uses connector-owned tab isolation; SnapEye visual operations require an approved root.",
  code: OxpCode.DESCRIPTION,
  "file.transfer":
    "Save a ChatGPT-provided native file into an approved root. This path does not perform OpenAI API auth; authenticated OpenAI Files use direct openai_files.",
  read: "Read files and text windows in approved roots. Single media reads return image/audio or sampled video; batch media returns handles. No implicit edit grounding.",
  edit: "Surgically edit text. For create/full-replace, pass content here or prefer write; missing-file empty-oldString, prepend, and append shapes self-heal through atomic write.",
  git: "Typed Git inspection plus guarded stage/restore/commit. For a parent approved root, pass workdir to select the nested repository. Prefer over raw shell Git.",
  json: "Analyze JSON/JSONC/JSONL/BSON by validate, query, search, schema, diff, or stats. Format/patch stays dry-run unless write authority permits commit.",
  lsp: "Run bounded language-server inspection for a file inside one approved root. Native paths are virtualized and results outside the root are suppressed.",
  memory:
    "Search durable lessons and bounded recent Session evidence in an approved root. Session hits are historical, not saved memory. Remember/forget require write authority.",
  sqlite:
    "Inspect, query, mutate, explain, or export SQLite data inside one approved root. Primary, attached, and output files are independently authority-checked.",
  sympy:
    "Run bounded symbolic mathematics through SymPy in an approved root. Python executes through OXP-owned exact-argv processes with secret-stripped environment and timeout cleanup.",
  ofxp: "Use trusted remote OpenFork peers through the local OFXP runtime. OXP calls carry an explicit external principal instead of fabricating a Session identity.",
  openfork_swarm:
    "Coordinate durable OpenFork Swarms in an approved root without inventing a Session. Worker-only settlement requires an explicitly supervised real Session.",
  "openfork_session.checkpoint":
    "Inspect or restore checkpoints through supervision of an existing authorized Session. Restore remains independently write-gated and commit-revalidated.",
  openfork_worker:
    "Create/manage durable workers with workdir support. list/get report ownership only; use result/wait for live state/blockers. model_catalog lists models; agent_catalog lists agents.",
  patch:
    "Plan/apply verified multi-file patches. Default if-clean preserves safe/already-satisfied files and reports conflicts for targeted retry; apply:true stays atomic.",
  find: "Find files by glob or bounded text search inside approved roots. Literal by default; use offset/limit metadata for resumable pages or opt into regex.",
  process:
    "Run commands; process remains unrestricted. Start via argv/command; use opaque handle (never PID) for lifecycle. Upstream may reject model-authored authentication before OXP.",
  "runtime.refresh":
    "Transactionally activate a rebuilt OXP backend with content-addressed identity, bounded trial acceptance, and automatic runtime rollback without touching source or Git.",
  project:
    "Inspect bounded project snapshots (summary, structure, full), recent files, or toolchain probes. Requires an approved root; toolchain execution also requires process authority.",
  refactor:
    "Perform stale-safe TypeScript/JavaScript refactors inside one approved root. Reads, durable previews, source commits, and compiler checks are independently authorized.",
  skill:
    "Discover or load project-local SKILL.md instructions. Set workdir for a nested project inside an approved root; global/imported skills remain invisible.",
  symbols:
    "Search/outline TypeScript or JavaScript symbols and usages. Set workdir to scope a nested project inside an approved root; prefer over grep for code identity.",
  "system-one":
    "Run typed semantic inference through OpenFork's System One provider primitive in an approved root. Preserves provider/account routing and reports probabilities, usage, and cost.",
  test: "List tests cheaply or run the detected Bun/Vitest/Jest/node:test/Mocha/AVA/Playwright harness. Runs use OXP-owned processes with timeout cleanup.",
  usage:
    "Inspect supervised Session context or, with a separate default-off grant, aggregate usage, native workload (≤90d), selected summary sections, or empirical OXP attribution.",
  models:
    "Search, filter, sort and page public model metadata, with opt-in supervised Session activity. Configured access, quota and global accounting remain host-private.",
  typecheck:
    "Explain TypeScript diagnostics or run scoped/full no-emit checks. Compiler processes are OXP-owned and temporary configs stay outside the workspace.",
  web: "Fetch known HTTP(S) URLs or search the web through OpenFork's shared network executors. Requires the explicit OXP integrations grant.",
  write:
    "Create or fully replace text files atomically. Prefer for exact Markdown/code/config content; edit.content is a compatible self-healing route.",
  schedule:
    "Manage durable scheduled tasks in an approved root: create/edit, enable/disable, run now, inspect history/inbox, acknowledge results, preview, or remove.",
  "schedule.create":
    "Create one durable scheduled task in an approved root from a relative delay, timestamp, or recurring schedule. Requires automation authority; creates no Session.",
} as const)

export const DIRECT_TOOL_DESCRIPTIONS = Object.freeze({
  read: CAPABILITY_DESCRIPTIONS.read,
  edit: CAPABILITY_DESCRIPTIONS.edit,
  git: CAPABILITY_DESCRIPTIONS.git,
  patch: CAPABILITY_DESCRIPTIONS.patch,
  find: CAPABILITY_DESCRIPTIONS.find,
  process: CAPABILITY_DESCRIPTIONS.process,
  write: CAPABILITY_DESCRIPTIONS.write,
  openai_files:
    "List/get/upload/download OpenAI Files through OXP's trusted OpenAI connection and approved-root paths.",
  capability:
    "Discover/call OpenFork/MCP tools. On describe, focusAction selects one operation; guidanceMode=full restores all parameter help. Code Mode: describe code, then call code. Use direct tools for authenticated work.",
  openfork_info:
    "Call status first with sessionTitle (this conversation's own title); it identifies the logical session. Status: roots, grants, schema fingerprint, recent incidents. Read-only.",
  openfork_diagnostics:
    "Read recent sanitized OXP internal-error incidents by incident ID. Uses only in-memory diagnostics and the authenticated OXP connection; it does not load workspace state or OXP configuration.",
  openfork_session:
    "Session recall/control. search defaults to newest matching evidence and returns explicit event/record/retrieval-time provenance; Session updatedAt is record mutation, not guaranteed conversation activity or liveness. Newer recalled evidence normally supersedes older mutable-state claims, but live code/runtime is authoritative. Use relevance ranking for intentional historical/corroborative recall. turn waits exact turn; send queues; steer safe-boundary. send/steer admit, not execute.",
  openfork_request:
    "List/reply supervised Session permissions and questions. Resolve each blocked worker by sessionID, then wait again. External paths are reject-only; approved roots bound authority.",
  openfork_worker:
    "Manage durable workers. list/get show ownership, not liveness; use result/wait for live state and blockers via openfork_request. Use model_catalog/agent_catalog for choices.",
} as const)

export function capabilityDescription(id: keyof typeof CAPABILITY_DESCRIPTIONS) {
  return CAPABILITY_DESCRIPTIONS[id]
}

export function directToolDescription(id: keyof typeof DIRECT_TOOL_DESCRIPTIONS) {
  return DIRECT_TOOL_DESCRIPTIONS[id]
}

export * as OxpProse from "./prose"
