/**
 * Agent Experience (AX): steer GitHub RAG reads onto the authenticated gh
 * tool before anonymous HTTP egress. This is guidance, never a permission grant
 * or an implicit second tool invocation.
 */
type Route = { kind: "file" | "directory" | "issue" | "pull" | "repository" | "api"; example: string }
const OWNER = /^[A-Za-z0-9-]+$/
const REPO = /^[A-Za-z0-9_.-]+$/
const SIMPLE_REF = /^(?:main|master|[0-9a-f]{40})$/i

function safeParts(pathname: string): string[] | undefined {
  const raw = pathname.split("/").slice(1)
  if (raw.at(-1) === "") raw.pop() // An ordinary trailing slash is not a path component.
  if (raw.some((segment) => !segment || /%(?:2f|5c|00|0a|0d)/i.test(segment))) return
  try {
    const parts = raw.map(decodeURIComponent)
    if (parts.some((part) => part === "." || part === ".." || /[\\/\r\n\0]/.test(part))) return
    return parts
  } catch {
    return
  }
}

const show = (value: unknown) => JSON.stringify(value)
function example(input: Record<string, unknown>) {
  return `github(${show(input)})`
}

function contentRoute(owner: string, repo: string, op: string, rest: string[]): Route | undefined {
  const [ref, ...path] = rest
  if (!ref || !path.length) return
  // Raw and blob URLs cannot reliably distinguish slash-containing refs
  // from source paths. Suggest discovery rather than inventing a ref boundary.
  if (!SIMPLE_REF.test(ref)) {
    return {
      kind: op === "tree" ? "directory" : "file",
      example: `Use the github tool to resolve the ref/path boundary first (the URL may contain a slash-bearing branch name); then call github action=api on the repo contents endpoint. Start with ${example({ action: "catalog", q: "GitHub repository contents API" })}.`,
    }
  }
  const endpoint = `repos/${owner}/${repo}/contents/${path.map(encodeURIComponent).join("/")}`
  return {
    kind: op === "tree" ? "directory" : "file",
    example: example({
      action: "api",
      repo: `${owner}/${repo}`,
      endpoint,
      params: { ref },
      ...(op === "tree" ? {} : { headers: { Accept: "application/vnd.github.raw+json" } }),
    }),
  }
}

/** Conservative, exact-host, HTTPS-only policy; do not classify archives/attachments. */
export function classifyGitHubFetch(url: string, format: "text" | "markdown" | "html"): Route | undefined {
  if (format === "html") return
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port || parsed.search) return
  const host = parsed.hostname.toLowerCase()
  const parts = safeParts(parsed.pathname)
  if (!parts) return
  if (host === "raw.githubusercontent.com") {
    const [owner, repo, ...rest] = parts
    if (!owner || !repo || !OWNER.test(owner) || !REPO.test(repo)) return
    return contentRoute(owner, repo, "raw", rest)
  }
  if (host === "api.github.com") {
    const [namespace, owner, repo, ...rest] = parts
    if (namespace !== "repos" || !owner || !repo || !OWNER.test(owner) || !REPO.test(repo) || !rest.length) return
    return { kind: "api", example: example({ action: "api", repo: `${owner}/${repo}`, endpoint: parts.map(encodeURIComponent).join("/") }) }
  }
  if (host !== "github.com" && host !== "www.github.com") return
  const [owner, repo, op, ...rest] = parts
  if (!owner || !repo || !OWNER.test(owner) || !REPO.test(repo)) return
  if (op === "blob" || op === "raw" || op === "tree") return contentRoute(owner, repo, op, rest)
  if ((op === "pull" || op === "issues") && rest.length === 1) {
    const match = /^([1-9]\d*)(?:\.(diff|patch))?$/.exec(rest[0]!)
    if (!match) return
    const number = match[1]!
    if (op === "issues") {
      if (match[2]) return
      return { kind: "issue", example: example({ action: "command", repo: `${owner}/${repo}`, argv: ["issue", "view", number, "--json", "title,body,state"] }) }
    }
    return {
      kind: "pull",
      example: example({ action: "command", repo: `${owner}/${repo}`, argv: match[2] ? ["pr", "diff", number] : ["pr", "view", number, "--json", "title,body,state"] }),
    }
  }
  if (!op && rest.length === 0) {
    return { kind: "repository", example: example({ action: "command", argv: ["repo", "view", `${owner}/${repo}`, "--json", "name,description,defaultBranchRef"] }) }
  }
}

/**
 * Successful, non-fetching result. Callers can explicitly opt out when gh is
 * inaccessible or exact public HTTP behavior is needed; no auth is borrowed.
 */
export function githubFetchGuidance(url: string, format: "text" | "markdown" | "html") {
  const route = classifyGitHubFetch(url, format)
  if (!route) return
  return {
    title: "AX guidance: use GitHub for repository research",
    output: [
      "AX routing guidance (not an error): no HTTP request was made, and no GitHub content was retrieved.",
      "This looks like GitHub repository research. Prefer the authenticated github tool (gh CLI, user account/permission scope), rather than anonymous web fetch, particularly for private repositories and rate limits.",
      'First activate github via tool({action:"describe",tool:"github"}) unless a current descriptor has already been supplied through @github.',
      `Recommended github arguments: ${route.example}`,
      'Execute that operation using tool({action:"call",tool:"github",contract:<exact returned contract>,args:<recommended github argument object>}); do not substitute guessed contracts.',
      'If gh auth is unavailable, GitHub reports 403/rate-limit exhaustion, or exact HTTP representation is needed, use web({action:"fetch",forceWeb:true,...}) or webfetch({forceWeb:true,...}) for PUBLIC URLs. Avoid repeatedly retrying an exhausted GitHub API quota. Anonymous WebFetch does not grant access to private repository files; do not claim success without source content.',
    ].join("\n"),
    metadata: {
      advisory: "github-preferred",
      contentFetched: false,
      recommendedTool: "github",
      kind: route.kind,
    },
  }
}
