import { describe, expect, test } from "bun:test"
import { createSessionNavigation } from "./data"

function click(overrides: Partial<MouseEvent> = {}) {
  let prevented = false
  return {
    event: {
      button: 0,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      preventDefault() {
        prevented = true
      },
      ...overrides,
    } as MouseEvent,
    prevented: () => prevented,
  }
}

describe("createSessionNavigation", () => {
  test("uses in-app navigation for an ordinary primary click", () => {
    const opened: string[] = []
    const nav = createSessionNavigation({
      sessionID: () => "ses_child",
      href: () => "/project/session/ses_child",
      navigateToSession: (id) => opened.push(id),
    })
    const input = click()

    nav.navigate(input.event)

    expect(input.prevented()).toBe(true)
    expect(opened).toEqual(["ses_child"])
  })

  test("preserves modifier-click anchor behavior", () => {
    const opened: string[] = []
    const nav = createSessionNavigation({
      sessionID: () => "ses_child",
      href: () => "/project/session/ses_child",
      navigateToSession: (id) => opened.push(id),
    })
    const input = click({ metaKey: true })

    nav.navigate(input.event)

    expect(input.prevented()).toBe(false)
    expect(opened).toEqual([])
  })

  test("is not clickable without a materialized Session target", () => {
    const nav = createSessionNavigation({
      sessionID: () => undefined,
      href: () => undefined,
    })

    expect(nav.clickable()).toBe(false)
    expect(nav.href()).toBeUndefined()
  })
})
