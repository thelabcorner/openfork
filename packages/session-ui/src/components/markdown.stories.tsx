// @ts-nocheck
import * as mod from "./markdown"
import { create } from "@opencode-ai/ui/storybook/scaffold"
import { markdown } from "@opencode-ai/ui/storybook/fixtures"

const docs = `### Overview
Render sanitized Markdown with code blocks, Mermaid diagrams, inline code, and safe links.

Pair with \`Code\` for standalone code views.

### API
- Required: \`text\` Markdown string.
- Uses the Marked context provider for parsing and sanitization.

### Variants and states
- Code blocks include copy buttons when rendered.
- Completed \`mermaid\` fences lazy-render as interactive, theme-aware diagrams.

### Behavior
- Sanitizes HTML and auto-converts inline URL code to links.
- Adds copy buttons to code blocks.

### Accessibility
- Copy buttons include aria-labels from i18n.
- TODO: confirm link target behavior in sanitized output.

### Theming/tokens
- Uses \`data-component="markdown"\` and related slots for styling.

`

const story = create({
  title: "UI/Markdown",
  mod,
  args: {
    text: markdown,
  },
})

export default {
  title: "UI/Markdown",
  id: "components-markdown",
  component: story.meta.component,
  tags: ["autodocs"],
  parameters: {
    docs: {
      description: {
        component: docs,
      },
    },
  },
}

export const Basic = story.Basic

export const Mermaid = {
  args: {
    text: `## Architecture\n\n\`\`\`mermaid\nflowchart LR\n  UI[Message timeline] --> Projector[Streaming projector]\n  Projector --> Fence{Fence complete?}\n  Fence -- No --> Code[Cheap source block]\n  Fence -- Yes --> Lazy[Viewport lazy loader]\n  Lazy --> Cache[Theme-aware SVG cache]\n  Cache --> Diagram[Interactive diagram]\n\`\`\`\n`,
  },
}
