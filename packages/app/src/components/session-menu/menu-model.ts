export type MenuItemVariant = "default" | "danger"

export type MenuItemDef =
  | {
      kind: "item"
      id: string
      label: string
      disabled?: boolean
      variant?: MenuItemVariant
      icon?: string
      onSelect: () => void
    }
  | {
      kind: "submenu"
      id: string
      label: string
      disabled?: boolean
      icon?: string
      items: MenuItemDef[]
    }
  | {
      kind: "checkbox"
      id: string
      label: string
      checked: boolean
      disabled?: boolean
      icon?: string
      onSelect: () => void
    }
  | {
      kind: "radio"
      id: string
      label: string
      checked: boolean
      disabled?: boolean
      icon?: string
      onSelect: () => void
    }

export type MenuSectionDef = {
  id: string
  items: MenuItemDef[]
  hidden?: boolean
}

export function filterVisibleSections(sections: MenuSectionDef[]): MenuSectionDef[] {
  return sections.filter((section) => !section.hidden && section.items.length > 0)
}
