export function performanceBuildEnv(env: NodeJS.ProcessEnv = process.env) {
  return {
    // A performance build must not inherit NODE_ENV=development from the
    // developer shell. Doing so makes Vite compile import.meta.env.DEV paths
    // such as DebugBar and its performance observers into the measured bundle.
    NODE_ENV: "production",
    OPENCODE_CHANNEL: env.OPENCODE_PERFORMANCE_CHANNEL ?? "prod",
  }
}
