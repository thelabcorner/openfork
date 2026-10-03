import { Context, Effect, Layer } from "effect"
import type { Part } from "@opencode-ai/schema/session-v1"
import { makeGlobalNode } from "../effect/app-node"

export interface Key {
  readonly sessionID: string
  readonly messageID: string
  readonly partID: string
}

export interface Interface {
  /** Register a borrowed producer-owned part getter and return its release token. */
  readonly register: (input: Key & { readonly snapshot: () => Part }) => symbol
  /** Release only the matching generation; a stale cleanup cannot remove a replacement. */
  readonly release: (key: Key, token: symbol) => void
  /** Read detached snapshots for the requested detail-page message IDs. */
  readonly snapshot: (sessionID: string, messageIDs: readonly string[]) => readonly Part[]
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionCurrentParts") {}

const layer = Layer.effect(Service, Effect.sync(() => {
  const bySession = new Map<string, Map<string, Map<string, { token: symbol; snapshot: () => Part }>>>()

  const messages = (sessionID: string) => {
    let value = bySession.get(sessionID)
    if (!value) {
      value = new Map()
      bySession.set(sessionID, value)
    }
    return value
  }

  return Service.of({
    register: (input) => {
      const token = Symbol("session-current-part")
      const message = messages(input.sessionID)
      let parts = message.get(input.messageID)
      if (!parts) {
        parts = new Map()
        message.set(input.messageID, parts)
      }
      parts.set(input.partID, { token, snapshot: input.snapshot })
      return token
    },
    release: (key, token) => {
      const message = bySession.get(key.sessionID)?.get(key.messageID)
      if (message?.get(key.partID)?.token !== token) return
      message.delete(key.partID)
      if (message.size === 0) bySession.get(key.sessionID)?.delete(key.messageID)
      if (bySession.get(key.sessionID)?.size === 0) bySession.delete(key.sessionID)
    },
    snapshot: (sessionID, messageIDs) => {
      const session = bySession.get(sessionID)
      if (!session) return []
      const result: Part[] = []
      for (const messageID of messageIDs) {
        for (const entry of session.get(messageID)?.values() ?? []) {
          // JS mutations and this detached clone run synchronously on the same
          // event loop, so the returned part is one coherent producer snapshot.
          result.push(structuredClone(entry.snapshot()))
        }
      }
      return result
    },
  })
}))

export const node = makeGlobalNode({ service: Service, layer, deps: [] })
