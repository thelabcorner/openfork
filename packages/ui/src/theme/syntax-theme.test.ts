import { expect, test } from "bun:test"
import { OpenCodeTheme } from "../context/marked-theme"
import { resolveThemeVariant } from "./resolve"
import oc2Theme from "./themes/oc-2.json"
import oneDarkTheme from "./themes/one-dark.json"
import type { DesktopTheme } from "./types"

const oc2 = oc2Theme as DesktopTheme
const oneDark = oneDarkTheme as DesktopTheme

function relativeLuminance(color: string) {
  const channels = color
    .slice(1)
    .match(/.{2}/g)!
    .map((value) => Number.parseInt(value, 16) / 255)
    .map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4))
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!
}

function contrast(left: string, right: string) {
  const a = relativeLuminance(left)
  const b = relativeLuminance(right)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

test("OC-2 keeps the editor syntax palette isolated from general UI syntax tokens", () => {
  const light = resolveThemeVariant(oc2.light, false)
  const dark = resolveThemeVariant(oc2.dark, true)

  expect(light["syntax-keyword"]).toBe("var(--v2-pink-800)")
  expect(light["syntax-code-foreground"]).toBe("#262626")
  expect(light["syntax-code-keyword"]).toBe("#0033B3")
  expect(light["syntax-code-string"]).toBe("#067D17")
  expect(light["syntax-code-function"]).toBe("#00627A")
  expect(light["syntax-code-number"]).toBe("#1750EB")
  expect(light["syntax-code-comment"]).toBe("#70757C")

  expect(dark["syntax-keyword"]).toBe("var(--v2-pink-400)")
  expect(dark["syntax-code-foreground"]).toBe("#BCBEC4")
  expect(dark["syntax-code-keyword"]).toBe("#CF8E6D")
  expect(dark["syntax-code-string"]).toBe("#6AAB73")
  expect(dark["syntax-code-function"]).toBe("#56A8F5")
  expect(dark["syntax-code-number"]).toBe("#2AACB8")
  expect(dark["syntax-code-comment"]).toBe("#7B7F86")
})

test("OC-2 editor syntax colors retain normal-text contrast in both color schemes", () => {
  const variants = [
    resolveThemeVariant(oc2.light, false),
    resolveThemeVariant(oc2.dark, true),
  ]
  const roles = [
    "comment",
    "regexp",
    "keyword",
    "string",
    "function",
    "operator",
    "variable",
    "property",
    "type",
    "constant",
    "punctuation",
    "number",
    "decorator",
    "builtin",
  ]

  for (const variant of variants) {
    const background = variant["background-stronger"]
    expect(background.startsWith("#")).toBe(true)
    for (const role of roles) {
      const foreground = variant[`syntax-code-${role}`]
      expect(foreground.startsWith("#")).toBe(true)
      expect(contrast(foreground, background)).toBeGreaterThanOrEqual(4.5)
    }
  }
})

test("themes without an editor-specific palette inherit their existing syntax colors", () => {
  const light = resolveThemeVariant(oneDark.light, false)
  const dark = resolveThemeVariant(oneDark.dark, true)

  expect(light["syntax-code-keyword"]).toBe(light["syntax-keyword"])
  expect(light["syntax-code-foreground"]).toBe(light["text-base"])
  expect(light["syntax-code-function"]).toBe(light["syntax-function"])
  expect(light["syntax-code-property"]).toBe(light["syntax-property"])

  expect(dark["syntax-code-keyword"]).toBe(dark["syntax-keyword"])
  expect(dark["syntax-code-foreground"]).toBe(dark["text-base"])
  expect(dark["syntax-code-function"]).toBe(dark["syntax-function"])
  expect(dark["syntax-code-property"]).toBe(dark["syntax-property"])
})

test("the shared OpenCode Shiki theme routes semantic code roles through editor tokens", () => {
  const theme = JSON.stringify(OpenCodeTheme)

  expect(theme).toContain("--syntax-code-keyword")
  expect(theme).toContain("--syntax-code-function")
  expect(theme).toContain("--syntax-code-parameter")
  expect(theme).toContain("--syntax-code-number")
  expect(theme).not.toContain("--syntax-unknown")
})
