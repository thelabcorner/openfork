/**
 * Local smoke probe for the bundled offline Harper engine.
 * Run from repository root: bun packages/app/benchmarks/harper-smoke.ts
 * Never accesses a provider, network grammar service, or authored user drafts.
 */
import { LocalLinter } from "harper.js"
import { binaryInlined as binary } from "harper.js/binaryInlined"

const linter = new LocalLinter({ binary })
try {
  for (const text of [
    "This is a example of a application.",
    "I has a book. I has a book.",
    "The the quick brown fox jumps.",
    "Please contienu the reasearch.",
  ]) {
    const issues = await linter.lint(text)
    console.log(JSON.stringify({
      text,
      issues: issues.map((issue) => ({
        start: issue.span().start, end: issue.span().end,
        category: issue.lint_kind(),
        message: issue.message(),
        suggestions: issue.suggestions().slice(0, 3).map((s) => s.get_replacement_text()),
      })),
    }))
  }
} finally {
  await linter.dispose()
}
