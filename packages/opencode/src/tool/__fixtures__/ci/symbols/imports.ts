// symbols fixture: aliased import — `import { greet as hi }` binds `hi`
// locally and sources `greet` from ./a. usages of "greet" should attribute
// the source; usages of "hi" the local binding.
import { greet as hi } from "./src/a"

export function aliasedUse(): string {
  return hi("aliased")
}
