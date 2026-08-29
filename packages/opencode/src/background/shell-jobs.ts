import { Context, Effect, Layer, SynchronizedRef } from "effect"
import type { ChildProcessHandle } from "effect/unstable/process/ChildProcessSpawner"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { TRUNCATION_DIR } from "@/tool/truncation-dir"
import path from "path"

export type ShellJobKind = "shell" | "monitor"

export type ShellJobDelivery =
  | { readonly mode: "none" }
  | { readonly mode: "completion"; readonly ownerSessionID: string }
  | {
      readonly mode: "events"
      readonly ownerSessionID: string
      readonly description: string
      readonly debounceMs: number
      readonly eventStream: "stdout"
    }

export type ShellJobEntry = {
  id: string
  handle: ChildProcessHandle
  command: string
  shell: string
  cwd: string
  env: NodeJS.ProcessEnv
  logPath: string
  metaPath: string
  notify: boolean
  timeoutMs?: number
  kind: ShellJobKind
  delivery: ShellJobDelivery
  startedAt: number
  description?: string
}

export interface Interface {
  readonly register: (entry: ShellJobEntry) => Effect.Effect<void>
  readonly remove: (id: string) => Effect.Effect<void>
  readonly get: (id: string) => Effect.Effect<ShellJobEntry | undefined>
  readonly list: () => Effect.Effect<ShellJobEntry[]>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/ShellJobs") {}

// File stem for a job id: strips a leading "job_" prefix so both the default
// "job_<ulid>" ids and custom handles ("bg1") map to one clean file name
// ("job_<ulid>.log", "job_bg1.log") without a double prefix.
export function jobFileStem(id: string): string {
  return id.startsWith("job_") ? id.slice("job_".length) : id
}

export const JOB_SUBDIR = "job-output"
export const jobLogPath = (id: string) => path.join(TRUNCATION_DIR, JOB_SUBDIR, `job_${jobFileStem(id)}.log`)
export const jobMetaPath = (id: string) => path.join(TRUNCATION_DIR, JOB_SUBDIR, `job_${jobFileStem(id)}.json`)
// Legacy paths (pre-subdir) — for reading old jobs that haven't been migrated
export const jobLogPathLegacy = (id: string) => path.join(TRUNCATION_DIR, `job_${jobFileStem(id)}.log`)
export const jobMetaPathLegacy = (id: string) => path.join(TRUNCATION_DIR, `job_${jobFileStem(id)}.json`)

// Process-global set of live job file stems. Truncate.cleanup (which runs in a
// global context without an instance) reads this to never delete a running
// job's log/meta files even when the job has been quiet past the mtime cutoff.
const held = new Set<string>()

export const heldJobStems = (): ReadonlySet<string> => held

type Jobs = {
  readonly register: (entry: ShellJobEntry) => Effect.Effect<void>
  readonly remove: (id: string) => Effect.Effect<void>
  readonly get: (id: string) => Effect.Effect<ShellJobEntry | undefined>
  readonly list: () => Effect.Effect<ShellJobEntry[]>
}

const make = Effect.gen(function* () {
  const jobs = yield* SynchronizedRef.make(new Map<string, ShellJobEntry>())

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      const all = yield* SynchronizedRef.get(jobs)
      for (const entry of all.values()) {
        held.delete(jobFileStem(entry.id))
        yield* entry.handle.kill({ forceKillAfter: "3 seconds" }).pipe(Effect.ignore)
      }
    }),
  )

  const register: Jobs["register"] = (entry) =>
    Effect.gen(function* () {
      held.add(jobFileStem(entry.id))
      yield* SynchronizedRef.update(jobs, (map) => new Map(map).set(entry.id, entry))
    })

  const remove: Jobs["remove"] = (id) =>
    Effect.gen(function* () {
      held.delete(jobFileStem(id))
      yield* SynchronizedRef.update(jobs, (map) => {
        const next = new Map(map)
        next.delete(id)
        return next
      })
    })

  const get: Jobs["get"] = (id) => Effect.map(SynchronizedRef.get(jobs), (map) => map.get(id))

  const list: Jobs["list"] = () => Effect.map(SynchronizedRef.get(jobs), (map) => Array.from(map.values()))

  return { register, remove, get, list }
})

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() => make)
    return Service.of({
      register: (entry) => InstanceState.useEffect(state, (jobs) => jobs.register(entry)),
      remove: (id) => InstanceState.useEffect(state, (jobs) => jobs.remove(id)),
      get: (id) => InstanceState.useEffect(state, (jobs) => jobs.get(id)),
      list: () => InstanceState.useEffect(state, (jobs) => jobs.list()),
    })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as ShellJobs from "./shell-jobs"
