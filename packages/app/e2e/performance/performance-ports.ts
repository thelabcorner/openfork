export function performancePorts(env: NodeJS.ProcessEnv = process.env) {
  const appPort = Number(env.PLAYWRIGHT_PORT ?? 3000)
  const serverPort = Number(env.PLAYWRIGHT_SERVER_PORT ?? 4096)

  if (!Number.isInteger(appPort) || appPort <= 0 || appPort > 65_535)
    throw new Error(`Invalid Playwright app port: ${env.PLAYWRIGHT_PORT ?? appPort}`)
  if (!Number.isInteger(serverPort) || serverPort <= 0 || serverPort > 65_535)
    throw new Error(`Invalid mocked OpenCode server port: ${env.PLAYWRIGHT_SERVER_PORT ?? serverPort}`)
  if (appPort === serverPort)
    throw new Error(
      `Playwright app port (${appPort}) must differ from mocked OpenCode server port (${serverPort}); aliasing them bypasses the mock backend interceptor`,
    )

  return { appPort, serverPort }
}

export function performanceBackendUrl(env: NodeJS.ProcessEnv = process.env) {
  const { serverPort } = performancePorts(env)
  const host = env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"
  return `http://${host}:${serverPort}`
}
