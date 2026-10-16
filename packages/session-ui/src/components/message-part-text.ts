export function readPartText(
  accum: Record<string, string> | undefined,
  part: { id: string; text?: string },
  streaming = false,
): string {
  const raw = accum?.[part.id] ?? part.text ?? ""
  // A live trailing space/newline is authoritative source still arriving.
  // Trimming it makes subsequent tokens appear to rewrite the displayed text.
  return streaming ? raw : raw.trim()
}
