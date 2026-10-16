import * as Context from "effect/Context"
import * as Option from "effect/Option"
import * as Tracer from "effect/Tracer"

/**
 * Return only explicitly application-namespaced Effect operation labels.
 * Names that could encode user input, SQL identifiers, file paths, identifiers,
 * or arbitrary span attributes are never persisted in diagnostic strings.
 *
 * The nearest application span is normally Effect.fn("Session.foo") or
 * Effect.fn("SessionExecutionOwner.foo"); SQL driver spans are bypassed.
 */
const safeOperation = /^(?:Session[A-Za-z0-9]*|RuntimeOwner|Swarm[A-Za-z0-9]*|Database[A-Za-z0-9]*|EventV2|Event[A-Za-z0-9]*|Context[A-Za-z0-9]*|Usage[A-Za-z0-9]*|Project[A-Za-z0-9]*|Goal[A-Za-z0-9]*|OXP[A-Za-z0-9]*|Search[A-Za-z0-9]*|Snapshot[A-Za-z0-9]*|Provider[A-Za-z0-9]*|OpenFork[A-Za-z0-9]*)\.[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)?$/

/**
 * Sample one immutable operation label from the current Effect trace, not
 * JavaScript stack traces. No trace IDs, parameters, annotations or spans
 * themselves are retained.
 */
export function sqliteQueryOrigin(context: Context.Context<never>): string {
  let candidate = Context.getOption(context, Tracer.ParentSpan)
  for (let depth = 0; depth < 16 && Option.isSome(candidate); depth++) {
    const span = candidate.value
    if (span._tag !== "Span") return "unknown"
    if (span.name.length <= 128 && safeOperation.test(span.name)) return span.name
    candidate = span.parent
  }
  return "unknown"
}
