import { For, createEffect, createSignal, onCleanup } from "solid-js"
import { highlightCode } from "../markdown/highlight"
import { parseMarkdown, project, sanitizeMarkdown, type Block, type Projection } from "../markdown"

type Rendered = { key: string; html: string }

// Per-block HTML cache, keyed by "<mode>:<raw>" — a completed block's raw
// text never changes again once it's no longer the streaming tail, so this
// turns "re-render the whole message on every delta" into "re-render only
// the one block that's still growing."
const htmlCache = new Map<string, string>()
const MAX_CACHE = 400

function cacheSet(key: string, html: string) {
  if (htmlCache.size >= MAX_CACHE) {
    const oldest = htmlCache.keys().next().value
    if (oldest !== undefined) htmlCache.delete(oldest)
  }
  htmlCache.set(key, html)
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}

async function renderBlock(block: Block): Promise<string> {
  // Live tail and incomplete fences must appear instantly for typewriter.
  // Full markdown parse + shiki would pop in one frame later.
  if (block.mode === "live") {
    // Minimal paragraph wrapping so streaming text still feels like markdown
    // without paying the async parser cost per token.
    const esc = escapeHtml(block.src)
    return esc ? `<p>${esc.replace(/\n/g, "<br>")}</p>` : ""
  }
  if (block.mode === "code" && !block.complete) {
    return `<pre class="shiki-fallback"><code>${escapeHtml(block.src)}</code></pre>`
  }
  if (block.mode === "code") return highlightCode(block.src, block.language ?? "text")
  return sanitizeMarkdown(await parseMarkdown(block.src))
}

export function Markdown(props: { text: string; streaming?: boolean }) {
  const [rendered, setRendered] = createSignal<Rendered[]>([])
  let projectionRef: Projection | undefined
  let generation = 0
  let disposed = false
  onCleanup(() => {
    disposed = true
  })

  createEffect(() => {
    const text = props.text
    const live = !!props.streaming
    const next = project(projectionRef, text, live)
    projectionRef = next
    const myGeneration = ++generation

    void Promise.all(
      next.blocks.map(async (block, i): Promise<Rendered> => {
        const key = `${block.mode}:${block.raw}`
        const cached = block.mode !== "live" ? htmlCache.get(key) : undefined
        if (cached !== undefined) return { key: `${i}`, html: cached }
        const html = await renderBlock(block)
        if (block.mode !== "live") cacheSet(key, html)
        return { key: `${i}`, html }
      }),
    ).then((results) => {
      if (disposed || myGeneration !== generation) return
      setRendered(results)
    })
  })

  return (
    <div class="md-content" classList={{ "md-streaming": !!props.streaming }}>
      <For each={rendered()}>{(block) => <div class="md-block" innerHTML={block.html} />}</For>
    </div>
  )
}
