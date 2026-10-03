import { createSignal } from "solid-js"
import { SystemInjectionCardV2, type SystemInjectionCardV2Props } from "./system-injection-v2"

const docs = `### Overview
Reveals the context the SERVER attached to a turn — the \`synthetic: true\` text parts (plan and
build-switch reminders, MCP resource bodies, shell preambles, compaction hand-offs), first-class
system/skill context rows, and whole automation turns whose provenance gives them Synthetic
semantics. The model receives them; the user never wrote them.

### Two states
**Collapsed** it is a quiet right-aligned pill in the prompt column — hairline dashed, unfilled —
so it reads as a sibling of the turn and can never be mistaken for something the user typed.
**Expanded** it drops the disguise and becomes a full-width dense panel, because the payload is a
document, not a line.

### Structure
Injection payloads are an XML-ish envelope around markdown bodies. The card parses the envelope
(\`system-injection-content.ts\`) into titled frames, status pills and key/value chips, and renders
every leaf body through the same markdown renderer the assistant's own text uses. A **Raw** toggle
shows the untouched wire text whenever structure was found. The body scrolls inside the app's
overlay scrollbar.

### API
Purely presentational. The timeline owns which parts are injections and owns the open/closed
state, because the virtualizer unmounts off-screen rows. \`tone\` is optional: when it is omitted
the card derives the accent from the payload's own status attributes.

### Theming
\`data-component="system-injection"\`, with \`data-tone\` and \`data-kind\` on the root; colors are
CSS variables (\`--sysinj-*\`).
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

const TASK = `<task id="ses_f3485c087ffeta1Ca9qg5AzTer" state="completed">
<summary>Background task completed: Harden demo static paths</summary>
<task_result>
Implemented the static-file boundary hardening in the two requested files.

- **\`webseal-poc/server/demo-server.mjs\`** — Canonicalizes the configured dist root and each
  requested file before reading it. Malformed percent-encoding now returns \`400\`.
- **\`webseal-poc/test/demo-server-security.test.mjs\`** — Adds isolated tests using a temporary
  dist, an external target, and a server started on an available loopback port.

**Root cause:** The previous containment check examined the lexical path only. A directory symlink
could appear inside the dist directory while resolving to an external target.

**Verification:** \`node --test webseal-poc/test/demo-server-security.test.mjs\` passed all 3 tests.
</task_result>
</task>`

const TASK_ERROR = `<task id="ses_9f21" state="error">
<summary>Background task failed: Regenerate the SDK</summary>
<task_error>
Command failed with exit code 1

  error TS2345: Argument of type 'string' is not assignable to parameter of type 'MessageID'.
</task_error>
</task>`

const SHELL = `<background_shell id="job_7c1" status="completed" exit="0">
<command>bun test packages/core</command>
<preview>
 1204 pass
 0 fail
Ran 1204 tests across 96 files. [18.42s]
</preview>
Full output: .openfork/logs/job_7c1.log
</background_shell>`

const REMINDER = `<system-reminder>
Plan mode is active. You must not create or edit files, run write-shaped shell commands, or commit
code.

If the user asks for an edit, tell them plan mode is active and that they need to switch to build
mode first.
</system-reminder>`

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
        rawLabel="Raw"
        richLabel="Rich"
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

/** The envelope case: attributes become chips and a status pill, the summary becomes the lead,
 * and the result body goes through the markdown renderer. */
export const TaskSummary = {
  render: () => <Controlled open badge="Task summary" kind="task" segments={[{ id: "prt_1", text: TASK }]} />,
}

export const TaskFailed = {
  render: () => <Controlled open badge="Task summary" kind="task" segments={[{ id: "prt_1", text: TASK_ERROR }]} />,
}

export const BackgroundShell = {
  render: () => <Controlled open badge="Shell summary" kind="shell" segments={[{ id: "prt_1", text: SHELL }]} />,
}

export const SystemReminder = {
  render: () => <Controlled open segments={[{ id: "prt_1", text: REMINDER }]} />,
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

/** Past the body's max height the payload scrolls under the app's overlay thumb. */
export const Long = {
  render: () => (
    <Controlled
      open
      segments={[{ id: "prt_1", text: Array.from({ length: 60 }, (_, i) => `Reminder line ${i + 1}`).join("\n\n") }]}
    />
  ),
}
