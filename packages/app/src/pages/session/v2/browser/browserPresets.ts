// Device presets for the browser viewport toolbar. Mirrors Chrome DevTools'
// default device toolbar list (Dimensions dropdown) so recorded/viewed
// dimensions match what engineers already expect from that tool. Dense,
// v2-zinc styled, i18n-labeled. `nameKey` resolves through the desktop
// renderer t().

import type { DeviceOrientation } from "./types"

/** i18n keys for device preset names (resolved through the app dictionary). */
export type BrowserDeviceNameKey =
  | "browser.device.iphone-se"
  | "browser.device.iphone-xr"
  | "browser.device.iphone-12-pro"
  | "browser.device.iphone-14-pro-max"
  | "browser.device.pixel-7"
  | "browser.device.galaxy-s8-plus"
  | "browser.device.galaxy-s20-ultra"
  | "browser.device.ipad-mini"
  | "browser.device.ipad-air"
  | "browser.device.ipad-pro"
  | "browser.device.surface-pro-7"
  | "browser.device.surface-duo"
  | "browser.device.galaxy-z-fold5"
  | "browser.device.zenbook-fold"
  | "browser.device.galaxy-a51-71"
  | "browser.device.nest-hub"
  | "browser.device.nest-hub-max"

export interface BrowserDevicePreset {
  id: string
  nameKey: BrowserDeviceNameKey
  width: number
  height: number
  /** Touch devices show a "device" chip in the toolbar instead of raw px. */
  device?: boolean
}

export const BROWSER_DEVICE_PRESETS: readonly BrowserDevicePreset[] = [
  { id: "iphone-se", nameKey: "browser.device.iphone-se", width: 375, height: 667, device: true },
  { id: "iphone-xr", nameKey: "browser.device.iphone-xr", width: 414, height: 896, device: true },
  { id: "iphone-12-pro", nameKey: "browser.device.iphone-12-pro", width: 390, height: 844, device: true },
  { id: "iphone-14-pro-max", nameKey: "browser.device.iphone-14-pro-max", width: 430, height: 932, device: true },
  { id: "pixel-7", nameKey: "browser.device.pixel-7", width: 412, height: 915, device: true },
  { id: "galaxy-s8-plus", nameKey: "browser.device.galaxy-s8-plus", width: 360, height: 740, device: true },
  { id: "galaxy-s20-ultra", nameKey: "browser.device.galaxy-s20-ultra", width: 412, height: 915, device: true },
  { id: "ipad-mini", nameKey: "browser.device.ipad-mini", width: 768, height: 1024, device: true },
  { id: "ipad-air", nameKey: "browser.device.ipad-air", width: 820, height: 1180, device: true },
  { id: "ipad-pro", nameKey: "browser.device.ipad-pro", width: 1024, height: 1366, device: true },
  { id: "surface-pro-7", nameKey: "browser.device.surface-pro-7", width: 912, height: 1368, device: true },
  { id: "surface-duo", nameKey: "browser.device.surface-duo", width: 540, height: 720, device: true },
  { id: "galaxy-z-fold5", nameKey: "browser.device.galaxy-z-fold5", width: 344, height: 882, device: true },
  { id: "zenbook-fold", nameKey: "browser.device.zenbook-fold", width: 853, height: 1280, device: true },
  { id: "galaxy-a51-71", nameKey: "browser.device.galaxy-a51-71", width: 412, height: 914, device: true },
  { id: "nest-hub", nameKey: "browser.device.nest-hub", width: 1024, height: 600, device: true },
  { id: "nest-hub-max", nameKey: "browser.device.nest-hub-max", width: 1280, height: 800, device: true },
]

export function resolveBrowserDevicePreset(id: string | null): BrowserDevicePreset | null {
  if (!id) return null
  return BROWSER_DEVICE_PRESETS.find((preset) => preset.id === id) ?? null
}

/**
 * Rotate a preset between portrait/landscape by swapping dims. Pure — used by
 * the rotate button in the device toolbar and unit-tested.
 */
export function rotateDevicePreset(
  preset: { width: number; height: number },
  orientation: DeviceOrientation,
): { width: number; height: number } {
  if (orientation === "landscape") return { width: Math.max(preset.width, preset.height), height: Math.min(preset.width, preset.height) }
  return { width: Math.min(preset.width, preset.height), height: Math.max(preset.width, preset.height) }
}
