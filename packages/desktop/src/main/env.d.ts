interface ImportMetaEnv {
  readonly OPENCODE_CHANNEL: string
  readonly OPENCODE_RUNTIME_MODULE_URL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

declare module "virtual:opencode-server" {
  export namespace Server {
    export const listen: typeof import("../../../opencode/dist/types/src/node").Server.listen
    export type Listener = import("../../../opencode/dist/types/src/node").Server.Listener
  }
  export namespace Config {
    export const get: typeof import("../../../opencode/dist/types/src/node").Config.get
    export type Info = import("../../../opencode/dist/types/src/node").Config.Info
  }
  export const OxpHost: typeof import("../../../opencode/dist/types/src/oxp/host").OxpHost
  export const OxpRuntimeRefresh: typeof import("../../../opencode/dist/types/src/oxp/runtime-refresh").OxpRuntimeRefresh
  export const runtimeModuleUrl: string
  export const bootstrap: typeof import("../../../opencode/dist/types/src/node").bootstrap
}
