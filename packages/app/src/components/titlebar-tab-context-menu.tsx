import { createSignal, lazy, Show, Suspense, type ParentProps } from "solid-js"
import type { ServerConnection } from "@/context/server"
import type { Session } from "@opencode-ai/sdk/v2"

const TitlebarTabContextMenuRuntime = lazy(() =>
  import("./titlebar-tab-context-menu-runtime").then((module) => ({ default: module.TitlebarTabContextMenuRuntime })),
)

type Props = ParentProps<{
  id: string
  session?: () => Session | undefined
  server?: ServerConnection.Key
  isGroup?: boolean
  groupId?: string
  groupName?: string
  onOpenChange?: (open: boolean) => void
}>

/**
 * Zero-idle-cost tab context-menu trigger.
 *
 * The old wrapper mounted one complete SessionContextMenu owner per visible tab,
 * pulling the unified menu/dialog/action graph into the titlebar's synchronous
 * startup module graph. A right-click is the first moment any of that code can
 * affect UX, so keep only the trigger surface eager and instantiate the exact
 * same menu implementation at the cursor on demand.
 */
export function TitlebarTabContextMenu(props: Props) {
  const [cursor, setCursor] = createSignal<{ x: number; y: number }>()

  return (
    <>
      <div
        class="block h-full w-full min-w-0"
        onContextMenu={(event) => {
          event.preventDefault()
          setCursor({ x: event.clientX, y: event.clientY })
        }}
      >
        {props.children}
      </div>
      <Show when={cursor()} keyed>
        {(position) => (
          <Suspense>
            <TitlebarTabContextMenuRuntime
              id={props.id}
              session={props.session}
              server={props.server}
              isGroup={props.isGroup}
              groupId={props.groupId}
              groupName={props.groupName}
              cursor={position}
              onOpenChange={(open) => {
                props.onOpenChange?.(open)
                if (!open) setCursor(undefined)
              }}
            />
          </Suspense>
        )}
      </Show>
    </>
  )
}
