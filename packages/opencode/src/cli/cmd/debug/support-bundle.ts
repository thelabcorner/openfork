/**
 * `openfork debug support-bundle` — the export surface for a shareable diagnostics artifact.
 *
 * This command owns *composition and delivery only*. Every privacy decision lives in
 * `@opencode-ai/core/diagnostics/support-bundle`: the section allowlist, the single secret
 * owner, report-local pseudonyms, and the included/excluded manifest. There is deliberately
 * no second scrubber here — a second one would be a second, permanently divergent answer to
 * "what is safe to share".
 *
 * Two properties are structural rather than remembered:
 *
 * 1. **Tier 0.** `instance: false` means this never crosses `InstanceStore.load`, so the
 *    command still works when the thing being diagnosed is instance bootstrap itself.
 * 2. **No conversation source.** This command reads no session, message, or task state at
 *    all, so conversation content cannot be included even by accident. The artifact reports
 *    it as explicitly excluded, and `--include-conversation` deliberately does not exist.
 */
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import { Effect } from "effect"
import type { Argv } from "yargs"
import { SupportBundle } from "@opencode-ai/core/diagnostics/support-bundle"
import { Global } from "@opencode-ai/core/global"
import { InstallationChannel, InstallationVersion } from "@opencode-ai/core/installation/version"
import { effectCmd, fail } from "../../effect-cmd"

/** The active log file name. Matches the default in `@opencode-ai/core/observability/logging`. */
const LOG_BASENAME = "openfork.log"

/**
 * Default number of trailing log lines to hand to the core projection.
 *
 * The core projection applies its own per-section array bound and keeps the *first*
 * N entries it is given, so the caller must hand over the newest lines for a support
 * bundle to show the failure that prompted it. Exceeding this bound is not an error:
 * the core projection simply bounds further.
 */
const DEFAULT_LOG_LINES = 64

const DEFAULT_LOG_BYTES = 256 * 1024

/**
 * Most severe level present in the retained lines, as a coarse hint for triage.
 *
 * The formatter emits `key=value` structured lines, so a level token is only recognised
 * when it appears as a standalone field. Anything unrecognised stays `Info`, which is the
 * honest default: this is a hint, not an assertion.
 */
function coarsestLevel(lines: readonly string[]): string {
  const seen = new Set<string>()
  for (const line of lines) {
    const match = /(?:^|\s)level=(Debug|Info|Warn|Error)(?:\s|$)/.exec(line)
    if (match) seen.add(match[1]!)
  }
  for (const level of ["Error", "Warn", "Info", "Debug"]) if (seen.has(level)) return level
  return "Info"
}

/**
 * Newest-first walk over the active log plus its rotated siblings, oldest chunk first.
 *
 * Rotation in `@opencode-ai/core/observability/logging` writes `${file}.${stamp}.gz`, so
 * plain lexicographic order is chronological for both the active file and its rotations.
 * The budget is spent from the newest end backwards, which is what makes a bounded bundle
 * still contain the failing turn rather than the oldest retained line.
 */
async function readRecentLogLines(dir: string, byteBudget: number): Promise<string[]> {
  if (byteBudget <= 0) return []
  let names: string[]
  try {
    names = (await fs.readdir(dir)).filter((name) => name === LOG_BASENAME || name.startsWith(`${LOG_BASENAME}.`))
  } catch {
    return []
  }
  names.sort()
  const chunks: string[] = []
  let remaining = byteBudget
  for (let index = names.length - 1; index >= 0 && remaining > 0; index--) {
    const name = names[index]!
    let buffer: Buffer
    try {
      buffer = await fs.readFile(path.join(dir, name))
    } catch {
      continue
    }
    if (name.endsWith(".gz")) {
      try {
        buffer = zlib.gunzipSync(buffer)
      } catch {
        continue
      }
    }
    const slice = buffer.subarray(Math.max(0, buffer.length - remaining))
    remaining -= slice.length
    chunks.unshift(slice.toString("utf8"))
  }
  return chunks.join("").split(/\r?\n/)
}

/** Split a bounded log tail into the newest `lineLimit` non-empty lines. */
export function tailLines(text: string, lineLimit: number): string[] {
  if (lineLimit <= 0) return []
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0)
  return lines.length > lineLimit ? lines.slice(-lineLimit) : lines
}

/**
 * Private literals to hand the core pseudonymizer.
 *
 * The home root and the account name are the two identities that appear verbatim in log
 * lines and paths without looking like either. Everything else is left to the core
 * path/email classifiers.
 */
function privateValues(): string[] {
  const values = new Set<string>()
  const add = (value: string | undefined) => {
    const trimmed = value?.trim()
    if (trimmed && trimmed.length >= 2) values.add(trimmed)
  }
  add(Global.Path.home)
  add(os.homedir())
  add(process.env.USERNAME)
  add(process.env.USER)
  try {
    add(os.userInfo().username)
  } catch {
    // A host without a resolvable account is not a reason to fail a diagnostics bundle.
  }
  return [...values]
}

export const SupportBundleCommand = effectCmd({
  command: "support-bundle",
  describe: "write a privacy-safe diagnostics support bundle",
  // Tier 0: never materialize a workspace Instance. A support bundle has to keep working
  // when instance bootstrap is the thing that is broken.
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .option("out", {
        type: "string",
        describe: "write the bundle to this file instead of stdout",
      })
      .option("log-bytes", {
        type: "number",
        default: DEFAULT_LOG_BYTES,
        describe: "how many recent log bytes to read (0 disables the log section)",
      })
      .option("log-lines", {
        type: "number",
        default: DEFAULT_LOG_LINES,
        describe: "how many of the newest log lines to include",
      })
      .option("compact", {
        type: "boolean",
        default: false,
        describe: "emit single-line JSON instead of indented JSON",
      })
      .option("explain", {
        type: "boolean",
        default: false,
        describe: "print an included/excluded summary to stderr before the artifact",
      }),
  handler: Effect.fn("Cli.debug.supportBundle")(function* (args: {
    out?: string
    logBytes: number
    logLines: number
    compact: boolean
    explain: boolean
  }) {
    const rawLines =
      args.logBytes > 0 ? tailLines(yield* Effect.promise(() => readRecentLogLines(Global.Path.log, args.logBytes)), args.logLines) : []

    // Only the fields the core section spec declares are supplied. Anything else is
    // dropped by the allowlist, so passing extra keys would be misleading dead weight.
    const bundle = SupportBundle.build(
      {
        runtime: {
          version: InstallationVersion,
          channel: InstallationChannel,
          platform: process.platform,
          arch: process.arch,
          nodeVersion: process.versions.node,
          executable: process.execPath,
          configRoot: Global.Path.config,
          dataRoot: Global.Path.data,
          uptimeSeconds: Math.round(process.uptime()),
        },
        logs:
          rawLines.length > 0
            ? { level: coarsestLevel(rawLines), lines: rawLines }
            : undefined,
      },
      { privateValues: privateValues() },
    )

    const json = SupportBundle.serialize(bundle, { pretty: !args.compact })

    if (args.explain) {
      const lines = [
        "OpenFork support bundle — read this before you share the file.",
        `included: ${bundle.included.length > 0 ? bundle.included.join(", ") : "(none)"}`,
        "excluded:",
        ...bundle.excluded.map((entry) => `  - ${entry.id}: ${entry.reason}`),
        `scrub: ${bundle.scrub.redactedValues} credential value(s), ${bundle.scrub.pseudonymizedValues} pseudonymized, ${bundle.scrub.truncatedValues} truncated, ${bundle.scrub.droppedValues} dropped`,
        "Report it at https://github.com/thelabcorner/openfork/issues",
      ]
      process.stderr.write(lines.join("\n") + "\n")
    }

    if (!args.out) {
      process.stdout.write(json + "\n")
      return
    }
    yield* Effect.promise(() => fs.writeFile(args.out!, json + "\n", "utf8")).pipe(
      Effect.catchCause((cause) => fail(`failed to write support bundle: ${cause}`)),
    )
    process.stderr.write(`support bundle written to ${args.out}\n`)
  }),
})
