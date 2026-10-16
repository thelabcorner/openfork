import type { ToolCatalogItem } from "@opencode-ai/sdk/v2/client"
import type { AtOption } from "./slash-popover"

// Maps the lightweight server tool catalog (ids + one-line descriptions, no
// schemas) onto @mention popover options. Nothing is hardcoded: custom tools,
// permission filtering, and lazy exposure all flow from the catalog response.
export function toToolOptions(items: readonly ToolCatalogItem[]): AtOption[] {
  return items.map((item) => ({
    type: "tool",
    name: item.id,
    display: item.id,
    description: item.description,
    exposure: item.exposure,
    source: item.source,
  }))
}
