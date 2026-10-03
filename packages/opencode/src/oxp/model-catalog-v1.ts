import { Effect, Layer } from "effect"
import { OxpModelCatalog } from "./model-catalog"
import { OxpRuntimeV1 } from "./runtime-v1"

async function providerModule() {
  return import("@/provider/provider")
}

const list: OxpModelCatalog.Interface["list"] = (target) =>
  OxpRuntimeV1.enter(
    target,
    async () => {
      const { Provider } = await providerModule()
      return Effect.gen(function* () {
        const provider = yield* Provider.Service
        const providers = yield* provider.list()
        const models: OxpModelCatalog.Model[] = []

        for (const info of Object.values(providers)) {
          for (const model of Object.values(info.models)) {
            if (!Provider.isLanguageModel(model)) continue
            models.push({
              providerID: String(info.id),
              providerName: info.name,
              modelID: String(model.id),
              name: model.name,
              ...(model.family ? { family: model.family } : {}),
              status: String(model.status),
              variants: Object.keys(model.variants ?? {}).sort(),
            })
          }
        }

        models.sort(
          (a, b) =>
            a.providerName.localeCompare(b.providerName) ||
            a.name.localeCompare(b.name) ||
            a.modelID.localeCompare(b.modelID),
        )
        return { models }
      })
    },
    "Native workspace model catalog failed",
  )

export const layer = Layer.succeed(
  OxpModelCatalog.Service,
  OxpModelCatalog.Service.of({ list }),
)

export * as OxpModelCatalogV1 from "./model-catalog-v1"