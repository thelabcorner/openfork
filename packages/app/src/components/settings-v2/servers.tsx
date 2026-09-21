import { useSearchParams } from "@solidjs/router"
import type { OfxpSettingsPeerOverview } from "@opencode-ai/sdk/v2/client"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import fuzzysort from "fuzzysort"
import { type Component, For, Show, createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { ServerRowMenu } from "@/components/server/server-row-menu"
import { ServerHealthIndicator } from "@/components/server/server-row"
import { useLanguage } from "@/context/language"
import { ServerConnection, serverName, useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"
import { useServerManagementController } from "../dialog-select-server"
import { DialogServerV2 } from "./dialog-server-v2"
import { OfxpNetworkSettingsV2, useOfxpServerConnectionsUi } from "./ofxp-network"
import { SettingsListV2 } from "./parts/list"
import { AddServerMenu, isWslServer, useFilteredWslServers, WslServerSettings } from "@/wsl/settings"
import "./settings-v2.css"

function shortID(value: string | undefined) {
  if (!value) return "—"
  if (value.length <= 18) return value
  return `${value.slice(0, 8)}…${value.slice(-8)}`
}

function hasEffectiveAuthority(peer: OfxpSettingsPeerOverview | undefined, now = Date.now()) {
  if (!peer || peer.info.rekeyState !== "stable") return false
  if (peer.info.grantExpiresAt !== undefined && peer.info.grantExpiresAt <= now) return false
  const global = peer.grant.messaging || peer.grant.integrations || peer.grant.browser
  const rooted =
    peer.roots.length > 0 &&
    (peer.grant.read ||
      peer.grant.write ||
      peer.grant.git ||
      peer.grant.process ||
      peer.grant.filesReceive ||
      peer.grant.filesSend ||
      peer.grant.automation ||
      peer.grant.sessionSupervision !== "none" ||
      peer.grant.requestSupervision ||
      peer.grant.delegation !== "disabled" ||
      peer.grant.nestedDelegation)
  return global || rooted
}

function connectionKind(conn: ServerConnection.Any, language: ReturnType<typeof useLanguage>) {
  if (conn.type === "ssh") return language.t("settings.ofxp.connections.ssh")
  if (conn.type === "sidecar") {
    return conn.variant === "wsl"
      ? language.t("settings.ofxp.connections.wsl")
      : language.t("settings.ofxp.connections.local")
  }
  return language.t("settings.ofxp.connections.http")
}

type ServerManagementController = ReturnType<typeof useServerManagementController>

const ServerConnectionNetworkStrip: Component<{
  serverKey: ServerConnection.Key
  controller: ServerManagementController
}> = (props) => {
  const language = useLanguage()
  const ofxp = useOfxpServerConnectionsUi()
  const networkState = () => ofxp?.state()
  const health = () => props.controller.status()[props.serverKey]
  const identity = () => health()?.ofxp
  const peerID = () => {
    const value = identity()
    return value?.enabled === true ? value.peerID : undefined
  }
  const fingerprint = () => {
    const value = identity()
    return value?.enabled === true ? value.fingerprint : undefined
  }
  const peer = () => {
    const id = peerID()
    return id ? networkState()?.peers.find((value) => value.info.id === id) : undefined
  }
  const pairing = () => {
    const id = peerID()
    return id ? networkState()?.pairings.find((value) => value.peer.id === id) : undefined
  }
  const candidate = () => {
    const id = peerID()
    return id ? networkState()?.candidates.find((value) => value.peerID === id) : undefined
  }
  const isSelf = () => !!peerID() && peerID() === networkState()?.status.peerID
  const authorized = () => hasEffectiveAuthority(peer())

  const relationship = () => {
    if (health()?.healthy === false) return "unreachable"
    const value = identity()
    if (!value) return "unknown"
    if (!value.enabled) return "disabled"
    if (!value.compatible) return "incompatible"
    if (!networkState()) return "relationship-checking"
    if (isSelf()) return "self"
    if (peer()?.info.rekeyState === "required") return "rekey"
    if (peer()) return authorized() ? "authorized" : "trusted"
    if (pairing()) return "pairing"
    if (candidate()) return candidate()?.pairing ? "discovered" : "discovered-unavailable"
    if (networkState()?.status.active === false) return "network-disabled"
    return "awaiting"
  }

  const relationshipLabel = () => {
    switch (relationship()) {
      case "unreachable":
        return language.t("settings.ofxp.connections.unreachable")
      case "disabled":
        return language.t("settings.ofxp.connections.networkOff")
      case "incompatible":
        return language.t("settings.ofxp.connections.protocolMismatch")
      case "self":
        return language.t("settings.ofxp.connections.self")
      case "rekey":
        return language.t("settings.ofxp.peers.identityChanged")
      case "authorized":
        return language.t("settings.ofxp.connections.authorizedPeer")
      case "trusted":
        return language.t("settings.ofxp.connections.trustedPeer")
      case "pairing":
        return language.t("settings.ofxp.connections.pairing")
      case "discovered":
        return language.t("settings.ofxp.connections.discovered")
      case "discovered-unavailable":
        return language.t("settings.ofxp.connections.discoveredUnavailable")
      case "relationship-checking":
        return language.t("settings.ofxp.connections.checkingRelationship")
      case "network-disabled":
        return language.t("settings.ofxp.connections.enableToCorrelate")
      case "awaiting":
        return language.t("settings.ofxp.connections.awaitingDiscovery")
      default:
        return health()?.healthy === true
          ? language.t("settings.ofxp.connections.identityUnavailable")
          : language.t("settings.ofxp.connections.checkingIdentity")
    }
  }

  const networkAction = () => {
    const id = peerID()
    if (!ofxp || !id || isSelf() || health()?.healthy !== true) return
    if (peer()) {
      return {
        label: language.t("settings.ofxp.connections.manageTrust"),
        action: () => ofxp.focusPeer(id),
      }
    }
    if (pairing()) {
      return {
        label: language.t("settings.ofxp.connections.review"),
        action: () => ofxp.focusPairing(id),
      }
    }
    if (candidate()?.pairing && identity()?.enabled === true) {
      return {
        label: language.t("settings.ofxp.connections.verify"),
        action: () => ofxp.beginPairing(id),
      }
    }
    if (identity()?.enabled === true && networkState()?.status.active === false) {
      return {
        label: language.t("settings.ofxp.connections.enableNetwork"),
        action: ofxp.enableNetwork,
      }
    }
  }

  return (
    <div class="settings-v2-server-card-network" data-relation={relationship()}>
      <div class="settings-v2-server-card-network-icon">
        <IconV2
          name={
            relationship() === "rekey"
              ? "warning"
              : relationship() === "authorized" || relationship() === "trusted"
                ? "check"
                : "link"
          }
          size="small"
        />
      </div>
      <div class="settings-v2-server-card-network-copy">
        <span>{language.t("settings.ofxp.connections.networkIdentity")}</span>
        <strong>{relationshipLabel()}</strong>
        <Show when={identity()?.enabled === true}>
          <div class="settings-v2-server-card-peer">
            <code title={peerID()}>{language.t("settings.ofxp.connections.peerID", { id: shortID(peerID()) })}</code>
            <span>·</span>
            <code title={fingerprint()}>{shortID(fingerprint())}</code>
          </div>
        </Show>
      </div>
      <Show when={networkAction()}>
        {(action) => (
          <ButtonV2
            size="small"
            variant="ghost-muted"
            disabled={ofxp?.busy()}
            onClick={() => action().action()}
          >
            {action().label}
          </ButtonV2>
        )}
      </Show>
    </div>
  )
}

const ServerConnectionsPanel: Component = () => {
  const dialog = useDialog()
  const language = useLanguage()
  const controller = useServerManagementController()
  const server = useServer()
  const serverSDK = useServerSDK()
  const ofxp = useOfxpServerConnectionsUi()
  const [, setSearch] = useSearchParams<{ server?: string }>()
  const [store, setStore] = createStore({ filter: "" })
  const wslServers = useFilteredWslServers(() => store.filter)

  const scopedKey = createMemo(() => ServerConnection.key(serverSDK().server))
  const regularItems = createMemo(() => controller.sortedItems().filter((item) => !isWslServer(item)))
  const showSearch = createMemo(() => regularItems().length + wslServers().length > 1)

  const filtered = createMemo(() => {
    const items = regularItems()
    const query = store.filter.trim()
    if (!query) return items
    return fuzzysort
      .go(query, items, {
        keys: [(item) => serverName(item), (item) => item.http.url],
      })
      .map((result) => result.obj)
  })

  const openAdd = () => {
    dialog.push(() => <DialogServerV2 mode="add" />)
  }

  const openEdit = (conn: ServerConnection.Http) => {
    dialog.push(() => <DialogServerV2 mode="edit" server={conn} />)
  }

  const networkState = () => ofxp?.state()
  const trustedPeerIDs = createMemo(() => new Set((networkState()?.peers ?? []).map((peer) => peer.info.id)))
  const reachableCount = createMemo(
    () => controller.sortedItems().filter((item) => controller.status()[ServerConnection.key(item)]?.healthy === true).length,
  )
  const identityCount = createMemo(
    () => controller.sortedItems().filter((item) => controller.status()[ServerConnection.key(item)]?.ofxp?.enabled === true).length,
  )
  const trustedCount = createMemo(
    () =>
      controller
        .sortedItems()
        .filter((item) => {
          const identity = controller.status()[ServerConnection.key(item)]?.ofxp
          return identity?.enabled === true && trustedPeerIDs().has(identity.peerID)
        }).length,
  )

  return (
    <div class="settings-v2-section settings-v2-server-connections">
      <div class="settings-v2-ofxp-section-heading">
        <div>
          <h3 class="settings-v2-section-title">{language.t("settings.ofxp.connections.title")}</h3>
          <p>{language.t("settings.ofxp.connections.description")}</p>
        </div>
        <AddServerMenu onAddServer={openAdd} />
      </div>

      <div class="settings-v2-server-connections-overview">
        <div class="settings-v2-server-connections-view">
          <IconV2 name="server" size="small" />
          <span>{language.t("settings.ofxp.connections.viewing")}</span>
          <strong>{serverName(serverSDK().server)}</strong>
        </div>
        <div class="settings-v2-server-connections-stats">
          <div><strong>{controller.sortedItems().length}</strong><span>{language.t("settings.ofxp.connections.backends")}</span></div>
          <div><strong>{reachableCount()}</strong><span>{language.t("settings.ofxp.connections.reachable")}</span></div>
          <div><strong>{identityCount()}</strong><span>{language.t("settings.ofxp.connections.identities")}</span></div>
          <div><strong>{trustedCount()}</strong><span>{language.t("settings.ofxp.connections.trusted")}</span></div>
        </div>
      </div>

      <Show when={showSearch()}>
        <div class="settings-v2-tab-search settings-v2-server-connections-search">
          <TextInputV2
            type="search"
            appearance="base"
            value={store.filter}
            onInput={(event) => setStore("filter", event.currentTarget.value)}
            placeholder={language.t("dialog.server.search.placeholder")}
            spellcheck={false}
            autocorrect="off"
            autocomplete="off"
            autocapitalize="off"
            aria-label={language.t("dialog.server.search.placeholder")}
          />
          <Show when={store.filter}>
            <IconButtonV2
              type="button"
              variant="ghost-muted"
              size="small"
              class="settings-v2-tab-search-clear"
              icon={<IconV2 name="close" size="large" class="text-v2-icon-icon-muted" />}
              onClick={() => setStore("filter", "")}
            />
          </Show>
        </div>
      </Show>

      <Show
        when={filtered().length > 0 || wslServers().length > 0}
        fallback={
          <div class="settings-v2-servers-status">
            <span>{store.filter ? language.t("palette.empty") : language.t("dialog.server.empty")}</span>
            <Show when={store.filter}>
              <span class="settings-v2-servers-status-filter">&quot;{store.filter}&quot;</span>
            </Show>
          </div>
        }
      >
        <SettingsListV2>
          <WslServerSettings
            controller={controller}
            servers={wslServers}
            activeKey={server.key}
            scopedKey={scopedKey()}
            onManage={(key) => setSearch({ server: key })}
            onUse={(key) => {
              const connection = controller.sortedItems().find((item) => ServerConnection.key(item) === key)
              if (connection) void controller.select(connection)
            }}
            renderNetwork={(key) => <ServerConnectionNetworkStrip serverKey={key} controller={controller} />}
          />
          <For each={filtered()}>
            {(item) => {
              const key = ServerConnection.key(item)
              const health = () => controller.status()[key]
              const isDefault = () => controller.defaultKey() === key
              const isActiveBackend = () => server.key === key
              const isScopedBackend = () => scopedKey() === key

              return (
                <div
                  class="settings-v2-server-card"
                  data-health={health()?.healthy === false ? "offline" : health()?.healthy === true ? "online" : "checking"}
                  data-scoped={isScopedBackend() ? "true" : "false"}
                >
                  <div class="settings-v2-server-card-main">
                    <div class="settings-v2-server-card-icon">
                      <ServerHealthIndicator health={health()} />
                      <IconV2 name="server" size="small" />
                    </div>
                    <div class="settings-v2-server-card-copy">
                      <div class="settings-v2-server-card-title">
                        <strong>{serverName(item)}</strong>
                        <Show when={isActiveBackend()}>
                          <Tag variant="accent">{language.t("settings.ofxp.connections.activeBackend")}</Tag>
                        </Show>
                        <Show when={isScopedBackend()}>
                          <Tag>{language.t("settings.ofxp.connections.managingHere")}</Tag>
                        </Show>
                        <Show when={controller.canDefault() && isDefault()}>
                          <Tag>{language.t("dialog.server.status.default")}</Tag>
                        </Show>
                      </div>
                      <div class="settings-v2-server-card-meta">
                        <span>{connectionKind(item, language)}</span>
                        <Show when={health()?.version}><span>v{health()?.version}</span></Show>
                        <code title={item.http.url}>{item.http.url}</code>
                      </div>
                    </div>
                    <div class="settings-v2-server-card-actions">
                      <Show when={!isScopedBackend()}>
                        <ButtonV2
                          size="small"
                          variant="ghost-muted"
                          disabled={health()?.healthy === false}
                          onClick={() => setSearch({ server: key })}
                        >
                          {language.t("settings.ofxp.connections.manage")}
                        </ButtonV2>
                      </Show>
                      <Show when={!isActiveBackend()}>
                        <ButtonV2
                          size="small"
                          variant="outline"
                          disabled={health()?.healthy === false}
                          onClick={() => void controller.select(item)}
                        >
                          {language.t("settings.ofxp.connections.use")}
                        </ButtonV2>
                      </Show>
                      <ServerRowMenu server={item} controller={controller} onEdit={openEdit} />
                    </div>
                  </div>

                  <ServerConnectionNetworkStrip serverKey={key} controller={controller} />
                </div>
              )
            }}
          </For>
        </SettingsListV2>
      </Show>
    </div>
  )
}

export const SettingsServersV2: Component = () => {
  return (
    <OfxpNetworkSettingsV2>
      <ServerConnectionsPanel />
    </OfxpNetworkSettingsV2>
  )
}
