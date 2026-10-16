import { expect, test } from "bun:test"
import { createHighlighter, getTokenStyleObject, stringifyTokenStyle, type ThemedToken } from "shiki"
import { flattenHighlightLines, convertHighlightTokens } from "./markdown-highlight-tokens"
import { createTokenStyleSerializer } from "./markdown-token-style"
import { ShikiStreamTokenizer } from "@shikijs/stream"

const fixtures = [
  { lang: "typescript", text: "const message: string = '🍒';\r\n\r\nconsole.log(message);\n" },
  { lang: "tsx", text: "export const App = () => <span title=\"foo\">🥇</span>;\r\n" },
  { lang: "json", text: "{\r\n  \"counter\": 4,\n  \"emoji\": \"🍒\"\r\n}\n" },
  { lang: "python", text: "def hello(x: str):\r\n    print(x)\n\r\nhello('🍒')\n" },
  { lang: "css", text: "body {\r\n  color: #ff3344;\n}\r\n" },
  { lang: "html", text: "<html>\r\n  <div aria-label=\"🥇\">Hello</div>\n</html>\r\n" },
] as const

test("real Shiki complete tokens preserve exact source and produce identical styles across grammars", async () => {
  const highlighter = await createHighlighter({ themes: ["github-dark"], langs: fixtures.map((f) => f.lang) })
  const serialize = createTokenStyleSerializer()
  try {
    for (const fixture of fixtures) {
      const lines = highlighter.codeToTokens(fixture.text, { lang: fixture.lang, theme: "github-dark" }).tokens
      const tokens = flattenHighlightLines(lines, (token: ThemedToken) => [token.content, serialize(token)], fixture.text)
      expect(tokens.map((token) => token[0]).join(""), fixture.lang).toBe(fixture.text)
      const actual = tokens.map((token) => token[1])
      const reference = lines.flatMap((line, lineIndex) => [
        ...line.map((token) => stringifyTokenStyle(token.htmlStyle ?? getTokenStyleObject(token))),
        ...(lineIndex === lines.length - 1 ? [] : [""]),
      ])
      expect(actual, fixture.lang).toEqual(reference)
    }
  } finally {
    highlighter.dispose()
  }
})

test("real Shiki stream maintains byte-for-byte source across chunk boundaries and CRLF", async () => {
  const highlighter = await createHighlighter({ themes: ["github-dark"], langs: ["typescript"] })
  try {
    const stream = new ShikiStreamTokenizer({ highlighter, lang: "typescript", theme: "github-dark" })
    const chunks = ["const a: string = ", "\"🍒\";\r", "\nconst b = 42;", "\r", "\nconsole.log(a, b);\n"]
    const serialize = createTokenStyleSerializer()
    let stable: [string, string][] = []
    let expected = ""
    for (const chunk of chunks) {
      expected += chunk
      const next = await stream.enqueue(chunk)
      stable = [...stable, ...convertHighlightTokens(next.stable, (token) => [token.content, serialize(token)])]
      const unstable = convertHighlightTokens(next.unstable, (token) => [token.content, serialize(token)])
      expect([...stable, ...unstable].map((token) => token[0]).join("")).toBe(expected)
    }
  } finally {
    highlighter.dispose()
  }
})
