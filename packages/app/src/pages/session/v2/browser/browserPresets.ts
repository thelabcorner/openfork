// Device presets for the browser viewport toolbar. Dense, v2-zinc styled,
// i18n-labeled. `nameKey` resolves through the desktop renderer t().

import type { DeviceOrientation } from "./types"

/** i18n keys for device preset names (resolved through the app dictionary). */
export type BrowserDeviceNameKey =
  | "browser.device.iphone-se"
  | "browser.device.iphone-15"
  | "browser.device.pixel-8"
  | "browser.device.ipad-air"
  | "browser.device.small-laptop"
  | "browser.device.laptop"
  | "browser.device.desktop"

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
  { id: "iphone-15", nameKey: "browser.device.iphone-15", width: 390, height: 844, device: true },
  { id: "pixel-8", nameKey: "browser.device.pixel-8", width: 412, height: 915, device: true },
  { id: "ipad-air", nameKey: "browser.device.ipad-air", width: 820, height: 1180, device: true },
  { id: "small-laptop", nameKey: "browser.device.small-laptop", width: 1280, height: 800 },
  { id: "laptop", nameKey: "browser.device.laptop", width: 1440, height: 900 },
  { id: "desktop-hd", nameKey: "browser.device.desktop", width: 1920, height: 1080 },
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
