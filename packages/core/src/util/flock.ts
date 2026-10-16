import path from "path"
import os from "os"
import { randomBytes, randomUUID } from "crypto"
import { mkdir, readFile, rm, stat, utimes, writeFile } from "fs/promises"
import { execFile as execFileCallback } from "node:child_process"
import { promisify } from "node:util"
import { Hash } from "./hash"
import { Effect } from "effect"

export type FlockGlobal = {
  state: string
}

export namespace Flock {
  let global: FlockGlobal | undefined

  export function setGlobal(g: FlockGlobal) {
    global = g
  }

  const root = () => {
    if (!global) throw new Error("Flock global not set")
    return path.join(global.state, "locks")
  }

  // Defaults for callers that do not provide timing options.
  const defaultOpts = {
    staleMs: 60_000,
    timeoutMs: 5 * 60_000,
    baseDelayMs: 100,
    maxDelayMs: 2_000,
  }

  export interface WaitEvent {
    key: string
    attempt: number
    delay: number
    waited: number
  }

  export type Wait = (input: WaitEvent) => void | Promise<void>

  export interface Options {
    dir?: string
    signal?: AbortSignal
    staleMs?: number
    timeoutMs?: number
    baseDelayMs?: number
    maxDelayMs?: number
    onWait?: Wait
    /** For process slots only: an expired heartbeat must not evict a live
     * same-host process. Other locks retain their existing recovery policy. */
    protectLiveProcess?: boolean
  }

  type Opts = {
    staleMs: number
    timeoutMs: number
    baseDelayMs: number
    maxDelayMs: number
    protectLiveProcess: boolean
  }

  type Owned = {
    acquired: true
    startHeartbeat: (intervalMs?: number) => void
    release: () => Promise<void>
  }

  export interface Lease {
    release: () => Promise<void>
    [Symbol.asyncDispose]: () => Promise<void>
  }

  function leaseOf(lock: Owned): Lease {
    const release = () => lock.release()
    return {
      release,
      [Symbol.asyncDispose]() {
        return release()
      },
    }
  }

  function code(err: unknown) {
    if (typeof err !== "object" || err === null || !("code" in err)) return
    const value = err.code
    if (typeof value !== "string") return
    return value
  }

  function sleep(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new Error("Aborted"))
        return
      }

      let timer: NodeJS.Timeout | undefined

      const done = () => {
        signal?.removeEventListener("abort", abort)
        resolve()
      }

      const abort = () => {
        if (timer) {
          clearTimeout(timer)
        }
        signal?.removeEventListener("abort", abort)
        reject(signal?.reason ?? new Error("Aborted"))
      }

      signal?.addEventListener("abort", abort, { once: true })
      timer = setTimeout(done, ms)
    })
  }

  function jitter(ms: number) {
    const j = Math.floor(ms * 0.3)
    const d = Math.floor(Math.random() * (2 * j + 1)) - j
    return Math.max(0, ms + d)
  }

  function mono() {
    return performance.now()
  }

  function wall() {
    return performance.timeOrigin + mono()
  }

  async function stats(file: string) {
    try {
      return await stat(file)
    } catch (err) {
      const errCode = code(err)
      if (errCode === "ENOENT" || errCode === "ENOTDIR") return
      throw err
    }
  }

  function locallyAlive(pid: number): boolean {
    // Signal 0 probes liveness; it does not terminate or interrupt the owner.
    // Permission denial and unknown OS errors are not proof of death.
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return code(error) !== "ESRCH"
    }
  }

  const execFile = promisify(execFileCallback)
  const processBirthCache = new Map<number, { observedAt: number; startedAt?: number }>()
  async function processBornAt(pid: number): Promise<number | undefined> {
    const now = mono()
    const cached = processBirthCache.get(pid)
    if (cached && now - cached.observedAt < 5_000) return cached.startedAt
    let startedAt: number | undefined
    try {
      // Only an already-stale lease with a LIVE PID pays this probe cost.
      // A liveness signal alone cannot distinguish PID reuse after a crash.
      const command = process.platform === "win32"
        ? {
            executable: "powershell.exe",
            args: [
              "-NoProfile", "-NonInteractive", "-Command",
              `[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime()).ToUnixTimeMilliseconds()`,
            ],
          }
        : { executable: "ps", args: ["-p", String(pid), "-o", "lstart="] }
      const { stdout } = await execFile(command.executable, command.args, {
        timeout: 3_000,
        windowsHide: true,
        maxBuffer: 4_096,
      })
      const timestamp = process.platform === "win32"
        ? Number(stdout.trim())
        : Date.parse(stdout.trim())
      if (Number.isFinite(timestamp) && timestamp > 0) startedAt = timestamp
    } catch {
      // Unprovable PID reuse must not authorize stale-lock eviction.
    }
    processBirthCache.set(pid, { observedAt: now, startedAt })
    if (processBirthCache.size > 64) processBirthCache.clear()
    return startedAt
  }

  /** A newer process with the same recycled PID cannot own a lease which
   * predates its birth. Ambiguous times conservatively protect the lock. */
  export function provablyReusedPID(lockCreatedAt: unknown, processStartedAt: unknown): boolean {
    if (typeof lockCreatedAt !== "string" || typeof processStartedAt !== "number") return false
    const acquiredAt = Date.parse(lockCreatedAt)
    return Number.isFinite(acquiredAt) && Number.isFinite(processStartedAt) &&
      processStartedAt > acquiredAt + 3_000
  }

  async function stale(lockDir: string, heartbeatPath: string, metaPath: string, opts: Opts) {
    // Stale detection allows automatic recovery after crashed owners.
    const now = wall()
    const heartbeat = await stats(heartbeatPath)
    if (heartbeat) {
      if (now - heartbeat.mtimeMs <= opts.staleMs) return false
    } else {
      const meta = await stats(metaPath)
      if (meta) {
        if (now - meta.mtimeMs <= opts.staleMs) return false
      } else {
        const dir = await stats(lockDir)
        if (!dir || now - dir.mtimeMs <= opts.staleMs) return false
      }
    }

    if (opts.protectLiveProcess) {
      const owner = await readFile(metaPath, "utf8").then((raw) => JSON.parse(raw) as {
        pid?: unknown
        hostname?: unknown
        createdAt?: unknown
      }).catch(() => undefined)
      // Even when heartbeat renewal is delayed by synchronous workload, its
      // owner can still be executing. Fail closed if that PID remains live.
      if (
        owner?.hostname === os.hostname() &&
        typeof owner.pid === "number" &&
        Number.isSafeInteger(owner.pid) &&
        owner.pid > 0 &&
        locallyAlive(owner.pid)
      ) {
        const startedAt = await processBornAt(owner.pid)
        if (!provablyReusedPID(owner.createdAt, startedAt)) return false
      }
    }
    return true
  }

  async function tryAcquireLockDir(lockDir: string, opts: Opts): Promise<Owned | { acquired: false }> {
    const token = randomUUID?.() ?? randomBytes(16).toString("hex")
    const metaPath = path.join(lockDir, "meta.json")
    const heartbeatPath = path.join(lockDir, "heartbeat")

    try {
      await mkdir(lockDir, { mode: 0o700 })
    } catch (err) {
      if (code(err) !== "EEXIST") {
        throw err
      }

      if (!(await stale(lockDir, heartbeatPath, metaPath, opts))) {
        return { acquired: false }
      }

      const breakerPath = lockDir + ".breaker"
      try {
        await mkdir(breakerPath, { mode: 0o700 })
      } catch (claimErr) {
        const errCode = code(claimErr)
        if (errCode === "EEXIST") {
          const breaker = await stats(breakerPath)
          if (breaker && wall() - breaker.mtimeMs > opts.staleMs) {
            await rm(breakerPath, { recursive: true, force: true }).catch(() => undefined)
          }
          return { acquired: false }
        }

        if (errCode === "ENOENT" || errCode === "ENOTDIR") {
          return { acquired: false }
        }

        throw claimErr
      }

      try {
        // Breaker ownership ensures only one contender performs stale cleanup.
        if (!(await stale(lockDir, heartbeatPath, metaPath, opts))) {
          return { acquired: false }
        }

        await rm(lockDir, { recursive: true, force: true })

        try {
          await mkdir(lockDir, { mode: 0o700 })
        } catch (retryErr) {
          const errCode = code(retryErr)
          if (errCode === "EEXIST" || errCode === "ENOTEMPTY") {
            return { acquired: false }
          }
          throw retryErr
        }
      } finally {
        await rm(breakerPath, { recursive: true, force: true }).catch(() => undefined)
      }
    }

    const meta = {
      token,
      pid: process.pid,
      hostname: os.hostname(),
      createdAt: new Date().toISOString(),
    }

    await writeFile(heartbeatPath, "", { flag: "wx" }).catch(async () => {
      await rm(lockDir, { recursive: true, force: true })
      throw new Error("Lock acquired but heartbeat already existed (possible compromise).")
    })

    await writeFile(metaPath, JSON.stringify(meta, null, 2), { flag: "wx" }).catch(async () => {
      await rm(lockDir, { recursive: true, force: true })
      throw new Error("Lock acquired but meta.json already existed (possible compromise).")
    })

    let timer: NodeJS.Timeout | undefined

    const startHeartbeat = (intervalMs = Math.max(100, Math.floor(opts.staleMs / 3))) => {
      if (timer) return
      // Heartbeat prevents long critical sections from being evicted as stale.
      timer = setInterval(() => {
        const t = new Date()
        void utimes(heartbeatPath, t, t).catch(() => undefined)
      }, intervalMs)
      timer.unref?.()
    }

    const release = async () => {
      if (timer) {
        clearInterval(timer)
        timer = undefined
      }

      const current = await readFile(metaPath, "utf8")
        .then((raw) => {
          const parsed = JSON.parse(raw)
          if (!parsed || typeof parsed !== "object") return {}
          return {
            token: "token" in parsed && typeof parsed.token === "string" ? parsed.token : undefined,
          }
        })
        .catch((err) => {
          const errCode = code(err)
          if (errCode === "ENOENT" || errCode === "ENOTDIR") {
            throw new Error("Refusing to release: lock is compromised (metadata missing).")
          }
          if (err instanceof SyntaxError) {
            throw new Error("Refusing to release: lock is compromised (metadata invalid).")
          }
          throw err
        })
      // Token check prevents deleting a lock that was re-acquired by another process.
      if (current.token !== token) {
        throw new Error("Refusing to release: lock token mismatch (not the owner).")
      }

      await rm(lockDir, { recursive: true, force: true })
    }

    return {
      acquired: true,
      startHeartbeat,
      release,
    }
  }

  async function acquireLockDir(
    lockDir: string,
    input: { key: string; onWait?: Wait; signal?: AbortSignal },
    opts: Opts,
  ) {
    const stop = mono() + opts.timeoutMs
    let attempt = 0
    let waited = 0
    let delay = opts.baseDelayMs

    while (true) {
      input.signal?.throwIfAborted()

      const res = await tryAcquireLockDir(lockDir, opts)
      if (res.acquired) {
        return res
      }

      if (mono() > stop) {
        throw new Error(`Timed out waiting for lock: ${input.key}`)
      }

      attempt += 1
      const ms = jitter(delay)
      await input.onWait?.({
        key: input.key,
        attempt,
        delay: ms,
        waited,
      })
      await sleep(ms, input.signal)
      waited += ms
      delay = Math.min(opts.maxDelayMs, Math.floor(delay * 1.7))
    }
  }

  export async function acquire(key: string, input: Options = {}): Promise<Lease> {
    input.signal?.throwIfAborted()
    const cfg: Opts = {
      staleMs: input.staleMs ?? defaultOpts.staleMs,
      timeoutMs: input.timeoutMs ?? defaultOpts.timeoutMs,
      baseDelayMs: input.baseDelayMs ?? defaultOpts.baseDelayMs,
      maxDelayMs: input.maxDelayMs ?? defaultOpts.maxDelayMs,
      protectLiveProcess: input.protectLiveProcess ?? false,
    }
    const dir = input.dir ?? root()

    await mkdir(dir, { recursive: true })
    const lockfile = path.join(dir, Hash.fast(key) + ".lock")
    const lock = await acquireLockDir(
      lockfile,
      {
        key,
        onWait: input.onWait,
        signal: input.signal,
      },
      cfg,
    )
    lock.startHeartbeat()
    return leaseOf(lock)
  }

  /**
   * One-shot, non-blocking acquisition. This is the admission primitive for
   * work that must fail closed when another process already owns the resource;
   * unlike acquire(), it never queues behind the current owner.
   */
  export async function tryAcquire(key: string, input: Options = {}): Promise<Lease | undefined> {
    input.signal?.throwIfAborted()
    const cfg: Opts = {
      staleMs: input.staleMs ?? defaultOpts.staleMs,
      timeoutMs: input.timeoutMs ?? defaultOpts.timeoutMs,
      baseDelayMs: input.baseDelayMs ?? defaultOpts.baseDelayMs,
      maxDelayMs: input.maxDelayMs ?? defaultOpts.maxDelayMs,
      protectLiveProcess: input.protectLiveProcess ?? false,
    }
    const dir = input.dir ?? root()
    await mkdir(dir, { recursive: true })
    const lockfile = path.join(dir, Hash.fast(key) + ".lock")
    const lock = await tryAcquireLockDir(lockfile, cfg)
    if (!lock.acquired) return
    lock.startHeartbeat()
    return leaseOf(lock)
  }

  export async function withLock<T>(key: string, fn: () => Promise<T>, input: Options = {}) {
    await using _ = await acquire(key, input)
    input.signal?.throwIfAborted()
    return await fn()
  }

  export const effect = Effect.fn("Flock.effect")(function* (key: string, input: Options = {}) {
    return yield* Effect.acquireRelease(
      Effect.promise((signal) => Flock.acquire(key, { ...input, signal })).pipe(
        Effect.withSpan("Flock.acquire", {
          attributes: { key },
        }),
      ),
      (lock) => Effect.promise(() => lock.release()).pipe(Effect.withSpan("Flock.release")),
    ).pipe(Effect.asVoid)
  })
}
