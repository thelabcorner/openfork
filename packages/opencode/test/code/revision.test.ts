import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as Capability from "@/tool/capability"
import * as Revision from "@/code/revision"

const native = (id: string, schema: object = { type: "object", properties: {} }): Capability.Registration => ({
  identity: Capability.nativeIdentity(id),
  kind: "native",
  description: id,
  inputSchema: schema,
  authorize: () => Effect.die(new Error("unused")),
  invokeSemantic: () => Effect.die(new Error("unused")),
  authorityBinding: `native:${id}:v1`,
  classifyWorkspaceMutation: () => false,
  codeCallable: true,
  lifetime: "inline",
})

describe("saved Code revision identity", () => {
  test("canonicalizes source without trimming or Unicode normalization", () => {
    expect(Revision.canonicalSource("\uFEFFconst x = 1\r\nreturn x\r")).toBe("const x = 1\nreturn x\n")
    expect(Revision.canonicalSource("  return 'é'  ")).toBe("  return 'é'  ")
  })

  test("enforces portable deterministic saved IDs", () => {
    expect(Revision.validateID("find_todos")).toBe("find_todos")
    for (const id of ["Find", "9bad", "with-dash", "global", "project", "con", "lpt1"]) {
      expect(() => Revision.validateID(id)).toThrow()
    }
  })

  test("description and tags do not alter executable revision identity", () => {
    const a = Revision.derive({
      source: "return input",
      spec: { name: "echo", description: "first", tags: ["one"] },
      dependencies: [],
    })
    const b = Revision.derive({
      source: "return input",
      spec: { name: "echo", description: "second", tags: ["two"] },
      dependencies: [],
    })

    expect(a.revision).toBe(b.revision)
    expect(a.descriptorFingerprint).not.toBe(b.descriptorFingerprint)
  })

  test("dependency execution contracts participate in revision identity, prose does not", () => {
    const a = native("read")
    const proseChanged = { ...a, description: "new prose" }
    const schemaChanged = native("read", {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    })

    expect(Revision.executionContract(a)).toBe(Revision.executionContract(proseChanged))
    expect(Revision.executionContract(a)).not.toBe(Revision.executionContract(schemaChanged))
  })

  test("derives sorted exact static dependency contracts and rejects dynamic refs", () => {
    const a = native("alpha")
    const z = native("zeta")
    const inventory: Capability.Inventory = { generation: "g1", entries: [z, a] }

    const deps = Revision.dependencies({
      refs: [z.identity.ref, a.identity.ref, z.identity.ref],
      dynamicCallTarget: false,
      inventory,
      scope: "project",
    })
    expect(deps.map((item) => item.ref)).toEqual([a.identity.ref, z.identity.ref])
    expect(() =>
      Revision.dependencies({
        refs: [],
        dynamicCallTarget: true,
        inventory,
        scope: "project",
      }),
    ).toThrow("computed call")
  })

  test("global saved tools cannot pin project saved revisions", () => {
    const projectSaved: Capability.Registration = {
      ...native("saved"),
      identity: Capability.savedIdentity("project", "child", "sha256:abc"),
      kind: "saved",
      revision: "sha256:abc",
      authorityBinding: "saved:project:child",
    }
    const inventory = { generation: "g", entries: [projectSaved] }

    expect(() =>
      Revision.dependencies({
        refs: [projectSaved.identity.ref],
        dynamicCallTarget: false,
        inventory,
        scope: "global",
      }),
    ).toThrow("cannot pin project-scoped")
  })

  test("preflights captured contracts without silently adopting a changed capability", () => {
    const original = native("read")
    const captured = Revision.captureDependencies({
      refs: [original.identity.ref],
      inventory: { generation: "g1", entries: [original] },
    })

    expect(() =>
      Revision.preflightDependencies({
        dependencies: captured,
        inventory: { generation: "g1", entries: [original] },
        scope: "project",
      }),
    ).not.toThrow()

    const changed = native("read", {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    })
    expect(() =>
      Revision.preflightDependencies({
        dependencies: captured,
        inventory: { generation: "g2", entries: [changed] },
        scope: "project",
      }),
    ).toThrow("execution contract changed")
  })

  test("verifies source hash and executable revision independently", () => {
    const derived = Revision.derive({
      source: "return 1",
      spec: { name: "constant" },
      dependencies: [],
    })
    expect(() =>
      Revision.verify({
        source: derived.source,
        envelope: derived.envelope,
        expectedRevision: derived.revision,
      }),
    ).not.toThrow()
    expect(() =>
      Revision.verify({
        source: "return 2",
        envelope: derived.envelope,
        expectedRevision: derived.revision,
      }),
    ).toThrow("source hash")
  })
})
