/**
 * Resolves — and *verifies* — the backend the mobile PWA dev proxy is allowed
 * to talk to. Used only by `packages/mobile/vite.config.ts`.
 *
 * The rule this file enforces: never proxy to a port, only ever to a proven
 * identity. Every failure below used to present as "the PWA is talking to some
 * other opencode", which is indistinguishable from a broken app until you
 * notice the sessions belong to a different project.
 */
import {
  ENV_RUN_ID,
  HANDSHAKE_VERSION,
  IDENTITY_PATH,
  type DevHandshake,
  type InstanceIdentity,
  readHandshake,
} from "./handshake"

export type ProbeFailure =
  /** Nothing is listening — the desktop half is down, or already exited. */
  | "unreachable"
  /** Something answered, but it is not an opencode HTTP API (SPA HTML, a proxy, a random dev server). */
  | "not-opencode"
  /** An opencode without `/instance/identity` — i.e. a different, older build. */
  | "outdated"
  /** An opencode that did not launch from this desktop (no `OPENCODE_INSTANCE_ID`). */
  | "unmanaged"
  /** A *different* opencode instance answered on the expected port. */
  | "mismatch"

export type ProbeResult = { ok: true; identity: InstanceIdentity } | { ok: false; reason: ProbeFailure; detail: string }

export type TargetResolution =
  | { ok: true; url: string; instanceID?: string; identity?: InstanceIdentity; source: "handshake" | "override" }
  | { ok: false; code: string; message: string; hint: string; detail?: string }

const PROBE_TIMEOUT_MS = 2500

/**
 * Asks a candidate backend who it is. Deliberately strict about the response
 * shape: opencode's catch-all UI route answers *every* unknown path with the
 * SPA's HTML, so "HTTP 200" proves nothing while a JSON body carrying the
 * expected `instanceID` proves everything.
 */
export async function probeIdentity(
  url: string,
  options: { expect?: string; timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<ProbeResult> {
  const fetchImpl = options.fetchImpl ?? fetch
  let response: Response
  try {
    response = await fetchImpl(new URL(IDENTITY_PATH, `${url}/`), {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS),
    })
  } catch (error) {
    return { ok: false, reason: "unreachable", detail: errorText(error) }
  }
  if (response.status === 404 || response.status === 405) {
    return { ok: false, reason: "outdated", detail: `${IDENTITY_PATH} responded ${response.status}` }
  }
  if (!response.ok) {
    return { ok: false, reason: "not-opencode", detail: `${IDENTITY_PATH} responded ${response.status}` }
  }
  let body: unknown
  try {
    body = await response.json()
  } catch {
    const type = response.headers.get("content-type") ?? "unknown"
    // The SPA fallback lands here: text/html with a 200.
    return { ok: false, reason: type.includes("html") ? "outdated" : "not-opencode", detail: `content-type ${type}` }
  }
  if (!body || typeof body !== "object") {
    return { ok: false, reason: "not-opencode", detail: "identity was not an object" }
  }
  const identity = body as InstanceIdentity
  if (typeof identity.instanceID !== "string" || !identity.instanceID) {
    return { ok: false, reason: "outdated", detail: "identity had no instanceID" }
  }
  if (options.expect) {
    // An `anon:` id is still a per-process identity, so pinning to one is
    // sound — that is how the v2 daemon path (which the desktop attaches to
    // rather than spawns) is verified.
    if (identity.instanceID !== options.expect) {
      return { ok: false, reason: "mismatch", detail: `expected ${options.expect}, got ${identity.instanceID}` }
    }
  } else if (identity.instanceID.startsWith("anon:")) {
    // No expectation to check against, so refuse an unclaimed process rather
    // than adopt whatever happens to hold the port.
    return {
      ok: false,
      reason: "unmanaged",
      detail: `instance ${identity.instanceID} was not launched by this desktop`,
    }
  }
  return { ok: true, identity }
}

type Cached = { key: string; url: string; instanceID?: string; identity?: InstanceIdentity; at: number }

export type TargetResolver = {
  /** Reads the handshake, verifies identity when stale, and reports the outcome. */
  resolve(): Promise<TargetResolution>
  /** Last *verified* URL. Synchronous, for `http-proxy`'s `router` hook. */
  verifiedUrl(): string | undefined
  /** Last verified identity, exposed to the PWA for display and pinning. */
  verifiedIdentity(): InstanceIdentity | undefined
}

export function createTargetResolver(options: {
  /** Absolute path of `packages/mobile/.opencode-dev-handshake.json`. */
  file: string
  /** Explicit operator override; verified too, then pinned to its first identity. */
  override?: string
  /** This Vite's `OPENCODE_DEV_RUN_ID`, when it was started by `bun run dev`. */
  runID?: string
  revalidateMs?: number
  now?: () => number
  fetchImpl?: typeof fetch
  onLog?: (level: "info" | "warn", message: string) => void
}): TargetResolver {
  const now = options.now ?? Date.now
  const revalidateMs = options.revalidateMs ?? 3000
  const log = options.onLog ?? (() => {})
  let cached: Cached | undefined
  let inflight: Promise<TargetResolution> | undefined
  let lastLogged = ""
  /** Pinned on first success so an override cannot silently move instances either. */
  let overridePin: string | undefined

  const report = (result: TargetResolution) => {
    const signature = result.ok ? `ok:${result.url}:${result.instanceID ?? ""}` : `err:${result.code}:${result.message}`
    if (signature === lastLogged) return result
    lastLogged = signature
    if (result.ok) {
      const who = result.instanceID ? ` (instance ${short(result.instanceID)})` : ""
      log("info", `mobile dev proxy bound to ${result.url}${who}`)
    } else {
      log("warn", `mobile dev proxy refusing to bind: ${result.message} ${result.hint}`)
    }
    return result
  }

  const verify = async (
    url: string,
    expect: string | undefined,
    source: "handshake" | "override",
    handshake?: DevHandshake,
  ): Promise<TargetResolution> => {
    const probe = await probeIdentity(url, { expect, fetchImpl: options.fetchImpl })
    if (!probe.ok) {
      cached = undefined
      return report(failure(probe, url, expect, source, handshake))
    }
    if (source === "override") overridePin = probe.identity.instanceID
    cached = {
      key: `${source}:${url}:${expect ?? probe.identity.instanceID}`,
      url,
      instanceID: probe.identity.instanceID,
      identity: probe.identity,
      at: now(),
    }
    return report({ ok: true, url, instanceID: probe.identity.instanceID, identity: probe.identity, source })
  }

  const run = async (): Promise<TargetResolution> => {
    const file = readHandshake(options.file)

    // The canonical desktop launcher supplies a run id to both Vite and
    // Electron. Once that contract is present, an override is intentionally
    // ignored: allowing it here would reintroduce the exact failure this gate
    // exists to prevent (a PWA launched by desktop silently using an unrelated
    // server from an inherited environment variable).
    const overrideAllowed = Boolean(options.override && !options.runID)

    if (!file) {
      const override = options.override
      if (!overrideAllowed || !override) {
        cached = undefined
        return report({
          ok: false,
          code: "DesktopSidecarUnavailableError",
          message: "The desktop sidecar is not running.",
          hint: "Start it with `bun run dev` from packages/desktop. Do not start a standalone backend — the PWA only binds to the sidecar that launched it.",
        })
      }
      const key = `override:${override}:${overridePin ?? ""}`
      if (cached?.key === key && now() - cached.at < revalidateMs) {
        return {
          ok: true,
          url: cached.url,
          instanceID: cached.instanceID,
          identity: cached.identity,
          source: "override",
        }
      }
      return verify(override, overridePin, "override")
    }

    const handshake = file.handshake
    if (!handshake) {
      cached = undefined
      return report({
        ok: false,
        code: "DesktopSidecarHandshakeInvalidError",
        message: "The dev handshake file is unreadable.",
        hint: `Delete ${options.file} and restart \`bun run dev\` from packages/desktop.`,
        detail: file.raw.slice(0, 120),
      })
    }
    if (handshake.version !== HANDSHAKE_VERSION) {
      cached = undefined
      return report({
        ok: false,
        code: "DesktopSidecarHandshakeVersionError",
        message: `The dev handshake is version ${handshake.version}; this PWA server speaks version ${HANDSHAKE_VERSION}.`,
        hint: "Both halves come from one `bun run dev`, so this means a stale file or a stale process. Restart the whole dev stack.",
      })
    }
    // Both halves of `bun run dev` inherit one run id. If they disagree, this
    // Vite is looking at a handshake written by a *different* dev stack — the
    // exact situation that used to bind the PWA to the wrong opencode.
    if (options.runID && handshake.runID !== options.runID) {
      cached = undefined
      return report({
        ok: false,
        code: "DesktopSidecarForeignRunError",
        message: "The running desktop belongs to a different `bun run dev` than this PWA server.",
        hint: `This PWA server was launched by run ${short(options.runID)}; the sidecar handshake belongs to run ${short(handshake.runID || "unknown")}. Stop the extra dev stack, then restart \`bun run dev\`.`,
      })
    }

    const key = `handshake:${handshake.url}:${handshake.instanceID}`
    if (cached?.key === key && now() - cached.at < revalidateMs) {
      return {
        ok: true,
        url: cached.url,
        instanceID: cached.instanceID,
        identity: cached.identity,
        source: "handshake",
      }
    }
    return verify(handshake.url, handshake.instanceID, "handshake", handshake)
  }

  return {
    resolve() {
      // Collapse a burst of concurrent requests onto a single probe.
      if (inflight) return inflight
      inflight = run().finally(() => {
        inflight = undefined
      })
      return inflight
    },
    verifiedUrl: () => cached?.url,
    verifiedIdentity: () => cached?.identity,
  }
}

function failure(
  probe: Extract<ProbeResult, { ok: false }>,
  url: string,
  expect: string | undefined,
  source: "handshake" | "override",
  handshake?: DevHandshake,
): TargetResolution {
  const channel = handshake?.channel ? `, channel ${handshake.channel}` : ""
  const where = `${url}${handshake?.pid ? ` (desktop pid ${handshake.pid}${channel})` : ""}`
  switch (probe.reason) {
    case "unreachable":
      return {
        ok: false,
        code: "DesktopSidecarUnavailableError",
        message: `The desktop sidecar at ${where} is not answering.`,
        hint: "It is still starting, or it exited. Keep OpenCode Desktop running — the proxy rebinds by itself once it answers.",
        detail: probe.detail,
      }
    case "mismatch":
      return {
        ok: false,
        code: "DesktopSidecarInstanceMismatchError",
        message: `A different opencode instance is listening on ${where}.`,
        hint: `Expected instance ${short(expect ?? "?")}. The sidecar's ephemeral port was taken over by another opencode process. Restart \`bun run dev\` from packages/desktop — the proxy will not bind to the wrong backend.`,
        detail: probe.detail,
      }
    case "unmanaged":
      return {
        ok: false,
        code: "DesktopSidecarUnmanagedInstanceError",
        message: `The opencode at ${where} was not launched by this desktop.`,
        hint: "It is an unrelated instance (`opencode serve`, a JetBrains ACP agent, another checkout) holding this port. Restart `bun run dev` from packages/desktop.",
        detail: probe.detail,
      }
    case "outdated":
      return {
        ok: false,
        code: "DesktopSidecarOutdatedError",
        message: `The server at ${where} is an older opencode without ${IDENTITY_PATH}.`,
        hint:
          source === "override"
            ? "Point the override at a backend built from this checkout, or drop the override and use `bun run dev`."
            : "Run `bun run predev` from packages/desktop to rebuild the sidecar bundle, then restart `bun run dev`.",
        detail: probe.detail,
      }
    case "not-opencode":
      return {
        ok: false,
        code: "DesktopSidecarNotOpencodeError",
        message: `Whatever is listening on ${where} is not an opencode server.`,
        hint: "A listening port is not evidence of a backend. Restart `bun run dev` from packages/desktop so the sidecar takes a fresh port.",
        detail: probe.detail,
      }
  }
}

function short(id: string) {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id
}

function errorText(error: unknown) {
  if (error instanceof Error) return error.message
  return String(error)
}

export { ENV_RUN_ID }
