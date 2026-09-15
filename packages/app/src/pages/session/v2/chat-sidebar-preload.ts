let pending: Promise<typeof import("./chat-sidebar-pane")> | undefined

export function loadChatSidebarPane() {
  return (pending ??= import("./chat-sidebar-pane"))
}
