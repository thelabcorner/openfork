const ALWAYS_DEBUGGER_OPERATIONS = new Set([
  "snapshot",
  "screenshot",
  "click",
  "type",
  "press",
  "scroll",
  "evaluate",
  "resize",
  "set_appearance",
])

const VISUAL_OPERATIONS = new Set(["visual_capture", "visual_diff", "visual_record"])

/**
 * Keep Chrome's debugger attachment lazy. SnapEye itself runs through the
 * isolated content world and needs no CDP, but OpenCode-native element targets
 * (snapshot refs / locators / coordinates) are canonicalized with the shared
 * Runtime.evaluate resolver before SnapEye starts.
 */
export function operationNeedsDebugger(name: string, input: unknown): boolean {
  if (ALWAYS_DEBUGGER_OPERATIONS.has(name)) return true
  if (!VISUAL_OPERATIONS.has(name) || !input || typeof input !== "object") return false
  const target = (input as { target?: unknown }).target
  return !!target && typeof target === "object" && (target as { kind?: unknown }).kind === "element"
}

