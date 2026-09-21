# Shell Tool Reliability Research Ledger

**Status:** V1 patch campaign active; first reliability slice implemented  
**Date:** 2026-09-17  
**Scope:** OpenFork's production **V1 tool stack only**. V2/core tool implementations are research context, not patch targets, unless this scope is explicitly reopened. Primary targets are the V1 model-facing `bash` compatibility tool, its foreground/background launch paths, `background action=monitor`, and shared runtime helpers used by those V1 surfaces.

This document remains the research ledger and implementation decision record. It records what the tree does, what external shell specifications say, recurring agent/tool failure patterns seen in other coding agents, the invariants driving the patch phase, and the status of implemented slices.

### 0.1 Product-routing decision (closed 2026-09-17)

OpenFork Desktop's production chat path uses the V1/legacy tool registry. For this campaign, V1 is the only provider-facing tool surface that matters. Do not spend implementation budget patching `packages/core/src/tool/bash.ts` or otherwise pursuing V2 tool parity unless explicitly requested.

### 0.2 First patch slice (implemented 2026-09-17)

- Added `packages/opencode/src/tool/shell/launch.ts` as the V1 owner for resolved execution-profile metadata and process invocation construction.
- Foreground V1 shell, detached/background V1 shell, and `background action=monitor` now share that launcher instead of duplicating PowerShell/heredoc launch logic.
- Provider prose now states the actual resolved interpreter path, dialect, path environment, SCRIPT STRING contract, fresh-process/non-persistent semantics, and redundant nested-shell warning.
- `background action=monitor` now advertises the same resolved runtime profile and marks its command as a shell SCRIPT STRING.
- Removed blanket PowerShell backtick-escaping advice and added Windows PowerShell 5.1 native-argv caution.
- cmd.exe guidance now states that single quotes are not general quoting and calls out the documented 8191-character ceiling.
- Multiline PR-body guidance now prefers `gh ... --body-file` rather than quote-dense inline transport.
- PowerShell Bash-heredoc compatibility translation now refuses **unquoted** delimiters instead of silently literalizing Bash expansion semantics; quoted delimiters and `<<-` remain supported.
- Added focused profile/prompt/heredoc regression tests. Focused suite: **27 passed, 0 failed**.
- Repaired the V1 shell integration-test layer to provide its existing `Snapshot` dependency, then ran the full cross-shell V1 suite on Windows across Git Bash, PowerShell 7, Windows PowerShell 5.1, and cmd.exe: **91 passed, 0 failed** (261 assertions).
- Repository-wide typecheck remains red from unrelated concurrent work. A filtered typecheck still reports the pre-existing `ShellJob.Service.launch` environment typed as `unknown` at the `background action=monitor` call boundary; this existed in the surrounding background-job typing and is not being papered over with an unsafe cast in this slice.

---

## 0. Executive findings

The central reliability problem is not one bad escaping function. It is a contract problem:

> A model-authored `command: string` is a program in a particular shell language, but the model is not always given a precise, trustworthy description of the language and transport that will parse that string.

There are currently multiple independently important parsing layers:

1. model JSON/tool-call serialization,
2. OpenCode's tool contract and any command rewriting,
3. the selected shell parser (`bash`, `sh`, `zsh`, `pwsh`, Windows PowerShell, or `cmd.exe`),
4. shell-to-native-program argument marshalling,
5. sometimes an additional nested shell (`bash -c`, `pwsh -Command`, `cmd /c`),
6. the target program's own parser (regex, JSON, `python -c`, `git`, `gh`, etc.).

Every extra parse layer creates another opportunity for quotes, backslashes, dollar signs, backticks, `%`, carets, newlines, and shell operators to change meaning.

### Highest-priority findings

The table below records the **pre-patch audit findings** that motivated this campaign. Items that are now resolved are retained as historical evidence; Section 13 is the authoritative implementation/current-state ledger.

| Priority | Finding | Failure mode |
|---|---|---|
| **P0** | Legacy and V2 both expose a provider-visible tool named `bash`, but they do not share the same Windows shell resolution/behavior. | Model cannot infer dialect from tool name; same call shape can mean PowerShell, cmd, Git Bash, or POSIX shell depending on stack/runtime. |
| **P0** | The PowerShell Bash-heredoc rewriter erases the semantic distinction between **quoted** and **unquoted** Bash heredocs. | Silent semantic corruption: unquoted Bash heredocs should expand parameters/command substitutions/arithmetic, but the rewrite always emits a literal single-quoted PowerShell here-string. |
| **P0** | `Shell.args()` wraps Bash/zsh session-shell commands in an outer script that calls `eval ${JSON.stringify(command)}`. | The submitted command is parsed once while constructing `eval`'s argument and then parsed again by `eval`; quote/expansion semantics can change before the intended command is evaluated. |
| **P0** | The Bash PR-body example in `shell/prompt.ts` is syntactically incomplete. | The prompt itself teaches a malformed heredoc pattern. |
| **P0** | The POSIX-family prompt says the tool uses a "persistent shell session", but each tool call starts a new child process. | Agents may incorrectly rely on `cd`, shell variables, functions, aliases, or exported state surviving across calls. |
| **P0** | PowerShell notes contain blanket advice to escape special characters with the backtick. | On Windows PowerShell 5.1, the difficult boundary is often PowerShell-to-native argv conversion; blanket backtick escaping can silently produce the wrong native arguments while returning exit 0. |
| **P1** | Legacy prose already injects `${os}` and `${shell}`, but only as coarse `process.platform` + shell basename. V2 has only a static description. | The user's proposed runtime placeholder exists only partially; it needs to become one canonical **resolved execution profile** used by every shell-launching surface. |
| **P1** | `background action=monitor` launches through the same resolved shell machinery but its tool prose does not advertise the resolved shell/dialect. | An agent can compose a monitor command using syntax different from the shell that will execute it. |
| **P1** | Foreground shell execution and background shell execution duplicate PowerShell/heredoc launch logic. | Fixes can drift and create foreground/background semantic differences. |
| **P1** | Legacy permission/safety parsing sees the original command while PowerShell execution may later rewrite Bash heredocs. | Static analysis and executed text can diverge. |
| **P1** | Shell identity is inferred primarily from executable basename. | Wrapper executables/custom shell launchers can execute one dialect while being described as another. |
| **P1** | Complex payloads are transported as inline shell script strings. | Nested quotes, multiline bodies, markdown, regexes, JSON, and Windows paths are disproportionately fragile. |

---

## 1. Current OpenCode shell surface inventory

### 1.1 Legacy/rich shell tool (`packages/opencode`)

Primary files:

- `packages/opencode/src/tool/shell.ts`
- `packages/opencode/src/tool/shell/prompt.ts`
- `packages/opencode/src/tool/shell/shell.txt`
- `packages/opencode/src/tool/shell/id.ts`
- `packages/opencode/src/util/powershell-heredoc.ts`
- `packages/opencode/src/tool/shell-safety.ts`
- `packages/opencode/src/tool/shell-concurrency.ts`
- `packages/opencode/src/background/shell-job.ts`
- `packages/opencode/src/tool/background.ts`
- `packages/core/src/shell.ts`

Important current behavior:

- The compatibility tool ID is still **`bash`** (`shell/id.ts:14-16`) even when the actual command interpreter is PowerShell or cmd.
- Legacy shell selection uses `Shell.acceptable(cfg.shell)`.
- On Windows, `packages/core/src/shell.ts:98-120` currently prefers, in order, roughly:
  1. `pwsh`,
  2. `powershell`,
  3. Git Bash,
  4. `%COMSPEC%` / `cmd.exe`.
- The legacy prompt already renders `OS: ${os}, Shell: ${shell}` (`shell/shell.txt:3`, `shell/prompt.ts:297-315`).
- The shell name supplied to that prompt is a normalized executable basename, not a full capability description.
- PowerShell gets a special direct launch using `-NoLogo -NoProfile -NonInteractive -Command` through the shared V1 `ShellLaunch` boundary.
- Foreground, detached, and monitor launches now share that boundary. The former Bash-heredoc rewriter has been retired; PowerShell Bash-heredoc/here-string syntax is detected and rejected rather than transformed.

### 1.2 V2/core `bash` tool (`packages/core`)

Primary files:

- `packages/core/src/tool/bash.ts`
- `packages/core/src/tool/builtins.ts`
- `packages/core/src/tool/registry.ts`
- `packages/core/src/location-services.ts`

Important current behavior:

- The tool is also named **`bash`** (`packages/core/src/tool/bash.ts:18`).
- It is included in the V2 built-in tool group (`builtins.ts:35-49`) and location-service graph (`location-services.ts:79-87`).
- Its provider-facing description is static (`bash.ts:109`) and does not tell the model the **resolved current shell**.
- Its fallback is `/bin/sh` on POSIX and `%COMSPEC%`/`cmd.exe` on Windows (`bash.ts:49`).
- It executes with `ChildProcess.make(input.command, [], { shell, ... })` (`bash.ts:154-164`).
- The source explicitly carries a parity TODO: **"Restore PowerShell and cmd-specific invocation/path handling on Windows."** (`bash.ts:69`).
- Its warnings literally say "Bash runs with host-user ... authority" even when the configured shell may not be Bash (`bash.ts:138-141`).

### 1.3 Background/monitor shell execution

`packages/opencode/src/tool/background.ts` is not just a job manager. `action="monitor"` accepts a fresh model-authored `command` string and resolves a shell itself (`background.ts:252-309`). It therefore belongs in this audit.

Its static `background.txt` describes the command only as a "long-running shell command" and does not inject the actual resolved OS/shell/dialect. That makes monitor creation a second provider-facing command-string surface with less shell guidance than the main shell tool.

### 1.4 Session shell endpoint and command-template shell substitutions

There are two additional shell-string execution surfaces outside the model-facing `bash` tool definitions:

1. `SessionPrompt.shell` (`packages/opencode/src/session/prompt.ts:1150-1291`) executes a user-submitted shell command and records it as a shell tool part. It resolves `Shell.preferred(cfg.shell)`, then calls `Shell.args(sh, input.command, cwd)` before spawning the process.
2. Custom command templates can execute `` !`...` `` shell substitutions before they become a prompt (`session/prompt.ts:2669-2690`). These resolve `Shell.preferred(cfg.shell)` and now lower through the same V1 `ShellLaunch.command(...)` boundary used by provider-facing shell execution, then run through the shared `ChildProcessSpawner`.

`packages/core/src/shell.ts::args()` remains part of the quote-mangling audit, not merely shell-selection infrastructure. Its Bash/zsh branches retain the intentional login/rc bootstrap, but user command source is no longer interpolated into that bootstrap. It is transported as a distinct positional argument:

```sh
cd -- "$1"
__opencode_session_shell_source=$2
set -- "$1"
eval "$__opencode_session_shell_source"
```

The command bytes therefore stay out of the fixed bootstrap's source parse. The one remaining `eval` is the intentional parse of the supplied shell program after startup initialization. Regression coverage restores the historical positional-parameter view so the transport-only `$2` is not visible to the executed command.

This path is not the same as the model-facing shell tool, but it shares the shell runtime and can reproduce the same quote-mangling class in user shell execution and command-template preprocessing. It belongs in the regression corpus.

The PTY terminal path (`packages/core/src/pty.ts:173-200`) also consumes `Shell.preferred(...)`, but it launches the selected shell executable interactively rather than transporting a generated shell program through `-c`/`eval`; it is relevant to shell-selection consistency, not the same quote-transport risk.

### 1.5 Both provider materialization paths are real, not dead duplicate code

The legacy session path materializes the legacy registry through `SessionTools.resolve()` (`packages/opencode/src/session/tools.ts:237-369`), and `packages/opencode/src/session/prompt.ts:2160-2175` supplies those tools to the V1 session generation path. That registry initializes `ShellTool` as its shell entry (`packages/opencode/src/tool/registry.ts:224-280`).

The V2/core runner separately calls the V2 `ToolRegistry.materialize()` and sends those definitions to the provider (`packages/core/src/session/runner/llm.ts:278-299`). Its built-in set includes the core `BashTool`.

Therefore the two `bash` contracts are architecturally live in their respective session stacks. Patch planning must treat shell reliability as a **cross-stack contract**, not assume one copy is obsolete merely because another exists. A remaining product-routing question is which user-facing clients/features currently select V1 vs V2, but the code-level materialization paths are established.

### 1.6 Typed tools that already avoid shell-string composition

Several tools launch known binaries with argv arrays (`git`, `project`, `test`, `typecheck`, `sqlite`, `sympy`, etc.). These are important positive examples: they avoid exposing shell metacharacters as program syntax unless shell behavior is explicitly required.

This supports a general architecture rule:

> Use a shell script string only when shell language features are actually needed. Use executable + argv for structured program invocation.

---

## 2. Shell identity must be a resolved execution profile, not an OS guess

The model needs to know at least three independent facts:

1. **Host platform** — Windows, macOS, Linux, etc.
2. **Actual command interpreter/dialect** — Bash/POSIX, PowerShell 7, Windows PowerShell 5.1, cmd.exe, zsh, etc.
3. **Path/native-program environment** — e.g. Windows + Git Bash is a POSIX-like shell parsing Windows-hosted programs and paths; PowerShell can also run on Linux; host OS does not uniquely determine shell syntax.

The current legacy `${os}` + `${shell}` placeholder is directionally correct, but it is too lossy to be the long-term contract. The V2 tool does not have even that resolved description.

### Candidate canonical structure for patch phase

```ts
type ShellExecutionProfile = {
  platform: NodeJS.Platform
  shellPath: string
  shellName: string
  dialect: "posix" | "bash" | "zsh" | "powershell" | "cmd"
  version?: string
  pathEnvironment?: "native-posix" | "native-windows" | "msys-git-bash"
  nativeArgMode?: "powershell-legacy" | "powershell-windows" | "powershell-standard"
  transport: "inline-script" | "script-file"
  persistent: false
}
```

Exact fields can change. The important invariant is ownership:

> The same runtime component that decides what executable/arguments will actually be spawned must produce the profile advertised to the model.

Do **not** independently infer the prompt's shell from `$SHELL`, `%COMSPEC%`, platform, terminal application, or configuration text after execution resolution has already happened.

### Candidate model-facing block

```text
Runtime shell profile:
- Host OS: Windows (win32)
- Actual interpreter: PowerShell 7.x (pwsh)
- Dialect: PowerShell
- Path environment: native Windows
- Command input is a shell SCRIPT STRING, not an argv array.
- Each tool call starts a fresh shell process; shell state does not persist across calls.
- Do not wrap the command in another `pwsh -Command`, `cmd /c`, or `bash -c` unless a foreign shell is specifically required.
```

This is materially better than a generic list of all possible shells because it removes the model's need to select a branch.

---

## 3. Quote mangling: failure taxonomy

### 3.1 Script-string vs argv ambiguity

An argv tool and a script-string tool have opposite rules for shell operators:

- In an argv array, `|`, `&&`, `>`, `;` are ordinary argument bytes unless the target program interprets them.
- In a shell script string, those tokens are operators and **must not** be defensively quoted if they are intended as syntax.

OpenAI Codex issue #20875 documents exactly this model/tool-contract failure: a string-valued `cmd` field led models to emit quoted literal operators such as `'|'`, so the pipe became an argument rather than shell syntax. The same report shows how adding a nested `bash -c '...'` creates another quote layer that breaks backticks/dollar signs.

**Candidate invariant:** provider-facing prose should explicitly say **SCRIPT STRING** or **ARGV ARRAY** near the parameter description itself, not only in distant system prose.

### 3.2 Nested shell invocation multiplies parsers

High-risk forms include:

```text
bash -c '...'
pwsh -Command "..."
cmd /c "..."
ssh host 'shell program here'
```

These may be necessary, but the outer shell transforms the inner program before the inner parser sees it. Models frequently add an unnecessary nested shell even when the tool already provides one.

**Candidate prompt rule:** do not nest the same shell around the command (`pwsh -Command` inside a tool already executing PowerShell, `bash -c` inside Bash) merely for grouping. For complex foreign-shell content, prefer a temporary script file plus an explicit interpreter.

### 3.3 `eval` is an explicit second parser

GNU Bash defines `eval` by concatenating its arguments into a command, then reading and executing that command. BashFAQ/048 calls out the practical consequence directly: code passed through `eval` is parsed twice, and quoting/expansion must survive both passes.

That is directly relevant to `Shell.args()` for Bash/zsh. The wrapper is trying to preserve login-shell initialization and the caller-selected working directory, but using `eval` to re-inject the original command means the transport itself participates in shell semantics.

Patch-time question: can the login-shell wrapper pass the command as an opaque positional parameter and execute it through a representation that does not perform an unintended first round of expansion, or can the complex command be moved to a temporary script file? The replacement must preserve aliases/startup behavior that motivated the current wrapper; simply deleting `eval` without understanding that contract is not sufficient.

### 3.4 POSIX variable/command expansion

For POSIX/Bash-family shells, shell-generated data should be quoted as data. ShellCheck SC2086 and BashFAQ/050 both reinforce the same distinction: strings of shell code are not interchangeable with argv arrays/data.

Regression corpus should include:

- spaces and tabs,
- glob characters `* ? [ ]`,
- empty arguments,
- apostrophes,
- dollar signs and command substitutions,
- regex backslashes,
- JSON/Markdown containing quotes and backticks.

### 3.5 PowerShell has two separate quoting boundaries

PowerShell first parses its own expression/argument language and then marshals arguments to native executables. Microsoft documents that:

- outer PowerShell quotes are normally consumed by PowerShell,
- PowerShell 7.3 changed native argument passing,
- `$PSNativeCommandArgumentPassing` can be `Legacy`, `Standard`, or `Windows`,
- Windows mode intentionally falls back to legacy behavior for `cmd.exe`, `.bat`, `.cmd`, and several script hosts.

Therefore "PowerShell quoting" is not one behavior. `powershell.exe` 5.1 and modern `pwsh` are materially different for native programs.

The current `shell/prompt.ts:64,73` instruction, "Escape special characters with the PowerShell backtick character," is too broad. OpenCode issue #42402 contains a concrete Windows PowerShell 5.1 native-argv corruption case where backtick escaping made the result worse and still returned success.

**Candidate rule:** PowerShell guidance must distinguish:

- quoting a PowerShell string,
- invoking cmdlets,
- passing an argument to a native executable,
- Windows PowerShell 5.1 vs PowerShell 7.3+ native-argument behavior.

### 3.6 cmd.exe is a separate language, not "Windows shell syntax"

Important cmd-specific differences include:

- single quotes are not a normal quoting delimiter,
- environment variables use `%VAR%`, with expansion timing surprises in compound lines,
- `& | < > ^ % ! ( )` have cmd-specific behavior,
- inline multiline payloads are fragile,
- Microsoft documents an 8191-character `cmd.exe` command-line/environment-expansion limit.

That last point is architectural: sufficiently large inline generated scripts should not be passed through cmd command text at all.

---

## 4. Heredoc deep dive

### 4.1 Bash semantics that must be preserved

GNU Bash and POSIX agree on the critical distinction:

| Bash form | Body semantics |
|---|---|
| `<<'EOF'` / quoted delimiter | Body is literal; no parameter, command, or arithmetic expansion. |
| `<<EOF` / unquoted delimiter | Body undergoes parameter expansion, command substitution, and arithmetic expansion (with heredoc-specific backslash rules). |
| `<<-EOF` | Leading **tabs** are stripped from body/terminator in addition to the quoted/unquoted expansion semantics. |

This means `<<'PY'` and `<<PY` are **not interchangeable syntax variants**.

### 4.2 Current PowerShell rewrite loses that distinction

Current implementation facts:

- `parseOperator()` detects the delimiter quote (`powershell-heredoc.ts:312-327`).
- `collectHeredocs()` does **not** retain that quote in the `Heredoc` object (`:292-305`; type at `:92-107`).
- `render()` always emits a literal single-quoted PowerShell here-string `@' ... '@` or literal base64-decoded text (`:474-480`).
- Therefore the rewrite has no way to reproduce Bash expansion semantics for unquoted heredocs.

The test `packages/opencode/test/util/powershell-heredoc.test.ts:29-33` currently expects an unquoted `<<PY` body containing `$HOME` to remain literal. That expectation conflicts with Bash heredoc semantics: Bash expands `$HOME` before the target interpreter receives stdin, even if the characters happen to sit inside what looks like a Python single-quoted string. The shell does not parse Python syntax inside a heredoc body.

**This is a silent correctness bug, not merely an unsupported syntax edge case.**

### 4.3 Safer patch direction

Until true unquoted-heredoc expansion semantics are implemented and tested, the conservative behavior should be:

1. auto-translate **quoted-delimiter** heredocs whose semantics can be preserved,
2. do not silently literalize unquoted heredocs,
3. either leave unquoted heredocs untouched so the failure is visible, or reject them with a precise diagnostic that directs the model to a safer representation,
4. prefer dedicated file tools / temporary files / stdin-aware structured execution for large generated payloads.

Failing loudly is preferable to exit-0 semantic corruption.

### 4.4 Heredocs are unusually fragile in agent tool transports

Public coding-agent issue trackers show recurring transport-level heredoc bugs even when the shell syntax is valid:

- Claude Code #32563: a single quote inside a quoted heredoc body was reportedly broken by an outer command-transport quoting layer.
- Claude Code #88561 / #89392: reported Windows/Git-Bash backslash collapse even inside quoted heredocs.
- Claude Code #62813: reported a size-dependent hang for a heredoc nested inside command substitution.
- Claude Code #29619: complex Markdown bodies combining apostrophes/backticks repeatedly broke inline heredoc command construction.
- Claude Code #65162: model used PowerShell here-string syntax inside a Bash tool on Windows, silently corrupting a git commit message.

These are third-party issue reports, not shell specifications, but the repeated shape is useful: **heredoc correctness can be defeated by the tool transport before the shell's own heredoc grammar gets a chance to protect the payload.**

### 4.5 Current prompt has a malformed heredoc example

`packages/opencode/src/tool/shell/prompt.ts:279-283` constructs:

```text
gh pr create --title "the pr title" --body "$(cat <<'EOF'
## Summary
<1-3 bullet points>
```

The generated example has no closing `EOF` and no closing command substitution/quote. This should be treated as a direct prompt bug during patching.

More generally, using an inline heredoc solely to transport a PR/commit body should be questioned. `gh ... --body-file`, `git commit -F <file>`, and analogous file/stdin interfaces avoid one or more parsing layers.

---

## 5. Prompt/contract contradictions found in the pre-patch legacy tool

### 5.1 "Persistent shell session" is false

`shell/prompt.ts:271-274` says:

> Executes a given bash command in a persistent shell session...

The execution path starts a fresh child process for each tool call. A background job persists as a process, but ordinary tool calls do not share shell state.

This wording can induce commands like:

```text
call 1: export FOO=bar
call 2: echo "$FOO"
```

or separate `cd`/follow-up calls that cannot work as intended.

### 5.2 "bash tool call" wording leaks into non-Bash profiles

`chainGuidance()` tells PowerShell 7 and cmd agents to use "a single bash tool call" (`prompt.ts:83-89`). The provider-visible tool really is named `bash`, so this is historically understandable, but it reinforces the wrong language prior.

During the compatibility period, prose should say something like **"this shell tool call (tool id: `bash`)"** and immediately state the actual dialect.

### 5.3 PowerShell write guidance conflicts with the PR example

The PowerShell section says not to use here-strings for file writing (`prompt.ts:165-171`) while the GitHub PR example later recommends a PowerShell here-string (`:264-268`). Those are technically different tasks, but the broad prohibition/recommendation pair is easy for a model to generalize incorrectly.

The stronger invariant is not "never use here-strings". It is:

> Do not use the shell as a bulk text transport when a dedicated file/body-file/stdin interface removes quoting layers.

### 5.4 Shell version/capability is encoded indirectly

`pwsh` is labeled PowerShell 7+ and `powershell` is labeled Windows PowerShell 5.1. This is useful, but the profile should ideally originate from the executable actually being launched and, where practical, a cheap cached version/capability probe.

The key capabilities are more useful to the model than a marketing/version label:

- `&&` / `||` support,
- native argument-passing mode,
- encoding defaults,
- path environment,
- here-string syntax,
- whether shell state persists.

---

## 6. Foreground/background/monitor parity hazards

The PowerShell command construction/heredoc rewrite exists in both:

- `packages/opencode/src/tool/shell.ts`, and
- `packages/opencode/src/background/shell-job.ts:58-84`.

This duplication is a reliability hazard. The patch phase should strongly prefer one shared function/component that accepts:

```text
resolved shell profile + command + cwd + env + stdin policy
```

and returns the exact process invocation for foreground, ordinary background, and monitor jobs.

The same shared profile should drive model prose.

### Static-analysis ordering question

The legacy shell tool parses/scans the model's original command for permissions/safety while the PowerShell path can subsequently rewrite heredoc syntax before execution. We need an explicit invariant for the patch phase:

- either analysis is defined over **source semantics** and the transform is proven semantics-preserving,
- or analysis also sees/correlates the transformed command.

Today the unquoted-heredoc finding demonstrates that the transform is not always semantics-preserving, so this distinction is not academic.

---

## 7. Safer transport patterns

### 7.1 Prefer argv for known program invocations

For a tool that means "run git", "run tests", or "invoke this exact binary", prefer:

```text
executable + argv[]
```

over:

```text
shell string containing executable + arguments
```

Python's subprocess documentation states the same security/reliability principle: without a shell, metacharacters are ordinary argument data; once a shell is explicitly invoked, quoting whitespace/metacharacters becomes the caller's responsibility.

This does **not** mean the shell tool should disappear. Pipelines, redirections, conditionals, substitutions, loops, and shell-native commands genuinely require a shell language. It means the contract should be explicit rather than pretending script strings and argv are the same thing.

### 7.2 Consider an explicit argv sibling surface

Long-term candidate:

```text
exec_argv({ executable, args, cwd, ... })
exec_script({ script, shell?, cwd, ... })
```

or an equivalent distinction inside one typed tool.

Codex #20875 independently arrives at this same split after observing operator over-quoting caused by a string/argv mental-model mismatch.

### 7.3 Prefer temporary script files for complex/multiline shell programs

For large or quote-dense scripts, a temp file changes the transport from:

```text
JSON -> shell command option (`-c`/`-Command`/`/c`) -> shell parser
```

to approximately:

```text
JSON -> write exact script bytes -> interpreter executes file
```

GitHub Actions is a useful production precedent: `run:` blocks are written to temporary shell-specific script files and the chosen shell executes the file. On Windows, it uses `.ps1` for PowerShell and `.cmd` for cmd; Bash gets a script file invocation as well.

This does not remove quoting **inside** the script, but it removes the outer command-string quoting layer around the whole script.

Candidate threshold triggers for script-file transport:

- command contains a newline,
- command contains heredoc/here-string syntax,
- command length is large,
- command contains multiple nested quote domains,
- cmd.exe payload approaches its command-line limit,
- generated content is data (Markdown/JSON/source code) rather than shell logic.

### 7.4 Prefer body/file/stdin switches for generated text

Examples:

- `gh ... --body-file <file>` instead of inline multiline `--body` shell quoting,
- `git commit -F <file>` instead of quote-dense multiline `-m`,
- interpreter script files instead of `python -c "..."` / `node -e "..."` for nontrivial code,
- dedicated Write/Edit/Patch tools instead of `echo`, `cat <<EOF`, `Set-Content`, etc.

---

## 8. Candidate patch architecture (research hypothesis)

This is the current best direction, subject to implementation investigation and benchmark/regression results.

### Phase A — one canonical shell execution profile

1. Resolve the actual executable exactly once through shared shell runtime ownership.
2. Classify dialect/capabilities from that resolved executable, with explicit handling for supported wrappers/configured shells.
3. Cache any version probe so prompt construction does not spawn a process per model turn.
4. Expose the profile to:
   - legacy shell prompt,
   - V2/core bash definition,
   - background monitor definition,
   - foreground/background launch functions,
   - tests/diagnostics.

### Phase B — make provider prose mechanically truthful

At minimum, tell the model:

- host OS,
- actual resolved interpreter,
- dialect/version family,
- path environment,
- script-string contract,
- process persistence semantics,
- high-risk dialect-specific rules,
- "do not unnecessarily nest another shell" guidance.

The prose must be generated from the same profile execution uses. No duplicated shell-selection switch statements in prompt code.

### Phase C — fix known prompt defects

- close/remove the malformed Bash heredoc PR example,
- remove "persistent shell session",
- remove generic "backtick escapes special characters" advice,
- stop calling PowerShell/cmd syntax "Bash" except where explaining the legacy tool ID,
- add cmd parse-time variable-expansion caveat or steer complex stateful cmd logic to script files,
- teach Git Bash to use safe path forms (`C:/...` or an explicitly normalized POSIX/MSYS path) rather than unquoted `C:\...`.

### Phase D — make heredoc handling semantics-safe

The initial conservative option was to translate only quoted delimiters. Byte-level Windows integration falsified that approach because PowerShell normalized trailing LF to CRLF. The implemented policy is therefore stricter:

- do not translate Bash heredocs or `<<<` here-strings through PowerShell,
- reject both quoted and unquoted heredocs with actionable file/native-syntax alternatives,
- retain detection tests for quoting/comments/CRLF/fd-qualified/`<<-` forms so rejection does not become a naive substring filter,
- add regression tests proving quoted/unquoted distinction and proving unsupported forms fail before permission prompts.

Longer-term option:

- use script files/stdin-aware structured transport for payloads that cannot cross the selected shell boundary faithfully; do not reintroduce cross-dialect heredoc rewriting without a byte/semantic proof.

### Phase E — unify process invocation

Deduplicate foreground/background/monitor command construction. One shared launcher should own:

- PowerShell flags,
- shell-specific validation/fail-closed compatibility policy,
- encoding policy,
- cwd/env behavior,
- process grouping/kill semantics where possible.

### Phase F — evaluate a structured argv execution sibling

Do not force models to use shell language just to run a single native executable with difficult arguments. A clearly named argv-mode capability can remove an entire parser from common operations.

---

## 9. Regression/evaluation corpus required before calling this fixed

We should build a table-driven corpus whose oracle is **exact bytes/argv observed by a sentinel child program**, not merely exit code 0.

### 9.1 Runtime dimensions

Where CI/dev infrastructure permits:

- Linux: `/bin/sh`, Bash, zsh
- macOS: zsh, Bash/sh where available
- Windows native:
  - PowerShell 7 (`pwsh`)
  - Windows PowerShell 5.1 (`powershell.exe`)
  - `cmd.exe`
  - Git Bash/MSYS

Run each relevant case through:

- legacy foreground shell,
- legacy background shell,
- background monitor launch,
- V2/core bash tool.
- `SessionPrompt.shell` / `Shell.args()` Bash/zsh wrapper,
- custom-command `` !`...` `` shell substitution.

### 9.2 Quoting payload corpus

Exact-argv cases should contain:

- `plain`
- `with space`
- empty string
- `'apostrophe'`
- `"double quote"`
- both quote types together
- `$HOME`, `${HOME}`, `$(...)`, `` `...` ``
- PowerShell `$env:NAME`, `$()`, backtick
- `%PATH%`, `!VAR!`, `^`, `&`, `|`, `<`, `>` for cmd
- `C:\Users\Name\Folder With Space\x.txt`
- `C:/Users/Name/Folder With Space/x.txt`
- POSIX paths with spaces
- regexes with `\`, `\\`, `$`, brackets, capture groups
- JSON with escaped quotes/backslashes
- Markdown with apostrophes + backticks + dollar signs
- Unicode: accented Latin, CJK, emoji
- CRLF and LF payloads
- arguments ending in backslash before a quote (Windows argv edge case)

### 9.3 Operator corpus

Prove the distinction between shell syntax and literal argv data:

- `|`
- `&&`
- `||`
- `;`
- `>` / `>>`
- `<`
- command substitutions
- grouped expressions/subshells where supported

### 9.4 Heredoc corpus

At minimum:

- quoted delimiter: `<<'EOF'`
- double-quoted delimiter
- unquoted delimiter: `<<EOF`
- `<<-EOF` with tabs
- `$VAR` in body
- `$(command)` in body
- arithmetic `$((1+2))` in body
- apostrophes/backticks/double quotes in literal body
- CRLF body
- Unicode body
- body containing PowerShell here-string terminator `'@` / `"@`
- multiple heredocs in one command
- heredoc after a command chain
- malformed/unterminated heredoc
- unknown stdin target
- target executable path containing spaces

For unquoted heredocs the oracle must compare against **real Bash semantics**, never against a compatibility transform's output. The current PowerShell policy rejects these forms rather than rewriting them.

### 9.5 Process-state corpus

Prove/document that ordinary calls do not persist:

- `cd`
- shell variable assignment
- exported environment variable
- function definition
- alias
- current umask if relevant

If future product behavior intentionally adds persistence, this test group becomes the contract migration alarm.

### 9.6 Failure quality

A reliability fix is incomplete if the only change is from "silent corruption" to "mysterious syntax error". For unsupported cross-dialect constructs, diagnostics should ideally name:

- actual shell,
- unsupported construct,
- safe alternative (`workdir`, temporary script, body file, argv execution, etc.).

---

## 10. Source ledger

### Shell specifications / authoritative docs

1. **GNU Bash Reference Manual — Here Documents / Redirections**  
   https://www.gnu.org/software/bash/manual/html_node/Redirections.html  
   Key use: quoted vs unquoted heredoc expansion; `<<-` tab stripping.

2. **POSIX.1-2024 Shell Command Language**  
   https://pubs.opengroup.org/onlinepubs/9799919799/utilities/V3_chap02.html  
   Key use: tokenization/quoting model; here-document semantics independent of Bash-specific extensions.

3. **Microsoft PowerShell — about_Quoting_Rules**  
   https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules?view=powershell-7.5  
   Key use: single/double quote behavior; here-string syntax and expansion; external-command quote removal.

4. **Microsoft PowerShell — about_Parsing**  
   https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing?view=powershell-7.5  
   Key use: expression vs argument mode; stop-parsing token; native-command argument behavior; PowerShell 7.3 changes.

5. **Microsoft — cmd.exe command-line string limitation**  
   https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/command-line-string-limitation  
   Key use: documented 8191-character cmd command/environment expansion limit.

6. **Node.js — child_process**  
   https://nodejs.org/api/child_process.html  
   Key use: shell-string execution vs direct process execution; `.bat`/`.cmd` Windows requirements and quoting.

7. **Python — subprocess security considerations**  
   https://docs.python.org/3/library/subprocess.html  
   Key use: metacharacters are ordinary data without a shell; once a shell is used, caller owns quoting; Windows batch-file caveat.

8. **GitHub Actions — workflow shell execution**  
   https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax  
   Key use: production precedent for writing `run:` content to shell-specific temporary script files and executing those files.

9. **ShellCheck SC2086**  
   https://www.shellcheck.net/wiki/SC2086  
   Key use: word splitting/globbing from unquoted shell expansion.

10. **BashFAQ/050**  
    https://mywiki.wooledge.org/BashFAQ/050  
    Key use: shell code strings are not argv arrays; arrays/functions are safer for composed commands.

11. **GNU Bash Reference Manual — `eval` builtin**  
    https://www.gnu.org/software/bash/manual/html_node/Bourne-Shell-Builtins.html  
    Key use: `eval` concatenates its arguments into a command, then reads and executes that command — an explicit second parse.

12. **BashFAQ/048 — eval command and security issues**  
    https://mywiki.wooledge.org/BashFAQ/048  
    Key use: practical explanation of double parsing and quote/expansion hazards around `eval`.

### Empirical coding-agent/tooling failures

These are issue reports and should be treated as empirical signals/reproduction seeds, not normative specifications.

13. **OpenAI Codex #20875 — tool-contract ambiguity / over-quoted shell operators**  
    https://github.com/openai/codex/issues/20875

14. **OpenAI Codex #41534 — Windows nested `pwsh -Command` quote corruption**  
    https://github.com/openai/codex/issues/41534

15. **OpenCode #15810 — Windows Git Bash/cmd silent command corruption**  
    https://github.com/anomalyco/opencode/issues/15810

16. **OpenCode #16479 — shell-aware Bash tool prompt request**  
    https://github.com/anomalyco/opencode/issues/16479

17. **OpenCode #42402 — Windows PowerShell 5.1 backtick guidance/native argv corruption**  
    https://github.com/anomalyco/opencode/issues/42402

18. **OpenCode #39884 — PowerShell backslash escapes corrupt user-facing CLI payloads**  
    https://github.com/anomalyco/opencode/issues/39884

19. **OpenCode #41426 / #38799 — configured shell vs actual bash-tool shell mismatch reports**  
    https://github.com/anomalyco/opencode/issues/41426  
    https://github.com/anomalyco/opencode/issues/38799

20. **Claude Code #83928 — Windows wrong-shell / quoting failure study**  
    https://github.com/anthropics/claude-code/issues/83928

21. **Claude Code #32563 — quoted heredoc damaged by outer tool transport**  
    https://github.com/anthropics/claude-code/issues/32563

22. **Claude Code #65162 — PowerShell here-string emitted into Bash tool**  
    https://github.com/anthropics/claude-code/issues/65162

23. **Claude Code #88561 / #89392 — Windows/Git-Bash backslash collapse reports**  
    https://github.com/anthropics/claude-code/issues/88561  
    https://github.com/anthropics/claude-code/issues/89392

24. **Claude Code #62813 — heredoc-in-command-substitution size/hang report**  
    https://github.com/anthropics/claude-code/issues/62813

25. **Claude Code #29619 — quote-dense Markdown CLI payload failures**  
    https://github.com/anthropics/claude-code/issues/29619

---

## 11. Patch-time decision gates

Before modifying runtime behavior, answer these with tests/source evidence rather than assumptions:

1. Which session paths currently materialize legacy tools vs V2/core tools in this fork, and can a user encounter both in normal product flows?
2. Should the legacy provider-visible ID remain `bash` until the 2.0 compatibility boundary, while prose calls it "shell"? What exact saved-permission/plugin compatibility would a rename break?
3. Can shell resolution/profile ownership be moved low enough that V1, V2, background, and PTY all consume one truth without violating location/global architecture contracts?
4. **Resolved for this slice:** custom/unknown wrapper executables remain launchable, but basename classification is fail-honest: unknown names advertise `dialect: unknown` and receive no invented shell-language recipe. Explicit dialect declaration/probing can be added later if the product needs first-class wrapper support.
5. Should multiline commands always go through temporary script files, or only above a complexity threshold?
6. Can we add a structured argv execution mode without bloating the default tool manifest/prompt-cache prefix?
7. For PowerShell stdin pipelines, what exact byte/encoding behavior do 5.1 and 7.x produce for ASCII, Unicode, CRLF, and NUL/control bytes? Existing unit assumptions need integration verification.
8. For Git Bash/MSYS, what canonical path representation should prose recommend and what, if anything, should runtime normalize automatically without changing literal data arguments?
9. How should permissions be represented if source text is transformed before execution? The user-approved/source command and exact executed command should be auditable together.
10. What is the desired behavior for unsupported unquoted Bash heredocs when actual shell is PowerShell: visible failure, model-facing validation error, or a semantics-preserving compatibility implementation?
11. Why does `Shell.args()` need `eval` for Bash/zsh today, and which startup/alias semantics would regress if session-shell execution instead used a script file or a single-parse wrapper?

---

## 12. Current working thesis

The likely robust endpoint is **not** a giant table of escape recipes in `shell.txt`.

It is a layered design:

1. **Truthful runtime profile** — model is told exactly what will execute the command.
2. **Minimal parse layers** — argv for data-oriented native execution; shell only for shell programs.
3. **Script-file transport for complex multiline shell programs** — avoid re-quoting an entire generated program through `-c`/`-Command`/`/c` when unnecessary.
4. **No silent semantic translators** — compatibility rewrites must prove semantic preservation or refuse the construct.
5. **One V1 launcher, one profile, one regression corpus** across foreground/background/monitor paths for this OpenFork campaign. V2 remains research/reference only here.
6. **Byte/argv-based tests** — exit code 0 is not proof of correctness.

That architecture directly targets the observed costly failure classes: wrong dialect, quote mangling, heredoc breakage, path corruption, and commands that appear successful while passing different bytes than the model intended.

---

## 13. Implementation ledger — 2026-09-17 transport slice

Scope remains **OpenFork V1 production tools** for this campaign. The V2/core provider-facing `bash` tool is not part of the patch surface; shared core utilities are changed only where a live V1 execution path consumes them.

### Completed and verified in this slice

- V1 foreground shell, detached shell, and background monitor execution converge on `src/tool/shell/launch.ts`, which owns the resolved execution profile and exact process launch plan.
- The provider contract now identifies host OS, actual interpreter, dialect, path environment, native-argument mode, SCRIPT STRING semantics, and fresh-process/non-persistent state.
- Unknown/custom wrapper executable names are classified as `dialect: unknown` instead of being silently described as POSIX. Their provider prose explicitly refuses to invent Bash/PowerShell/cmd syntax from a filename.
- The PowerShell launch plan is deliberately **non-translating**: permission/safety analysis always consumes the exact model-authored `sourceScript`. Short source is passed directly as the process script; oversized source may execute through a fixed transport bootstrap whose environment payload reconstructs that same source before the one intentional PowerShell parse. The bootstrap is transport, not a cross-dialect source rewrite.
- Bash heredocs are rejected on PowerShell rather than translated. Unquoted forms cannot preserve Bash expansion semantics; byte-level integration testing also disproved the quoted-form rewrite because the native PowerShell pipeline normalized the heredoc's trailing LF to CRLF. Bash `<<<` here-strings are likewise rejected instead of guessed at.
- Foreground shell and monitor paths preflight that launch plan before permission prompts, so deterministically unsupported compatibility syntax cannot ask the user to approve a command that will never be launched.
- Windows PowerShell 5.1 guidance no longer recommends generic backtick escaping for native argv. It documents legacy native marshalling and narrowly describes `--%` for static literal native arguments.
- cmd.exe inline script transport now fails closed above an 8000-character budget, leaving headroom below Microsoft's documented 8191-character command-line ceiling and steering large payloads to file/stdin transport instead of risking truncation/corruption.
- A new exact integration failure closed the cmd.exe multiline gate: inline `echo one\necho two` exited successfully while only `line-one` reached stdout. V1 now rejects CR/LF in inline cmd.exe programs before permission/execution and directs genuine multiline cmd programs to a temporary `.cmd` file. This is a fail-closed fix for silent partial execution, not a style preference.
- Exact argv sentinel coverage now exercises spaces, embedded quotes, trailing backslashes, literal `$HOME`, Unicode, empty arguments, shell metacharacters, percent-delimited data where the shell can preserve it, carets, and exclamation marks across the available Git Bash / PowerShell 7 / Windows PowerShell 5.1 / cmd.exe matrix. cmd.exe `%NAME%` remains explicitly documented as syntax even inside double quotes rather than pretending a quote recipe makes it arbitrary literal data.
- Ordinary shell calls are regression-tested to prove shell variables/state do not persist between invocations.
- PR-body examples no longer teach shell-generated multiline Markdown. They direct the model to the dedicated Write tool plus the target program's `--body-file` interface.

### Session-shell double-parse gate: closed 2026-09-18

`packages/core/src/shell.ts::args()` is consumed by the live V1 `SessionPrompt.shell` path. An earlier investigation left this gate open because the files were marked assume-unchanged. The current campaign deliberately cleared that index flag only for the two files it now owns, re-audited their diff, and closed the transport defect described in the canonical section below. No repository-wide index-flag rewrite was performed.

### Evidence / current validation state

- Earlier baseline Windows V1 shell matrix: **91/91 tests, 261 assertions** across Git Bash + PowerShell 7 + Windows PowerShell 5.1 + cmd.exe. This is a historical baseline, not the final expanded-corpus count below.
- Earlier focused profile/prompt/heredoc checkpoint: **32/32 tests, 52 assertions**. This is likewise superseded once the current expanded suite is rerun.
- Final expanded Windows V1 shell matrix after the cmd.exe fail-closed fixes: **110/110 tests, 307 assertions** across Git Bash + PowerShell 7 + Windows PowerShell 5.1 + cmd.exe.
- Focused launch/profile/prompt/PowerShell-stdin analyzer suite: **32/32 tests, 68 assertions**.
- Shared background/monitor runtime suite: **17/17 tests, 71 assertions**.
- The repository-wide typecheck remains independently red from the large concurrent worktree. The prior shell-local `ShellJob.Service.launch` unknown Effect-environment leak was removed architecturally by eliminating the unnecessary service requirement from that method's public interface rather than adding a cast. The latest opencode filtered check reports no shell-patch type diagnostic beyond the pre-existing tree-sitter WASM declaration/import-resolution errors; remaining diagnostics are elsewhere in the concurrent worktree.

### Remaining high-value gates

1. Expanded exact-argv Windows matrix is complete for this slice: **110/110, 307 assertions**. Future corpus additions should be driven by a reproduced transport failure rather than speculative escape recipes.
2. Intentional multiline shell programs are now covered across the available shell matrix and remain inline. Do not introduce automatic script-file transport merely because a command contains a newline; first demonstrate a byte/semantic failure that the transport would remove.
3. Git Bash Windows path forms are now exercised explicitly (`C:/...`, MSYS `/c/...`, and quoted literal Windows-path data arguments). Current policy is guidance, not runtime normalization: arbitrary arguments are never rewritten because a Windows-looking string may be literal data.
4. Keep the PowerShell Bash-stdin compatibility boundary non-transforming unless a future mechanism proves exact semantics/bytes. The prior quoted-heredoc transform is closed as a negative result: real Windows integration observed trailing-LF → CRLF normalization.
5. Keep permissions tied to the exact approved `sourceScript`. Do not equate source identity with process-bootstrap identity: Git Bash and oversized PowerShell deliberately use fixed transport bootstraps. `interpreterScript` names the exact source/bootstrap string handed to the selected interpreter. The invariant is **no semantics-changing source translation**, not source/bootstrap string identity.

The multiline gate is now shell-specific. A newline alone is **not** a script-file trigger for Bash/zsh/PowerShell; intentional multiline programs execute inline there. cmd.exe is the evidence-backed exception: real integration proved silent first-line-only execution, so inline multiline cmd programs fail closed and are steered to `.cmd` files. Automatic script-file fallback remains deferred; the runtime refuses the unsafe transport rather than silently changing lifecycle/cleanup/permission behavior.

### Cmd automatic-fallback gate: negative result

The remaining cmd refusal was re-opened after the PowerShell environment transport succeeded. Neither analogous fallback is semantics-preserving:

- **Automatic `.cmd` staging changes the command language.** A real Windows differential executed `echo zero=[%0] all=[%*] dir=[%~dp0]` inline and from an otherwise identical temporary batch file. Inline cmd left those batch-parameter forms literal; the staged file expanded `%0` to the temporary batch path and `%~dp0` to its temporary directory. Automatic file staging would therefore make transport implementation details observable to authored source.
- **Environment-source transport cannot bypass cmd's own limit.** Real child processes inherited 9k, 20k, and 32k test values, but `set <name>` exposed only an 8191-character result and normal `%VAR%` expansion did not reproduce the original value. A direct ~9k source expansion also exited **0 with no authored sentinel output**, and a two-line CRLF source exited **0 after executing only the first line**. Environment indirection therefore reproduces the same silent-success class instead of solving it. This matches Microsoft's documented 8191-character cmd command/expansion boundary even though modern Win32 environment blocks themselves may be much larger.

Therefore cmd remains deliberately fail-closed for multiline source and for source above the conservative 8000-character budget. A future automatic fallback needs a new mechanism-level proof of command semantics, stdin independence, exact text handling, cleanup, and permission/source identity; copying the PowerShell environment design or silently writing a `.cmd` file is not admissible. Provider guidance explicitly says rejected source is not auto-staged and that an explicit batch file opts into batch-file semantics.

Primary reference:

- https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/command-line-string-limitation — cmd.exe 8191-character command, inherited-variable, and expansion limits.

### Negative result: quoted Bash heredoc → PowerShell translation

The earlier compatibility translator is retired. A byte-level stdin sentinel against real Windows shells showed that a syntactically valid quoted Bash heredoc ending in LF did **not** survive the PowerShell native pipeline byte-for-byte: the trailing LF was normalized to CRLF. That falsifies the required semantics-preserving-transform invariant even before considering target-specific encoding behavior. The production boundary now only detects Bash heredoc / `<<<` syntax and fails closed with a file/native-syntax alternative; it does not rewrite model-authored shell text.
# 2026-09-18 EOL architecture alignment

The V1 shell campaign is explicitly subordinate to the repository-wide Git/EOL invariant in `docs/architecture/git-eol-policy.md`.

- Repository attributes own canonical checkout/materialization bytes; the shell launcher must not invent a competing newline policy.
- The shared `CrossSpawnSpawner` is the authoritative process owner for shell descendants, so foreground V1 shell, detached V1 shell, and monitor jobs inherit `GitRuntime.environment` without duplicating Git configuration in `ShellLaunch`.
- Dedicated Write/Edit/Patch own target-file mutation semantics and preserve intentional CRLF/mixed terminators. Shell transport is not a byte-preserving file-mutation API.
- Provider prose now states both halves of the invariant: OpenFork-owned Git defaults are deterministic LF materialization, while intentional target-file terminators remain mutation-tool concerns. It explicitly forbids using shell newline conversion or Git config mutation as a file-EOL repair mechanism.
- A V1 end-to-end shell regression now proves that Git invoked through every available configured shell resolves `core.autocrlf=false` and that an explicit later `git -c core.autocrlf=true` still wins. This complements the lower-level CrossSpawnSpawner real-worktree byte PoC rather than duplicating it.
- The existing PowerShell heredoc refusal is consistent with this architecture: exact multiline bytes go through file/mutation or explicit stdin/file interfaces, not a lossy cross-dialect text rewrite.
- Performance invariant: no per-command Git probe, version lookup, file scan, or EOL scan was added. Git policy remains one environment-boundary merge in the shared spawner; shell profile/plan remains pure O(command length) validation only where syntax requires it.

Verification after alignment: shell prompt 8/8, launch 16/16, full V1 shell 114/114 (323 assertions). The background suite remains 16/17 with the pre-existing/concurrent custom-id collision test timing out at its fixed 5s deadline even in isolation; all shell-profile/heredoc/monitor execution tests pass.

## Session shell bootstrap transport

The remaining V1 `SessionPrompt.shell -> Shell.invocation()` Bash/zsh boundary was hardened without changing the user-command language or startup behavior.

Previously the complete command was serialized with `JSON.stringify(command)` and interpolated into the outer login-shell bootstrap as `eval <serialized source>`. That made command bytes part of two shell source layers before the intended evaluation.

The bootstrap now receives the command as an opaque positional argument. It copies `$2` into a private source variable, restores the historical positional-parameter contract with `set -- "$1"`, and evaluates the source exactly once at the intended command-language boundary. The working directory remains `$1`; therefore existing commands that inspect `$#`/`$1` do not gain a transport-only argument.

Regression coverage proves:

- the command text is absent from the bootstrap program itself;
- quote-sensitive literals survive the boundary (`$HOME`, command-substitution syntax, quotes, backslashes);
- the transport argument is not observable as a new positional parameter by the executed command;
- Bash/zsh startup and alias-loading behavior remains owned by the existing bootstrap rather than being removed as an unrelated behavioral rewrite.

This removes the avoidable source interpolation layer while retaining one deliberate `eval`: a shell script string necessarily needs to be parsed as shell source. The invariant is now "opaque transport, one intentional source parse," not "eliminate eval regardless of semantics."

## External harness cross-check (2026-09-18, initial pass)

The V1 execution contract was cross-checked against current public implementations rather than treating OpenFork's design as self-validating.

### OpenAI Codex

Current Codex `Shell::derive_exec_args()` explicitly lowers a shell script string to an executable argv vector: Bash/zsh/sh use `[shell, -c|-lc, command]`, PowerShell uses `[shell, -NoProfile?, -Command, command]`, and cmd uses `[shell, /c, command]`. Its exec-server protocol likewise represents process starts as an explicit `argv` array (example: `["bash", "-lc", "..."]`). Sources:

- https://github.com/openai/codex/blob/main/codex-rs/core/src/shell.rs
- https://github.com/openai/codex/blob/main/codex-rs/exec-server/README.md

OpenFork now follows the same important transport invariant for known V1 dialects: resolve the interpreter first, then invoke that executable directly with the script in a dedicated interpreter argument. It does not ask the process library to synthesize another shell wrapper around Bash/zsh/POSIX commands.

Codex also parses the inner command of `bash -lc`/`zsh -lc` explicitly for policy analysis rather than pretending the outer wrapper argv is the user command. OpenFork's corresponding invariant remains source-script permission analysis before `ShellLaunch` execution. Source:

- https://github.com/openai/codex/blob/main/codex-rs/shell-command/src/parse_command.rs

### Gemini CLI

Gemini documents the same direct interpreter model: Windows executes through `powershell.exe -NoProfile -Command`; Unix-like hosts execute through `bash -c`. Its shell utility returns `{ executable, argsPrefix }` rather than a generic `shell: true` transport. Sources:

- https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/shell.md
- https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/shell-utils.ts

OpenFork deliberately goes slightly stricter for PowerShell automation by adding `-NoLogo -NonInteractive`. Both V1 cmd execution paths retain Node/cross-spawn's tested cmd shell adapter because a direct-cmd argv experiment changed quote-sensitive native-argument behavior. `Shell.invocation()` is the authoritative core contract; the retained `Shell.args()` compatibility accessor fails closed whenever a shell adapter or source-environment transport would be lost.

### Claude Code / eval caution

A current Claude Code issue reports the harness using a `bash -c "source <snapshot> && eval '<command>'"`-style path and describes variable-expansion failures around piped commands. This is issue evidence rather than a normative specification, but it reinforces why OpenFork no longer interpolates command source into its Bash/zsh bootstrap. OpenFork transports the source opaquely as an argv element and retains only the one parse required to execute it after startup initialization.

- https://github.com/anthropics/claude-code/issues/33693

### VS Code shell integration

VS Code is an interactive-terminal harness rather than a one-shot agent shell, so its startup injection architecture should not be copied wholesale. It is still useful corroboration for two principles: shell-specific initialization is explicit, and exact command text is treated as protocol data that needs careful escaping/transport. VS Code also documents supported shell differences rather than assuming one universal shell language.

- https://github.com/microsoft/vscode/blob/main/src/vs/workbench/contrib/terminal/common/scripts/shellIntegration-bash.sh
- https://github.com/microsoft/vscode-docs/blob/main/docs/terminal/shell-integration.md

### Windows length boundaries

Microsoft documents two different limits that justify keeping OpenFork's cmd and direct-process cases conceptually separate: `cmd.exe` has an 8191-character command-line limit, while Win32 `CreateProcess` allows 32,767 characters. OpenFork reproduced a distinct ~8 KiB corruption boundary through the Git-for-Windows/MSYS argv bridge even after direct `bash.exe -c` invocation. That finding remains the reason source must not cross the MSYS argv bridge, but it is **not** a current source-size ceiling: the environment-backed MSYS transport now keeps authored source out of argv and has passed 20k/25k/100k-class source tests.

- https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/command-line-string-limitation
- https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-createprocessw

### Resulting V1 harness invariant

For known POSIX-family shells and short PowerShell source, the architecture converges with Codex and Gemini on `resolved executable + explicit interpreter argv + opaque command argument`. Windows Git Bash/MSYS and oversized PowerShell source use measured environment-backed transports so authored source does not cross unsafe argv boundaries. cmd.exe remains the evidence-backed Node/cross-spawn exception described below. Script-file/body-file guidance remains the fallback when no proven transport can preserve the requested source/bytes. No per-command probing or filesystem staging was introduced on the normal fast path.

## External harness cross-check — 2026-09-18 canonical pass

The implementation was compared against current production/open-source harnesses and upstream shell specifications rather than treated as an OpenFork-only design.

### OpenAI Codex

Sources:

- https://github.com/openai/codex/blob/main/codex-rs/core/src/shell.rs
- https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/unified_exec.rs
- https://github.com/openai/codex/issues/20875

Codex models `exec_command.cmd` as a shell-script string and lowers known shells explicitly as `[shell, -c/-lc, command]` (PowerShell uses `-Command`, cmd uses `/c`). It does not first interpolate the model command into another shell source string. The public issue corpus separately identifies script-string-vs-argv ambiguity and redundant nested shells as a model-contract failure class.

OpenFork alignment:

- the V1 schema explicitly says SCRIPT STRING, not argv;
- same-shell nesting is discouraged in provider prose;
- known POSIX interpreters now use direct `shell -c <opaque argument>` lowering rather than Node's implicit `shell` option;
- the V1 session bootstrap passes its command as an opaque positional argument before the one intentional eval required to execute source in the already-initialized login shell.

### Google Gemini CLI

Sources:

- https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/shell.md
- https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/shell-utils.ts

Gemini likewise exposes a required string `command`, executes Unix through `bash -c`, and uses PowerShell `-NoProfile -Command` on Windows. It keeps shell identity/dialect first-class rather than pretending every host uses Bash.

OpenFork alignment:

- dynamic runtime profile reports the actual interpreter/dialect;
- PowerShell is a first-class launch shape rather than Bash syntax translated into PowerShell;
- known POSIX execution now mirrors explicit `-c` lowering.

### GitHub Actions runner

Sources:

- https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- https://github.com/actions/runner/blob/main/src/Runner.Worker/Handlers/ScriptHandler.cs
- https://github.com/actions/runner/blob/main/docs/adrs/0277-run-action-shell-options.md

Actions takes the more conservative transport: `run:` content is written to a temporary shell-specific script and the interpreter executes that file. This eliminates the outer `-c` quoting/length layer at the cost of a file write per step. Actions also treats cmd/PowerShell/Bash as distinct execution contracts.

OpenFork decision:

- do **not** pay a temporary-file write for every short agent shell call;
- use direct opaque `-c`/PowerShell execution on the hot path;
- switch to a proven opaque transport before empirically unsafe Windows argv boundaries where semantics can be preserved without filesystem staging;
- fail closed, using explicit script/body files when appropriate, where no such transport is proved (notably cmd multiline/oversized source and Bash-heredoc compatibility under PowerShell).

This preserves the performance contract while matching the same correctness principle: complex data should stop crossing extra shell-quoting layers.

### Node / cross-spawn transport exception

Node documents `spawn()` with `shell: false` as the default and treats `shell` as an explicit extra shell layer. It also applies cmd-specific Windows argument behavior when a shell is selected. OpenFork therefore uses direct interpreter argv for known POSIX-family shells and PowerShell, but does not assume Codex's Rust cmd lowering is byte-for-byte equivalent under Node/libuv/cross-spawn.

A direct model-facing cmd experiment with `cmd.exe /d /e:on /v:off /s /c <script>` broke the existing quote-sensitive native-argv sentinel while the tested Node shell adapter passed it. The experiment was reverted rather than weakening the oracle. cmd remains fail-closed for multiline and oversized source; a future automatic fallback should use a temporary `.cmd` file instead of adding quote recipes.

Source:

- https://nodejs.org/api/child_process.html

### Anthropic / Claude

Sources:

- https://platform.claude.com/docs/en/agents-and-tools/tool-use/bash-tool
- https://github.com/anthropics/claude-code/issues/32563
- https://github.com/anthropics/claude-code/issues/85111
- https://github.com/anthropics/claude-code/issues/88561

Anthropic's public Bash tool intentionally uses a persistent client-owned Bash process, which is a different product semantic from OpenFork's fresh-process V1 shell contract. The useful commonality is that the model emits a shell command string and the harness owns transport/process lifetime. Claude Code's Windows issue corpus is especially valuable negative evidence: outer quoting has broken quoted heredocs, backslashes have been silently collapsed in Git Bash transport, and command strings around ~8 KiB have been silently truncated while still producing misleading/successful outcomes.

OpenFork result:

- do not copy Claude's persistence semantics into V1;
- do copy the lesson that source bytes must not be reconstructed through an extra quote layer;
- exact argv/byte sentinels remain required;
- direct `C:\\Program Files\\Git\\bin\\bash.exe -c <script>` testing independently reproduced an MSYS argv boundary: payloads around 8.0–8.15 KiB succeeded, while roughly 8.18 KiB and above arrived garbled/truncated enough for Bash to report an unmatched quote. This happened with direct executable invocation, so the defect is not attributed to cmd.exe or Node's generic shell wrapper;
- Windows Git Bash/MSYS no longer sends authored source through that bridge. A fixed bootstrap travels in argv while the source travels in the reserved, MSYS-conversion-excluded `OPENCODE_INTERNAL_SHELL_SOURCE` environment value, is copied/unset before execution, and is parsed once by Bash. This removes the old ~8 KiB argv ceiling while preserving stdin. cmd.exe remains the separate conservative 8,000-character fail-closed case.

### Specifications backing the harness decisions

- GNU Bash here-doc and positional-parameter semantics:
  https://www.gnu.org/software/bash/manual/bash.html
- Microsoft PowerShell parsing/native argument behavior:
  https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_parsing
- Microsoft cmd.exe 8191-character limit:
  https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/command-line-string-limitation
- Node child-process shell contract:
  https://nodejs.org/api/child_process.html
- Git runtime config precedence:
  https://git-scm.com/docs/git-config
- Git repository EOL attributes:
  https://git-scm.com/docs/gitattributes

### Cross-harness conclusion

OpenFork should not imitate any one harness wholesale. Codex/Gemini validate the explicit interpreter + opaque command-argument hot path; GitHub Actions validates script-file transport as the robust complex-script fallback; Claude's public/issue behavior supplies adversarial evidence for persistence, quoting, heredoc, backslash, and Windows-length hazards.

The resulting OpenFork rule is narrower and evidence-based:

1. keep the tool contract explicitly script-shaped;
2. resolve and advertise the actual interpreter;
3. invoke known interpreters explicitly instead of asking a generic subprocess helper to synthesize another shell layer;
4. never cross-translate shell languages unless semantics and bytes are proved;
5. preserve repository/mutation EOL ownership separately from shell source transport;
6. reject empirically unsafe inline forms before permission/execution;
7. move source across a measured opaque transport—or to an explicit file when no semantics-preserving transport exists—rather than growing escaping recipes;
8. test exact argv/stdin/file bytes and negative failure behavior, not only exit codes.

## 2026-09-18 SessionPrompt.shell / Shell.invocation transport repair (canonical)

The V1 user-shell path had a distinct quote-corruption boundary outside the model-facing shell tool:

`SessionPrompt.shellImpl -> Shell.preferred -> Shell.invocation -> ChildProcessSpawner`.

For Bash and zsh, the predecessor to `Shell.invocation` interpolated the user command into a bootstrap program using `JSON.stringify(command)`, then executed `eval <that embedded string>`. This created two shell parsing opportunities:

1. the bootstrap shell parsed the JavaScript/JSON-derived double-quoted representation, where shell expansions such as `$HOME` and `$(...)` were still meaningful;
2. `eval` parsed the resulting text again as the intended command.

JavaScript JSON string escaping is not a shell quoting primitive. A command whose source intentionally single-quotes `'$HOME'` can therefore be changed before the intended parse because those single quotes are merely characters inside the bootstrap's outer double-quoted string. The same class applies to command substitutions and backslash/quote combinations.

The repair retains the startup behavior that motivated the bootstrap (login shell, rc loading, Bash alias expansion, and explicit cwd) while removing command interpolation. On native POSIX hosts the command is an opaque process argument: the bootstrap copies `$2` into an internal transport variable, restores the historical positional-parameter surface to only `$1 = cwd`, and only then invokes `eval`. On Windows/MSYS the later environment transport supersedes `$2` so authored source never crosses the defective MSYS argv bridge.

```
bash -l -c '<fixed bootstrap; cd -- "$1"; source=$2; set -- "$1"; eval "$source">' opencode <cwd> <command>
```

The fixed bootstrap is parsed once. Transport initially maps `opencode`, cwd, and command to `$0`, `$1`, and `$2`. Before executing user source, `set -- "$1"` restores the historical command-visible positional state (`$# == 1`, `$1 == cwd`, `$2` unset). This second step is essential: a naive `eval "$2"` transport fixes quote corruption but leaks the transport argument into the user's `$#`, `$2`, and `$@`, creating a subtler semantic regression. The internal source variable is intentionally obscure and non-exported; unlike a function wrapper, it does not change top-level `return`, traps, or execution scope.

This deliberately does **not** remove `eval` mechanically. The input is shell source and therefore must be parsed by the selected shell somewhere; the defect was the accidental *extra* parse caused by source interpolation. Replacing this with a temporary script would add filesystem I/O, cleanup/failure state, and another artifact lifecycle without improving the single-parse property for this path.

Regression coverage now asserts both structure and behavior:

- Bash/zsh bootstrap source cannot contain the user command.
- cwd and command occupy distinct positional arguments.
- a real Git Bash execution preserves literal `$HOME`, literal `$(printf nested)`, embedded double quotes, and backslashes exactly according to the source command's own quoting.
- a real Git Bash execution proves the user command still observes the historical positional contract: `$# == 1`, `$1 == cwd`, and `$2` is unset.
- the core shell suite contains direct behavioral coverage for both positional and Windows environment-backed source transports, including stdin availability, case-insensitive environment-key handling, size boundaries, and cmd/PowerShell invocation regressions.

Performance impact is effectively neutral-to-positive: no temp file, no additional process, no probe, and no filesystem operation were introduced. The command moves from bytes embedded in the bootstrap argv element to its own argv element; the bootstrap becomes fixed-size. The only added shell work is one scalar assignment plus `set -- "$1"`, both constant-time relative to command execution. This also preserves the EOL architecture: multiline command bytes remain argv data until the intentional shell parse, with no generated text file or newline conversion layer.

## PowerShell large-source environment transport — 2026-09-18 canonical

The remaining Windows PowerShell ceiling was re-opened from first principles. Real Windows testing established that `pwsh -Command <source>` remains healthy through roughly 32,000 source characters in the current launch shape, while process creation fails around 32,700 with `ENAMETOOLONG`; 33k/40k/100k fail likewise. `POWERSHELL_INLINE_SCRIPT_LIMIT = 30_000` is therefore retained as a **transport-switch threshold**, not a user-source refusal limit. JavaScript `.length` is the relevant UTF-16-code-unit measure for this boundary.

### Rejected alternatives

- `-Command -` / `-File -` consume standard input. PowerShell documents those forms as reading command text from stdin, so they cannot preserve the shell tool's independent authored stdin channel.
- `-EncodedCommand` is still argv transport and PowerShell requires its payload to be Base64 of UTF-16LE bytes. Encoding expands the command-line payload rather than removing the native boundary.
- Direct `-File <temp.ps1>` worked in a >100k PoC under both runtimes but is not semantics-neutral: it introduces filesystem lifecycle/I/O, script identity (`$PSScriptRoot` / `$PSCommandPath` / `$MyInvocation`) and execution-policy behavior that direct `-Command` does not have.
- One giant environment value is not acceptable. Microsoft documents 32,767 characters as the maximum size of a user-defined environment variable.

Sources:

- https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh?view=powershell-7.5
- https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1
- https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables

### Admitted transport

For Windows PowerShell source above 30,000 UTF-16 code units:

1. authored source is split into private environment values capped at 24,000 UTF-16 code units each, with a surrogate-pair boundary guard;
2. each entry is named under `OPENCODE_INTERNAL_POWERSHELL_SOURCE_4F73B6A1_####`;
3. argv carries only the ordinary automation prefix plus a small bootstrap;
4. the bootstrap reconstructs the string with an array + `String.Concat` inside a child scope, removing every transport entry through PowerShell's `Env:` provider before authored code runs;
5. outer-scope `Invoke-Expression` performs the one intentional PowerShell parse. Microsoft documents `Invoke-Expression` as evaluating in the current scope;
6. ordinary stdin is untouched.

Microsoft documents that, starting with Windows Vista / Server 2008, there is no technical limit on the total environment-block size even though each user-defined variable is capped at 32,767 characters. The 24k chunk size stays well inside the per-variable contract while avoiding the Win32 command-line boundary entirely.

Sources:

- https://learn.microsoft.com/en-us/windows/win32/procthread/environment-variables
- https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/invoke-expression?view=powershell-7.5

### Byte/semantic proof

The environment transport was exercised on the real Windows host against both PowerShell 7 (`pwsh.exe`) and Windows PowerShell 5.1 (`powershell.exe`):

- 32k, 100k, and 500k-class valid source executed successfully;
- reconstructed source matched the original across CRLF/LF, Unicode (`雪`, `☃`, emoji/surrogate pairs), quotes, backticks, doubled backslashes, path-looking text, and literal `$` data;
- stdin remained independently readable by authored source;
- direct `-Command` and environment transport matched for top-level `return`, `exit`, terminating `throw`, `param`, `using namespace`, `$args`, `$MyInvocation.Line`, `$MyInvocation.InvocationName`, `$PSScriptRoot`, and `$PSCommandPath` in the exercised corpus;
- the existing quote-sensitive native-argv sentinel passes through the >30k environment path on both runtimes;
- PowerShell 7 exposed a transport entry when it was cleared only through the .NET environment API, so the production bootstrap now removes entries via `Env:`; the regression asserts no reserved source entries are visible to authored code;
- actual NUL source remains rejected before permission in the provider shell and before durable turn admission in `SessionPrompt.shell`.

An adversarial post-closeout probe found one integrity gap in the first chunked implementation: if an expected environment chunk disappeared before reconstruction, PowerShell's `[String]::Concat` treated the missing value as empty. A crafted three-chunk source therefore reconstructed into a shorter but still valid program, printed its sentinel, and exited 0. The transport now verifies each expected `Env:` entry exists and verifies the reconstructed UTF-16 length before returning source to outer-scope `Invoke-Expression`. Missing/truncated transport therefore fails closed before authored code executes. The regression deliberately deletes a middle chunk and asserts non-zero exit plus absence of the authored sentinel on both available PowerShell runtimes.

Foreground/background/monitor execution receives this behavior from the shared `ShellLaunch`; the user-shell path receives the same mechanism from core `Shell.invocation()`. `Shell.args()` remains argv-only compatibility and refuses metadata-bearing transports instead of silently dropping their environment contract.

### Performance / EOL consequence

The normal PowerShell hot path (<=30k) is unchanged: no probe, no file, no extra process, and direct `-Command` argv. The large-source path performs linear source chunking and one environment copy at launch, then linear reconstruction with `String.Concat`; it adds no filesystem lifecycle, watcher, timer, or background resource. Shell-source transport remains separate from repository materialization and mutation EOL policy: no source file is generated, and `.gitattributes` / GitRuntime / Write/Edit/Patch retain their existing ownership.

### SessionPrompt inherited-environment audit

A final ownership audit found one subtle difference between `ShellLaunch` and the user-shell path. `SessionPrompt.shell` had already applied `Shell.withSourceEnvironment(...)`, but then created the Effect child with `extendEnv: true`. `CrossSpawnSpawner` intentionally implements that option by merging `process.env` at the process boundary. A stale environment entry under the reserved PowerShell source prefix could therefore be removed from the explicit child map and then reintroduced from the parent environment after transport sanitization.

The user-shell path now materializes its intended inherited environment exactly once (`process.env`, then plugin overrides, then `TERM=dumb`), applies `withSourceEnvironment` to that complete map, and spawns with `extendEnv: false`. This preserves the prior inheritance/override semantics while making the transport sanitizer the final environment owner. The regression seeds an unrelated stale high-index `OPENCODE_INTERNAL_POWERSHELL_SOURCE_4F73B6A1_9999` entry in `process.env`, executes >30k PowerShell source, and verifies authored code sees no reserved transport entries. NUL source still fails before any durable shell turn is admitted.

## 2026-09-18 validation closure and background teardown ownership

The final V1 validation pass found one real lifecycle bug outside quote/escape transport and one test-lifecycle leak. Both were investigated rather than hidden behind larger test timeouts.

### Background kill: one process lifecycle owner

`background action=kill` previously performed two independent teardown actions for the same running shell job:

1. `BackgroundJob.cancel(id)` marked the job cancelled and asynchronously closed the job-owned scope; that scope owns the `CrossSpawnSpawner` child and therefore already terminates the process in its finalizer.
2. The tool then called `entry.handle.kill(...)` directly on the same process.

On Windows this reproduced as a deterministic hang after `BackgroundJob.cancel()` had already returned. A raw process-level PoC showed `taskkill /T /F` itself was healthy (~1.8 ms-to-seconds scale on the measured host, with process close following normally); phase tracing then proved the stall occurred specifically at the second direct `handle.kill()`. The two teardown paths were racing the same process tree / close signal.

The V1 background kill path now follows the repository ownership invariant:

- when a live `BackgroundJob` row owns the process, kill transitions it to `cancelled` and lets that scope be the **single** process-teardown owner;
- monitor delivery is detached before cancellation so explicit monitor kill cannot wake the model;
- direct `handle.kill()` remains only as a bounded defensive fallback for the orphan state where a live `ShellJobs` handle exists but no `BackgroundJob` owner exists.

The isolated regression returned to the normal 5-second harness budget (measured ~2.95 s cold and ~0.65-0.76 s warm/full-suite) without relaxing the timeout.

### Background collision test ownership leak

The remaining `custom id collisions are rejected` timeout was a separate test defect. All original assertions completed, but the test successfully launched custom job `bg2` and left the instance scope while that background process was still live. Fixture teardown then paid process cleanup and hit the fixed test deadline.

The test now explicitly waits for the successful `bg2` job after completing the collision assertions. This makes the test own the process it starts and keeps collision semantics independent from instance-disposal latency.

### Final V1 execution-path audit

The current model-authored shell-source paths are intentionally limited to two execution contracts:

- **Provider-facing V1 shell / detached shell / monitor / custom `!\`...\`` expansion:** resolve the shell, preflight with the canonical launch plan, then execute through `ShellLaunch.command`. Foreground, detached/background, and monitor therefore share dialect validation, PowerShell policy, cmd policy, and Git Bash/MSYS source transport.
- **`SessionPrompt.shell`:** resolve the configured/preferred user shell, lower through `Shell.invocation`, materialize inherited/plugin environment once, apply source-transport environment ownership, then spawn without a second inherited-environment merge. This remains a distinct login-shell contract because it intentionally preserves startup/alias behavior, but its Windows limits and source transports are shared Core primitives rather than a second quoting implementation.

The remaining direct `ChildProcess.make` use in the V1 shell tool for `cygpath` is a fixed helper program with the path passed as a positional argument; it is not another model-authored shell-source transport. No additional V1 path was found independently lowering provider/user shell source with its own `-Command`, `/c`, or quote-reconstruction recipe.

A post-closeout cross-platform audit found one remaining known-interpreter drift: provider-facing `pwsh` on POSIX hosts fell through the generic Node `shell:` adapter even though the V1 session-shell path already invoked PowerShell explicitly. Microsoft documents the same `pwsh -NoLogo -NoProfile -NonInteractive -Command <string>` CLI on Linux/macOS, so the provider launcher now invokes known PowerShell directly on every platform; only the >30k environment-source fallback remains Windows-specific. This removes an unnecessary shell-adapter layer and restores foreground/session parity.

The same audit clarified custom/unknown wrapper semantics. Node's documented custom-shell contract requires `-c` on POSIX and cmd-compatible `/d /s /c` parsing on Windows; an arbitrary executable is not an opaque custom-shell protocol. `ExecutionProfile` therefore exposes `invocationProtocol` as a first-class fact, both shell and monitor descriptions render it from the same profile, and unknown-wrapper guidance states the host-adapter requirement rather than implying arbitrary wrapper argv semantics.

Primary references:

- https://nodejs.org/api/child_process.html — custom shell requirements and platform adapter contract.
- https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_pwsh — cross-platform `pwsh` CLI options including `-Command`, `-NoLogo`, `-NoProfile`, and `-NonInteractive`.

### Final regression results

- `packages/opencode/test/tool/shell.test.ts`: **125/125 passed, 345 assertions** across Git Bash, PowerShell 7, Windows PowerShell 5.1, and cmd.exe, including the formerly silent oversized inherited-variable expansion.
- `packages/opencode/test/tool/background.test.ts`: **23/23 passed, 81 assertions**, including >30k PowerShell source through both detached and monitor execution on PowerShell 7 and Windows PowerShell 5.1 plus shared invocation-protocol truth.
- `packages/core/test/shell.test.ts`: **33/33 passed, 114 assertions**, including missing-chunk and reconstructed-length fail-closed PowerShell transport integrity checks, raw Windows case-collision parity, and the cmd inherited-environment validator.
- `packages/core/test/process-environment.test.ts` + `git-runtime.test.ts` + `shell.test.ts`: **44/44 passed, 154 assertions** as the combined lower-level process/environment/Git/shell boundary suite; the real cmd oracle is included in this count.
- `packages/opencode/test/tool/shell-launch.test.ts` + `shell-prompt.test.ts`: **33/33 passed, 114 assertions**, including the POSIX-PowerShell direct-invocation contract, explicit invocation-protocol truth, cmd no-auto-stage guidance, and the inherited-expansion refusal contract.
- fresh focused `SessionPrompt.shell` + custom `!\`...\`` expansion/lifecycle selection on Windows: **13 passed, 11 platform/fixture skips, 0 failed, 38 assertions**. This includes configured cmd execution, cmd multiline pre-admission refusal, lossy inherited-expansion refusal before process execution, 100k Git Bash source, oversized PowerShell source, busy/queue lifecycle, and large custom-command expansion transport.
- `packages/opencode/test/util/javascript-runtime.test.ts`: **14/14 passed, 21 assertions**, including Windows case-insensitive user-shell overrides and differently-cased explicit `ELECTRON_RUN_AS_NODE` opt-in.
- relevant diff whitespace gate: `git diff --check` **passed**.
- native Windows x64 production build with `--single --skip-install --skip-embed-web-ui`: **passed**; binary `--version` smoke passed and bundled ChunkDB capability smoke reported `user_version 4`.

Package-native typechecks remain red from unrelated concurrent work. The final scoped Core check reports only test-host Bun typing/import resolution plus an unrelated LLM `TextDecoder` diagnostic; none originates in `process-environment.ts`, `git-runtime.ts`, or production shell transport. The scoped OpenCode check reports the existing Tree-sitter WASM declaration/import misses on `src/tool/shell.ts` plus unrelated control-plane/sync, SPAD, archive typing, image WASM, and server diagnostics. No new V1 shell/background/session/environment production type diagnostic surfaced.

### Performance closure

No runtime shell/version probe, filesystem scan, temp-file staging, or extra process was added to the normal V1 hot path. A local microbenchmark of pure launch planning / command-object construction measured:

| Operation | Iterations | Measured cost |
|---|---:|---:|
| PowerShell short `ShellLaunch.plan` | 100,000 | ~1.32 µs/op |
| PowerShell short `ShellLaunch.command` | 20,000 | ~1.54 µs/op |
| Git Bash short `ShellLaunch.plan` | 100,000 | ~0.53 µs/op |
| Git Bash short `ShellLaunch.command` | 20,000 | ~104.8 µs/op |
| Git Bash 25k-source `ShellLaunch.plan` | 10,000 | ~1.86 µs/op |
| cmd `validateInvocationEnvironment`, 127-key env | 200,000 | ~14.1 µs/op |
| Windows `ProcessEnvironment.merge`, 127 base + 3 overrides | 200,000 | ~23.7 µs/op |

The Git Bash command-construction cost is dominated by the intentional one-pass environment copy/canonicalization required to insert opaque source and protect it from MSYS environment conversion. The cmd validator and shared environment merge are likewise linear, allocation-bounded, and perform no I/O. `ProcessEnvironment.merge` replaces GitRuntime's previous O(E) environment merge rather than adding another process-boundary pass there. All measured costs remain negligible beside real Windows process startup.

The closing architecture is therefore: **one truthful shell profile, one provider-facing launcher, one host-semantics-aware environment composer, one generic pre-spawn environment validator, one session-shell invocation contract sharing the same transport primitives, one owner per background process lifecycle, and exact byte/argv/environment/state regressions at every boundary that previously corrupted or hung.**

### Post-closure cmd fallback and inherited-expansion falsification

The remaining cmd fail-closed boundary was reopened experimentally rather than accepted by assumption. Two apparent automatic fallbacks were falsified on the real Windows host:

- **Temporary `.cmd` staging is not transparent.** Inline `%0`, `%1`, `%*`, and `%~dp0` remain literal under the current command-string contract, while an otherwise identical generated batch file populates them from the temporary batch path/arguments and adds batch execution context. Automatic staging therefore changes observable program semantics.
- **Environment-backed cmd source is not an opaque large-source transport.** Cmd's own 8191-character expansion boundary remains in force; source indirection reproduces the same silent-success class rather than removing it.

A subsequent boundary sweep exposed a distinct hole that the 8000-character **source** guard could not catch. A short cmd conditional was executed while one inherited environment value varied from 7k through 9k characters. Values through roughly 8100 expanded normally; near the total command boundary cmd failed visibly with `The input line is too long.`; at **8192+ characters** the same `%NAME%` expansion was silently observed as empty and the command exited **0 on the wrong branch**. A native child launched through the same cmd process still received the oversized value intact when the command string did not expand it, proving that globally rejecting large environment values would be unnecessarily broad.

Core therefore owns the generic pre-spawn boundary `Shell.validateInvocationEnvironment(file, command, env)`. Callers do not learn cmd-specific transport quirks. The current Windows/cmd rule performs one O(environment-size) pass to index only values above the documented 8191-character inherited-variable limit, then one O(source-size) scan of percent-delimited expansions. It rejects only a referenced oversized variable, including modifier forms whose variable name precedes `:` such as `%VAR:~0,10%` and `%VAR:a=b%`. Oversized values that are merely inherited remain legal for native children. Future interpreter-specific environment/source invariants belong behind the same Core boundary rather than at V1 call sites.

The validator runs at the **effective-environment ownership boundary**, after plugin/user environment composition. V1 foreground/background shell and event monitor execution validate the final child environment before launch; `ShellLaunch.command` retains the same Core invariant as defense in depth for callers that construct commands directly. `SessionPrompt.shell` deliberately resolves arbitrary `shell.env` plugin code only **after** its durable shell-turn readiness barrier opens: `Runner.stopShell()` waits for that barrier before interrupting so recovery has a durable turn to target, and moving a potentially hanging plugin hook ahead of it would make cancellation wait behind plugin code. Once ready, the session path materializes and sanitizes one complete child-environment snapshot, validates it, and spawns exactly that snapshot with `extendEnv: false`. Plugin/runtime-phase refusal may therefore be recorded on the admitted shell operation, but the unsafe process is never launched and validation/execution cannot observe different environment merges.

The end-to-end V1 tool and distinct `SessionPrompt.shell` regressions seed an 8192-character inherited value and execute the exact conditional that previously selected `SILENT-WRONG-BRANCH`; both paths must fail explicitly instead of spawning cmd.

The expansion work also exposed a lower-level Windows environment-composition bug. JavaScript object spread is case-sensitive, while Windows environment names are not. A real cmd oracle with both `OPENFORK_CASE_PROBE` and `openfork_case_probe` proved that the first logical entry is what the process boundary observes; merely appending a differently-cased override does **not** override it. This could make a plugin/user override disagree with the environment the validator believed it had constructed.

Core now owns `ProcessEnvironment.merge(base, overrides, platform)` as the single host-semantics-aware composition primitive. On Windows it canonicalizes logical names case-insensitively, preserves the first logical value of an already-ambiguous inherited map (matching the measured process boundary), and lets later **explicit overrides** replace that inherited casing/value deterministically. POSIX remains case-sensitive. `GitRuntime.environment` now reuses this primitive instead of maintaining a private copy of the same rule; `userChildEnvironment`, foreground shell, background/monitor shell, and `SessionPrompt.shell` therefore converge on the same Windows override semantics. This also standardizes stripping/explicit opt-in of host-only `ELECTRON_RUN_AS_NODE` across the shell execution surfaces.

The defense-in-depth cmd validator independently interprets an uncanonicalized Windows map with the same measured first-logical-entry rule, so a direct caller that bypasses `ProcessEnvironment.merge` still cannot make validation disagree with cmd. Regression coverage includes pure cross-platform merge semantics, differently-cased explicit override replacement, ambiguous inherited maps, GitRuntime's existing casing contract, user-shell environment hooks, and a real cmd expansion oracle.

This leaves cmd deliberately fail-closed for multiline source, oversized source, and semantically lossy inherited `%NAME%` expansion. A future automatic transport must prove source semantics, environment semantics, stdin independence, exact bytes, permission identity, and cleanup together; neither `.cmd` staging nor environment indirection satisfies that bar.

The added validator is deliberately O(E + S) only on cmd execution, with no I/O and no extra process. A local 200,000-iteration hot-path benchmark over a 127-entry environment measured ~14.1 µs/call. PowerShell/Bash paths return before the environment scan.

Primary reference:

- https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/command-line-string-limitation — cmd.exe's 8191-character command-line, inherited-variable, and expansion limits.
