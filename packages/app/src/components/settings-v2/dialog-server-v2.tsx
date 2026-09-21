import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { Tag } from "@opencode-ai/ui/v2/badge-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@opencode-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@opencode-ai/ui/v2/divider-v2"
import { Icon as IconV2 } from "@opencode-ai/ui/v2/icon"
import { TextInputV2 } from "@opencode-ai/ui/v2/text-input-v2"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { type Component, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { type ServerConnection } from "@/context/server"
import { useServerManagementController } from "../dialog-select-server"
import "./settings-v2.css"

function shortID(value: string | undefined) {
  if (!value) return "—"
  if (value.length <= 18) return value
  return `${value.slice(0, 8)}…${value.slice(-8)}`
}

export const DialogServerV2: Component<{
  mode: "add" | "edit"
  server?: ServerConnection.Http
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const controller = useServerManagementController({
    onSelect: () => dialog.close(),
    navigateOnAdd: false,
  })
  const [opened, setOpened] = createSignal(false)

  onMount(() => {
    if (props.mode === "add") controller.startAdd()
    if (props.mode === "edit" && props.server) controller.startEdit(props.server)
    setOpened(true)
  })

  onCleanup(() => {
    controller.resetForm()
  })

  createEffect(() => {
    if (!opened()) return
    if (controller.isFormMode()) return
    dialog.close()
  })

  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing) return
    event.preventDefault()
    controller.submitForm()
  }

  const title = () =>
    props.mode === "add" ? language.t("dialog.server.add.title") : language.t("dialog.server.edit.title")

  const submitLabel = () => {
    if (controller.formBusy()) return language.t("dialog.server.add.checking")
    if (props.mode === "add") return language.t("dialog.server.add.button")
    return language.t("common.save")
  }

  const ofxpLabel = () => {
    if (controller.formStatus() === false) return language.t("settings.ofxp.connections.unreachable")
    const identity = controller.formOfxp()
    if (!identity) return language.t("settings.ofxp.connections.identityUnavailable")
    if (!identity.enabled) return language.t("settings.ofxp.connections.networkOff")
    if (!identity.compatible) return language.t("settings.ofxp.connections.protocolMismatch")
    return language.t("settings.ofxp.connections.verifiedIdentity")
  }

  const peerID = () => {
    const identity = controller.formOfxp()
    return identity?.enabled === true ? identity.peerID : undefined
  }

  const fingerprint = () => {
    const identity = controller.formOfxp()
    return identity?.enabled === true ? identity.fingerprint : undefined
  }

  const compatibleIdentity = () => {
    const identity = controller.formOfxp()
    return identity?.enabled === true && identity.compatible
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{title()}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-6">
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.url")}</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              value={controller.formValue()}
              placeholder={language.t("dialog.server.add.placeholder")}
              invalid={!!controller.formError()}
              disabled={controller.formBusy()}
              autofocus
              onInput={(event) => controller.handleFormChange()(event.currentTarget.value)}
              onKeyDown={keyDown}
            />
            <Show when={controller.formError()}>
              <span class="settings-v2-server-dialog-error">{controller.formError()}</span>
            </Show>
          </div>
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.name")}</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              value={controller.formName()}
              placeholder={language.t("dialog.server.add.namePlaceholder")}
              disabled={controller.formBusy()}
              onInput={(event) => controller.handleFormNameChange()(event.currentTarget.value)}
              onKeyDown={keyDown}
            />
          </div>
          <div class="grid w-full min-w-0 grid-cols-2 gap-4">
            <div class="flex min-w-0 flex-col gap-2">
              <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.username")}</label>
              <TextInputV2
                type="text"
                appearance="large"
                class="!w-full self-stretch"
                value={controller.formUsername()}
                placeholder={language.t("dialog.server.add.usernamePlaceholder")}
                disabled={controller.formBusy()}
                onInput={(event) => controller.handleFormUsernameChange()(event.currentTarget.value)}
                onKeyDown={keyDown}
              />
            </div>
            <div class="flex min-w-0 flex-col gap-2">
              <label class="settings-v2-server-dialog-label">{language.t("dialog.server.add.password")}</label>
              <TextInputV2
                type="password"
                appearance="large"
                class="!w-full self-stretch"
                value={controller.formPassword()}
                placeholder={language.t("dialog.server.add.passwordPlaceholder")}
                disabled={controller.formBusy()}
                onInput={(event) => controller.handleFormPasswordChange()(event.currentTarget.value)}
                onKeyDown={keyDown}
              />
            </div>
          </div>
          <Show when={controller.formValue().trim()}>
            <div
              class="settings-v2-server-dialog-ofxp"
              data-health={
                controller.formStatus() === false
                  ? "offline"
                  : controller.formStatus() === true
                    ? "online"
                    : "checking"
              }
            >
              <div class="settings-v2-server-dialog-ofxp-icon">
                <IconV2
                  name={
                    controller.formStatus() === false
                      ? "warning"
                      : compatibleIdentity()
                        ? "check"
                        : "link"
                  }
                  size="small"
                />
              </div>
              <div class="settings-v2-server-dialog-ofxp-copy">
                <span>{language.t("settings.ofxp.connections.networkIdentity")}</span>
                <strong>{controller.formStatus() === undefined ? language.t("settings.ofxp.connections.checkingIdentity") : ofxpLabel()}</strong>
                <Show when={peerID()}>
                  <div>
                    <code>{language.t("settings.ofxp.connections.peerID", { id: shortID(peerID()) })}</code>
                    <span>·</span>
                    <code title={fingerprint()}>{shortID(fingerprint())}</code>
                  </div>
                </Show>
              </div>
              <Show when={compatibleIdentity()}>
                <Tag>{language.t("settings.ofxp.connections.verifiedIdentity")}</Tag>
              </Show>
              <p>{language.t("settings.ofxp.connections.previewNotice")}</p>
            </div>
          </Show>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={controller.formBusy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={controller.formBusy()} onClick={controller.submitForm}>
          {submitLabel()}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
