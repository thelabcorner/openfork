import { describe, expect, test } from "bun:test"
import { Agent } from "@opencode-ai/schema/agent"
import {
  AGENT_ID_MAX_LENGTH,
  EDITABLE_NATIVE_AGENT_DEFINITIONS,
  agentConfigPatch,
  agentConfigValue,
  agentExposure,
  agentStudioHref,
  customAgentIDs,
  draftFromAgentConfig,
  draftValidation,
  isEditableNativeAgent,
  isValidAgentID,
  parseAgentModel,
} from "./agent-studio-model"

describe("agent studio model", () => {
  test("custom agents default to both primary and subagent availability", () => {
    expect(draftFromAgentConfig({ id: "review" }).mode).toBe("all")
  })

  test("native availability reflects configured overrides over shipped defaults", () => {
    expect(draftFromAgentConfig({ id: "explore", config: { mode: "primary" }, nativeMode: "subagent" }).mode).toBe(
      "primary",
    )
    expect(draftFromAgentConfig({ id: "explore", nativeMode: "subagent" }).mode).toBe("subagent")
  })

  test("model parsing preserves provider model ids containing slashes", () => {
    expect(parseAgentModel("openrouter/anthropic/claude-sonnet-4")).toEqual({
      providerID: "openrouter",
      modelID: "anthropic/claude-sonnet-4",
    })
  })

  test("patches clear optional values and persist custom availability", () => {
    const draft = draftFromAgentConfig({
      id: "review",
      config: {
        prompt: "Be exact",
        mode: "subagent",
        hidden: true,
        model: "openrouter/anthropic/claude-sonnet-4",
      },
    })
    draft.prompt = ""
    draft.model = undefined
    draft.mode = "all"
    draft.hidden = false

    expect(agentConfigPatch(draft, { native: false })).toMatchObject({
      prompt: undefined,
      model: undefined,
      mode: "all",
      hidden: undefined,
    })
  })

  test("replacement values preserve unmanaged settings while physically clearing managed fields", () => {
    const existing = {
      prompt: "old prompt",
      temperature: 0.7,
      permission: { bash: "deny" } as const,
      options: { reasoning: "high" },
    }
    const draft = draftFromAgentConfig({ id: "review", config: existing })
    draft.prompt = ""
    draft.temperature = ""
    draft.mode = "subagent"

    expect(agentConfigValue(existing, draft, { native: false })).toEqual({
      mode: "subagent",
      permission: { bash: "deny" },
      options: { reasoning: "high" },
    })
  })

  test("native replacement preserves exposure overrides that Studio does not own", () => {
    const existing = {
      prompt: "old prompt",
      mode: "primary" as const,
      hidden: true,
      permission: { bash: "deny" } as const,
    }
    const draft = draftFromAgentConfig({ id: "explore", config: existing, nativeMode: "subagent" })
    draft.prompt = "new prompt"

    expect(agentConfigValue(existing, draft, { native: true })).toEqual({
      prompt: "new prompt",
      mode: "primary",
      hidden: true,
      permission: { bash: "deny" },
    })
  })

  test("filters reserved native and disabled tombstone entries", () => {
    expect(
      customAgentIDs({
        build: { prompt: "override" },
        "prompt-revisor": { model: "openai/gpt-5" },
        review: { mode: "all" },
        retired: { disable: true },
      }),
    ).toEqual(["review"])
  })

  test("validates stable mention-safe ids and numeric fields", () => {
    const draft = draftFromAgentConfig({ id: "review-agent" })
    draft.temperature = "0.2"
    draft.topP = "0.9"
    draft.steps = "12"
    expect(draftValidation(draft)).toEqual({ id: true, temperature: true, topP: true, steps: true })

    draft.id = "Review Agent"
    draft.steps = "1.5"
    expect(draftValidation(draft)).toMatchObject({ id: false, steps: false })
  })

  // The exact Tier-0 endpoint validates the id with the same pattern and a
  // 128-character cap. Studio validation has to match it exactly, or Save can
  // be offered for a value the server will reject with a 400.
  test("agent id validation mirrors the exact config endpoint contract", () => {
    expect(isValidAgentID("reviewer")).toBe(true)
    expect(isValidAgentID("review.agent_1-x")).toBe(true)
    expect(isValidAgentID("Reviewer")).toBe(false)
    expect(isValidAgentID("-reviewer")).toBe(false)
    expect(isValidAgentID("")).toBe(false)
    expect(isValidAgentID("a".repeat(AGENT_ID_MAX_LENGTH))).toBe(true)
    expect(isValidAgentID("a".repeat(AGENT_ID_MAX_LENGTH + 1))).toBe(false)

    const draft = draftFromAgentConfig({ id: "a".repeat(AGENT_ID_MAX_LENGTH + 1) })
    expect(draftValidation(draft).id).toBe(false)
  })
})

describe("agent studio exposure", () => {
  test("mode drives composer, mention, and delegation capability", () => {
    expect(agentExposure({ mode: "primary", hidden: false })).toEqual({
      composer: true,
      mention: false,
      delegation: false,
    })
    expect(agentExposure({ mode: "subagent", hidden: false })).toEqual({
      composer: false,
      mention: true,
      delegation: true,
    })
    expect(agentExposure({ mode: "all", hidden: false })).toEqual({
      composer: true,
      mention: true,
      delegation: true,
    })
  })

  test("hidden is discoverability only and never changes delegation", () => {
    expect(agentExposure({ mode: "subagent", hidden: true })).toEqual({
      composer: false,
      mention: false,
      delegation: true,
    })
    expect(agentExposure({ mode: "all", hidden: true })).toEqual({
      composer: false,
      mention: false,
      delegation: true,
    })
    expect(agentExposure({ mode: "primary", hidden: true }).delegation).toBe(false)
  })

  test("the studio projection is the shared browser-safe contract, not a copy", () => {
    for (const mode of ["primary", "subagent", "all"] as const) {
      expect(agentExposure({ mode, hidden: false })).toEqual(Agent.exposure({ mode, hidden: false }))
    }
  })
})

describe("built-in agent rows come from the shared contract", () => {
  test("only non-hidden built-ins are presented as manageable rows", () => {
    expect(EDITABLE_NATIVE_AGENT_DEFINITIONS.map((item) => item.id).toSorted()).toEqual([
      "build",
      "explore",
      "general",
      "plan",
      "yolo",
    ])
    // Host-owned internal agents stay reserved: they are catalog entries, but
    // they are not ordinary manageable agents or valid Studio deep-link targets.
    expect(EDITABLE_NATIVE_AGENT_DEFINITIONS.some((item) => item.hidden)).toBe(false)
    expect(isEditableNativeAgent("explore")).toBe(true)
    expect(isEditableNativeAgent("compaction")).toBe(false)
    expect(isEditableNativeAgent("prompt-revisor")).toBe(false)
  })

  test("hidden built-ins remain reserved ids so they cannot be recreated as custom agents", () => {
    expect(customAgentIDs({ title: { mode: "primary" }, summary: {}, reviewer: { mode: "all" } })).toEqual([
      "reviewer",
    ])
  })
})

describe("agent studio deep link", () => {
  test("targets the routed page and carries the current selection", () => {
    expect(agentStudioHref("explore")).toBe("/agents?selected=explore")
    expect(agentStudioHref("my-reviewer")).toBe("/agents?selected=my-reviewer")
    expect(agentStudioHref("explore", "C:\\repo with spaces")).toBe(
      "/agents?selected=explore&directory=C%3A%5Crepo+with+spaces",
    )
  })

  test("falls back to the bare page for a missing or unusable selection", () => {
    expect(agentStudioHref()).toBe("/agents")
    expect(agentStudioHref("  ")).toBe("/agents")
    expect(agentStudioHref("../settings")).toBe("/agents")
    expect(agentStudioHref("https://example.com")).toBe("/agents")
    expect(agentStudioHref("a".repeat(AGENT_ID_MAX_LENGTH + 1))).toBe("/agents")
  })
})
