/**
 * Pure view-model for the WakaTime settings panel.
 *
 * The panel is a read-mostly projection of the process-global Core WakaTime
 * exporter. Core owns the opt-in and the CLI resolution; this module only
 * derives what to display, and only from the Tier-0 status payload. There is no
 * API-key draft, no credential store, and no local persistence: the renderer
 * has no secret authority and must not invent one.
 */

export interface WakaTimeStatusView {
  readonly enabled: boolean
  readonly configured: boolean
  readonly cli?: string
  readonly source?: "override" | "system" | "managed"
}

/**
 * Why the exporter is or is not sending.
 *
 * - `disabled`: the user has not opted in, so nothing is queued or sent.
 * - `missing-key`: opted in, but no WAKATIME_API_KEY and no `~/.wakatime.cfg`,
 *   so delivery would silently no-op.
 * - `missing-cli`: opted in and authenticated, but no already-resolved CLI was
 *   found. Core downloads one on the first heartbeat, so this is a diagnostic,
 *   not a blocking error.
 * - `ready`: opted in, authenticated, and a CLI is already resolved.
 */
export type WakaTimeConnection = "disabled" | "missing-key" | "missing-cli" | "ready"

export function connectionState(status: WakaTimeStatusView | undefined): WakaTimeConnection {
  if (status === undefined || !status.enabled) return "disabled"
  if (!status.configured) return "missing-key"
  return status.cli === undefined || status.cli.length === 0 ? "missing-cli" : "ready"
}

const CLI_SOURCES = ["override", "system", "managed"] as const

/**
 * How the resolved CLI was found. An unrecognized value from a newer server is
 * rendered as `undefined` rather than being displayed raw or trusted as a
 * known state.
 */
export function cliSource(status: WakaTimeStatusView | undefined): (typeof CLI_SOURCES)[number] | undefined {
  const source = status?.source
  return source !== undefined && CLI_SOURCES.includes(source) ? source : undefined
}

/**
 * The CLI path is shown only when Core actually resolved one. A blank or
 * whitespace-only path is treated as absent so the diagnostics row can fall
 * back to explanatory copy instead of rendering an empty code element.
 */
export function cliPath(status: WakaTimeStatusView | undefined): string | undefined {
  const cli = status?.cli?.trim()
  return cli !== undefined && cli.length > 0 ? cli : undefined
}
