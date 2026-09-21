import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const electronVite = (() => {
  const manifest = createRequire(import.meta.url).resolve("electron-vite/package.json")
  return join(dirname(manifest), "bin", "electron-vite.js")
})()

const child = Bun.spawn([process.execPath, electronVite, "dev"], {
  cwd: join(import.meta.dir, ".."),
  env,
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

const stop = () => child.kill()
process.once("SIGINT", stop)
process.once("SIGTERM", stop)

process.exitCode = await child.exited
process.off("SIGINT", stop)
process.off("SIGTERM", stop)
