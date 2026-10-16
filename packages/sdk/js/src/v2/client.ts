export * from "./gen/types.gen.js"
export type { FileSystemEntry as LocationFileSystemEntry } from "./gen/types.gen.js"

import { createClient } from "./gen/client/client.gen.js"
import { type Config } from "./gen/client/types.gen.js"
import {
  Message as SessionMessageReadClient,
  OpencodeClient as GeneratedOpencodeClient,
  Session2 as SessionReadClient,
} from "./gen/sdk.gen.js"
import type { Part } from "./gen/types.gen.js"
import { wrapClientError } from "../error-interceptor.js"
export { type Config as OpencodeClientConfig }

type TimelinePartsMethod = (input: { sessionID: string; messageID: string; cursor?: string }) => Promise<{
  data?: { data: Part[]; nextCursor?: string }
  error?: unknown
  response?: Response
}>

/**
 * The full OpenCode HTTP API contains a retained V1 session-read surface in
 * addition to the generated `/api/*` client. Keep that narrow adapter explicit
 * so first-party V1 callers can use its bootstrap-free `/session/*` routes
 * without hand-editing generated endpoints or migrating onto the current API.
 */
export class OpencodeClient extends GeneratedOpencodeClient {
  /**
   * First-party Tier-0 profiling endpoints added after the frozen generated SDK.
   *
   * Uses the same authenticated, configured SDK transport; unlike passing an
   * extra key into a generated endpoint method, this preserves additive query
   * parameters such as includeWorkload and never loses their values to the
   * generator's older query allowlist. Remove after the generated API catches up.
   */
  public analyticsProjection(
    path: "/usage/workload" | "/global/oxp/attribution",
    query: Record<string, string | number | undefined>,
    options?: { signal?: AbortSignal },
  ) {
    return this.client.get({
      url: path,
      query,
      throwOnError: true,
      signal: options?.signal,
    })
  }

  private _sessionRead?: SessionReadClient &
    Pick<SessionMessageReadClient, "parts"> & {
      timelineParts: TimelinePartsMethod
      timelinePartsBatch: SessionReadClient["timelinePartsBatch"]
      toolOutput: SessionMessageReadClient["toolOutput"]
    }

  get sessionRead(): SessionReadClient &
    Pick<SessionMessageReadClient, "parts"> & {
      timelineParts: TimelinePartsMethod
      timelinePartsBatch: SessionReadClient["timelinePartsBatch"]
      toolOutput: SessionMessageReadClient["toolOutput"]
    } {
    if (this._sessionRead) return this._sessionRead
    const session = new SessionReadClient({ client: this.client })
    const message = new SessionMessageReadClient({ client: this.client })
    const timelineParts = Reflect.get(message, "timelineParts")
    if (typeof timelineParts !== "function") throw new Error("The generated SDK is missing the timeline-parts read")
    return (this._sessionRead = Object.assign(session, {
      parts: message.parts.bind(message),
      timelineParts: timelineParts.bind(message) as TimelinePartsMethod,
      timelinePartsBatch: session.timelinePartsBatch.bind(session),
      toolOutput: message.toolOutput.bind(message),
    }))
  }
}

function pick(value: string | null, fallback?: string, encode?: (value: string) => string) {
  if (!value) return
  if (!fallback) return value
  if (value === fallback) return fallback
  if (encode && value === encode(fallback)) return fallback
  return value
}

function rewrite(request: Request, values: { directory?: string; workspace?: string }) {
  if (request.method !== "GET" && request.method !== "HEAD") return request

  const url = new URL(request.url)
  let changed = false

  for (const [name, key] of [
    ["x-opencode-directory", "directory"],
    ["x-opencode-workspace", "workspace"],
  ] as const) {
    const value = pick(
      request.headers.get(name),
      key === "directory" ? values.directory : values.workspace,
      key === "directory" ? encodeURIComponent : undefined,
    )
    if (!value) continue
    for (const query of url.pathname.startsWith("/api/") ? [key, `location[${key}]`] : [key]) {
      if (!url.searchParams.has(query)) {
        url.searchParams.set(query, value)
      }
    }
    changed = true
  }

  if (!changed) return request

  const next = new Request(url, request)
  next.headers.delete("x-opencode-directory")
  next.headers.delete("x-opencode-workspace")
  return next
}

export function createOpencodeClient(config?: Config & { directory?: string; experimental_workspaceID?: string }) {
  if (!config?.fetch) {
    const customFetch: any = (req: any) => {
      // @ts-ignore
      req.timeout = false
      return fetch(req)
    }
    config = {
      ...config,
      fetch: customFetch,
    }
  }

  if (config?.directory) {
    config.headers = {
      ...config.headers,
      "x-opencode-directory": encodeURIComponent(config.directory),
    }
  }

  if (config?.experimental_workspaceID) {
    config.headers = {
      ...config.headers,
      "x-opencode-workspace": config.experimental_workspaceID,
    }
  }

  const client = createClient(config)
  client.interceptors.request.use((request) => {
    if (!request) throw new Error("OpenFork SDK request interceptor received no Request")
    return rewrite(request, {
      directory: config?.directory,
      workspace: config?.experimental_workspaceID,
    })
  })
  client.interceptors.response.use((response) => {
    const contentType = response.headers.get("content-type")
    if (contentType === "text/html")
      throw new Error("Request is not supported by this version of OpenFork Server (Server responded with text/html)")

    return response
  })
  client.interceptors.error.use(wrapClientError)
  return new OpencodeClient({ client })
}
