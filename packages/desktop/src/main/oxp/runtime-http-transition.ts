import type { RuntimeBackendModule, RuntimeBackendTransition } from "./runtime-refresh"

export type RuntimeHttpListenOptions = {
  readonly port: number
  readonly hostname: string
  readonly username: string
  readonly password: string
  readonly cors: readonly string[]
}

export type RuntimeHttpListener = {
  readonly url: URL
  stop(close?: boolean): void | Promise<void>
}

type RuntimeHttpBackendModule = RuntimeBackendModule & {
  readonly Server: {
    listen(options: RuntimeHttpListenOptions): Promise<RuntimeHttpListener>
  }
}

function httpBackend(module: RuntimeBackendModule): RuntimeHttpBackendModule {
  const value = module as Partial<RuntimeHttpBackendModule>
  if (!value.Server || typeof value.Server.listen !== "function") {
    throw new Error("Runtime backend does not export Server.listen")
  }
  return value as RuntimeHttpBackendModule
}

/**
 * Owns the ordinary desktop HTTP listener across a transactional backend
 * refresh. The utility process and public URL stay stable; only the module
 * serving the listener changes.
 *
 * A rejected transition guarantees the previous backend was restored unless
 * restoration itself also failed, in which case current() becomes undefined so
 * the coordinator cannot falsely report either runtime as serving.
 */
export class RuntimeHttpBackendOwner implements RuntimeBackendTransition {
  private module: RuntimeBackendModule | undefined
  private listener: RuntimeHttpListener | undefined

  constructor(
    initialModule: RuntimeBackendModule,
    initialListener: RuntimeHttpListener,
    private readonly listenOptions: RuntimeHttpListenOptions,
    private readonly probe: (listener: RuntimeHttpListener) => Promise<void>,
  ) {
    this.module = initialModule
    this.listener = initialListener
  }

  current() {
    return this.module
  }

  async transition(from: RuntimeBackendModule, to: RuntimeBackendModule) {
    if (from === to) return
    if (this.module !== from || !this.listener) {
      throw new Error("Runtime HTTP backend owner does not match the requested source module")
    }

    const previous = this.listener
    await previous.stop(true)

    let candidate: RuntimeHttpListener | undefined
    try {
      candidate = await httpBackend(to).Server.listen(this.listenOptions)
      await this.probe(candidate)
      this.listener = candidate
      this.module = to
      return
    } catch (activationError) {
      if (candidate) {
        try {
          await candidate.stop(true)
        } catch {}
      }
      try {
        const restored = await httpBackend(from).Server.listen(this.listenOptions)
        await this.probe(restored)
        this.listener = restored
        this.module = from
      } catch (restoreError) {
        this.listener = undefined
        this.module = undefined
        throw new AggregateError(
          [activationError, restoreError],
          "Runtime HTTP backend activation failed and the previous listener could not be restored",
        )
      }
      throw activationError
    }
  }

  async stop(close = false) {
    const current = this.listener
    this.listener = undefined
    this.module = undefined
    await current?.stop(close)
  }
}
