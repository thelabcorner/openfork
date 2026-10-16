import type { OxpParentActivitySummary } from "@opencode-ai/sdk/v2/client"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { MenuV2 } from "@opencode-ai/ui/v2/menu-v2"
import { createSignal, Show } from "solid-js"
import { useLanguage } from "@/context/language"
import { useOxpActivity } from "@/context/oxp-activity"
import { showToast } from "@/utils/toast"
import { ContextMenuCursorTrigger } from "@/components/context-menu-cursor-trigger"

let renameDialogModule: Promise<typeof import("@/components/dialog-rename-oxp-activity")> | undefined

export function OxpActivityContextMenu(props: {
  activity: OxpParentActivitySummary
  cursor: { x: number; y: number }
  onOpen: () => void
  onOpenChange: (open: boolean) => void
}) {
  const language = useLanguage()
  const dialog = useDialog()
  const store = useOxpActivity()
  const [open, setOpen] = createSignal(true)
  const [busy, setBusy] = createSignal(false)
  const [confirmDelete, setConfirmDelete] = createSignal(false)

  const run = async (
    action: () => Promise<unknown>,
    successTitle: string,
    failureTitle: string,
  ) => {
    if (busy()) return
    setBusy(true)
    try {
      const result = await action()
      if (result === false) throw new Error(failureTitle)
      showToast({ title: successTitle, variant: "success" })
    } catch (error) {
      showToast({
        title: failureTitle,
        description: error instanceof Error && error.message !== failureTitle ? error.message : undefined,
        variant: "error",
      })
    } finally {
      setBusy(false)
    }
  }

  const rename = () => {
    const module = (renameDialogModule ??= import("@/components/dialog-rename-oxp-activity"))
    void module.then(({ DialogRenameOxpActivity }) =>
      dialog.show(() => (
        <DialogRenameOxpActivity
          initial={props.activity.title ?? props.activity.lastRootAlias ?? ""}
          onSubmit={(next) =>
            void run(
              () => store.rename(props.activity.id, next),
              language.t("oxpActivity.action.renamed"),
              language.t("oxpActivity.action.renameFailed"),
            )
          }
        />
      )),
    )
  }

  const copyID = async () => {
    if (typeof navigator === "undefined" || !navigator.clipboard) return
    try {
      await navigator.clipboard.writeText(props.activity.id)
      showToast({ title: language.t("oxpActivity.action.copied"), variant: "success" })
    } catch {
      showToast({ title: language.t("oxpActivity.action.copyFailed"), variant: "error" })
    }
  }

  return (
    <MenuV2
      open={open()}
      onOpenChange={(next) => {
        setOpen(next)
        props.onOpenChange(next)
      }}
      placement="right-start"
      gutter={2}
      shift={2}
      flip
      overflowPadding={8}
    >
      <ContextMenuCursorTrigger x={props.cursor.x} y={props.cursor.y} />
      <MenuV2.Portal>
        <MenuV2.Content class="w-60">
          <MenuV2.Item onSelect={props.onOpen}>
            {language.t("oxpActivity.action.openActivity")}
          </MenuV2.Item>
          <MenuV2.Item disabled={busy()} onSelect={rename}>
            {language.t("oxpActivity.action.rename")}
          </MenuV2.Item>
          <MenuV2.Item
            disabled={busy()}
            onSelect={() =>
              void run(
                () => store.regenerateTitle(props.activity.id),
                language.t("oxpActivity.action.titleRegenerated"),
                language.t("oxpActivity.action.titleNotGenerated"),
              )
            }
          >
            {language.t("oxpActivity.action.regenerateTitle")}
          </MenuV2.Item>
          <MenuV2.Item closeOnSelect={false} disabled={busy()} onSelect={() => void copyID()}>
            {language.t("oxpActivity.action.copyID")}
          </MenuV2.Item>
          <MenuV2.Separator />
          <MenuV2.Item
            disabled={busy()}
            onSelect={() =>
              void run(
                () => store.archive(props.activity.id, true),
                language.t("oxpActivity.action.archivedToast"),
                language.t("oxpActivity.action.archiveFailed"),
              )
            }
          >
            {language.t("oxpActivity.action.archive")}
          </MenuV2.Item>
          <Show
            when={confirmDelete()}
            fallback={
              <MenuV2.Item closeOnSelect={false} disabled={busy()} onSelect={() => setConfirmDelete(true)}>
                {language.t("oxpActivity.action.delete")}
              </MenuV2.Item>
            }
          >
            <MenuV2.Item
              disabled={busy()}
              class="text-v2-state-fg-danger"
              onSelect={() =>
                void run(
                  () => store.remove(props.activity.id),
                  language.t("oxpActivity.action.deletedToast"),
                  language.t("oxpActivity.action.deleteFailed"),
                )
              }
            >
              {language.t("oxpActivity.action.deleteConfirm")}
            </MenuV2.Item>
          </Show>
        </MenuV2.Content>
      </MenuV2.Portal>
    </MenuV2>
  )
}
