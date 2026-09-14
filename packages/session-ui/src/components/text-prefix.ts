/**
 * Exact append/prefix check for hot streaming paths.
 *
 * `String#startsWith(previous)` eagerly walks a growing prefix in current
 * Chromium/V8 and JavaScriptCore builds. Repeating that for token-sized updates
 * turns a safety proof into quadratic host work. `slice(... ) === previous`
 * preserves exact semantics while letting engines reuse substring/rope storage
 * before equality comparison, which is substantially cheaper for the strings
 * produced by our append-only stream reducers.
 */
export function hasTextPrefix(text: string, previous: string) {
  return text.length >= previous.length && text.slice(0, previous.length) === previous
}
