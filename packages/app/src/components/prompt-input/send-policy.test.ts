import { describe, expect, test } from "bun:test"
import {
  isPromptTextRevisable,
  promptOneShotRevisionAction,
  resolveAutomaticRevisionIntent,
  resolvePromptPrimaryAction,
} from "./send-policy"

describe("Prompt Input V2 send policy", () => {
  test("keeps ordinary send as the default action", () => {
    expect(
      resolvePromptPrimaryAction({
        mode: "normal",
        working: false,
        canSubmit: true,
        hasRevisableText: true,
        autoReviseBeforeSending: false,
        revisionBusy: false,
      }),
    ).toBe("submit")
  })

  test("auto-revises normal prompts before the send decision", () => {
    expect(
      resolvePromptPrimaryAction({
        mode: "normal",
        working: false,
        canSubmit: true,
        hasRevisableText: true,
        autoReviseBeforeSending: true,
        revisionBusy: false,
      }),
    ).toBe("revise")
  })

  test("tiered automation distinguishes review from auto-send", () => {
    expect(
      resolveAutomaticRevisionIntent({ autoReviseBeforeSending: false, autoSendAfterRevision: false }),
    ).toBeUndefined()
    expect(resolveAutomaticRevisionIntent({ autoReviseBeforeSending: true, autoSendAfterRevision: false })).toBe(
      "review",
    )
    expect(resolveAutomaticRevisionIntent({ autoReviseBeforeSending: true, autoSendAfterRevision: true })).toBe("send")
    // Defensive normalization: auto-send cannot independently activate revision.
    expect(
      resolveAutomaticRevisionIntent({ autoReviseBeforeSending: false, autoSendAfterRevision: true }),
    ).toBeUndefined()
  })

  test("an unchanged reviewed revision is ready for the next Send instead of revising forever", () => {
    expect(
      resolvePromptPrimaryAction({
        mode: "normal",
        working: false,
        canSubmit: true,
        hasRevisableText: true,
        autoReviseBeforeSending: true,
        revisionBusy: false,
        revisionReadyForSend: true,
      }),
    ).toBe("submit")
  })

  test("never applies prompt revision policy to shell commands", () => {
    expect(
      resolvePromptPrimaryAction({
        mode: "shell",
        working: false,
        canSubmit: true,
        hasRevisableText: true,
        autoReviseBeforeSending: true,
        revisionBusy: false,
      }),
    ).toBe("submit")
  })

  test("blank working composers keep stop as the primary action", () => {
    expect(
      resolvePromptPrimaryAction({
        mode: "normal",
        working: true,
        canSubmit: false,
        hasRevisableText: false,
        autoReviseBeforeSending: true,
        revisionBusy: false,
      }),
    ).toBe("stop")
  })

  test("drafts typed during a generation remain sendable while stop moves to the menu", () => {
    expect(
      resolvePromptPrimaryAction({
        mode: "normal",
        working: true,
        canSubmit: true,
        hasRevisableText: true,
        autoReviseBeforeSending: false,
        revisionBusy: false,
      }),
    ).toBe("submit")
  })

  test("blocks duplicate primary submissions while the revisor owns the draft", () => {
    expect(
      resolvePromptPrimaryAction({
        mode: "normal",
        working: true,
        canSubmit: true,
        hasRevisableText: true,
        autoReviseBeforeSending: true,
        revisionBusy: true,
      }),
    ).toBe("blocked")
  })

  test("reopens a pending clarification instead of starting another revision", () => {
    expect(
      resolvePromptPrimaryAction({
        mode: "normal",
        working: false,
        canSubmit: true,
        hasRevisableText: true,
        autoReviseBeforeSending: true,
        revisionBusy: false,
        awaitingClarification: true,
      }),
    ).toBe("clarify")
  })

  test("one-shot menu action inverts around the persistent auto-revise preference", () => {
    expect(promptOneShotRevisionAction(false)).toBe("send-with-revisor")
    expect(promptOneShotRevisionAction(true)).toBe("send-without-revisor")
  })

  test("attachment-only/comment-only drafts bypass the text revisor and still send", () => {
    expect(
      resolvePromptPrimaryAction({
        mode: "normal",
        working: false,
        canSubmit: true,
        hasRevisableText: false,
        autoReviseBeforeSending: true,
        revisionBusy: false,
      }),
    ).toBe("submit")
  })

  test("does not treat slash commands as revisable prompt text", () => {
    expect(isPromptTextRevisable("  /compact now  ")).toBe(false)
    expect(isPromptTextRevisable("/custom arg")).toBe(false)
    expect(isPromptTextRevisable("implement /compact as a command")).toBe(true)
  })
})
