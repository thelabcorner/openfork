export * as ExchangeOwnedCommand from "./owned-command"

import { Effect } from "effect"
import * as Utf8 from "@/util/utf8"

export const DEFAULT_OUTPUT_CAP_BYTES = 3_000_000
export const MAX_OUTPUT_CAP_BYTES = 4 * 1024 * 1024

export interface State {
  readonly running: boolean
  readonly exitCode?: number
  readonly truncated?: boolean
}

export interface StartInput {
  readonly argv: readonly [string, ...string[]]
  readonly workdir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly title?: string
  readonly operation?: string
  readonly onStdout: (chunk: string) => void
  readonly onStderr: (chunk: string) => void
}

export interface Backend<E> {
  readonly start: (input: StartInput) => Effect.Effect<{ readonly handle: string }, E>
  readonly wait: (handle: string, timeoutMs: number, signal?: AbortSignal) => Effect.Effect<State, E>
  readonly kill: (handle: string) => Effect.Effect<State, E>
  readonly remove: (handle: string) => Effect.Effect<void, E>
}

export interface Input {
  readonly argv: readonly [string, ...string[]]
  readonly workdir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly title?: string
  readonly operation?: string
  readonly timeoutMs: number
  readonly outputCapBytes?: number
  readonly signal?: AbortSignal
}

export interface Result {
  readonly stdout: string
  readonly stderr: string
  readonly truncated: boolean
  readonly timedOut: boolean
  readonly exitCode: number | null
}

function collector(limit: number) {
  let text = ""
  let bytes = 0
  let truncated = false
  return {
    append(chunk: string) {
      bytes += Utf8.byteLength(chunk)
      const retained = Utf8.byteLength(text)
      if (retained >= limit) {
        truncated = true
        return
      }
      const next = Utf8.truncate(chunk, limit - retained)
      text += next.text
      truncated ||= next.truncated
    },
    value: () => text,
    truncated: () => truncated || bytes > limit,
  }
}

/**
 * Shared lifecycle for internal exact-argv work owned by an external principal.
 * Authority, root resolution, handle ownership and process-tree retirement stay
 * with the protocol adapter; this layer owns bounded capture + wait/kill/remove.
 */
export function run<E>(backend: Backend<E>, input: Input): Effect.Effect<Result, E> {
  const cap = Math.min(Math.max(input.outputCapBytes ?? DEFAULT_OUTPUT_CAP_BYTES, 1), MAX_OUTPUT_CAP_BYTES)
  const stdout = collector(cap)
  const stderr = collector(cap)

  return Effect.gen(function* () {
    const started = yield* backend.start({
      argv: input.argv,
      workdir: input.workdir,
      env: input.env,
      title: input.title,
      operation: input.operation,
      onStdout: stdout.append,
      onStderr: stderr.append,
    })

    let state: State
    let timedOut = false
    const waited = yield* backend.wait(started.handle, input.timeoutMs, input.signal).pipe(
      Effect.catch((error) =>
        backend
          .kill(started.handle)
          .pipe(
            Effect.catch(() => Effect.succeed({ running: false } satisfies State)),
            Effect.andThen(backend.remove(started.handle).pipe(Effect.catch(() => Effect.void))),
            Effect.andThen(Effect.fail(error)),
          ),
      ),
    )
    state = waited
    if (state.running) {
      timedOut = true
      state = yield* backend.kill(started.handle)
    }
    yield* backend.remove(started.handle)

    return {
      stdout: stdout.value(),
      stderr: stderr.value(),
      truncated: stdout.truncated() || stderr.truncated() || state.truncated === true,
      timedOut,
      exitCode: timedOut ? null : (state.exitCode ?? null),
    } satisfies Result
  })
}

