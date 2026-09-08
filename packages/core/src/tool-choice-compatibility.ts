/**
 * Runtime classifier for providers that support tools but reject stronger
 * tool-choice modes such as `required` / named forcing and only accept `auto`.
 *
 * The model catalogs currently expose whether tool calls are supported, but not
 * which tool-choice modes a particular upstream accepts. Keep that distinction
 * runtime-negotiated instead of hardcoding provider IDs.
 */
export function isToolChoiceCompatibilityError(error: unknown): boolean {
  const fragments: string[] = []
  const seen = new Set<unknown>()

  const visit = (value: unknown, depth: number) => {
    if (value === undefined || value === null || depth > 4 || seen.has(value)) return
    if (typeof value === "string") {
      fragments.push(value)
      return
    }
    if (typeof value !== "object") return
    seen.add(value)

    if (value instanceof Error) {
      fragments.push(value.name, value.message)
      visit(value.cause, depth + 1)
    }

    const record = value as Record<string, unknown>
    for (const key of ["message", "cause", "reason", "error", "data", "responseBody", "body"]) {
      visit(record[key], depth + 1)
    }
  }

  visit(error, 0)
  const normalized = fragments.join("\n").toLowerCase()
  if (!normalized.includes("tool_choice") && !normalized.includes("tool choice")) return false
  if (
    normalized.includes('only "auto" is supported') ||
    normalized.includes("only 'auto' is supported") ||
    normalized.includes("only auto is supported")
  ) {
    return true
  }

  const rejectsMode =
    normalized.includes("not currently supported") ||
    normalized.includes("not supported") ||
    normalized.includes("unsupported")
  const namesStrongerChoice =
    normalized.includes("required") ||
    normalized.includes("named function") ||
    normalized.includes("named tool") ||
    normalized.includes("specific tool")
  return rejectsMode && namesStrongerChoice
}

export type ToolChoiceCapabilityIdentity = {
  readonly providerID: string
  readonly modelID: string
  readonly apiNpm?: string
  readonly apiURL?: string
  readonly apiID?: string
  readonly routeID?: string
  readonly routeProtocol?: string
}

const autoOnlyToolChoice = new Set<string>()

export function toolChoiceCapabilityKey(identity: ToolChoiceCapabilityIdentity): string {
  return [
    identity.providerID,
    identity.modelID,
    identity.apiNpm ?? "",
    identity.apiURL ?? "",
    identity.apiID ?? "",
    identity.routeID ?? "",
    identity.routeProtocol ?? "",
  ].join("\u0000")
}

export function preferredToolChoice(
  identity: ToolChoiceCapabilityIdentity,
  requested: "required" | "auto" | "none",
): "required" | "auto" | "none" {
  if (requested !== "required") return requested
  return autoOnlyToolChoice.has(toolChoiceCapabilityKey(identity)) ? "auto" : "required"
}

/**
 * Records an observed upstream incompatibility with strong tool-choice forcing.
 * Returns true only when the supplied error proves this is a tool-choice
 * compatibility downgrade rather than a generic provider failure.
 */
export function rememberAutoOnlyToolChoice(identity: ToolChoiceCapabilityIdentity, error: unknown): boolean {
  if (!isToolChoiceCompatibilityError(error)) return false
  autoOnlyToolChoice.add(toolChoiceCapabilityKey(identity))
  return true
}

/** @internal Test/debug seam. */
export function resetToolChoiceCapabilityMemory() {
  autoOnlyToolChoice.clear()
}
