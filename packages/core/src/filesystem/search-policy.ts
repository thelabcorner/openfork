import { Glob } from "../util/glob"
import path from "path"

export function searchBackend(input: { disableFff: boolean; available: boolean; watcherIgnore: readonly string[] }) {
  // FFF has no ignore-list input. Its background scanner/watchers must not
  // traverse paths that workspace configuration has explicitly excluded.
  return input.disableFff || !input.available || input.watcherIgnore.length > 0 ? "ripgrep" : "fff"
}

export function useSearchIndex(input: { enabled: boolean; watcherIgnore: readonly string[] }) {
  // The materialized index does not consume location-local watcher exclusions.
  return input.enabled && input.watcherIgnore.length === 0
}

export function watcherIgnoredPath(filepath: string, patterns: readonly string[]) {
  const normalized = filepath.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "")
  return patterns.some((pattern) => Glob.match(pattern, normalized))
}

export function workspaceIgnoreGlobs(patterns: readonly string[], directory: string) {
  const root = path.resolve(directory).replaceAll("\\", "/").replace(/\/$/, "")
  const rootPrefix = `${root}/`
  const fold = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value)
  return patterns.flatMap((pattern) => {
    const normalized = pattern.replaceAll("\\", "/")
    if (!path.isAbsolute(pattern)) return [normalized.replace(/^\.\//, "").replace(/^\/+/, "")]
    const absolute = path.resolve(pattern).replaceAll("\\", "/")
    if (fold(absolute) === fold(root)) return ["**"]
    if (!fold(absolute).startsWith(fold(rootPrefix))) return []
    return [absolute.slice(rootPrefix.length)]
  })
}
