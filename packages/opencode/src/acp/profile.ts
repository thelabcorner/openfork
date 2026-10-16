const memoryEnabled = process.env.OPENFORK_ACP_MEMORY_PROFILE === "1"
const enabled = process.env.OPENCODE_ACP_PROFILE === "1" || memoryEnabled
const started = performance.now()

export function mark(name: string, fields?: Record<string, string | number | boolean | undefined>) {
  if (!enabled) return
  write(`${name}.mark`, performance.now() - started, fields)
}

export function duration(
  name: string,
  startedAt: number,
  fields?: Record<string, string | number | boolean | undefined>,
) {
  if (!enabled) return
  write(name, performance.now() - startedAt, fields)
}

export async function measure<T>(
  name: string,
  fn: () => Promise<T>,
  fields?: Record<string, string | number | boolean | undefined>,
) {
  if (!enabled) return fn()
  const start = performance.now()
  try {
    return await fn()
  } finally {
    write(name, performance.now() - start, fields)
  }
}

function write(name: string, durationMs: number, fields?: Record<string, string | number | boolean | undefined>) {
  const extra = fields
    ? Object.entries(fields)
        .filter((entry): entry is [string, string | number | boolean] => entry[1] !== undefined)
        .map(([key, value]) => `${key}=${value}`)
        .join(" ")
    : ""
  // Opt-in only: production logs and the hot event path must not pay for
  // process.memoryUsage(). Captures heap/external alongside RSS so a large
  // Windows working set isn't misdiagnosed as retained JS objects.
  const memory = memoryEnabled ? process.memoryUsage() : undefined
  const metrics = memory
    ? ` rssMiB=${Math.round(memory.rss / 1048576)} heapMiB=${Math.round(memory.heapUsed / 1048576)} heapTotalMiB=${Math.round(memory.heapTotal / 1048576)} externalMiB=${Math.round(memory.external / 1048576)} arrayBuffersMiB=${Math.round(memory.arrayBuffers / 1048576)}`
    : ""
  console.error(`[acp-profile] ${name} ${Math.round(durationMs)}ms${extra ? ` ${extra}` : ""}${metrics}`)
}

// Optional fixed-rate sampling covers phases (SDK hydration, GC and teardown)
// that have no explicit ACP mark. Unref ensures diagnostics cannot keep the
// protocol host alive after stdin EOF; the normal runtime allocates no timer.
if (memoryEnabled) {
  const sampler = setInterval(() => write("memory.sample", 0), 1000)
  sampler.unref()
}

export * as ACPProfile from "./profile"
