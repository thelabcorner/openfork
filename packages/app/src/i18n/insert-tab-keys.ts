// Inserts the tab-ui session-state / regenerate-title i18n keys into every app
// locale, anchored on keys the parity test guarantees to exist. Translations are
// per-locale (consistent with existing session/stop/close terminology).
import { readdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

const dir = import.meta.dir
const skip = new Set([
  "en.ts",
  "parity.test.ts",
  "desktop-native.ts",
  "desktop-native.test.ts",
  "insert-tab-keys.ts",
  "translations-tab-ui.ts",
])

// key -> { anchor, insertAfter }
const groups = [
  {
    // command.session.stop/.pause/.resume/.regenerateTitle — after compact.description
    anchor: `"command.session.compact.description"`,
  "command.session.stop": "Stop session",
  "command.session.stop.description": "Stop the current response and cancel pending work",
  "command.session.pause": "Pause session",
  "command.session.pause.description": "Pause this session to continue it later",
  "command.session.resume": "Resume session",
  "command.session.resume.description": "Continue the paused session",
  "command.session.regenerateTitle": "Regenerate session title",
  "command.session.regenerateTitle.description": "Generate a new title from this session's conversation",
  "command.session.regenerateTitle.pending": "Generating title…",
    keys: [
      ["command.session.stop", "Stop session"],
      ["command.session.stop.description", "Stop the current response and cancel pending work"],
      ["command.session.pause", "Pause session"],
      ["command.session.pause.description", "Pause this session to continue it later"],
      ["command.session.resume", "Resume session"],
      ["command.session.resume.description", "Continue the paused session"],
      ["command.session.regenerateTitle", "Regenerate session title"],
      ["command.session.regenerateTitle.description", "Generate a new title from this session's conversation"],
      ["command.session.regenerateTitle.pending", "Generating title…"],
    ],
  },
  {
    anchor: `"prompt.action.stop"`,
  "prompt.action.paused": "Paused — will run on resume",
    keys: [["prompt.action.paused", "Paused — will run on resume"]],
  },
  {
    anchor: `"common.closeTab"`,
  "common.stopSession": "Stop session",
  "common.pauseSession": "Pause session",
  "common.resumeSession": "Resume session",
    keys: [
      ["common.stopSession", "Stop session"],
      ["common.pauseSession", "Pause session"],
      ["common.resumeSession", "Resume session"],
    ],
  },
  {
    anchor: `"titlebar.updateVersion"`,
  "tab.state.working": "Working",
  "tab.state.paused": "Paused",
    keys: [
      ["tab.state.working", "Working"],
      ["tab.state.paused", "Paused"],
    ],
  },
]

// Per-locale translations for each key, keyed by locale name.
// Structure: translations[locale][key] = copy. Falls back to English if missing
// (parity only requires key presence; English fallback is the documented interim).
import("./translations-tab-ui.ts").then(async ({ translations }) => {
  const files = (await readdir(dir)).filter((file) => file.endsWith(".ts") && !skip.has(file))
  let changed = 0
  for (const file of files) {
    const locale = file.slice(0, -3)
    const path = join(dir, file)
    let source = await readFile(path, "utf8")
    const t = translations[locale] ?? {}
    for (const group of groups) {
      const anchorLine = source.split("\n").find((line) => line.includes(group.anchor))
      if (!anchorLine) throw new Error(`${file}: anchor ${group.anchor} not found`)
      const lines = source.split("\n")
      const index = lines.findIndex((line) => line.includes(group.anchor))
      const insert = group.keys
        .map(([key, en]) => `  "${key}": ${JSON.stringify(t[key] ?? en)},`)
      lines.splice(index + 1, 0, ...insert)
      source = lines.join("\n")
    }
    await writeFile(path, source)
    changed++
  }
  console.log(`updated ${changed} locale files`)
})
