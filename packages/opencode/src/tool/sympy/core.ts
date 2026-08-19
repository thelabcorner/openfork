// Pure helpers for the `sympy` tool — no Effect, no Python. Unit-testable in
// isolation (the live Python parts live in sympy.ts).

export const OPERATIONS = [
  "simplify",
  "expand",
  "factor",
  "solve",
  "diff",
  "integrate",
  "limit",
  "series",
  "evalf",
  "nroots",
  "factorint",
  "primefactors",
  "gcd",
  "lcm",
  "apart",
  "together",
  "trigsimp",
  "cancel",
] as const
export type Operation = (typeof OPERATIONS)[number]

export const TIME_LIMIT_DEFAULT_MS = 15_000
export const TIME_LIMIT_MAX_MS = 60_000
export const OUTPUT_CAP_BYTES = 120_000
export const RESULT_CAP_BYTES = 60_000

// Operations that accept extra positional params. `required` params must be
// present or the build fails with the hint. `optional` params have defaults.
const EXTRA_PARAMS: Record<
  string,
  { required?: Array<"variable" | "point">; optional?: Array<"variable" | "point" | "direction" | "order" | "precision">; hint: string }
> = {
  limit: {
    required: ["point"],
    optional: ["variable", "direction"],
    hint: "limit requires `point` (the value the variable approaches, e.g. 0, oo, -oo). Example: expr='sin(x)/x', operation='limit', point=0.",
  },
  series: {
    optional: ["variable", "point", "order"],
    hint: "series accepts optional point (default 0) and order (default 6). Example: expr='sin(x)', operation='series', order=6.",
  },
  evalf: {
    optional: ["precision"],
    hint: "evalf accepts optional precision (digits, default 15). Example: expr='sqrt(2)', operation='evalf', precision=30.",
  },
  nroots: {
    optional: ["precision"],
    hint: "nroots accepts optional precision (digits, default 15). Example: expr='x**4 - 1', operation='nroots', precision=6.",
  },
  solve: {
    optional: ["variable"],
    hint: "solve accepts an optional variable (default: the first free symbol). Example: expr='x**2 - 4', operation='solve'.",
  },
  diff: {
    optional: ["variable", "order"],
    hint: "diff accepts optional variable (default: first free symbol) and order (default 1). Example: expr='sin(x)*cos(x)', operation='diff'.",
  },
  integrate: {
    optional: ["variable"],
    hint: "integrate accepts an optional variable (default: first free symbol). Indefinite only on the structured path; use the code path for definite integrals.",
  },
}

export type BuildResult =
  | { ok: true; code: string; kind: "expr" | "code"; display: string }
  | { ok: false; error: string }

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

// Heuristic: is the expression composed only of known sympy function/constant
// names (sqrt, sin, pi, oo, ...) plus numbers/operators — i.e. no user
// variables? Used to allow symbol-less constant expressions through the
// no-free-symbols guard.
export function isConstantLike(expr: string): boolean {
  const tokens = expr.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []
  if (tokens.length === 0) return true
  const KNOWN = new Set([
    "sqrt", "cbrt", "root", "sin", "cos", "tan", "cot", "sec", "csc",
    "asin", "acos", "atan", "acot", "asec", "acsc", "atan2",
    "sinh", "cosh", "tanh", "asinh", "acosh", "atanh",
    "exp", "log", "ln", "LambertW",
    "pi", "oo", "infinity", "E", "I", "numpy", "nan", "zoo",
    "sign", "Abs", "abs", "floor", "ceiling", "frac",
    "gamma", "factorial", "binomial", "PolyGamma", "Zeta", "zeta",
    "gcd", "lcm", "Mod", "Integer", "Rational", "Float", "Number",
    "Symbol", "symbols", "simplify", "expand", "factor", "solve", "diff",
    "integrate", "limit", "series", "evalf", "nroots", "print", "sstr",
    "True", "False", "None", "Matrix", "eye", "zeros", "ones", "transpose",
  ])
  return tokens.every((t) => KNOWN.has(t))
}

// Split a symbols string ("x y" / "a b c" / "x, y") into clean identifiers.
export function parseSymbols(symbols: string | undefined): string[] {
  if (!symbols) return []
  return symbols
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => SAFE_IDENT.test(s))
}

// Heuristic auto-detection of free symbols from an expression string.
// Conservative: only standalone single letters are candidates, excluding
// e/i/o (Euler's / imaginary unit / Landau order) and letters that look like
// they belong to a longer identifier (`sin`, `pi`, ... are multi-letter, so a
// single-letter token boundary check keeps them out).
export function detectSymbols(expr: string): string[] {
  const found = new Set<string>()
  const re = /(^|[^A-Za-z0-9_.])([A-Za-z])(?=$|[^A-Za-z0-9_])/g
  let match: RegExpExecArray | null
  while ((match = re.exec(expr)) !== null) {
    if (match[1] === "." || match[1] === "_") continue
    found.add(match[2]!)
  }
  const banned = new Set(["e", "i", "o", "E", "I", "O"])
  return [...found]
    .filter((s) => !banned.has(s))
    .toSorted((a, b) => a.localeCompare(b))
}

// Build the Python source for a structured (expr + operation) call.
// The variable default is the FIRST detected symbol, never a hardcoded `x`,
// so expr='y**2' differentiates correctly.
export function buildExprCall(input: {
  expr: string
  operation?: Operation | (string & {})
  symbols?: string[]
  variable?: string
  point?: string
  direction?: string
  order?: number
  precision?: number
}): BuildResult {
  const expr = input.expr.trim()
  if (!expr) return { ok: false, error: "expr is required for the structured path." }
  // An empty explicit list falls back to auto-detection (parseSymbols can
  // legitimately return [] when the user passed nothing or junk).
  const auto = detectSymbols(expr)
  const symbols = input.symbols && input.symbols.length > 0 ? input.symbols : auto
  // Constant/function-only expressions (sqrt(8), sin(pi/4), 2+2) have no free
  // symbols and are valid — sympy handles them with no declared symbols. Only
  // reject when the expression uses variable-like tokens we failed to detect.
  if (symbols.length === 0 && !isConstantLike(expr)) {
    return {
      ok: false,
      error: `No free symbols detected in "${expr}". Provide an explicit symbols string (e.g. symbols="x y") if the expression uses variables.`,
    }
  }
  const op = (input.operation ?? "simplify") as Operation
  const first = symbols[0]
  const extra = EXTRA_PARAMS[op]

  // Variable-dependent operations (solve/diff/integrate/limit/series) need a
  // free symbol; constants have none.
  const needsVariable = ["solve", "diff", "integrate", "limit", "series"].includes(op)
  if (needsVariable && !first) {
    return {
      ok: false,
      error: `${op} requires a variable. The expression "${expr}" has no free symbols — use a symbolic expression (e.g. "x**2 - 4") or pass symbols="x".`,
    }
  }

  if (extra) {
    for (const key of extra.required ?? []) {
      if (input[key] === undefined) return { ok: false, error: extra.hint }
    }
  }

  const code = [
    `from sympy import *`,
    ...symbols.map((s) => `${s} = Symbol("${s}")`),
    `_expr = sympify(${JSON.stringify(expr)})`,
    `_result = ${opCall(op, input, first ?? "x")}`,
    `print("__SYMPY_RESULT__")`,
    `print(sstr(_result))`,
  ].join("\n")

  return { ok: true, code, kind: "expr", display: `${op}(${expr})` }
}

function opCall(
  op: Operation,
  input: { variable?: string; point?: string; direction?: string; order?: number; precision?: number },
  defaultVar: string,
): string {
  const v = input.variable || defaultVar
  switch (op) {
    case "simplify":
    case "expand":
    case "factor":
    case "trigsimp":
    case "cancel":
    case "together":
    case "apart":
      return `${op}(_expr)`
    case "solve":
      return `solve(_expr, ${v})`
    case "diff":
      return `diff(_expr, ${v}, ${input.order ?? 1})`
    case "integrate":
      return `integrate(_expr, ${v})`
    case "limit":
      return `limit(_expr, ${v}, ${input.point ?? "0"}${input.direction ? `, dir="${input.direction}"` : ""})`
    case "series":
      return `series(_expr, ${v}, ${input.point ?? "0"}, ${input.order ?? 6})`
    case "evalf":
      return `_expr.evalf(${input.precision ?? 15})`
    case "nroots":
      return `nroots(_expr, ${input.precision ?? 15})`
    case "factorint":
      return `factorint(_expr)`
    case "primefactors":
      return `primefactors(_expr)`
    case "gcd":
    case "lcm":
      return `${op}(_expr)`
    default:
      return `${op}(_expr)`
  }
}

// Build the Python source for the advanced (code) path. The user's statements
// run inside a code.InteractiveConsole whose sys.displayhook is overridden to
// capture the value of the last expression (REPL semantics); sstr() renders it.
// Lines are pushed one at a time so multi-line statements (bracketed lists,
// indented blocks) compile correctly.
export function buildCodeCall(input: { code: string; symbols?: string[] }): BuildResult {
  const code = input.code.trim()
  if (!code) return { ok: false, error: "code is required for the advanced path." }
  const symbols = input.symbols ?? []
  const locals = symbols.length > 0 ? `{${symbols.map((s) => `${JSON.stringify(s)}: ${s}`).join(", ")}}` : "{}"
  const prelude = [
    `from sympy import *`,
    `import code, sys`,
    ...symbols.map((s) => `${s} = Symbol("${s}")`),
    `_captured = []`,
    `sys.displayhook = lambda v: _captured.append(v) if v is not None else None`,
    `_console = code.InteractiveConsole(${locals})`,
    `_console.push("from sympy import *")`,
  ]
  const lines = code
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== "")
  const pushes = lines.map((line) => `_console.push(${JSON.stringify(line)})`)
  const wrapped = [
    ...prelude,
    ...pushes,
    `print("__SYMPY_RESULT__")`,
    `print(sstr(_captured[-1]) if _captured else "<no result>")`,
  ].join("\n")
  return { ok: true, code: wrapped, kind: "code", display: "code" }
}

// Parse the child's stdout: everything before the RESULT marker is diagnostics
// (warnings / user prints), everything after is the result (multi-line allowed —
// sstr of matrices/polynomials spans lines).
export function parseOutput(stdout: string): { diagnostics: string; result: string } {
  const marker = "__SYMPY_RESULT__"
  const idx = stdout.indexOf(marker)
  if (idx === -1) {
    const trimmed = stdout.trim()
    return { diagnostics: trimmed, result: trimmed }
  }
  const diagnostics = stdout.slice(0, idx).trim()
  const after = stdout.slice(idx + marker.length).trim()
  return { diagnostics, result: after }
}

// Extract the useful first error line from a Python traceback (stderr).
export function firstErrorLine(stderr: string): string {
  const lines = stderr.split(/\r?\n/)
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (/^(NameError|TypeError|ValueError|SyntaxError|ZeroDivisionError|SympifyError|AttributeError|RuntimeError|NotImplementedError|RecursionError|AssertionError|KeyError|IndexError|ImportError|ModuleNotFoundError|FloatingPointError|OverflowError)/.test(line)) {
      return line
    }
  }
  const meaningful = lines.filter((l) => l.trim() && !l.startsWith("Traceback") && !l.trim().startsWith("File ") && !/^\s*\^+\s*$/.test(l))
  return meaningful.at(-1)?.trim() ?? stderr.trim().slice(0, 300)
}

export function suggestionFor(line: string): string | undefined {
  const l = line.toLowerCase()
  if (l.includes("not defined")) {
    return "NameError: an identifier isn't defined. Pass variables via `symbols` (e.g. symbols=\"x y\") on the structured path, or declare them in the code path. To call an operation, use the operation enum (e.g. operation=\"simplify\") instead of typing a function name inside expr."
  }
  if (l.includes("sympify")) {
    return "SympifyError: the expression could not be parsed. Check balanced parentheses and use Python numeric syntax (`**` for powers, `*` for multiplication, `^` is bitwise XOR, not a power)."
  }
  if (l.includes("module") && l.includes("not callable")) {
    return "An imported sympy name was called as a function. Most sympy functions are already in scope (from sympy import *); call them by name (e.g. simplify(x))."
  }
  if (l.includes("zero division") || l.includes("division by zero")) {
    return "ZeroDivisionError: the expression hits a division by zero. Check the point/bounds, or use operation='limit' for removable singularities."
  }
  if (l.includes("syntax")) {
    return "SyntaxError: invalid Python in the expression/code. Use `**` for powers, `*` for multiplication, and valid numeric literals."
  }
  if (l.includes("can't convert expression to float") || l.includes("cannot be evaluated to a number")) {
    return "A numeric operation hit a symbolic result. Use evalf or nroots only on numeric expressions, or leave the result symbolic."
  }
  return undefined
}

export function humanizeMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(1)}s`
}

// Availability-probe message templates (pure, so they're unit-testable without
// a live python). The tool's probe picks one of these based on what it found.
export function missingPythonMessage(): string {
  return "Neither `python` nor `python3`/`py` is available on PATH. Install Python (https://www.python.org) and SymPy: python -m pip install sympy"
}

export function missingSympyMessage(interpreter: string, version: string | undefined): string {
  return `Python (${interpreter}${version ? ` ${version}` : ""}) is available but SymPy is not installed. Install it with: python -m pip install sympy   (or: uv pip install sympy)`
}
