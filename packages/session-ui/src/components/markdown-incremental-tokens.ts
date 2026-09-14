import type { Token, Tokens, TokensList } from "marked"

/**
 * Characters that can change Markdown/HTML/KaTeX tokenization without a
 * newline. Keep this intentionally conservative: a miss only costs a normal
 * lexer pass, while a false positive would be a rendering correctness bug.
 */
const unsafeAppendChars = new Set([
  "\\",
  "\r",
  "\n",
  "`",
  "*",
  "_",
  "~",
  "[",
  "]",
  "(",
  ")",
  "<",
  ">",
  "{",
  "}",
  "&",
  "$",
  "@",
  ":",
  "/",
  "|",
  "!",
])

function safeSuffix(value: string) {
  if (!value) return false
  for (const char of value) if (unsafeAppendChars.has(char)) return false
  return true
}

/**
 * GFM can promote a previously ordinary terminal text run into an autolink
 * after later characters arrive (for example `foo@bar` + `.com`, or `www` +
 * `.example`). Do not incrementally extend those ambiguous runs.
 */
function autolinkCandidate(value: string) {
  const tail = value.match(/\S+$/)?.[0]?.toLowerCase() ?? ""
  if (!tail) return false
  return (
    tail.includes("&") ||
    tail.includes("@") ||
    tail.startsWith("www") ||
    tail === "http" ||
    tail === "https" ||
    tail === "ftp"
  )
}

function textToken(value: string): Tokens.Text {
  return { type: "text", raw: value, text: value, escaped: false }
}

function appendInline(tokens: Token[], suffix: string): boolean {
  const last = tokens.at(-1)
  if (!last) {
    tokens.push(textToken(suffix))
    return true
  }

  if (last.type === "text") {
    const token = last as Tokens.Text
    if (token.tokens?.length) {
      if (!appendInline(token.tokens, suffix)) return false
      token.raw += suffix
      token.text += suffix
      return true
    }
    if (autolinkCandidate(token.text)) return false
    token.raw += suffix
    token.text += suffix
    return true
  }

  // A GFM autolink at EOF can absorb later ordinary characters and change its
  // href/text. Explicit Markdown links are closed by syntax and are safe, but
  // distinguishing every link tokenizer case here buys little. Fall back.
  if (last.type === "link") return false

  // These are closed inline constructs. A grammar-safe suffix becomes a plain
  // text sibling after them and cannot alter their already-tokenized contents.
  if (
    last.type === "strong" ||
    last.type === "em" ||
    last.type === "del" ||
    last.type === "codespan" ||
    last.type === "escape" ||
    last.type === "image" ||
    last.type === "br" ||
    last.type === "checkbox"
  ) {
    tokens.push(textToken(suffix))
    return true
  }

  // Extension tokens such as inline KaTeX are closed constructs too, but do
  // not guess about arbitrary third-party tokenizers. The ordinary lexer path
  // remains the correctness fallback for Generic/HTML/tag/unknown tokens.
  return false
}

function appendBlock(tokens: Token[], suffix: string): boolean {
  const last = tokens.at(-1)
  if (!last) return false

  if (last.type === "paragraph" || last.type === "heading") {
    const token = last as Tokens.Paragraph | Tokens.Heading
    if (!appendInline(token.tokens, suffix)) return false
    token.raw += suffix
    token.text += suffix
    return true
  }

  if (last.type === "blockquote") {
    const token = last as Tokens.Blockquote
    if (!appendBlock(token.tokens, suffix)) return false
    token.raw += suffix
    token.text += suffix
    return true
  }

  if (last.type === "list") {
    const token = last as Tokens.List
    const item = token.items.at(-1)
    if (!item || !appendBlock(item.tokens, suffix)) return false
    token.raw += suffix
    item.raw += suffix
    item.text += suffix
    return true
  }

  // List-item block content is commonly wrapped in a text token that itself
  // owns inline tokens. Handle it here, but reject a bare block-level text token
  // with no inline tokenization because its grammar context is ambiguous.
  if (last.type === "text") {
    const token = last as Tokens.Text
    if (!token.tokens?.length || !appendInline(token.tokens, suffix)) return false
    token.raw += suffix
    token.text += suffix
    return true
  }

  // Tables, HTML, code, definitions, horizontal rules, block KaTeX and unknown
  // extensions can all reinterpret their terminal source. Full lexing is cheap
  // insurance for those less common shapes.
  return false
}

function preservesTrailingWhitespace(tokens: Token[]): boolean {
  const last = tokens.at(-1)
  if (!last) return false
  if (last.type === "paragraph") return true
  if (last.type === "blockquote") return preservesTrailingWhitespace((last as Tokens.Blockquote).tokens)
  // A block-level text token occurs inside list items, whose outer list lexer
  // normalizes EOF whitespace before this level is reached. Treat it as unsafe
  // unless a future non-list caller proves a stronger context.
  return false
}

/**
 * Mutate a retained Marked token list for a proven append-only, grammar-safe
 * suffix. Returns false without requiring the caller to trust the mutated list;
 * callers should replace it with a fresh lexer result on any miss.
 */
export function appendPlainMarkdownTokens(tokens: TokensList, suffix: string, previousText?: string) {
  if (!safeSuffix(suffix)) return false
  // Marked has token-specific EOF whitespace normalization (notably headings
  // and list items), but ordinary paragraphs preserve it exactly. Crossing a
  // whitespace boundary is safe only for a terminal shape whose lexer retains
  // those bytes in its inline token tree.
  if (
    (/[ \t]$/.test(suffix) || (previousText !== undefined && /[ \t]$/.test(previousText))) &&
    !preservesTrailingWhitespace(tokens)
  )
    return false
  return appendBlock(tokens, suffix)
}
