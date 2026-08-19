// symbols fixture: declares its OWN same-name `greet` binding — different
// from src/a.ts's greet. usages of "greet" must NOT attribute this file.
export function greet(): string {
  return "local c"
}

export function localUse(): string {
  return greet()
}
