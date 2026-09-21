import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { AbsolutePath } from "@opencode-ai/core/schema"
import { Reference } from "@opencode-ai/core/reference"
import { ReferenceGuidance } from "@opencode-ai/core/reference/guidance"
import { SystemContext } from "@opencode-ai/core/system-context/index"
import { it } from "./lib/effect"
import { renderReady } from "./lib/system-context"

const guidanceLayer = (referenceLayer: Layer.Layer<Reference.Service>) =>
  AppNodeBuilder.build(ReferenceGuidance.node, [[Reference.node, referenceLayer]])

describe("ReferenceGuidance", () => {
  it.effect("lists available references in the system context", () =>
    Effect.gen(function* () {
      const guidance = yield* ReferenceGuidance.Service
      const rendered = yield* renderReady(yield* guidance.load())

      expect(rendered).toContain("<available_references>")
      expect(rendered).toContain("<name>docs</name>")
      expect(rendered).toContain("<path>/docs</path>")
      expect(rendered).toContain("<description>Use for product documentation</description>")
    }).pipe(
      Effect.provide(
        guidanceLayer(
          Layer.mock(Reference.Service, {
            list: () =>
              Effect.succeed([
                new Reference.Info({
                  name: "docs",
                  path: AbsolutePath.make("/docs"),
                  description: "Use for product documentation",
                  source: Reference.LocalSource.make({
                    type: "local",
                    path: AbsolutePath.make("/docs"),
                    description: "Use for product documentation",
                  }),
                }),
              ]),
          }),
        ),
      ),
    ),
  )

  it.effect("omits guidance when no references are available", () =>
    Effect.gen(function* () {
      const guidance = yield* ReferenceGuidance.Service
      expect(yield* renderReady(yield* guidance.load())).toBe("")
    }).pipe(Effect.provide(guidanceLayer(Layer.mock(Reference.Service, { list: () => Effect.succeed([]) })))),
  )

  it.effect("omits references without descriptions", () =>
    Effect.gen(function* () {
      const guidance = yield* ReferenceGuidance.Service
      expect(yield* renderReady(yield* guidance.load())).toBe("")
    }).pipe(
      Effect.provide(
        guidanceLayer(
          Layer.mock(Reference.Service, {
            list: () =>
              Effect.succeed([
                new Reference.Info({
                  name: "docs",
                  path: AbsolutePath.make("/docs"),
                  source: Reference.LocalSource.make({ type: "local", path: AbsolutePath.make("/docs") }),
                }),
              ]),
          }),
        ),
      ),
    ),
  )
})
