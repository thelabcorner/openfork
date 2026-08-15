import { createOpencodeClient } from "@opencode-ai/sdk/v2/client"
import { OpenCode, type OpenCodeClient } from "@opencode-ai/client/promise"
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

export function createSdkForServer({
  server,
  ...config
}: Omit<NonNullable<Parameters<typeof createOpencodeClient>[0]>, "baseUrl"> & {
  server: ServerConnection.HttpBase
}) {
  const auth = (() => {
    if (!server.password) return
    return {
      Authorization: `Basic ${authTokenFromCredentials({ username: server.username, password: server.password })}`,
    }
  })()

  return createOpencodeClient({
    ...config,
    headers: {
      ...(config.headers instanceof Headers ? Object.fromEntries(config.headers.entries()) : config.headers),
      ...auth,
    },
    baseUrl: server.url,
  })
}

export function createApiForServer(input: {
  server: ServerConnection.HttpBase
  fetch?: typeof globalThis.fetch
}): OpenCodeClient {
  return withClientContext(
    OpenCode.make({
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
  return new Error(`OpenCode client request descriptor missing while calling ${method}`, { cause })
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
