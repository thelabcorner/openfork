import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { described } from "./metadata"
import { Authorization } from "../middleware/authorization"
 
/**
 * The Telegram channel owns bot setup, chat pairing and transport; each
 * notification service owns its own preferences and event semantics.
 * Quota is the first service, not part of the Telegram transport contract.
 */
export const TelegramStatus = Schema.Struct({
  enabled:Schema.Boolean,
  configured:Schema.Boolean,
  connected:Schema.Boolean,
  botUsername:Schema.optional(Schema.String),
  chatLabel:Schema.optional(Schema.String),
  pairingUrl:Schema.optional(Schema.String),
  pairingExpiresAt:Schema.optional(Schema.Number),
  owner:Schema.Boolean,
  services:Schema.Array(Schema.Struct({
    id:Schema.String,
    title:Schema.String,
    enabled:Schema.Boolean,
  })),
  error:Schema.optional(Schema.String),
  lastAttemptAt:Schema.optional(Schema.Number),
  lastSuccessAt:Schema.optional(Schema.Number),
}).annotate({identifier:"TelegramNotificationStatus"})

export const TelegramQuotaSubscription = Schema.Struct({
  providerId:Schema.String,
  scope:Schema.Literals(["provider","account","model","account-model"]),
  accountId:Schema.optional(Schema.String),
  model:Schema.optional(Schema.String),
  windowKey:Schema.String,
  enabled:Schema.Boolean,
}).annotate({identifier:"TelegramQuotaSubscription"})
export const TelegramQuotaSettings = Schema.Struct({
  enabled:Schema.Boolean,
  subscriptions:Schema.Array(TelegramQuotaSubscription),
  scheduled:Schema.Number,
}).annotate({identifier:"TelegramQuotaSettings"})

const MasterUpdate=Schema.Struct({enabled:Schema.Boolean})
const BotSetup=Schema.Struct({token:Schema.String})
const QuotaUpdate=Schema.Struct({enabled:Schema.Boolean,subscriptions:Schema.Array(TelegramQuotaSubscription)})
export class ApiTelegramError extends Schema.ErrorClass<ApiTelegramError>("ApiTelegramError")(
  {message:Schema.String},{httpApiStatus:400},
) {}

export const TelegramPaths={
  status:"/global/telegram",
  bot:"/global/telegram/bot",
  pairing:"/global/telegram/pairing",
  pairingCheck:"/global/telegram/pairing/check",
  test:"/global/telegram/test",
  quota:"/global/telegram/services/quota",
} as const

export const TelegramApi=HttpApi.make("telegram").add(
  HttpApiGroup.make("telegram")
    .add(HttpApiEndpoint.get("status",TelegramPaths.status,{
      success:described(TelegramStatus,"Sanitized Telegram connection and registered notification services"),
      error:ApiTelegramError,
    }))
    .add(HttpApiEndpoint.patch("update",TelegramPaths.status,{
      payload:MasterUpdate,success:TelegramStatus,error:ApiTelegramError,
    }))
    .add(HttpApiEndpoint.post("configure",TelegramPaths.bot,{
      payload:BotSetup,success:TelegramStatus,error:ApiTelegramError,
    }))
    .add(HttpApiEndpoint.delete("disconnect",TelegramPaths.bot,{
      success:TelegramStatus,error:ApiTelegramError,
    }))
    .add(HttpApiEndpoint.post("beginPairing",TelegramPaths.pairing,{
      success:TelegramStatus,error:ApiTelegramError,
    }))
    .add(HttpApiEndpoint.post("checkPairing",TelegramPaths.pairingCheck,{
      success:TelegramStatus,error:ApiTelegramError,
    }))
    .add(HttpApiEndpoint.post("test",TelegramPaths.test,{
      success:TelegramStatus,error:ApiTelegramError,
    }))
    // First notification-service extension. Other sources do not have to
    // change bot credentials, polling, destinations or delivery semantics.
    .add(HttpApiEndpoint.get("quotaStatus",TelegramPaths.quota,{
      success:described(TelegramQuotaSettings,"Provider quota notification subscription state"),
      error:ApiTelegramError,
    }))
    .add(HttpApiEndpoint.patch("quotaUpdate",TelegramPaths.quota,{
      payload:QuotaUpdate,success:TelegramQuotaSettings,error:ApiTelegramError,
    }))
    .middleware(Authorization)
    .annotateMerge(OpenApi.annotations({
      title:"Telegram notifications",
      description:"Generic Telegram delivery channel and independently configurable notification sources.",
    })),
)
