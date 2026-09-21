import { createSignal } from "solid-js"
import { SystemInjectionCardV2, type SystemInjectionCardV2Props } from "./system-injection-v2"

const docs = `### Overview
Reveals the \`synthetic: true\` text parts the server appends to a user turn — plan/build-switch
reminders, MCP resource bodies, shell-tool preambles, compaction hand-offs. The model receives
them; the user never wrote them, and the prompt bubble has never drawn them.

Sits in the prompt column (right-aligned, same radius and max width as the user bubble) so the
relationship to the turn is obvious, but is deliberately unfilled and hairline-dashed so it can
never be mistaken for something the user typed.

### API
Purely presentational. The timeline owns which parts are injections and owns the open/closed
state, because the virtualizer unmounts off-screen rows.

### Theming
\`data-component="system-injection"\`; edge/accent colors are CSS variables on the root (\`--sysinj-*\`).
`

export default {
  title: "UI V2/SystemInjection",
  id: "components-system-injection-v2",
  component: SystemInjectionCardV2,
  tags: ["autodocs"],
  parameters: {
    layout: "padded",
    docs: { description: { component: docs } },
  },
}

const PLAN = `You are in plan mode. Do not make any edits to the filesystem.

Research the codebase and produce a plan at .openfork/plan.md using the write tool.`

const BUILD_SWITCH = `The user has switched out of plan mode. You may now edit files.`

function Controlled(args: Partial<SystemInjectionCardV2Props> & { segments: SystemInjectionCardV2Props["segments"] }) {
  const [open, setOpen] = createSignal(args.open ?? false)
  const [copied, setCopied] = createSignal(false)
  return (
    <div style={{ display: "flex", "flex-direction": "column", width: "100%" }}>
      <SystemInjectionCardV2
        badge="System"
        expandLabel="Show system context added to this turn"
        collapseLabel="Hide system context added to this turn"
        copyLabel="Copy"
        copiedLabel="Copied"
        {...args}
        copied={copied()}
        onCopy={() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 2000)
        }}
        open={open()}
        onOpenChange={setOpen}
      />
    </div>
  )
}

export const Collapsed = {
  render: () => <Controlled segments={[{ id: "prt_1", text: PLAN }]} />,
}

export const Expanded = {
  render: () => <Controlled open segments={[{ id: "prt_1", text: PLAN }]} />,
}

export const Multiple = {
  render: () => (
    <Controlled
      open
      segments={[
        { id: "prt_1", text: BUILD_SWITCH },
        { id: "prt_2", text: "A plan file exists at .openfork/plan.md. Execute on the plan defined within it." },
        { id: "prt_3", text: PLAN },
      ]}
    />
  ),
}

export const Long = {
  render: () => (
    <Controlled
      open
      segments={[{ id: "prt_1", text: Array.from({ length: 60 }, (_, i) => `Reminder line ${i + 1}`).join("\n") }]}
    />
  ),
}
