import fs from "node:fs/promises"
import { acquireMachineSlot } from "../../src/util/machine-slot-budget"

type Input = {
  prefix: string
  slots: number
  dir: string
  holdMs: number
  active: string
  overlap: string
  done: string
}

const input = JSON.parse(process.argv[2] ?? "null") as Input | null
if (!input) throw new Error("missing machine-slot worker input")

const abort = new AbortController()
const lease = await acquireMachineSlot({
  prefix: input.prefix,
  slots: input.slots,
  dir: input.dir,
  signal: abort.signal,
  staleMs: 5_000,
  retryMs: 10,
})

try {
  try {
    await fs.writeFile(input.active, String(process.pid), { flag: "wx" })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== "EEXIST") throw error
    await fs.appendFile(input.overlap, `${process.pid}\n`)
  }
  await Bun.sleep(input.holdMs)
  await fs.appendFile(input.done, `${process.pid}\n`)
} finally {
  await fs.rm(input.active, { force: true })
  await lease.release()
}
