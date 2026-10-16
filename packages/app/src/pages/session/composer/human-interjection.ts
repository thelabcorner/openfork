/** Presentation consumes the server capability, never reconstructs delegation. */
export function isReadOnlyChild(session: { parentID?: string; humanInterjection?: boolean } | undefined) {
  return !!session?.parentID && session.humanInterjection !== true
}

export function showsSessionComposer(
  session: { parentID?: string; humanInterjection?: boolean } | undefined,
  permissionPending: boolean,
) {
  return session?.humanInterjection === true || !permissionPending || !!session?.parentID
}
