import { CodeMode, toolError } from "@opencode-ai/codemode"
import { fromJsonSchema } from "@modelcontextprotocol/server"
import { Effect } from "effect"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Permission } from "@/permission"
import type * as Tool from "@/tool/tool"
import * as Capability from "@/tool/capability"
import * as Revision from "./revision"
import type { LoadedRevision } from "./saved"
import { PreparedProgramCache } from "./prepared"
import * as CodeExecution from "./execution"

type Attachment = NonNullable<Tool.ExecuteResult["attachments"]>[number]

type VerifiedSaved = {
  readonly item: LoadedRevision
  readonly prepared: CodeMode.PreparedProgram
}

type RegistrationOptions = {
  /** Authoritative immutable-handle resolver. Production supplies disk+admission resolution. */
  readonly resolveExact?: (selector: string) => Effect.Effect<LoadedRevision, unknown>
  /** Frozen root capability snapshot used for dependency-contract re-preflight. */
  readonly snapshot?: () => ReadonlyMap<string, Capability.Registration>
}

function issueText(issues: readonly unknown[] | undefined) {
  if (!issues?.length) return
  return issues
    .slice(0, 3)
    .map((issue) => {
      if (typeof issue !== "object" || issue === null) return String(issue)
      const message = "message" in issue ? String(issue.message) : "schema violation"
      const path =
        "path" in issue && Array.isArray(issue.path)
          ? issue.path.map((segment) => String(segment)).join(".")
          : ""
      return path ? `${path}: ${message}` : message
    })
    .join("; ")
}

function validator(schema: object) {
  const standard = fromJsonSchema(schema)
  return (value: unknown) =>
    Effect.promise(() => Promise.resolve(standard["~standard"].validate(value))).pipe(
      Effect.flatMap((result) => {
        const detail = issueText(result.issues)
        return detail ? Effect.fail(toolError(detail)) : Effect.succeed(value)
      }),
    )
}

function programValue(result: Tool.ExecuteResult, collect: (attachment: Attachment) => void): unknown {
  for (const attachment of result.attachments ?? []) collect(attachment)
  if (result.data !== undefined) return result.data
  if (result.output.length > 0) return result.output
  return null
}

function outputText(value: unknown) {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value) ?? "null"
  } catch {
    return "null"
  }
}

function permissionPattern(item: LoadedRevision) {
  return `call:${item.scope}:${item.id}@${item.revision}`
}

function authorityBinding(item: LoadedRevision) {
  // Bind trust to the physical scope without persisting an absolute path into
  // revision dependency envelopes.
  return `saved:${item.scope}:${Revision.sha256(item.scopeKey)}:${item.id}`
}

function prepareRevision(item: LoadedRevision) {
  let prepared: CodeMode.PreparedProgram | undefined
  let prepareDiagnostic: string | undefined
  try {
    prepared = PreparedProgramCache.get(item.source, item.envelope.sourceHash)
    const preparedRefs = prepared.dependencies.literalRefs
    const envelopeRefs = item.envelope.dependencies.map((dependency) => dependency.ref).sort()
    if (
      prepared.dependencies.dynamicCallTarget ||
      preparedRefs.length !== envelopeRefs.length ||
      preparedRefs.some((ref, index) => ref !== envelopeRefs[index])
    ) {
      prepareDiagnostic =
        "Saved source capability references do not match the admitted immutable dependency envelope."
      prepared = undefined
    }
  } catch (cause) {
    prepareDiagnostic = cause instanceof Error ? cause.message : String(cause)
  }
  return { prepared, prepareDiagnostic }
}

function baseRegistration(item: LoadedRevision, options: RegistrationOptions = {}): Capability.Registration {
  const initial = prepareRevision(item)
  const pattern = permissionPattern(item)

  const verify = (ctx: Tool.Context) =>
    Effect.gen(function* () {
      const cache = CodeExecution.verifiedSavedFrom(ctx)
      if (!cache) {
        return yield* Effect.fail(toolError("Saved Code capability is missing its root verification cache."))
      }
      const cached = cache.get(item.handle) as VerifiedSaved | undefined
      if (cached) return cached

      const fresh = options.resolveExact
        ? yield* options.resolveExact(item.handle).pipe(
            Effect.mapError((cause) =>
              toolError(
                cause instanceof Error
                  ? `Saved revision exact revalidation failed: ${cause.message}`
                  : "Saved revision exact revalidation failed.",
                cause,
              ),
            ),
          )
        : item
      if (fresh.handle !== item.handle || fresh.revision !== item.revision || fresh.id !== item.id || fresh.scope !== item.scope) {
        return yield* Effect.fail(toolError("Saved revision exact revalidation returned a different immutable identity."))
      }
      if (!fresh.admitted) {
        return yield* Effect.fail(toolError(fresh.diagnostic?.message ?? "Saved revision is not admitted."))
      }
      try {
        Revision.verify({
          source: fresh.source,
          envelope: fresh.envelope,
          expectedRevision: fresh.revision,
        })
      } catch (cause) {
        return yield* Effect.fail(
          toolError(
            cause instanceof Error ? cause.message : "Saved revision integrity verification failed.",
            cause,
          ),
        )
      }

      const snapshot = options.snapshot?.()
      if (snapshot) {
        const dependency = dependencyDiagnostic(fresh, snapshot)
        if (dependency) return yield* Effect.fail(toolError(dependency.message))
      }

      const next = prepareRevision(fresh)
      if (!next.prepared) {
        return yield* Effect.fail(toolError(next.prepareDiagnostic ?? "Saved revision cannot be prepared."))
      }
      const verified: VerifiedSaved = { item: fresh, prepared: next.prepared }
      cache.set(item.handle, verified)
      return verified
    })

  return {
    identity: Capability.savedIdentity(item.scope, item.id, item.revision),
    kind: "saved",
    description: item.manifest?.description ?? `Saved Code tool: ${item.id}`,
    inputSchema: item.envelope.inputSchema,
    ...(item.envelope.outputSchema ? { outputSchema: item.envelope.outputSchema } : {}),
    revision: item.revision,
    invokeSemantic: (args, ctx) =>
      Effect.gen(function* () {
        const verified = yield* verify(ctx)
        const current = verified.item
        const inputValidate = validator(current.envelope.inputSchema)
        const outputValidate = current.envelope.outputSchema ? validator(current.envelope.outputSchema) : undefined
        const budget = CodeExecution.budgetFrom(ctx)
        if (!budget) {
          return yield* Effect.fail(
            toolError("Saved Code capability is missing its root Code execution budget."),
          )
        }

        yield* inputValidate(args)
        // Admission + static dependency preflight happened when the frozen
        // capability snapshot was built. Permission is intentionally later.
        yield* ctx.ask({
          permission: "code",
          patterns: [pattern],
          always: [pattern],
          metadata: {
            action: "call",
            scope: item.scope,
            id: item.id,
            revision: item.revision,
          },
        })

        if (current.envelope.dependencies.length > 0 && !ctx.invokeCapability) {
          return yield* Effect.fail(toolError("Saved Code capability cannot recurse without the host capability gateway."))
        }
        const attachments: Attachment[] = []
        const result = yield* CodeMode.executePrepared(verified.prepared, {
          input: args,
          ...(ctx.invokeCapability
            ? {
                call: (ref: string, nestedArgs: unknown) =>
                  ctx.invokeCapability!(ref, nestedArgs).pipe(
                    Effect.map((nested) => programValue(nested, (attachment) => attachments.push(attachment))),
                    Effect.mapError((cause) =>
                      toolError(cause instanceof Error ? cause.message : "Nested saved capability call failed", cause),
                    ),
                  ),
              }
            : {}),
          limits: CodeExecution.HOST_LIMITS,
          budget,
        })

        if (!result.ok) {
          return yield* Effect.fail(
            toolError(`Saved Code execution failed [${result.error.kind}]: ${result.error.message}`),
          )
        }
        if (outputValidate) yield* outputValidate(result.value)

        return {
          title: current.manifest?.description ?? current.id,
          metadata: {
            scope: current.scope,
            id: current.id,
            revision: current.revision,
            calls: result.toolCalls.length,
            ...(result.truncated ? { truncated: true } : {}),
          },
          output: outputText(result.value),
          data: result.value,
          ...(attachments.length > 0 ? { attachments } : {}),
        } satisfies Tool.ExecuteResult
      }),
    authorize: ({ authority, context }) => {
      const policy = Permission.evaluate("code", pattern, authority.ruleset)
      if (policy.action === "deny") return Effect.fail(new PermissionV1.DeniedError({ ruleset: [policy] }))
      if (!item.admitted) return Effect.fail(new Error(item.diagnostic?.message ?? "Saved revision is not admitted."))
      if (!initial.prepared) return Effect.fail(new Error(initial.prepareDiagnostic ?? "Saved revision cannot be prepared."))
      if (!options.resolveExact) return Effect.void
      if (!context) return Effect.fail(toolError("Saved revision exact revalidation requires a root capability context."))
      return verify(context).pipe(Effect.asVoid)
    },
    authorityBinding: authorityBinding(item),
    // Saved Code is a delegator/composition frame. Workspace mutation belongs
    // to the concrete descendant capability that actually mutates, so marking
    // the saved parent itself would force Snapshot ordering even for pure reads.
    classifyWorkspaceMutation: () => false,
    codeCallable: item.admitted && initial.prepared !== undefined,
    lifetime: "inline",
    ...(!item.admitted || !initial.prepared
      ? {
          diagnostic: {
            kind: "SavedToolDirty",
            message: item.diagnostic?.message ?? initial.prepareDiagnostic ?? "Saved revision is not callable.",
          },
        }
      : {}),
  }
}

function dependencyDiagnostic(
  item: LoadedRevision,
  byRef: ReadonlyMap<string, Capability.Registration>,
): Capability.Registration["diagnostic"] {
  for (const dependency of item.envelope.dependencies) {
    const registration = byRef.get(dependency.ref)
    if (!registration || !registration.codeCallable) {
      return {
        kind: "DependencyContractChanged",
        message: `Saved dependency is unavailable or not callable: ${dependency.ref}`,
      }
    }
    const actual = Revision.executionContract(registration)
    if (
      actual !== dependency.executionContract ||
      registration.authorityBinding !== dependency.authorityBinding
    ) {
      return {
        kind: "DependencyContractChanged",
        message: `Saved dependency execution contract changed: ${dependency.ref}`,
      }
    }
    if (dependency.pinnedHandle && dependency.pinnedHandle !== registration.identity.ref) {
      return {
        kind: "DependencyContractChanged",
        message: `Pinned saved dependency identity changed: ${dependency.ref}`,
      }
    }
  }
  return undefined
}

/**
 * Build saved registrations against one frozen root inventory.
 *
 * Dependency contracts are checked once, then non-callability propagates
 * through reverse saved-dependency edges in O(saved + edges). Cycles whose
 * contracts are otherwise valid remain callable here and are rejected
 * dynamically by the gateway if a concrete execution traverses the cycle.
 */
export function registrations(
  items: readonly LoadedRevision[],
  base: readonly Capability.Registration[],
  options: Omit<RegistrationOptions, "snapshot"> = {},
): readonly Capability.Registration[] {
  const artifacts = new Map(items.map((item) => [item.handle, item]))
  let byRef: ReadonlyMap<string, Capability.Registration> = new Map(base.map((entry) => [entry.identity.ref, entry]))
  const saved = items.map((item) =>
    baseRegistration(item, {
      ...options,
      snapshot: () => byRef,
    }),
  )
  byRef = new Map([...base, ...saved].map((entry) => [entry.identity.ref, entry]))
  const diagnostics = new Map<string, Capability.Registration["diagnostic"]>()
  const dependents = new Map<string, string[]>()

  for (const registration of saved) {
    const item = artifacts.get(registration.identity.ref)!
    const inherited =
      registration.diagnostic?.kind === "SavedToolDirty" ? registration.diagnostic : undefined
    const direct = inherited ? undefined : dependencyDiagnostic(item, byRef)
    const diagnostic = inherited ?? direct
    if (diagnostic) diagnostics.set(registration.identity.ref, diagnostic)

    for (const dependency of item.envelope.dependencies) {
      if (!artifacts.has(dependency.ref)) continue
      const list = dependents.get(dependency.ref)
      if (list) list.push(registration.identity.ref)
      else dependents.set(dependency.ref, [registration.identity.ref])
    }
  }

  const queue = [...diagnostics.keys()]
  for (let index = 0; index < queue.length; index++) {
    const unavailable = queue[index]!
    for (const dependent of dependents.get(unavailable) ?? []) {
      if (diagnostics.has(dependent)) continue
      diagnostics.set(dependent, {
        kind: "DependencyContractChanged",
        message: `Saved dependency is unavailable or not callable: ${unavailable}`,
      })
      queue.push(dependent)
    }
  }

  return saved.map((registration) => {
    const item = artifacts.get(registration.identity.ref)!
    const diagnostic = diagnostics.get(registration.identity.ref)
    return {
      ...registration,
      codeCallable: item.admitted && !diagnostic,
      ...(diagnostic ? { diagnostic } : { diagnostic: undefined }),
    } satisfies Capability.Registration
  })
}
