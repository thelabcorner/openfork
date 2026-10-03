import type { Block } from "./markdown-stream"
import { hasTextPrefix } from "./text-prefix"

export function canReusePendingBlock(current: Pick<Block, "mode" | "raw"> | undefined, next: Block) {
  if (!current || current.mode !== next.mode) return false
  if (next.mode === "code" || next.mode === "live") return hasTextPrefix(next.raw, current.raw)
  return current.raw === next.raw
}
