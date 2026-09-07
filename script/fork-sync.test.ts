import { describe, expect, test } from "bun:test"
import { checkSnapshot, classifyConflict, mergePackageJson, mergeWorkspacePackages, snapshotPackageJson } from "./fork-sync"

const PRUNE = ["packages/console", "packages/web", "infra", "nix", "sdks", "packages/cli"]

describe("classifyConflict", () => {
  test("DROP trees always prune, even with awkward paths", () => {
    expect(classifyConflict("packages/console/app/package.json", PRUNE)).toBe("prune")
    expect(classifyConflict("packages/web/src/content/docs/zen.mdx", PRUNE)).toBe("prune")
    expect(classifyConflict("infra/console.ts", PRUNE)).toBe("prune")
    expect(classifyConflict("packages/console/app/src/routes/workspace/[id]/billing/reload-section.tsx", PRUNE)).toBe("prune")
    expect(classifyConflict("sdks/vscode/package.json", PRUNE)).toBe("prune")
  })
  test("lock, manifests, generated", () => {
    expect(classifyConflict("bun.lock", PRUNE)).toBe("lock")
    expect(classifyConflict("package.json", PRUNE)).toBe("pkg-union")
    expect(classifyConflict("packages/opencode/package.json", PRUNE)).toBe("pkg-union")
    expect(classifyConflict("packages/client/src/generated/client.ts", PRUNE)).toBe("generated")
    expect(classifyConflict("packages/sdk/js/src/v2/gen/sdk.gen.ts", PRUNE)).toBe("generated")
  })
  test("fork-owned and meta keep ours", () => {
    expect(classifyConflict("packages/app/src/components/titlebar-tab-nav.tsx", PRUNE)).toBe("fork-ours")
    expect(classifyConflict("packages/core/src/session/title.ts", PRUNE)).toBe("fork-ours")
    expect(classifyConflict("packages/opencode/src/fork/credentials.ts", PRUNE)).toBe("fork-ours")
    expect(classifyConflict("packages/core/src/goal/automation.ts", PRUNE)).toBe("fork-ours")
    expect(classifyConflict("packages/schema/src/goal.ts", PRUNE)).toBe("fork-ours")
    expect(classifyConflict("packages/opencode/src/tool/goal.ts", PRUNE)).toBe("fork-ours")
    expect(classifyConflict("packages/app/src/components/goal-composer-shelf.tsx", PRUNE)).toBe("fork-ours")
    expect(classifyConflict("FORK.md", PRUNE)).toBe("meta-ours")
    expect(classifyConflict("docs/handoff/AGENTS.md", PRUNE)).toBe("meta-ours")
  })
  test("unions and unknowns need a human", () => {
    expect(classifyConflict("packages/opencode/src/tool/registry.ts", PRUNE)).toBe("union-manual")
    expect(classifyConflict("packages/opencode/src/session/prompt.ts", PRUNE)).toBe("union-manual")
    expect(classifyConflict("packages/app/src/components/some-new-thing.tsx", PRUNE)).toBe("manual")
  })
})

describe("mergePackageJson", () => {
  test("v1.18.29 regression: fork-only exports survive", () => {
    const ours = {
      version: "1.18.27",
      exports: { "./memory": "./src/memory/index.ts", "./*": "./src/*.ts" },
      dependencies: { "web-push": "3.6.7", effect: "catalog:" },
      scripts: { dev: "fork-dev", "fork:prune": "bun run script/fork-prune.ts" },
    }
    const theirs = {
      version: "1.18.29",
      exports: { "./*": "./src/*.ts" },
      dependencies: { effect: "catalog:", "@aws-sdk/client-s3": "1.0.0" },
      scripts: { dev: "upstream-dev", "dev:console": "bun console", sso: "aws sso" },
    }
    const { merged, report } = mergePackageJson("packages/core/package.json", ours, theirs)
    expect(merged.version).toBe("1.18.29")
    expect(merged.exports["./memory"]).toBe("./src/memory/index.ts")
    expect(merged.dependencies["web-push"]).toBe("3.6.7")
    expect(merged.dependencies["@aws-sdk/client-s3"]).toBe("1.0.0")
    expect(merged.scripts["fork:prune"]).toBeDefined()
    expect(merged.scripts.dev).toBe("fork-dev")
    expect(merged.scripts["dev:console"]).toBeUndefined()
    expect(merged.scripts.sso).toBeUndefined()
    expect(report.forkOnlyKept).toContain("exports../memory")
  })

  test("overlapping dep ranges take upstream", () => {
    const { merged, report } = mergePackageJson(
      "package.json",
      { dependencies: { effect: "0.0.1-fork" } },
      { dependencies: { effect: "9.9.9" } },
    )
    expect(merged.dependencies.effect).toBe("9.9.9")
    expect(report.overlapUpstreamWins).toContain("dependencies.effect")
  })

  test("fork-only top-level keys are preserved, workspaces stay upstream", () => {
    const { merged } = mergePackageJson(
      "package.json",
      { workspaces: ["packages/a"], homepage: "https://fork.example", version: "1.0.0" },
      { workspaces: ["packages/a", "packages/b"], version: "2.0.0" },
    )
    expect(merged.homepage).toBe("https://fork.example")
    expect(merged.workspaces).toEqual(["packages/a", "packages/b"])
  })
})

describe("mergeWorkspacePackages", () => {
  const opts = {
    workspaceExists: (e: string) => ["packages/app", "packages/tui", "packages/news"].includes(e),
    isDropWorkspace: (e: string) => ["packages/slack", "packages/console/app"].some((d) => e === d || e.startsWith(d + "/")),
  }
  test("v1.18.29 regression: globs and DROP entries never survive", () => {
    const { packages, dropped } = mergeWorkspacePackages(["packages/app", "packages/tui"], ["packages/*", "packages/console/*", "packages/slack", "packages/news"], opts)
    expect(packages).toEqual(["packages/app", "packages/news", "packages/tui"])
    expect(dropped).toContain("packages/*")
    expect(dropped).toContain("packages/slack")
  })
  test("nonexistent entries are dropped", () => {
    const { packages } = mergeWorkspacePackages(["packages/gone"], [], opts)
    expect(packages).toEqual([])
  })
})
describe("snapshot round-trip", () => {
  test("checkSnapshot catches a lost export", () => {
    const ours = { exports: { "./memory": "./src/memory/index.ts" }, scripts: { "fork:prune": "x" } }
    const theirs = { exports: {}, scripts: {} }
    const snap = snapshotPackageJson("packages/core/package.json", ours, theirs)
    expect(checkSnapshot(snap, ours)).toEqual([])
    expect(checkSnapshot(snap, theirs)).toContain("exports../memory")
  })
})
