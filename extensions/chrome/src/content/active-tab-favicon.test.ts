import { describe, expect, test } from "bun:test"
import { ACTIVE_TAB_ICON_ATTRIBUTE, setActiveTabFavicon } from "./active-tab-favicon"

function fakeDocument() {
  const nodes: any[] = []
  const root = {
    appendChild(node: any) {
      if (!nodes.includes(node)) nodes.push(node)
      node.isConnected = true
      return node
    },
  }
  const document = {
    head: root,
    documentElement: root,
    createElement() {
      const attributes = new Set<string>()
      const node: any = {
        rel: "",
        type: "",
        href: "",
        isConnected: false,
        setAttribute(name: string) { attributes.add(name) },
        hasAttribute(name: string) { return attributes.has(name) },
        remove() {
          const index = nodes.indexOf(node)
          if (index >= 0) nodes.splice(index, 1)
          node.isConnected = false
        },
      }
      return node
    },
    querySelector(selector: string) {
      if (selector === `link[${ACTIVE_TAB_ICON_ATTRIBUTE}]`) return nodes.find((node) => node.hasAttribute?.(ACTIVE_TAB_ICON_ATTRIBUTE)) ?? null
      return null
    },
    querySelectorAll(selector: string) {
      if (selector === `link[${ACTIVE_TAB_ICON_ATTRIBUTE}]`) return nodes.filter((node) => node.hasAttribute?.(ACTIVE_TAB_ICON_ATTRIBUTE))
      return []
    },
  }
  return document as unknown as Document
}

describe("setActiveTabFavicon", () => {
  test("adds one opencode icon without overwriting the page favicon and restores on clear", () => {
    const document = fakeDocument()
    const original = document.createElement("link")
    original.rel = "icon"
    original.href = "https://example.com/favicon.ico"
    document.head.appendChild(original)

    const opencodeUrl = "chrome-extension://example/assets/icon48.png"
    setActiveTabFavicon(document, true, opencodeUrl)
    setActiveTabFavicon(document, true, opencodeUrl)

    const marker = document.querySelector<HTMLLinkElement>(`link[${ACTIVE_TAB_ICON_ATTRIBUTE}]`)
    expect(marker?.href).toBe(opencodeUrl)
    expect(document.querySelectorAll(`link[${ACTIVE_TAB_ICON_ATTRIBUTE}]`)).toHaveLength(1)
    expect(original.href).toBe("https://example.com/favicon.ico")

    setActiveTabFavicon(document, false)
    expect(document.querySelector(`link[${ACTIVE_TAB_ICON_ATTRIBUTE}]`)).toBeNull()
    expect(original.isConnected).toBe(true)
  })

  test("reuses an early marker instead of duplicating it when head becomes available", () => {
    const document = fakeDocument()
    const opencodeUrl = "chrome-extension://example/assets/icon48.png"
    setActiveTabFavicon(document, true, opencodeUrl)
    setActiveTabFavicon(document, true, opencodeUrl)
    expect(document.querySelectorAll(`link[${ACTIVE_TAB_ICON_ATTRIBUTE}]`)).toHaveLength(1)
  })
})
