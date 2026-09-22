import { describe, expect, test } from "bun:test"
import {
  filterSettingsModelGroups,
  flattenSettingsModelGroups,
  groupSettingsModels,
  type SettingsModelItem,
} from "./models-view"

const item = (providerID: string, providerName: string, id: string, name: string): SettingsModelItem => ({
  key: `${providerID}:${id}`,
  id,
  name,
  displayName: name,
  releaseDate: "2026-09-01",
  provider: { id: providerID, name: providerName },
  searchText: `${providerName} ${name} ${id}`.toLocaleLowerCase(),
})

describe("settings models view projection", () => {
  test("orders popular providers first and sorts model rows once per group", () => {
    const groups = groupSettingsModels(
      [
        item("zeta", "Zeta", "z-2", "Z Model"),
        item("openai", "OpenAI", "o-2", "Zulu"),
        item("anthropic", "Anthropic", "a-1", "Claude"),
        item("openai", "OpenAI", "o-1", "Alpha"),
        item("alpha", "Alpha", "x-1", "X Model"),
      ],
      ["openai", "anthropic"],
    )

    expect(groups.map((group) => group.category)).toEqual(["openai", "anthropic", "alpha", "zeta"])
    expect(groups[0]?.items.map((model) => model.name)).toEqual(["Alpha", "Zulu"])
  })

  test("search matches provider, model name, id, and multiple tokens", () => {
    const groups = groupSettingsModels(
      [
        item("openrouter", "OpenRouter", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
        item("openai", "OpenAI", "gpt-5.6", "GPT 5.6"),
      ],
      [],
    )

    expect(filterSettingsModelGroups(groups, "deep v4").flatMap((group) => group.items.map((model) => model.id))).toEqual([
      "deepseek-v4.1-flash",
    ])
    expect(filterSettingsModelGroups(groups, "openai 5.6").flatMap((group) => group.items.map((model) => model.id))).toEqual([
      "gpt-5.6",
    ])
  })

  test("falls back to fuzzy matching only when exact token matching is empty", () => {
    const groups = groupSettingsModels(
      [
        item("openrouter", "OpenRouter", "deepseek-v4.1-flash", "DeepSeek V4.1 Flash"),
        item("openai", "OpenAI", "gpt-5.6", "GPT 5.6"),
      ],
      [],
    )

    expect(filterSettingsModelGroups(groups, "deepsek").flatMap((group) => group.items.map((model) => model.id))).toEqual([
      "deepseek-v4.1-flash",
    ])
  })

  test("collapse removes model rows while preserving the provider row", () => {
    const groups = groupSettingsModels(
      [item("openai", "OpenAI", "a", "A"), item("openai", "OpenAI", "b", "B")],
      [],
    )

    const rows = flattenSettingsModelGroups(groups, { openai: true }, false)
    expect(rows.map((row) => row.kind)).toEqual(["group"])
    expect(rows[0]).toMatchObject({ kind: "group", category: "openai", expanded: false })
  })

  test("active search expands matching groups without mutating persisted collapse state", () => {
    const groups = groupSettingsModels(
      [item("openai", "OpenAI", "a", "A"), item("openai", "OpenAI", "b", "B")],
      [],
    )
    const collapsed = { openai: true }

    const rows = flattenSettingsModelGroups(groups, collapsed, true)
    expect(rows.map((row) => row.kind)).toEqual(["group", "model", "model"])
    expect(rows[0]).toMatchObject({ kind: "group", expanded: true, searching: true })
    expect(collapsed).toEqual({ openai: true })
  })
})
