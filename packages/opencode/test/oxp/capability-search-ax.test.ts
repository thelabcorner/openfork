import { describe, expect, test } from "bun:test"
import { OxpCapabilitySearch } from "@/oxp/capability-search"
import { CAPABILITY_DESCRIPTIONS } from "@/oxp/prose"

const catalog = [
  { id: "openfork_swarm", description: "Coordinate durable OpenFork Swarms; worker-only settlement requires a supervised Session.", focusActions: {
    "member.batch": {}, "task.batch": {}, delegate: {}, "message.send": {},
  } },
  { id: "openfork_worker", description: "Create/manage durable workers; model_catalog lists models; agent_catalog lists agents." },
  { id: "json", description: "Analyze JSON/JSONC/JSONL/BSON by validate, query, search, schema, diff or stats." },
  { id: "patch", description: "Apply verified multi-file patches and report conflicts." },
  { id: "symbols", description: "Search symbol declarations, references, usages and outline." },
  { id: "read", description: "Read bounded file contents inside approved roots." },
  { id: "find", description: "Find files using glob or bounded grep." },
  { id: "git", description: "Inspect repository status, diff and history." },
  { id: "project", description: "Inspect workspace projects and runtime toolchains." },
  { id: "test", description: "Run project test suites and filters." },
  { id: "browser", description: "Control the shared desktop browser." },
  { id: "schedule", description: "List and run scheduled automations." },
  { id: "openfork_session.checkpoint", description: "Inspect or restore Session checkpoints." },
  { id: "process", description: "Run commands using a shell or argv." },
] as const

function legacy(query: string): string[] {
  const tokens = query.trim().toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  return catalog.filter(item => tokens.every(token =>
    (item.id + " " + item.description).toLowerCase().replace(/[^a-z0-9]+/g, " ").includes(token),
  )).map(item => item.id).sort()
}

const tasks = [
  { query: "batch workers", expected: "openfork_swarm" },
  { query: "JSON patches", expected: "json" },
  { query: "find symbol references", expected: "symbols" },
  { query: "show file content", expected: "read" },
  { query: "restore checkpoint", expected: "openfork_session.checkpoint" },
  { query: "run tests", expected: "test" },
  { query: "project runtime versions", expected: "project" },
  { query: "shell command output", expected: "process" },
  { query: "coordinate member batch", expected: "openfork_swarm" },
  { query: "browse screenshot tab", expected: "browser" },
  { query: "git status history", expected: "git" },
  { query: "grep regex files", expected: "find" },
] as const

describe("OXP tool search AX Pareto gate", () => {
  test("ranks a predeclared natural-language tool selection corpus without expanding schemas", () => {
    let oldHits = 0
    let newHits = 0
    let oldReciprocal = 0
    let newReciprocal = 0
    for (const task of tasks) {
      const found = OxpCapabilitySearch.rankCapabilities(catalog, task.query).map(item => item.id)
      const prior = legacy(task.query)
      expect(found.length, task.query).toBeGreaterThan(0)
      expect(found.slice(0, 3), task.query).toContain(task.expected)
      const oldRank = prior.indexOf(task.expected)
      const newRank = found.indexOf(task.expected)
      if (oldRank >= 0 && oldRank < 3) oldHits++
      if (newRank >= 0 && newRank < 3) newHits++
      oldReciprocal += oldRank >= 0 ? 1 / (oldRank + 1) : 0
      newReciprocal += newRank >= 0 ? 1 / (newRank + 1) : 0
    }
    console.log("AX-DISCOVERY-RETRIEVAL", JSON.stringify({
      corpus: tasks.length,
      baselineRecallAt3: oldHits / tasks.length,
      candidateRecallAt3: newHits / tasks.length,
      baselineMRR: oldReciprocal / tasks.length,
      candidateMRR: newReciprocal / tasks.length,
      provenance: "curated lexical retrieval fixture; not real model task completion",
    }))
    expect(newHits).toBe(tasks.length)
    expect(newHits).toBeGreaterThan(oldHits)
    expect(newReciprocal).toBeGreaterThan(oldReciprocal)
    // Baseline observed: these exact cases produce no relevant result with the
    // old all-terms substring filter. Same corpus, no model/token inference.
    expect(legacy("batch workers")).toEqual([])
    expect(legacy("JSON patches")).toEqual([])
  })

  test("preserves unfiltered catalog completeness, order and stable tie-breaking", () => {
    const ids = OxpCapabilitySearch.rankCapabilities(catalog).map(item => item.id)
    expect(ids).toEqual([...ids].sort())
    expect(new Set(ids).size).toBe(catalog.length)
    expect(OxpCapabilitySearch.rankCapabilities(catalog, "")).toEqual(
      OxpCapabilitySearch.rankCapabilities(catalog),
    )
    // Explicit, content-free search should not dump 33+ descriptions into an
    // agent prompt merely because stopwords/punctuation yielded zero tokens.
    expect(OxpCapabilitySearch.rankCapabilities(catalog, "????")).toEqual([])
    expect(OxpCapabilitySearch.rankCapabilities(catalog, "please help me")).toEqual([])
    expect(OxpCapabilitySearch.rankCapabilities(catalog, "   ").map(item => item.id)).toEqual(ids)
    expect(OxpCapabilitySearch.rankCapabilities(catalog, "batch workers"))
      .toEqual(OxpCapabilitySearch.rankCapabilities(catalog, "batch workers"))
  })

  test("unknown query and adversarial long input do not create fake capabilities", () => {
    expect(OxpCapabilitySearch.rankCapabilities(catalog, "zzzzunsupportedharnessfeature")).toEqual([])
    const long = OxpCapabilitySearch.rankCapabilities(catalog, "worker ".repeat(100000))
    expect(long.length).toBeLessThanOrEqual(catalog.length)
    expect(long.every(item => catalog.some(original => original.id === item.id))).toBe(true)
  })

  test("abstains on generic prose and handles owner-scoped unsupported capabilities", () => {
    const source = Object.entries(CAPABILITY_DESCRIPTIONS).map(([id, description]) => ({ id, description }))
    expect(OxpCapabilitySearch.rankCapabilities(source, "Write a poem about a kitten")).toEqual([])
    expect(OxpCapabilitySearch.rankCapabilities(source, "How much provider quota do I have left?")).toEqual([])
    expect(OxpCapabilitySearch.rankCapabilities(source, "Show me the last two hundred lines of a file")[0]?.id).toBe("read")
    expect(OxpCapabilitySearch.rankCapabilities(source, "Locate TypeScript filenames using glob patterns")[0]?.id).toBe("find")
    // Do not hide a separate authorized MCP tool that genuinely supports quota.
    const external = { id: "models", description: "Read configured provider quota and current balance for a permitted user." }
    expect(OxpCapabilitySearch.rankCapabilities([external], "provider quota")).toEqual([external])
  })

  test("action terms are discoverable without confusing an action with an authority grant", () => {
    const list = OxpCapabilitySearch.rankCapabilities(catalog, "task.batch")
    expect(list[0]?.id).toBe("openfork_swarm")
    expect(list[0]).not.toHaveProperty("grant")
    // Search-only metadata cannot invent an executable action or root.
    expect(OxpCapabilitySearch.rankCapabilities(catalog, "swarm admin.force")[0]?.id)
      .toBe("openfork_swarm")
  })

  test("identity-cached search indexes invalidate on changed descriptions or reviewed actions", () => {
    const item: { id: string; description: string; focusActions: Record<string, unknown> } = {
      id: "local-lookup",
      description: "List project files",
      focusActions: { list: {} },
    }
    expect(OxpCapabilitySearch.rankCapabilities([item], "project files")).toEqual([item])
    item.description = "Inspect model execution receipts"
    expect(OxpCapabilitySearch.rankCapabilities([item], "project files")).toEqual([])
    expect(OxpCapabilitySearch.rankCapabilities([item], "execution receipts")).toEqual([item])
    item.focusActions = { "task.batch": {} }
    expect(OxpCapabilitySearch.rankCapabilities([item], "task batch")).toEqual([item])
  })

  test("retrieves action intent without mistaking request scaffolding for the operation", () => {
    const source = Object.entries(CAPABILITY_DESCRIPTIONS).map(([id, description]) => ({ id, description }))
    const intents = [
      ["Find all callers of transformPath", "symbols"],
      ["Search for TODO comments across the repository", "find"],
      ["Which source files have uncommitted changes?", "git"],
      ["Walk me through the repo packages and scripts", "project"],
      ["Rename a function safely throughout the codebase", "refactor"],
      ["Unpack this tarball to an approved directory", "archive"],
      ["Differentiate this polynomial symbolically", "sympy"],
      ["Search the internet for project documentation", "web"],
    ] as const
    for (const [query, expected] of intents) {
      const results = OxpCapabilitySearch.rankCapabilities(source, query).map((item) => item.id)
      expect(results.slice(0, 3), query).toContain(expected)
    }
    // Permission boilerplate must not dominate task-action terms.
    const archive = OxpCapabilitySearch.rankCapabilities(source, "unpack tarball in approved directory")
    expect(archive[0]?.id).toBe("archive")
  })

  test("remains conservative on unsupported personal and creative tasks", () => {
    const source = Object.entries(CAPABILITY_DESCRIPTIONS).map(([id, description]) => ({ id, description }))
    for (const query of [
      "Tell me a funny story about turtles",
      "Suggest 5 baby names",
      "Create a fictional character biography",
      "My Experian credit score this morning",
      "Check my bank deposits today",
      "What's the weather in Tokyo this evening?",
      "Make me a portrait of a robot",
      "Calculate my retirement savings needed",
    ]) expect(OxpCapabilitySearch.rankCapabilities(source, query), query).toEqual([])
  })

  test("does not apply OpenFork-owned operation hints to foreign MCP tools with colliding names", () => {
    const remote = { id: "git", namespace: "mcp" as const, description: "Render plotting charts for scientific datasets." }
    const local = { id: "git", namespace: "openfork" as const, description: CAPABILITY_DESCRIPTIONS.git }
    const query = "uncommitted changes in checkout"
    expect(OxpCapabilitySearch.rankCapabilities([remote], query)).toEqual([])
    expect(OxpCapabilitySearch.rankCapabilities([local], query)).toEqual([local])
    // Namespace is not authority. This only influences discovery ranking; a
    // foreign capability that actually offers the requested feature still ranks.
    const real = { id: "git", namespace: "mcp" as const, description: "Inspect uncommitted checkout changes." }
    expect(OxpCapabilitySearch.rankCapabilities([real], query)).toEqual([real])
  })

  test("distinguishes tool operations from explanations, creative mentions and definitions", () => {
    const source = Object.entries(CAPABILITY_DESCRIPTIONS).map(([id, description]) => ({ id, description }))
    const operationQueries = [
      ["Inspect git diff for modified files", "git"],
      ["Search usage sites of normalizeGroupBounds", "symbols"],
      ["Compute a symbolic antiderivative of x cubed", "sympy"],
      ["Find what my previous coding session decided", "memory"],
      ["What are the outstanding changes in this checkout?", "git"],
      ["Compare these JSON logs", "json"],
      ["Summarize my recent commits", "git"],
      ["Explain these diagnostics", "typecheck"],
      ["What does the archive tool do?", "archive"],
      ["Explain differences between these JSON logs", "json"],
    ] as const
    for (const [query, expected] of operationQueries) {
      expect(OxpCapabilitySearch.rankCapabilities(source, query).slice(0, 3).map((item) => item.id), query)
        .toContain(expected)
    }
    for (const query of [
      "Explain the difference between Git merge and rebase",
      "Explain the ZIP compression format",
      "What is symbolic mathematics?",
      "How do browsers render CSS layouts conceptually?",
      "What does WAL stand for in SQLite?",
      "Explain how periodic scheduled jobs work",
      "Write a poem about a rusty process running in a terminal",
      "Write a paragraph describing a read-only document",
      "A children's story about extracting treasure from an archive",
      "Describe model context windows for beginners",
    ]) {
      expect(OxpCapabilitySearch.rankCapabilities(source, query), query).toEqual([])
    }
  })

  test("practical questions are not misclassified as conceptual explanations", () => {
    const source = Object.entries(CAPABILITY_DESCRIPTIONS).map(([id, description]) => ({ id, description }))
    for (const [query, expected] of [
      ["What are my scheduled automations?", "schedule"],
      ["What's the last commit in this repository?", "git"],
      ["What does my current Git diff contain?", "git"],
      ["Why did this test in my repository fail?", "test"],
      ["Which workers are currently blocked and waiting?", "openfork_worker"],
      ["How do I list symbol references in the repository?", "symbols"],
      ["What does my model token usage look like?", "usage"],
      ["What's in this ZIP archive?", "archive"],
      ["What were the last errors printed by this running process?", "process"],
      ["What does the OXP browser tab display right now?", "browser"],
    ] as const) {
      expect(OxpCapabilitySearch.rankCapabilities(source, query).slice(0, 3).map((item) => item.id), query)
        .toContain(expected)
    }
  })

  test("politeness scaffolds preserve operational intent and no-tool abstention", () => {
    const source = Object.entries(CAPABILITY_DESCRIPTIONS).map(([id, description]) => ({ id, description }))
    const positive = [
      ["Check my current Git diff", "git"],
      ["Show me the README file contents", "read"],
      ["Describe the entries in this tarball", "archive"],
      ["What are my latest scheduled automations?", "schedule"],
    ] as const
    const negative = [
      "Explain what a Git commit is",
      "What does WAL stand for in SQLite?",
      "Describe what symbolic integration means",
      "Explain the ZIP file format",
      "Summarize the history of TypeScript",
    ] as const
    for (const prefix of ["", "Please ", "Could you ", "I'd like you to ", "If possible, "]) {
      for (const [query, expected] of positive) {
        const wrapped = prefix + (prefix ? query[0]!.toLowerCase() + query.slice(1) : query)
        expect(OxpCapabilitySearch.rankCapabilities(source, wrapped).slice(0, 3).map((x) => x.id), wrapped)
          .toContain(expected)
      }
      for (const query of negative) {
        const wrapped = prefix + (prefix ? query[0]!.toLowerCase() + query.slice(1) : query)
        expect(OxpCapabilitySearch.rankCapabilities(source, wrapped), wrapped).toEqual([])
      }
    }
  })
})

export { tasks as CAPABILITY_AX_QUERIES, catalog as CAPABILITY_AX_FIXTURE, legacy as legacyCapabilitySearch }
