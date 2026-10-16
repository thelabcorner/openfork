import { createMemo, createSignal, getOwner, onCleanup, runWithOwner, Show, type ParentProps } from "solid-js"
import type { Session } from "@opencode-ai/sdk/v2"
import { base64Encode } from "@opencode-ai/core/util/encode"
import { ServerConnection } from "@/context/server"
import { useGlobal } from "@/context/global"
import { useLocal } from "@/context/local"
import { createPromptSession, type PromptModel, type PromptSession } from "@/context/prompt-state"
import { ServerSDKProvider } from "@/context/server-sdk-provider"
import { ServerSyncProvider } from "@/context/server-sync"
import { ModelsProvider } from "@/context/models"
import { SDKProvider } from "@/context/sdk"
import { DirectoryDataProvider } from "@/pages/directory-layout"
import type { ServerScope } from "@/utils/server-scope"
import { splitModelIDForProvider } from "@/utils/model-account-identity"

export type SessionModelPickerRequest = {
  session: Session
  server?: ServerConnection.Key
  serverScope: ServerScope
  anchor: { top: number; left: number }
  /** Called after the selected session preference is written; group menus use
   * this to apply the same choice to the remaining group members. */
  onModelSelect?: (model: PromptModel | undefined) => void
  applyModelTo?: Array<{ id: string; directory: string }>
  onBulkModelApplied?: (result: { total: number; succeeded: number; failed: number }) => void
}

const promptFromSession = (session: Session | undefined) => {
  const model = session?.model
  if (!model) return undefined
  return {
    providerID: model.providerID,
    modelID: model.id,
    accountID: model.accountID,
    variant: model.variant,
    routeIntent: model.routeIntent,
  }
}

type SessionModelSelection = PromptModel & { accountID?: string }

async function applyPromptModelToGroup(
  members: Array<{ id: string; directory: string }>,
  serverScope: ServerScope,
  owner: ReturnType<typeof getOwner>,
  model: PromptModel | undefined,
) {
  let next = 0
  let succeeded = 0
  let failed = 0
  const workers = Math.min(4, members.length)
  await Promise.all(
    Array.from({ length: workers }, async () => {
      while (next < members.length) {
        const member = members[next++]
        try {
          if (!owner) throw new Error("Prompt model owner is unavailable")
          const prompt = runWithOwner(owner, () =>
            createPromptSession(serverScope, { dir: base64Encode(member.directory), id: member.id }),
          )
          if (!prompt) throw new Error("Prompt session could not be created")
          await prompt.ready.promise
          prompt.model.set(model ? { ...model } : undefined)
          await prompt.flush()
          succeeded++
        } catch {
          failed++
        }
      }
    }),
  )
  return { total: members.length, succeeded, failed }
}

/**
 * Heavy model-picker runtime for session menus. Kept behind a dynamic import so
 * directory/model providers and the selector UI do not participate in shell or
 * Chat-sidebar startup merely because "Change model" exists as an action.
 */
export function SessionModelPicker(props: SessionModelPickerRequest & { onClose: () => void }) {
  const owner = getOwner()
  const prompt = createPromptSession(props.serverScope, {
    dir: base64Encode(props.session.directory),
    id: props.session.id,
  })
  const [ready, setReady] = createSignal(prompt.ready())
  const [bulkPending, setBulkPending] = createSignal(false)
  let closeRequested = false
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
  const close = () => {
    if (bulkPending()) {
      closeRequested = true
      return
    }
    props.onClose()
  }
  const onModelSelect = (model: PromptModel | undefined) => {
    props.onModelSelect?.(model)
    const members = props.applyModelTo
    if (!members) return
    if (members.length === 0) {
      props.onBulkModelApplied?.({ total: 0, succeeded: 0, failed: 0 })
      return
    }
    setBulkPending(true)
    void applyPromptModelToGroup(members, props.serverScope, owner, model)
      .then((result) => props.onBulkModelApplied?.(result))
      .finally(() => {
        setBulkPending(false)
        if (closeRequested) props.onClose()
      })
  }

  return (
    <Show when={ready()}>
      <SessionModelPopoverHost
        session={props.session}
        server={props.server}
        promptModel={prompt.model}
        anchor={props.anchor}
        onClose={close}
        onModelSelect={onModelSelect}
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
  onModelSelect?: (model: PromptModel | undefined) => void
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
        onModelSelect={props.onModelSelect}
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
        onModelSelect={props.onModelSelect}
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
  onModelSelect?: (model: PromptModel | undefined) => void
}) {
  const local = useLocal()
  const localModel = local.model
  const selectedPromptModel = (): SessionModelSelection | undefined => {
    const selected = props.promptModel.current() ?? promptFromSession(props.session)
    if (selected) return selected
    const current = localModel.current()
    if (!current) return undefined
    return { providerID: current.provider.id, modelID: current.id }
  }
  const routeIntentFor = (selected: SessionModelSelection | undefined) => {
    if (
      !selected ||
      selected.accountID ||
      splitModelIDForProvider(selected.modelID, selected.providerID).accountID
    ) {
      return undefined
    }
    if (selected.routeIntent) return selected.routeIntent

    const fromSession = promptFromSession(props.session)
    if (fromSession?.providerID === selected.providerID && fromSession.routeIntent?.kind === "auto") {
      return fromSession.routeIntent
    }

    const current = localModel.current()
    const localIntent = localModel.routeIntent.current()
    if (
      current?.provider.id === selected.providerID &&
      current.id === selected.modelID &&
      localIntent?.kind === "auto"
    ) {
      return localIntent
    }
  }
  const inheritAutoIntent = (previous: SessionModelSelection | undefined, next: PromptModel | undefined) => {
    const intent = routeIntentFor(previous)
    if (
      !previous ||
      !next ||
      previous.accountID ||
      previous.providerID !== next.providerID ||
      splitModelIDForProvider(previous.modelID, previous.providerID).accountID ||
      splitModelIDForProvider(next.modelID, next.providerID).accountID ||
      intent?.kind !== "auto"
    ) {
      return undefined
    }
    return intent
  }
  const wrapper = {
    ...localModel,
    routeIntent: {
      current: () => routeIntentFor(selectedPromptModel()),
    },
    current: () => {
      const selected = selectedPromptModel()
      if (!selected) return localModel.current()
      return (
        localModel.list().find((item) => item.provider.id === selected.providerID && item.id === selected.modelID) ??
        localModel.current()
      )
    },
    set: (
      value: {
        providerID: string
        modelID: string
        variant?: string
        routeIntent?: PromptModel["routeIntent"]
      } | undefined,
      opts?: { recent?: boolean },
    ) => {
      const previous = selectedPromptModel()
      const inherited = inheritAutoIntent(previous, value)
      const selected =
        value && !value.routeIntent && inherited
          ? { ...value, routeIntent: inherited }
          : value
      props.promptModel.set(selected)
      localModel.set(selected, opts)
      props.onModelSelect?.(selected)
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
