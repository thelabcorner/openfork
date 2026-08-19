import { describe, expect, test } from "bun:test"
import { sessionPanelLayout } from "./session-panel-layout"

const layout = (input: Partial<Parameters<typeof sessionPanelLayout>[0]>) =>
  sessionPanelLayout({ terminal: false, files: false, context: false, ...input })

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
  })

  test("context makes the row visible without stacking", () => {
    expect(layout({ context: true })).toEqual({
      visible: true,
      stacked: false,
    })
    expect(layout({ context: true, terminal: true })).toEqual({
      visible: true,
      stacked: false,
    })
  })
})
