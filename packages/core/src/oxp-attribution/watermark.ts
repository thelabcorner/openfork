export * as OxpAttributionWatermark from "./watermark"

import { Effect } from "effect"
import { observeDataVersion } from "../database/data-version"
import type { DatabaseShape } from "../database/database"
import { OxpAttributionRevision } from "./revision"

export interface Value {
  readonly localRevision: number
  readonly externalDataVersion: number
}

export interface Memo<A> {
  readonly watermark: Value
  readonly value: A
}

const UNOBSERVED_DATA_VERSION = Number.NaN

export const make = (db: DatabaseShape): Effect.Effect<Value> =>
  Effect.gen(function* () {
    const observed = yield* observeDataVersion(db)
    return {
      localRevision: OxpAttributionRevision.current(),
      externalDataVersion: observed ?? UNOBSERVED_DATA_VERSION,
    }
  })

export const same = (left: Value, right: Value) =>
  left.localRevision === right.localRevision && left.externalDataVersion === right.externalDataVersion

export const cached = <A>(read: Effect.Effect<A>, watermark: Effect.Effect<Value>) => {
  let settled: Memo<A> | undefined
  let inflight: { readonly watermark: Value; readonly round: Effect.Effect<Memo<A>> } | undefined

  const roundFor = Effect.fnUntraced(function* (current: Value) {
    const running = inflight
    if (running && same(running.watermark, current)) return running
    const next = {
      watermark: current,
      round: yield* Effect.cached(
        Effect.suspend(() => read).pipe(Effect.map((value): Memo<A> => ({ watermark: current, value }))),
      ),
    }
    inflight = next
    return next
  })

  return Effect.fnUntraced(function* () {
    const current = yield* watermark
    const hit = settled
    if (hit && same(hit.watermark, current)) return hit
    const opened = yield* roundFor(current)
    const next = yield* opened.round.pipe(
      Effect.onExit(() =>
        Effect.sync(() => {
          if (inflight === opened) inflight = undefined
        }),
      ),
    )
    settled = next
    return next
  })
}
