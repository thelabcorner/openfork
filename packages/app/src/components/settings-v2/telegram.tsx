import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Switch } from "@opencode-ai/ui/v2/switch-v2"
import { Spinner } from "@opencode-ai/ui/spinner"
import { type Accessor, type Component, createEffect, createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { useServerSDK } from "@/context/server-sdk"
import { showToast } from "@/utils/toast"
import { SettingsListV2 } from "./parts/list"
import { SettingsRowV2 } from "./parts/row"
import { isRollingQuotaOption, resetOptions, type QuotaAgendaView, type QuotaResetOption, withSubscription } from "./telegram-model"
import { telegramRequest, telegramQuotaRequest, type TelegramHubStatus, type TelegramQuotaSettings } from "./telegram-client"
import "./settings-telegram.css"
import { sectionsForTab, type SettingsSection } from "./sections"
import { useSettingsSectionScroll } from "./section-scroll"

const HORIZON_MS = 32 * 86400_000

function displayTime(time: number) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(time)
}

function safePairingURL(url: string | undefined) {
  if (!url) return undefined
  try {
    const target = new URL(url)
    return target.protocol === "https:" && target.hostname === "t.me" && target.pathname.length > 1 ? target.href : undefined
  } catch {
    return undefined
  }
}

function identityLabel(option: QuotaResetOption) {
  return [option.accountLabel, option.model].filter(Boolean).join(" · ") || "Provider-wide"
}

export const SettingsTelegramV2: Component<{ section?: Accessor<SettingsSection | undefined> }> = (props) => {
  const sdk = useServerSDK()
  const [status, setStatus] = createSignal<TelegramHubStatus>()
  const [quota, setQuota] = createSignal<TelegramQuotaSettings>()
  const [agenda, setAgenda] = createSignal<QuotaAgendaView>()
  const [loading, setLoading] = createSignal(true)
  const [agendaLoading, setAgendaLoading] = createSignal(false)
  const [agendaRequested, setAgendaRequested] = createSignal(false)
  const [error, setError] = createSignal("")
  const [busy, setBusy] = createSignal("")
  const [botToken, setBotToken] = createSignal("")
  const [confirmDisconnect, setConfirmDisconnect] = createSignal(false)
  const [showToken, setShowToken] = createSignal(false)
  const [polling, setPolling] = createSignal(false)

  const options = createMemo(() => resetOptions(agenda(), quota()?.subscriptions ?? []))
  const selected = createMemo(() => quota()?.subscriptions.filter((row) => row.enabled).length ?? 0)
  const pairingLink = createMemo(() => safePairingURL(status()?.pairingUrl))
  const setupReady = createMemo(() => status()?.configured === true && status()?.connected === true)
  const activeSection = () => props.section?.() ?? "connection"
  const headerRef = useSettingsSectionScroll(activeSection)
  const sectionTitle = () => sectionsForTab("telegram").find((entry) => entry.id === activeSection())?.label ?? "Telegram"

  const loadStatus = async () => {
    const next = await telegramRequest(sdk(), "GET", "")
    setStatus(next)
    return next
  }

  const refreshAgenda = async () => {
    setAgendaRequested(true)
    setAgendaLoading(true)
    try {
      const now = Date.now()
      const response = await sdk().client.quota.resets({ from: String(now), to: String(now + HORIZON_MS) }, { throwOnError: true })
      if (response.data) setAgenda(response.data as QuotaAgendaView)
    } catch {
      setError("Quota windows are currently unavailable. Your saved alert selections remain intact.")
    } finally {
      setAgendaLoading(false)
    }
  }

  const load = async () => {
    setLoading(true)
    setError("")
    try {
      const [, existingQuota] = await Promise.all([
        loadStatus(),
        telegramQuotaRequest(sdk(), "GET"),
      ])
      setQuota(existingQuota)
      // Provider quota discovery belongs to the selected Quota resets subtab,
      // not the Telegram settings or bot-connection lifecycle.
    } catch {
      setError("Could not load Telegram settings. Confirm that the OpenFork server supports quota notifications.")
    } finally {
      setLoading(false)
    }
  }

  onMount(() => void load())

  createEffect(() => {
    if (activeSection() !== "quota" || loading() || !quota() || agendaRequested()) return
    void refreshAgenda()
  })

  // Poll only during a user-initiated pairing ceremony; otherwise Settings
  // contributes no timers, and the Telegram bot is dormant when disabled.
  createEffect(() => {
    const url = pairingLink()
    if (activeSection() !== "connection" || !url || status()?.connected || loading()) return
    let disposed = false
    let inFlight = false
    const check = async () => {
      if (disposed || inFlight) return
      if ((status()?.pairingExpiresAt ?? 0) <= Date.now()) {
        setStatus((current) => current ? { ...current, pairingUrl: undefined, pairingExpiresAt: undefined } : current)
        return
      }
      inFlight = true
      setPolling(true)
      try {
        const next = await telegramRequest(sdk(), "POST", "/pairing/check")
        if (!disposed) {
          setStatus(next)
          if (next.connected) showToast({ variant: "success", icon: "check", title: "Telegram private chat linked" })
        }
      } catch {
        // Surface persistent actionable pairing status without repeating a toast
        // every interval (e.g., a webhook already owns getUpdates).
        if (!disposed) await loadStatus().catch(() => undefined)
      } finally {
        inFlight = false
        if (!disposed) setPolling(false)
      }
    }
    const interval = setInterval(() => void check(), 3000)
    onCleanup(() => {
      disposed = true
      clearInterval(interval)
    })
  })

  const action = async (name: string, run: () => Promise<TelegramHubStatus>, message?: string) => {
    if (busy()) return
    setBusy(name)
    setError("")
    try {
      const next = await run()
      setStatus(next)
      if (message) showToast({ variant: "success", icon: "check", title: message })
    } catch {
      setError(`Could not ${name}. Check the bot, server connection, and Telegram status, then retry.`)
    } finally {
      setBusy("")
    }
  }

  const connectBot = () => {
    const token = botToken().trim()
    if (!/^[0-9]{5,15}:[A-Za-z0-9_-]{20,}$/.test(token)) {
      setError("Enter a valid bot token from @BotFather.")
      return
    }
    void action("connect bot", () => telegramRequest(sdk(), "POST", "/bot", { token }), "Telegram bot verified").then(() => {
      // Never retain a pasted bot token in component state after submission.
      setBotToken("")
      setShowToken(false)
    })
  }

  const beginPairing = () =>
    void action("begin pairing", () => telegramRequest(sdk(), "POST", "/pairing"))

  const quotaAction = async (name: string, next: { enabled: boolean; subscriptions: TelegramQuotaSettings["subscriptions"] }) => {
    if (busy()) return
    setBusy(name)
    setError("")
    try {
      setQuota(await telegramQuotaRequest(sdk(), "PATCH", next))
      await loadStatus()
      if (next.enabled && !agenda()) void refreshAgenda()
    } catch {
      setError(`Could not ${name}. Check the notification service and retry.`)
    } finally {
      setBusy("")
    }
  }

  const setEnabled = (enabled: boolean) =>
    void action(
      enabled ? "enable Telegram" : "disable Telegram",
      () => telegramRequest(sdk(), "PATCH", "", { enabled }),
      enabled ? "Telegram notifications enabled" : "Telegram notifications disabled",
    )

  const setQuotaEnabled = (enabled: boolean) => {
    const current = quota()
    if (!current) return
    void quotaAction(enabled ? "enable quota alerts" : "disable quota alerts", {
      enabled,
      subscriptions: current.subscriptions,
    })
  }

  const toggleOption = (row: QuotaResetOption, enabled: boolean) => {
    const current = quota()
    if (!current) return
    const subscriptions = withSubscription(current.subscriptions, row, enabled)
    void quotaAction(
      enabled ? "subscribe to a quota window" : "unsubscribe from a quota window",
      { enabled: current.enabled, subscriptions },
    )
  }

  const disconnect = () =>
    void action("disconnect Telegram", () => telegramRequest(sdk(), "DELETE", "/bot"), "Telegram disconnected")
      .then(() => { setQuota({ enabled: false, subscriptions: [], scheduled: 0 }); setConfirmDisconnect(false) })

  return (
    <>
        <div ref={headerRef} class="settings-v2-tab-header settings-v2-subsection-header settings-telegram-header">
          <div class="settings-v2-tab-header-row">
            <div class="settings-telegram-title">
              <div class="settings-v2-subsection-parent">Telegram · Notification hub</div>
              <h2 class="settings-v2-tab-title">{sectionTitle()}</h2>
          </div>
          <IconButtonV2
            type="button"
            size="small"
            variant="ghost-muted"
            icon={<IconV2 name="reset" size="small" />}
            aria-label="Refresh Telegram status"
            title="Refresh"
            disabled={loading() || !!busy()}
            onClick={() => { void load(); if (activeSection() === "quota") void refreshAgenda() }}
          />
        </div>
        <Show when={activeSection() === "connection"}>
          <p class="settings-telegram-intro">
            Connect a private Telegram bot and configure each notification service independently. Quota-reset alerts are the first supported service.
          </p>
        </Show>
      </div>

      <div class="settings-v2-tab-body settings-telegram-body">
        <Show when={error()}>
          <div class="settings-telegram-error" role="alert">{error()}</div>
        </Show>

        <Show when={!loading()} fallback={
          <div class="settings-telegram-loading"><Spinner class="size-4" /> Loading Telegram configuration…</div>
        }>
          <Show when={activeSection() === "connection"}>
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">Bot connection</h3>
            <SettingsListV2>
              <SettingsRowV2 title="Telegram bot" description={
                status()?.configured
                  ? `@${status()?.botUsername || "configured"} · token stored server-side`
                  : "Create a bot with @BotFather, then paste its token to verify it. The token is never returned to this interface."
              }>
                <span class="settings-telegram-state" data-state={status()?.configured ? "ready" : "muted"}>
                  {status()?.configured ? "Configured" : "Not configured"}
                </span>
              </SettingsRowV2>
              <Show when={!status()?.configured}>
                <div class="settings-telegram-token-row">
                  <label for="openfork-telegram-token">Bot API token</label>
                  <div class="settings-telegram-token-entry">
                    <input
                      id="openfork-telegram-token"
                      type={showToken() ? "text" : "password"}
                      autocomplete="off"
                      spellcheck={false}
                      placeholder="123456789:AA..."
                      value={botToken()}
                      onInput={(event) => setBotToken(event.currentTarget.value)}
                    />
                    <ButtonV2 size="small" variant="outline" onClick={() => setShowToken(!showToken())}>
                      {showToken() ? "Hide" : "Show"}
                    </ButtonV2>
                    <ButtonV2 size="small" variant="contrast" disabled={!botToken().trim() || !!busy()} onClick={connectBot}>
                      Verify bot
                    </ButtonV2>
                  </div>
                </div>
              </Show>
              <Show when={status()?.configured}>
                <SettingsRowV2
                  title="Private chat"
                  description={status()?.connected
                    ? status()?.chatLabel || "Paired private chat"
                    : "Pair by opening the one-time Telegram link and pressing Start in the bot conversation."}
                >
                  <span class="settings-telegram-state" data-state={status()?.connected ? "ready" : "muted"}>
                    {status()?.connected ? "Linked" : "Not linked"}
                  </span>
                </SettingsRowV2>
                <Show when={!status()?.connected}>
                  <div class="settings-telegram-pair-row">
                    <Show when={pairingLink()} fallback={
                      <ButtonV2 size="small" variant="outline" disabled={!!busy()} onClick={beginPairing}>
                        Generate pairing link
                      </ButtonV2>
                    }>
                      {(link) => (
                        <>
                          <a class="settings-telegram-link" href={link()} target="_blank" rel="noopener noreferrer">
                            Open bot in Telegram <IconV2 name="external-link" size="small" />
                          </a>
                          <span class="settings-telegram-note">
                            One-time link expires {status()?.pairingExpiresAt ? displayTime(status()!.pairingExpiresAt!) : "shortly"}.
                            {polling() ? " Checking for your /start message…" : " Awaiting /start."}
                          </span>
                        </>
                      )}
                    </Show>
                  </div>
                </Show>
              </Show>
            </SettingsListV2>
          </div>
          </Show>

          <Show when={activeSection() === "delivery"}>
          <div class="settings-v2-section">
            <h3 class="settings-v2-section-title">Notifications</h3>
            <SettingsListV2>
              <SettingsRowV2
                title="Enable Telegram notifications"
                description="Master switch for every Telegram notification service. Individual services have their own controls below."
              >
                <Switch
                  checked={status()?.enabled === true}
                  disabled={!setupReady() || !!busy()}
                  onChange={setEnabled}
                />
              </SettingsRowV2>
              <SettingsRowV2
                title="Delivery status"
                description={status()?.lastSuccessAt
                  ? `Last delivered: ${displayTime(status()!.lastSuccessAt!)}`
                  : "No Telegram messages delivered yet"}
              >
                <span class="settings-telegram-state" data-state={status()?.owner ? "ready" : "muted"}>
                  {status()?.owner ? "Monitoring" : status()?.enabled ? "Waiting for active services" : "Idle"}
                </span>
              </SettingsRowV2>
              <Show when={status()?.error}>
                <div class="settings-telegram-error" role="status">{status()?.error}</div>
              </Show>
              <SettingsRowV2 title="Connection test" description="Send a single test message to your linked private Telegram chat.">
                <ButtonV2 size="small" variant="outline" disabled={!setupReady() || !!busy()}
                  onClick={() => void action("send test message", () => telegramRequest(sdk(), "POST", "/test"), "Test notification sent")}>
                  Send test
                </ButtonV2>
              </SettingsRowV2>
              </SettingsListV2>
          </div>
          </Show>

          <Show when={activeSection() === "quota"}>
          <div class="settings-v2-section">
            <div class="settings-telegram-section-heading">
              <h3 class="settings-v2-section-title">Notification services</h3>
              <span class="settings-telegram-muted">{selected()} selected</span>
            </div>
            <p class="settings-telegram-hint">
              Services manage notifications independently. Fixed provider resets may be confirmed; estimates
              generate unverified reminders. Rolling 5h windows alert on verified capacity increases of at least one percentage point.
            </p>
            <SettingsListV2>
              <SettingsRowV2
                title="Quota alerts"
                description="Choose per-account fixed reset alerts, estimated reminders, or observed rolling capacity increases."
              >
                <Switch checked={quota()?.enabled === true} disabled={!status()?.configured || !!busy()} onChange={setQuotaEnabled} />
              </SettingsRowV2>
            </SettingsListV2>
            <div class="settings-telegram-section-heading">
              <span class="settings-telegram-muted">Provider accounts and quota windows</span>
              <ButtonV2 size="small" variant="outline" disabled={agendaLoading()} onClick={() => void refreshAgenda()}>
                {agenda() ? "Refresh windows" : "Discover windows"}
              </ButtonV2>
            </div>
            <Show when={agendaLoading()}>
              <div class="settings-telegram-loading"><Spinner class="size-4" /> Discovering current quota windows…</div>
            </Show>
            <Show when={options().length > 0} fallback={
              <div class="settings-telegram-empty">
                {status()?.configured
                  ? "No provider quota windows are currently available. Connect provider accounts and refresh to discover usage; saved subscriptions remain intact."
                  : "Connect a Telegram bot to discover and select upcoming provider quota windows."}
              </div>
            }>
              <SettingsListV2>
                <For each={options()}>
                  {(option) => (
                    <div class="settings-telegram-window">
                      <div class="settings-telegram-window-main">
                        <div class="settings-telegram-window-name">{option.providerName} <span>· {option.windowKey}</span></div>
                        <div class="settings-telegram-window-details">
                          {identityLabel(option)} · {isRollingQuotaOption(option) ? "Rolling window · no fixed reset time" : `Expected ${displayTime(option.resetAt)}`}
                        </div>
                        <div class="settings-telegram-window-source">
                          {isRollingQuotaOption(option)
                            ? option.source === "provider"
                              ? "Alert on ≥1 percentage-point increase in available capacity (even 98% → 99%) · 1h cooldown"
                              : "Capacity change alerts require live official provider usage · local estimates never trigger"
                            : option.source === "provider"
                              ? "Provider-reported · alert after confirmed reset"
                              : `${option.source} estimate · scheduled reminder, not reset confirmation`}
                        </div>
                      </div>
                      <Switch
                        checked={option.enabled}
                        disabled={!status()?.configured || !!busy()}
                        onChange={(value) => toggleOption(option, value)}
                      />
                    </div>
                  )}
                </For>
              </SettingsListV2>
            </Show>
            <Show when={quota()?.subscriptions.some((sub) =>
              !options().some((option) => option.id === JSON.stringify([
                sub.providerId, sub.scope, sub.accountId ?? "", sub.model ?? "", sub.windowKey,
              ])))}>
              <div class="settings-telegram-note">
                Some previously saved account selections have no currently published reset deadline. They remain
                saved and will be recognized when that provider publishes new quota data.
              </div>
            </Show>
          </div>
          </Show>

          <Show when={activeSection() === "management"}>
          <Show when={status()?.configured}>
            <div class="settings-v2-section">
              <h3 class="settings-v2-section-title">Connection management</h3>
              <SettingsListV2>
                <SettingsRowV2 title="Disconnect Telegram" description="Remove this bot token, private-chat pairing, subscriptions, and pending alerts.">
                  <Show when={confirmDisconnect()} fallback={
                    <ButtonV2 size="small" variant="outline" disabled={!!busy()} onClick={() => setConfirmDisconnect(true)}>
                      Disconnect…
                    </ButtonV2>
                  }>
                    <div class="settings-telegram-disconnect">
                      <ButtonV2 size="small" variant="outline" onClick={() => setConfirmDisconnect(false)}>Cancel</ButtonV2>
                      <ButtonV2 size="small" variant="danger" disabled={!!busy()} onClick={disconnect}>Confirm</ButtonV2>
                    </div>
                  </Show>
                </SettingsRowV2>
              </SettingsListV2>
            </div>
          </Show>
          <p class="settings-telegram-privacy">
            OpenFork sends only provider/account labels, window names, reset timestamps, and capacity-recovery percentages to the linked chat.
            Bot tokens remain on the connected OpenFork server. Telegram messages are not end-to-end encrypted.
            Your OpenFork server must be running for notifications to be delivered; there is no hosted relay.
          </p>
          </Show>
        </Show>
      </div>
    </>
  )
}

export default SettingsTelegramV2
