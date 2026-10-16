/**
 * Convert an internal provider/transport exception into a safe, user-facing
 * title-generation explanation. Never return the original provider message:
 * it can contain request bodies, endpoints, or credentials.
 *
 * Provider/model identities (`provider/model`) are safe to surface and are
 * preserved so the toast names the failing model instead of forcing the user
 * to guess which selection broke.
 */
const MODEL_REF_PATTERN = /\b([a-z0-9][a-z0-9_-]*\/[a-z0-9][a-z0-9._:-]*[a-z0-9])\b/gi

function extractModelRef(raw: string): string | undefined {
  const lowered = raw.toLowerCase()
  const seen: string[] = []
  MODEL_REF_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = MODEL_REF_PATTERN.exec(raw)) !== null && seen.length < 2) {
    const token = match[1] ?? ""
    if (token.length === 0 || token.length > 80) continue
    const at = match.index ?? 0
    const context = lowered.slice(Math.max(0, at - 24), at)
    if (!/model|provider|route|title/.test(context)) continue
    if (!seen.includes(token)) seen.push(token)
  }
  MODEL_REF_PATTERN.lastIndex = 0
  return seen.length > 0 ? seen.join(", ") : undefined
}

export function titleFailureMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const message = raw.toLowerCase()
  const modelRef = extractModelRef(raw)
  const modelSuffix = modelRef ? ` (${modelRef})` : ""
  if (/timed?\s*out|timeout|deadline exceeded/.test(message))
    return "Title generation timed out. Try the model again or choose another one."
  if (/rate.?limit|too many requests|\b429\b|quota|usage limit|insufficient.?credits/.test(message))
    return "The title model hit a rate or usage limit. Wait for the limit to reset or choose another model."
  if (/invalid.?api.?key|unauthori[sz]ed|authentication|permission denied|\b401\b|\b403\b|credential expired/.test(message))
    return "The title model's provider/account authentication was rejected. Check its connection or choose another model."
  if (/tool.?call|tool_choice|generated_title|function.?call|structured.?output/.test(message))
    return `The title model${modelSuffix} could not complete the required structured title call. Choose a tool-capable model.`
  if (/model.*unavailab|no model|model.*not found|route.*unavailab|no.*route|no.*provider|account.*not.*serv|not.*eligible/.test(message))
    return `The selected title model${modelSuffix} is unavailable through the current provider/account route. Choose another model or account.`
  if (/fetch failed|econnreset|econnrefused|network|connection reset|\b502\b|\b503\b/.test(message))
    return "The title provider could not be reached. Check connectivity or try another model."
  return "The title model could not complete the request. Choose another model or retry."
}