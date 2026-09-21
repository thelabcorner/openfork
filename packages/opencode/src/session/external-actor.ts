/**
 * Protocol-neutral attribution for an actor that exists outside OpenFork's
 * native Session/resident-agent graph. This records origin only; it carries no
 * permission or instruction authority.
 */
export interface Ref {
  readonly type: "external"
  readonly source: string
  readonly ref: string
}

export * as ExternalActor from "./external-actor"
