import { Schema } from "effect"
import { Effect } from "effect"

console.log("effect version:", require("effect/package.json").version)

const OPS = ["simplify", "expand", "factor"] as const

// Line 33 pattern: Schema.Literals(arrayVariable)
try {
  const s = Schema.Literals(OPS)
  console.log("Literals(array var): constructed OK")
  console.log("  'simplify' decode:", Schema.decodeUnknownSync(s)("simplify"))
  try {
    Schema.decodeUnknownSync(s)("bogus")
    console.log("  'bogus' decode: accepted?!")
  } catch {
    console.log("  'bogus' decode: rejected (good)")
  }
} catch (e: any) {
  console.log("Literals(array var): CONSTRUCT CRASH:", e.message)
}

// Line 46 pattern: Schema.Literals(["+", "-"])
try {
  const s = Schema.Literals(["+", "-"])
  console.log("Literals(array literal): constructed OK")
  console.log("  '+' decode:", Schema.decodeUnknownSync(s)("+"))
  try {
    Schema.decodeUnknownSync(s)("*")
    console.log("  '*' decode: accepted?!")
  } catch {
    console.log("  '*' decode: rejected (good)")
  }
} catch (e: any) {
  console.log("Literals(array literal): CONSTRUCT CRASH:", e.message)
}

// Variadic form for comparison
try {
  const s = Schema.Literals(["a", "b"])
  console.log("Literals(variadic): constructed OK")
} catch (e: any) {
  console.log("Literals(variadic): CONSTRUCT CRASH:", e.message)
}

// Can we actually decode Parameters from sympy.ts? Import it directly.
try {
  const { SympyTool } = await import("./src/tool/sympy")
  console.log("SympyTool import: OK")
  const { Parameters } = await import("./src/tool/sympy")
  const p = Schema.decodeUnknownSync(Parameters)({ expr: "sqrt(8)" })
  console.log("Parameters decode:", JSON.stringify(p))
  const op = Schema.decodeUnknownSync(Parameters)({ expr: "x**2", operation: "factor", direction: "+" })
  console.log("with operation/direction:", JSON.stringify(op))
} catch (e: any) {
  console.log("SympyTool import CRASH:", e.message)
}
