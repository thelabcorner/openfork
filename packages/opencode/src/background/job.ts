import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { BackgroundJob as CoreBackgroundJob } from "@opencode-ai/core/background-job"
import { InstanceState } from "@/effect/instance-state"
import { Effect, Layer } from "effect"

export {
  Service,
  type ExtendInput,
  type Info,
  type Interface,
  type StartInput,
  type Status,
  type WaitInput,
  type WaitAnyInput,
  type WaitResult,
} from "@opencode-ai/core/background-job"

/** Keeps the legacy service instance-scoped while sharing the core registry engine. */
const layer = Layer.effect(
  CoreBackgroundJob.Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make(() => CoreBackgroundJob.make)
    return CoreBackgroundJob.Service.of({
      list: () => InstanceState.useEffect(state, (jobs) => jobs.list()),
      get: (id) => InstanceState.useEffect(state, (jobs) => jobs.get(id)),
      getMany: (ids) => InstanceState.useEffect(state, (jobs) => jobs.getMany(ids)),
      start: (input) => InstanceState.useEffect(state, (jobs) => jobs.start(input)),
      tryStart: (input) => InstanceState.useEffect(state, (jobs) => jobs.tryStart(input)),
      extend: (input) => InstanceState.useEffect(state, (jobs) => jobs.extend(input)),
      wait: (input) => InstanceState.useEffect(state, (jobs) => jobs.wait(input)),
      waitAny: (input) => InstanceState.useEffect(state, (jobs) => jobs.waitAny(input)),
      waitForPromotion: (id) => InstanceState.useEffect(state, (jobs) => jobs.waitForPromotion(id)),
      promote: (id) => InstanceState.useEffect(state, (jobs) => jobs.promote(id)),
      foreground: (id, onPromote) => InstanceState.useEffect(state, (jobs) => jobs.foreground(id, onPromote)),
      cancel: (id) => InstanceState.useEffect(state, (jobs) => jobs.cancel(id)),
    })
  }),
)

export const node = LayerNode.make({ service: CoreBackgroundJob.Service, layer, deps: [] })

export * as BackgroundJob from "./job"
