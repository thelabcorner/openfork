import type { AtOption } from "./slash-popover"

export type AtGroup = { category: string; items: AtOption[] }

export type AtRow = { kind: "header"; category: string } | { kind: "item"; option: AtOption }

export const groupTitleKey = (category: string) => {
  switch (category) {
    case "agent":
      return "prompt.popover.group.agents"
    case "reference":
    case "resource":
      return "prompt.popover.group.context"
    case "recent":
      return "prompt.popover.group.recent"
    case "file":
      return "prompt.popover.group.files"
    case "symbol":
      return "prompt.popover.group.symbols"
    case "external":
      return "prompt.popover.group.external"
    default:
      return category
  }
}

export function splitHighlightSegments(
  text: string,
  positions: number[] | undefined,
): { text: string; hit: boolean }[] | undefined {
  if (!positions?.length) return undefined
  const set = new Set(positions)
  const parts: { text: string; hit: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const last = parts[parts.length - 1]
    const hit = set.has(i)
    if (last && last.hit === hit) {
      last.text += text[i]
      continue
    }
    parts.push({ text: text[i], hit })
  }
  return parts
}

export function buildAtRows(groups: AtGroup[]): AtRow[] {
  const out: AtRow[] = []
  let lastTitle: string | undefined
  for (const group of groups) {
    if (group.items.length === 0) continue
    const title = groupTitleKey(group.category)
    if (title !== lastTitle) {
      out.push({ kind: "header", category: group.category })
      lastTitle = title
    }
    for (const option of group.items) out.push({ kind: "item", option })
  }
  return out
}
