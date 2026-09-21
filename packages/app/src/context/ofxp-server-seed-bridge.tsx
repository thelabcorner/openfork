import { createEffect } from "solid-js"
import { useGlobal } from "./global"
import { ServerConnection } from "./server"
import { useServerSDK } from "./server-sdk"
import { collectOfxpServerSeeds, createOfxpServerSeedSynchronizer } from "@/utils/ofxp-server-seeds"

const synchronizer = createOfxpServerSeedSynchronizer()

/**
 * Project configured remote ServerConnections into the OFXP runtime owned by
 * the *scoped* ServerSDKProvider.
 *
 * The health owner supplies already-sanitized source seeds on its existing
 * cadence. This bridge adds no timer and never reads the legacy independent
 * Settings server selector.
 */
export function OfxpServerSeedBridge() {
  const global = useGlobal()
  const serverSDK = useServerSDK()

  createEffect(() => {
    const scoped = serverSDK()
    const destinationKey = ServerConnection.key(scoped.server)
    if (global.servers.health[destinationKey]?.healthy !== true) {
      synchronizer.invalidate(destinationKey)
      return
    }
    const seeds = collectOfxpServerSeeds(global.servers.list(), global.servers.health, destinationKey)
    const destinationInstanceID = global.servers.health[destinationKey]?.instanceID ?? ""
    const signature = `${destinationInstanceID}\n${JSON.stringify(seeds)}`
    synchronizer.schedule(destinationKey, signature, () =>
      scoped.client.ofxp.discovery.serverSeeds(
        { ofxpSettingsServerSeedsPayload: { seeds } },
        { throwOnError: true },
      ),
    )
  })

  return null
}
