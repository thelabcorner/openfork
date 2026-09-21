import type {
  OfxpGrant,
  OfxpSettingsPeerOverview,
  OfxpSettingsRecentActivity,
  OfxpSettingsState,
} from "@opencode-ai/sdk/v2/client"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { SelectV2 } from "@opencode-ai/ui/v2/select-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import {
  For,
  Show,
  createContext,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  untrack,
  useContext,
  type JSX,
} from "solid-js"
import { createStore } from "solid-js/store"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { ServerConnection, serverName } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import "./settings-v2.css"

type BusyAction =
  | "runtime"
  | "refresh"
  | "rotateIdentity"
  | "finalizeIdentityRotation"
  | `pair:${string}`
  | `pairing:${string}`
  | `grant:${string}`
  | `root:${string}`
  | `revoke:${string}`

type OfxpServerConnectionsUi = {
  state: () => OfxpSettingsState | undefined
  busy: () => boolean
  beginPairing: (peerID: string) => void
  focusPeer: (peerID: string) => void
  focusPairing: (peerID: string) => void
  enableNetwork: () => void
}

const OfxpServerConnectionsContext = createContext<OfxpServerConnectionsUi>()

export function useOfxpServerConnectionsUi() {
  return useContext(OfxpServerConnectionsContext)
}

const emptyGrant = (): OfxpGrant => ({
  read: false,
  write: false,
  git: false,
  process: false,
  integrations: false,
  browser: false,
  filesReceive: false,
  filesSend: false,
  automation: false,
  messaging: false,
  sessionSupervision: "none",
  requestSupervision: false,
  delegation: "disabled",
  nestedDelegation: false,
})

const grantRows = [
  ["read", "settings.ofxp.capability.read.title", "settings.ofxp.capability.read.description"],
  ["write", "settings.ofxp.capability.write.title", "settings.ofxp.capability.write.description"],
  ["git", "settings.ofxp.capability.git.title", "settings.ofxp.capability.git.description"],
  ["process", "settings.ofxp.capability.process.title", "settings.ofxp.capability.process.description"],
  ["integrations", "settings.ofxp.capability.integrations.title", "settings.ofxp.capability.integrations.description"],
  ["browser", "settings.ofxp.capability.browser.title", "settings.ofxp.capability.browser.description"],
  ["filesReceive", "settings.ofxp.capability.filesReceive.title", "settings.ofxp.capability.filesReceive.description"],
  ["filesSend", "settings.ofxp.capability.filesSend.title", "settings.ofxp.capability.filesSend.description"],
  ["automation", "settings.ofxp.capability.automation.title", "settings.ofxp.capability.automation.description"],
  ["messaging", "settings.ofxp.capability.messaging.title", "settings.ofxp.capability.messaging.description"],
] as const

type BooleanGrantKey = (typeof grantRows)[number][0] | "requestSupervision" | "nestedDelegation"

function activityStateKey(state: OfxpSettingsRecentActivity["state"]) {
  switch (state) {
    case "admitted":
      return "settings.ofxp.activity.state.admitted" as const
    case "started":
      return "settings.ofxp.activity.state.started" as const
    case "committed":
      return "settings.ofxp.activity.state.committed" as const
    case "failed":
      return "settings.ofxp.activity.state.failed" as const
    case "cancelled":
      return "settings.ofxp.activity.state.cancelled" as const
  }
}

function activityCommitKey(commitClass: OfxpSettingsRecentActivity["commitClass"]) {
  switch (commitClass) {
    case "safe_read":
      return "settings.ofxp.activity.commit.safeRead" as const
    case "idempotent_mutation":
      return "settings.ofxp.activity.commit.idempotent" as const
    case "non_idempotent_mutation":
      return "settings.ofxp.activity.commit.nonIdempotent" as const
    case "durable_start":
      return "settings.ofxp.activity.commit.durableStart" as const
  }
}

function shortID(value: string | undefined) {
  if (!value) return "—"
  if (value.length <= 18) return value
  return `${value.slice(0, 8)}…${value.slice(-8)}`
}

function endpointLabel(endpoint: { host: string; port: number } | undefined) {
  if (!endpoint) return "—"
  const host = endpoint.host.includes(":") ? `[${endpoint.host}]` : endpoint.host
  return `${host}:${endpoint.port}`
}

function aliasFromPath(value: string) {
  const leaf = value.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || "root"
  const alias = leaf.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[^a-z0-9]+/, "").slice(0, 32)
  return alias || "root"
}

function enabledGrantCount(grant: OfxpGrant) {
  return [
    grant.read,
    grant.write,
    grant.git,
    grant.process,
    grant.integrations,
    grant.browser,
    grant.filesReceive,
    grant.filesSend,
    grant.automation,
    grant.messaging,
    grant.sessionSupervision !== "none",
    grant.requestSupervision,
    grant.delegation !== "disabled",
    grant.nestedDelegation,
  ].filter(Boolean).length
}

function hasGlobalGrant(grant: OfxpGrant) {
  return grant.messaging || grant.integrations || grant.browser
}

function hasRootScopedGrant(grant: OfxpGrant) {
  return [
    grant.read,
    grant.write,
    grant.git,
    grant.process,
    grant.filesReceive,
    grant.filesSend,
    grant.automation,
    grant.sessionSupervision !== "none",
    grant.requestSupervision,
    grant.delegation !== "disabled",
    grant.nestedDelegation,
  ].some(Boolean)
}

function hasEffectiveAuthority(peer: OfxpSettingsPeerOverview, now: number) {
  if (peer.info.rekeyState !== "stable") return false
  if (peer.info.grantExpiresAt !== undefined && peer.info.grantExpiresAt <= now) return false
  return hasGlobalGrant(peer.grant) || (peer.roots.length > 0 && hasRootScopedGrant(peer.grant))
}

export const OfxpNetworkSettingsV2 = (props: { children?: JSX.Element }) => {
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const [store, setStore] = createStore<{
    state?: OfxpSettingsState
    loading: boolean
    error?: string
    busy?: BusyAction
    expandedPeerID?: string
    confirmingRevokePeerID?: string
    confirmingRotateIdentity: boolean
    confirmingFinalizeRotation: boolean
    projectPath: string
  }>({
    loading: true,
    confirmingRotateIdentity: false,
    confirmingFinalizeRotation: false,
    projectPath: "",
  })
  const [authorityNow, setAuthorityNow] = createSignal(Date.now())
  let disposed = false
  let refreshTimer: ReturnType<typeof setInterval> | undefined
  let expiryTimer: ReturnType<typeof setTimeout> | undefined
  let stateRequestID = 0
  let busyRequestID = 0

  /**
   * Settings backend authority comes exclusively from the scoped providers.
   * Route/dialog server selection, API calls, project projection, and locality
   * must never drift onto the legacy independent settings server picker.
   */
  const scopedServer = createMemo(() => serverSDK().server)
  const scopedServerKey = createMemo(() => ServerConnection.key(scopedServer()))
  const api = () => serverSDK().client.ofxp
  const projects = createMemo(() =>
    serverSync().data.project.map((project) => ({
      path: project.worktree,
      label: project.name || project.worktree,
    })),
  )
  const selectedProject = createMemo(() => projects().find((project) => project.path === store.projectPath))

  const apply = (next: OfxpSettingsState) => {
    if (disposed) return
    setStore("state", next)
    setStore("error", undefined)
    if (store.expandedPeerID && !next.peers.some((peer) => peer.info.id === store.expandedPeerID)) {
      setStore("expandedPeerID", undefined)
    }
    if (store.confirmingRevokePeerID && !next.peers.some((peer) => peer.info.id === store.confirmingRevokePeerID)) {
      setStore("confirmingRevokePeerID", undefined)
    }
    if (!next.status.active || next.status.rotation) setStore("confirmingRotateIdentity", false)
    if (!next.status.rotation) setStore("confirmingFinalizeRotation", false)
  }

  const load = async (silent = false) => {
    const current = api()
    if (!current || store.busy === "refresh") return
    const requestID = ++stateRequestID
    if (!silent) setStore("loading", true)
    try {
      const response = await current.state({ throwOnError: true })
      if (requestID === stateRequestID && response.data) apply(response.data)
    } catch (error) {
      if (requestID === stateRequestID && !silent) {
        setStore("error", error instanceof Error ? error.message : language.t("settings.ofxp.loadFailed"))
      }
    } finally {
      if (requestID === stateRequestID && !silent && !disposed) setStore("loading", false)
    }
  }

  createEffect(() => {
    scopedServerKey()
    stateRequestID += 1
    busyRequestID += 1
    setStore({
      state: undefined,
      loading: true,
      error: undefined,
      busy: undefined,
      expandedPeerID: undefined,
      confirmingRevokePeerID: undefined,
      confirmingRotateIdentity: false,
      confirmingFinalizeRotation: false,
      projectPath: "",
    })
    untrack(() => void load())
  })

  createEffect(() => {
    const active = store.state?.status.active === true
    if (refreshTimer !== undefined) clearInterval(refreshTimer)
    refreshTimer = active
      ? setInterval(() => {
          if (!store.busy) void load(true)
        }, 5000)
      : undefined
  })

  onCleanup(() => {
    disposed = true
    if (refreshTimer !== undefined) clearInterval(refreshTimer)
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
  })

  const run = async (busy: BusyAction, action: () => Promise<{ data?: OfxpSettingsState }>) => {
    if (store.busy) return false
    setStore("busy", busy)
    const busyID = ++busyRequestID
    const requestID = ++stateRequestID
    try {
      const response = await action()
      if (requestID !== stateRequestID) return false
      if (response.data) apply(response.data)
      return true
    } catch (error) {
      if (requestID !== stateRequestID) return false
      showToast({
        variant: "error",
        title: language.t("settings.ofxp.actionFailed"),
        description: error instanceof Error ? error.message : undefined,
      })
      // Mutations are revision-fenced. Reconcile the one compact settings
      // projection after any failure so stale peer controls never remain armed.
      if (busy !== "refresh") await load(true)
      return false
    } finally {
      if (!disposed && busyID === busyRequestID) setStore("busy", undefined)
    }
  }

  const state = () => store.state
  const peers = () => state()?.peers ?? []
  const pairings = () => state()?.pairings ?? []
  const rotationJournal = () => state()?.status.rotation
  const rotationExpired = () => {
    const rotation = rotationJournal()
    return rotation ? rotation.expired || rotation.expiresAt <= authorityNow() : false
  }
  const activeRotation = () => {
    const rotation = rotationJournal()
    return rotation && !rotationExpired() ? rotation : undefined
  }
  createEffect(() => {
    const now = authorityNow()
    if (expiryTimer !== undefined) clearTimeout(expiryTimer)
    let nextExpiry = peers().reduce<number | undefined>((nearest, peer) => {
      const expiry = peer.info.grantExpiresAt
      if (expiry === undefined || expiry <= now) return nearest
      return nearest === undefined || expiry < nearest ? expiry : nearest
    }, undefined)
    const rotationExpiry = state()?.status.rotation?.expiresAt
    if (rotationExpiry !== undefined && rotationExpiry > now) {
      nextExpiry = nextExpiry === undefined || rotationExpiry < nextExpiry ? rotationExpiry : nextExpiry
    }
    expiryTimer =
      nextExpiry === undefined
        ? undefined
        : setTimeout(
            () => setAuthorityNow(Date.now()),
            Math.min(Math.max(nextExpiry - Date.now() + 25, 0), 2_147_483_647),
          )
  })
  const nearby = createMemo(() => {
    const trusted = new Set(peers().map((peer) => peer.info.id))
    const pending = new Set(pairings().map((pairing) => pairing.peer.id))
    return (state()?.candidates ?? []).filter((candidate) => !trusted.has(candidate.peerID) && !pending.has(candidate.peerID))
  })
  // Presence is producer-owned and may come from discovery or an already
  // authenticated pooled connection. It is not itself an identity signal.
  const presentTrustedCount = createMemo(() => peers().filter((peer) => peer.online).length)
  const authorizedCount = createMemo(() => {
    const now = authorityNow()
    return peers().filter((peer) => hasEffectiveAuthority(peer, now)).length
  })
  const selectedName = createMemo(() => {
    return serverName(scopedServer()) || language.t("settings.ofxp.runtime.unknown")
  })
  const dateTimeFormat = createMemo(
    () => new Intl.DateTimeFormat(language.intl(), { dateStyle: "medium", timeStyle: "short" }),
  )

  const formatWhen = (value: number | undefined) => {
    if (!value) return language.t("settings.ofxp.never")
    return dateTimeFormat().format(value)
  }

  const setRuntime = (enabled: boolean) => {
    const current = api()
    if (!current) return
    void run("runtime", () =>
      current.runtime({ ofxpSettingsRuntimePayload: { enabled } }, { throwOnError: true }),
    )
  }

  const refresh = () => {
    const current = api()
    if (!current) return
    void run("refresh", () => current.state({ throwOnError: true }))
  }

  const rotateIdentity = () => {
    const current = api()
    const peerID = state()?.status.peerID
    if (!current || !peerID) return
    void run("rotateIdentity", () =>
      current.rotateIdentity(
        { ofxpSettingsIdentityMutationPayload: { expectedPeerID: peerID } },
        { throwOnError: true },
      ),
    ).then((rotated) => {
      if (!rotated) return
      setStore("confirmingRotateIdentity", false)
      showToast({
        variant: "success",
        icon: "check",
        title: language.t("settings.ofxp.rotation.rotated"),
      })
    })
  }

  const finalizeIdentityRotation = () => {
    const current = api()
    const peerID = state()?.status.peerID
    if (!current || !peerID) return
    void run("finalizeIdentityRotation", () =>
      current.finalizeIdentityRotation(
        { ofxpSettingsIdentityMutationPayload: { expectedPeerID: peerID } },
        { throwOnError: true },
      ),
    ).then((finalized) => {
      if (!finalized) return
      setStore("confirmingFinalizeRotation", false)
      showToast({
        variant: "success",
        icon: "check",
        title: language.t("settings.ofxp.rotation.finalized"),
      })
    })
  }

  const beginPairing = (peerID: string) => {
    const current = api()
    if (!current) return
    void run(`pair:${peerID}`, () => current.pair({ peerID }, { throwOnError: true }))
  }

  const confirmPairing = (pairingID: string) => {
    const current = api()
    if (!current) return
    void run(`pairing:${pairingID}`, () => current.pairing.confirm({ pairingID }, { throwOnError: true }))
  }

  const cancelPairing = (pairingID: string) => {
    const current = api()
    if (!current) return
    void run(`pairing:${pairingID}`, () => current.pairing.cancel({ pairingID }, { throwOnError: true }))
  }

  const replaceGrant = (peer: OfxpSettingsPeerOverview, grant: OfxpGrant) => {
    const current = api()
    if (!current) return
    void run(`grant:${peer.info.id}`, () =>
      current.peer.grant(
        {
          peerID: peer.info.id,
          ofxpSettingsGrantPayload: { expectedRevision: peer.info.grantRevision, grant },
        },
        { throwOnError: true },
      ),
    )
  }

  const setBooleanGrant = (peer: OfxpSettingsPeerOverview, key: BooleanGrantKey, value: boolean) => {
    replaceGrant(peer, { ...peer.grant, [key]: value })
  }

  const applyPreset = (peer: OfxpSettingsPeerOverview, preset: "none" | "messaging" | "collaborate") => {
    const grant = emptyGrant()
    if (preset === "messaging") grant.messaging = true
    if (preset === "collaborate") {
      grant.read = true
      grant.messaging = true
      grant.delegation = "spawn"
    }
    replaceGrant(peer, grant)
  }

  const addProjectRoot = (peer: OfxpSettingsPeerOverview) => {
    const current = api()
    const project = selectedProject()
    if (!current || !project) return
    void run(`root:${peer.info.id}`, () =>
      current.peer.root.add(
        {
          peerID: peer.info.id,
          ofxpSettingsRootPayload: {
            expectedRevision: peer.info.grantRevision,
            alias: aliasFromPath(project.path),
            canonicalPath: project.path,
            source: "project",
          },
        },
        { throwOnError: true },
      ),
    )
  }

  const addLocalFolder = async (peer: OfxpSettingsPeerOverview) => {
    const current = api()
    if (!current || platform.platform !== "desktop" || !ServerConnection.local(scopedServer())) return
    const selection = await platform.openDirectoryPickerDialog({ title: language.t("settings.ofxp.roots.pick") })
    const path = Array.isArray(selection) ? selection[0] : selection
    if (!path) return
    await run(`root:${peer.info.id}`, () =>
      current.peer.root.add(
        {
          peerID: peer.info.id,
          ofxpSettingsRootPayload: {
            expectedRevision: peer.info.grantRevision,
            alias: aliasFromPath(path),
            canonicalPath: path,
            source: "manual",
          },
        },
        { throwOnError: true },
      ),
    )
  }

  const removeRoot = (peerID: string, rootID: string) => {
    const current = api()
    if (!current) return
    void run(`root:${peerID}`, () => current.peer.root.remove({ peerID, rootID }, { throwOnError: true }))
  }

  const revoke = (peer: OfxpSettingsPeerOverview) => {
    const current = api()
    if (!current) return
    void run(`revoke:${peer.info.id}`, () =>
      current.peer.revoke(
        {
          peerID: peer.info.id,
          ofxpSettingsRevokePayload: { expectedRevision: peer.info.grantRevision },
        },
        { throwOnError: true },
      ),
    ).then((revoked) => {
      if (!revoked) return
      setStore("confirmingRevokePeerID", undefined)
      showToast({ variant: "success", icon: "check", title: language.t("settings.ofxp.revoke.revoked") })
    })
  }

  const scrollTo = (selector: string) => {
    queueMicrotask(() => {
      document.querySelector<HTMLElement>(selector)?.scrollIntoView({ behavior: "smooth", block: "center" })
    })
  }

  const serverConnectionsUi: OfxpServerConnectionsUi = {
    state,
    busy: () => !!store.busy,
    beginPairing,
    focusPeer(peerID) {
      setStore("expandedPeerID", peerID)
      setStore("projectPath", "")
      scrollTo(`[data-ofxp-peer-id="${peerID}"]`)
    },
    focusPairing(peerID) {
      scrollTo(`[data-ofxp-pairing-peer-id="${peerID}"]`)
    },
    enableNetwork() {
      setRuntime(true)
    },
  }

  return (
    <OfxpServerConnectionsContext.Provider value={serverConnectionsUi}>
      <>
      <div class="settings-v2-tab-header settings-v2-ofxp-header">
        <div class="settings-v2-tab-header-row">
          <div class="settings-v2-ofxp-title-group">
            <h2 class="settings-v2-tab-title">{language.t("settings.ofxp.title")}</h2>
            <Tag>OFXP</Tag>
          </div>
          <div class="settings-v2-ofxp-master-toggle">
            <span>{language.t("settings.ofxp.enable")}</span>
            <Switch
              checked={state()?.status.active === true}
              disabled={store.loading || !!store.busy || !api()}
              onChange={setRuntime}
              hideLabel
            >
              {language.t("settings.ofxp.enable")}
            </Switch>
          </div>
        </div>
        <p class="settings-v2-ofxp-intro">{language.t("settings.ofxp.description")}</p>
      </div>

      <div class="settings-v2-tab-body settings-v2-ofxp-network">
        <Show
          when={!store.loading && state()}
          fallback={
            <div class="settings-v2-ofxp-loading" role="status" aria-live="polite">
              <Show
                when={store.loading}
                fallback={
                  <>
                    <span>{store.error ?? language.t("settings.ofxp.loadFailed")}</span>
                    <ButtonV2 size="small" variant="outline" disabled={!api()} onClick={() => void load()}>
                      {language.t("settings.ofxp.retry")}
                    </ButtonV2>
                  </>
                }
              >
                <Spinner />
                <span>{language.t("settings.ofxp.loading")}</span>
              </Show>
            </div>
          }
        >
          {(current) => (
            <>
              <div
                class="settings-v2-ofxp-hero"
                data-state={
                  current().status.active
                    ? current().status.discovery === "degraded"
                      ? "degraded"
                      : "active"
                    : "disabled"
                }
              >
                <div class="settings-v2-ofxp-hero-main">
                  <div class="settings-v2-ofxp-status-mark">
                    <Icon name="server" />
                    <span class="settings-v2-ofxp-status-dot" />
                  </div>
                  <div class="settings-v2-ofxp-hero-copy">
                    <span class="settings-v2-ofxp-hero-eyebrow">{language.t("settings.ofxp.thisDevice")}</span>
                    <strong class="settings-v2-ofxp-hero-title">
                      {current().status.label ?? selectedName()}
                    </strong>
                    <span class="settings-v2-ofxp-hero-backend">
                      {language.t("settings.ofxp.runtime.backend", { name: selectedName() })}
                    </span>
                    <span class="settings-v2-ofxp-hero-detail">
                      {current().status.active
                        ? language.t("settings.ofxp.runtime.ready", {
                            port: current().status.port ?? 0,
                            id: shortID(current().status.peerID),
                          })
                        : language.t("settings.ofxp.runtime.disabled")}
                    </span>
                    <Show when={!current().status.active}>
                      <span class="settings-v2-ofxp-hero-note">{language.t("settings.ofxp.runtime.enableNote")}</span>
                    </Show>
                    <Show when={current().status.discoveryError}>
                      {(error) => <span class="settings-v2-ofxp-inline-error" role="status">{error()}</span>}
                    </Show>
                  </div>
                </div>
                <div class="settings-v2-ofxp-hero-actions">
                  <ButtonV2
                    size="small"
                    variant="outline"
                    icon="refresh"
                    disabled={!!store.busy}
                    onClick={refresh}
                  >
                    {language.t("settings.ofxp.refresh")}
                  </ButtonV2>
                  <Show
                    when={
                      current().status.active &&
                      current().status.identityRotationSupported === true &&
                      !rotationJournal()
                    }
                  >
                    <ButtonV2
                      size="small"
                      variant="outline"
                      disabled={!!store.busy}
                      onClick={() => setStore("confirmingRotateIdentity", true)}
                    >
                      {language.t("settings.ofxp.rotation.action")}
                    </ButtonV2>
                  </Show>
                </div>
                <Show when={rotationJournal()}>
                  {(rotation) => (
                    <div
                      class="settings-v2-ofxp-rotation-status"
                      data-expired={rotationExpired() ? "true" : "false"}
                      role="status"
                    >
                      <Icon name="warning" size="small" />
                      <div class="settings-v2-ofxp-rotation-status-copy">
                        <strong>
                          {language.t(
                            rotationExpired()
                              ? "settings.ofxp.rotation.expiredTitle"
                              : "settings.ofxp.rotation.activeTitle",
                          )}
                        </strong>
                        <span>
                          {language.t(
                            rotationExpired()
                              ? "settings.ofxp.rotation.expiredDescription"
                              : "settings.ofxp.rotation.activeDescription",
                            {
                              peer: shortID(rotation().previousPeerID),
                              time: formatWhen(rotation().expiresAt),
                            },
                          )}
                        </span>
                      </div>
                      <ButtonV2
                        size="small"
                        variant={rotationExpired() ? "warning" : "outline"}
                        disabled={!!store.busy}
                        onClick={() => setStore("confirmingFinalizeRotation", true)}
                      >
                        {language.t(
                          rotationExpired()
                            ? "settings.ofxp.rotation.clearExpired"
                            : "settings.ofxp.rotation.finish",
                        )}
                      </ButtonV2>
                    </div>
                  )}
                </Show>
                <Show
                  when={
                    store.confirmingRotateIdentity &&
                    current().status.active &&
                    current().status.identityRotationSupported === true &&
                    !rotationJournal()
                  }
                >
                  <div class="settings-v2-ofxp-rotation-confirm" role="alert">
                    <Icon name="warning" size="small" />
                    <div class="settings-v2-ofxp-rotation-confirm-copy">
                      <strong>{language.t("settings.ofxp.rotation.confirmTitle")}</strong>
                      <span>{language.t("settings.ofxp.rotation.confirmDescription")}</span>
                    </div>
                    <div class="settings-v2-ofxp-rotation-confirm-actions">
                      <ButtonV2
                        size="small"
                        variant="ghost-muted"
                        disabled={!!store.busy}
                        onClick={() => setStore("confirmingRotateIdentity", false)}
                      >
                        {language.t("common.cancel")}
                      </ButtonV2>
                      <ButtonV2
                        size="small"
                        variant="danger"
                        disabled={!!store.busy}
                        onClick={rotateIdentity}
                      >
                        {language.t("settings.ofxp.rotation.confirm")}
                      </ButtonV2>
                    </div>
                  </div>
                </Show>
                <Show
                  when={
                    store.confirmingFinalizeRotation &&
                    current().status.active &&
                    current().status.rotation
                  }
                >
                  <div class="settings-v2-ofxp-rotation-confirm" role="alert">
                    <Icon name="warning" size="small" />
                    <div class="settings-v2-ofxp-rotation-confirm-copy">
                      <strong>
                        {language.t(
                          rotationExpired()
                            ? "settings.ofxp.rotation.finalizeExpiredTitle"
                            : "settings.ofxp.rotation.finalizeTitle",
                        )}
                      </strong>
                      <span>
                        {language.t(
                          rotationExpired()
                            ? "settings.ofxp.rotation.finalizeExpiredDescription"
                            : "settings.ofxp.rotation.finalizeDescription",
                        )}
                      </span>
                    </div>
                    <div class="settings-v2-ofxp-rotation-confirm-actions">
                      <ButtonV2
                        size="small"
                        variant="ghost-muted"
                        disabled={!!store.busy}
                        onClick={() => setStore("confirmingFinalizeRotation", false)}
                      >
                        {language.t("common.cancel")}
                      </ButtonV2>
                      <ButtonV2
                        size="small"
                        variant="danger"
                        disabled={!!store.busy}
                        onClick={finalizeIdentityRotation}
                      >
                        {language.t("settings.ofxp.rotation.finalizeConfirm")}
                      </ButtonV2>
                    </div>
                  </div>
                </Show>
                <div class="settings-v2-ofxp-hero-stats">
                  <div><strong>{peers().length}</strong><span>{language.t("settings.ofxp.stats.trusted")}</span></div>
                  <div><strong>{presentTrustedCount()}</strong><span>{language.t("settings.ofxp.stats.online")}</span></div>
                  <div><strong>{nearby().length}</strong><span>{language.t("settings.ofxp.stats.nearby")}</span></div>
                  <div><strong>{authorizedCount()}</strong><span>{language.t("settings.ofxp.stats.authorized")}</span></div>
                </div>
              </div>

              <Show when={pairings().length > 0}>
                <div class="settings-v2-section settings-v2-ofxp-pairing-section">
                  <div class="settings-v2-ofxp-section-heading">
                    <div>
                      <h3 class="settings-v2-section-title">{language.t("settings.ofxp.pairing.title")}</h3>
                      <p>{language.t("settings.ofxp.pairing.description")}</p>
                    </div>
                    <Tag>{language.t("settings.ofxp.pairing.pending")}</Tag>
                  </div>
                  <For each={pairings()}>
                    {(pairing) => (
                      <div class="settings-v2-ofxp-pairing-card" data-ofxp-pairing-peer-id={pairing.peer.id}>
                        <div class="settings-v2-ofxp-pairing-copy">
                          <strong>{pairing.peer.label}</strong>
                          <span>{shortID(pairing.peer.id)} · {shortID(pairing.peer.fingerprint)}</span>
                        </div>
                        <div
                          class="settings-v2-ofxp-sas"
                          aria-label={language.t("settings.ofxp.pairing.codeLabel", { code: pairing.sas })}
                        >
                          {pairing.sas}
                        </div>
                        <p>{language.t("settings.ofxp.pairing.compare")}</p>
                        <Show when={pairing.continuityClaim}>
                          {(claim) => (
                            <div class="settings-v2-ofxp-pairing-continuity" role="status">
                              <Icon name="warning" size="small" />
                              <div>
                                <strong>{language.t("settings.ofxp.pairing.continuityTitle")}</strong>
                                <span>
                                  {language.t("settings.ofxp.pairing.continuityDescription", {
                                    peer: shortID(claim().previousPeerID),
                                    time: formatWhen(claim().expiresAt),
                                  })}
                                </span>
                              </div>
                            </div>
                          )}
                        </Show>
                        <span class="settings-v2-ofxp-pairing-expiry">
                          {language.t("settings.ofxp.pairing.expires", { time: formatWhen(pairing.expiresAt) })}
                        </span>
                        <div class="settings-v2-ofxp-pairing-actions">
                          <ButtonV2 size="small" variant="contrast" disabled={!!store.busy} onClick={() => confirmPairing(pairing.pairingID)}>
                            {language.t("settings.ofxp.pairing.confirm")}
                          </ButtonV2>
                          <ButtonV2 size="small" variant="ghost-muted" disabled={!!store.busy} onClick={() => cancelPairing(pairing.pairingID)}>
                            {language.t("common.cancel")}
                          </ButtonV2>
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>

              <div class="settings-v2-section">
                <div class="settings-v2-ofxp-section-heading">
                  <div>
                    <h3 class="settings-v2-section-title">{language.t("settings.ofxp.peers.title")}</h3>
                    <p>{language.t("settings.ofxp.peers.description")}</p>
                  </div>
                </div>
                <Show
                  when={peers().length > 0}
                  fallback={<div class="settings-v2-ofxp-empty"><Icon name="link" /><strong>{language.t("settings.ofxp.peers.empty")}</strong><span>{language.t("settings.ofxp.peers.emptyDescription")}</span></div>}
                >
                  <div class="settings-v2-ofxp-peer-list">
                    <For each={peers()}>
                      {(peer) => {
                        const expanded = () => store.expandedPeerID === peer.info.id
                        const authorityLocked = () => peer.info.rekeyState === "required"
                        const grantExpired = () =>
                          peer.info.grantExpiresAt !== undefined && peer.info.grantExpiresAt <= authorityNow()
                        const rootScopedAuthorityPending = () =>
                          !authorityLocked() &&
                          !grantExpired() &&
                          peer.roots.length === 0 &&
                          hasRootScopedGrant(peer.grant)
                        const recentActivity = () =>
                          state()?.activity.find((activity) => activity.sourcePeerID === peer.info.id)
                        const confirmingRevoke = () => store.confirmingRevokePeerID === peer.info.id
                        return (
                          <div
                            class="settings-v2-ofxp-peer-card"
                            data-ofxp-peer-id={peer.info.id}
                            data-expanded={expanded() ? "true" : "false"}
                            data-rekey={peer.info.rekeyState}
                          >
                            <button
                              type="button"
                              class="settings-v2-ofxp-peer-summary"
                              aria-expanded={expanded()}
                              onClick={() => {
                                setStore("expandedPeerID", expanded() ? undefined : peer.info.id)
                                setStore("projectPath", "")
                              }}
                            >
                              <span class="settings-v2-ofxp-peer-presence" data-online={peer.online ? "true" : "false"} />
                              <span class="settings-v2-ofxp-peer-copy">
                                <span class="settings-v2-ofxp-peer-name-row">
                                  <strong>{peer.info.label}</strong>
                                  <Show when={peer.info.rekeyState === "required"}>
                                    <Tag>{language.t("settings.ofxp.peers.identityChanged")}</Tag>
                                  </Show>
                                  <Show when={hasEffectiveAuthority(peer, authorityNow())}>
                                    <Tag>{language.t("settings.ofxp.peers.authorized")}</Tag>
                                  </Show>
                                  <Show when={grantExpired()}>
                                    <Tag>{language.t("settings.ofxp.peers.expired")}</Tag>
                                  </Show>
                                </span>
                                <span>
                                  {peer.authenticatedEndpoint
                                    ? language.t("settings.ofxp.peers.connected")
                                    : peer.online
                                      ? language.t("settings.ofxp.peers.online")
                                      : language.t("settings.ofxp.peers.offline")}
                                  {" · "}{language.t("settings.ofxp.peers.rootsCount", { count: peer.roots.length })}
                                  {" · "}{language.t("settings.ofxp.peers.grantsCount", { count: enabledGrantCount(peer.grant) })}
                                </span>
                              </span>
                              <Icon name="chevron-down" size="small" class={expanded() ? "rotate-180" : ""} />
                            </button>

                            <Show when={expanded()}>
                              <div class="settings-v2-ofxp-peer-detail">
                                <Show when={authorityLocked()}>
                                  <div class="settings-v2-ofxp-authority-notice" role="alert">
                                    <Icon name="warning" size="small" />
                                    <div>
                                      <strong>{language.t("settings.ofxp.peer.rekey.title")}</strong>
                                      <span>{language.t("settings.ofxp.peer.rekey.description")}</span>
                                    </div>
                                  </div>
                                </Show>
                                <Show when={peer.info.grantExpiresAt}>
                                  {(expiresAt) => (
                                    <div class="settings-v2-ofxp-authority-notice" role="status">
                                      <Icon name="warning" size="small" />
                                      <div>
                                        <strong>{language.t("settings.ofxp.peer.expiry.title")}</strong>
                                        <span>
                                          {language.t(
                                            grantExpired()
                                              ? "settings.ofxp.peer.expiry.expiredDescription"
                                              : "settings.ofxp.peer.expiry.description",
                                            { time: formatWhen(expiresAt()) },
                                          )}
                                        </span>
                                      </div>
                                    </div>
                                  )}
                                </Show>
                                <Show when={rootScopedAuthorityPending()}>
                                  <div class="settings-v2-ofxp-authority-notice" role="status">
                                    <Icon name="warning" size="small" />
                                    <div>
                                      <strong>{language.t("settings.ofxp.peer.rootScope.title")}</strong>
                                      <span>{language.t("settings.ofxp.peer.rootScope.description")}</span>
                                    </div>
                                  </div>
                                </Show>

                                <div class="settings-v2-ofxp-peer-facts">
                                  <div><span>{language.t("settings.ofxp.peer.fingerprint")}</span><code>{peer.info.fingerprint}</code></div>
                                  <div><span>{language.t("settings.ofxp.peer.paired")}</span><strong>{formatWhen(peer.info.pairedAt)}</strong></div>
                                  <div><span>{language.t("settings.ofxp.peer.lastSeen")}</span><strong>{formatWhen(peer.info.lastSeenAt)}</strong></div>
                                  <div><span>{language.t("settings.ofxp.peer.version")}</span><strong>{peer.openforkVersion ? `v${peer.openforkVersion}` : "—"}</strong></div>
                                  <div><span>{language.t("settings.ofxp.peer.protocol")}</span><strong>{peer.protocolVersion ? `OFXP v${peer.protocolVersion}` : "—"}</strong></div>
                                  <div><span>{language.t("settings.ofxp.peer.endpoint")}</span><code>{endpointLabel(peer.authenticatedEndpoint)}</code></div>
                                </div>

                                <Show when={recentActivity()}>
                                  {(activity) => (
                                    <div class="settings-v2-ofxp-subsection">
                                      <div class="settings-v2-ofxp-subsection-heading">
                                        <div>
                                          <strong>{language.t("settings.ofxp.activity.title")}</strong>
                                          <span>{language.t("settings.ofxp.activity.description")}</span>
                                        </div>
                                      </div>
                                      <div class="settings-v2-ofxp-activity-row">
                                        <div class="settings-v2-ofxp-activity-copy">
                                          <code>{activity().operation}</code>
                                          <span>
                                            {language.t(activityCommitKey(activity().commitClass))}
                                            {" · "}
                                            {formatWhen(activity().settledAt ?? activity().createdAt)}
                                          </span>
                                        </div>
                                        <Tag>{language.t(activityStateKey(activity().state))}</Tag>
                                      </div>
                                    </div>
                                  )}
                                </Show>

                                <div class="settings-v2-ofxp-subsection">
                                  <div class="settings-v2-ofxp-subsection-heading">
                                    <div><strong>{language.t("settings.ofxp.presets.title")}</strong><span>{language.t("settings.ofxp.presets.description")}</span></div>
                                    <div class="settings-v2-ofxp-preset-actions">
                                      <ButtonV2 size="small" variant="outline" disabled={!!store.busy || authorityLocked()} onClick={() => applyPreset(peer, "none")}>{language.t("settings.ofxp.presets.none")}</ButtonV2>
                                      <ButtonV2 size="small" variant="outline" disabled={!!store.busy || authorityLocked()} onClick={() => applyPreset(peer, "messaging")}>{language.t("settings.ofxp.presets.messaging")}</ButtonV2>
                                      <ButtonV2 size="small" variant="outline" disabled={!!store.busy || authorityLocked()} onClick={() => applyPreset(peer, "collaborate")}>{language.t("settings.ofxp.presets.collaborate")}</ButtonV2>
                                    </div>
                                  </div>
                                </div>

                                <div class="settings-v2-ofxp-subsection">
                                  <div class="settings-v2-ofxp-subsection-heading">
                                    <div><strong>{language.t("settings.ofxp.roots.title")}</strong><span>{language.t("settings.ofxp.roots.description")}</span></div>
                                  </div>
                                  <Show when={peer.roots.length > 0}>
                                    <div class="settings-v2-ofxp-root-chips">
                                      <For each={peer.roots}>
                                        {(root) => (
                                          <span
                                            class="settings-v2-ofxp-root-chip"
                                            title={language.t("settings.ofxp.roots.approvedAt", {
                                              time: formatWhen(root.approvedAt),
                                            })}
                                          >
                                            <span>/{root.alias}</span>
                                            <span class="settings-v2-ofxp-root-source">
                                              {language.t(
                                                root.source === "project"
                                                  ? "settings.ofxp.roots.source.project"
                                                  : "settings.ofxp.roots.source.manual",
                                              )}
                                            </span>
                                            <IconButtonV2
                                              type="button"
                                              size="small"
                                              variant="ghost-muted"
                                              icon={<Icon name="close" size="small" />}
                                              aria-label={language.t("settings.ofxp.roots.removeNamed", {
                                                alias: root.alias,
                                              })}
                                              disabled={!!store.busy || authorityLocked()}
                                              onClick={() => removeRoot(peer.info.id, root.id)}
                                            />
                                          </span>
                                        )}
                                      </For>
                                    </div>
                                  </Show>
                                  <div class="settings-v2-ofxp-root-add">
                                    <Show when={projects().length > 0}>
                                      <SelectV2
                                        appearance="inline"
                                        options={projects()}
                                        current={selectedProject()}
                                        value={(option) => option.path}
                                        label={(option) => option.label}
                                        placeholder={language.t("settings.ofxp.roots.chooseProject")}
                                        disabled={!!store.busy || authorityLocked()}
                                        onSelect={(option) => setStore("projectPath", option?.path ?? "")}
                                      />
                                      <ButtonV2 size="small" variant="outline" disabled={!!store.busy || authorityLocked() || !selectedProject()} onClick={() => addProjectRoot(peer)}>
                                        {language.t("settings.ofxp.roots.approveProject")}
                                      </ButtonV2>
                                    </Show>
                                    <Show when={platform.platform === "desktop" && ServerConnection.local(scopedServer())}>
                                      <ButtonV2 size="small" variant="outline" icon="folder-add-left" disabled={!!store.busy || authorityLocked()} onClick={() => void addLocalFolder(peer)}>
                                        {language.t("settings.ofxp.roots.addFolder")}
                                      </ButtonV2>
                                    </Show>
                                  </div>
                                </div>

                                <div class="settings-v2-ofxp-subsection">
                                  <div class="settings-v2-ofxp-subsection-heading">
                                    <div><strong>{language.t("settings.ofxp.capabilities.title")}</strong><span>{language.t("settings.ofxp.capabilities.description")}</span></div>
                                  </div>
                                  <SettingsListV2>
                                    <For each={grantRows}>
                                      {([key, title, description]) => (
                                        <SettingsRowV2 title={language.t(title)} description={language.t(description)}>
                                          <Switch
                                            checked={peer.grant[key]}
                                            disabled={!!store.busy || authorityLocked()}
                                            onChange={(value) => setBooleanGrant(peer, key, value)}
                                            hideLabel
                                          >
                                            {language.t(title)}
                                          </Switch>
                                        </SettingsRowV2>
                                      )}
                                    </For>
                                    <SettingsRowV2 title={language.t("settings.ofxp.capability.supervision.title")} description={language.t("settings.ofxp.capability.supervision.description")}>
                                      <Switch
                                        checked={peer.grant.sessionSupervision !== "none"}
                                        disabled={!!store.busy || authorityLocked()}
                                        onChange={(value) => replaceGrant(peer, { ...peer.grant, sessionSupervision: value ? "approved-roots" : "none" })}
                                        hideLabel
                                      >
                                        {language.t("settings.ofxp.capability.supervision.title")}
                                      </Switch>
                                    </SettingsRowV2>
                                    <SettingsRowV2 title={language.t("settings.ofxp.capability.requests.title")} description={language.t("settings.ofxp.capability.requests.description")}>
                                      <Switch
                                        checked={peer.grant.requestSupervision}
                                        disabled={!!store.busy || authorityLocked()}
                                        onChange={(value) => setBooleanGrant(peer, "requestSupervision", value)}
                                        hideLabel
                                      >
                                        {language.t("settings.ofxp.capability.requests.title")}
                                      </Switch>
                                    </SettingsRowV2>
                                    <SettingsRowV2 title={language.t("settings.ofxp.capability.delegation.title")} description={language.t("settings.ofxp.capability.delegation.description")}>
                                      <Switch
                                        checked={peer.grant.delegation !== "disabled"}
                                        disabled={!!store.busy || authorityLocked()}
                                        onChange={(value) =>
                                          replaceGrant(peer, {
                                            ...peer.grant,
                                            delegation: value ? "spawn" : "disabled",
                                            nestedDelegation: value ? peer.grant.nestedDelegation : false,
                                          })
                                        }
                                        hideLabel
                                      >
                                        {language.t("settings.ofxp.capability.delegation.title")}
                                      </Switch>
                                    </SettingsRowV2>
                                    <SettingsRowV2 title={language.t("settings.ofxp.capability.nested.title")} description={language.t("settings.ofxp.capability.nested.description")}>
                                      <Switch
                                        checked={peer.grant.nestedDelegation}
                                        disabled={!!store.busy || peer.grant.delegation === "disabled" || authorityLocked()}
                                        onChange={(value) => setBooleanGrant(peer, "nestedDelegation", value)}
                                        hideLabel
                                      >
                                        {language.t("settings.ofxp.capability.nested.title")}
                                      </Switch>
                                    </SettingsRowV2>
                                  </SettingsListV2>
                                </div>

                                <div class="settings-v2-ofxp-danger-row">
                                  <div><strong>{language.t("settings.ofxp.revoke.title")}</strong><span>{language.t("settings.ofxp.revoke.description")}</span></div>
                                  <Show
                                    when={confirmingRevoke()}
                                    fallback={
                                      <ButtonV2
                                        size="small"
                                        variant="danger"
                                        disabled={!!store.busy}
                                        onClick={() => setStore("confirmingRevokePeerID", peer.info.id)}
                                      >
                                        {language.t("settings.ofxp.revoke.action")}
                                      </ButtonV2>
                                    }
                                  >
                                    <div class="settings-v2-ofxp-danger-actions">
                                      <ButtonV2 size="small" variant="danger" disabled={!!store.busy} onClick={() => revoke(peer)}>
                                        {language.t("settings.ofxp.revoke.confirm")}
                                      </ButtonV2>
                                      <ButtonV2
                                        size="small"
                                        variant="ghost-muted"
                                        disabled={!!store.busy}
                                        onClick={() => setStore("confirmingRevokePeerID", undefined)}
                                      >
                                        {language.t("common.cancel")}
                                      </ButtonV2>
                                    </div>
                                  </Show>
                                </div>
                              </div>
                            </Show>
                          </div>
                        )
                      }}
                    </For>
                  </div>
                </Show>
              </div>

              <div class="settings-v2-section">
                <div class="settings-v2-ofxp-section-heading">
                  <div>
                    <h3 class="settings-v2-section-title">{language.t("settings.ofxp.nearby.title")}</h3>
                    <p>{language.t("settings.ofxp.nearby.description")}</p>
                  </div>
                  <Show when={current().status.active && current().status.discovery === "degraded"}>
                    <Tag>{language.t("settings.ofxp.nearby.degraded")}</Tag>
                  </Show>
                </div>
                <Show
                  when={current().status.active}
                  fallback={<div class="settings-v2-ofxp-empty"><Icon name="server" /><strong>{language.t("settings.ofxp.nearby.disabled")}</strong><span>{language.t("settings.ofxp.nearby.disabledDescription")}</span></div>}
                >
                  <Show
                    when={nearby().length > 0}
                    fallback={<div class="settings-v2-ofxp-empty settings-v2-ofxp-empty--compact"><Icon name="link" /><strong>{language.t("settings.ofxp.nearby.empty")}</strong><span>{language.t("settings.ofxp.nearby.emptyDescription")}</span></div>}
                  >
                    <SettingsListV2>
                      <For each={nearby()}>
                        {(candidate) => (
                          <div class="settings-v2-ofxp-nearby-row">
                            <div class="settings-v2-ofxp-peer-presence" data-online="true" />
                            <div class="settings-v2-ofxp-peer-copy">
                              <strong>{language.t("settings.ofxp.nearby.peer", { id: shortID(candidate.peerID) })}</strong>
                              <span>
                                {language.t("settings.ofxp.nearby.meta", {
                                  version: candidate.openforkVersion,
                                  count: candidate.endpointCount,
                                })}
                              </span>
                            </div>
                            <ButtonV2 size="small" variant="outline" disabled={!!store.busy || !candidate.pairing} onClick={() => beginPairing(candidate.peerID)}>
                              {candidate.pairing ? language.t("settings.ofxp.nearby.pair") : language.t("settings.ofxp.nearby.unavailable")}
                            </ButtonV2>
                          </div>
                        )}
                      </For>
                    </SettingsListV2>
                  </Show>
                </Show>
              </div>

            </>
          )}
        </Show>
        {props.children}
      </div>
      </>
    </OfxpServerConnectionsContext.Provider>
  )
}
