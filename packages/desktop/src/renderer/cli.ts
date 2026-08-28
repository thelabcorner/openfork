import { initI18n, t } from "./i18n"

export async function installCli(): Promise<void> {
  await initI18n()

  const api = (typeof window !== "undefined" ? (window as unknown as { api?: typeof window.api }).api : undefined)
  if (!api?.installCli) {
    window.alert(t("desktop.cli.failed.message", { error: "Not in Electron" }))
    return
  }
  try {
    const path = await api.installCli()
    window.alert(t("desktop.cli.installed.message", { path }))
  } catch (e) {
    window.alert(t("desktop.cli.failed.message", { error: String(e) }))
  }
}
