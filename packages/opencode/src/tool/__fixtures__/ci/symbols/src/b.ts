// symbols fixture: imports the symbols from ./a and uses them (design §11)
import { greet, Greeter } from "./a"

export function useGreet(): string {
  return greet("b")
}

export function makeGreeter(): Greeter {
  return new Greeter("b")
}
