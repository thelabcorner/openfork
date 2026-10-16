import { describe, expect, test } from "bun:test"
import { createRoot, createSignal, mapArray } from "solid-js"
import type { MenuSectionDef } from "../src/components/session-menu/menu-model"
import { createReconciledMenuSections } from "../src/components/session-menu/menu-reconciliation"

function section(id: string, labels: string[], onSelect: () => void = () => {}): MenuSectionDef {
  return {
    id,
    items: labels.map((label, index) => ({ id: `${id}:${index}`, kind: "item" as const, label, onSelect })),
  }
}

function mount(initial: MenuSectionDef[]) {
  return createRoot((dispose) => {
    const [model, setModel] = createSignal(initial)
    const view = createReconciledMenuSections(model)
    return { view, setModel, dispose }
  })
}

describe("keyed session/context menu model reconciliation", () => {
  test("preserves section and item owners while updating state and the latest action", () => {
    const original = () => { oldCalls++ }
    let oldCalls = 0
    let newCalls = 0
    const { view, setModel, dispose } = mount([section("state", ["Stop", "Pause"], original)])
    try {
      const originalSection = view[0]
      const originalItem = view[0].items[0]
      setModel([{ id: "state", items: [
        { kind: "item", id: "state:0", label: "Stop", disabled: true, onSelect: () => newCalls++ },
        { kind: "item", id: "state:1", label: "Pause", disabled: false, onSelect: () => newCalls++ },
      ] }])
      expect(view[0]).toBe(originalSection)
      expect(view[0].items[0]).toBe(originalItem)
      expect(view[0].items[0]).toMatchObject({ disabled: true, label: "Stop" })
      if (view[0].items[0].kind === "item") view[0].items[0].onSelect()
      expect(oldCalls).toBe(0)
      expect(newCalls).toBe(1)
    } finally { dispose() }
  })

  test("reorders by stable ids, removes stale fields, and adds new sections", () => {
    const { view, setModel, dispose } = mount([
      { id: "session", items: [{ kind: "item", id: "rename", label: "Rename", description: "old", onSelect: () => {} }] },
      section("group", ["Add", "Remove"]),
    ])
    try {
      const session = view[0]
      const rename = view[0].items[0]
      const group = view[1]
      const remove = view[1].items[1]
      setModel([
        { id: "group", items: [
          { kind: "item", id: "group:1", label: "Remove", onSelect: () => {} },
          { kind: "item", id: "group:0", label: "Add", onSelect: () => {} },
        ] },
        { id: "session", items: [{ kind: "item", id: "rename", label: "Rename", onSelect: () => {} }] },
        section("new", ["Inspect"]),
      ])
      expect(view.map((entry) => entry.id)).toEqual(["group", "session", "new"])
      expect(view[0]).toBe(group)
      expect(view[0].items[0]).toBe(remove)
      expect(view[1]).toBe(session)
      expect(view[1].items[0]).toBe(rename)
      expect("description" in view[1].items[0]).toBe(false)
      setModel([section("new", ["Inspect"])])
      expect(view).toHaveLength(1)
      expect(view[0].id).toBe("new")
    } finally { dispose() }
  })

  test("nested submenu selections update without remounting their owner", () => {
    const { view, setModel, dispose } = mount([{
      id: "model",
      items: [{ kind: "submenu", id: "variant", label: "Reasoning effort", items: [
        { kind: "radio", id: "variant:low", label: "Low", checked: true, onSelect: () => {} },
        { kind: "radio", id: "variant:high", label: "High", checked: false, onSelect: () => {} },
      ] }],
    }])
    try {
      const submenu = view[0].items[0]
      if (submenu.kind !== "submenu") throw new Error("expected submenu")
      const high = submenu.items[1]
      setModel([{
        id: "model",
        items: [{ kind: "submenu", id: "variant", label: "Reasoning effort", items: [
          { kind: "radio", id: "variant:low", label: "Low", checked: false, onSelect: () => {} },
          { kind: "radio", id: "variant:high", label: "High", checked: true, onSelect: () => {} },
        ] }],
      }])
      expect(view[0].items[0]).toBe(submenu)
      expect(submenu.items[1]).toBe(high)
      expect(submenu.items[1]).toMatchObject({ checked: true })
    } finally { dispose() }
  })

  test("Solid keyed row mapping keeps mounted instances through frequent refreshes", () => {
    let mounted = 0
    const [model, setModel] = createSignal<MenuSectionDef[]>([section("state", ["Stop", "Pause", "Resume"])])
    const fixture = createRoot((dispose) => {
      const view = createReconciledMenuSections(model)
      const rows = mapArray(() => view[0].items, (item) => {
        mounted++
        return () => item.label
      })
      return { view, rows, dispose }
    })
    try {
      expect(fixture.rows().map((getLabel) => getLabel())).toEqual(["Stop", "Pause", "Resume"])
      for (let i = 0; i < 100; i++) {
        setModel([section("state", [`Stop ${i}`, "Pause", "Resume"])])
        expect(fixture.rows()[0]()).toBe(`Stop ${i}`)
      }
      expect(mounted).toBe(3)
    } finally { fixture.dispose() }
  })
})
