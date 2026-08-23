import type { JSX } from "solid-js"

export type MenuItemVariant = "default" | "danger"

export type MenuItemDef =
  | {
      kind: "item"
      id: string
      label: string
      disabled?: boolean
      variant?: MenuItemVariant
      onSelect: () => void
    }
  | {
      kind: "submenu"
      id: string
      label: string
      disabled?: boolean
      items: MenuItemDef[]
    }

export type MenuSectionDef = {
  id: string
  items: MenuItemDef[]
  hidden?: boolean
}

export function filterVisibleSections(sections: MenuSectionDef[]): MenuSectionDef[] {
  return sections.filter((section) => !section.hidden && section.items.length > 0)
}
