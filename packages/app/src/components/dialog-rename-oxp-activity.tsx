import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { createSignal } from "solid-js"
import { useLanguage } from "@/context/language"

export function DialogRenameOxpActivity(props: { initial: string; onSubmit: (title: string) => void }) {
  const dialog = useDialog()
  const language = useLanguage()
  const [title, setTitle] = createSignal(props.initial)

  return (
    <Dialog title={language.t("oxpActivity.action.rename")} class="w-full max-w-[420px]">
      <form
        class="flex flex-col gap-5 p-5 pt-1"
        onSubmit={(event) => {
          event.preventDefault()
          const value = title().trim()
          if (!value) return
          props.onSubmit(value)
          dialog.close()
        }}
      >
        <TextField
          autofocus
          type="text"
          label={language.t("oxpActivity.action.renamePlaceholder")}
          placeholder={language.t("oxpActivity.action.renamePlaceholder")}
          value={title()}
          onChange={setTitle}
        />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!title().trim()}>
            {language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}
