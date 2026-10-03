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
  "file.transfer":
    "Save a ChatGPT-provided native file into an approved root. This path does not perform OpenAI API auth; authenticated OpenAI Files use direct openai_files.",
  read:
    "Read bounded files/directories inside approved roots. Batches isolate ordinary item errors; authority, path-escape, cancel, and system failures abort the batch.",
  edit:
    "Surgically edit text. For create/full-replace, pass content here or prefer write; missing-file empty-oldString, prepend, and append shapes self-heal through atomic write.",
  git:
    "Typed Git inspection plus guarded stage/restore/commit. For a parent approved root, pass workdir to select the nested repository. Prefer over raw shell Git.",
  json:
    "Analyze JSON/JSONC/JSONL/BSON by validate, query, search, schema, diff, or stats. Format/patch stays dry-run unless write authority permits commit.",
  lsp:
    "Run bounded language-server inspection for a file inside one approved root. Native paths are virtualized and results outside the root are suppressed.",
  memory:
    "Read or update OpenFork project/workspace memory inside one approved root. Reads require read authority; remember/forget revalidate write authority at commit.",
  sqlite:
    "Inspect, query, mutate, explain, or export SQLite data inside one approved root. Primary, attached, and output files are independently authority-checked.",
  sympy:
    "Run bounded symbolic mathematics through SymPy in an approved root. Python executes through OXP-owned exact-argv processes with secret-stripped environment and timeout cleanup.",
  ofxp:
    "Use trusted remote OpenFork peers through the local OFXP runtime. OXP calls carry an explicit external principal instead of fabricating a Session identity.",
  openfork_swarm:
    "Coordinate durable OpenFork Swarms in an approved root without inventing a Session. Worker-only settlement requires an explicitly supervised real Session.",
  "openfork_session.checkpoint":
    "Inspect or restore checkpoints through supervision of an existing authorized Session. Restore remains independently write-gated and commit-revalidated.",
  openfork_worker:
    "Create/manage durable workers with workdir support. list/get report ownership only; use result/wait for live state/blockers. model_catalog lists models; agent_catalog lists agents.",
  patch:
    "Plan/apply verified multi-file patches. Default if-clean preserves safe/already-satisfied files and reports conflicts for targeted retry; apply:true stays atomic.",
  find:
    "Find files by glob or bounded text search inside approved roots. Literal by default; use offset/limit metadata for resumable pages or opt into regex.",
  process:
    "Run commands; process remains unrestricted. Start via argv/command; use opaque handle (never PID) for lifecycle. Upstream may reject model-authored authentication before OXP.",
  "runtime.refresh":
    "Transactionally activate a rebuilt OXP backend with content-addressed identity, bounded trial acceptance, and automatic runtime rollback without touching source or Git.",
  project:
    "Inspect project structure, stack/toolchain metadata, and recent files without opening arbitrary source bodies.",
  refactor:
    "Perform stale-safe TypeScript/JavaScript refactors inside one approved root. Reads, durable previews, source commits, and compiler checks are independently authorized.",
  skill:
    "Discover or load project-local SKILL.md instructions inside one approved root. Global, external-config, remote-cached, and imported skills stay invisible.",
  symbols:
    "Search, outline, or find TypeScript/JavaScript symbol usages with AST-aware attribution inside an approved root. Prefer over grep for code identity.",
  "system-one":
    "Run typed semantic inference through OpenFork's System One provider primitive in an approved root. Preserves provider/account routing and reports probabilities, usage, and cost.",
  test:
    "List tests cheaply or run the detected Bun/Vitest/Jest/node:test/Mocha/AVA/Playwright harness. Runs use OXP-owned processes with timeout cleanup.",
  typecheck:
    "Explain TypeScript diagnostics or run scoped/full no-emit checks. Compiler processes are OXP-owned and temporary configs stay outside the workspace.",
  web:
    "Fetch known HTTP(S) URLs or search the web through OpenFork's shared network executors. Requires the explicit OXP integrations grant.",
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
    "Discover/call optional OpenFork or MCP capabilities. Do not route authenticated work through this generic broker; use purpose-specific tools.",
  openfork_info:
    "Inspect OXP status, roots, grants, schema fingerprint, or compact capability catalog. Read-only.",
  openfork_session:
    "Session: root-scoped search (`tool:read term`); list/get/messages/checkpoints; send/turn; todos/goals; no hydration.",
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
