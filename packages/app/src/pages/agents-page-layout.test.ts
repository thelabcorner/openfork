import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"

describe("Agent Studio page shell", () => {
  test("uses the canonical raised-pane gutter and flex-height contract", () => {
    const page = readFileSync(new URL("./agents-page.tsx", import.meta.url), "utf8")

    expect(page).toContain('data-component="agents-page"')
    expect(page).toContain(
      'class="m-2 flex min-h-0 min-w-0 flex-1 self-stretch overflow-hidden rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)] contain-strict"',
    )

    // Recurring failure mode: a smaller bespoke outer margin makes the page
    // visibly too tall relative to the other raised panes.
    expect(page).not.toMatch(/data-component="agents-page"[\s\S]{0,160}class="[^"]*\bm-1\b/)

    // The outer page participates in the app-shell flex contract. It must not
    // independently claim the parent's full width/height.
    expect(page).not.toMatch(/data-component="agents-page"[\s\S]{0,160}class="[^"]*\bh-full\b/)
    expect(page).not.toMatch(/data-component="agents-page"[\s\S]{0,160}class="[^"]*\bw-full\b/)
  })
})