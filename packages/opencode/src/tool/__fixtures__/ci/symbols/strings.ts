// symbols fixture: name appears in a string and a comment — must yield 0 refs
export const message = "greet is a verb"
// greet appears here in a comment too

export function unrelated(): string {
  return "no greet here"
}
