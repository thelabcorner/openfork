import { createMemo, createSignal, onCleanup, Show, type ParentProps } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { ServerConnection } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useLocal } from "@/context/local"
import { createPromptSession, type PromptSession } from "@/context/prompt-state"
import { ServerSDKProvider } from "@/context/server-sdk"
import { ServerSyncProvider } from "@/context/server-sync"
import { ModelsProvider } from "@/context/models"
import { SDKProvider } from "@/context/sdk"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import type { ServerScope } from "@/utils/server-scope"

export type SessionModelPickerRequest = {
  session: Session
  server?: ServerConnection.Key
  serverScope: ServerScope
  anchor: { top: number; left: number }
}

const promptFromSession = (session: Session | undefined) => {
  const model = session?.model
  if (!model) return undefined
  return { providerID: model.providerID, modelID: model.id, variant: model.variant }
}

/**
 * Heavy model-picker runtime for session menus. Kept behind a dynamic import so
 * directory/model providers and the selector UI do not participate in shell or
 * Chat-sidebar startup merely because "Change model" exists as an action.
 */
export function SessionModelPicker(props: SessionModelPickerRequest & { onClose: () => void }) {
  const prompt = createPromptSession(props.serverScope, {
    dir: base64Encode(props.session.directory),
    id: props.session.id,
  })
  const [ready, setReady] = createSignal(prompt.ready())
  let disposed = false

  if (!ready()) {
    void Promise.resolve(prompt.ready.promise)
      .then(() => {
        if (!disposed) setReady(true)
      })
      .catch(() => {
        if (!disposed) props.onClose()
      })
  }
  onCleanup(() => {
    disposed = true
  })

  return (
    <Show when={ready()}>
      <SessionModelPopoverHost
        session={props.session}
        server={props.server}
        promptModel={prompt.model}
        anchor={props.anchor}
        onClose={props.onClose}
      />
    </Show>
  )
}

function SessionModelPopoverHost(props: {
  session: Session
  server?: ServerConnection.Key
  promptModel: PromptSession["model"]
  anchor: { top: number; left: number }
  onClose: () => void
}) {
  let ambientLocal: ReturnType<typeof useLocal> | undefined
  try {
    ambientLocal = useLocal()
  } catch {
    ambientLocal = undefined
  }

  if (ambientLocal) {
    return (
      <ModelWrapperPopover
        session={props.session}
        promptModel={props.promptModel}
        anchor={props.anchor}
        onClose={props.onClose}
      />
    )
  }

  return (
    <ScopedLocalProvider session={props.session} server={props.server}>
      <ModelWrapperPopover
        session={props.session}
        promptModel={props.promptModel}
        anchor={props.anchor}
        onClose={props.onClose}
      />
    </ScopedLocalProvider>
  )
}

function ScopedLocalProvider(props: ParentProps<{ session: Session; server?: ServerConnection.Key }>) {
  const global = useGlobal()
  const conn = createMemo(() =>
    props.server ? global.servers.list().find((item) => ServerConnection.key(item) === props.server) : undefined,
  )
  const directory = () => props.session.directory
  const server = () => props.server

  return (
    <ServerSDKProvider server={conn}>
      <ServerSyncProvider server={conn}>
        <ModelsProvider directory={directory}>
          <SDKProvider directory={directory}>
            <DirectoryDataProvider directory={directory} server={server}>
              {props.children}
            </DirectoryDataProvider>
          </SDKProvider>
        </ModelsProvider>
      </ServerSyncProvider>
    </ServerSDKProvider>
  )
}

function ModelWrapperPopover(props: {
  session: Session
  promptModel: PromptSession["model"]
  anchor: { top: number; left: number }
  onClose: () => void
}) {
  const local = useLocal()
  const localModel = local.model
  const wrapper = {
    ...localModel,
    current: () => {
      const selected = props.promptModel.current() ?? promptFromSession(props.session)
      if (!selected) return localModel.current()
      return (
        localModel.list().find((item) => item.provider.id === selected.providerID && item.id === selected.modelID) ??
        localModel.current()
      )
    },
    set: (
      value: { providerID: string; modelID: string; variant?: string } | undefined,
      opts?: { recent?: boolean },
    ) => {
      props.promptModel.set(value)
      localModel.set(value, opts)
    },
  }

  return <SessionModelPopover model={wrapper} anchor={props.anchor} onClose={props.onClose} />
}

function SessionModelPopover(props: {
  model: ReturnType<typeof useLocal>["model"]
  anchor: { top: number; left: number }
  onClose: () => void
}) {
  const [Comp, setComp] = createSignal<typeof import("@/components/dialog-select-model").ModelSelectorPopoverV2>()
  void import("@/components/dialog-select-model").then((mod) => setComp(() => mod.ModelSelectorPopoverV2))

  return (
    <Show when={Comp()} keyed>
      {(C) => (
        <C
          model={props.model}
          defaultOpen
          onClose={props.onClose}
          trigger={(triggerProps) => (
            <button
              {...triggerProps}
              type="button"
              ref={(el: HTMLButtonElement) => {
                const forwardRef = (triggerProps as { ref?: (el: HTMLButtonElement) => void }).ref
                if (typeof forwardRef === "function") forwardRef(el)
              }}
              style={{
                position: "fixed",
                top: `${props.anchor.top}px`,
                left: `${props.anchor.left}px`,
                width: "1px",
                height: "1px",
                opacity: 0,
                "pointer-events": "none",
              }}
              tabIndex={-1}
              aria-hidden="true"
            />
          )}
        />
      )}
    </Show>
  )
}
