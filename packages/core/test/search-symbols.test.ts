import { describe, expect, test } from "bun:test"
import { extractSymbols, extractTypeScriptSymbols } from "@opencode-ai/core/search/symbols"

describe("search symbols", () => {
  test("extracts TypeScript declarations and methods", () => {
    const source = `export interface User {\n  id: string\n}\n\nexport type Role = "admin"\nexport enum Status { Ready }\nexport const makeUser = () => ({})\nexport function loadUser() {}\nexport class Service {\n  start() {}\n}`
    expect(extractSymbols("src/user.ts", source)).toEqual([
      { name: "User", kind: "interface", path: "src/user.ts", line: 1 },
      { name: "Role", kind: "type", path: "src/user.ts", line: 5 },
      { name: "Status", kind: "enum", path: "src/user.ts", line: 6 },
      { name: "makeUser", kind: "const", path: "src/user.ts", line: 7 },
      { name: "loadUser", kind: "function", path: "src/user.ts", line: 8 },
      { name: "Service", kind: "class", path: "src/user.ts", line: 9 },
      { name: "start", kind: "method", path: "src/user.ts", line: 10 },
    ])
  })

  test("returns no symbols for unsupported extensions", () => {
    expect(extractSymbols("README.md", "# User\nfunction fake() {}" )).toEqual([])
  })

  test("supports JavaScript and preserves line numbers", () => {
    expect(extractTypeScriptSymbols("\nconst value = 1\nfunction run() {}", "lib.js")).toEqual([
      { name: "value", kind: "const", path: "lib.js", line: 2 },
      { name: "run", kind: "function", path: "lib.js", line: 3 },
    ])
  })
})
