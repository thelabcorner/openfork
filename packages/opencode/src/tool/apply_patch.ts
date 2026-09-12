import { Effect, Schema } from "effect"
import * as Tool from "./tool"
import { EventV2Bridge } from "@/event-v2-bridge"
import { LSP } from "@/lsp/lsp"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Format } from "../format"
import DESCRIPTION from "./apply_patch.txt"
import {
  Parameters as PatchParameters,
  runPatchEffect,
  type PatchExecutorServices,
} from "./patch"

// GPT-family models keep the familiar `apply_patch` tool name, but execute the
// same hardened bulk-mutation engine as the fork-native `patch` tool. This
// prevents the two mutation paths from drifting while preserving GPT's strong
// prior for apply_patch.
export const Parameters = PatchParameters

export const ApplyPatchTool = Tool.define(
  "apply_patch",
  Effect.gen(function* () {
    const lsp = yield* LSP.Service
    const afs = yield* FSUtil.Service
    const format = yield* Format.Service
    const events = yield* EventV2Bridge.Service
    const services: PatchExecutorServices = { lsp, afs, format, events }

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        runPatchEffect(
          services,
          // Preserve GPT's established apply_patch contract: omission means
          // apply now and fail on conflicts. The richer patch behaviors remain
          // available explicitly via apply:false / apply:"if-clean".
          params.apply === undefined ? { ...params, apply: true } : params,
          ctx,
        ).pipe(Effect.orDie),
    }
  }),
)
