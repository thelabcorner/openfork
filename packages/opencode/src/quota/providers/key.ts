import { Effect, Option } from "effect"
import type { Auth } from "@/auth"

function authKeyFor(info: Auth.Info): string | undefined {
  if (info.type === "api") return info.key
  if (info.type === "oauth") return info.access
  if (info.type === "wellknown") return info.token
  return undefined
}

/**
 * Resolves the first usable bearer key among auth.json alias entries,
 * mirroring OpenChamber's normalizeAuthEntry key/token fallback: api key,
 * oauth access token, or wellknown token, in that order per entry.
 */
export const authKey = (auth: Auth.Interface, aliases: readonly string[]) =>
  Effect.gen(function* () {
    for (const alias of aliases) {
      const result = yield* Effect.option(auth.get(alias))
      const info = Option.getOrUndefined(result)
      if (info === undefined) continue
      const key = authKeyFor(info)
      if (key !== undefined && key !== "") return { id: alias, key }
    }
    return undefined
  })
