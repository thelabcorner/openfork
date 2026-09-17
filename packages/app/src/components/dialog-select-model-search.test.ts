import { describe, expect, test } from "bun:test"
import {
  createModelSearchMatcher,
  filterPreparedModelGroupsForSearch,
  matchesModelSearch,
  prepareModelGroupSearchFields,
  selectModelSections,
} from "./dialog-select-model-search"

describe("matchesModelSearch", () => {
  test("does not match when prepared fields are temporarily unavailable", () => {
    expect(createModelSearchMatcher("claude")(undefined)).toBe(false)
  })
  test("matches model names across separators", () => {
    expect(matchesModelSearch("gpt 5", ["GPT-5.5"])).toBe(true)
    expect(matchesModelSearch("gpt-5", ["GPT-5.5"])).toBe(true)
    expect(matchesModelSearch("gpt5", ["GPT-5.5"])).toBe(true)
  })

  test("matches any searchable model field", () => {
    expect(matchesModelSearch("open ai", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(true)
    expect(matchesModelSearch("gpt 5", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(true)
  })

  test("matches tokens in any order across model fields", () => {
    expect(matchesModelSearch("sonnet anthropic", ["Claude 3.7 Sonnet", "anthropic"])).toBe(true)
    expect(matchesModelSearch("vertex gemini", ["Gemini 2.5 Pro", "Google Vertex"])).toBe(true)
  })

  test("matches compact identifiers and punctuation independently", () => {
    expect(matchesModelSearch("claude 37", ["Claude-3.7-Sonnet"])).toBe(true)
    expect(matchesModelSearch("open ai o3", ["o3-mini", "OpenAI"])).toBe(true)
  })

  test("ignores accents and repeated whitespace", () => {
    expect(matchesModelSearch("  mistral   large ", ["Místral-Large-2"])).toBe(true)
  })

  test("does not match unrelated searches", () => {
    expect(matchesModelSearch("claude", ["GPT-5.5", "gpt-5.5", "OpenAI"])).toBe(false)
  })

  test("does not create compact matches across separate field boundaries", () => {
    expect(matchesModelSearch("aib", ["AI", "B"])).toBe(false)
  })
})

describe("filterPreparedModelGroupsForSearch", () => {
  const canonical = { id: "claude-3.7-sonnet", name: "Claude-3.7 Sonnet", provider: { name: "Anthropic" } }
  const dana = {
    id: "claude-3.7-sonnet@wb-dana",
    name: "Claude-3.7 Sonnet",
    provider: { name: "Anthropic" },
  }
  const lee = {
    id: "claude-3.7-sonnet@wb-lee",
    name: "Claude-3.7 Sonnet",
    provider: { name: "Anthropic" },
  }
  const groups = [
    {
      label: "Claude-3.7 Sonnet",
      canonical,
      variants: [
        { accountID: "dana", item: dana },
        { accountID: "lee", item: lee },
      ],
    },
  ]
  const fields = prepareModelGroupSearchFields(groups)

  test("keeps provider and normalized punctuation matches canonical", () => {
    expect(filterPreparedModelGroupsForSearch(groups, "anthropic", fields)).toEqual([canonical])
    expect(filterPreparedModelGroupsForSearch(groups, "claude 37", fields)).toEqual([canonical])
  })

  test("expands only the matching account variant", () => {
    expect(filterPreparedModelGroupsForSearch(groups, "dana", fields)).toEqual([dana])
    expect(filterPreparedModelGroupsForSearch(groups, "wb lee", fields)).toEqual([lee])
  })

  test("canonical model matches stay collapsed even though variants share the model name", () => {
    expect(filterPreparedModelGroupsForSearch(groups, "sonnet", fields)).toEqual([canonical])
  })
})

describe("selectModelSections", () => {
  const key = (item: { provider: { name: string }; id: string }) => `${item.provider.name}:${item.id}`
  const base = {
    keyOf: key,
    groupKeyOf: (item: { provider: { name: string }; id: string }) => item.id.replace(/@.*$/, ""),
    recentGroupKeys: [] as string[],
    isFavorite: () => false,
  }
  const sonnet = { provider: { name: "Anthropic" }, id: "claude-sonnet" }
  const dana = { provider: { name: "Anthropic" }, id: "claude-sonnet@wb-dana" }
  const gpt = { provider: { name: "OpenAI" }, id: "gpt-5" }

  test("only projects rows present in the filtered list", () => {
    const result = selectModelSections([gpt], { ...base, isFavorite: (item) => item.id === "claude-sonnet" })
    expect(result.favorites).toEqual([])
  })

  test("a search-expanded account variant is what the section renders", () => {
    const result = selectModelSections([dana], { ...base, isFavorite: () => true })
    expect(result.favorites).toEqual([dana])
  })

  test("renders one row per model group even when variants collapse together", () => {
    const result = selectModelSections([sonnet, dana], { ...base, isFavorite: () => true })
    expect(result.favorites).toEqual([sonnet])
  })

  test("a favorite never repeats under Recent", () => {
    const result = selectModelSections([sonnet, gpt], {
      ...base,
      recentGroupKeys: ["claude-sonnet", "gpt-5"],
      isFavorite: (item) => item.id === "claude-sonnet",
    })
    expect(result.favorites).toEqual([sonnet])
    expect(result.recents).toEqual([gpt])
  })

  test("recent order follows recentGroupKeys, not list order", () => {
    const result = selectModelSections([sonnet, gpt], { ...base, recentGroupKeys: ["gpt-5", "claude-sonnet"] })
    expect(result.recents).toEqual([gpt, sonnet])
  })
})
