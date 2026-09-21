import { describe, expect, test } from "bun:test"
import {
  anthropicSystemMessageCapability,
  intersectSystemMessageCapability,
  type ProviderSystemMessageCapability,
  type SystemMessageEncoderCapability,
} from "../src"

describe("system message capability", () => {
  const encoder = (chronological: boolean, turnScoped = false): SystemMessageEncoderCapability => ({
    chronological,
    turnScoped,
  })

  test("fails closed when provider or encoder cannot preserve chronological privilege", () => {
    const none: ProviderSystemMessageCapability = { history: "none", turnScoped: false }
    const cumulative: ProviderSystemMessageCapability = { history: "cumulative-privileged", turnScoped: true }

    expect(intersectSystemMessageCapability(none, encoder(true, true))).toEqual({
      history: "head-only",
      turnScoped: false,
    })
    expect(intersectSystemMessageCapability(cumulative, encoder(false, true))).toEqual({
      history: "head-only",
      turnScoped: false,
    })
  })

  test("never exposes turn-scoped System without authority-preserving chronological placement", () => {
    expect(
      intersectSystemMessageCapability(
        { history: "cumulative-privileged", turnScoped: true },
        { chronological: false, turnScoped: true },
      ),
    ).toEqual({ history: "head-only", turnScoped: false })
  })

  test("preserves provider semantics instead of collapsing cumulative and replace-complete", () => {
    expect(
      intersectSystemMessageCapability(
        { history: "cumulative-privileged", turnScoped: true },
        encoder(true, false),
      ),
    ).toEqual({ history: "cumulative-privileged", turnScoped: false })

    expect(
      intersectSystemMessageCapability(
        { history: "replace-complete", turnScoped: false },
        encoder(true, true),
      ),
    ).toEqual({ history: "replace-complete", turnScoped: false })
  })
})

describe("Anthropic provider system-message semantics", () => {
  test.each([
    "claude-opus-4-8",
    "claude-opus-4.8",
    "claude-opus-4-8-20260901",
    "claude-opus-5",
    "claude-opus-5-20260724",
    "claude-fable-5",
    "claude-fable-5-1",
    "claude-fable-5.1",
    "claude-mythos-5",
    "claude-mythos-5-1",
    "anthropic/claude-opus-5",
    "global.anthropic.claude-fable-5-1",
    "us.anthropic.claude-opus-5-v1:0",
    "claude-opus-5@default",
  ])("classifies documented supported family %s as cumulative privileged", (modelID) => {
    expect(anthropicSystemMessageCapability(modelID)).toEqual({
      history: "cumulative-privileged",
      turnScoped: true,
    })
  })

  test.each([
    "claude-sonnet-5",
    "anthropic/claude-sonnet-5",
    "claude-sonnet-5@default",
    "claude-opus-4-7",
    "claude-opus-4-8-fast",
    "claude-opus-5-1",
    "claude-fable-latest",
    "claude-mythos-5-2",
    "unknown",
  ])("fails closed for undocumented/unsupported family %s", (modelID) => {
    expect(anthropicSystemMessageCapability(modelID)).toEqual({ history: "none", turnScoped: false })
  })
})
