import { ProviderIcon as RealProviderIcon } from "@opencode-ai/ui/provider-icon"

const LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  "claude-api": "Anthropic",
  claude: "Claude",
  openai: "OpenAI",
  opencode: "OpenCode",
  "opencode-go": "OpenCode Go",
  openrouter: "OpenRouter",
  xai: "xAI",
  google: "Google",
  nvidia: "NVIDIA",
  groq: "Groq",
  deepseek: "DeepSeek",
}

export function providerLabel(providerID: string): string {
  return LABELS[providerID.toLowerCase()] ?? providerID
}

export function ProviderBadge(props: { providerID: string; size?: "xs" | "sm" | "md" }) {
  const px = () => (props.size === "md" ? 16 : props.size === "sm" ? 14 : 12)
  return (
    <RealProviderIcon
      id={props.providerID}
      class={`provider-icon ${props.size ?? "xs"}`}
      width={px()}
      height={px()}
      aria-label={providerLabel(props.providerID)}
    />
  )
}
