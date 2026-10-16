import { Effect, Schema, Stream } from "effect"
import { ChildProcess } from "effect/unstable/process"
import { AppProcess } from "@opencode-ai/core/process"
import * as Tool from "./tool"
import { InstanceState } from "@/effect/instance-state"
import { BrokerContract } from "./broker-contract"
import DESCRIPTION from "./github.txt"

const DEFAULT_MAX_BYTES = 120_000
const MAX_MAX_BYTES = 500_000
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_PROCESS_ARG_CHARS = 24_000
const MAX_STDIN_BYTES = 2_000_000
const BLOCKED_API_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "host",
  "connection",
  "transfer-encoding",
  "content-length",
  "content-type",
  "x-github-otp",
])

const READ_COMMANDS = {
  repo: new Set(["view", "list"]),
  issue: new Set(["list", "view", "status"]),
  pr: new Set(["list", "view", "status", "checks", "diff"]),
  run: new Set(["list", "view"]),
  workflow: new Set(["list", "view"]),
  release: new Set(["list", "view"]),
  search: new Set(["code", "commits", "issues", "prs", "repos"]),
  label: new Set(["list"]),
  cache: new Set(["list"]),
  ruleset: new Set(["list", "view", "check"]),
} as const

const WRITE_COMMANDS = {
  issue: new Set(["create", "edit", "comment", "close", "reopen", "lock", "unlock", "pin", "unpin", "delete"]),
  pr: new Set([
    "create",
    "edit",
    "comment",
    "close",
    "reopen",
    "merge",
    "ready",
    "review",
    "update-branch",
    "lock",
    "unlock",
  ]),
  run: new Set(["rerun", "cancel", "delete"]),
  workflow: new Set(["run", "enable", "disable"]),
  release: new Set(["edit", "delete"]),
  label: new Set(["create", "edit", "delete", "clone"]),
  cache: new Set(["delete"]),
} as const

const HELP_TOPICS = new Set([
  "api",
  "auth",
  "cache",
  "issue",
  "label",
  "pr",
  "release",
  "repo",
  "ruleset",
  "run",
  "search",
  "status",
  "workflow",
])

const BLOCKED_COMMAND_FLAGS = new Set([
  "--web",
  "--body-file",
  "--notes-file",
  "--input",
  "--show-token",
  "--editor",
  "--attach",
  "--worktree",
  "--checkout",
  "--recover",
])

const TARGETED_PR_WRITES = new Set([
  "edit",
  "comment",
  "close",
  "reopen",
  "merge",
  "ready",
  "review",
  "update-branch",
  "lock",
  "unlock",
])

type Access = "read" | "write"

export const Parameters = Schema.Struct({
  action: Schema.optional(
    Schema.Literals(["status", "help", "catalog", "describe", "command", "api", "graphql"]),
  ).annotate({
    description:
      "Operation (default status). catalog searches the GitHub capability index; describe details one catalog ref; command runs a curated gh command; api performs REST; graphql performs GraphQL; help prints gh help for an approved topic.",
  }),
  argv: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(80))).annotate({
    description:
      'command: argv after "gh", e.g. ["pr","view","123","--json","title,body,state"]. help: optional topic path, e.g. ["pr","create"].',
  }),
  repo: Schema.optional(Schema.String).annotate({
    description: "Optional [HOST/]OWNER/REPO context. Exposed to gh as GH_REPO and used for API placeholders.",
  }),
  host: Schema.optional(Schema.String).annotate({
    description: "Optional GitHub hostname, e.g. github.com or github.example.com.",
  }),
  endpoint: Schema.optional(Schema.String).annotate({
    description:
      'api: REST endpoint relative to the GitHub API host, e.g. "repos/{owner}/{repo}/issues". Absolute URLs are rejected.',
  }),
  method: Schema.optional(Schema.Literals(["GET", "HEAD", "POST", "PATCH", "PUT", "DELETE"])).annotate({
    description: "api HTTP method. Defaults to POST when body is supplied, otherwise GET.",
  }),
  params: Schema.optional(Schema.Unknown).annotate({
    description: "api: flat query-parameter object. Scalars and scalar arrays are supported.",
  }),
  body: Schema.optional(Schema.Unknown).annotate({
    description: "api: JSON request body. Not accepted for GET/HEAD.",
  }),
  query: Schema.optional(Schema.String).annotate({
    description: "graphql: GraphQL document.",
  }),
  q: Schema.optional(Schema.String).annotate({
    description: "catalog: free-text search over the GitHub capability index.",
  }),
  kind: Schema.optional(Schema.Literals(["command", "api", "graphql"])).annotate({
    description: "catalog: restrict results to one index kind.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 }))).annotate({
    description: "catalog: max results (default 10, max 25).",
  }),
  ref: Schema.optional(Schema.String).annotate({
    description: "describe: exact catalog ref, e.g. github:api:GET /repos/{owner}/{repo}/issues.",
  }),
  variables: Schema.optional(Schema.Unknown).annotate({
    description:
      "graphql: variables object. Arbitrary JSON is supported normally; paginated GraphQL currently requires scalar variables.",
  }),
  paginate: Schema.optional(Schema.Boolean).annotate({
    description:
      "Follow all pages. REST pagination is GET-only. GraphQL pagination requires $endCursor and pageInfo{hasNextPage,endCursor}.",
  }),
  slurp: Schema.optional(Schema.Boolean).annotate({
    description: "With paginate, wrap pages in an outer JSON array.",
  }),
  jq: Schema.optional(Schema.String).annotate({
    description: "Apply gh's jq-compatible projection to JSON output.",
  }),
  headers: Schema.optional(Schema.Unknown).annotate({
    description:
      "api/graphql: optional HTTP header object for media types, API versions, or conditional requests. Credential/hop-by-hop headers are refused.",
  }),
  previews: Schema.optional(Schema.Array(Schema.String).check(Schema.isMaxLength(20))).annotate({
    description: "api/graphql: GitHub API preview names, max 20.",
  }),
  includeHeaders: Schema.optional(Schema.Boolean).annotate({
    description: "api/graphql: include HTTP response status and headers in output.",
  }),
  maxBytes: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 2_000, maximum: MAX_MAX_BYTES }))).annotate({
    description: "Combined stdout/stderr capture cap (default 120000, max 500000 bytes).",
  }),
  timeoutMs: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1_000, maximum: MAX_TIMEOUT_MS }))).annotate({
    description: "Process timeout in milliseconds (default 30000, max 120000).",
  }),
})

type Input = Schema.Schema.Type<typeof Parameters>
type Action = NonNullable<Input["action"]>

const COMMON_FIELDS = ["repo", "host", "maxBytes", "timeoutMs"] as const
const ACTION_FIELDS = {
  status: [] as const,
  help: ["argv"] as const,
  catalog: ["q", "kind", "limit"] as const,
  describe: ["ref"] as const,
  command: ["argv"] as const,
  api: [
    "endpoint",
    "method",
    "params",
    "body",
    "paginate",
    "slurp",
    "jq",
    "headers",
    "previews",
    "includeHeaders",
  ] as const,
  graphql: ["query", "variables", "paginate", "slurp", "jq", "headers", "previews", "includeHeaders"] as const,
} satisfies Record<Action, readonly (keyof Input)[]>

type Metadata = {
  action: string
  access: Access
  ok: boolean
  exitCode: number
  truncated: boolean
  repo?: string
  host?: string
  command?: string
}

function asRecord(value: unknown, name: string): Record<string, unknown> {
  if (value === undefined) return {}
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object`)
  }
  return value as Record<string, unknown>
}

function cleanText(value: string, name: string) {
  if (value.includes("\0")) throw new Error(`${name} may not contain NUL bytes`)
  return value
}

function cleanArgv(argv: readonly string[]) {
  if (argv.length === 0) throw new Error("argv must not be empty")
  if (argv.length > 80) throw new Error("argv is capped at 80 items")
  for (const arg of argv) {
    cleanText(arg, "argv item")
    if (arg.length > 8_192) throw new Error("argv items are capped at 8192 characters")
  }
}

function validateActionFields(input: Input, action: Action) {
  const allowed = new Set<string>(["action", ...COMMON_FIELDS, ...ACTION_FIELDS[action]])
  const extras = Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key)
    .filter((key) => !allowed.has(key))
  if (extras.length > 0) throw new Error(`github ${action} does not accept: ${extras.join(", ")}`)
}

function commandKey(argv: readonly string[]) {
  cleanArgv(argv)
  const top = argv[0]!
  if (top === "status") {
    if (argv.length > 1 && argv[1] && !argv[1]!.startsWith("-")) {
      throw new Error("gh status does not accept a subcommand")
    }
    return { top, sub: "", access: "read" as const }
  }
  const sub = argv[1]
  if (!sub || sub.startsWith("-")) throw new Error(`gh ${top} requires an approved subcommand`)
  const read = READ_COMMANDS[top as keyof typeof READ_COMMANDS] as ReadonlySet<string> | undefined
  if (read?.has(sub)) return { top, sub, access: "read" as const }
  const write = WRITE_COMMANDS[top as keyof typeof WRITE_COMMANDS] as ReadonlySet<string> | undefined
  if (write?.has(sub)) return { top, sub, access: "write" as const }
  throw new Error(
    `Unsupported gh command "${top} ${sub}". Use action=help for supported gh families, or action=api/graphql for endpoints not covered by curated command mode.`,
  )
}

function validateCommandArgv(argv: readonly string[]) {
  const classification = commandKey(argv)
  for (const arg of argv) {
    const flag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg
    if (BLOCKED_COMMAND_FLAGS.has(flag)) {
      throw new Error(
        `command mode refuses ${flag}; use structured tool fields instead of browser/editor/token/file-input behavior`,
      )
    }
    if (classification.top !== "search" && (flag === "--repo" || flag === "-R")) {
      throw new Error(
        "command mode refuses -R/--repo; use the top-level repo field so permission and host scope stay exact",
      )
    }
    if (arg === "-F") {
      throw new Error(
        "command mode refuses -F because gh commonly treats it as file-backed input; use explicit text/raw fields",
      )
    }
    if (arg === "-w" && !(classification.top === "run" && classification.sub === "list")) {
      throw new Error("command mode refuses -w when it can select browser behavior; use long-form non-browser flags")
    }
    if (
      arg === "-e" &&
      !(classification.top === "run" && classification.sub === "list") &&
      classification.top !== "status"
    ) {
      throw new Error("command mode refuses -e when it can select editor behavior; use long-form non-editor flags")
    }
  }
  if (
    classification.top === "issue" &&
    classification.access === "write" &&
    classification.sub !== "create" &&
    (!argv[2] || !/^\d+$/.test(argv[2]!))
  ) {
    throw new Error(`gh issue ${classification.sub} requires an explicit numeric issue number`)
  }
  if (
    classification.top === "pr" &&
    TARGETED_PR_WRITES.has(classification.sub) &&
    (!argv[2] || argv[2]!.startsWith("-"))
  ) {
    throw new Error(`gh pr ${classification.sub} requires an explicit pull request number, URL, or branch`)
  }
  if (
    classification.access === "write" &&
    (classification.top === "pr" || classification.top === "issue") &&
    argv[2] &&
    /^https?:\/\//i.test(argv[2]!)
  ) {
    throw new Error(
      "remote write targets must use top-level repo plus a number/branch; URL targets bypass exact permission scope",
    )
  }
  if (
    classification.top === "pr" &&
    (classification.sub === "merge" || classification.sub === "close") &&
    argv.some((arg) => arg === "--delete-branch" || arg === "-d")
  ) {
    throw new Error(
      `gh pr ${classification.sub} refuses --delete-branch because it also mutates the local Git worktree`,
    )
  }
  if (classification.top === "pr" && classification.sub === "create") {
    if (
      !argv.some(
        (arg, index) =>
          ((arg === "--head" || arg === "-H") &&
            typeof argv[index + 1] === "string" &&
            argv[index + 1]!.length > 0 &&
            !argv[index + 1]!.startsWith("-")) ||
          arg.startsWith("--head="),
      )
    ) {
      throw new Error("gh pr create requires an explicit --head to prevent implicit push/fork behavior")
    }
    if (
      argv.some((arg) =>
        ["--template", "-T", "--dry-run", "--fill", "-f", "--fill-first", "--fill-verbose"].includes(arg),
      )
    ) {
      throw new Error("gh pr create refuses local template/dry-run/fill modes; pass explicit remote PR fields instead")
    }
  }
  if (
    classification.top === "workflow" &&
    classification.sub === "run" &&
    argv.some((arg) => arg === "--field" || arg.startsWith("--field=") || arg === "--json")
  ) {
    throw new Error("gh workflow run refuses file/STDIN-decoding input modes; use --raw-field/-f with explicit values")
  }
  return classification
}

function validateHelpArgv(argv: readonly string[]) {
  if (argv.length === 0) return
  cleanArgv(argv)
  const top = argv[0]!
  if (!HELP_TOPICS.has(top)) throw new Error(`Unsupported help topic: ${top}`)
  if (argv.some((item) => item.startsWith("-"))) throw new Error("help topic argv must contain command names only")
}

function validateHost(host: string | undefined) {
  if (!host) return
  cleanText(host, "host")
  if (host.includes("/") || host.includes("\\") || host.includes(":") || !/^[A-Za-z0-9.-]+$/.test(host)) {
    throw new Error("host must be a bare GitHub hostname")
  }
}

function validateRepo(repo: string | undefined) {
  if (!repo) return
  cleanText(repo, "repo")
  if (repo.startsWith("-") || /\s/.test(repo) || repo.includes("\\")) {
    throw new Error("repo must use [HOST/]OWNER/REPO form")
  }
  const parts = repo.split("/").filter(Boolean)
  if (parts.length !== 2 && parts.length !== 3) throw new Error("repo must use [HOST/]OWNER/REPO form")
}

function explicitRepoHost(repo: string | undefined) {
  if (!repo) return
  const parts = repo.split("/").filter(Boolean)
  return parts.length === 3 ? parts[0] : undefined
}

function requestedHost(input: Input) {
  const repoHost = explicitRepoHost(input.repo)
  if (input.host && repoHost && input.host.toLowerCase() !== repoHost.toLowerCase()) {
    throw new Error("host and repo hostname disagree")
  }
  return input.host ?? repoHost
}

function normalizeEndpoint(endpoint: string) {
  cleanText(endpoint, "endpoint")
  const value = endpoint.replace(/^\/+/, "")
  if (!value || value.startsWith("-")) throw new Error("api endpoint is required")
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value)) {
    throw new Error("api endpoint must be relative; use host for GitHub Enterprise")
  }
  return value
}

function appendQuery(endpoint: string, paramsValue: unknown) {
  const params = asRecord(paramsValue, "params")
  if (Object.keys(params).length === 0) return endpoint
  const query = new URLSearchParams()
  for (const [key, raw] of Object.entries(params)) {
    cleanText(key, "query parameter name")
    const values = Array.isArray(raw) ? raw : [raw]
    for (const value of values) {
      if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`params.${key} must be a scalar or scalar array`)
      }
      query.append(key, value === null ? "" : String(value))
    }
  }
  const glue = endpoint.includes("?") ? "&" : "?"
  return `${endpoint}${glue}${query.toString()}`
}

function graphqlAccess(query: string): Access {
  cleanText(query, "query")
  return /\bmutation\b/i.test(query) ? "write" : "read"
}

function apiHeaderArgs(value: unknown) {
  const headers = asRecord(value, "headers")
  const args: string[] = []
  for (const [name, raw] of Object.entries(headers)) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
      throw new Error(`Invalid HTTP header name: ${name}`)
    }
    if (BLOCKED_API_HEADERS.has(name.toLowerCase())) {
      throw new Error(`Refusing protected HTTP header: ${name}`)
    }
    if (typeof raw !== "string" && typeof raw !== "number" && typeof raw !== "boolean") {
      throw new Error(`headers.${name} must be a string, number, or boolean`)
    }
    const rendered = String(raw)
    cleanText(rendered, `headers.${name}`)
    if (rendered.includes("\r") || rendered.includes("\n")) {
      throw new Error(`headers.${name} may not contain newlines`)
    }
    args.push("--header", `${name}: ${rendered}`)
  }
  return args
}

function previewArgs(value: readonly string[] | undefined) {
  if (!value?.length) return [] as string[]
  for (const preview of value) {
    if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(preview)) {
      throw new Error(`Invalid GitHub API preview name: ${preview}`)
    }
  }
  return ["--preview", value.join(",")]
}

function scalarGraphqlVariables(value: unknown) {
  const vars = asRecord(value, "variables")
  const args: string[] = []
  for (const [key, item] of Object.entries(vars)) {
    cleanText(key, "GraphQL variable name")
    if (typeof item === "string") {
      args.push("--raw-field", `${key}=${item}`)
      continue
    }
    if (item === null || typeof item === "number" || typeof item === "boolean") {
      args.push("--field", `${key}=${String(item)}`)
      continue
    }
    throw new Error(
      `Paginated GraphQL currently supports scalar variables only; variable "${key}" is composite. Run without paginate or encode pagination explicitly via action=api.`,
    )
  }
  return args
}

export type CatalogKind = "command" | "api" | "graphql"

export type CatalogEntry = {
  ref: string
  kind: CatalogKind
  summary: string
  access: Access
  example: unknown
  detail?: string
}

const methodAccess = (method: string): Access => (method === "GET" || method === "HEAD" ? "read" : "write")

function commandCatalogEntries(): CatalogEntry[] {
  const entries: CatalogEntry[] = [
    {
      ref: "github:command:status",
      kind: "command",
      summary: "gh status: repository and pull request status",
      access: "read",
      example: { action: "command", argv: ["status"] },
    },
  ]
  for (const [top, subs] of Object.entries(READ_COMMANDS)) {
    for (const sub of subs) {
      entries.push({
        ref: `github:command:${top} ${sub}`,
        kind: "command",
        summary: `gh ${top} ${sub}`,
        access: "read",
        example: { action: "command", argv: [top, sub] },
      })
    }
  }
  for (const [top, subs] of Object.entries(WRITE_COMMANDS)) {
    for (const sub of subs) {
      entries.push({
        ref: `github:command:${top} ${sub}`,
        kind: "command",
        summary: `gh ${top} ${sub} (remote write)`,
        access: "write",
        example: { action: "command", argv: [top, sub] },
        detail: "Curated write commands carry extra guards; see action=help or the classify error text.",
      })
    }
  }
  return entries
}

// Compact curated REST surface covering the connector matrix (§4): repos,
// Git objects, issues, PRs, reviews, Actions, checks, search, users, secrets.
const REST_CATALOG: ReadonlyArray<{ method: string; path: string; summary: string; detail?: string }> = [
  { method: "GET", path: "/repos/{owner}/{repo}", summary: "Repository metadata" },
  { method: "GET", path: "/repos/{owner}/{repo}/contents/{path}", summary: "File or directory contents" },
  { method: "GET", path: "/repos/{owner}/{repo}/commits", summary: "List commits", detail: "params: sha, per_page" },
  { method: "GET", path: "/repos/{owner}/{repo}/commits/{sha}", summary: "Single commit" },
  {
    method: "GET",
    path: "/repos/{owner}/{repo}/compare/{base}...{head}",
    summary: "Compare two revisions",
  },
  { method: "GET", path: "/repos/{owner}/{repo}/branches", summary: "List branches" },
  { method: "GET", path: "/repos/{owner}/{repo}/branches/{branch}", summary: "Branch state" },
  { method: "GET", path: "/repos/{owner}/{repo}/git/trees/{sha}", summary: "Git tree" },
  { method: "GET", path: "/repos/{owner}/{repo}/git/blobs/{sha}", summary: "Git blob" },
  { method: "GET", path: "/repos/{owner}/{repo}/git/refs/{ref}", summary: "Git ref" },
  { method: "POST", path: "/repos/{owner}/{repo}/git/blobs", summary: "Create blob", detail: "body: content, encoding" },
  { method: "POST", path: "/repos/{owner}/{repo}/git/trees", summary: "Create tree", detail: "body: base_tree, tree[]" },
  { method: "POST", path: "/repos/{owner}/{repo}/git/refs", summary: "Create ref", detail: "body: ref, sha" },
  { method: "PATCH", path: "/repos/{owner}/{repo}/git/refs/{ref}", summary: "Update ref", detail: "body: sha, force" },
  { method: "DELETE", path: "/repos/{owner}/{repo}/git/refs/{ref}", summary: "Delete ref" },
  {
    method: "GET",
    path: "/repos/{owner}/{repo}/collaborators/{username}/permission",
    summary: "Repository permission level",
  },
  { method: "GET", path: "/repos/{owner}/{repo}/installation", summary: "Repository installation info" },
  {
    method: "GET",
    path: "/repos/{owner}/{repo}/issues",
    summary: "List issues",
    detail: "params: state, labels, per_page",
  },
  { method: "POST", path: "/repos/{owner}/{repo}/issues", summary: "Create issue", detail: "body: title, body" },
  { method: "GET", path: "/repos/{owner}/{repo}/issues/{n}", summary: "Single issue" },
  { method: "PATCH", path: "/repos/{owner}/{repo}/issues/{n}", summary: "Update issue", detail: "body: title, body, state" },
  { method: "GET", path: "/repos/{owner}/{repo}/issues/{n}/comments", summary: "List issue comments" },
  {
    method: "POST",
    path: "/repos/{owner}/{repo}/issues/{n}/comments",
    summary: "Comment on issue",
    detail: "body: body",
  },
  { method: "PATCH", path: "/repos/{owner}/{repo}/issues/comments/{id}", summary: "Update comment" },
  { method: "DELETE", path: "/repos/{owner}/{repo}/issues/comments/{id}", summary: "Delete comment" },
  { method: "PUT", path: "/repos/{owner}/{repo}/issues/{n}/labels", summary: "Set issue labels" },
  { method: "POST", path: "/repos/{owner}/{repo}/issues/{n}/labels", summary: "Add issue labels" },
  { method: "DELETE", path: "/repos/{owner}/{repo}/issues/{n}/labels/{name}", summary: "Remove issue label" },
  { method: "POST", path: "/repos/{owner}/{repo}/issues/{n}/assignees", summary: "Add assignees" },
  { method: "DELETE", path: "/repos/{owner}/{repo}/issues/{n}/assignees", summary: "Remove assignees" },
  { method: "POST", path: "/repos/{owner}/{repo}/issues/{n}/reactions", summary: "React to issue" },
  { method: "POST", path: "/repos/{owner}/{repo}/issues/comments/{id}/reactions", summary: "React to comment" },
  { method: "PUT", path: "/repos/{owner}/{repo}/issues/{n}/lock", summary: "Lock conversation" },
  { method: "DELETE", path: "/repos/{owner}/{repo}/issues/{n}/lock", summary: "Unlock conversation" },
  { method: "GET", path: "/repos/{owner}/{repo}/pulls", summary: "List pull requests", detail: "params: state, head, base" },
  { method: "POST", path: "/repos/{owner}/{repo}/pulls", summary: "Create pull request", detail: "body: head, base, title" },
  { method: "GET", path: "/repos/{owner}/{repo}/pulls/{n}", summary: "Single pull request" },
  { method: "PATCH", path: "/repos/{owner}/{repo}/pulls/{n}", summary: "Update pull request" },
  { method: "GET", path: "/repos/{owner}/{repo}/pulls/{n}/files", summary: "Changed filenames" },
  { method: "GET", path: "/repos/{owner}/{repo}/pulls/{n}/commits", summary: "PR commits" },
  { method: "GET", path: "/repos/{owner}/{repo}/pulls/{n}/reviews", summary: "List reviews" },
  {
    method: "POST",
    path: "/repos/{owner}/{repo}/pulls/{n}/reviews",
    summary: "Submit review decision",
    detail: "body: event, body",
  },
  { method: "POST", path: "/repos/{owner}/{repo}/pulls/{n}/reviews/{id}/events", summary: "Submit pending review" },
  { method: "POST", path: "/repos/{owner}/{repo}/pulls/{n}/reviews/{id}/dismissals", summary: "Dismiss review" },
  { method: "GET", path: "/repos/{owner}/{repo}/pulls/{n}/comments", summary: "List review comments" },
  { method: "POST", path: "/repos/{owner}/{repo}/pulls/{n}/comments", summary: "Create review comment" },
  { method: "PATCH", path: "/repos/{owner}/{repo}/pulls/comments/{id}", summary: "Update review comment" },
  { method: "DELETE", path: "/repos/{owner}/{repo}/pulls/comments/{id}", summary: "Delete review comment" },
  { method: "POST", path: "/repos/{owner}/{repo}/pulls/{n}/requested_reviewers", summary: "Request reviewers" },
  { method: "DELETE", path: "/repos/{owner}/{repo}/pulls/{n}/requested_reviewers", summary: "Cancel review requests" },
  { method: "PUT", path: "/repos/{owner}/{repo}/pulls/{n}/merge", summary: "Merge pull request" },
  { method: "GET", path: "/repos/{owner}/{repo}/actions/runs", summary: "List workflow runs" },
  { method: "GET", path: "/repos/{owner}/{repo}/actions/runs/{id}", summary: "Single workflow run" },
  { method: "POST", path: "/repos/{owner}/{repo}/actions/runs/{id}/rerun", summary: "Rerun workflow" },
  { method: "POST", path: "/repos/{owner}/{repo}/actions/runs/{id}/cancel", summary: "Cancel workflow run" },
  { method: "DELETE", path: "/repos/{owner}/{repo}/actions/runs/{id}", summary: "Delete workflow run" },
  { method: "GET", path: "/repos/{owner}/{repo}/actions/runs/{id}/jobs", summary: "Run jobs" },
  { method: "GET", path: "/repos/{owner}/{repo}/actions/jobs/{id}/logs", summary: "Job logs" },
  { method: "GET", path: "/repos/{owner}/{repo}/actions/runs/{id}/artifacts", summary: "Run artifacts" },
  { method: "GET", path: "/repos/{owner}/{repo}/actions/workflows", summary: "List workflows" },
  { method: "GET", path: "/repos/{owner}/{repo}/actions/workflows/{id}/runs", summary: "Workflow runs" },
  { method: "POST", path: "/repos/{owner}/{repo}/actions/workflows/{id}/dispatches", summary: "Dispatch workflow" },
  { method: "GET", path: "/repos/{owner}/{repo}/commits/{ref}/check-runs", summary: "Check runs for ref" },
  { method: "POST", path: "/repos/{owner}/{repo}/check-runs", summary: "Create check run" },
  { method: "PATCH", path: "/repos/{owner}/{repo}/check-runs/{id}", summary: "Update check run" },
  { method: "GET", path: "/repos/{owner}/{repo}/commits/{ref}/status", summary: "Combined commit status" },
  { method: "POST", path: "/repos/{owner}/{repo}/statuses/{sha}", summary: "Create commit status" },
  { method: "GET", path: "/search/repositories", summary: "Search repositories", detail: "params: q" },
  { method: "GET", path: "/search/code", summary: "Search code", detail: "params: q" },
  { method: "GET", path: "/search/issues", summary: "Search issues and PRs", detail: "params: q" },
  { method: "GET", path: "/search/commits", summary: "Search commits", detail: "params: q" },
  { method: "GET", path: "/user", summary: "Authenticated user" },
  { method: "GET", path: "/users/{username}", summary: "User profile" },
  { method: "GET", path: "/orgs/{org}", summary: "Organization profile" },
  { method: "GET", path: "/user/installations", summary: "App installations" },
  { method: "GET", path: "/repos/{owner}/{repo}/actions/secrets/public-key", summary: "Actions public key" },
  { method: "GET", path: "/repos/{owner}/{repo}/actions/secrets/{name}", summary: "Read secret metadata" },
  { method: "PUT", path: "/repos/{owner}/{repo}/actions/secrets/{name}", summary: "Create or update secret" },
  { method: "DELETE", path: "/repos/{owner}/{repo}/actions/secrets/{name}", summary: "Delete secret" },
]

const GRAPHQL_CATALOG: ReadonlyArray<{ name: string; summary: string; access: Access; skeleton: string }> = [
  { name: "viewer", summary: "Authenticated user login", access: "read", skeleton: "query { viewer { login } }" },
  {
    name: "repoPullRequests",
    summary: "Open PRs with page cursors",
    access: "read",
    skeleton:
      "query($owner: String!, $name: String!, $endCursor: String) { repository(owner: $owner, name: $name) { pullRequests(first: 20, after: $endCursor, states: OPEN) { pageInfo { hasNextPage endCursor } nodes { number title } } } }",
  },
  {
    name: "issueComments",
    summary: "Issue comments with page cursors",
    access: "read",
    skeleton:
      "query($owner: String!, $name: String!, $number: Int!, $endCursor: String) { repository(owner: $owner, name: $name) { issue(number: $number) { comments(first: 20, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { body } } } } }",
  },
  {
    name: "reviewThreads",
    summary: "PR review threads with page cursors",
    access: "read",
    skeleton:
      "query($owner: String!, $name: String!, $number: Int!, $endCursor: String) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { reviewThreads(first: 20, after: $endCursor) { pageInfo { hasNextPage endCursor } nodes { isResolved comments(first: 5) { nodes { body } } } } } } }",
  },
  {
    name: "addIssueComment",
    summary: "Comment on an issue or PR",
    access: "write",
    skeleton: "mutation($subjectId: ID!, $body: String!) { addComment(input: {subjectId: $subjectId, body: $body}) { clientMutationId } }",
  },
  {
    name: "addPullRequestReview",
    summary: "Submit a PR review",
    access: "write",
    skeleton:
      "mutation($pullRequestId: ID!, $body: String, $event: PullRequestReviewEvent) { addPullRequestReview(input: {pullRequestId: $pullRequestId, body: $body, event: $event}) { clientMutationId } }",
  },
  {
    name: "markReady",
    summary: "Mark draft PR ready for review",
    access: "write",
    skeleton:
      "mutation($pullRequestId: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $pullRequestId}) { clientMutationId } }",
  },
  {
    name: "autoMerge",
    summary: "Enable PR auto-merge",
    access: "write",
    skeleton:
      "mutation($pullRequestId: ID!, $mergeMethod: PullRequestMergeMethod) { enablePullRequestAutoMerge(input: {pullRequestId: $pullRequestId, mergeMethod: $mergeMethod}) { clientMutationId } }",
  },
]

function restCatalogEntries(): CatalogEntry[] {
  return REST_CATALOG.map((entry) => {
    const endpoint = entry.path.replace(/^\/+/, "")
    return {
      ref: `github:api:${entry.method} ${entry.path}`,
      kind: "api" as const,
      summary: entry.summary,
      access: methodAccess(entry.method),
      example:
        entry.method === "GET" || entry.method === "HEAD"
          ? { action: "api", endpoint }
          : { action: "api", endpoint, method: entry.method },
      ...(entry.detail ? { detail: entry.detail } : {}),
    } satisfies CatalogEntry
  })
}

function graphqlCatalogEntries(): CatalogEntry[] {
  return GRAPHQL_CATALOG.map((entry) => ({
    ref: `github:graphql:${entry.name}`,
    kind: "graphql" as const,
    summary: entry.summary,
    access: entry.access,
    example: { action: "graphql", query: entry.skeleton },
    detail:
      entry.access === "read"
        ? "Paginated skeletons use $endCursor with pageInfo{hasNextPage,endCursor}."
        : "Mutations classify as write permission.",
  }))
}

let catalogCache: CatalogEntry[] | undefined

export function catalogEntries(): CatalogEntry[] {
  catalogCache ??= [...commandCatalogEntries(), ...restCatalogEntries(), ...graphqlCatalogEntries()]
  return catalogCache
}

export function searchCatalog(input: { q?: string; kind?: CatalogKind; limit?: number }): {
  items: CatalogEntry[]
  total: number
  truncated: boolean
} {
  const q = (input.q ?? "").trim().toLowerCase()
  const limit = Math.min(Math.max(input.limit ?? 10, 1), 25)
  const matches = catalogEntries().filter(
    (entry) =>
      (!input.kind || entry.kind === input.kind) &&
      (!q || entry.ref.toLowerCase().includes(q) || entry.summary.toLowerCase().includes(q)),
  )
  const ranked = [...matches].sort((a, b) => {
    const aRef = a.ref.toLowerCase().includes(q)
    const bRef = b.ref.toLowerCase().includes(q)
    if (aRef !== bRef) return aRef ? -1 : 1
    return a.ref.localeCompare(b.ref)
  })
  return { items: ranked.slice(0, limit), total: matches.length, truncated: matches.length > limit }
}

export function describeCatalogRef(ref: string): CatalogEntry {
  cleanText(ref, "ref")
  const entry = catalogEntries().find((item) => item.ref === ref)
  if (!entry) {
    throw new Error(`Unknown catalog ref "${ref}". Use action=catalog to search the GitHub capability index.`)
  }
  return entry
}

export function catalogDescriptor(entry: CatalogEntry): BrokerContract.CanonicalDescriptor {
  return BrokerContract.toCanonicalDescriptor({
    ref: entry.ref,
    kind: `github-${entry.kind}`,
    description: entry.summary,
    inputSchema: entry.example,
    invocation: {
      tool: "github",
      action: entry.kind === "command" ? "command" : entry.kind,
      argsField: entry.kind === "command" ? "argv" : entry.kind === "api" ? "endpoint" : "query",
      hint: JSON.stringify(entry.example),
    },
  })
}

export function classify(input: Input): { access: Access; command?: string } {
  const action = input.action ?? "status"
  validateActionFields(input, action)
  validateHost(input.host)
  validateRepo(input.repo)
  const targetHost = requestedHost(input)
  validateHost(targetHost)
  if (input.jq) cleanText(input.jq, "jq")

  if (action === "status") return { access: "read" }
  if (action === "help") {
    validateHelpArgv(input.argv ?? [])
    return { access: "read" }
  }
  if (action === "catalog") {
    if (input.q !== undefined) cleanText(input.q, "q")
    return { access: "read", command: "catalog" }
  }
  if (action === "describe") {
    if (!input.ref) throw new Error("describe action requires ref; use action=catalog to find one")
    describeCatalogRef(input.ref)
    return { access: "read", command: `describe ${input.ref}` }
  }
  if (action === "command") {
    const argv = input.argv ?? []
    const info = validateCommandArgv(argv)
    return { access: info.access, command: `${info.top}${info.sub ? ` ${info.sub}` : ""}` }
  }
  if (action === "api") {
    if (!input.endpoint) throw new Error("api action requires endpoint")
    const method = input.method ?? (input.body === undefined ? "GET" : "POST")
    if ((method === "GET" || method === "HEAD") && input.body !== undefined) {
      throw new Error(`${method} api requests do not accept body; use params for query parameters`)
    }
    if (input.paginate && method !== "GET") throw new Error("REST pagination is supported only for GET")
    if (input.slurp && !input.paginate) throw new Error("slurp requires paginate")
    appendQuery(normalizeEndpoint(input.endpoint), input.params)
    apiHeaderArgs(input.headers)
    previewArgs(input.previews)
    return {
      access: method === "GET" || method === "HEAD" ? "read" : "write",
      command: `${method} ${input.endpoint ?? ""}`.trim(),
    }
  }
  if (!input.query) throw new Error("graphql action requires query")
  if (input.slurp && !input.paginate) throw new Error("slurp requires paginate")
  asRecord(input.variables, "variables")
  if (input.paginate) scalarGraphqlVariables(input.variables)
  apiHeaderArgs(input.headers)
  previewArgs(input.previews)
  return { access: graphqlAccess(input.query), command: "graphql" }
}

function permissionPattern(input: Input, access: Access, command?: string) {
  const target = input.repo ?? input.host ?? "current"
  const detail = command ?? input.action ?? "status"
  return `${access}:${target}:${detail}`.slice(0, 240)
}

const encoder = new TextEncoder()

const runGh = Effect.fn("GithubTool.runGh")(function* (
  app: AppProcess.Interface,
  cwd: string,
  args: readonly string[],
  options: {
    repo?: string
    host?: string
    stdin?: string
    signal?: AbortSignal
    maxBytes?: number
    timeoutMs?: number
  },
) {
  const env: Record<string, string> = {
    GH_PROMPT_DISABLED: "1",
    GH_PAGER: "cat",
    PAGER: "cat",
    NO_COLOR: "1",
    CLICOLOR: "0",
    GH_FORCE_TTY: "",
    GH_DEBUG: "",
    GH_NO_UPDATE_NOTIFIER: "1",
    GH_NO_EXTENSION_UPDATE_NOTIFIER: "1",
    GH_SPINNER_DISABLED: "1",
    GH_TELEMETRY: "0",
    // Do not let caller environment silently retarget repository/host authority.
    GH_REPO: options.repo ?? "",
    GH_HOST: options.host ?? "",
  }

  let argChars = 2
  for (const arg of args) {
    cleanText(arg, "gh argument")
    argChars += arg.length + 3
  }
  if (argChars > MAX_PROCESS_ARG_CHARS) {
    throw new Error(
      `gh argv is too large (${argChars} chars; max ${MAX_PROCESS_ARG_CHARS}). Put large payloads in structured api/graphql body fields so they travel over stdin.`,
    )
  }
  const stdinBytes = options.stdin === undefined ? undefined : encoder.encode(options.stdin)
  if (stdinBytes && stdinBytes.byteLength > MAX_STDIN_BYTES) {
    throw new Error(`gh stdin payload is too large (${stdinBytes.byteLength} bytes; max ${MAX_STDIN_BYTES})`)
  }

  const result = yield* app.run(
    ChildProcess.make("gh", [...args], {
      cwd,
      extendEnv: true,
      env,
      stdin: stdinBytes === undefined ? "ignore" : Stream.make(stdinBytes),
      stdout: "pipe",
      stderr: "pipe",
    }),
    {
      maxOutputBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      maxErrorBytes: options.maxBytes ?? DEFAULT_MAX_BYTES,
      timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      signal: options.signal,
    },
  )
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString("utf8"),
    stderr: result.stderr.toString("utf8"),
    truncated: result.stdoutTruncated || result.stderrTruncated,
  }
})

const assertKnownHost = Effect.fn("GithubTool.assertKnownHost")(function* (
  app: AppProcess.Interface,
  cwd: string,
  host: string | undefined,
  signal?: AbortSignal,
) {
  if (!host || host.toLowerCase() === "github.com") return
  const status = yield* runGh(app, cwd, ["auth", "status", "--json", "hosts"], {
    signal,
    maxBytes: 80_000,
    timeoutMs: 15_000,
  })
  let parsed: unknown
  try {
    parsed = JSON.parse(status.stdout)
  } catch {
    throw new Error("Could not verify configured GitHub hosts before using a custom hostname")
  }
  const hosts = asRecord(asRecord(parsed, "auth status").hosts, "auth status hosts")
  if (!Object.keys(hosts).some((item) => item.toLowerCase() === host.toLowerCase())) {
    throw new Error(
      `Refusing unconfigured GitHub host "${host}". Authenticate that host with gh first so credentials cannot be redirected to an arbitrary hostname.`,
    )
  }
})

const assertSafeApiRouting = Effect.fn("GithubTool.assertSafeApiRouting")(function* (
  app: AppProcess.Interface,
  cwd: string,
  host: string | undefined,
  signal?: AbortSignal,
) {
  const args = ["config", "get", "api_host"]
  if (host) args.push("--host", host)
  const result = yield* runGh(app, cwd, args, {
    signal,
    maxBytes: 8_000,
    timeoutMs: 10_000,
  })
  if (result.exitCode !== 0) {
    throw new Error("Could not verify GitHub CLI api_host routing before using authenticated GitHub operations")
  }
  const routedHost = result.stdout.trim()
  if (!routedHost) return
  if (host && routedHost.toLowerCase() === host.toLowerCase()) return
  throw new Error(
    `Refusing GitHub CLI api_host redirect to "${routedHost}". The github tool does not inherit authenticated API redirects because gh documents api_host as not being a security boundary.`,
  )
})

function renderResult(
  action: string,
  access: Access,
  result: { exitCode: number; stdout: string; stderr: string; truncated: boolean },
  input: Input,
  command?: string,
) {
  const stdout = result.stdout.trim()
  const stderr = result.stderr.trim()
  const output =
    stdout && stderr && result.exitCode !== 0
      ? `${stdout}\n\n<stderr>\n${stderr}\n</stderr>`
      : stdout || stderr || "(no output)"
  return {
    title: command ? `github ${command}` : `github ${action}`,
    output,
    metadata: {
      action,
      access,
      ok: result.exitCode === 0,
      exitCode: result.exitCode,
      truncated: result.truncated,
      ...(input.repo ? { repo: input.repo } : {}),
      ...(input.host ? { host: input.host } : {}),
      ...(command ? { command } : {}),
    } satisfies Metadata,
  }
}

export const GithubTool = Tool.define<typeof Parameters, Metadata, AppProcess.Service>(
  "github",
  Effect.gen(function* () {
    const app = yield* AppProcess.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      exposure: "lazy",
      execute: (input: Input, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const action = input.action ?? "status"
          const classified = classify(input)
          const targetHost = requestedHost(input)
          const pattern = permissionPattern(input, classified.access, classified.command)
          const instance = yield* InstanceState.context

          yield* ctx.ask({
            permission: "github",
            patterns: [pattern],
            always: [pattern],
            metadata: {
              action,
              access: classified.access,
              ...(input.repo ? { repo: input.repo } : {}),
              ...(input.host ? { host: input.host } : {}),
              ...(classified.command ? { command: classified.command } : {}),
            },
          })

          yield* assertKnownHost(app, instance.directory, targetHost, ctx.abort)
          if (action === "command" || action === "api" || action === "graphql") {
            yield* assertSafeApiRouting(app, instance.directory, targetHost, ctx.abort)
          }

          const common = {
            repo: input.repo,
            host: targetHost,
            signal: ctx.abort,
            maxBytes: input.maxBytes,
            timeoutMs: input.timeoutMs,
          }

          if (action === "status") {
            const result = yield* runGh(app, instance.directory, ["auth", "status", "--json", "hosts"], common)
            return renderResult(action, classified.access, result, input, "auth status")
          }

          if (action === "help") {
            const argv = input.argv ?? []
            validateHelpArgv(argv)
            const args = argv.length ? [...argv, "--help"] : ["help"]
            const result = yield* runGh(app, instance.directory, args, common)
            return renderResult(
              action,
              classified.access,
              result,
              input,
              argv.length ? `${argv.join(" ")} --help` : "help",
            )
          }

          if (action === "command") {
            const argv = input.argv ?? []
            validateCommandArgv(argv)
            const result = yield* runGh(app, instance.directory, argv, common)
            return renderResult(action, classified.access, result, input, argv.slice(0, 2).join(" "))
          }

          if (action === "catalog") {
            const found = searchCatalog({ q: input.q, kind: input.kind, limit: input.limit })
            return {
              title: "github catalog",
              output: JSON.stringify(found),
              metadata: {
                action,
                access: classified.access,
                ok: true,
                exitCode: 0,
                truncated: found.truncated,
                ...(input.repo ? { repo: input.repo } : {}),
                ...(input.host ? { host: input.host } : {}),
                command: "catalog",
              } satisfies Metadata,
            }
          }

          if (action === "describe") {
            const entry = describeCatalogRef(input.ref!)
            const descriptor = catalogDescriptor(entry)
            return {
              title: `github describe ${entry.ref}`,
              output: JSON.stringify({ entry, canonical: descriptor }),
              metadata: {
                action,
                access: classified.access,
                ok: true,
                exitCode: 0,
                truncated: false,
                ...(input.repo ? { repo: input.repo } : {}),
                ...(input.host ? { host: input.host } : {}),
                command: `describe ${entry.ref}`,
              } satisfies Metadata,
            }
          }

          if (action === "api") {
            if (!input.endpoint) throw new Error("api action requires endpoint")
            const method = input.method ?? (input.body === undefined ? "GET" : "POST")
            if ((method === "GET" || method === "HEAD") && input.body !== undefined) {
              throw new Error(`${method} api requests do not accept body; use params for query parameters`)
            }
            if (input.paginate && method !== "GET") throw new Error("REST pagination is supported only for GET")
            if (input.slurp && !input.paginate) throw new Error("slurp requires paginate")

            const endpoint = appendQuery(normalizeEndpoint(input.endpoint), input.params)
            const args = ["api", endpoint, "--method", method]
            if (targetHost) args.push("--hostname", targetHost)
            if (input.paginate) args.push("--paginate")
            if (input.slurp) args.push("--slurp")
            if (input.jq) args.push("--jq", input.jq)
            if (input.includeHeaders) args.push("--include")
            args.push(...previewArgs(input.previews), ...apiHeaderArgs(input.headers))
            let stdin: string | undefined
            if (input.body !== undefined) {
              stdin = JSON.stringify(input.body)
              args.push("--input", "-")
              args.push("--header", "Content-Type: application/json")
            }
            const result = yield* runGh(app, instance.directory, args, { ...common, stdin })
            return renderResult(action, classified.access, result, input, `${method} ${endpoint}`)
          }

          if (!input.query) throw new Error("graphql action requires query")
          if (input.slurp && !input.paginate) throw new Error("slurp requires paginate")
          const args = ["api", "graphql"]
          if (targetHost) args.push("--hostname", targetHost)
          if (input.jq) args.push("--jq", input.jq)
          if (input.includeHeaders) args.push("--include")
          args.push(...previewArgs(input.previews), ...apiHeaderArgs(input.headers))

          let stdin: string | undefined
          if (input.paginate) {
            args.push("--paginate")
            if (input.slurp) args.push("--slurp")
            args.push("--raw-field", `query=${input.query}`)
            args.push(...scalarGraphqlVariables(input.variables))
          } else {
            stdin = JSON.stringify({ query: input.query, variables: asRecord(input.variables, "variables") })
            args.push("--input", "-")
            args.push("--header", "Content-Type: application/json")
          }

          const result = yield* runGh(app, instance.directory, args, { ...common, stdin })
          return renderResult(action, classified.access, result, input, "graphql")
        }),
    }
  }),
)
