import { readFile, stat } from "node:fs/promises"
import { extname } from "node:path"
import {
  ParameterizedFingerprintBuilder,
  hashParameterizedFingerprint,
} from "../src/session/spad/parameterized-fast"
import { parameterizedMatchCode } from "../src/session/spad/parameterized"

const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx"])
const MAX_FILES = 240
const MAX_BYTES = 192 * 1024
const WINDOW_LINES = 8
const PHASE_OFFSETS = [0, 4] as const
const STEP_LINES = WINDOW_LINES
const MIN_DISTANCE_LINES = WINDOW_LINES
const MAX_DISTANCE_LINES = 96
const MAX_BLOCK_CHARS = 8192
const MIN_TOKENS = 24

const git = Bun.spawn(["git", "ls-files", "-z"], { cwd: "../..", stdout: "pipe", stderr: "pipe" })
const stdout = await new Response(git.stdout).text()
const stderr = await new Response(git.stderr).text()
const code = await git.exited
if (code !== 0) throw new Error(`git ls-files failed (${code}): ${stderr}`)

const files: string[] = []
for (const file of stdout.split("\0").sort()) {
  if (!file || !EXTENSIONS.has(extname(file).toLowerCase())) continue
  const info = await stat(`../../${file}`).catch(() => undefined)
  if (!info?.isFile() || info.size === 0 || info.size > MAX_BYTES) continue
  files.push(file)
  if (files.length >= MAX_FILES) break
}

type Previous = { file: string; startLine: number; text: string; tokenCount: number; repeatedDensity: number }
type Example = {
  file: string
  previousStartLine: number
  currentStartLine: number
  tokenCount: number
  repeatedParameterDensity: number
  constantCoverage: number
  renamedParameterClasses: number
  renamedCalleeClasses: number
}

let windows = 0
let proposalHashMatches = 0
let exactParameterizedMatches = 0
let strongMatches = 0
let renamedStrongMatches = 0
let rejectedTooDistant = 0
let recurrenceSeries3 = 0
let strongSeries3 = 0
let renamedStrongSeries3 = 0
let chars = 0
const examples: Example[] = []

for (const file of files) {
  const text = await readFile(`../../${file}`, "utf8").catch(() => undefined)
  if (!text || text.includes("\u0000")) continue
  const lines = text.split(/\r?\n/)
  for (const phase of PHASE_OFFSETS) {
    const seen = new Map<string, Previous & { streak: number }>()
    const builder = new ParameterizedFingerprintBuilder(MAX_BLOCK_CHARS)
    for (let start = phase; start + WINDOW_LINES <= lines.length; start += STEP_LINES) {
      const block = lines.slice(start, start + WINDOW_LINES).join("\n")
      if (block.length === 0 || block.length > MAX_BLOCK_CHARS) continue
      const view = builder.build(block)
      if (view.length < MIN_TOKENS) continue
      windows++
      chars += block.length
      const { h1, h2 } = hashParameterizedFingerprint(view)
      const key = `${view.length}:${h1}:${h2}`
      const previous = seen.get(key)
      let streak = 1
      if (previous) {
        const distance = start + 1 - previous.startLine
        if (distance > MAX_DISTANCE_LINES) rejectedTooDistant++
        else {
          proposalHashMatches++
          const exact = parameterizedMatchCode(previous.text, block)
          if (exact.matched) {
            exactParameterizedMatches++
            streak = previous.streak + 1
            const strong = exact.constantCoverage >= 0.35 && exact.repeatedParameterDensity >= 0.5 && exact.repeatedParameterClasses >= 2
            if (strong) strongMatches++
            if (strong && exact.renamedParameterClasses >= 2) renamedStrongMatches++
            if (streak >= 3) recurrenceSeries3++
            if (streak >= 3 && strong) strongSeries3++
            if (streak >= 3 && strong && exact.renamedParameterClasses >= 2) renamedStrongSeries3++
            if (examples.length < 30) {
              examples.push({
                file,
                previousStartLine: previous.startLine,
                currentStartLine: start + 1,
                tokenCount: exact.tokenCount,
                repeatedParameterDensity: exact.repeatedParameterDensity,
                constantCoverage: exact.constantCoverage,
                renamedParameterClasses: exact.renamedParameterClasses,
                renamedCalleeClasses: exact.renamedCalleeClasses,
              })
            }
          }
        }
      }
      // Keep only the most recent block with this proposal signature, matching
      // the recurrence-detection use case rather than cross-file clone search.
      seen.set(key, {
        file,
        startLine: start + 1,
        text: block,
        tokenCount: view.length,
        repeatedDensity: view.repeatedParameterDensity,
        streak,
      })
    }
  }
}

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      parameters: {
        maxFiles: MAX_FILES,
        maxBytes: MAX_BYTES,
        windowLines: WINDOW_LINES,
        stepLines: STEP_LINES,
        phaseOffsets: PHASE_OFFSETS,
        minDistanceLines: MIN_DISTANCE_LINES,
        maxDistanceLines: MAX_DISTANCE_LINES,
        minTokens: MIN_TOKENS,
      },
      files: files.length,
      windows,
      chars,
      proposalHashMatches,
      proposalRate: windows ? proposalHashMatches / windows : 0,
      exactParameterizedMatches,
      exactMatchRate: windows ? exactParameterizedMatches / windows : 0,
      strongMatches,
      strongMatchRate: windows ? strongMatches / windows : 0,
      renamedStrongMatches,
      renamedStrongMatchRate: windows ? renamedStrongMatches / windows : 0,
      rejectedTooDistant,
      recurrenceSeries3,
      recurrenceSeries3Rate: windows ? recurrenceSeries3 / windows : 0,
      strongSeries3,
      strongSeries3Rate: windows ? strongSeries3 / windows : 0,
      renamedStrongSeries3,
      renamedStrongSeries3Rate: windows ? renamedStrongSeries3 / windows : 0,
      verifierAcceptance: proposalHashMatches ? exactParameterizedMatches / proposalHashMatches : 0,
      examples,
    },
    null,
    2,
  ),
)
