/**
 * Lightweight POSIX shell syntax highlighting.
 *
 * The desktop renders the command through shiki (a `bash` fence inside
 * `Markdown`). That is right there — shiki is already loaded for message
 * markdown. Here it is not: this PWA renders everything in one type face with
 * no monospace, so shiki's per-token colours fight the surrounding style, and
 * pulling hundreds of KB of grammars into a phone bundle to colour a one-line
 * command is a poor trade.
 *
 * So this is a small, deliberate shell tokenizer producing tokens styled from
 * the app's own palette. It covers what actually appears in tool calls: quoted
 * strings (quoting style preserved, since `"$HOME"` expands and `'$HOME'`
 * does not — and a wrong-looking command is usually wrong for that reason),
 * comments, redirections, pipes and operators, flags, paths, numbers, the
 * leading program, and the subcommand of the CLIs agents invoke most.
 *
 * It is not a shell parser. Unrecognised text stays plain, which is the correct
 * fallback: a wrong colour is worse than no colour.
 */

export type CommandTokenKind =
  | "plain"
  | "program"
  | "subcommand"
  | "flag"
  | "string"
  | "comment"
  | "operator"
  | "redirect"
  | "number"
  | "path"

export type CommandToken = {
  text: string
  kind: CommandTokenKind
}

// Longest first, so `&&` wins over `&` and `>>` over `>`.
const OPERATORS = [
  "&&", "||", ";;", "|&",
  ">>", "<<", ">|", "<&", ">&",
  ">", "<", "|", ";", "&",
  "(", ")", "{", "}",
]

/** `sudo`/`env`/`npx`/`time` prefix a real command; they do not own the program slot. */
const TRANSPARENT = new Set(["sudo", "env", "npx", "time", "nohup", "exec"])

const SUBCOMMANDS: Record<string, Set<string>> = {
  git: new Set([
    "add", "branch", "checkout", "cherry-pick", "clone", "commit", "config", "diff", "fetch",
    "init", "log", "merge", "mv", "pull", "push", "rebase", "reset", "restore", "revert", "rm",
    "show", "stash", "status", "switch", "tag",
  ]),
  npm: new Set(["install", "run", "test", "build", "ci", "start", "publish", "exec", "lint", "audit", "outdated", "list", "why"]),
  pnpm: new Set(["install", "run", "test", "build", "add", "exec", "dlx", "lint", "audit", "list", "why", "outdated"]),
  yarn: new Set(["install", "run", "test", "build", "add", "dlx", "lint", "audit", "why", "set"]),
  bun: new Set(["install", "run", "test", "build", "add", "x", "create", "pm", "outdated", "update"]),
  docker: new Set(["build", "run", "ps", "stop", "start", "logs", "exec", "compose", "images", "pull", "push", "rmi"]),
  cargo: new Set(["build", "run", "test", "check", "fmt", "clippy", "add", "update", "publish", "install"]),
  go: new Set(["build", "run", "test", "fmt", "vet", "mod", "get", "generate", "install"]),
  gh: new Set(["pr", "issue", "repo", "run", "workflow", "release", "auth", "api", "search"]),
  kubectl: new Set(["get", "apply", "delete", "describe", "logs", "exec", "port-forward", "scale"]),
  brew: new Set(["install", "uninstall", "upgrade", "update", "list", "search", "info", "services"]),
  systemctl: new Set(["start", "stop", "restart", "status", "enable", "disable", "daemon-reload"]),
  aws: new Set(["s3", "ec2", "lambda", "configure", "sts", "cloudformation", "iam"]),
  gcloud: new Set(["compute", "container", "projects", "auth", "config", "functions", "run"]),
  uv: new Set(["run", "pip", "venv", "add", "remove", "sync", "lock", "init", "build", "publish"]),
  poetry: new Set(["install", "add", "remove", "run", "build", "publish", "env", "lock", "shell"]),
}

const isFlag = (word: string) => /^--?[A-Za-z][\w.-]*$/.test(word) || /^--[\w.-]+=/.test(word) || /^-[A-Za-z]{2,}$/.test(word)

const isNumber = (word: string) => /^-?\d+(\.\d+)?$/.test(word)

const isPathLike = (word: string) =>
  word.length > 1 && (word.includes("/") || word.includes("\\") || /^\.{1,2}$/.test(word) || word.startsWith("~"))

/** Splits a command line into styled runs; adjacent same-kind runs are merged. */
export function tokenizeCommand(command: string): CommandToken[] {
  const tokens: CommandToken[] = []

  const push = (text: string, kind: CommandTokenKind) => {
    if (!text) return
    const previous = tokens[tokens.length - 1]
    if (previous && previous.kind === kind) previous.text += text
    else tokens.push({ text, kind })
  }

  // True when the next bare word should be read as the program of a command.
  let expectProgram = true
  // Set once a program has been seen, cleared by the first bare word after it
  // or by a control operator — only the first word is the subcommand.
  let expectSubcommand = false
  let program: string | undefined

  let index = 0
  while (index < command.length) {
    const char = command[index]!

    if (/\s/.test(char)) {
      let end = index
      while (end < command.length && /\s/.test(command[end]!)) end++
      push(command.slice(index, end), "plain")
      index = end
      continue
    }

    // A `#` starts a comment only at the start of a word.
    if (char === "#" && (tokens.length === 0 || /\s$/.test(tokens[tokens.length - 1]!.text))) {
      push(command.slice(index), "comment")
      break
    }

    if (char === "'" || char === '"') {
      let end = index + 1
      while (end < command.length) {
        if (command[end] === "\\" && end + 1 < command.length) {
          end += 2
          continue
        }
        if (command[end] === char) {
          end++
          break
        }
        end++
      }
      push(command.slice(index, end), "string")
      index = end
      continue
    }

    // `2>&1`, `1>/dev/null`: the fd number is part of the redirection, not a
    // standalone number token, and `>&` must not be read as `>` + `&`.
    const fdPrefix = command[index] === "2" || command[index] === "1"
    const operatorAt = fdPrefix ? index + 1 : index
    const operator = OPERATORS.find((candidate) => command.startsWith(candidate, operatorAt))
    if (operator) {
      const redirect = /^[<>]/.test(operator)
      let end = operatorAt + operator.length
      // A duplicate-fd target (`2>&1`) is one token, not `>&` plus a `1`.
      const dup = /^[<>]?&/.test(operator) || operator === ">&" || operator === "<&"
      if (dup && command[end] && /[&\d]/.test(command[end]!)) end++
      const start = operatorAt - (fdPrefix ? 1 : 0)
      push(command.slice(start, end), redirect ? "redirect" : "operator")
      index = end
      // `|`, `;`, `&&`, `||` end the command; the next word is a new program.
      if (!redirect && operator !== "(" && operator !== "{") {
        expectProgram = true
        expectSubcommand = false
        program = undefined
      }
      continue
    }

    let end = index
    while (end < command.length && !/[\s"'#|;&<>(){}]/.test(command[end]!)) end++
    if (end === index) {
      // Unmatched closing punctuation.
      push(char, "plain")
      index++
      continue
    }
    const word = command.slice(index, end)
    index = end

    if (expectProgram) {
      const base = word.split(/[/\\]/).pop()?.toLowerCase() ?? ""
      // `env FOO=1 npm test` — a leading assignment is not the program.
      if (TRANSPARENT.has(base) || (/^[A-Za-z_][\w]*=/.test(word) && program === undefined)) {
        push(word, "plain")
        continue
      }
      program = base
      expectProgram = false
      expectSubcommand = true
      push(word, "program")
      continue
    }

    if (isFlag(word)) {
      expectSubcommand = false
      push(word, "flag")
      continue
    }

    if (expectSubcommand && program && SUBCOMMANDS[program]?.has(word.toLowerCase())) {
      expectSubcommand = false
      push(word, "subcommand")
      continue
    }
    expectSubcommand = false

    if (isNumber(word)) push(word, "number")
    else if (isPathLike(word)) push(word, "path")
    else push(word, "plain")
  }

  return tokens
}
