import { getOwner, runWithOwner } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/context/language"
import type { Session } from "@opencode-ai/sdk/v2"
import type { ServerConnection } from "@/context/server"
import { showToast } from "@/utils/toast"
import { beginTitleRegeneration, endTitleRegeneration, isTitleRegenerationPending, type TabSessionApi } from "./titlebar-tab-actions"
import { sessionTitleErrorMessage } from "./session-title-error"

/**
 * One shared manual retitle workflow for session commands, tabs and context
 * menus. A failed model never triggers a new provider request: only selecting
 * another model in the dialog does. Selection applies to this title request
 * alone; it does not silently mutate the chat's model preference.
 */
export function createSessionTitleRegeneration(input: {
  sessionID: () => string | undefined
  session: () => Session | undefined
  api: () => TabSessionApi | undefined
  server?: () => ServerConnection.Key | undefined
}) {
  const dialog = useDialog()
  const language = useLanguage()
  const owner = getOwner()

  // Bind every failed attempt to its original session/server. A toast may be
  // acted on after the user switches tabs; it must never retitle the new tab.
  type Target = {
    sessionID: string
    session: Session | undefined
    api: TabSessionApi
    server: ServerConnection.Key | undefined
  }

  const chooseModel = (target?: Target) => {
    const chosen = target ?? (() => {
      const sessionID = input.sessionID()
      const api = input.api()
      return sessionID && api
        ? { sessionID, session: input.session(), api, server: input.server?.() }
        : undefined
    })()
    const session = chosen?.session
    if (!chosen || !session || session.id !== chosen.sessionID) {
      showToast({
        title: language.t("toast.title.failed"),
        description: language.t("toast.title.modelPickerUnavailable"),
        variant: "error",
      })
      return
    }
    void import("./session-menu/session-model-dialog").then(({ DialogSessionModelPicker }) => {
      if (!owner) return
      runWithOwner(owner, () =>
        void dialog.show(() => (
          <DialogSessionModelPicker
            session={session}
            server={chosen.server}
            onSelectModel={(model) => {
              // The user explicitly authorizes precisely this model for
              // precisely this session, not a persistent composer change.
              run(model, chosen)
            }}
          />
        )),
      )
    }).catch((error) => {
      showToast({
        title: language.t("toast.title.failed"),
        description: error instanceof Error ? error.message : language.t("toast.title.modelPickerUnavailable"),
        variant: "error",
      })
    })
  }

  const run = (model?: { providerID: string; id: string }, target?: Target) => {
    const sessionID = target?.sessionID ?? input.sessionID()
    const api = target?.api ?? input.api()
    if (!sessionID || !api || isTitleRegenerationPending(sessionID)) return
    const pinned = target ?? { sessionID, session: input.session(), api, server: input.server?.() }
    beginTitleRegeneration(sessionID)
    void api.regenerateTitle({ sessionID, ...(model ? { model } : {}) })
      .then(() => showToast({ title: language.t("toast.title.regenerated"), variant: "success" }))
       .catch((error) =>
         showToast({
           title: language.t("toast.title.failed"),
           description: sessionTitleErrorMessage(error) ?? language.t("toast.title.pickAnotherModel"),
          variant: "error",
          actions: [{ label: language.t("toast.title.chooseModel"), onClick: () => chooseModel(pinned) }],
        }),
      )
      .finally(() => endTitleRegeneration(sessionID))
  }

  return { run, chooseModel }
}
