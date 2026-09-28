import path from "node:path"
import { describe, expect, test } from "bun:test"
import {
  fileActivityIdentity,
  fileActivityInput,
  fileActivityProject,
  fileActivityRoute,
  fileActivityTargets,
} from "../../src/oxp/server"
import { OxpSchema } from "../../src/oxp/schema"
import type { OxpResult } from "../../src/oxp/result"
import type { OxpRoot } from "../../src/oxp/root"

const committed = (
  structured: unknown,
  mutation: OxpResult.MutationResult = { attempted: true, committed: true },
): OxpResult.CapabilityResult => ({
  output: "ok",
  structured,
  mutation,
})

describe("OXP file-transfer coding activity boundary", () => {
  test("recognizes only direct or brokered file-transfer routes", () => {
    expect(fileActivityRoute("openai_files", { action: "save_chatgpt_file" })).toBe(true)
    expect(
      fileActivityRoute("capability", {
        namespace: "openfork",
        capability: "file.transfer",
      }),
    ).toBe(true)

    expect(fileActivityRoute("read", { path: "/project/a.ts" })).toBe(false)
    expect(fileActivityRoute("capability", { namespace: "openfork", capability: "read" })).toBe(false)
    expect(fileActivityRoute("capability", { namespace: "other", capability: "file.transfer" })).toBe(false)
  })

  test("projects committed local transfer effects without inventing line deltas", () => {
    expect(
      fileActivityTargets(
        "openai_files",
        {},
        committed({ action: "save_chatgpt_file", path: "/project/download.txt", bytes: 12 }),
      ),
    ).toEqual([{ kind: "write", virtualPath: "/project/download.txt" }])

    expect(
      fileActivityTargets(
        "capability",
        { namespace: "openfork", capability: "file.transfer" },
        committed({ action: "upload_openai_file", source: "/project/upload.txt", bytes: 12 }),
      ),
    ).toEqual([{ kind: "read", virtualPath: "/project/upload.txt" }])
  })

  test("stays silent for discovery, failed, uncommitted, and malformed transfer results", () => {
    const broker = { namespace: "openfork", capability: "file.transfer" }

    expect(fileActivityTargets("openai_files", {}, committed({ action: "get_openai_file", fileID: "file_1" }))).toEqual([])
    expect(fileActivityTargets("capability", broker, committed({ action: "list_openai_files", files: [] }))).toEqual([])
    expect(
      fileActivityTargets(
        "openai_files",
        {},
        committed(
          { action: "save_chatgpt_file", path: "/project/not-committed.txt" },
          { attempted: true, committed: false },
        ),
      ),
    ).toEqual([])
    expect(fileActivityTargets("openai_files", {}, { output: "failed" })).toEqual([])
    expect(fileActivityTargets("openai_files", {}, committed({ action: "save_chatgpt_file" }))).toEqual([])
  })

  test("derives entity, project, and folder only from the verified approved root", () => {
    const canonicalRoot = path.resolve("C:/approved/example-project")
    const entity = path.join(canonicalRoot, "nested", "file.ts")
    const root: OxpSchema.Root = {
      id: OxpSchema.RootID.make("00000000-0000-4000-8000-000000000001"),
      alias: OxpSchema.RootAlias.make("public-alias"),
      path: canonicalRoot,
      approvedAt: 1,
      sources: ["project"],
    }
    const resolved: OxpRoot.ResolvedPath = {
      root,
      canonicalPath: canonicalRoot,
      path: entity,
      virtualPath: "/public-alias/nested/file.ts",
    }

    expect(fileActivityProject(canonicalRoot, "public-alias")).toBe(path.basename(canonicalRoot))
    const input = fileActivityInput("write", resolved)
    expect(input).toEqual({
      entity,
      kind: "write",
      project: path.basename(canonicalRoot),
      projectFolder: canonicalRoot,
      source: "oxp",
    })
    expect(input.aiLineChanges).toBeUndefined()
    expect(input.aiSession).toBeUndefined()
    expect(input.sourceRef).toBeUndefined()
  })

  test("canonical file identity makes call-local dedupe deterministic", () => {
    const target = path.resolve("C:/approved/example-project", "nested", "file.ts")
    const equivalent = path.join(path.dirname(target), ".", path.basename(target))
    expect(fileActivityIdentity(equivalent)).toBe(fileActivityIdentity(target))

    // Identity is pure process-local state: concurrent calls compute the same
    // key independently and share no mutable dedupe map.
    const concurrent = Array.from({ length: 8 }, () => fileActivityIdentity(equivalent))
    expect(new Set(concurrent)).toEqual(new Set([fileActivityIdentity(target)]))
  })
})
