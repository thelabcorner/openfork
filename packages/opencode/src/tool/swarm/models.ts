import {
  resolveModelRef,
  rankModelsForCoordinator,
  type ModelCatalogEntry,
  type ModelRef,
} from "./self-heal"

export interface ModelsInput {
  search?: string
}

export interface ModelsResult {
  title: string
  output: string
}

export function models(
  catalog: ModelCatalogEntry[],
  input: ModelsInput,
  ctx: { coordinator: { model: ModelRef } },
): ModelsResult {
  const ranked = rankModelsForCoordinator(catalog, ctx.coordinator, input.search)
  const lines: string[] = []
  const self = ctx.coordinator.model
  lines.push(
    `YOUR MODEL (use 'self' to reuse it for swarm members): ${self.providerID}/${self.modelID}`,
  )
  if (input.search) {
    lines.push(`Matching '${input.search}':`)
  } else {
    lines.push("Available models (your model ranked first):")
  }
  for (const m of ranked.slice(0, 20)) {
    const aliasNote = m.aliases?.length ? `  aliases: ${m.aliases.join(", ")}` : ""
    lines.push(`  ${m.providerID}/${m.modelID}${m.label ? `  (${m.label})` : ""}${aliasNote}`)
  }
  if (ranked.length === 0) {
    lines.push(`No model matched '${input.search}'. Use 'self' for your own model, or broaden the query.`)
  }
  lines.push("")
  lines.push("Tip: pass model: 'self' (or omit it) on swarm members to inherit your exact model automatically.")
  return {
    title: "models",
    output: lines.join("\n"),
  }
}

export function validateMemberModel(
  raw: ModelRef | string | undefined,
  ctx: { coordinator: { model: ModelRef } },
  catalog: ModelCatalogEntry[],
): ModelRef {
  return resolveModelRef(raw, ctx.coordinator, catalog)
}
