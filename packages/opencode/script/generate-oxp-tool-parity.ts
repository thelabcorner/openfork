/**
 * Regenerate the documented OXP/native built-in tool matrix from the shared
 * transport mapping. This script reads the authoritative ledger; it does not
 * infer capabilities from prose or overwrite the rest of the architecture doc.
 *
 * Run from the repository: bun packages/opencode/script/generate-oxp-tool-parity.ts
 */
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { OxpToolCoverage } from "../src/oxp/tool-coverage"

const docPath = resolve(import.meta.dir, "../../../docs/architecture/oxp-native-tool-parity.md")
const begin = "<!-- OXP-NATIVE-PARITY-MATRIX:START -->"
const end = "<!-- OXP-NATIVE-PARITY-MATRIX:END -->"
const table = [begin, OxpToolCoverage.markdownParityMatrix(), end].join("\n")
const previous = readFileSync(docPath, "utf8")

let next: string
if (previous.includes(begin)) {
  const start = previous.indexOf(begin)
  const finish = previous.indexOf(end, start)
  if (finish === -1) throw new Error("Unclosed OXP parity matrix marker")
  next = previous.slice(0, start) + table + previous.slice(finish + end.length)
} else {
  const anchor = "## Deployment boundary"
  if (!previous.includes(anchor)) throw new Error("Missing OXP architecture document insertion point")
  next = previous.replace(
    anchor,
    [
      "## Native tool exposure matrix",
      "",
      "This table is generated from the shared native/external transport ledger.",
      "Do not hand-edit it. A regression test checks the exact generated rows.",
      "",
      table,
      "",
      anchor,
    ].join("\n"),
  )
}

const actionBegin = "<!-- OXP-NATIVE-ACTION-SCOPES:START -->"
const actionEnd = "<!-- OXP-NATIVE-ACTION-SCOPES:END -->"
const actions = [actionBegin, OxpToolCoverage.markdownActionScopes(), actionEnd].join("\n")
if (next.includes(actionBegin)) {
  const start = next.indexOf(actionBegin)
  const finish = next.indexOf(actionEnd, start + actionBegin.length)
  if (finish === -1) throw new Error("Unclosed OXP action scope matrix marker")
  next = next.slice(0, start) + actions + next.slice(finish + actionEnd.length)
} else {
  const anchor = "## Deployment boundary"
  if (!next.includes(anchor)) throw new Error("Missing OXP architecture document action section insertion point")
  next = next.replace(
    anchor,
    [
      "## Explicit action-level boundaries",
      "",
      "An executable capability **name** does not establish identical actions or",
      "credential/Session lifetime semantics. The following intentionally narrower",
      "adapters are checked against both native and OXP parameter schemas.",
      "",
      actions,
      "",
      anchor,
    ].join("\n"),
  )
}

if (next !== previous) writeFileSync(docPath, next)
console.log(
  `Native builtins: ${OxpToolCoverage.ENTRIES.length}; explicit exceptions: ${OxpToolCoverage.EXPLICIT_EXCEPTIONS.length}; updated: ${next !== previous}`,
)
