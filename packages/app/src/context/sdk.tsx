import { createSimpleContext } from "@opencode-ai/ui/context"
import { type Accessor, createMemo, type JSX, type ParentProps } from "solid-js"
import { type ServerSDK, useServerSDK } from "./server-sdk"

export type DirectorySDK = ReturnType<ServerSDK["ensureDirSdkContext"]>

const sdkContext = createSimpleContext<
  Accessor<DirectorySDK>,
  { directory: string | Accessor<string> }
>({
  name: "SDK",
  // Resolves the directory-scoped SDK reactively from the (possibly changing) server.
  init: (props: { directory: string | Accessor<string> }) => {
    const serverSDK = useServerSDK()
    return createMemo(() => {
      const directory = typeof props.directory === "function" ? props.directory() : props.directory
      return serverSDK().ensureDirSdkContext(directory)
    })
  },
})

export const useSDK: () => Accessor<DirectorySDK> = sdkContext.use
export const SDKProvider: (
  props: ParentProps<{ directory: string | Accessor<string> }>,
) => JSX.Element = sdkContext.provider
