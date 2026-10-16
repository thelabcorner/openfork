/**
 * Build-time-only canonical OXP transport manifest generator.
 *
 * Run from repo root:
 *   bun packages/opencode/script/generate-oxp-transport-manifest.ts
 *   bun packages/opencode/script/generate-oxp-transport-manifest.ts --check
 *
 * The execution/schema owners are loaded ONLY during generation or drift
 * verification. A lightweight runtime may read the frozen JSON artifact
 * without importing the 360-module eager capability graph.
 */
import fs from "node:fs/promises"
import path from "node:path"
import { OxpSurface } from "../src/oxp/surface"

const destination = path.resolve(import.meta.dir, "../src/oxp/transport-manifest.generated.json")
const snapshot = {
  generator: "oxp-transport-manifest-v1",
  majorVersion: OxpSurface.MAJOR_VERSION,
  fingerprint: OxpSurface.FINGERPRINT,
  instructions: OxpSurface.SERVER_INSTRUCTIONS,
  tools: OxpSurface.TOOLS,
  outputSchema: OxpSurface.OUTPUT_SCHEMA,
  legacyOutputSchema: OxpSurface.LEGACY_OUTPUT_SCHEMA,
}
const serialized = JSON.stringify(snapshot, null, 2) + "\n"
if (process.argv.includes("--check")) {
  const existing = await fs.readFile(destination, "utf8").catch(() => "")
  if (existing !== serialized) {
    console.error("OXP manifest drift: generated transport contract differs from source owners. Regenerate and review schema/annotations before release.")
    process.exitCode = 1
  } else {
    console.log(JSON.stringify({ status: "verified", file: path.basename(destination), fingerprint: snapshot.fingerprint, tools: snapshot.tools.length, bytes: Buffer.byteLength(serialized) }))
  }
} else {
  // Only this fixed generated path is written; do not alter any other source.
  await fs.writeFile(destination, serialized)
  console.log(JSON.stringify({ status: "generated", file: path.basename(destination), fingerprint: snapshot.fingerprint, tools: snapshot.tools.length, bytes: Buffer.byteLength(serialized) }))
}
