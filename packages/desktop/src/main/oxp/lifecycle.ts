import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { app, BrowserWindow, Menu, nativeImage, Tray } from "electron"
import { nativeT } from "../native-translations"
import { setAppQuitting, setCloseToTray, setInitialWindowsHidden, showMainWindows } from "../windows"
import type { OxpLifecycle } from "./config"

export const START_HIDDEN_ARG = "--openfork-start-hidden"

function trayIcon() {
  const ext = process.platform === "win32" ? "ico" : "png"
  const candidates = app.isPackaged
    ? [path.join(process.resourcesPath, "icons", `icon.${ext}`)]
    : [
        path.join(app.getAppPath(), "resources", "icons", `icon.${ext}`),
        path.join(import.meta.dirname, "../../../resources/icons", `icon.${ext}`),
      ]
  for (const candidate of candidates) {
    const image = nativeImage.createFromPath(candidate)
    if (!image.isEmpty()) return image
  }
  return nativeImage.createEmpty()
}

function escapeDesktopExec(value: string) {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
}

async function setLinuxAutostart(openAtLogin: boolean, startHidden: boolean) {
  const configHome = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config")
  const file = path.join(configHome, "autostart", "openfork-oxp.desktop")
  if (!openAtLogin) {
    await fs.rm(file, { force: true })
    return
  }
  if (!app.isPackaged) throw new Error("Launch at login can only be enabled from a packaged OpenFork desktop build.")
  const args = startHidden ? ` ${START_HIDDEN_ARG}` : ""
  const payload = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=OpenFork",
    `Exec=${escapeDesktopExec(app.getPath("exe"))}${args}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    "",
  ].join("\n")
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  await fs.writeFile(temp, payload, { encoding: "utf8", mode: 0o600 })
  await fs.rename(temp, file)
}

export class OxpLifecycleOwner {
  private tray: Tray | undefined

  prepareInitialWindowVisibility(config: OxpLifecycle) {
    const hiddenLoginLaunch = config.startHidden && process.argv.includes(START_HIDDEN_ARG)
    setInitialWindowsHidden(hiddenLoginLaunch)
  }

  async apply(config: OxpLifecycle) {
    setCloseToTray(config.closeToTray)
    await this.applyLoginItem(config)
    const needTray = config.closeToTray || (config.launchAtLogin && config.startHidden)
    if (needTray) this.ensureTray()
    else this.destroyTray(true)
  }

  private async applyLoginItem(config: OxpLifecycle) {
    if (process.platform === "linux") {
      await setLinuxAutostart(config.launchAtLogin, config.startHidden)
      return
    }
    if (config.launchAtLogin && !app.isPackaged) {
      throw new Error("Launch at login can only be enabled from a packaged OpenFork desktop build.")
    }
    app.setLoginItemSettings({
      openAtLogin: config.launchAtLogin,
      args: config.startHidden ? [START_HIDDEN_ARG] : [],
    })
  }

  private ensureTray() {
    if (this.tray) return
    const tray = new Tray(trayIcon())
    tray.setToolTip("OpenFork OXP")
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: nativeT("desktop.oxp.tray.open"), click: () => showMainWindows() },
        { type: "separator" },
        {
          label: nativeT("desktop.oxp.tray.quit"),
          click: () => {
            setAppQuitting()
            app.quit()
          },
        },
      ]),
    )
    tray.on("click", () => showMainWindows())
    tray.on("double-click", () => showMainWindows())
    this.tray = tray
  }

  private destroyTray(showBeforeDestroy: boolean) {
    if (!this.tray) return
    if (showBeforeDestroy) {
      const windows = BrowserWindow.getAllWindows()
      if (windows.length && windows.every((win) => !win.isVisible())) showMainWindows()
    }
    this.tray.destroy()
    this.tray = undefined
  }

  dispose() {
    this.destroyTray(false)
  }
}
