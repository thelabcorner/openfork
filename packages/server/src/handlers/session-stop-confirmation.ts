/** Pure generation-fence verification for current-protocol Session Stop. */
export function stopLeftObservedGenerationOwned(
  before: { readonly ownerID?: string | null; readonly generation: number },
  after: { readonly ownerID?: string | null; readonly generation: number },
) {
  return !!before.ownerID &&
    after.ownerID === before.ownerID &&
    after.generation === before.generation
}
