import { createMemo, type Accessor } from "solid-js"
import { useGlobal, type ServerCtx } from "@/context/global"
import { useNotification } from "@/context/notification"
import { usePermission } from "@/context/permission"
import { sessionPermissionRequest, sessionQuestionRequest } from "@/pages/session/composer/session-request-tree"
import { type ProjectAvatarStatus } from "@opencode-ai/ui/v2/project-avatar-v2"
import { ServerConnection } from "@/context/server"

export function useSessionTabAvatarState(
  server: Accessor<ServerConnection.Key>,
  directory: Accessor<string>,
  sessionId: Accessor<string>,
  knownServerCtx?: Accessor<ServerCtx | undefined>,
) {
  const global = useGlobal()
  const notification = useNotification()
  const permission = usePermission()
  // Titlebar tabs already have a server-owned context. Don't rescan the full
  // connection catalogue for every avatar whenever that catalogue changes.
  const connection = createMemo(() =>
    knownServerCtx?.() ? undefined : global.servers.list().find((item) => ServerConnection.key(item) === server()),
  )
  const sync = createMemo(() => {
    const existing = knownServerCtx?.()
    if (existing) return existing.sync
    const conn = connection()
    if (conn) return global.ensureServerCtx(conn).sync
  })
  // A directory's parent->children index is already shared by the child
  // store. Resolve it once per directory/session-list revision, not once per
  // permission and question check across every status indicator.
  const childIndex = createMemo(() => {
    const serverSync = sync()
    if (!serverSync) return
    const [store] = serverSync.child(directory(), { bootstrap: false })
    return store.session_children()
  })
  const hasPermissions = createMemo(() => {
    const serverSync = sync()
    const children = childIndex()
    if (!serverSync || !children) return false
    const permissionState = permission.ensureServerState(server())
    return !!sessionPermissionRequest(
      children,
      serverSync.session.data.permission,
      sessionId(),
      (item) => !permissionState.autoResponds(item, directory()),
    )
  })
  const hasQuestions = createMemo(() => {
    const serverSync = sync()
    const children = childIndex()
    if (!serverSync || !children) return false
    return !!sessionQuestionRequest(children, serverSync.session.data.question, sessionId())
  })
  const needsAttention = createMemo(() => hasPermissions() || hasQuestions())
  const notificationState = createMemo(() => {
    if (!sync()) return
    return notification.ensureServerState(server())
  })
  const unread = createMemo(() => needsAttention() || (notificationState()?.session.unseenCount(sessionId()) ?? 0) > 0)
  const status = createMemo<ProjectAvatarStatus | undefined>(() => {
    const serverSync = sync()
    if (!serverSync) return undefined
    const sessionStatus = serverSync.session.data.session_status[sessionId()]
    if (sessionStatus?.type === "retry") return "error"
    if (hasPermissions()) return "permission"
    if (hasQuestions()) return "question"
    const unseen = (notificationState()?.session.unseenCount(sessionId()) ?? 0) > 0
    if (!serverSync.session.data.session_working(sessionId()) && unseen) return "complete"
    return undefined
  })
  const loading = createMemo(() => {
    const serverSync = sync()
    if (!serverSync) return false
    if (needsAttention()) return false
    return serverSync.session.data.session_working(sessionId())
  })
  return { unread, status, loading }
}
