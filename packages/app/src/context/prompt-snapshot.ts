import type { ContentPart, Prompt } from "./prompt-state"

/**
 * Capture an independent prompt topology at admission. Solid's store arrays are
 * reactive proxies: merely assigning the array does not freeze a send while a
 * worktree/session is being created.
 *
 * Preserve opaque image blobs and semantic identities. Clone mutable source
 * metadata so subsequent editor mutations cannot rebind an already captured
 * structured reference.
 */
function snapshotPart(part: ContentPart): ContentPart {
  switch (part.type) {
    case "text":
    case "agent":
    case "skill":
    case "tool":
    case "external-path":
      return { ...part }
    case "image":
      return { ...part, blob: { ...part.blob } }
    case "file":
      return {
        ...part,
        selection: part.selection ? { ...part.selection } : undefined,
        source: part.source ? {
          ...part.source,
          text: { ...part.source.text },
        } : undefined,
      }
    default: {
      // Exhaustiveness must fail at compile time if another part kind appears.
      const unreachable: never = part
      return unreachable
    }
  }
}

export function snapshotPrompt(prompt: readonly ContentPart[]): Prompt {
  return prompt.map(snapshotPart)
}
