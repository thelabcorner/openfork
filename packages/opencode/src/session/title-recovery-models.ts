/**
 * Order bounded title-generation recovery models without changing provider/account
 * ownership. The caller supplies only models from the original provider and
 * resolves every choice against its committed provider route before execution.
 *
 * This is a last resort after explicitly configured models and the normal
 * small-model selection. It must never expand into all configured providers.
 */
export function rankTitleRecoveryModels<
  T extends {
    readonly id: string
    readonly status: string
    readonly capabilities: { readonly toolcall: boolean }
    readonly cost: { readonly input: number; readonly output: number }
  },
>(
  models: readonly T[],
  excluded: ReadonlySet<string>,
  limit = 2,
): T[] {
  if (limit <= 0) return []
  return models
    .filter(
      (model) =>
        model.status === "active" &&
        model.capabilities.toolcall === true &&
        !excluded.has(model.id) &&
        Number.isFinite(model.cost.input) &&
        Number.isFinite(model.cost.output) &&
        model.cost.input >= 0 &&
        model.cost.output >= 0,
    )
    .sort((left, right) => {
      // A typical title request has more input than output tokens. Compare
      // prices within the *same provider*; never select another billing domain.
      const a = left.cost.input * 4 + left.cost.output
      const b = right.cost.input * 4 + right.cost.output
      return a - b || left.id.localeCompare(right.id)
    })
    .slice(0, limit)
}
