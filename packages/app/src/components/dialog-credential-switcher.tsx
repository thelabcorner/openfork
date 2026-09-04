import { type Accessor, type Component, createMemo, createSignal, For, Show } from "solid-js"
import { createStore } from "solid-js/store"
import { Dialog as DialogV2, DialogBody, DialogHeader, DialogTitleGroup } from "@opencode-ai/ui/v2/dialog-v2"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { IconButtonV2 } from "@opencode-ai/ui/v2/icon-button-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { Spinner } from "@opencode-ai/ui/spinner"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useLanguage } from "@/context/language"
import { useForkUsage } from "@/context/fork-usage"
import { useServerSDK } from "@/context/server-sdk"
import { useServerSync } from "@/context/server-sync"
import { useNow } from "@/hooks/use-now"
import { showToast } from "@/utils/toast"
import { ForkClient, type ForkCredentialInfo, type ForkServer } from "@/utils/fork-client"
import { UsageBreakdownV2 } from "./usage-gauge-v2"

export const DialogCredentialSwitcherV2: Component<{
  directory?: Accessor<string | undefined>
}> = (props) => {
  const language = useLanguage()
  const serverSDK = useServerSDK()
  const serverSync = useServerSync()
  const forkUsage = useForkUsage()
  const server = (): ForkServer => serverSDK().server.http
  const directory = () => props.directory?.()

  const now = useNow()

  const credentials = forkUsage.credentials
  const usage = forkUsage.usage

  const [renaming, setRenaming] = createSignal<string | undefined>()
  const [confirmingRemove, setConfirmingRemove] = createSignal<string | undefined>()
  const [renameStore, setRenameStore] = createStore({ value: "" })
  const [addStore, setAddStore] = createStore({ open: false, key: "", label: "", error: undefined as string | undefined })

  const COOLDOWN_MS = 30_000
  const [lastRefreshedAt, setLastRefreshedAt] = createSignal(0)
  const cooldownRemaining = () => Math.max(0, COOLDOWN_MS - (now() - lastRefreshedAt()))
  const isCoolingDown = () => cooldownRemaining() > 0
  const isRefreshing = () => usage.loading
  const canRefresh = () => !isCoolingDown() && !isRefreshing()

  const refreshUsage = () => {
    if (!canRefresh()) return
    setLastRefreshedAt(now())
    forkUsage.refreshUsage()
  }

  const refreshAll = async () => {
    forkUsage.refreshAll()
    await serverSync().refreshProviders().catch(() => undefined)
  }

  // The pool account a bare request routes to (env-first, else the vault
  // designated default). The vault rows are keyed by UUID; locate the vault
  // row whose pool identity matches so the badge is exact even when env keys
  // outrank a vault-designated default.
  const defaultVaultID = () => {
    const defaultAccountID = forkUsage.usage.latest?.defaultAccountID
    if (!defaultAccountID) return undefined
    return forkUsage.usage.latest?.byCredential.find((entry) => entry.accountID === defaultAccountID)?.credentialID
  }
  // Vault rows plus a read-only synthetic row when the pool default is an env
  // key the vault has no row for (so a bare request's real target is never
  // invisible / mislabeled as "no keys").
  type CredentialRow = ForkCredentialInfo & { readonly: boolean; isDefault: boolean }
  const rows = createMemo<CredentialRow[]>(() => {
    const vault = credentials.latest ?? []
    const fallbackActive = () => vault.find((credential) => credential.active)?.id
    const activeID = () => defaultVaultID() ?? fallbackActive()
    const out: CredentialRow[] = vault.map((credential) => ({
      ...credential,
      readonly: false,
      isDefault: activeID() === credential.id,
    }))
    const defaultAccountID = forkUsage.usage.latest?.defaultAccountID
    const covered = out.some((row) => row.isDefault)
    if (defaultAccountID && !covered) {
      out.push({
        id: defaultAccountID,
        label: forkUsage.usage.latest?.defaultAccountLabel ?? language.t("dialog.credential.envSource"),
        active: false,
        timeCreated: 0,
        readonly: true,
        isDefault: true,
      })
    }
    return out
  })

  const setDefault = async (credentialID: string) => {
    await ForkClient.setDefault(server(), credentialID, directory())
    await refreshAll()
  }

  const startRename = (credential: { id: string; label: string }) => {
    setConfirmingRemove(undefined)
    setRenaming(credential.id)
    setRenameStore("value", credential.label)
  }

  const submitRename = async (credentialID: string) => {
    const label = renameStore.value.trim()
    if (!label) return
    await ForkClient.rename(server(), credentialID, label)
    setRenaming(undefined)
    forkUsage.refreshAll()
  }

  const remove = async (credentialID: string) => {
    await ForkClient.remove(server(), credentialID, directory())
    setConfirmingRemove(undefined)
    await refreshAll()
    showToast({ variant: "success", icon: "circle-check", title: language.t("dialog.credential.remove") })
  }

  const submitAdd = async (event: SubmitEvent) => {
    event.preventDefault()
    const key = addStore.key.trim()
    if (!key) {
      setAddStore("error", language.t("provider.connect.apiKey.required"))
      return
    }
    setAddStore("error", undefined)
    await ForkClient.add(server(), { key, label: addStore.label.trim() || undefined, directory: directory() })
    setAddStore({ open: false, key: "", label: "", error: undefined })
    await refreshAll()
    showToast({
      variant: "success",
      icon: "circle-check",
      title: language.t("provider.connect.toast.connected.title", { provider: "OpenCode" }),
    })
  }

  const usageFor = (credentialID: string) => forkUsage.usageWindowsFor(credentialID)

  return (
    <DialogV2
      size={addStore.open ? "large" : "normal"}
      variant="settings"
      fit
      containerClass="!h-auto max-h-[calc(100vh-32px)] max-w-[calc(100vw-32px)]"
    >
      <DialogHeader hideClose={false} closeLabel={language.t("common.close")}>
        <DialogTitleGroup
          title={language.t("dialog.credential.title")}
          description={language.t("dialog.credential.description")}
        />
        <IconButtonV2
          type="button"
          size="small"
          variant="ghost-muted"
          aria-label={language.t("browser.tab.refresh")}
          title={language.t("browser.tab.refresh")}
          disabled={!canRefresh()}
          onClick={() => refreshUsage()}
          icon={
            <Show
              when={isRefreshing()}
              fallback={
                <Show when={isCoolingDown()} fallback={
                  <svg
                    data-slot="icon-svg"
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    xmlns="http://www.w3.org/2000/svg"
                    aria-hidden="true"
                  >
                    <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                    <path d="M3 3v5h5" />
                    <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                    <path d="M16 16h5v5" />
                  </svg>
                }>
                  <span class="text-[10px] font-[560] leading-none tabular-nums">{Math.ceil(cooldownRemaining() / 1000)}</span>
                </Show>
              }
            >
              <Spinner class="size-3.5 shrink-0" />
            </Show>
          }
        />
      </DialogHeader>
      <DialogBody class="!flex-none !overflow-visible">
        <div class="flex flex-col gap-4 px-5 pt-3 pb-5">
          <Show
            when={!credentials.loading}
            fallback={
              <div class="flex items-center justify-center gap-2 px-1 py-6 text-[13px] text-v2-text-text-faint">
                <Spinner class="size-3.5 shrink-0" />
                {language.t("common.loading")}
                {language.t("common.loading.ellipsis")}
              </div>
            }
          >
          <Show
            when={rows().length > 0}
            fallback={<div class="px-1 py-3 text-[13px] text-v2-text-text-faint">{language.t("dialog.credential.empty")}</div>}
          >
            <div class="flex flex-col gap-1.5">
              <For each={rows()}>
                {(credential) => {
                    const windows = () => usageFor(credential.id)
                    return (
                      <div
                        class="flex flex-col gap-2 rounded-[6px] border px-3 py-2.5 data-[active=true]:border-v2-border-border-muted data-[active=true]:bg-v2-overlay-simple-overlay-hover data-[active=true]:shadow-[inset_0_0_0_1px_var(--v2-border-border-muted)]"
                        data-active={credential.isDefault ? "true" : undefined}
                      >
                        <Show
                          when={renaming() === credential.id}
                          fallback={
                            <div class="flex items-center gap-2">
                              <div class="flex min-w-0 flex-1 items-center gap-2">
                                <Show when={credential.isDefault}>
                                  <IconV2 name="check" size="small" class="shrink-0 text-v2-state-fg-success" />
                                </Show>
                                <span class="min-w-0 truncate text-[13px] font-[530] leading-5 text-v2-text-text-base">
                                  {credential.label}
                                </span>
                                <Show when={credential.isDefault}>
                                  <span class="shrink-0 rounded-[4px] bg-v2-state-bg-success px-1.5 py-0.5 text-[10px] font-[530] leading-3 text-v2-state-fg-success">
                                    {language.t("dialog.credential.default")}
                                  </span>
                                </Show>
                                <Show when={credential.readonly}>
                                  <span class="shrink-0 rounded-[4px] bg-v2-border-border-muted px-1.5 py-0.5 text-[10px] font-[530] leading-3 text-v2-text-text-muted">
                                    {language.t("dialog.credential.envSource")}
                                  </span>
                                </Show>
                              </div>
                              <Show when={!credential.isDefault && !credential.readonly}>
                                <ButtonV2 size="small" variant="outline" onClick={() => void setDefault(credential.id)}>
                                  {language.t("dialog.credential.setDefault")}
                                </ButtonV2>
                              </Show>
                              <Show when={!credential.readonly}>
                                <IconButtonV2
                                  type="button"
                                  size="small"
                                  variant="ghost-muted"
                                  icon={<IconV2 name="edit" size="small" />}
                                  aria-label={language.t("dialog.credential.rename")}
                                  onClick={() => startRename(credential)}
                                />
                              </Show>
                              <Show
                                when={confirmingRemove() === credential.id}
                                fallback={
                                  <IconButtonV2
                                    type="button"
                                    size="small"
                                    variant="ghost-muted"
                                    icon={<IconV2 name="trash" size="small" class="!text-v2-state-fg-danger" />}
                                    aria-label={language.t("dialog.credential.remove")}
                                    onClick={() => setConfirmingRemove(credential.id)}
                                  />
                                }
                              >
                                <ButtonV2 size="small" variant="danger" onClick={() => void remove(credential.id)}>
                                  {language.t("dialog.credential.remove")}
                                </ButtonV2>
                              </Show>
                            </div>
                          }
                        >
                          <form
                            class="flex w-full items-center gap-2"
                            onSubmit={(event) => {
                              event.preventDefault()
                              void submitRename(credential.id)
                            }}
                          >
                            <TextInputV2
                              class="!w-full !flex-1 min-w-0"
                              autofocus
                              value={renameStore.value}
                              placeholder={language.t("dialog.credential.rename.placeholder")}
                              onInput={(event) => setRenameStore("value", event.currentTarget.value)}
                            />
                            <ButtonV2
                              type="button"
                              size="small"
                              variant="ghost"
                              onClick={() => {
                                setConfirmingRemove(undefined)
                                setRenaming(undefined)
                              }}
                            >
                              {language.t("common.cancel")}
                            </ButtonV2>
                            <ButtonV2 type="submit" size="small" variant="neutral">
                              {language.t("common.continue")}
                            </ButtonV2>
                            <Show
                              when={confirmingRemove() === credential.id}
                              fallback={
                                <IconButtonV2
                                  type="button"
                                  size="small"
                                  variant="ghost-muted"
                                  icon={<IconV2 name="trash" size="small" class="!text-v2-state-fg-danger" />}
                                  aria-label={language.t("dialog.credential.remove")}
                                  onClick={() => setConfirmingRemove(credential.id)}
                                />
                              }
                            >
                              <ButtonV2 size="small" variant="danger" onClick={() => void remove(credential.id)}>
                                {language.t("dialog.credential.remove")}
                              </ButtonV2>
                            </Show>
                          </form>
                        </Show>
                        <Show
                          when={windows()}
                          fallback={
                            <Show when={usage.loading}>
                              <div class="flex items-center gap-2 px-0.5 py-1 text-[11px] text-v2-text-text-faint">
                                <Spinner class="size-3 shrink-0" />
                                {language.t("common.loading")}
                                {language.t("common.loading.ellipsis")}
                              </div>
                            </Show>
                          }
                        >
                          {(result) => (
                            <div class="flex flex-col gap-1.5 border-t border-v2-border-border-muted pt-1.5">
                              <div class="flex items-center justify-between">
                                <span class="text-[10px] font-[560] uppercase leading-3 tracking-[0.04em] text-v2-text-text-muted">
                                  {language.t("usage.go.title")}
                                </span>
                                <span class="text-[9px] font-[440] uppercase leading-3 tracking-[0.06em] text-v2-text-text-faint">
                                  {language.t("usage.reset.predicted")}
                                </span>
                              </div>
                              <UsageBreakdownV2 windows={result()} now={now()} />
                            </div>
                          )}
                        </Show>
                      </div>
                    )
                  }}
                </For>
              </div>
            </Show>
          </Show>

          <Show
            when={addStore.open}
            fallback={
              <ButtonV2 size="small" variant="outline" icon="plus" class="self-start" onClick={() => setAddStore("open", true)}>
                {language.t("dialog.credential.add")}
              </ButtonV2>
            }
          >
            <form onSubmit={(event) => void submitAdd(event)} class="flex flex-col gap-2 rounded-md border border-v2-border-border-muted p-3">
              <TextInputV2
                autofocus
                value={addStore.key}
                placeholder={language.t("provider.connect.apiKey.placeholder")}
                invalid={addStore.error !== undefined}
                autocomplete="off"
                spellcheck={false}
                onInput={(event) => setAddStore("key", event.currentTarget.value)}
              />
              <TextInputV2
                value={addStore.label}
                placeholder={language.t("provider.connect.apiKey.labelPlaceholder")}
                autocomplete="off"
                spellcheck={false}
                onInput={(event) => setAddStore("label", event.currentTarget.value)}
              />
              <Show when={addStore.error}>
                {(error) => <div class="text-[12px] text-v2-state-fg-danger">{error()}</div>}
              </Show>
              <div class="flex gap-2">
                <ButtonV2 type="submit" size="small" variant="contrast">
                  {language.t("common.continue")}
                </ButtonV2>
                <ButtonV2
                  type="button"
                  size="small"
                  variant="ghost"
                  onClick={() => setAddStore({ open: false, key: "", label: "", error: undefined })}
                >
                  {language.t("common.close")}
                </ButtonV2>
              </div>
            </form>
          </Show>
        </div>
      </DialogBody>
    </DialogV2>
  )
}
