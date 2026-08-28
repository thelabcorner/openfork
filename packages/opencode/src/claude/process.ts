// Narrow typed process port for Claude CLI subprocesses.
//
// Everything availability/auth needs from the OS process layer is expressed
// here so tests can drive fake fixtures without spawning anything. The
// default implementation wraps node:child_process (Bun-compatible).

import { spawn, spawnSync } from "node:child_process"
import type { ChildEnv } from "./env"

export interface ExecOptions {
  readonly cwd?: string
  readonly env?: ChildEnv
  readonly timeoutMs?: number
}

export interface ExecResult {
  readonly code: number | null
  readonly signal: string | null
  readonly stdout: string
  readonly stderr: string
  /** Set when the process could not be spawned at all. */
  readonly error?: string
}

export interface StreamChunk {
  readonly stream: "stdout" | "stderr"
  readonly text: string
}

export interface SpawnExit {
  readonly code: number | null
  readonly signal: string | null
  readonly error?: string
}

/** Bounded tail of combined output kept for pattern matching, never display. */
const MAX_BUFFERED_OUTPUT = 64 * 1024

export interface SpawnHandle {
  readonly pid: number | undefined
  write(text: string): boolean
  end(): void
  kill(): void
  readonly output: AsyncIterable<StreamChunk>
  readonly exit: Promise<SpawnExit>
}

export interface ClaudeProcessPort {
  exec(file: string, args: readonly string[], options?: ExecOptions): Promise<ExecResult>
  spawn(file: string, args: readonly string[], options?: ExecOptions): Promise<SpawnHandle>
}

function stripAnsi(text: string): string {
  return text.replace(/\u001B\[[0-9;?]*[A-Za-z]/g, "")
}

function tail(text: string, max = MAX_BUFFERED_OUTPUT): string {
  return text.length > max ? text.slice(text.length - max) : text
}

class NodeSpawnHandle implements SpawnHandle {
  constructor(private readonly child: ReturnType<typeof spawn>) {}

  get pid(): number | undefined {
    return this.child.pid
  }

  write(text: string): boolean {
    return this.child.stdin?.write(text) ?? false
  }

  end(): void {
    this.child.stdin?.end()
  }

  kill(): void {
    this.child.kill()
  }

  get output(): AsyncIterable<StreamChunk> {
    const push = (chunk: StreamChunk) => pushChunk(chunk)
    const fail = (error: unknown) => failQueue(error)
    return {
      [Symbol.asyncIterator]() {
        return {
          next: () => pull(),
          return: () => {
            cleanup()
            return Promise.resolve({ done: true as const, value: undefined })
          },
        }
      },
    }

    let queue: StreamChunk[] = []
    let resolvers: Array<(result: IteratorResult<StreamChunk>) => void> = []
    let rejecters: Array<(error: unknown) => void> = []
    let closed = false

    const pushChunk = (chunk: StreamChunk) => {
      if (closed) return
      const resolver = resolvers.shift()
      if (resolver) resolver({ done: false, value: chunk })
      else queue.push(chunk)
    }
    const failQueue = (error: unknown) => {
      if (closed) return
      closed = true
      for (const rejecter of rejecters) rejecter(error)
      rejecters = []
    }

    const child = this.child
    const onData = (stream: "stdout" | "stderr") => (chunk: Buffer | string) =>
      push({ stream, text: String(chunk) })
    const stdoutHandler = onData("stdout")
    const stderrHandler = onData("stderr")
    const closeHandler = () => {
      closed = true
      for (const resolver of resolvers) resolver({ done: true, value: undefined })
      resolvers = []
    }

    const cleanup = () => {
      child.stdout?.off("data", stdoutHandler)
      child.stderr?.off("data", stderrHandler)
      child.off("close", closeHandler)
      child.off("error", fail)
    }

    child.stdout?.setEncoding?.("utf8")
    child.stderr?.setEncoding?.("utf8")
    child.stdout?.on("data", stdoutHandler)
    child.stderr?.on("data", stderrHandler)
    // A broken pipe while writing must not take the host down.
    child.stdin?.on("error", () => {})
    child.on("error", fail)
    child.on("close", closeHandler)

    const pull = (): Promise<IteratorResult<StreamChunk>> => {
      const queued = queue.shift()
      if (queued) return Promise.resolve({ done: false, value: queued })
      if (closed) return Promise.resolve({ done: true, value: undefined })
      return new Promise((resolve, reject) => {
        resolvers.push(resolve)
        rejecters.push(reject)
      })
    }
  }

  get exit(): Promise<SpawnExit> {
    const child = this.child
    return new Promise((resolve) => {
      child.once("error", (error: Error) => resolve({ code: null, signal: null, error: error.message }))
      child.once("exit", (code, signal) => resolve({ code, signal: signal ?? null }))
    })
  }
}

/** Default port over node:child_process. Output is ANSI-stripped and bounded. */
export const nodeProcessPort: ClaudeProcessPort = {
  async exec(file, args, options) {
    try {
      const result = spawnSync(file, [...args], {
        encoding: "utf8",
        timeout: options?.timeoutMs,
        env: options?.env as NodeJS.ProcessEnv | undefined,
        cwd: options?.cwd,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      })
      if (result.error) {
        return { code: result.status, signal: result.signal ?? null, stdout: "", stderr: "", error: result.error.message }
      }
      return {
        code: result.status,
        signal: result.signal ?? null,
        stdout: tail(stripAnsi(String(result.stdout ?? ""))),
        stderr: tail(stripAnsi(String(result.stderr ?? ""))),
      }
    } catch (error) {
      return { code: null, signal: null, stdout: "", stderr: "", error: error instanceof Error ? error.message : String(error) }
    }
  },

  async spawn(file, args, options) {
    const child = spawn(file, [...args], {
      cwd: options?.cwd,
      env: options?.env as NodeJS.ProcessEnv | undefined,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    })
    return new NodeSpawnHandle(child)
  },
}

export * as ClaudeProcess from "./process"
