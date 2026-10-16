import { describe, expect, test } from "bun:test"
import { catalogDescriptor, catalogEntries, classify, describeCatalogRef, searchCatalog } from "../../src/tool/github"

describe("tool.github classification", () => {
  test("curated read commands remain read-only", () => {
    expect(classify({ action: "command", argv: ["pr", "view", "123"] })).toEqual({
      access: "read",
      command: "pr view",
    })
    expect(classify({ action: "command", argv: ["run", "list"] })).toEqual({
      access: "read",
      command: "run list",
    })
  })

  test("curated remote mutations require write permission", () => {
    expect(classify({ action: "command", argv: ["pr", "merge", "123", "--squash"] })).toEqual({
      access: "write",
      command: "pr merge",
    })
    expect(classify({ action: "command", argv: ["issue", "comment", "123", "--body", "ok"] })).toEqual({
      access: "write",
      command: "issue comment",
    })
  })

  test("REST classification follows the HTTP method", () => {
    expect(classify({ action: "api", endpoint: "repos/cli/cli" })).toEqual({
      access: "read",
      command: "GET repos/cli/cli",
    })
    expect(classify({ action: "api", endpoint: "repos/cli/cli/issues", body: { title: "x" } })).toEqual({
      access: "write",
      command: "POST repos/cli/cli/issues",
    })
    expect(classify({ action: "api", endpoint: "repos/cli/cli", method: "DELETE" })).toEqual({
      access: "write",
      command: "DELETE repos/cli/cli",
    })
  })

  test("structured actions reject invalid or ambiguous inputs before execution", () => {
    expect(() => classify({ action: "status", endpoint: "repos/cli/cli" })).toThrow(
      "github status does not accept: endpoint",
    )
    expect(() => classify({ action: "command", argv: ["pr", "view", "1"], body: { ignored: true } })).toThrow(
      "github command does not accept: body",
    )
    expect(() => classify({ action: "api" })).toThrow("api action requires endpoint")
    expect(() => classify({ action: "api", endpoint: "repos/cli/cli", method: "GET", body: { nope: true } })).toThrow(
      "GET api requests do not accept body",
    )
    expect(() => classify({ action: "api", endpoint: "https://example.com/steal" })).toThrow(
      "api endpoint must be relative",
    )
    expect(() => classify({ action: "api", endpoint: "repos/cli/cli", slurp: true })).toThrow("slurp requires paginate")
    expect(() =>
      classify({ action: "api", endpoint: "repos/cli/cli", headers: { Authorization: "Bearer x" } }),
    ).toThrow("Refusing protected HTTP header")
    expect(() =>
      classify({ action: "api", endpoint: "repos/cli/cli", headers: { Accept: "ok\r\nX-Evil: yes" } }),
    ).toThrow("may not contain newlines")
    expect(() => classify({ action: "api", endpoint: "repos/cli/cli", previews: ["bad preview"] })).toThrow(
      "Invalid GitHub API preview name",
    )
    expect(() =>
      classify({ action: "api", endpoint: "repos/cli/cli", repo: "github.example.com/o/r", host: "github.com" }),
    ).toThrow("host and repo hostname disagree")
  })

  test("GraphQL queries and mutations are separated", () => {
    expect(classify({ action: "graphql", query: "query { viewer { login } }" })).toEqual({
      access: "read",
      command: "graphql",
    })
    expect(
      classify({ action: "graphql", query: 'mutation { addStar(input:{starrableId:"x"}) { clientMutationId } }' }),
    ).toEqual({
      access: "write",
      command: "graphql",
    })
  })

  test("unknown command families and unsafe flags are rejected", () => {
    expect(() => classify({ action: "command", argv: ["extension", "exec", "anything"] })).toThrow(
      "Unsupported gh command",
    )
    expect(() => classify({ action: "command", argv: ["pr", "view", "123", "--web"] })).toThrow(
      "command mode refuses --web",
    )
    expect(() => classify({ action: "command", argv: ["auth", "token"] })).toThrow("Unsupported gh command")
    expect(() => classify({ action: "command", argv: ["pr", "comment", "123", "-F", "secret.txt"] })).toThrow(
      "command mode refuses -F",
    )
    expect(() => classify({ action: "command", argv: ["pr", "merge", "123", "--delete-branch"] })).toThrow(
      "refuses --delete-branch",
    )
  })

  test("mutating PR operations require explicit targets and safe create heads", () => {
    expect(() => classify({ action: "command", argv: ["pr", "merge", "--squash"] })).toThrow(
      "requires an explicit pull request",
    )
    expect(() => classify({ action: "command", argv: ["pr", "create", "--title", "x", "--body", "y"] })).toThrow(
      "requires an explicit --head",
    )
    expect(
      classify({ action: "command", argv: ["pr", "create", "--head", "feature", "--title", "x", "--body", "y"] }),
    ).toEqual({
      access: "write",
      command: "pr create",
    })
    expect(() =>
      classify({ action: "command", argv: ["pr", "create", "--head", "feature", "--template", "pr.md"] }),
    ).toThrow("refuses local template/dry-run/fill modes")
    expect(() => classify({ action: "command", argv: ["pr", "create", "--head", "feature", "--fill"] })).toThrow(
      "refuses local template/dry-run/fill modes",
    )
  })

  test("overloaded gh short flags are interpreted by subcommand", () => {
    expect(classify({ action: "command", argv: ["run", "list", "-w", "ci.yml", "-e", "push"] })).toEqual({
      access: "read",
      command: "run list",
    })
    expect(() => classify({ action: "command", argv: ["pr", "view", "123", "-w"] })).toThrow("refuses -w")
    expect(() => classify({ action: "command", argv: ["issue", "comment", "12", "-e"] })).toThrow("refuses -e")
    expect(() =>
      classify({ action: "command", argv: ["workflow", "run", "ci.yml", "-F", "name=@secret.txt"] }),
    ).toThrow("refuses -F")
    expect(() =>
      classify({ action: "command", argv: ["workflow", "run", "ci.yml", "--field", "name=@secret.txt"] }),
    ).toThrow("refuses file/STDIN-decoding input modes")
    expect(classify({ action: "command", argv: ["workflow", "run", "ci.yml", "-f", "name=explicit"] })).toEqual({
      access: "write",
      command: "workflow run",
    })
  })

  test("repository authority cannot be retargeted inside curated commands", () => {
    expect(() => classify({ action: "command", argv: ["pr", "view", "123", "--repo", "other/repo"] })).toThrow(
      "refuses -R/--repo",
    )
    expect(() =>
      classify({ action: "command", argv: ["issue", "close", "https://github.com/other/repo/issues/12"] }),
    ).toThrow("explicit numeric issue number")
    expect(() =>
      classify({ action: "command", argv: ["pr", "merge", "https://github.com/other/repo/pull/12"] }),
    ).toThrow("URL targets bypass exact permission scope")
    expect(classify({ action: "command", argv: ["search", "code", "needle", "--repo", "owner/repo"] })).toEqual({
      access: "read",
      command: "search code",
    })
  })

  test("issue writes require exact numeric targets", () => {
    expect(() => classify({ action: "command", argv: ["issue", "close"] })).toThrow("explicit numeric issue number")
    expect(classify({ action: "command", argv: ["issue", "close", "12"] })).toEqual({
      access: "write",
      command: "issue close",
    })
  })

  test("status and help are read-only", () => {
    expect(classify({ action: "status" })).toEqual({ access: "read" })
    expect(classify({ action: "help", argv: ["pr", "create"] })).toEqual({ access: "read" })
    expect(classify({ action: "command", argv: ["status", "-e", "cli/cli"] })).toEqual({
      access: "read",
      command: "status",
    })
  })

  test("REST pagination is GET-only and slurp requires paginate", () => {
    expect(() =>
      classify({ action: "api", endpoint: "repos/cli/cli", method: "POST", paginate: true }),
    ).toThrow("REST pagination is supported only for GET")
    expect(() => classify({ action: "api", endpoint: "repos/cli/cli", slurp: true })).toThrow(
      "slurp requires paginate",
    )
  })

  test("GraphQL paginated variables must be scalar", () => {
    expect(
      classify({ action: "graphql", query: "query { viewer { login } }", paginate: true, variables: { cursor: "abc" } }),
    ).toEqual({ access: "read", command: "graphql" })
    expect(() =>
      classify({
        action: "graphql",
        query: "query { viewer { login } }",
        paginate: true,
        variables: { filter: { type: "USER" } },
      }),
    ).toThrow("scalar variables only")
  })

  test("GraphQL slurp requires paginate", () => {
    expect(() =>
      classify({ action: "graphql", query: "query { viewer { login } }", slurp: true }),
    ).toThrow("slurp requires paginate")
  })

  test("API absolute URLs and invalid previews are refused", () => {
    expect(() => classify({ action: "api", endpoint: "https://api.github.com/repos/cli/cli" })).toThrow(
      "api endpoint must be relative",
    )
    expect(() =>
      classify({ action: "api", endpoint: "repos/cli/cli", previews: ["bad preview"] }),
    ).toThrow("Invalid GitHub API preview name")
  })

  test("catalog and describe are read-only discovery", () => {
    expect(classify({ action: "catalog", q: "issue comment" })).toEqual({ access: "read", command: "catalog" })
    expect(classify({ action: "catalog", kind: "api", limit: 5 })).toEqual({ access: "read", command: "catalog" })
    expect(classify({ action: "describe", ref: "github:api:GET /repos/{owner}/{repo}/issues" })).toEqual({
      access: "read",
      command: "describe github:api:GET /repos/{owner}/{repo}/issues",
    })
  })

  test("catalog rejects foreign fields and describe requires a known ref", () => {
    expect(() => classify({ action: "catalog", endpoint: "repos/cli/cli" })).toThrow(
      "github catalog does not accept: endpoint",
    )
    expect(() => classify({ action: "describe" })).toThrow("describe action requires ref")
    expect(() => classify({ action: "describe", ref: "github:api:GET /nope" })).toThrow("Unknown catalog ref")
    expect(() => classify({ action: "describe", ref: "github:api:GET /repos/{owner}/{repo}/issues", q: "x" })).toThrow(
      "github describe does not accept: q",
    )
  })

  test("catalog search matches, filters, bounds, and ranks", () => {
    const all = catalogEntries()
    expect(all.length).toBeGreaterThan(100)
    expect(new Set(all.map((entry) => entry.ref)).size).toBe(all.length)

    const issues = searchCatalog({ q: "issue comment" })
    expect(issues.total).toBeGreaterThan(0)
    expect(issues.items.every((entry) => entry.ref.toLowerCase().includes("issue") || entry.summary.toLowerCase().includes("issue"))).toBe(true)

    const graphqlOnly = searchCatalog({ kind: "graphql" })
    expect(graphqlOnly.total).toBeGreaterThan(0)
    expect(graphqlOnly.items.every((entry) => entry.kind === "graphql")).toBe(true)

    const bounded = searchCatalog({ limit: 3 })
    expect(bounded.items.length).toBe(3)
    expect(bounded.truncated).toBe(true)

    const clamped = searchCatalog({ limit: 500 })
    expect(clamped.items.length).toBeLessThanOrEqual(25)
  })

  test("describe returns the invocation shape plus canonical envelope", () => {
    const entry = describeCatalogRef("github:api:POST /repos/{owner}/{repo}/issues/{n}/comments")
    expect(entry.access).toBe("write")
    expect(entry.example).toEqual({
      action: "api",
      endpoint: "repos/{owner}/{repo}/issues/{n}/comments",
      method: "POST",
    })
    const descriptor = catalogDescriptor(entry)
    expect(descriptor).toEqual({
      protocol: "capability-descriptor-v1",
      ref: entry.ref,
      kind: "github-api",
      description: entry.summary,
      inputSchema: entry.example,
      invocation: {
        tool: "github",
        action: "api",
        argsField: "endpoint",
        hint: JSON.stringify(entry.example),
      },
    })
  })
})
