import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import * as Telegram from "@/notification/telegram"
import { TelegramApi } from "../groups/telegram"
import { ApiTelegramError } from "../groups/telegram"

/**
 * Thin Tier-0 handler. Bot connection belongs to the generic channel;
 * quota subscriptions belong to their own notification source.
 */
export const telegramHandlers=HttpApiBuilder.group(TelegramApi,"telegram",(handlers)=>
  Effect.gen(function*(){
    const notification=yield* Telegram.Service
    const wrap=<T>(task:()=>Promise<T>)=>Effect.tryPromise({
      try:task,
      catch:()=>new ApiTelegramError({message:"Telegram request failed. Check notification settings and the server connection."}),
    })
    return handlers
      .handle("status",()=>wrap(()=>notification.status()))
      .handle("update",(ctx)=>wrap(()=>notification.hub.setEnabled(ctx.payload.enabled)))
      .handle("configure",(ctx)=>wrap(()=>notification.hub.configure(ctx.payload.token)))
      .handle("disconnect",()=>wrap(()=>notification.hub.disconnect()))
      .handle("beginPairing",()=>wrap(()=>notification.hub.beginPairing()))
      .handle("checkPairing",()=>wrap(()=>notification.hub.checkPairing()))
      .handle("test",()=>wrap(()=>notification.hub.sendTest()))
      .handle("quotaStatus",()=>Effect.sync(()=>notification.quota.status()))
      .handle("quotaUpdate",(ctx)=>wrap(()=>notification.quota.update(ctx.payload)))
  }),
)
