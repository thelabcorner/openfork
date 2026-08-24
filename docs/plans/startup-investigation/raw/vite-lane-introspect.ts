// STARTUP-AUTOPSY: one-off introspection of vite 7 DevServer shape (vite-lane).
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import path from "node:path"

const desktopDir = path.resolve(import.meta.dir, "../../packages/desktop")
process.chdir(desktopDir)
const req = createRequire(path.join(desktopDir, "package.json"))
const { resolveConfig } = await import(pathToFileURL(req.resolve("electron-vite")).href)
const resolved = await resolveConfig({}, "serve")
const cfg = resolved.config.renderer
cfg.cacheDir = path.resolve(import.meta.dir, "vite-lane-probe-cache")
cfg.server = { ...cfg.server, port: 5181, strictPort: false }
cfg.logLevel = "silent"
const { createServer } = await import(pathToFileURL(req.resolve("vite")).href)
const server = await createServer(cfg)
await server.listen()

console.log("own keys:", Object.keys(server).join(","))
console.log("has environments:", !!server.environments, Object.keys(server.environments ?? {}))
const clientEnv = server.environments?.client
console.log("clientEnv keys:", clientEnv ? Object.keys(clientEnv).join(",") : "-")
console.log("moduleGraph methods:", clientEnv?.moduleGraph ? Object.getOwnPropertyNames(Object.getPrototypeOf(clientEnv.moduleGraph)).join(",") : "-")

const r = await server.transformRequest("/index.tsx")
console.log("transform result keys:", Object.keys(r ?? {}).join(","))
console.log("result.id:", r?.id)

const mod = clientEnv?.moduleGraph?.getModule?.(r!.id!)
console.log("mod found:", !!mod, "importedUrls:", mod?.importedUrls?.size)
if (mod?.importedUrls) console.log([...mod.importedUrls].slice(0, 8))

await server.close()
process.exit(0)
