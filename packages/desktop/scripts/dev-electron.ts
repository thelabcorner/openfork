import { join } from "node:path"

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const child = Bun.spawn(["electron-vite", "dev"], {
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
