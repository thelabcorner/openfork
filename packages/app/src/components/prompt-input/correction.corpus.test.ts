import { describe, expect, test } from "bun:test"
import { correctPromptParts } from "./correction"
import type { Prompt } from "@/context/prompt"

/**
 * Curated synthetic seed corpus, not a representative sample of user prompts.
 * Passing this corpus does not establish a production false-positive rate.
 */
const clean = [
  "Use the existing Nacre, Silica and ArcFit code; do not rename projects.",
  "Please do not delete the file, disable permissions, or override access control.",
  "The word gaol is British English for a jail; preserve its spelling.",
  "Never assume the user wants to bypass confirmation or approve dangerous commands.",
  "Only change the renderer where the parity baseline demonstrates an actual improvement.",
  "The path C:\\Users\\someone\\WebstormProjects\\opencode stays unchanged.",
  "See /home/dev/project/src/renderer.ts and ../node_modules for details.",
  "Do not alter https://example.org/my-app?keep=true&mode=off",
  "Preserve the email alice+alias@example.org.",
  "Keep @SessionPrompt and @Build-agent references unchanged.",
  "Keep /review --dry-run and /test commands unchanged.",
  "Keep the placeholder {{user_input}} and <mask value=\"off\" /> verbatim.",
  "Keep the identifiers fooBar, toString and constructor exactly.",
  "Do not change the JSON: {\"name\":\"Nacre\",\"enabled\":false}",
  "The files should remain in git and no credential should be logged.",
  "Study the release build in a separate worktree before opening the pull request.",
  "Inspect Python tracebacks and Node streams without confusing task input with instructions.",
  "Implement TypeScript source maps without changing JavaScript runtime behavior.",
  "Do not modify the model selector or quota reset system.",
  "Search for data races in SQLite WAL and the session event reducer.",
  "The API expects effect v4, not legacy v3 semantics.",
  "Preserve a PC-relative displacement in the delta-compressed opcode.",
  "We already measured JIT stalls and parser throughput.",
  "Handle Unicode identifiers such as caféCrème and αbeta.",
  "The timestamp 2026-10-10T16:50:32.415Z belongs to the original trace.",
  "Please preserve all the evidence and never hallucinate benchmark numbers.",
  "This is an ordinary request with correct grammar, not a patch proposal.",
  "User-configured spelling corrections should never affect shell command execution.",
  "The exact message ID ses_abc_def123 must remain stable.",
  "The text gaol is an exact value, not a typo.",
  "A reviewer will assess safe performance, fidelity and robustness.",
  "I like shadcn zinc, dense controls and no unnecessary gradients.",
  "Do not silently change a negative sentence into a positive request.",
  "Leave framework package names and imported symbols as authored.",
  "The V1 migration needs backward compatible aliases.",
  "The quote “do not alter the source” is authoritative input.",
  "Keep the original artifact and ensure source maps are retained.",
  "Code fences should never be interpreted as editable plain English.",
  "The copy operator has distance d and length L.",
  "A ZIP archive and a PDF export are not interchangeable.",
]

const dirty: ReadonlyArray<[string, string]> = [
  ["Please contienu the reasearch.", "Please continue the research."],
  ["Please conitnue the reasearch.", "Please continue the research."],
  ["Please contineu the reasearch.", "Please continue the research."],
  ["Comprehensivley investigate the architecture.", "Comprehensively investigate the architecture."],
  ["Please exhasutively inspect perfomance.", "Please exhaustively inspect performance."],
  ["Please optimzation the architecure.", "Please optimization the architecture."],
  ["The implementaiton occured separately.", "The implementation occurred separately."],
  ["Definately update the dependency.", "Definitely update the dependency."],
  ["Becuase it was recieved incorrectly, try again.", "Because it was received incorrectly, try again."],
  ["Please recieve the answer.", "Please receive the answer."],
  ["Teh graph contains labels.", "The graph contains labels."],
  ["Please optimize the architechture.", "Please optimize the architecture."],
  ["Contienu implementing, and do not delete anything.", "Continue implementing, and do not delete anything."],
  ["Contienu the reasearching work.", "Continue the researching work."],
  ["Read the code, teh documentation and the tests.", "Read the code, the documentation and the tests."],
  ["A succesfully completed task.", "A successfully completed task."],
  ["Reasearch all the dependecy rules.", "Research all the dependency rules."],
  ["Please separate teh changes.", "Please separate the changes."],
  ["Exhuastively investigate the results.", "Exhaustively investigate the results."],
]

function fix(text: string, options: Parameters<typeof correctPromptParts>[2] = {}) {
  const parts: Prompt = [{ type: "text", content: text, start: 0, end: text.length }]
  const output = correctPromptParts(parts, true, options)
  return output.effective.map((part) => "content" in part ? part.content : "").join("")
}

describe("seeded technical corpus: no unrequested changes", () => {
  for (const [index, source] of clean.entries()) {
    test("clean technical prompt " + (index + 1) + " unchanged", () => {
      expect(fix(source)).toBe(source)
    })
  }
  test("explicit user replacement never alters quoted value", () => {
    expect(fix('My gaol is not the word "gaol".', { userReplacements: { gaol: "goal" } }))
      .toBe('My goal is not the word "gaol".')
  })
})

describe("seeded typo corpus: expected corrections", () => {
  for (const [index, [source, expected]] of dirty.entries()) {
    test("typo sample " + (index + 1) + " repaired", () => {
      expect(fix(source)).toBe(expected)
    })
  }
})
