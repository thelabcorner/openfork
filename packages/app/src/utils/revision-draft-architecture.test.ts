import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../..")
const source = (relative: string) => fs.readFile(path.join(root, relative), "utf8")

function before(text: string, first: string, second: string) {
  const a = text.indexOf(first)
  const b = text.indexOf(second, Math.max(0, a))
  expect(a).toBeGreaterThanOrEqual(0)
  expect(b).toBeGreaterThan(a)
}

describe("revision draft ownership architecture", () => {
  test("Prompt transfers ownership only after its canonical draft is durable", async () => {
    const text = await source("src/components/prompt-input-v2.tsx")
    const send = text.slice(text.indexOf("const send = async"), text.indexOf("const run = async", text.indexOf("const send = async")))
    before(send, "await props.controller.flushDraft()", "consumeArtifact(result.artifactID)")
    expect(send).toContain("if (changed(flow))")
    expect(text).toContain("targetKey() !== flow.target.key")
    expect(text).toContain("artifact.key !== targetKey()")

    const applyRecovered = text.slice(
      text.indexOf("const applyRecovered = async"),
      text.indexOf("createEffect(() =>", text.indexOf("const applyRecovered = async")),
    )
    before(applyRecovered, "await props.controller.flushDraft()", "await consumeArtifact(artifact.id)")

    const recovery = text.slice(
      text.indexOf("const structurallyApplied ="),
      text.indexOf("const changed =", text.indexOf("const structurallyApplied =")),
    )
    expect(recovery).toContain("promptRevisionArtifactIsApplied")
    before(recovery, "await props.controller.flushDraft()", "await consumeArtifact(artifact.id)")
    expect(recovery).toContain("consumeIfEqual: false")
    expect(recovery).not.toContain('if (decision === "consume")')
  })

  test("Goal transfers ownership only after each durable Goal mutation succeeds", async () => {
    const text = await source("src/components/goal-composer-shelf.tsx")
    before(text, "await goals.updateActive", "await refine.commit()")
    before(text, "await goals.updateDraft", "await refine.commit()")
    before(text, "await goals.createAndFocus", "await refine.commit()")
    expect(text).toContain("requireExplicitRecovery: true")
    expect(text).not.toContain("consumeArtifact(result.artifactID)")
    expect(text).toContain("revisionWorkspaceSourceFingerprint({ directory, source: draft })")
    expect(text).toContain('location: { directory: flow.directory }')
    expect(text).toContain("input.targetKey() !== flow.target.key")
  })

  test("Scheduled Task retains revised form state until create/update commits", async () => {
    const text = await source("src/components/scheduled-task-editor.tsx")
    const submit = text.slice(text.indexOf("const submit = async"), text.indexOf("const chooseDirectory"))
    const update = submit.indexOf("await store.update")
    const create = submit.indexOf("await store.create")
    const consume = submit.indexOf("await commitRevisionArtifact()")
    expect(update).toBeGreaterThanOrEqual(0)
    expect(create).toBeGreaterThanOrEqual(0)
    expect(consume).toBeGreaterThan(update)
    expect(consume).toBeGreaterThan(create)

    expect(text).toContain("rememberRevisionArtifact(result.artifactID)")
    expect(text).not.toContain("consumeRevisionArtifact(result.artifactID)")
    expect(text).toContain("requireExplicitApply: !existing")
    expect(text).toContain("revisionFingerprint() !== fingerprint")
    expect(text).toContain("location: { directory }")
    expect(text).toContain("revisionTargetKey() !== revisionTarget.key")
  })
})
