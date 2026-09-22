import type { OfxpSettingsState } from "@opencode-ai/sdk/v2/client"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon } from "@opencode-ai/ui/v2/icon"
import { For, Show, Suspense, createMemo, lazy, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobal } from "@/context/global"
import { useLanguage } from "@/context/language"
import { usePwaConnection } from "@/context/pwa-connection"
import { useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { revokeDevice } from "@/components/settings-v2/pairing"

function shortID(value: string | undefined) {
  if (!value) return "—"
  if (value.length <= 20) return value
  return `${value.slice(0, 9)}…${value.slice(-8)}`
}

const PwaConnectionEndpoint = lazy(() =>
  import("@/components/pwa/connection-endpoint").then((module) => ({ default: module.PwaConnectionEndpoint })),
)

export function PwaConnectionSettings() {
  const language = useLanguage()
  const connection = usePwaConnection()
  const global = useGlobal()
  const server = useServer()
  const sdk = useServerSDK()
  const [store, setStore] = createStore<{
    state?: OfxpSettingsState
    loading: boolean
    busy: boolean
    confirmingRevoke: boolean
    revoking: boolean
    editingEndpoint: boolean
    error?: string
  }>({
    loading: true,
    busy: false,
    confirmingRevoke: false,
    revoking: false,
    editingEndpoint: false,
  })

  const health = createMemo(() => global.servers.health[server.key])
  const projectedIdentity = createMemo(() => {
    const value = health()?.ofxp
    if (value?.enabled === true) return value
    return connection?.networkIdentity
  })
  const networkDisabled = createMemo(() => health()?.ofxp?.enabled === false)
  const publicOrigin = createMemo(() => {
    const identity = health()?.ofxp
    return identity?.enabled === true ? identity.publicOrigin : undefined
  })
  const peers = createMemo(() => store.state?.peers ?? [])
  const onlinePeers = createMemo(() => peers().filter((peer) => peer.online))
  const identityChanged = createMemo(() => {
    const pinned = connection?.networkIdentity?.peerID
    const current = store.state?.status.peerID
    return !!pinned && !!current && pinned !== current
  })

  const load = async (silent = false) => {
    if (!silent) setStore("loading", true)
    try {
      const response = await sdk().client.ofxp.state({ throwOnError: true })
      setStore("state", response.data)
      setStore("error", undefined)
    } catch (error) {
      if (!silent) setStore("error", error instanceof Error ? error.message : language.t("pwa.connection.networkLoadFailed"))
    } finally {
      if (!silent) setStore("loading", false)
    }
  }

  const enableNetwork = async () => {
    if (store.busy) return
    setStore("busy", true)
    try {
      const response = await sdk().client.ofxp.runtime(
        { ofxpSettingsRuntimePayload: { enabled: true } },
        { throwOnError: true },
      )
      if (response.data) setStore("state", response.data)
      setStore("error", undefined)
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : language.t("pwa.connection.networkEnableFailed"))
    } finally {
      setStore("busy", false)
    }
  }

  const discoveryLabel = (value: OfxpSettingsState["status"]["discovery"]) => {
    if (value === "active") return language.t("pwa.connection.network.discovery.active")
    if (value === "degraded") return language.t("pwa.connection.network.discovery.degraded")
    return language.t("pwa.connection.network.discovery.disabled")
  }

  const revokeCurrentDevice = async () => {
    const deviceID = connection?.deviceID
    if (!deviceID || store.revoking) return
    setStore("revoking", true)
    setStore("error", undefined)
    try {
      await revokeDevice(sdk(), deviceID)
      connection?.forgetDevice?.()
    } catch (error) {
      setStore("error", error instanceof Error ? error.message : language.t("pwa.connection.revoke.failed"))
      setStore("confirmingRevoke", false)
    } finally {
      setStore("revoking", false)
    }
  }

  onMount(() => void load())

  return (
    <div class="flex flex-col gap-3 pb-5">
      <section class="overflow-hidden rounded-[12px] border border-v2-border-border-base bg-v2-background-bg-base">
        <div class="flex items-start gap-3 border-b border-v2-border-border-base px-4 py-4">
          <div class="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-v2-background-bg-layer-02 text-v2-icon-icon-base">
            <Icon name="server" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <div class="text-[13px] font-[560] text-v2-text-text-strong">{language.t("pwa.connection.title")}</div>
              <span
                class="size-2 rounded-full"
                classList={{
                  "bg-v2-state-icon-success": health()?.healthy === true,
                  "bg-v2-state-icon-danger": health()?.healthy === false,
                  "bg-v2-icon-icon-muted": health() === undefined,
                }}
              />
            </div>
            <div class="mt-1 truncate font-mono text-[11px] text-v2-text-text-muted">{connection?.serverUrl ?? server.name}</div>
          </div>
          <div class="text-[11px] font-[530] text-v2-text-text-muted">
            {health()?.healthy === true
              ? language.t("pwa.connection.reachable")
              : health()?.healthy === false
                ? language.t("pwa.connection.unreachable")
                : language.t("pwa.connection.checking")}
          </div>
        </div>
        <Show when={connection?.deviceID}>
          <div class="flex items-center justify-between gap-3 px-4 py-3 text-[12px]">
            <span class="text-v2-text-text-muted">{language.t("pwa.connection.device")}</span>
            <code class="truncate text-v2-text-text-base" title={connection?.deviceID}>{shortID(connection?.deviceID)}</code>
          </div>
        </Show>
        <Show when={connection?.migrateEndpoint}>
          <div class="flex flex-col gap-2 border-t border-v2-border-border-base px-4 py-3 text-[12px]">
            <div class="flex items-center justify-between gap-3">
              <span class="text-v2-text-text-muted">{language.t("pwa.connection.endpoint.title")}</span>
              <Show when={!store.editingEndpoint}>
                <button
                  type="button"
                  class="text-[11px] font-[530] text-v2-text-text-muted underline-offset-2"
                  onClick={() => setStore("editingEndpoint", true)}
                >
                  {language.t("pwa.connection.endpoint.update")}
                </button>
              </Show>
            </div>
            <Show when={store.editingEndpoint}>
              <Suspense fallback={<div class="h-9 animate-pulse rounded-[8px] bg-v2-background-bg-layer-02" />}>
                <PwaConnectionEndpoint
                  serverUrl={connection?.serverUrl ?? ""}
                  migrate={connection!.migrateEndpoint!}
                  onClose={() => setStore("editingEndpoint", false)}
                />
              </Suspense>
            </Show>
          </div>
        </Show>
        <Show when={publicOrigin()}>
          {(origin) => (
            <div class="flex items-center justify-between gap-3 border-t border-v2-border-border-base px-4 py-3 text-[12px]">
              <span class="text-v2-text-text-muted">{language.t("pwa.connection.ingress.title")}</span>
              <code class="min-w-0 truncate text-[11px] text-v2-text-text-base" title={origin()}>{origin()}</code>
            </div>
          )}
        </Show>
      </section>

      <section class="overflow-hidden rounded-[12px] border border-v2-border-border-base bg-v2-background-bg-base">
        <div class="flex items-start gap-3 border-b border-v2-border-border-base px-4 py-4">
          <div class="flex size-9 shrink-0 items-center justify-center rounded-[9px] bg-v2-background-bg-layer-02 text-v2-icon-icon-base">
            <Icon name="link" />
          </div>
          <div class="min-w-0 flex-1">
            <div class="text-[13px] font-[560] text-v2-text-text-strong">{language.t("pwa.connection.network.title")}</div>
            <p class="mt-1 text-[12px] leading-5 text-v2-text-text-muted">{language.t("pwa.connection.network.description")}</p>
          </div>
          <ButtonV2 variant="ghost-muted" size="small" disabled={store.loading || store.busy} onClick={() => void load()}>
            <Icon name="refresh" />
          </ButtonV2>
        </div>

        <Show when={identityChanged()}>
          <div class="mx-3 mt-3 flex gap-2 rounded-[9px] border border-v2-state-border-danger/40 bg-v2-state-bg-danger/10 px-3 py-2.5 text-[12px] leading-5 text-v2-text-text-base">
            <Icon name="warning" class="mt-0.5 shrink-0 text-v2-state-icon-danger" />
            <span>{language.t("pwa.connection.network.identityChanged")}</span>
          </div>
        </Show>

        <Show when={projectedIdentity()} keyed>
          {(identity) => (
            <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 py-3 text-[12px]">
              <span class="text-v2-text-text-muted">{language.t("pwa.connection.network.peer")}</span>
              <code class="min-w-0 truncate text-right text-v2-text-text-base" title={identity.peerID}>{shortID(identity.peerID)}</code>
              <span class="text-v2-text-text-muted">{language.t("pwa.connection.network.realm")}</span>
              <code class="min-w-0 truncate text-right text-v2-text-text-base" title={identity.realmID}>{shortID(identity.realmID)}</code>
              <span class="text-v2-text-text-muted">{language.t("pwa.connection.network.protocol")}</span>
              <span class="text-right text-v2-text-text-base">{identity.protocolMin === identity.protocolMax ? identity.protocolMin : `${identity.protocolMin}–${identity.protocolMax}`}</span>
            </div>
          )}
        </Show>

        <Show when={networkDisabled()}>
          <div class="px-4 py-3 text-[12px] leading-5 text-v2-text-text-muted">{language.t("pwa.connection.network.serverDisabled")}</div>
        </Show>

        <Show when={store.state} keyed>
          {(state) => (
            <div class="border-t border-v2-border-border-base px-4 py-3">
              <div class="grid grid-cols-3 gap-2">
                <div class="rounded-[8px] bg-v2-background-bg-layer-01 px-3 py-2.5">
                  <div class="text-[16px] font-[600] tabular-nums text-v2-text-text-strong">{peers().length}</div>
                  <div class="mt-0.5 text-[10px] font-[530] uppercase tracking-[0.06em] text-v2-text-text-faint">{language.t("pwa.connection.network.trusted")}</div>
                </div>
                <div class="rounded-[8px] bg-v2-background-bg-layer-01 px-3 py-2.5">
                  <div class="text-[16px] font-[600] tabular-nums text-v2-text-text-strong">{onlinePeers().length}</div>
                  <div class="mt-0.5 text-[10px] font-[530] uppercase tracking-[0.06em] text-v2-text-text-faint">{language.t("pwa.connection.network.online")}</div>
                </div>
                <div class="rounded-[8px] bg-v2-background-bg-layer-01 px-3 py-2.5">
                  <div class="text-[16px] font-[600] tabular-nums text-v2-text-text-strong">{state.candidates.length}</div>
                  <div class="mt-0.5 text-[10px] font-[530] uppercase tracking-[0.06em] text-v2-text-text-faint">{language.t("pwa.connection.network.nearby")}</div>
                </div>
              </div>

              <div class="mt-3 flex items-center justify-between gap-3">
                <div class="flex items-center gap-2 text-[12px] text-v2-text-text-muted">
                  <span class={`size-2 rounded-full ${state.status.active ? "bg-v2-state-icon-success" : "bg-v2-icon-icon-muted"}`} />
                  <span>{state.status.active ? language.t("pwa.connection.network.active") : language.t("pwa.connection.network.inactive")}</span>
                  <span>·</span>
                  <span>{discoveryLabel(state.status.discovery)}</span>
                </div>
                <Show when={!state.status.active}>
                  <ButtonV2 variant="contrast" size="small" disabled={store.busy} onClick={() => void enableNetwork()}>
                    {store.busy ? language.t("pwa.connection.network.enabling") : language.t("pwa.connection.network.enable")}
                  </ButtonV2>
                </Show>
              </div>

              <Show when={peers().length > 0}>
                <div class="mt-3 overflow-hidden rounded-[8px] border border-v2-border-border-base">
                  <For each={peers().slice(0, 5)}>
                    {(peer) => (
                      <div class="flex items-center gap-3 border-b border-v2-border-border-base px-3 py-2.5 last:border-b-0">
                        <span class={`size-2 shrink-0 rounded-full ${peer.online ? "bg-v2-state-icon-success" : "bg-v2-icon-icon-muted"}`} />
                        <div class="min-w-0 flex-1">
                          <div class="truncate text-[12px] font-[530] text-v2-text-text-base">{peer.info.label || shortID(peer.info.id)}</div>
                          <div class="truncate font-mono text-[10px] text-v2-text-text-faint">{shortID(peer.info.id)}</div>
                        </div>
                        <div class="text-[10px] font-[530] uppercase tracking-[0.05em] text-v2-text-text-faint">
                          {peer.online ? language.t("pwa.connection.network.online") : language.t("pwa.connection.network.offline")}
                        </div>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          )}
        </Show>

        <Show when={store.error}>
          <div class="border-t border-v2-border-border-base px-4 py-3 text-[12px] leading-5 text-v2-state-text-danger">{store.error}</div>
        </Show>
      </section>

      <Show when={connection?.forgetDevice}>
        <section class="overflow-hidden rounded-[12px] border border-v2-border-border-base bg-v2-background-bg-base">
          <div class="px-4 py-4">
            <div class="flex items-start gap-3">
              <div class="flex size-8 shrink-0 items-center justify-center rounded-[8px] bg-v2-state-bg-danger/10 text-v2-state-icon-danger">
                <Icon name="trash" />
              </div>
              <div class="min-w-0 flex-1">
                <div class="text-[13px] font-[560] text-v2-text-text-strong">{language.t("pwa.connection.revoke.title")}</div>
                <p class="mt-1 text-[12px] leading-5 text-v2-text-text-muted">{language.t("pwa.connection.revoke.description")}</p>
              </div>
            </div>
            <Show
              when={store.confirmingRevoke}
              fallback={
                <div class="mt-3 flex flex-wrap gap-2 pl-11">
                  <Show when={connection?.deviceID}>
                    <ButtonV2 variant="danger" size="normal" onClick={() => setStore("confirmingRevoke", true)}>
                      {language.t("pwa.connection.revoke.action")}
                    </ButtonV2>
                  </Show>
                  <ButtonV2 variant="neutral" size="normal" onClick={() => connection?.forgetDevice?.()}>
                    {language.t("pwa.connection.forget.action")}
                  </ButtonV2>
                </div>
              }
            >
              <div class="mt-3 ml-11 rounded-[9px] border border-v2-state-border-danger/40 bg-v2-state-bg-danger/10 p-3">
                <div class="text-[12px] leading-5 text-v2-text-text-base">{language.t("pwa.connection.revoke.description")}</div>
                <div class="mt-3 flex gap-2">
                  <ButtonV2 variant="danger" size="normal" disabled={store.revoking} onClick={() => void revokeCurrentDevice()}>
                    {store.revoking ? language.t("pwa.connection.revoke.working") : language.t("pwa.connection.revoke.confirm")}
                  </ButtonV2>
                  <ButtonV2
                    variant="neutral"
                    size="normal"
                    disabled={store.revoking}
                    onClick={() => setStore("confirmingRevoke", false)}
                  >
                    {language.t("pwa.connection.revoke.cancel")}
                  </ButtonV2>
                </div>
              </div>
            </Show>
          </div>
          <div class="border-t border-v2-border-border-base px-4 py-3">
            <div class="text-[11px] leading-4 text-v2-text-text-muted">
              <span class="font-[530] text-v2-text-text-base">{language.t("pwa.connection.forget.title")}</span>
              {" · "}
              {language.t("pwa.connection.forget.description")}
            </div>
          </div>
        </section>
      </Show>
    </div>
  )
}