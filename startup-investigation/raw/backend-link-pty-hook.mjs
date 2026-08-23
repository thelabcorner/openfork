// STARTUP-AUTOPSY: resolution shim so the dist bundle's two externals resolve
// exactly as they do inside the desktop sidecar (electron-vite externalizes
// node-pty against packages/desktop/node_modules).
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"

const req = createRequire(new URL("../../packages/desktop/package.json", import.meta.url))

export async function resolve(specifier, context, next) {
  if (specifier === "@lydell/node-pty") {
    return { url: pathToFileURL(req.resolve("@lydell/node-pty")).href, shortCircuit: true }
  }
  return next(specifier, context)
}
