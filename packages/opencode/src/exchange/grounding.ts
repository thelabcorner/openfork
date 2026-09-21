export * as ExchangeGrounding from "./grounding"

import { Context, Layer } from "effect"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { FSUtil } from "@opencode-ai/core/fs-util"

const DEFAULT_MAX = 2048

export interface Scoped {
  readonly note: (rootID: string, path: string, fingerprint: string) => void
  readonly get: (rootID: string, path: string) => string | undefined
  readonly remove: (rootID: string, path: string) => void
}

export interface Interface {
  readonly scoped: (principal: string) => Scoped
  readonly size: () => number
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ExchangeGrounding") {}
export const use = serviceUse(Service)

export function make(max = DEFAULT_MAX): Interface {
  const entries = new Map<string, string>()
  const key = (principal: string, rootID: string, filePath: string) =>
    `${principal}\u0000${rootID}\u0000${FSUtil.normalizePath(filePath)}`
  const set = (id: string, value: string) => {
    if (entries.has(id)) entries.delete(id)
    while (entries.size >= max) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
    entries.set(id, value)
  }
  return {
    scoped: (principal) => ({
      note: (rootID, filePath, fingerprint) => set(key(principal, rootID, filePath), fingerprint),
      get: (rootID, filePath) => entries.get(key(principal, rootID, filePath)),
      remove: (rootID, filePath) => {
        entries.delete(key(principal, rootID, filePath))
      },
    }),
    size: () => entries.size,
  }
}

const layer = Layer.succeed(Service, Service.of(make()))
export const node = makeGlobalNode({ service: Service, layer, deps: [] })

