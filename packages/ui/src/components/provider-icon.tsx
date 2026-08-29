import type { Component, JSX } from "solid-js"
import { createMemo, splitProps } from "solid-js"
import sprite from "./provider-icons/sprite.svg"
import { iconNames, type IconName } from "./provider-icons/types"

export type ProviderIconProps = JSX.SVGElementTags["svg"] & {
  id: string
}

export const ProviderIcon: Component<ProviderIconProps> = (props) => {
  const [local, rest] = splitProps(props, ["id", "class", "classList"])
  const resolved = createMemo(() => {
    // Claude subscription and API-key providers intentionally have distinct
    // IDs, but share Anthropic's visual identity.
    if (local.id === "claude" || local.id === "claude-api") return "anthropic"
    // OpenCode Zen free quota is IP-based and shares the OpenCode brand.
    if (local.id === "opencode-zen" || local.id === "zen" || local.id === "opencode-free") return "opencode"
    return iconNames.includes(local.id as IconName) ? local.id : "synthetic"
  })
  return (
    <svg
      data-component="provider-icon"
      {...rest}
      classList={{
        ...local.classList,
        [local.class ?? ""]: !!local.class,
      }}
    >
      <use href={`${sprite}#${resolved()}`} />
    </svg>
  )
}
