import type { ProjectAvatarStyle } from "@opencode-ai/ui/v2/project-avatar-v2"

export type MenuItemVariant = "default" | "danger"

export type MenuItemAvatar = {
  fallback: string
  src?: string
  variant?: ProjectAvatarStyle
}

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
      search?: { placeholder: string }
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
      avatar?: MenuItemAvatar
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
