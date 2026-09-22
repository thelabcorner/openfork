import { describe, expect, test } from "bun:test"

const source = await Bun.file(new URL("./tab-bar.css", import.meta.url)).text()

describe("PWA tab bar presentation contract", () => {
  test("stays blur-free in steady state", () => {
    expect(source).not.toContain("backdrop-filter")
    expect(source).not.toContain("backdrop-blur")
  })

  test("gates hover affordances to precise pointers", () => {
    const hoverIndex = source.indexOf(":hover")
    expect(hoverIndex).toBeGreaterThan(-1)
    expect(source.slice(0, hoverIndex)).toContain("@media (hover: hover) and (pointer: fine)")
  })

  test("keeps touch targets and safe-area ownership in the bar", () => {
    expect(source).toContain("min-height: 45px")
    expect(source).toContain("min-width: 44px")
    expect(source).toContain("env(safe-area-inset-bottom")
  })

  test("honors reduced motion", () => {
    expect(source).toContain("@media (prefers-reduced-motion: reduce)")
  })
})
