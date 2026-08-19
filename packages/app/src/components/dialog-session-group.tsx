import { Button } from "@opencode-ai/ui/button"
import { Dialog } from "@opencode-ai/ui/dialog"
import { TextField } from "@opencode-ai/ui/text-field"
import { For, Show, createSignal } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"

export function DialogSessionGroupName(props: {
  initial?: string
  onSubmit: (name: string) => void
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const [name, setName] = createSignal(props.initial ?? "")

  return (
    <Dialog title={props.initial ? language.t("common.rename") : language.t("sessionGroup.create")} class="w-full max-w-[420px]">
      <form
        class="flex flex-col gap-5 p-5 pt-1"
        onSubmit={(event) => {
          event.preventDefault()
          const value = name().trim()
          if (!value) return
          props.onSubmit(value)
          dialog.close()
        }}
      >
        <TextField
          autofocus
          type="text"
          label={language.t("sessionGroup.name.input")}
          placeholder={language.t("sessionGroup.name.placeholder")}
          value={name()}
          onChange={setName}
        />
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" disabled={!name().trim()}>
            {language.t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  )
}

export function DialogSessionGroupPicker(props: {
  groups: Array<{ id: string; name: string }>
  onSelect: (groupId: string) => void
  onCreate: () => void
}) {
  const dialog = useDialog()
  const language = useLanguage()

  return (
    <Dialog title={language.t("sessionGroup.addTo")} class="w-full max-w-[420px]">
      <div class="flex flex-col gap-1 p-5 pt-1">
        <For each={props.groups}>
          {(group) => (
            <Button
              type="button"
              variant="ghost"
              class="justify-start"
              onClick={() => {
                props.onSelect(group.id)
                dialog.close()
              }}
            >
              {group.name}
            </Button>
          )}
        </For>
        <Show when={props.groups.length > 0}>
          <div class="my-2 h-px bg-border-base" />
        </Show>
        <Button
          type="button"
          variant="ghost"
          class="justify-start"
          onClick={() => {
            dialog.close()
            props.onCreate()
          }}
        >
          {language.t("home.sessions.contextMenu.newGroup")}
        </Button>
      </div>
    </Dialog>
  )
}
