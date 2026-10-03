import { createServer } from "node:net"
import { resolve, sep } from "node:path"

/** Vite fixtures must own both their ephemeral listener and dependency cache. */
export async function privateViteIsolation(cacheDirectory: string) {
  const cacheDir = resolve(cacheDirectory)
  if (cacheDir.split(sep).some((part) => part.toLowerCase() === "node_modules")) {
    throw new Error(`Vite fixture cache must not use shared node_modules: ${cacheDir}`)
  }
  // Vite treats port: 0 as its default port on some host stacks. Reserve an
  // actual nonzero port first; strictPort then makes a race fail safely rather
  // than silently falling back to 5173 or another listener.
  const reservation = createServer()
  await new Promise<void>((resolveListen, reject) => {
    reservation.once("error", reject)
    reservation.listen(0, "127.0.0.1", resolveListen)
  })
  const address = reservation.address()
  if (!address || typeof address === "string") {
    await new Promise<void>((resolveClose) => reservation.close(() => resolveClose()))
    throw new Error("could not reserve a private Vite port")
  }
  const port = address.port
  await new Promise<void>((resolveClose, reject) => reservation.close((error) => error ? reject(error) : resolveClose()))
  if (port === 5173) {
    throw new Error("private Vite fixture must not bind the live development port 5173")
  }
  return {
    cacheDir,
    server: { host: "127.0.0.1" as const, port, strictPort: true },
  }
}
