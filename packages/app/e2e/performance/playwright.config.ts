import config from "../../playwright.config"
import { performancePorts } from "./performance-ports"
import { performanceBuildEnv } from "./performance-environment"

const { appPort: port } = performancePorts()
process.env.OPENCODE_PERFORMANCE_RUN_ID ??= `${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`

export default {
  ...config,
  testDir: ".",
  testIgnore: ["**/unit/**", "**/*.test.ts"],
  outputDir: "../test-results/performance",
  fullyParallel: false,
  workers: 1,
  reporter: [["html", { outputFolder: "../playwright-report/performance", open: "never" }], ["line"]],
  webServer: {
    ...config.webServer,
    command: `bun run build && bun run serve -- --host 0.0.0.0 --port ${port} --strictPort`,
    reuseExistingServer: false,
    env: {
      ...(config.webServer && !Array.isArray(config.webServer) ? config.webServer.env : {}),
      ...performanceBuildEnv(),
    },
  },
}
