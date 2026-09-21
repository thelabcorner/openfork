import { describe, expect, test } from "bun:test"
import { projectOxpIpcError } from "./ipc-error"

describe("OXP renderer error projection", () => {
  test("preserves only explicit browser-safe action guidance", () => {
    expect(projectOxpIpcError(new Error("Enable OXP before connecting the Secure MCP Tunnel.")).message).toBe(
      "Enable OXP before connecting the Secure MCP Tunnel.",
    )
  })

  test("does not reflect secret endpoint URLs, native paths, or credentials from privileged exceptions", () => {
    const secret = "sk-renderer-must-never-see-this"
    const endpoint = "http://127.0.0.1:41234/mcp/super-secret-token"
    const nativePath = "C:\\Users\\example\\private-project"
    const projected = projectOxpIpcError(
      new Error(`failed endpoint=${endpoint} key=${secret} path=${nativePath}`),
    ).message
    expect(projected).not.toContain(secret)
    expect(projected).not.toContain(endpoint)
    expect(projected).not.toContain(nativePath)
    expect(projected).toMatch(/No privileged error details/)
  })

  test("collapses structural validation failures to a stable public message", () => {
    expect(projectOxpIpcError(new Error("Invalid OXP grant patch")).message).toBe("Invalid OpenAI Exchange input.")
  })
})
