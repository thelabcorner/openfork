// Ported from packages/session-ui/src/components/markdown-cache.tsx's
// sanitizeMarkdown — same DOMPurify profile (KaTeX emits MathML + inline SVG
// for things like \sqrt, which the default HTML-only profile would strip).
import DOMPurify from "dompurify"

const config = {
  USE_PROFILES: { html: true, mathMl: true },
  SANITIZE_NAMED_PROPS: true,
  FORBID_TAGS: ["style"],
  FORBID_CONTENTS: ["style", "script"],
  ADD_TAGS: ["svg", "path"],
  ADD_ATTR: ["d", "viewBox", "preserveAspectRatio", "xmlns", "target"],
}

if (typeof window !== "undefined" && DOMPurify.isSupported) {
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (!(node instanceof HTMLAnchorElement)) return
    if (node.target !== "_blank") return
    const rel = node.getAttribute("rel") ?? ""
    const set = new Set(rel.split(/\s+/).filter(Boolean))
    set.add("noopener")
    set.add("noreferrer")
    node.setAttribute("rel", Array.from(set).join(" "))
  })
}

export function sanitizeMarkdown(html: string): string {
  if (!DOMPurify.isSupported) return ""
  return DOMPurify.sanitize(html, config) as unknown as string
}
