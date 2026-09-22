export const PAIR_CODE_LENGTH = 6
export const PAIR_CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ"

export function normalizePairCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, PAIR_CODE_LENGTH)
}

export function validPairCode(value: string) {
  return value.length === PAIR_CODE_LENGTH && [...value].every((char) => PAIR_CODE_ALPHABET.includes(char))
}

export function normalizeServerUrl(value: string, options?: { allowInsecureRemote?: boolean }) {
  const url = new URL(value.trim())
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Server URL must use HTTP or HTTPS")
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  if (!options?.allowInsecureRemote && url.protocol !== "https:" && !local)
    throw new Error("Remote servers must use HTTPS")
  url.username = ""
  url.password = ""
  url.hash = ""
  return url.toString().replace(/\/$/, "")
}
