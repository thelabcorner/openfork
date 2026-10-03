import path from "path"
import { randomUUID } from "crypto"
import { Context, Effect, Layer, Option, Schedule, Schema } from "effect"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Global } from "@opencode-ai/core/global"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { EffectFlock } from "@opencode-ai/core/util/effect-flock"
import { OxpError } from "./error"
import { OxpModelSelection } from "./model-selection"
import { OxpSchema } from "./schema"

type LoadState =
  | { readonly kind: "valid"; readonly config: OxpSchema.Config }
  | { readonly kind: "malformed"; readonly fallback: OxpSchema.Config }

export interface Interface {
  readonly get: () => Effect.Effect<OxpSchema.Config, OxpError.DependencyUnavailable>
  readonly reload: () => Effect.Effect<OxpSchema.Config, OxpError.DependencyUnavailable>
  readonly update: (fn: (current: OxpSchema.Config) => OxpSchema.Config) => Effect.Effect<OxpSchema.Config, OxpError.Error>
  readonly setEnabled: (enabled: boolean) => Effect.Effect<OxpSchema.Config, OxpError.Error>
  readonly setGrant: (patch: Partial<OxpSchema.Grant>) => Effect.Effect<OxpSchema.Config, OxpError.Error>
  /** Durable OXP delegation preference. This is not a provider/model allowlist. */
  readonly setWorkerDefaultModel: (
    model: OxpSchema.ModelSelection | undefined,
  ) => Effect.Effect<OxpSchema.Config, OxpError.Error>
  /** Durable root-scoped OXP agent preference. This is not agent authorization. */
  readonly setWorkerDefaultAgent: (
    rootID: OxpSchema.RootID,
    agent: string | undefined,
  ) => Effect.Effect<OxpSchema.Config, OxpError.Error>
  readonly subscribe: (listener: (config: OxpSchema.Config) => void) => Effect.Effect<() => void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OxpConfig") {}
export const use = serviceUse(Service)

function freezeConfig(config: OxpSchema.Config): OxpSchema.Config {
  // New default-off grants are materialized in memory so older, otherwise valid
  // oxp.json documents remain compatible without an eager disk rewrite.
  const normalized = {
    ...config,
    grant: {
      ...config.grant,
      automation: config.grant.automation ?? false,
    },
    // models/agents are retained only for on-disk compatibility with the old
    // selection-authorization design. Defaults remain active preferences.
    workerPolicy: config.workerPolicy ?? {
      models: [],
      agents: [],
      agentRoots: [],
    },
  } satisfies OxpSchema.Config
  Object.freeze(normalized.connector)
  Object.freeze(normalized.grant)
  for (const model of normalized.workerPolicy.models) Object.freeze(model)
  Object.freeze(normalized.workerPolicy.models)
  Object.freeze(normalized.workerPolicy.agents)
  for (const scoped of normalized.workerPolicy.agentRoots ?? []) {
    Object.freeze(scoped.agents)
    Object.freeze(scoped)
  }
  if (normalized.workerPolicy.agentRoots) Object.freeze(normalized.workerPolicy.agentRoots)
  if (normalized.workerPolicy.defaultModel) Object.freeze(normalized.workerPolicy.defaultModel)
  Object.freeze(normalized.workerPolicy)
  for (const root of normalized.roots) {
    if (root.sources) Object.freeze(root.sources)
    Object.freeze(root)
  }
  Object.freeze(normalized.roots)
  return Object.freeze(normalized)
}

/**
 * Pre-root-scoping configs stored one connector-global defaultAgent. Freeze
 * that preference onto roots that already exist the first time worker-agent
 * preferences are mutated. Newly approved roots never inherit it implicitly.
 *
 * Legacy models/agents arrays are preserved byte-for-byte for compatibility;
 * runtime delegation no longer treats either array as authorization.
 */
export function scopeLegacyWorkerAgentPolicy(
  config: OxpSchema.Config,
): OxpSchema.WorkerPolicy {
  const policy = config.workerPolicy ?? { models: [], agents: [] }
  if (policy.agentRoots !== undefined) return policy
  return {
    ...policy,
    agentRoots: config.roots.map((root) => ({
      rootID: root.id,
      agents: [...policy.agents],
      ...(policy.defaultAgent ? { defaultAgent: policy.defaultAgent } : {}),
    })),
  }
}

function semantic(config: OxpSchema.Config) {
  return JSON.stringify({ ...config, revision: 0 })
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const global = yield* Global.Service
    const fs = yield* FSUtil.Service
    const flock = yield* EffectFlock.Service
    const filepath = path.join(global.config, "oxp.json")
    const lockKey = `oxp-config:${filepath}`
    const listeners = new Set<(config: OxpSchema.Config) => void>()
    let cached: LoadState | undefined
    let malformedFallback: OxpSchema.Config | undefined

    const defaults = () => freezeConfig(OxpSchema.defaults(OxpSchema.ConnectorID.make(randomUUID())))
    const unavailable = (detail: string) => new OxpError.DependencyUnavailable({ detail })

    const atomicWrite = Effect.fn("OxpConfig.atomicWrite")(function* (config: OxpSchema.Config) {
      const temporary = `${filepath}.${process.pid}.${randomUUID()}.tmp`
      const payload = `${JSON.stringify(config, null, 2)}\n`
      yield* fs.makeDirectory(path.dirname(filepath), { recursive: true }).pipe(
        Effect.mapError(() => unavailable("Unable to create the OXP configuration directory")),
      )
      yield* fs.writeFileString(temporary, payload, { flag: "wx", mode: 0o600 }).pipe(
        Effect.mapError(() => unavailable("Unable to write the OXP configuration temporary file")),
      )
      yield* fs.rename(temporary, filepath).pipe(
        Effect.retry({ times: 8, schedule: Schedule.spaced("20 millis") }),
        Effect.catch((cause) =>
          fs.remove(temporary).pipe(
            Effect.ignore,
            Effect.andThen(
              Effect.fail(unavailable(`Unable to atomically publish OXP configuration: ${String(cause)}`)),
            ),
          ),
        ),
      )
    })

    const decode = Effect.fnUntraced(function* (value: unknown) {
      return yield* Schema.decodeUnknownEffect(OxpSchema.Config)(value, {
        errors: "all",
        onExcessProperty: "error",
      }).pipe(Effect.map(freezeConfig), Effect.option)
    })

    const readDisk = Effect.fn("OxpConfig.readDisk")(function* (createIfMissing: boolean) {
      const raw = yield* fs.readFileString(filepath).pipe(
        Effect.map((value) => Option.some(value)),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed(Option.none<string>()),
        ),
        Effect.mapError(() => unavailable("Unable to read OXP configuration")),
      )
      if (Option.isNone(raw)) {
        const config = defaults()
        if (createIfMissing) yield* atomicWrite(config)
        return { kind: "valid", config } as const
      }

      const parsed = yield* Effect.try({
        try: () => JSON.parse(raw.value) as unknown,
        catch: () => new OxpError.InvalidArgument({ detail: "OXP configuration JSON is malformed" }),
      }).pipe(Effect.option)
      if (Option.isSome(parsed)) {
        const decoded = yield* decode(parsed.value)
        if (Option.isSome(decoded)) return { kind: "valid", config: decoded.value } as const
      }

      malformedFallback ??= defaults()
      return { kind: "malformed", fallback: malformedFallback } as const
    })

    const publish = (state: LoadState) => {
      cached = state
      const value = state.kind === "valid" ? state.config : state.fallback
      for (const listener of listeners) {
        try {
          listener(value)
        } catch {
          // Subscribers observe committed state; they never participate in the commit.
        }
      }
      return value
    }

    const locked = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        flock.withLock(lockKey),
        Effect.mapError((error) =>
          OxpError.isError(error) ? error : unavailable("Unable to acquire the OXP configuration lock"),
        ),
      )

    const load = Effect.fnUntraced(function* (force: boolean) {
      if (!force && cached) return cached.kind === "valid" ? cached.config : cached.fallback
      return yield* locked(readDisk(true).pipe(Effect.map(publish)))
    })

    const get = Effect.fn("OxpConfig.get")(function* () {
      return yield* load(false)
    })

    const reload = Effect.fn("OxpConfig.reload")(function* () {
      return yield* load(true)
    })

    const update = Effect.fn("OxpConfig.update")(function* (fn: (current: OxpSchema.Config) => OxpSchema.Config) {
      return yield* locked(
        Effect.gen(function* () {
          const state = yield* readDisk(false)
          if (state.kind === "malformed") {
            return yield* new OxpError.Conflict({ detail: "OXP configuration is malformed and will not be overwritten" })
          }
          const candidate = yield* Effect.try({
            try: () => fn(state.config),
            catch: (cause) =>
              OxpError.isError(cause)
                ? cause
                : new OxpError.InvalidArgument({ detail: "OXP configuration update failed validation" }),
          })
          const decoded = yield* Schema.decodeUnknownEffect(OxpSchema.Config)(candidate, {
            errors: "all",
            onExcessProperty: "error",
          }).pipe(
            Effect.mapError(() => new OxpError.InvalidArgument({ detail: "OXP configuration update is invalid" })),
          )
          if (semantic(decoded) === semantic(state.config)) {
            publish({ kind: "valid", config: state.config })
            return state.config
          }
          const next = freezeConfig({ ...decoded, revision: state.config.revision + 1 })
          yield* atomicWrite(next)
          publish({ kind: "valid", config: next })
          return next
        }),
      )
    })

    const setEnabled = Effect.fn("OxpConfig.setEnabled")(function* (enabled: boolean) {
      return yield* update((current) => ({ ...current, enabled }))
    })

    const setGrant = Effect.fn("OxpConfig.setGrant")(function* (patch: Partial<OxpSchema.Grant>) {
      return yield* update((current) => {
        const grant = { ...current.grant, ...patch }
        if (grant.sessionSupervision === "none") grant.requestSupervision = false
        if (grant.delegation === "disabled") grant.nestedDelegation = false
        return { ...current, grant }
      })
    })

    const setWorkerDefaultModel = Effect.fn("OxpConfig.setWorkerDefaultModel")(
      function* (model: OxpSchema.ModelSelection | undefined) {
        return yield* update((current) => {
          const policy = current.workerPolicy ?? {
            models: [],
            agents: [],
            agentRoots: [],
          }
          const normalized = model
            ? OxpModelSelection.normalize(model)
            : undefined
          return {
            ...current,
            workerPolicy: {
              ...policy,
              ...(normalized
                ? { defaultModel: { ...normalized } }
                : { defaultModel: undefined }),
            },
          }
        })
      },
    )

    const setWorkerDefaultAgent = Effect.fn("OxpConfig.setWorkerDefaultAgent")(
      function* (rootID: OxpSchema.RootID, agent: string | undefined) {
        return yield* update((current) => {
          if (!current.roots.some((root) => root.id === rootID)) {
            throw new OxpError.RootNotFound({
              detail: "Approved root does not exist",
            })
          }
          const policy = scopeLegacyWorkerAgentPolicy(current)
          const currentRoot =
            policy.agentRoots?.find((entry) => entry.rootID === rootID) ?? {
              rootID,
              agents: [],
            }
          const nextRoot: OxpSchema.WorkerAgentRootPolicy = {
            ...currentRoot,
            ...(agent ? { defaultAgent: agent } : { defaultAgent: undefined }),
          }
          return {
            ...current,
            workerPolicy: {
              ...policy,
              agentRoots: [
                ...(policy.agentRoots ?? []).filter(
                  (entry) => entry.rootID !== rootID,
                ),
                nextRoot,
              ],
            },
          }
        })
      },
    )


    const subscribe = Effect.fn("OxpConfig.subscribe")(function* (listener: (config: OxpSchema.Config) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    })

    return Service.of({
      get,
      reload,
      update,
      setEnabled,
      setGrant,
      setWorkerDefaultModel,
      setWorkerDefaultAgent,
      subscribe,
    })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [Global.node, FSUtil.node, EffectFlock.node] })

export * as OxpConfig from "./config"
