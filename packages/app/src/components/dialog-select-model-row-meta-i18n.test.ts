import { describe, expect, test } from "bun:test"
import { resolveTemplate } from "@solid-primitives/i18n"
import { dict } from "@/i18n/en"

/**
 * NEGATIVE INVARIANT for `ModelRowMeta`'s WorkBuddy row meta.
 *
 * The row once inlined its three WorkBuddy strings — `"Free now"`,
 * `credits/request`, and `"Free"` — so the provider-account tooltip and the
 * row label stayed English in every locale while the rest of the selector was
 * translated. Nothing about the rendering would have failed: the copy simply
 * never reached the dictionary. A behavioral/render test cannot catch that, so
 * this asserts on the source of the component itself.
 */

const componentSource = () => Bun.file(new URL("./dialog-select-model.tsx", import.meta.url)).text()

function rowMetaSource(text: string) {
  const start = text.indexOf("function ModelRowMeta(")
  expect(start).toBeGreaterThan(-1)
  const end = text.indexOf("const uptimeTone", start)
  expect(end).toBeGreaterThan(start)
  return text.slice(start, end)
}

describe("ModelRowMeta WorkBuddy copy localization", () => {
  test("resolves every WorkBuddy row-meta string through an i18n key", async () => {
    const body = rowMetaSource(await componentSource())

    expect(body).toContain('language.t("model.tooltip.workbuddy.free")')
    expect(body).toContain('language.t("model.tooltip.workbuddy.rateValue"')
    expect(body).toContain('language.t("model.tag.free")')
  })

  test("cannot regress to hardcoded English row-meta literals", async () => {
    const body = rowMetaSource(await componentSource())

    // The English copy itself lives in the dictionary, so its presence inside
    // the component is by definition unlocalizable.
    for (const literal of ['"Free now"', '"Free"', "credits/request"]) {
      expect(body).not.toContain(literal)
    }
  })

  test("keeps the reused English strings byte-for-byte", () => {
    expect(dict["model.tooltip.workbuddy.free"]).toBe("Free now")
    expect(dict["model.tag.free"]).toBe("Free")
    expect(dict["model.tooltip.workbuddy.rateValue"]).toBe("{{rate}} credits/request")
  })

  test("rate title renders exactly the English it rendered before localization", () => {
    const rendered = resolveTemplate(dict["model.tooltip.workbuddy.rateValue"], { rate: "x0.5" })

    expect(rendered).toBe("x0.5 credits/request")
  })
})