import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { Installation } from "../../installation"
import { InstallationVersion } from "@opencode-ai/core/installation/version"
import { PRODUCT_RELEASES_URL } from "@opencode-ai/core/brand"

export const UpgradeCommand = {
  command: "upgrade [target]",
  describe: "upgrade OpenFork to the latest or a specific version",
  builder: (yargs: Argv) =>
    yargs.positional("target", {
      describe: "OpenFork release version to install, for example '1.18.30' or 'v1.18.30'",
      type: "string",
    }),
  handler: async (args: { target?: string }) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Upgrade")
    const method = await Installation.method()
    if (method === "unknown") {
      prompts.log.error(
        `OpenFork will not overwrite ${process.execPath} because it is not a fork-managed direct installation.`,
      )
      prompts.log.info(`Use an OpenFork release from ${PRODUCT_RELEASES_URL} instead.`)
      prompts.outro("Done")
      return
    }
    prompts.log.info("Using fork-managed direct release updater")
    const target = args.target ? args.target.replace(/^v/, "") : await Installation.latest()

    if (InstallationVersion === target) {
      prompts.log.warn(`OpenFork upgrade skipped: ${target} is already installed`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(`From ${InstallationVersion} → ${target}`)
    const spinner = prompts.spinner()
    spinner.start("Upgrading...")
    const err = await Installation.upgrade(method, target).catch((err) => err)
    if (err) {
      spinner.stop("Upgrade failed", 1)
      if (err instanceof Installation.UpgradeFailedError) {
        prompts.log.error(err.stderr)
      } else if (err instanceof Error) prompts.log.error(err.message)
      prompts.outro("Done")
      return
    }
    spinner.stop("Upgrade complete")
    prompts.outro("Done")
  },
}
