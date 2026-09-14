// Mobile uses Shiki's fine-grained core + JavaScript regex engine. Importing the
// top-level `shiki` bundle makes every registered grammar/theme reachable and
// the default Oniguruma engine adds a WASM startup/download tax. A phone should
// pay only for the first language it actually displays.
import type { HighlighterCore } from "shiki/core"

const THEME = "github-dark"
// Keep every grammar import statically enumerable. Importing `shiki/langs`
// exposes Shiki's entire bundled-language registry to Vite, which means the
// production build emits hundreds of otherwise unreachable grammar chunks.
// Direct imports preserve lazy, per-language admission while constraining the
// asset graph to the languages mobile actually supports.
const LANGUAGE_LOADERS = {
  typescript: () => import("shiki/langs/typescript.mjs"),
  tsx: () => import("shiki/langs/tsx.mjs"),
  javascript: () => import("shiki/langs/javascript.mjs"),
  jsx: () => import("shiki/langs/jsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  shell: () => import("shiki/langs/shell.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  sql: () => import("shiki/langs/sql.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  dockerfile: () => import("shiki/langs/dockerfile.mjs"),
  c: () => import("shiki/langs/c.mjs"),
  cpp: () => import("shiki/langs/cpp.mjs"),
  java: () => import("shiki/langs/java.mjs"),
  php: () => import("shiki/langs/php.mjs"),
  ruby: () => import("shiki/langs/ruby.mjs"),
  swift: () => import("shiki/langs/swift.mjs"),
  kotlin: () => import("shiki/langs/kotlin.mjs"),
  csharp: () => import("shiki/langs/csharp.mjs"),
} as const

type Lang = keyof typeof LANGUAGE_LOADERS

let highlighterPromise: Promise<HighlighterCore> | undefined
const loaded = new Set<string>()
const loading = new Map<string, Promise<void>>()

function getHighlighter() {
  if (!highlighterPromise) {
    highlighterPromise = Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
      import("shiki/themes/github-dark.mjs"),
    ]).then(async ([shiki, engine, theme]) => {
      return shiki.createHighlighterCore({
        themes: [theme.default],
        langs: [],
        engine: engine.createJavaScriptRegexEngine(),
      })
    })
  }
  return highlighterPromise
}

function loadLanguage(lang: Lang) {
  return LANGUAGE_LOADERS[lang]()
}

async function ensureLanguage(highlighter: HighlighterCore, lang: Lang, source = loadLanguage(lang)) {
  if (loaded.has(lang)) return
  const pending = loading.get(lang)
  if (pending) return pending
  const task = source
    .then((module) => highlighter.loadLanguage(module.default))
    .then(() => {
      loaded.add(lang)
    })
    .finally(() => loading.delete(lang))
  loading.set(lang, task)
  return task
}

function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

const LANG_SET = new Set<string>(Object.keys(LANGUAGE_LOADERS))

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
    const requested = lang as Lang
    // Engine/theme and first grammar fetch/parse are independent. Start them
    // together so the first code fence pays max(engine, grammar), not their sum.
    const highlighterWork = getHighlighter()
    const languageWork = loadLanguage(requested)
    const highlighter = await highlighterWork
    await ensureLanguage(highlighter, requested, languageWork)
    return highlighter.codeToHtml(code, { lang, theme: THEME })
  } catch {
    return `<pre class="shiki-fallback"><code>${escapeHtml(code)}</code></pre>`
  }
}
