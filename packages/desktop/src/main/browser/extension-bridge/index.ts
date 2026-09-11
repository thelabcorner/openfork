// extension-bridge barrel — public surface for the chrome-attach lane.
//
// Re-export order matters for documentation: the host framing lives closest to
// the wire, the bridge is the multiplex, and pairing is the install surface.

export { encodeNativeMessage, decodeNativeFrames, NATIVE_MESSAGE_MAX_BYTES, NATIVE_MESSAGE_HEADER_SIZE, ExtensionHost } from "./extension-host"
export type { ExtensionHostOptions, DispatchFn } from "./extension-host"

export { ExtensionBridge, mapChromeErrorToTag } from "./extension-bridge"
export type { Lane, ExtensionTabRecord, ExtensionBridgeOptions } from "./extension-bridge"

export {
  HOST_NAME,
  getNativeHostDir,
  getManifestPath,
  buildManifest,
  writeHosts,
  removeHosts,
  getStatus,
  getInstructions,
  windowsRegistryKey,
} from "./pairing"
export type { NativeHostManifest, BrowserVariant, PairingStatus, PairingOptions, PairingInstructions } from "./pairing"
