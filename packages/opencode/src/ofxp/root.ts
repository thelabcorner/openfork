export * as OfxpRoot from "./root"

import path from "node:path"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { OfxpPeer } from "@opencode-ai/core/ofxp-peer"
import { makeGlobalNode } from "@opencode-ai/core/effect/app-node"
import { serviceUse } from "@opencode-ai/core/effect/service-use"
import { Ofxp } from "@opencode-ai/schema/ofxp"

const IS_WINDOWS = process.platform === "win32"

export class InvalidPathError extends Schema.TaggedErrorClass<InvalidPathError>()("OfxpRoot.InvalidPathError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export class RootChangedError extends Schema.TaggedErrorClass<RootChangedError>()("OfxpRoot.RootChangedError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail
  }
}

export type Error = InvalidPathError | RootChangedError

export interface Resolved {
  readonly authorization: OfxpPeer.Authorization
  readonly rootID: Ofxp.RootID
  readonly alias: Ofxp.RootAlias
  readonly rootPath: string
  readonly path: string
  readonly relativePath: string
  readonly virtualPath: string
}

/**
 * Project a canonical Machine-B path into the public OFXP root namespace.
 * Fails closed instead of ever serializing an absolute path outside the grant.
 */
export function toVirtualPath(root: Pick<Resolved, "rootPath" | "alias">, canonicalPath: string) {
  if (!contained(root.rootPath, canonicalPath)) {
    throw new InvalidPathError({ detail: "OFXP result path escapes the approved root" })
  }
  const relative = path.relative(root.rootPath, canonicalPath).split(path.sep).join("/")
  return relative ? `/${root.alias}/${relative}` : `/${root.alias}`
}

export interface Interface {
  readonly approve: (
    peerID: Ofxp.PeerID,
    candidate: string,
    alias?: string,
    source?: "manual" | "project",
    expectedGrantRevision?: number,
  ) => Effect.Effect<
    Ofxp.PublicRoot,
    | Error
    | OfxpPeer.OfxpPeerSchema.NotFoundError
    | OfxpPeer.OfxpPeerSchema.StaleRevisionError
    | OfxpPeer.OfxpPeerSchema.ValidationError
  >
  readonly resolve: (
    authorization: OfxpPeer.Authorization,
    relativePath?: string,
    options?: { readonly allowMissing?: boolean },
  ) => Effect.Effect<Resolved, Error>
  readonly verify: (authorization: OfxpPeer.Authorization) => Effect.Effect<Resolved, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/OfxpRoot") {}
export const use = serviceUse(Service)

function pathIdentity(value: string) {
  const resolved = path.resolve(value)
  return IS_WINDOWS ? resolved.toLowerCase() : resolved
}

function samePath(left: string, right: string) {
  return pathIdentity(left) === pathIdentity(right)
}

function contained(parent: string, child: string) {
  const left = pathIdentity(parent)
  const right = pathIdentity(child)
  return right === left || right.startsWith(left.endsWith(path.sep) ? left : `${left}${path.sep}`)
}

function normalizeAlias(input: string) {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 32)
  return Ofxp.RootAlias.make(slug || "folder")
}

function relativeSegments(input: string | undefined) {
  const value = input?.trim() ?? ""
  if (!value || value === ".") return []
  if (value.length > 4096 || value.includes("\0")) throw new InvalidPathError({ detail: "OFXP path is invalid" })
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith("\\") || value.includes("\\")) {
    throw new InvalidPathError({ detail: "OFXP paths must be root-relative and use '/' separators" })
  }
  const segments = value.split("/")
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new InvalidPathError({ detail: "OFXP path traversal or empty segments are not allowed" })
  }
  for (const segment of segments) {
    if (segment.length > 255 || /[\x00-\x1f\x7f]/.test(segment)) {
      throw new InvalidPathError({ detail: "OFXP path contains an invalid segment" })
    }
    if (IS_WINDOWS && (segment.includes(":") || /[<>"|?*]/.test(segment) || /[. ]$/.test(segment))) {
      throw new InvalidPathError({ detail: "OFXP path contains a Windows-invalid segment" })
    }
  }
  return segments
}

function fingerprint(stat: { readonly ino: Option.Option<bigint | number> }) {
  const ino = Number(Option.getOrElse(stat.ino, () => 0))
  return ino > 0 ? `inode:${ino}` : undefined
}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const peers = yield* OfxpPeer.Service

    const approve = Effect.fn("OfxpRoot.approve")(function* (
      peerID: Ofxp.PeerID,
      candidate: string,
      requestedAlias?: string,
      source: "manual" | "project" = "manual",
      expectedGrantRevision?: number,
    ) {
      if (!path.isAbsolute(candidate)) return yield* new InvalidPathError({ detail: "OFXP approved root must be absolute" })
      if (IS_WINDOWS && candidate.startsWith("\\\\")) {
        return yield* new InvalidPathError({ detail: "OFXP UNC/network roots are not supported" })
      }
      const canonical = yield* fs.realPath(candidate).pipe(
        Effect.mapError(() => new InvalidPathError({ detail: "OFXP approved root does not exist" })),
      )
      const parsed = path.parse(canonical)
      if (samePath(parsed.root, canonical)) {
        return yield* new InvalidPathError({ detail: "Approving an entire filesystem as an OFXP root is not allowed" })
      }
      const stat = yield* fs.stat(canonical).pipe(
        Effect.mapError(() => new InvalidPathError({ detail: "OFXP approved root is unavailable" })),
      )
      if (stat.type !== "Directory") return yield* new InvalidPathError({ detail: "OFXP approved root must be a directory" })
      return yield* peers.approveRoot({
        peerID,
        ...(expectedGrantRevision === undefined ? {} : { expectedGrantRevision }),
        alias: normalizeAlias(requestedAlias ?? (path.basename(canonical) || "folder")),
        canonicalPath: canonical,
        identityFingerprint: fingerprint(stat),
        source,
      })
    })

    const resolve = Effect.fn("OfxpRoot.resolve")(function* (
      authorization: OfxpPeer.Authorization,
      relativePath?: string,
      options: { readonly allowMissing?: boolean } = {},
    ) {
      const root = authorization.root
      if (!root) return yield* new InvalidPathError({ detail: "OFXP operation requires an approved root" })
      const current = yield* fs.realPath(root.canonicalPath).pipe(
        Effect.mapError(() => new RootChangedError({ detail: `OFXP root /${root.alias} is unavailable` })),
      )
      if (!samePath(current, root.canonicalPath)) {
        return yield* new RootChangedError({ detail: `OFXP root /${root.alias} changed on disk` })
      }
      const stat = yield* fs.stat(current).pipe(
        Effect.mapError(() => new RootChangedError({ detail: `OFXP root /${root.alias} is unavailable` })),
      )
      if (stat.type !== "Directory") return yield* new RootChangedError({ detail: `OFXP root /${root.alias} is no longer a directory` })
      const currentFingerprint = fingerprint(stat)
      if (root.identityFingerprint && currentFingerprint && root.identityFingerprint !== currentFingerprint) {
        return yield* new RootChangedError({ detail: `OFXP root /${root.alias} was replaced on disk` })
      }

      const segments = yield* Effect.try({
        try: () => relativeSegments(relativePath),
        catch: (cause) =>
          cause instanceof InvalidPathError ? cause : new InvalidPathError({ detail: "OFXP path failed validation" }),
      })
      const requested = segments.length ? path.join(current, ...segments) : current
      let target = yield* fs.realPath(requested).pipe(Effect.catch(() => Effect.succeed(undefined)))
      if (!target) {
        if (!options.allowMissing) return yield* new InvalidPathError({ detail: "OFXP target does not exist" })

        // For a creation target, prove the deepest existing ancestor first.
        // This closes the classic `approved/link -> outside; write link/new`
        // escape: the existing symlink resolves outside and containment fails
        // before any directory or file is created.
        const missing: string[] = []
        let cursor = requested
        while (true) {
          const real = yield* fs.realPath(cursor).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (real) {
            if (!contained(current, real)) {
              return yield* new InvalidPathError({ detail: "OFXP path escapes the approved root" })
            }
            const ancestor = yield* fs.stat(real).pipe(
              Effect.mapError(() => new InvalidPathError({ detail: "OFXP target ancestor is unavailable" })),
            )
            if (missing.length > 0 && ancestor.type !== "Directory") {
              return yield* new InvalidPathError({ detail: "OFXP target parent is not a directory" })
            }
            target = missing.length ? path.join(real, ...missing.reverse()) : real
            break
          }
          const parent = path.dirname(cursor)
          if (samePath(parent, cursor)) {
            return yield* new InvalidPathError({ detail: "OFXP target has no valid ancestor inside the approved root" })
          }
          missing.push(path.basename(cursor))
          cursor = parent
        }
      }
      if (!contained(current, target)) return yield* new InvalidPathError({ detail: "OFXP path escapes the approved root" })
      const relative = path.relative(current, target).split(path.sep).join("/")
      return {
        authorization,
        rootID: root.id,
        alias: root.alias,
        rootPath: current,
        path: target,
        relativePath: relative,
        virtualPath: toVirtualPath({ rootPath: current, alias: root.alias }, target),
      } satisfies Resolved
    })

    const verify = Effect.fn("OfxpRoot.verify")(function* (authorization: OfxpPeer.Authorization) {
      return yield* resolve(authorization)
    })

    return Service.of({ approve, resolve, verify })
  }),
)

export const node = makeGlobalNode({ service: Service, layer, deps: [FSUtil.node, OfxpPeer.node] })
