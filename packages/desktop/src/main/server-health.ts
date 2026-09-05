import { setTimeout as delay } from "node:timers/promises"

export async function waitForServerHealth(check: (signal: AbortSignal) => Promise<boolean>, exited: Promise<number>) {
  const controller = new AbortController()
  const gone = exited.then((code) => {
    throw new Error(`Sidecar exited before health check passed with code ${code}`)
  })
  const ready = async () => {
    while (!controller.signal.aborted) {
      await delay(100, undefined, { signal: controller.signal })
      if (await check(controller.signal)) return
    }
  }
  try {
    await Promise.race([ready(), gone])
  } finally {
    // Promise.race does not cancel its loser. Abort both the pending request
    // and retry timer so a dead sidecar cannot leave a permanent polling loop.
    controller.abort()
  }
}
