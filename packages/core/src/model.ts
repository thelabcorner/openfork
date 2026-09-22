import { Types } from "effect"
import { Model } from "@opencode-ai/schema/model"
import { ProviderV2 } from "./provider"
import { splitModelIDForProvider } from "@opencode-ai/schema/model-select/account-identity"

export const ID = Model.ID
export type ID = typeof ID.Type

export const VariantID = Model.VariantID
export type VariantID = typeof VariantID.Type

// Grouping of models, eg claude opus, claude sonnet
export const Family = Model.Family
export type Family = Model.Family

export const Primitive = Model.Primitive
export type Primitive = Model.Primitive
export const isLanguageModel = Model.isLanguageModel

export const Capabilities = Model.Capabilities
export type Capabilities = Model.Capabilities

export const Cost = Model.Cost

export const Ref = Model.Ref
export type Ref = typeof Ref.Type

export const Api = Model.Api
export type Api = Model.Api

export const Info = Model.Info
export type Info = Model.Info

export type MutableInfo = Omit<Types.DeepMutable<Info>, "api"> & {
  api: ProviderV2.MutableApi<Api>
}

export function parse(input: string): { providerID: ProviderV2.ID; modelID: ID; accountID?: string } {
  const [providerID, ...modelID] = input.split("/")
  const provider = ProviderV2.ID.make(providerID)
  const split = splitModelIDForProvider(modelID.join("/"), provider)
  return {
    providerID: provider,
    modelID: ID.make(split.baseModelID),
    ...(split.accountID ? { accountID: split.accountID } : {}),
  }
}

export * as ModelV2 from "./model"
