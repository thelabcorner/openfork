import { describe, expect, test } from "bun:test"
import { catastrophicDeleteReason, type ShellSafetyKind } from "@/tool/shell-safety"

const home = "C:\\Users\\dev"
const cwd = "C:\\Users\\dev\\project"
const check = (kind: ShellSafetyKind, tokens: string[], at = cwd) =>
  catastrophicDeleteReason(tokens, { kind, home, cwd: at })

describe("shell catastrophic delete guard", () => {
  test.each([
    ["bash", ["rm", "-rf", "dist"]],
    ["bash", ["rm", "-rf", "node_modules"]],
    ["bash", ["rm", "-r", "./build"]],
    ["powershell", ["Remove-Item", "-Recurse", "-Force", ".\\dist"]],
    ["cmd", ["rmdir", "/s", "/q", "build"]],
  ] as Array<[ShellSafetyKind, string[]]>) ("allows normal project deletion: %s %j", (kind, tokens) => {
    expect(check(kind, tokens)).toBeUndefined()
  })

  test.each([
    ["bash", ["rm", "-rf", "/"]],
    ["bash", ["rm", "-rf", "/*"]],
    ["bash", ["sudo", "rm", "-rf", "/"]],
    ["bash", ["rm", "-rf", "~"]],
    ["bash", ["rm", "-rf", "$HOME/*"]],
    ["bash", ["rm", "-rf", "C:\\"]],
    ["powershell", ["Remove-Item", "-Recurse", "-Force", "C:\\"]],
    ["powershell", ["rm", "-Recurse", "$env:USERPROFILE"]],
    ["cmd", ["rmdir", "/s", "/q", "C:\\"]],
  ] as Array<[ShellSafetyKind, string[]]>) ("blocks catastrophic deletion: %s %j", (kind, tokens) => {
    expect(check(kind, tokens)).toContain("Blocked catastrophic recursive delete")
  })

  test("blocks relative deletion when cwd itself is the drive root", () => {
    expect(check("bash", ["rm", "-rf", "."], "C:\\")).toContain("Blocked catastrophic recursive delete")
  })

  test("does not block non-recursive root operations", () => {
    expect(check("bash", ["rm", "/"])).toBeUndefined()
    expect(check("powershell", ["Remove-Item", "C:\\"])).toBeUndefined()
  })
})
