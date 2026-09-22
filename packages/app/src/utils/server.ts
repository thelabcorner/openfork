import type { OpencodeClient, OpencodeClientConfig } from "@opencode-ai/sdk/v2/client"
import type { OpenCodeClient } from "@opencode-ai/client/promise"
import type { ServerConnection } from "@/context/server"
import { decode64 } from "@/utils/base64"

export function authTokenFromCredentials(input: { username?: string; password: string }) {
  return btoa(`${input.username ?? "opencode"}:${input.password}`)
}

export function authFromToken(token: string | null) {
  const decoded = decode64(token ?? undefined)
  if (!decoded) return
  const separator = decoded.indexOf(":")
  if (separator === -1) return
  return {
    username: decoded.slice(0, separator) || "opencode",
    password: decoded.slice(separator + 1),
  }
}

type ServerSdkConfig = OpencodeClientConfig & {
  directory?: string
  experimental_workspaceID?: string
}

let sdkModule: Promise<typeof import("@opencode-ai/sdk/v2/client")> | undefined
const loadSdkModule = () => (sdkModule ??= import("@opencode-ai/sdk/v2/client"))
let promiseClientModule: Promise<typeof import("@opencode-ai/client/promise")> | undefined
const loadPromiseClientModule = () => (promiseClientModule ??= import("@opencode-ai/client/promise"))

function lazyMethodClient<T extends object>(load: () => Promise<T>, tag: string): T {
  const nodes = new Map<string, unknown>()

  const node = (path: PropertyKey[]): unknown => {
    const key = path.map(String).join(".")
    const cached = nodes.get(key)
    if (cached) return cached

    const proxy = new Proxy(function () {}, {
      get(_target, property) {
        // A callable proxy with a .then property is treated as a Promise by
        // Promise.resolve/await, which would eagerly load the entire SDK merely
        // by passing an endpoint object around.
        if (property === "then") return undefined
        if (property === Symbol.toStringTag) return tag
        return node([...path, property])
      },
      apply(_target, _thisArg, args) {
        if (path.length === 0) throw new TypeError("OpenFork SDK root is not callable")
        return load().then((client) => {
          let parent: unknown = client
          for (let index = 0; index < path.length - 1; index++) {
            parent = (parent as Record<PropertyKey, unknown>)[path[index]!]
          }
          const property = path[path.length - 1]!
          const method = (parent as Record<PropertyKey, unknown>)?.[property]
          if (typeof method !== "function") {
            throw new TypeError(`OpenFork SDK member ${path.map(String).join(".")} is not callable`)
          }
          return Reflect.apply(method, parent, args)
        })
      },
    })
    nodes.set(key, proxy)
    return proxy
  }

  return node([]) as T
}

export function createSdkForServer({
  server,
  ...config
}: Omit<ServerSdkConfig, "baseUrl"> & {
  server: ServerConnection.HttpBase
}): OpencodeClient {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  const options: ServerSdkConfig = {
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  }
  let client: Promise<OpencodeClient> | undefined
  return lazyMethodClient(
    () => (client ??= loadSdkModule().then((mod) => mod.createOpencodeClient(options))),
    "OpenForkLazySdk",
  )
}

export function createApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): OpenCodeClient {
  let client: Promise<OpenCodeClient> | undefined
  return lazyMethodClient(
    () =>
      (client ??= loadPromiseClientModule().then((mod) =>
        withClientContext(
          mod.OpenCode.make({
            baseUrl: input.server.url,
            fetch: input.fetch,
            headers: input.server.password
              ? {
                  Authorization: `Basic ${authTokenFromCredentials({
                    username: input.server.username,
                    password: input.server.password,
                  })}`,
                }
              : undefined,
          }),
        ),
      )),
    "OpenForkLazyApi",
  )
}

export type ServerApi = OpenCodeClient

function withClientContext<T extends object>(value: T, path: readonly string[] = []): T {
  const cache = new Map<PropertyKey, unknown>()
  return new Proxy(value, {
    get(target, property, receiver) {
      const item = Reflect.get(target, property, receiver)
      if (typeof item === "function") {
        return (...args: unknown[]) => {
          const method = [...path, String(property)].join(".")
          try {
            return annotateClientResult(Reflect.apply(item, target, args), method)
          } catch (cause) {
            throw annotateClientError(cause, method)
          }
        }
      }
      if (item === null || typeof item !== "object") return item
      if (cache.has(property)) return cache.get(property)
      const nested = withClientContext(item, [...path, String(property)])
      cache.set(property, nested)
      return nested
    },
  })
}

function annotateClientResult(result: unknown, method: string) {
  if (isPromiseLike(result)) return result.catch((cause) => Promise.reject(annotateClientError(cause, method)))
  if (isAsyncIterable(result)) return annotateAsyncIterable(result, method)
  return result
}

function annotateAsyncIterable<T>(result: AsyncIterable<T>, method: string): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const item of result) yield item
      } catch (cause) {
        throw annotateClientError(cause, method)
      }
    },
  }
}

function annotateClientError(cause: unknown, method: string) {
  if (!isMissingDescriptorError(cause)) return cause
  return new Error(`OpenFork client request descriptor missing while calling ${method}`, { cause })
}

function isMissingDescriptorError(cause: unknown) {
  if (cause instanceof Error && cause.message.includes("reading 'method'")) return true
  if (cause instanceof Error && "cause" in cause) return isMissingDescriptorError(cause.cause)
  return false
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  if (!value || typeof value !== "object") return false
  return typeof (value as { then?: unknown }).then === "function"
}

function isAsyncIterable(value: unknown): value is AsyncIterable<unknown> {
  if (!value || typeof value !== "object") return false
  return typeof (value as { [Symbol.asyncIterator]?: unknown })[Symbol.asyncIterator] === "function"
}
