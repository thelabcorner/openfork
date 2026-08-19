import { Effect } from "effect"
import { Schema } from "effect"
import z from "zod"
import path from "path"
import type { JSONSchema7, JSONSchema7Definition } from "@ai-sdk/provider"
import type { Hooks, ToolContext as PluginToolContext, ToolDefinition } from "@opencode-ai/plugin"
import type * as Tool from "./tool"
import { Agent } from "@/agent/agent"
import { Truncate } from "@/tool/truncate"
import { EffectBridge } from "@/effect/bridge"
import { Glob } from "@opencode-ai/core/util/glob"
import { loadToolModule } from "./import"

export type CustomToolDeps = {
  agent: Agent.Interface
  truncate: Truncate.Interface
  directory: string
  worktree: string
}

/**
 * Convert a plugin/custom-tool definition into a registry `Tool.Def`.
 *
 * Agent/Truncate and the instance directory/worktree are captured at BUILD time
 * (the caller — registry state build or ToolReload — resolves them from its own
 * instance scope), so the resulting execute closure has no Effect requirements,
 * matching `Tool.Def.execute`. The Zod → Effect Schema + JSON Schema conversion
 * below is byte-for-byte the legacy registry conversion (#27451, #27630
 * tolerance included): do not change it independently of a regression test.
 */
export function fromPlugin(id: string, def: ToolDefinition, deps: CustomToolDeps): Tool.Def {
  // Plugin tools still expose Zod args publicly; keep that compatibility
  // boxed at the registry boundary and give the LLM the original JSON Schema.
  // Normalize missing args to `{}` once — pre-1.14.49 the code was
  // `z.object(def.args)` and Zod silently tolerated undefined (#27451, #27630).
  const args = def.args ?? {}
  const entries = Object.entries(args)
  const allZod = entries.every((entry) => isZodType(entry[1]))
  const zodParams = allZod ? z.object(args) : undefined
  const jsonSchema = zodParams ? zodJsonSchema(zodParams) : legacyJsonSchema(entries)
  const parameters = zodParams
    ? Schema.declare<unknown>((u): u is unknown => zodParams.safeParse(u).success)
    : Schema.Unknown
  return {
    id,
    parameters,
    jsonSchema,
    description: def.description,
    execute: (args, toolCtx) =>
      Effect.gen(function* () {
        // Bridge the host's Effect-based `ask` into a Promise-returning
        // function for the plugin to make sure context persists
        const bridge = yield* EffectBridge.make()
        const pluginCtx: PluginToolContext = {
          ...toolCtx,
          ask: (req) => bridge.promise(toolCtx.ask(req)),
          directory: deps.directory,
          worktree: deps.worktree,
        }
        const result = yield* Effect.promise(() => def.execute(args as any, pluginCtx))
        const output = typeof result === "string" ? result : result.output
        const metadata = typeof result === "string" ? {} : (result.metadata ?? {})
        const attachments = typeof result === "string" ? undefined : result.attachments
        const info = yield* deps.agent.get(toolCtx.agent)
        const out = yield* deps.truncate.output(output, {}, info)
        return {
          title: typeof result === "string" ? "" : (result.title ?? ""),
          output: out.truncated ? out.content : output,
          attachments,
          metadata: {
            ...metadata,
            truncated: out.truncated,
            ...(out.truncated && { outputPath: out.outputPath }),
          },
        }
      }).pipe(
        Effect.withSpan("Tool.execute", {
          attributes: {
            "tool.name": id,
            "session.id": toolCtx.sessionID,
            "message.id": toolCtx.messageID,
            ...(toolCtx.callID ? { "tool.call_id": toolCtx.callID } : {}),
          },
        }),
      ),
  }
}

/**
 * Build the custom tool slice for a set of config directories: file-based tools
 * from `{tool,tools}/*.{js,ts}` plus plugin-provided tools, both converted via
 * `fromPlugin`. File modules are loaded with `loadToolModule` (fresh re-import
 * per call — see ./import.ts), so the result reflects the current disk state
 * even when a prior load of the same file is already cached.
 */
export function buildCustomTools(
  dirs: string[],
  plugins: readonly Hooks[],
  deps: CustomToolDeps & { waitForDependencies: () => Effect.Effect<void> },
): Effect.Effect<Tool.Def[], never> {
  return Effect.gen(function* () {
    const custom: Tool.Def[] = []
    const matches = dirs.flatMap((dir) =>
      Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
    )
    if (matches.length) yield* deps.waitForDependencies()
    for (const match of matches) {
      const namespace = path.basename(match, path.extname(match))
      // `match` is an absolute filesystem path from `Glob.scanSync(..., { absolute: true })`.
      // `loadToolModule` re-reads and bundles it in-memory so the content-unique
      // data:/blob: URL yields a fresh module (Bun caches by pathname otherwise).
      const mod = yield* Effect.promise(() => loadToolModule(match))
      for (const [id, def] of Object.entries(mod)) {
        if (!isPluginTool(def)) continue
        custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def, deps))
      }
    }

    for (const p of plugins) {
      for (const [id, def] of Object.entries(p.tool ?? {})) {
        custom.push(fromPlugin(id, def, deps))
      }
    }

    return custom
  })
}

export function isPluginTool(value: unknown): value is ToolDefinition {
  return typeof value === "object" && value !== null && "args" in value && "description" in value && "execute" in value
}

function isZodType(value: unknown): value is z.ZodType {
  return typeof value === "object" && value !== null && "_zod" in value
}

function isJsonSchemaDefinition(value: unknown): value is JSONSchema7Definition {
  return typeof value === "boolean" || (typeof value === "object" && value !== null && !Array.isArray(value))
}

function legacyJsonSchema(entries: [string, unknown][]): JSONSchema7 {
  const properties = Object.fromEntries(
    entries.filter((entry): entry is [string, JSONSchema7Definition] => isJsonSchemaDefinition(entry[1])),
  )
  return {
    type: "object",
    properties,
    required: Object.keys(properties),
  }
}

function zodJsonSchema(schema: z.ZodType): JSONSchema7 {
  const result = normalizeZodJsonSchema(z.toJSONSchema(schema, { io: "input", metadata: zodMetadataRegistry(schema) }))
  if (!isJsonSchemaObject(result)) throw new Error("plugin tool Zod schema produced a non-object JSON Schema")
  const { $defs, ...rest } = result
  return (
    $defs && isJsonSchemaObject($defs) ? { ...rest, definitions: $defs as JSONSchema7["definitions"] } : rest
  ) as JSONSchema7
}

function zodMetadataRegistry(schema: z.ZodType) {
  const registry = z.registry<Record<string, unknown>>()
  const seen = new WeakSet<object>()
  const collect = (value: unknown) => {
    if (typeof value !== "object" || value === null) return
    if (seen.has(value)) return
    seen.add(value)

    if (isZodType(value)) {
      const metadata = typeof value.meta === "function" ? value.meta() : undefined
      const description = typeof value.description === "string" ? value.description : undefined
      const merged = {
        ...(metadata && typeof metadata === "object" ? metadata : {}),
        ...(description ? { description } : {}),
      }
      if (Object.keys(merged).length) registry.add(value, merged)
      collect(value._zod.def)
      return
    }

    for (const item of Object.values(value)) collect(item)
  }
  collect(schema)
  return registry
}

function normalizeZodJsonSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => normalizeZodJsonSchema(item))
  if (typeof value !== "object" || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) =>
        (entry[0] === "exclusiveMaximum" || entry[0] === "exclusiveMinimum") && typeof entry[1] === "boolean"
          ? false
          : true,
      )
      .map(([key, item]) => [key, normalizeZodJsonSchema(item)]),
  )
}

function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export * as ToolCustom from "./custom"
