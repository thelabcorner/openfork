import { describe, expect, test } from "bun:test"
import { parseSkillNotice } from "./skill-parse"

/**
 * Shapes taken from packages/opencode/src/tool/skill.ts — `missOutput`, the
 * "no name provided" branch, and `Skill.NotFoundError#message`.
 */
describe("parseSkillNotice", () => {
  test("splits a not-found miss into message, roster, and model hints", () => {
    const output = [
      'Skill "upstream-sync" not found. Not in local skills folders (agent-skills/, skills/, .skills/, etc.) or registered.',
      "Available: docs, review",
      'Tip: Use skill({ mode: "list" }), a normalized name, or skill({ filePath: "..." }) for a skill outside this project.',
      "",
      "Available skills (project folders + previously imported paths):",
      "- docs: Write documentation.",
      "- review: Review a diff.",
      "",
      'Use skill({ mode: "list" }) to list all.',
      'Use skill({ filePath: "C:/Users/.../Downloads/my-skill" }) to load a skill from anywhere on disk.',
    ].join("\n")

    const parsed = parseSkillNotice(output)!
    expect(parsed.message).toBe(
      'Skill "upstream-sync" not found. Not in local skills folders (agent-skills/, skills/, .skills/, etc.) or registered.',
    )
    // The roster arrives twice; the described copy wins and nothing duplicates.
    expect(parsed.items).toEqual([
      { name: "docs", description: "Write documentation." },
      { name: "review", description: "Review a diff." },
    ])
    expect(parsed.hints).toHaveLength(3)
    expect(parsed.hints.every((hint) => /^(Use |Tip: )/.test(hint))).toBe(true)
  })

  test("handles the empty roster", () => {
    const parsed = parseSkillNotice(
      "No skill name or filePath provided.\n\nAvailable skills:\n(none)\n\nUse mode:\"list\", a registered name, or filePath to a SKILL.md.",
    )!
    expect(parsed.message).toBe("No skill name or filePath provided.")
    expect(parsed.items).toEqual([])
    expect(parsed.hints).toHaveLength(1)
  })

  test("keeps an invalid-path message intact", () => {
    const parsed = parseSkillNotice(
      "No SKILL.md at ~/Downloads/thing.\n\nPass a SKILL.md file or a folder that contains one.",
    )!
    expect(parsed.message).toBe("No SKILL.md at ~/Downloads/thing.")
    expect(parsed.hints).toEqual(["Pass a SKILL.md file or a folder that contains one."])
  })

  test("returns undefined for output with nothing to show", () => {
    expect(parseSkillNotice("   \n\n  ")).toBeUndefined()
  })
})
