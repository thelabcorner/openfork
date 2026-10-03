import { Agent as AgentContract } from "@opencode-ai/schema/agent"
import type { AgentConfig } from "@opencode-ai/sdk/v2/client"

export type AgentStudioMode = AgentContract.Mode

/**
 * The Studio edits the persisted global `agent` record. It is typed from the
 * generated transport contract rather than a hand-rolled shape so a save
 * payload is always exactly what `PUT /global/config/agent/:agentID` accepts.
 */
export type AgentStudioConfig = AgentConfig

export type AgentStudioModelRef = {
  providerID: string
  modelID: string
}

export type AgentStudioDraft = {
  id: string
  description: string
  prompt: string
  mode: AgentStudioMode
  hidden: boolean
  model?: AgentStudioModelRef
  variant: string
  temperature: string
  topP: string
  steps: string
}

export type NativeAgentDefinition = AgentContract.BuiltIn

/**
 * Built-in identity and shipped exposure defaults come from
 * `@opencode-ai/schema/agent`, the same contract the runtime seeds from.
 * Effective mode/hidden may be overridden by config, so Studio reads those
 * values from the persisted definition instead of maintaining a second preset
 * registry.
 */
export const NATIVE_AGENT_DEFINITIONS: readonly NativeAgentDefinition[] = AgentContract.BuiltInTopology

/**
 * Only visible built-ins are ordinary Studio rows. Hidden host-owned agents stay
 * reserved catalog identities but are intentionally absent from this management
 * surface.
 */
export const EDITABLE_NATIVE_AGENT_DEFINITIONS: readonly NativeAgentDefinition[] = NATIVE_AGENT_DEFINITIONS.filter(
  (item) => !item.hidden,
)

export const RESERVED_NATIVE_AGENT_IDS = new Set<string>(NATIVE_AGENT_DEFINITIONS.map((item) => item.id))

export const isEditableNativeAgent = (id: string): boolean =>
  EDITABLE_NATIVE_AGENT_DEFINITIONS.some((item) => item.id === id)

export const nativeAgentMode = (id: string): NativeAgentDefinition["mode"] | undefined =>
  NATIVE_AGENT_DEFINITIONS.find((item) => item.id === id)?.mode

/**
 * Where a catalogued agent can actually be reached. Delegates to the shared
 * contract so the Studio, the composer chooser, and the @mention palette cannot
 * disagree with each other or with the runtime.
 */
export const agentExposure = (input: { mode: AgentStudioMode; hidden: boolean }) => AgentContract.exposure(input)

export function parseAgentModel(value: string | undefined): AgentStudioModelRef | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return
  const slash = trimmed.indexOf("/")
  if (slash <= 0 || slash === trimmed.length - 1) return
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  }
}

const numericText = (value: number | undefined) => (value === undefined ? "" : String(value))

export function draftFromAgentConfig(input: {
  id: string
  config?: AgentStudioConfig
  nativeMode?: NativeAgentDefinition["mode"]
}): AgentStudioDraft {
  const config = input.config ?? {}
  return {
    id: input.id,
    description: typeof config.description === "string" ? config.description : "",
    prompt: typeof config.prompt === "string" ? config.prompt : "",
    // Built-ins have shared shipped defaults, but existing config may override
    // their exposure. Studio reflects that effective runtime value even though
    // built-in exposure remains read-only on this surface.
    mode: config.mode ?? input.nativeMode ?? "all",
    hidden: config.hidden === true,
    model: parseAgentModel(typeof config.model === "string" ? config.model : undefined),
    variant: typeof config.variant === "string" ? config.variant : "",
    temperature: numericText(typeof config.temperature === "number" ? config.temperature : undefined),
    topP: numericText(typeof config.top_p === "number" ? config.top_p : undefined),
    steps: numericText(typeof config.steps === "number" ? config.steps : undefined),
  }
}

function optionalFinite(value: string) {
  if (!value.trim()) return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function optionalPositiveInt(value: string) {
  const number = optionalFinite(value)
  if (number === undefined || !Number.isInteger(number) || number <= 0) return undefined
  return number
}

/**
 * Mirrors the Tier-0 `PUT/DELETE /global/config/agent/:agentID` parameter
 * contract (`Schema.isPattern` + `Schema.isMaxLength(128)`). Keeping the two
 * identical means the Studio can never offer Save for a value the exact
 * endpoint would reject with a 400.
 */
export const AGENT_ID_MAX_LENGTH = 128
export const AGENT_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/

export function isValidAgentID(value: string): boolean {
  const id = value.trim()
  if (id.length === 0 || id.length > AGENT_ID_MAX_LENGTH) return false
  return AGENT_ID_PATTERN.test(id)
}

export function draftValidation(draft: AgentStudioDraft) {
  const temperature = draft.temperature.trim()
  const topP = draft.topP.trim()
  const steps = draft.steps.trim()
  return {
    id: isValidAgentID(draft.id),
    temperature: !temperature || Number.isFinite(Number(temperature)),
    topP: !topP || Number.isFinite(Number(topP)),
    steps: !steps || optionalPositiveInt(steps) !== undefined,
  }
}

export function agentConfigPatch(draft: AgentStudioDraft, options: { native: boolean }): AgentStudioConfig {
  return {
    description: draft.description.trim() || undefined,
    prompt: draft.prompt.trim() || undefined,
    model: draft.model ? `${draft.model.providerID}/${draft.model.modelID}` : undefined,
    variant: draft.variant.trim() || undefined,
    temperature: optionalFinite(draft.temperature),
    top_p: optionalFinite(draft.topP),
    steps: optionalPositiveInt(draft.steps),
    ...(options.native
      ? {}
      : {
          mode: draft.mode,
          hidden: draft.mode === "primary" ? undefined : draft.hidden || undefined,
        }),
  }
}

const MANAGED_AGENT_KEYS = [
  "description",
  "prompt",
  "model",
  "variant",
  "temperature",
  "top_p",
  "steps",
  "mode",
  "hidden",
] as const

/**
 * Exact replacement of the Studio-owned subset of one agent definition.
 *
 * Advanced/unmanaged keys (`permission`, `options`, `tools`, `color`, …) are
 * carried through untouched, and every managed key is physically deleted before
 * the new values are applied. That is what lets a cleared field really clear
 * instead of leaving a stale nested value behind.
 */
export function agentConfigValue(
  existing: AgentStudioConfig | undefined,
  draft: AgentStudioDraft,
  options: { native: boolean },
): AgentStudioConfig {
  const next: AgentStudioConfig = { ...(existing ?? {}) }
  for (const key of MANAGED_AGENT_KEYS) {
    // Built-in exposure is not editable in Studio. Preserve any advanced
    // mode/hidden override that already exists instead of silently deleting it
    // when the user saves an unrelated built-in prompt/model/tuning change.
    if (options.native && (key === "mode" || key === "hidden")) continue
    delete next[key]
  }
  for (const [key, value] of Object.entries(agentConfigPatch(draft, options))) {
    if (value !== undefined) next[key] = value
  }
  return next
}

export function draftFingerprint(draft: AgentStudioDraft) {
  return JSON.stringify({
    id: draft.id,
    description: draft.description,
    prompt: draft.prompt,
    mode: draft.mode,
    hidden: draft.hidden,
    model: draft.model ? [draft.model.providerID, draft.model.modelID] : null,
    variant: draft.variant,
    temperature: draft.temperature,
    topP: draft.topP,
    steps: draft.steps,
  })
}

export function customAgentIDs(config: Record<string, AgentStudioConfig | undefined>) {
  return Object.entries(config)
    .filter(([id, value]) => !RESERVED_NATIVE_AGENT_IDS.has(id) && value?.disable !== true)
    .map(([id]) => id)
    .sort((a, b) => a.localeCompare(b))
}

/**
 * Deep link into the routed Agent Studio page.
 *
 * The Studio is a normal app tab route, so this is a plain href rather than a
 * router import: the reusable session-ui agent chooser only ever receives a
 * `manage` callback, and the app composes the navigation at the boundary that
 * owns the router. An unusable or unknown selection falls back to the bare page
 * so a stale composer selection can never produce a broken link.
 */
export function agentStudioHref(agentID?: string, directory?: string): string {
  const id = agentID?.trim()
  const dir = directory?.trim()
  const params = new URLSearchParams()
  if (id && isValidAgentID(id)) params.set("selected", id)
  if (dir) params.set("directory", dir)
  const query = params.toString()
  return query ? `/agents?${query}` : "/agents"
}
