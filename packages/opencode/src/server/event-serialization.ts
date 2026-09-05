const frames = new WeakMap<object, string>()
const legacy = new WeakMap<object, { id: string; type: string; properties: unknown }>()

// Object identity prevents ID collisions across representations. Weak keys
// avoid retaining megabytes of old tool output after subscribers release it.
export function serializeLegacyEvent(event: object): string {
  const cached = frames.get(event)
  if (cached !== undefined) return cached
  const frame = JSON.stringify(event)
  frames.set(event, frame)
  return frame
}

export function adaptLegacyEvent(event: { id: string; type: string; data: unknown }) {
  const cached = legacy.get(event)
  if (cached) return cached
  const value = { id: event.id, type: event.type, properties: event.data }
  legacy.set(event, value)
  return value
}
