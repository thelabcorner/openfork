import path from "path"

// Derive the changed subtree (a root-relative dirPath) from an absolute watcher
// event path. A file event invalidates its parent dir; a directory create/delete
// event invalidates its parent too (the new/removed dir appears in that listing).
// Mirrors search.ts's filtering: skip anything outside the root and any dot
// segment (the watcher also subscribes to .git, which the index never lists).
export function deriveDir(root: string, file: string): string | undefined {
  const rel = path.relative(root, file).replaceAll("\\", "/")
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return undefined
  if (rel.split("/").some((segment) => segment === "" || segment.startsWith("."))) return undefined
  return rel.split("/").slice(0, -1).join("/")
}
