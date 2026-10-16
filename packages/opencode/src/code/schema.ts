import { Schema } from "effect"
import * as InputAdmission from "./input-admission"

export const Action = Schema.Literals(["search", "describe", "run", "save", "call"])
export type Action = typeof Action.Type

export const SearchTarget = Schema.Literals(["callable", "capabilities", "saved", "runs"])
export type SearchTarget = typeof SearchTarget.Type

export const SaveSpec = Schema.Struct({
  name: Schema.String.annotate({ description: "Saved-tool ID. Required for save/run promotion." }),
  description: Schema.optional(Schema.String).annotate({ description: "Optional saved-tool description override." }),
  scope: Schema.optional(Schema.Literals(["project", "global"])).annotate({
    description: "Optional saved-tool scope; project is the default.",
  }),
  inputSchema: Schema.optional(Schema.Unknown).annotate({ description: "Optional JSON Schema for saved-tool input." }),
  outputSchema: Schema.optional(Schema.Unknown).annotate({ description: "Optional JSON Schema for saved-tool output." }),
  tags: Schema.optional(Schema.Array(Schema.String)).annotate({ description: "Optional discovery tags for the saved tool." }),
})
export type SaveSpec = typeof SaveSpec.Type

/**
 * Provider-facing Code contract.
 *
 * Keep this shape flat and byte-stable. Action-specific requirements/XOR rules
 * are decoded by the host rather than expressed as provider-sensitive oneOfs.
 */
export const Parameters = Schema.Struct({
  action: Action.annotate({
    description:
      "Operation: search for refs, describe one exact ref, run/replay code, save a successful run, or call a saved tool.",
  }),

  // search
  query: Schema.optional(Schema.String).annotate({ description: "search: optional broad discovery query." }),
  ref: Schema.optional(Schema.String).annotate({
    description: "describe: exact host-issued capability/saved/run ref returned by search.",
  }),
  target: Schema.optional(SearchTarget).annotate({
    description: "search: discovery domain; defaults to callable.",
  }),
  limit: Schema.optional(Schema.Number).annotate({ description: "search: maximum results (default 8, maximum 25)." }),
  cursor: Schema.optional(Schema.String).annotate({ description: "search: opaque continuation cursor." }),

  // run
  code: Schema.optional(Schema.String).annotate({
    description: "run: inline JavaScript/TypeScript source. Mutually exclusive with runID.",
  }),
  runID: Schema.optional(Schema.String).annotate({
    description: "run: prior run handle for fresh replay; save: successful run to promote.",
  }),
  input: Schema.optional(Schema.Unknown).annotate({
    description: "run/call: JSON-safe invocation input. Inline run defaults to {}.",
  }),

  // save / run promotion
  save: Schema.optional(SaveSpec).annotate({
    description: "save: required saved-tool specification; run: optional post-success promotion.",
  }),

  // call
  tool: Schema.optional(Schema.String).annotate({
    description: "call: saved-tool ID, scoped alias, or immutable saved-revision handle.",
  }),
})
export type Parameters = typeof Parameters.Type

const fields = {
  search: new Set(["action", "query", "target", "limit", "cursor"]),
  describe: new Set(["action", "ref"]),
  run: new Set(["action", "code", "runID", "input", "save"]),
  save: new Set(["action", "runID", "save"]),
  call: new Set(["action", "tool", "input"]),
} as const

export class InvalidCodeRequest extends Error {
  constructor(readonly detail: string) {
    super(detail)
    this.name = "InvalidCodeRequest"
  }
}

export function validate(input: Parameters): Parameters {
  const admission = InputAdmission.inspect(input)
  if (!admission.ok) throw new InvalidCodeRequest(admission.reason)

  const allowed = fields[input.action as keyof typeof fields]
  for (const key of Object.keys(input)) {
    if (!allowed.has(key as never) && (input as Record<string, unknown>)[key] !== undefined) {
      throw new InvalidCodeRequest(`Field '${key}' is not valid for code.${input.action}.`)
    }
  }

  switch (input.action) {
    case "search":
      if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 25))
        throw new InvalidCodeRequest("code.search limit must be an integer from 1 to 25.")
      return input

    case "describe":
      if (!input.ref) throw new InvalidCodeRequest("code.describe requires ref.")
      return input

    case "run": {
      const selectors = Number(input.code !== undefined) + Number(input.runID !== undefined)
      if (selectors !== 1) throw new InvalidCodeRequest("code.run requires exactly one of code or runID.")
      return input
    }

    case "save":
      if (!input.runID || !input.save)
        throw new InvalidCodeRequest("code.save requires runID and save.")
      return input

    case "call":
      if (!input.tool) throw new InvalidCodeRequest("code.call requires tool.")
      return input
  }

  throw new InvalidCodeRequest("Unknown code action.")
}
