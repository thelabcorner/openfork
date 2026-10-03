export * as OfxpSessionSearch from "./session-search"

import { Effect } from "effect"
import { Database } from "@opencode-ai/core/database/database"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { Ofxp } from "@opencode-ai/schema/ofxp"
import { ExchangeError } from "@/exchange/error"
import { ExchangeSessionSearch } from "@/exchange/session-search"
import { OfxpRoot } from "../root"

export interface Dependencies {
  readonly db: Database.Interface["db"]
  readonly peers: OfxpPeer.Interface
  readonly roots: OfxpRoot.Interface
}

export interface Input
  extends Omit<
    ExchangeSessionSearch.Input,
    "directoryPrefixes" | "repairIndex" | "scopeLabel"
  > {
  readonly rootID?: Ofxp.RootID
}

export interface Result
  extends Omit<ExchangeSessionSearch.Result, "metadata"> {
  readonly metadata: ExchangeSessionSearch.Metadata & {
    readonly grantRevision: number
    readonly authorizedRoots: number
  }
}

function cancelled(signal?: AbortSignal) {
  return signal?.aborted
    ? Effect.fail(
        new ExchangeError.Cancelled({
          detail: "OFXP Session search was cancelled",
        }),
      )
    : Effect.void
}

/**
 * Registration-free OFXP supervision adapter for indexed Session recall.
 *
 * This intentionally does not advertise a supervision feature or register a
 * wire method. Central OFXP runtime integration owns that decision. The adapter
 * exists so the eventual dispatcher has one authority-safe executable owner
 * rather than reimplementing search semantics in the transport layer.
 */
export const execute = Effect.fn("OfxpSessionSearch.execute")(function* (
  deps: Dependencies,
  peerID: Ofxp.PeerID,
  input: Input,
  signal?: AbortSignal,
) {
  yield* cancelled(signal)

  const access = yield* deps.peers.access(peerID)
  const grantRevision = access.info.grantRevision
  const publicRoots = input.rootID
    ? [{ id: input.rootID }]
    : (yield* deps.peers.roots(peerID))
        .filter((root) => root.available)
        .map((root) => ({ id: root.id }))

  if (publicRoots.length === 0) {
    return yield* new ExchangeError.AuthorityDenied({
      detail: "OFXP Session search has no approved roots",
    })
  }

  const admitted = yield* Effect.forEach(
    publicRoots,
    ({ id }) =>
      deps.peers
        .authorize({
          peerID,
          capability: "sessionSupervision",
          rootID: id,
          expectedGrantRevision: grantRevision,
        })
        .pipe(Effect.flatMap((authorization) => deps.roots.verify(authorization))),
    { concurrency: 8 },
  )

  // Nested approved roots are valid. Prefer the most-specific root for public
  // projection so the same native directory has one deterministic virtual form.
  const projectedRoots = [...admitted].sort(
    (left, right) => right.rootPath.length - left.rootPath.length,
  )

  yield* cancelled(signal)
  const result = yield* ExchangeSessionSearch.execute(
    deps.db,
    {
      ...input,
      directoryPrefixes: projectedRoots.map((root) => root.rootPath),
      scopeLabel: input.rootID ? "root:" + input.rootID : "approved-roots",
    },
    {
      revalidate: () =>
        Effect.gen(function* () {
          yield* cancelled(signal)
          for (const root of admitted) {
            const authorization = yield* deps.peers.authorize({
              peerID,
              capability: "sessionSupervision",
              rootID: root.rootID,
              expectedGrantRevision: grantRevision,
            })
            yield* deps.roots.verify(authorization)
          }
        }),
      projectDirectory: (directory) => {
        const root = projectedRoots.find((candidate) => {
          try {
            OfxpRoot.toVirtualPath(candidate, directory)
            return true
          } catch {
            return false
          }
        })
        if (!root) {
          throw new ExchangeError.PathEscape({
            detail: "Session search result escaped every approved OFXP root",
          })
        }
        return OfxpRoot.toVirtualPath(root, directory)
      },
    },
  )

  return {
    ...result,
    metadata: {
      ...result.metadata,
      grantRevision,
      authorizedRoots: admitted.length,
    },
  } satisfies Result
})
