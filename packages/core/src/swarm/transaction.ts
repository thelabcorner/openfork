import { Effect } from "effect"
import type { Data, Definition } from "@opencode-ai/schema/event"
import { EventV2 } from "../event"
import { SwarmSchema } from "./schema"

/**
 * EventV2 local commit hooks intentionally expose only defects so a failed
 * projector cannot leave a durable event behind. Swarm domain errors therefore
 * cross that internal boundary as this private defect and are restored to typed
 * failures immediately outside publish().
 */
export class CommitFailure {
  constructor(readonly error: SwarmSchema.Error) {}
}

export function commitFail(error: SwarmSchema.Error) {
  return Effect.die(new CommitFailure(error))
}

export function liftCommitFailure<A>(effect: Effect.Effect<A>) {
  return effect.pipe(
    Effect.catchDefect((defect) =>
      defect instanceof CommitFailure ? Effect.fail(defect.error) : Effect.die(defect),
    ),
  )
}

export function publishWithCommit<D extends Definition>(
  events: EventV2.Interface,
  definition: D,
  data: Data<D>,
  commit: (seq: number) => Effect.Effect<void>,
) {
  return liftCommitFailure(events.publish(definition, data, { commit }))
}
