import { describe, expect, test } from "bun:test"
import { tokenizeCommand } from "./command"

function kinds(command: string) {
  return tokenizeCommand(command).map((token) => token.kind)
}

function find(command: string, kind: string) {
  return tokenizeCommand(command)
    .filter((token) => token.kind === kind)
    .map((token) => token.text)
}

describe("tokenizeCommand", () => {
  test("is lossless — rejoining tokens reproduces the input", () => {
    const commands = [
      "bun test src/app.test.ts --filter 'renders the row'",
      'git commit -m "fix: handle \'quoted\' paths"',
      "npm run build 2>&1 | tee build.log",
      "ls -la | grep -E '\\.tsx?$' | wc -l",
      "cd /tmp && rm -rf ./dist; echo done # cleanup",
      "cat file.txt > out.txt 2>> err.log",
      "docker compose up -d --build",
    ]
    for (const command of commands) {
      expect(tokenizeCommand(command).map((t) => t.text).join("")).toBe(command)
    }
  })

  test("marks the program and the subcommand", () => {
    expect(find("git commit -m wip", "program")).toEqual(["git"])
    expect(find("git commit -m wip", "subcommand")).toEqual(["commit"])
    expect(find("npm run build", "subcommand")).toEqual(["run"])
    expect(find("cargo test --release", "subcommand")).toEqual(["test"])
  })

  test("only the first word after the program is a subcommand", () => {
    // "commit" is the verb; the message after -m is not.
    expect(kinds("git commit -m wip")).toEqual([
      "program",
      "plain",
      "subcommand",
      "plain",
      "flag",
      "plain",
    ])
    // A second verb-like word is not coloured as a subcommand.
    expect(find("git commit -m commit", "subcommand")).toEqual(["commit"])
  })

  test("reads sudo and env as transparent prefixes", () => {
    expect(find("sudo systemctl restart nginx", "program")).toEqual(["systemctl"])
    expect(find("env FOO=1 npm test", "program")).toEqual(["npm"])
  })

  test("restarts the program slot after a control operator", () => {
    expect(find("cd /tmp && rm -rf dist", "program")).toEqual(["cd", "rm"])
    expect(find("echo hi | grep hi", "program")).toEqual(["echo", "grep"])
    expect(find("bun test; bun build", "program")).toEqual(["bun", "bun"])
  })

  test("separates flags, paths and numbers", () => {
    expect(find("ls -la ./src", "flag")).toEqual(["-la"])
    expect(find("ls -la ./src", "path")).toEqual(["./src"])
    expect(find("head -n 20 file.txt", "number")).toEqual(["20"])
  })

  test("preserves quoting style so expansion stays visible", () => {
    expect(find('echo "$HOME"', "string")).toEqual(['"$HOME"'])
    expect(find("echo '$HOME'", "string")).toEqual(["'$HOME'"])
  })

  test("classifies redirections apart from pipes", () => {
    const tokens = tokenizeCommand("bun test > out.txt 2>&1 | tee log")
    expect(tokens.filter((t) => t.kind === "redirect").map((t) => t.text)).toEqual([">", "2>&1"])
    expect(tokens.filter((t) => t.kind === "operator").map((t) => t.text)).toEqual(["|"])
  })

  test("treats a trailing hash as a comment", () => {
    expect(find("bun test # run the suite", "comment")).toEqual(["# run the suite"])
    // A hash inside a quoted string is not a comment.
    expect(find('echo "a # b"', "comment")).toEqual([])
    expect(find('echo "a # b"', "string")).toEqual(['"a # b"'])
  })

  test("merges adjacent runs of the same kind", () => {
    // Two flags separated by a space merge into one "flag" run.
    expect(find("ls -l -a", "flag")).toEqual(["-l", "-a"])
  })
})
