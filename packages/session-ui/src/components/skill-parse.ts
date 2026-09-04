export type SkillListItem = { name: string; description: string; score?: string }

/**
 * Everything the tool emits that is neither a loaded skill nor a `<skills>`
 * block: "not found", "no name provided", "path failed". All three are prose,
 * optionally followed by an `Available skills:` roster and one or more
 * `Use skill({...})` lines written for the model. Rendering that as markdown
 * produced a wall of unstyled text, which is what it looked like before.
 */
const SKILL_HINT = /^(Use |Tip: |Pass |Relative paths )/
/** `Available skills (project folders + …):` — a heading; the roster follows. */
const SKILL_ROSTER = /^Available(\s+skills)?\b[^:]*:\s*$/i
/** `Available: a, b, c` — the roster is inline on the same line. */
const SKILL_ROSTER_INLINE = /^Available(\s+skills)?\b[^:]*:\s*(\S.*)$/i

export function parseSkillNotice(output: string) {
  const lines = output.split("\n")
  const message: string[] = []
  const hints: string[] = []
  const items: SkillListItem[] = []
  let inRoster = false

  for (const raw of lines) {
    const line = raw.trim()
    if (SKILL_ROSTER.test(line)) {
      inRoster = true
      continue
    }
    const inline = SKILL_ROSTER_INLINE.exec(line)
    if (inline) {
      for (const name of inline[2]!.split(",")) {
        const trimmed = name.trim()
        if (trimmed && trimmed !== "(none)") items.push({ name: trimmed, description: "" })
      }
      continue
    }
    if (SKILL_HINT.test(line)) {
      hints.push(line)
      inRoster = false
      continue
    }
    const entry = /^-\s*([^:]+):\s*(.*)$/.exec(line)
    if (entry) {
      items.push({ name: entry[1]!.trim(), description: entry[2]!.trim() })
      continue
    }
    if (!line) {
      inRoster = false
      continue
    }
    if (line === "(none)") continue
    if (inRoster) continue
    message.push(line)
  }

  if (!message.length && !items.length) return undefined

  // The roster can arrive twice — inline in the error message and again under
  // the heading. Keep the described copy.
  const unique = new Map<string, SkillListItem>()
  for (const item of items) {
    const existing = unique.get(item.name)
    if (!existing || (!existing.description && item.description)) unique.set(item.name, item)
  }

  return { message: message.join(" "), items: [...unique.values()], hints }
}
