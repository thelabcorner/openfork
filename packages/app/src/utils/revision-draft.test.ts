import { describe, expect, test } from "bun:test"
import {
  promptRevisionTargetKey,
  promptRevisionSourceFingerprint,
  revisionRecoveryDecision,
  revisionCanApplyNow,
  revisionSourceFingerprint,
  revisionWorkspaceSourceFingerprint,
  scheduledTaskRevisionTargetKey,
} from "./revision-draft"

describe("revision draft recovery policy", () => {
  test("uses globally stable prompt target identities", () => {
    expect(promptRevisionTargetKey({ sessionID: "ses_1", draftID: "ignored", directory: "/a" })).toBe(
      "session:ses_1",
    )
    expect(promptRevisionTargetKey({ draftID: "draft_1", directory: "/a" })).toBe("draft:draft_1")
    expect(promptRevisionTargetKey({ draftID: "draft_1", directory: "/b" })).toBe("draft:draft_1")
    expect(promptRevisionTargetKey({ directory: "/a", windowID: "win-a" })).toBe("new:window:win-a")
    expect(promptRevisionTargetKey({ directory: "/a" })).toBe("workspace:/a")
    expect(promptRevisionTargetKey({ directory: "/b" })).not.toBe(promptRevisionTargetKey({ directory: "/a" }))
  })

  test("keeps Prompt editor identity stable while fencing workspace context separately", async () => {
    const source = "prompt-parts-fingerprint"
    expect(
      await promptRevisionSourceFingerprint({
        directory: "/a",
        promptFingerprint: source,
      }),
    ).not.toBe(
      await promptRevisionSourceFingerprint({
        directory: "/b",
        promptFingerprint: source,
      }),
    )
    expect(
      await promptRevisionSourceFingerprint({
        directory: "/a",
        promptFingerprint: source,
      }),
    ).toBe(
      await promptRevisionSourceFingerprint({
        directory: "/a",
        promptFingerprint: source,
      }),
    )
  })

  test("scopes recovery source fingerprints to the workspace without changing target identity", async () => {
    expect(await revisionWorkspaceSourceFingerprint({ directory: "/a", source: "same-editor-state" })).not.toBe(
      await revisionWorkspaceSourceFingerprint({ directory: "/b", source: "same-editor-state" }),
    )
  })

  test("isolates new scheduled-task recovery by durable desktop window identity", () => {
    expect(scheduledTaskRevisionTargetKey({ taskID: "task_1", directory: "/a", windowID: "win-a" })).toBe(
      "task:task_1",
    )
    expect(scheduledTaskRevisionTargetKey({ directory: "/a", windowID: "win-a" })).toBe("new:window:win-a")
    expect(scheduledTaskRevisionTargetKey({ directory: "/a", windowID: "win-b" })).toBe("new:window:win-b")
    expect(scheduledTaskRevisionTargetKey({ directory: "/a" })).toBe("new:workspace:/a")
  })

  test("fingerprints source deterministically without persisting the source body", async () => {
    const first = await revisionSourceFingerprint("same source")
    const second = await revisionSourceFingerprint("same source")
    expect(first).toBe(second)
    expect(first).not.toBe(await revisionSourceFingerprint("changed source"))
    expect(first.length).toBeGreaterThan(20)
  })

  test("auto-applies only when the source fence matches", () => {
    expect(
      revisionRecoveryDecision({
        sourceFingerprint: "source",
        currentFingerprint: "source",
        currentText: "old",
        revisedText: "new",
      }),
    ).toBe("apply")
    expect(
      revisionRecoveryDecision({
        sourceFingerprint: "source",
        currentFingerprint: "changed",
        currentText: "user changed this",
        revisedText: "new",
      }),
    ).toBe("conflict")
  })

  test("consumes already-applied durable results but keeps an unrelated empty editor fenced", () => {
    expect(
      revisionRecoveryDecision({
        sourceFingerprint: "source",
        currentFingerprint: "different",
        currentText: "new",
        revisedText: "new",
      }),
    ).toBe("consume")
    expect(
      revisionRecoveryDecision({
        sourceFingerprint: "source",
        currentFingerprint: "different",
        currentText: "",
        revisedText: "recovered",
      }),
    ).toBe("conflict")
  })

  test("does not let text equality bypass the source fence inside an ephemeral editor", () => {
    expect(
      revisionRecoveryDecision({
        sourceFingerprint: "source",
        currentFingerprint: "different",
        currentText: "revised but not saved",
        revisedText: "revised but not saved",
        consumeIfEqual: false,
      }),
    ).toBe("conflict")
    expect(
      revisionRecoveryDecision({
        sourceFingerprint: "source",
        currentFingerprint: "source",
        currentText: "revised but not saved",
        revisedText: "revised but not saved",
        consumeIfEqual: false,
      }),
    ).toBe("apply")
    expect(
      revisionCanApplyNow({
        expectedFingerprint: "different",
        currentFingerprint: "different",
      }),
    ).toBe(true)
  })

  test("requires an explicit recovery decision for pre-creation editors even when reconstructed source matches", () => {
    expect(
      revisionRecoveryDecision({
        sourceFingerprint: "same-source",
        currentFingerprint: "same-source",
        currentText: "",
        revisedText: "retained revision",
        consumeIfEqual: false,
        requireExplicitApply: true,
      }),
    ).toBe("conflict")
    expect(
      revisionCanApplyNow({
        expectedFingerprint: "same-source",
        currentFingerprint: "same-source",
      }),
    ).toBe(true)
  })

  test("revalidates a delayed recovery action against the exact editor snapshot it was offered against", () => {
    expect(
      revisionCanApplyNow({
        expectedFingerprint: "source",
        currentFingerprint: "source",
      }),
    ).toBe(true)
    expect(
      revisionCanApplyNow({
        expectedFingerprint: "source",
        currentFingerprint: "user-edited",
      }),
    ).toBe(false)
  })
})
