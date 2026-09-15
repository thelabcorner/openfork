import type { ServerConnection } from "@/context/server"
import { useSessionTabAvatarState } from "@/pages/layout/project-avatar-state"
import type { ProjectAvatarStatus } from "@opencode-ai/ui/v2/project-avatar-v2"
import type { Accessor, JSX } from "solid-js"
import type { HomeSessionRecord } from "./home-session-types"

/**
 * Lightweight status adapter shared by home rows and the Chat sidebar.
 *
 * Keep this separate from home-sessions-controller.tsx: rendering a session
 * avatar/status must not pull home-only query, archive, mutation, command, or
 * dialog machinery into consumers that only need status state.
 */
export function HomeSessionStatusController(props: {
  server: Accessor<ServerConnection.Key>
  record: HomeSessionRecord
  isOpenTab: (record: HomeSessionRecord) => boolean
  render: (state: {
    unread: Accessor<boolean>
    status: Accessor<ProjectAvatarStatus | undefined>
    loading: Accessor<boolean>
    open: Accessor<boolean>
  }) => JSX.Element
}) {
  const avatar = useSessionTabAvatarState(
    props.server,
    () => props.record.session.directory,
    () => props.record.session.id,
  )
  return props.render({
    unread: avatar.unread,
    status: avatar.status,
    loading: avatar.loading,
    open: () => props.isOpenTab(props.record),
  })
}
