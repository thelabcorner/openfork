import { hasTextPrefix } from "./text-prefix"

/** Only the sanitized Markdown render for the current worker projection can be
 * published. While newer work is pending, callers keep their previous rich
 * render instead of exposing raw source as a fallback. */
export function isMarkdownPresentationReady(
  rendered:
    | {
        text: string
        complete?: boolean
        presentable?: boolean
        progressive?: boolean
        blocks?: Array<{ mode?: string; plainText?: string; plainCode?: boolean; html?: string }>
      }
    | undefined,
  projected: { text: string } | undefined,
) {
  if (!rendered || !projected || rendered.presentable === false || !rendered.text && !!projected.text) return false
  // Only the owning renderer may publish a sanitized append-only batch while
  // later blocks are pending. An interrupted/unproven partial result is not
  // presentable, and an empty batch must not clear an existing rich tree.
  if (rendered.complete === false && !(rendered.progressive === true && rendered.presentable === true && !!rendered.blocks?.length)) return false
  // A completed rich prefix remains useful while the parser works on a newer
  // append. Demanding an exact match here can starve visible streaming under
  // sustained deltas. A replacement/truncation must never publish stale text.
  if (!hasTextPrefix(projected.text, rendered.text)) return false
  // The owning renderer proves its presentation contract once. Do not walk
  // every historical block again for each visible streaming update.
  if (rendered.presentable === true) return true
  // Plain source is not an acceptable intermediate presentation: it can be
  // visibly replaced by parsed Markdown on the next worker response. Code
  // fallback is still a deliberate code block with its own presentation.
  return rendered.blocks?.every((block) => block.plainText === undefined || block.plainCode === true) ?? true
}
