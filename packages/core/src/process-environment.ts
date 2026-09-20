/**
 * Merge child-process environment maps with the target host's key semantics.
 *
 * JavaScript object keys are case-sensitive; Windows environment names are not.
 * Passing duplicate logical names (for example PATH + Path) through CreateProcess
 * makes the first entry observable, which defeats ordinary "{ ...base, ...override }"
 * expectations. Canonicalize once so explicit overrides actually win.
 */
export function merge(
  base: NodeJS.ProcessEnv | undefined,
  overrides: NodeJS.ProcessEnv | undefined = undefined,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  if (platform !== "win32") {
    if (base) {
      for (const [key, value] of Object.entries(base)) env[key] = value
    }
    if (overrides) {
      for (const [key, value] of Object.entries(overrides)) env[key] = value
    }
    return env
  }

  const casing = new Map<string, string>()
  if (base) {
    for (const [key, value] of Object.entries(base)) {
      const normalized = key.toLowerCase()
      // Match the actual Windows process boundary for an already-ambiguous
      // input map: the first logical entry is the observable inherited value.
      if (casing.has(normalized)) continue
      casing.set(normalized, key)
      env[key] = value
    }
  }

  if (!overrides) return env
  for (const [key, value] of Object.entries(overrides)) {
    const normalized = key.toLowerCase()
    const prior = casing.get(normalized)
    if (prior !== undefined) delete env[prior]
    casing.set(normalized, key)
    env[key] = value
  }
  return env
}
