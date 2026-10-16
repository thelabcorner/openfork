/// <reference types="bun" />
// Real NDJSON ACP host process wrapper. Spawns the exact packaged executable
// with `acp` argv and speaks newline-delimited JSON-RPC on stdin/stdout.
//
// Protocol discipline enforced here:
// - every stdout line must parse as JSON (violations are recorded, never thrown
//   from the reader loop);
// - server->client requests are answered with method-not-found so the host
//   cannot wedge waiting on an unsupported client capability;
// - stderr is drained into a bounded ring (stdout is protocol-only by design).

export type LatencySample = {
  method: string
  ms: number
  ok: boolean
  at: number
  phase?: string
}

type Pending = {
  method: string
  startedAt: number
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
  phase?: string
}

export type SpawnHostOptions = {
  binary: string
  cwd: string
  env: Record<string, string>
  label: string
  requestTimeoutMs: number
  extraArgs?: readonly string[]
}

export class AcpHost {
  readonly label: string
  readonly pid: number
  private readonly child: Bun.Subprocess<"pipe", "pipe", "pipe">
  private readonly defaultTimeoutMs: number
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  readonly latencies: LatencySample[] = []
  readonly notifications: { method: string; params: unknown; at: number }[] = []
  readonly stdoutViolations: string[] = []
  readonly serverRequests: string[] = []
  readonly lagSamples: number[] = []
  private lagTimer: ReturnType<typeof setInterval> | undefined
  private lagLast = 0
  private stderrBytes = ""
  private exitCodeValue: number | null = null
  private readonly exitPromise: Promise<number>
  private stdinClosed = false
  private disposed = false

  get exitCode(): number | null {
    return this.exitCodeValue
  }

  private constructor(options: SpawnHostOptions) {
    this.label = options.label
    this.defaultTimeoutMs = options.requestTimeoutMs
    this.child = Bun.spawn([options.binary, "acp", ...(options.extraArgs ?? [])], {
      cwd: options.cwd,
      env: options.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.pid = this.child.pid
    this.exitPromise = this.child.exited.then((code) => {
      this.exitCodeValue = code
      return code
    })
    void this.readStdout(this.child.stdout)
    void this.readStderr(this.child.stderr)
    this.startLagSampler()
  }

  static spawn(options: SpawnHostOptions): AcpHost {
    return new AcpHost(options)
  }

  private startLagSampler() {
    const intervalMs = 50
    this.lagLast = performance.now()
    this.lagTimer = setInterval(() => {
      const now = performance.now()
      this.lagSamples.push(Math.max(0, now - this.lagLast - intervalMs))
      this.lagLast = now
    }, intervalMs)
  }

  private async readStdout(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        buffer += decoder.decode(chunk.value, { stream: true })
        for (;;) {
          const index = buffer.indexOf("\n")
          if (index < 0) break
          const line = buffer.slice(0, index).trim()
          buffer = buffer.slice(index + 1)
          if (!line) continue
          this.handleLine(line)
        }
      }
      const tail = buffer.trim()
      if (tail) this.handleLine(tail)
    } catch (error) {
      this.stdoutViolations.push(`stdout stream error: ${String(error)}`)
    } finally {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer)
        pending.reject(new Error(`ACP ${this.label} stdout closed before ${pending.method} completed`))
      }
      this.pending.clear()
    }
  }

  private handleLine(line: string) {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.stdoutViolations.push(line.slice(0, 500))
      return
    }
    if (!message || typeof message !== "object") {
      this.stdoutViolations.push(line.slice(0, 500))
      return
    }
    const record = message as Record<string, unknown>
    if (typeof record.id === "number" && typeof record.method === "string") {
      this.serverRequests.push(record.method)
      void this.write({
        jsonrpc: "2.0",
        id: record.id,
        error: { code: -32601, message: `cert client does not support ${record.method}` },
      })
      return
    }
    if (typeof record.id === "number") {
      const pending = this.pending.get(record.id)
      if (!pending) return
      this.pending.delete(record.id)
      clearTimeout(pending.timer)
      const ms = performance.now() - pending.startedAt
      if (record.error !== undefined) {
        this.latencies.push({ method: pending.method, ms, ok: false, at: Date.now(), phase: pending.phase })
        pending.reject(new Error(`ACP ${this.label} ${pending.method} error: ${JSON.stringify(record.error).slice(0, 2000)}`))
        return
      }
      this.latencies.push({ method: pending.method, ms, ok: true, at: Date.now(), phase: pending.phase })
      pending.resolve(record.result)
      return
    }
    if (typeof record.method === "string") {
      this.notifications.push({ method: record.method, params: record.params, at: Date.now() })
    }
  }

  private async readStderr(stream: ReadableStream<Uint8Array>) {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        this.stderrBytes = (this.stderrBytes + decoder.decode(chunk.value, { stream: true })).slice(-16_384)
      }
    } catch {
      // stderr close is normal during process teardown
    }
  }

  private write(message: unknown): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.stdinClosed) {
        reject(new Error(`ACP ${this.label} stdin already closed`))
        return
      }
      try {
        const written = this.child.stdin.write(JSON.stringify(message) + "\n")
        if (typeof written === "number") resolve()
        else void written.then(() => resolve(), reject)
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  async request<T>(
    method: string,
    params: unknown,
    options?: { timeoutMs?: number; phase?: string },
  ): Promise<T> {
    const id = this.nextId++
    const timeoutMs = options?.timeoutMs ?? this.defaultTimeoutMs
    const startedAt = performance.now()
    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.latencies.push({ method, ms: performance.now() - startedAt, ok: false, at: Date.now(), phase: options?.phase })
        reject(new Error(`ACP ${this.label} ${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(id, {
        method,
        startedAt,
        phase: options?.phase,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      })
    })
    await this.write({ jsonrpc: "2.0", id, method, params })
    return promise
  }

  notify(method: string, params: unknown): Promise<void> {
    return this.write({ jsonrpc: "2.0", method, params })
  }

  closeStdin(): void {
    if (this.stdinClosed) return
    this.stdinClosed = true
    try {
      this.child.stdin.end()
    } catch {
      // already closed
    }
  }

  async waitExit(timeoutMs: number): Promise<number> {
    if (this.exitCodeValue !== null) return this.exitCodeValue
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        this.exitPromise,
        new Promise<number>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`ACP ${this.label} did not exit within ${timeoutMs}ms`)), timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  kill(): void {
    try {
      this.child.kill()
    } catch {
      // already dead
    }
  }

  stderrTail(): string {
    return this.stderrBytes.slice(-8000)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (this.lagTimer) clearInterval(this.lagTimer)
    this.closeStdin()
    if (this.exitCodeValue === null) this.kill()
  }
}
