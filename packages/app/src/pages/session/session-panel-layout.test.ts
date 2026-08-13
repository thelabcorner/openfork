import { describe, expect, test } from "bun:test"
import { sessionPanelLayout } from "./session-panel-layout"

const layout = (input: Partial<Parameters<typeof sessionPanelLayout>[0]>) =>
  sessionPanelLayout({ review: false, terminal: false, files: false, browser: false, ...input })

describe("sessionPanelLayout", () => {
  test("keeps one V2 owner while changing panel geometry", () => {
    expect(layout({})).toEqual({
      visible: false,
      stacked: false,
    })
    expect(layout({ terminal: true })).toEqual({
      visible: true,
      stacked: false,
    })
    expect(layout({ review: true, terminal: true })).toEqual({
      visible: true,
      stacked: true,
    })
  })

  test("browser alone makes the row visible without stacking", () => {
    expect(layout({ browser: true })).toEqual({
      visible: true,
      stacked: false,
    })
    expect(layout({ browser: true, terminal: true })).toEqual({
      visible: true,
      stacked: false,
    })
  })
})
