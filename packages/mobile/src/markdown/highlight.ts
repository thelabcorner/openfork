// Lazy-loaded shiki highlighter — shiki's grammars/engine are ~100s of KB,
// so this only loads once the first code fence actually needs highlighting,
// not on initial app bundle/paint.
import type { Highlighter } from "shiki"

const THEME = "github-dark"
const LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "bash",
  "shell",
  "python",
  "go",
  "rust",
  "css",
  "html",
  "yaml",
  "markdown",
  "sql",
  "diff",
  "toml",
  "dockerfile",
  "c",
  "cpp",
  "java",
  "php",
  "ruby",
  "swift",
  "kotlin",
  "csharp",
]

let highlighterPromise: Promise<Highlighter> | undefined
function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = import("shiki").then((shiki) => shiki.createHighlighter({ themes: [THEME], langs: LANGS }))
  }
  return highlighterPromise
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const LANG_SET = new Set(LANGS)

// Fence languages people actually type are often shorthand — shiki's grammar
// names are the long form, so without this map "ts"/"js"/"py"/"sh" fences
// (extremely common) would silently fall back to unhighlighted text.
const ALIASES: Record<string, string> = {
  ts: "typescript",
  js: "javascript",
  py: "python",
  rb: "ruby",
  sh: "bash",
  zsh: "bash",
  yml: "yaml",
  md: "markdown",
  "c++": "cpp",
  "c#": "csharp",
  cs: "csharp",
  dockerfile: "dockerfile",
  golang: "go",
  rs: "rust",
  kt: "kotlin",
  text: "",
  plaintext: "",
  plain: "",
}

export async function highlightCode(code: string, language: string): Promise<string> {
  const raw = language.toLowerCase().trim()
  const lang = ALIASES[raw] ?? raw
  if (!lang || !LANG_SET.has(lang)) return `<pre class="shiki-fallback"><code>${escapeHtml(code)}</code></pre>`
  try {
    const highlighter = await getHighlighter()
    return highlighter.codeToHtml(code, { lang, theme: THEME })
  } catch {
    return `<pre class="shiki-fallback"><code>${escapeHtml(code)}</code></pre>`
  }
}
