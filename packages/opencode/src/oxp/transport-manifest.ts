/**
 * Static, CI-verified OXP protocol manifest without executable adapters.
 *
 * GENERATED SOURCE: transport-manifest.generated.json is produced exclusively
 * by script/generate-oxp-transport-manifest.ts. Do not alter it manually.
 * Loading this module must not import OxpSurface, OxpCapability, workspace or
 * Session owners. The generator's --check mode is a required release gate.
 */
import type { Tool } from "@modelcontextprotocol/server"
import data from "./transport-manifest.generated.json"

function deepFreeze<T>(input: T): Readonly<T> {
  if (input === null || typeof input !== "object" || Object.isFrozen(input)) return input
  for (const child of Object.values(input)) deepFreeze(child)
  return Object.freeze(input)
}

const snapshot = deepFreeze(data)
if (
  snapshot.generator !== "oxp-transport-manifest-v1" ||
  !/^[a-f0-9]{64}$/.test(snapshot.fingerprint) ||
  snapshot.tools.length === 0 ||
  new Set(snapshot.tools.map((tool) => tool.name)).size !== snapshot.tools.length
) {
  throw new Error("Invalid build-generated OXP transport manifest")
}

export const OXP_STATIC_TRANSPORT = Object.freeze({
  majorVersion: snapshot.majorVersion,
  fingerprint: snapshot.fingerprint,
  instructions: snapshot.instructions,
  // The source-owner generator and executable parity gate validate the exact
  // JSON schema shapes. JSON inference cannot represent MCP's recursive
  // JSON-schema index signatures without an explicit trust-boundary cast.
  tools: snapshot.tools as unknown as readonly Tool[],
  outputSchema: snapshot.outputSchema as NonNullable<Tool["outputSchema"]>,
  legacyOutputSchema: snapshot.legacyOutputSchema as NonNullable<Tool["outputSchema"]>,
})
