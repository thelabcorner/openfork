import { mkdirSync } from "node:fs"
import { isAbsolute, join, resolve } from "node:path"
import type { App } from "electron"

/** Configure every renderer storage path before Electron creates its sessions. */
export function configureElectronFixtureProfile(
  app: Pick<App, "isReady" | "setPath" | "getPath">,
  ownedRoot: string | undefined,
) {
  if (!ownedRoot || !isAbsolute(ownedRoot)) throw new Error("An absolute fixture-owned Electron profile root is required")
  if (app.isReady()) throw new Error("Electron fixture profiles must be configured before app readiness")
  const root = resolve(ownedRoot)
  const paths = {
    userData: join(root, "user-data"),
    sessionData: join(root, "session-data"),
    logs: join(root, "logs"),
    crashDumps: join(root, "crash-dumps"),
  }
  for (const name of Object.keys(paths) as Array<keyof typeof paths>) {
    mkdirSync(paths[name], { recursive: true })
    app.setPath(name, paths[name])
    if (resolve(app.getPath(name)) !== paths[name]) throw new Error(`Electron fixture ${name} escaped its owned profile`)
  }
  // Chromium stores its disk cache under sessionData; "cache" is not an
  // Electron getPath name. Do not use an unsupported setPath("cache", ...).
  return paths
}
