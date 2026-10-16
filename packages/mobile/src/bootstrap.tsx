import { createSignal, lazy, onCleanup, onMount, Show, Suspense } from "solid-js"
import type { PwaEndpointMigrationResult } from "@opencode-ai/app/pwa-client"
import {
  parseStoredNetworkIdentity,
  sameNetworkIdentity,
  pinnedIdentityVerdict,
  type NetworkIdentity,
} from "./network-identity"
import { normalizePairCode, normalizeServerUrl, validPairCode } from "./pairing-input"
import { parseLinkPairCode } from "./pairing-payload"
import { canRestoreDeviceToken, claimPair, credentialVerdict, probeNetworkIdentity } from "./pairing-client"
import { createAttemptGate } from "./attempt-gate"
import { readTrustedPairing, writeTrustedPairing, removeTrustedPairing, type TrustedPairing } from "./paired-storage"

const loadPwaClient = () => import("@opencode-ai/app/pwa-client")
const preloadPwaClient = () => void loadPwaClient().catch(() => {})
const PwaClientApp = lazy(() => loadPwaClient().then((module) => ({ default: module.PwaClientApp })))
const PairingCamera = lazy(() => import("./PairingCamera").then((module) => ({ default: module.PairingCamera })))

const SERVER_URL_KEY = "opencode.mobile.serverUrl"
const DEVICE_TOKEN_KEY = "opencode.mobile.deviceToken"
const EMBEDDED_PWA_DEVICE_TOKEN_KEY = "opencode.pwa.dat:deviceToken"
const DEVICE_ID_KEY = "opencode.mobile.deviceID"
const NETWORK_IDENTITY_KEY = "opencode.mobile.networkIdentity.v1"

type Connection = { serverUrl: string; deviceToken?: string; deviceID?: string; networkIdentity?: NetworkIdentity }
type PairResponse = { token?: unknown; deviceToken?: unknown; device?: { id?: unknown } }

function readStorage(key: string) {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

function writeStorage(key: string, value: string) {
  try {
    localStorage.setItem(key, value)
  } catch {
    // The in-memory connection still works when durable storage is blocked.
  }
}

function clearStorage(key: string) {
  try {
    localStorage.removeItem(key)
  } catch {
    // Pairing can still recover on the next successful claim.
  }
}

function readNetworkIdentity() {
  return parseStoredNetworkIdentity(readStorage(NETWORK_IDENTITY_KEY))
}

function loadTrustedPairing() {
  try { return readTrustedPairing(localStorage, { allowInsecureRemote: import.meta.env.DEV }) }
  catch { return { kind: "corrupt" } as const }
}

function persistTrustedPairing(value: TrustedPairing) {
  let saved = false
  try { saved = writeTrustedPairing(localStorage, value, { allowInsecureRemote: import.meta.env.DEV }) }
  catch { /* Browser storage may be disabled. */ }
  if (saved) {
    // Legacy keys are migration inputs only; clear after the atomic commit.
    clearStorage(SERVER_URL_KEY)
    clearStorage(DEVICE_TOKEN_KEY)
    clearStorage(EMBEDDED_PWA_DEVICE_TOKEN_KEY)
    clearStorage(DEVICE_ID_KEY)
    clearStorage(NETWORK_IDENTITY_KEY)
  }
  return saved
}

function launchConfig() {
  const search = new URLSearchParams(location.search)
  const hash = new URLSearchParams(location.hash.replace(/^#/, ""))
  const rawPairCode = hash.get("pair") ?? search.get("pair")
  const pairCode = parseLinkPairCode(rawPairCode)
  const requested = search.get("server")?.trim() || undefined
  const trusted = loadTrustedPairing()
  const legacy = trusted.kind === "absent"
  const storedServer = trusted.kind === "valid" ? trusted.value.serverUrl : legacy ? readStorage(SERVER_URL_KEY) : undefined
  const baked = (import.meta.env.VITE_OPENCODE_SERVER_URL as string | undefined)?.trim() || undefined
  const storedToken = trusted.kind === "valid" ? trusted.value.token : legacy ? readStorage(DEVICE_TOKEN_KEY) ?? readStorage(EMBEDDED_PWA_DEVICE_TOKEN_KEY) : undefined
  const deviceID = trusted.kind === "valid" ? trusted.value.deviceID : legacy ? readStorage(DEVICE_ID_KEY) : undefined
  const networkIdentity = trusted.kind === "valid" ? trusted.value.networkIdentity : legacy ? readNetworkIdentity() : undefined

  if (rawPairCode !== null) {
    // Pair codes are bearer secrets. Strip them before any app/runtime code can
    // observe the address bar or a user can accidentally share the URL.
    hash.delete("pair")
    search.delete("pair")
    const query = search.toString()
    const fragment = hash.toString()
    history.replaceState(null, "", `${location.pathname}${query ? `?${query}` : ""}${fragment ? `#${fragment}` : ""}`)
  }

  // Dev traffic must stay on :3301 so every request crosses the verified
  // sidecar-binding proxy. Production is a true separate-origin client.
  const serverUrl = import.meta.env.DEV
    ? location.origin
    : pairCode
      ? requested || baked || storedServer
      : storedToken && storedServer
        ? storedServer
        : requested || storedServer || baked

  return { serverUrl, pairCode, storedToken, deviceID, networkIdentity }
}

export function MobileBootstrap() {
  const launch = launchConfig()
  const [serverUrl, setServerUrl] = createSignal(launch.serverUrl ?? "")
  const [code, setCode] = createSignal(launch.pairCode ?? "")
  const [connection, setConnection] = createSignal<Connection>()
  const [phase, setPhase] = createSignal<"booting" | "verifying" | "pair" | "pairing">("booting")
  const [error, setError] = createSignal("")
  const [camera, setCamera] = createSignal(false)
  const [advanced, setAdvanced] = createSignal(!launch.serverUrl)
  const [storageWarning, setStorageWarning] = createSignal("")
  let storedToken = launch.storedToken
  let storedDeviceID = launch.deviceID
  let storedIdentity = launch.networkIdentity
  const attempts = createAttemptGate()
  // Route transitions and PWA remounts can destroy this component while a
  // pairing, restore, or migration request remains outstanding.
  onCleanup(() => attempts.invalidate())

  const connect = (next: Connection) => {
    setConnection(next)
    setError("")
  }

  const pair = async (nextCode = code(), nextServer = serverUrl()) => {
    if (phase() === "pairing") return
    const attempt = attempts.start()
    const normalizedCode = normalizePairCode(nextCode)
    if (!validPairCode(normalizedCode)) {
      setError("Enter the 6-character code shown by OpenFork Desktop")
      setPhase("pair")
      return
    }

    let normalizedServer: string
    try {
      normalizedServer = normalizeServerUrl(nextServer, { allowInsecureRemote: import.meta.env.DEV })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Invalid server URL")
      setAdvanced(true)
      setPhase("pair")
      return
    }

    setPhase("pairing")
    setError("")
    try {
      const claimed = await claimPair(normalizedServer, normalizedCode, fetch, attempt.signal)
      if (!attempt.current()) return
      // Pairing has succeeded; overlap app parsing with the remaining storage and
      // render transition instead of starting the large shared runtime afterward.
      preloadPwaClient()
      // Commit endpoint, identity pin and token as ONE browser-storage record.
      // A tab kill can no longer produce a new token paired with an old pin.
      const saved = persistTrustedPairing({ serverUrl: normalizedServer, token: claimed.token,
        deviceID: claimed.deviceID, networkIdentity: claimed.networkIdentity })
      setStorageWarning(saved ? "" : "Paired for this session, but browser storage is unavailable. Scan a fresh QR after reopening.")
      storedToken = claimed.token
      storedDeviceID = claimed.deviceID
      storedIdentity = claimed.networkIdentity
      setServerUrl(normalizedServer)
      connect({
        serverUrl: normalizedServer,
        deviceToken: claimed.token,
        deviceID: claimed.deviceID,
        networkIdentity: claimed.networkIdentity,
      })
    } catch (cause) {
      if (!attempt.current()) return
      setError(cause instanceof Error ? cause.message : "Pairing failed")
      setPhase("pair")
    }
  }

  const forget = () => {
    // A late pairing claim, restore probe, or endpoint migration must never
    // revive credentials or connection state after explicit user revocation.
    attempts.invalidate()
    try { removeTrustedPairing(localStorage) } catch { /* storage unavailable */ }
    clearStorage(SERVER_URL_KEY)
    clearStorage(DEVICE_TOKEN_KEY)
    clearStorage(EMBEDDED_PWA_DEVICE_TOKEN_KEY)
    clearStorage(DEVICE_ID_KEY)
    clearStorage(NETWORK_IDENTITY_KEY)
    storedToken = undefined
    storedDeviceID = undefined
    storedIdentity = undefined
    setConnection(undefined)
    setCode("")
    setError("")
    setStorageWarning("")
    setCamera(false)
    setPhase("pair")
  }

  const restore = async () => {
    if (launch.pairCode && launch.serverUrl) {
      await pair(launch.pairCode, launch.serverUrl)
      return
    }
    const attempt = attempts.start()
    if (!serverUrl()) {
      setPhase("pair")
      return
    }

    let normalizedServer: string
    try {
      normalizedServer = normalizeServerUrl(serverUrl(), { allowInsecureRemote: import.meta.env.DEV })
    } catch {
      setPhase("pair")
      setAdvanced(true)
      return
    }

    if (storedToken && !canRestoreDeviceToken(storedToken, storedIdentity)) {
      // A legacy unpinned token cannot safely be sent for TOFU validation:
      // an endpoint replacement could capture the device secret first.
      setError("This older pairing has no trusted server identity. Re-pair using a fresh desktop QR code.")
      setPhase("pair")
      return
    }

    if (storedToken) {
      // The shared app bundle is static and contains no credential. Start loading
      // it while the public identity/credential probes run so a returning paired
      // device does not pay a verification -> bundle waterfall.
      preloadPwaClient()
      setPhase("verifying")
      setError("")
      let liveIdentity: NetworkIdentity | undefined

      // Once an OFXP identity has been pinned, the public identity probe is a
      // credential firewall: no device secret is sent until the endpoint proves
      // it is still the paired OpenFork node.
      if (storedIdentity) {
        liveIdentity = await probeNetworkIdentity(normalizedServer, fetch, attempt.signal)
        if (!attempt.current()) return
        if (!liveIdentity) {
          setError("The paired OpenFork Network identity is not reachable yet. No device credential was sent.")
          return
        }
        if (!sameNetworkIdentity(storedIdentity, liveIdentity)) {
          setError("This endpoint now presents a different OpenFork Network identity. Re-pair before sending credentials.")
          setPhase("pair")
          return
        }
      }

      const verdict = await credentialVerdict(normalizedServer, storedToken, fetch, attempt.signal)
      if (!attempt.current()) return
      if (verdict !== "invalid") {
        if (storedIdentity) {
          const saved = persistTrustedPairing({ serverUrl: normalizedServer, token: storedToken,
            deviceID: storedDeviceID, networkIdentity: storedIdentity })
          if (!saved) setStorageWarning("Browser storage is unavailable. This pairing may not survive a restart.")
        }
        connect({
          serverUrl: normalizedServer,
          deviceToken: storedToken,
          deviceID: storedDeviceID,
          networkIdentity: storedIdentity,
        })
        return
      }
      try { removeTrustedPairing(localStorage) } catch { /* storage unavailable */ }
      clearStorage(DEVICE_TOKEN_KEY)
      clearStorage(EMBEDDED_PWA_DEVICE_TOKEN_KEY)
      storedToken = undefined
      setError("This device pairing is no longer authorized. Pair it again from OpenFork Desktop.")
      setPhase("pair")
      return
    }

    // Preserve support for deliberately unauthenticated development servers.
    const anonymous = await credentialVerdict(normalizedServer, undefined, fetch, attempt.signal)
    if (!attempt.current()) return
    if (anonymous === "valid") {
      writeStorage(SERVER_URL_KEY, normalizedServer)
      connect({ serverUrl: normalizedServer })
      return
    }
    setPhase("pair")
  }

  const migrateEndpoint = async (nextUrl: string): Promise<PwaEndpointMigrationResult> => {
    const token = storedToken
    const pinned = storedIdentity
    if (!token) return "credential-invalid"
    if (!pinned) return "unpinned"
    const attempt = attempts.start()

    let normalized: string
    try {
      normalized = normalizeServerUrl(nextUrl, { allowInsecureRemote: import.meta.env.DEV })
    } catch {
      return "invalid-url"
    }
    if (normalized === serverUrl()) return "migrated"

    const verdict = pinnedIdentityVerdict(pinned, await probeNetworkIdentity(normalized, fetch, attempt.signal))
    if (!attempt.current()) return "unreachable"
    if (verdict !== "match") {
      if (verdict === "unavailable") return "identity-unavailable"
      if (verdict === "mismatch") return "identity-mismatch"
      return "unpinned"
    }

    const credential = await credentialVerdict(normalized, token, fetch, attempt.signal)
    if (!attempt.current()) return "unreachable"
    if (credential === "invalid") return "credential-invalid"
    if (credential !== "valid") return "unreachable"

    if (!persistTrustedPairing({ serverUrl: normalized, token, deviceID: storedDeviceID, networkIdentity: pinned }))
      return "unreachable"
    setServerUrl(normalized)
    connect({ serverUrl: normalized, deviceToken: token, deviceID: storedDeviceID, networkIdentity: pinned })
    return "migrated"
  }

  onMount(() => void restore())

  return (
    <Show
      when={connection()}
      keyed
      fallback={
        <div class="pwa-bootstrap">
          <Show
            when={phase() !== "booting"}
            fallback={
              <div class="pwa-bootstrap-spinner pwa-bootstrap-spinner--large" />
            }
          >
            <div class="pwa-bootstrap-card">
              <div class="pwa-bootstrap-heading">
                <div class="pwa-bootstrap-title">OpenFork Mobile</div>
                <div class="pwa-bootstrap-copy">
                  {phase() === "verifying"
                    ? "Verifying the pinned OpenFork Network identity before this device sends credentials."
                    : "Pair this device with OpenFork Desktop. Once connected, mobile uses the same session and rendering runtime as desktop."}
                </div>
              </div>

              <Show when={phase() === "verifying"}>
                <div class="pwa-verify-card">
                  <div class="pwa-verify-row">
                    <div class="pwa-bootstrap-spinner" />
                    <div class="pwa-verify-copy">
                      <div class="pwa-verify-title">Verifying trusted node</div>
                      <div class="pwa-verify-id">
                        {storedIdentity?.peerID ?? serverUrl()}
                      </div>
                    </div>
                  </div>
                  <Show when={error()}>
                    <div class="pwa-bootstrap-alert" role="alert">
                      {error()}
                    </div>
                    <div class="pwa-bootstrap-actions">
                      <button
                        type="button"
                        class="pwa-bootstrap-button pwa-bootstrap-button--primary"
                        onClick={() => void restore()}
                      >
                        Retry
                      </button>
                      <button
                        type="button"
                        class="pwa-bootstrap-button"
                        onClick={forget}
                      >
                        Pair again
                      </button>
                    </div>
                  </Show>
                </div>
              </Show>

              <Show when={phase() !== "verifying"}>
              <Show when={camera()}>
                <Suspense fallback={<div class="pwa-camera-skeleton" />}>
                  <PairingCamera
                    onError={(message) => setError(message)}
                    onPairCode={(value, discoveredServer) => {
                      const nextServer = discoveredServer ?? serverUrl()
                      setCode(normalizePairCode(value))
                      if (discoveredServer) setServerUrl(discoveredServer)
                      void pair(value, nextServer)
                    }}
                  />
                </Suspense>
              </Show>

              <div class="pwa-bootstrap-actions">
                <button
                  type="button"
                  class="pwa-bootstrap-button pwa-bootstrap-button--soft"
                  aria-pressed={camera()}
                  onClick={() => setCamera((value) => !value)}
                >
                  {camera() ? "Hide camera" : "Scan QR"}
                </button>
                <button
                  type="button"
                  class="pwa-bootstrap-button"
                  aria-expanded={advanced()}
                  onClick={() => setAdvanced((value) => !value)}
                >
                  {advanced() ? "Hide server" : "Server URL"}
                </button>
              </div>

              <form
                class="pwa-bootstrap-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  void pair()
                }}
              >
                <label class="pwa-bootstrap-field">
                  <span class="pwa-bootstrap-label">Pairing code</span>
                  <input
                    inputmode="text"
                    autocapitalize="characters"
                    autocomplete="one-time-code"
                    spellcheck={false}
                    value={code()}
                    placeholder="K7M2XQ"
                    class="pwa-bootstrap-input pwa-bootstrap-input--code"
                    onInput={(event) => {
                      setCode(normalizePairCode(event.currentTarget.value))
                      setError("")
                    }}
                  />
                </label>
                <Show when={advanced()}>
                  <label class="pwa-bootstrap-field">
                    <span class="pwa-bootstrap-label">Server URL</span>
                    <input
                      inputmode="url"
                      autocomplete="url"
                      value={serverUrl()}
                      placeholder="https://api.example.com"
                      class="pwa-bootstrap-input"
                      onInput={(event) => {
                        setServerUrl(event.currentTarget.value)
                        setError("")
                      }}
                    />
                  </label>
                </Show>
                <Show when={error()}>
                  <div
                    class="pwa-bootstrap-alert"
                    role="alert"
                  >
                    {error()}
                  </div>
                </Show>
                <button
                  type="submit"
                  disabled={phase() === "pairing"}
                  class="pwa-bootstrap-button pwa-bootstrap-button--primary pwa-bootstrap-submit"
                >
                  {phase() === "pairing" ? "Pairing…" : "Connect"}
                </button>
              </form>

              <div class="pwa-bootstrap-security">
                <span class="pwa-bootstrap-security-dot" aria-hidden="true" />
                <p>
                  Pairing creates a device-scoped credential. After first trust, reconnects verify the pinned OpenFork
                  Network identity before that credential is sent.
                </p>
              </div>
              </Show>
            </div>
          </Show>
        </div>
      }
    >
      {(current) => (
        <Suspense
          fallback={
            <div class="pwa-bootstrap pwa-bootstrap-loading">
              <div class="pwa-bootstrap-spinner pwa-bootstrap-spinner--large" />
            </div>
          }
        >
          <Show when={storageWarning()}>
            <div class="pwa-bootstrap-alert" role="alert">{storageWarning()}</div>
          </Show>
          <PwaClientApp
            serverUrl={current.serverUrl}
            deviceToken={current.deviceToken}
            deviceID={current.deviceID}
            networkIdentity={current.networkIdentity}
            onForgetDevice={forget}
            migrateEndpoint={migrateEndpoint}
          />
        </Suspense>
      )}
    </Show>
  )
}
