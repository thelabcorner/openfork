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

const sidecarWatcher = Bun.spawn(
  [process.execPath, "./scripts/watch-node-sidecar.ts"],
  {
    cwd: join(import.meta.dir, ".."),
    env,
    stdin: "ignore",
    stdout: "inherit",
    stderr: "inherit",
  },
)

const stop = () => {
  child.kill()
  sidecarWatcher.kill()
}
process.once("SIGINT", stop)
process.once("SIGTERM", stop)

const first = await Promise.race([
  child.exited.then((code) => ({ owner: "electron" as const, code })),
  sidecarWatcher.exited.then((code) => ({ owner: "sidecar-watcher" as const, code })),
])
if (first.owner === "electron") sidecarWatcher.kill()
else child.kill()
await Promise.allSettled([child.exited, sidecarWatcher.exited])
process.exitCode = first.code
process.off("SIGINT", stop)
process.off("SIGTERM", stop)
