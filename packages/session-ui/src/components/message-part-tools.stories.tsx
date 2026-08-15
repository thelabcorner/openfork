// @ts-nocheck
import { Dynamic } from "solid-js/web"
import * as mod from "./message-part"
import { DataProvider } from "../context"
import { FileComponentProvider } from "@opencode-ai/ui/context/file"
import { File } from "./file"

const docs = `### Overview
Renders the actual per-tool cards (bash/read/grep/glob) and the read/grep/glob
context group, wrapped in a minimal mock DataProvider so they can be previewed
in isolation.`

export default {
  title: "UI/MessagePart Tools",
  id: "components-message-part-tools",
  parameters: { docs: { description: { component: docs } } },
}

const emptyData = {
  session: [],
  session_status: {},
  session_diff: {},
  message: {},
  part: {},
}

function ToolCard(props: {
  tool: string
  input: Record<string, unknown>
  metadata?: Record<string, unknown>
  output?: string
  status?: string
}) {
  const render = mod.getTool(props.tool)
  return (
    <DataProvider data={emptyData} directory="/repo">
      <FileComponentProvider component={File}>
        <div style={{ "max-width": "560px", padding: "12px" }}>
          <Dynamic
            component={render}
            input={props.input}
            metadata={props.metadata ?? {}}
            output={props.output}
            tool={props.tool}
            status={props.status ?? "completed"}
            defaultOpen
          />
        </div>
      </FileComponentProvider>
    </DataProvider>
  )
}

export const ShellCompleted = {
  render: () => (
    <ToolCard
      tool="shell"
      input={{ command: "bun test packages/session-ui" }}
      metadata={{ command: "bun test packages/session-ui" }}
      output={"PASS  src/components/basic-tool.test.ts\n  ✓ renders icon chip\n  ✓ status coloring\n\n2 tests passed."}
      status="completed"
    />
  ),
}

export const ShellRunning = {
  render: () => (
    <ToolCard tool="shell" input={{ command: "bun run typecheck" }} metadata={{ command: "bun run typecheck" }} status="running" />
  ),
}

export const Read = {
  render: () => (
    <ToolCard
      tool="read"
      input={{ filePath: "packages/session-ui/src/components/basic-tool.tsx", offset: 1, limit: 6 }}
      metadata={{
        display: {
          type: "file",
          path: "packages/session-ui/src/components/basic-tool.tsx",
          text: 'import { For, Show } from "solid-js"\nimport { Icon } from "@opencode-ai/ui/icon"\n\nexport function BasicTool(props) {\n  return <div>...</div>\n}',
          lineStart: 1,
          lineEnd: 6,
          totalLines: 40,
          truncated: true,
        },
      }}
      status="completed"
    />
  ),
}

export const Grep = {
  render: () => (
    <ToolCard
      tool="grep"
      input={{ pattern: "useData", path: "packages/session-ui/src", include: "*.tsx" }}
      output={[
        "Found 3 matches",
        "",
        "/repo/packages/session-ui/src/components/message-part.tsx:",
        "  Line 1790: const data = useData()",
        "  Line 2338: const fileComponent = useFileComponent()",
        "",
        "/repo/packages/session-ui/src/context/data.tsx:",
        "  Line 49: export const { use: useData, provider: DataProvider } = createSimpleContext({",
      ].join("\n")}
      status="completed"
    />
  ),
}

export const Glob = {
  render: () => (
    <ToolCard
      tool="glob"
      input={{ pattern: "**/*.stories.tsx", path: "packages/session-ui/src" }}
      output={[
        "/repo/packages/session-ui/src/components/basic-tool.stories.tsx",
        "/repo/packages/session-ui/src/components/message-part-tools.stories.tsx",
        "/repo/packages/session-ui/src/v2/components/basic-tool-v2.stories.tsx",
      ].join("\n")}
      status="completed"
    />
  ),
}

export const GenericMcpToolJson = {
  render: () => (
    <ToolCard
      tool="linear_search_issues"
      input={{ query: "tool card redesign", limit: 5 }}
      output={JSON.stringify(
        {
          results: [
            { id: "ENG-482", title: "Tool cards feel flat", status: "todo" },
            { id: "ENG-190", title: "Read tool has no expand affordance", status: "done" },
          ],
          count: 2,
        },
        null,
        2,
      )}
      status="completed"
    />
  ),
}

export const GenericMcpToolProse = {
  render: () => (
    <ToolCard
      tool="linear_search_issues"
      input={{ query: "tool card redesign", limit: 5 }}
      output={"Found 2 matching issues: ENG-482 and ENG-190. Both relate to the tool card redesign."}
      status="completed"
    />
  ),
}

export const Skill = {
  render: () => (
    <ToolCard
      tool="skill"
      input={{ name: "dataviz" }}
      output={"Loaded skill \"dataviz\": palette guidance, mark specs, and interaction rules for charts."}
      status="completed"
    />
  ),
}

export const ContextGroupReadGrepGlob = {
  render: () => {
    const parts = [
      {
        id: "prt_read",
        tool: "read",
        state: {
          status: "completed",
          input: { filePath: "packages/session-ui/src/components/basic-tool.tsx", offset: 1, limit: 6 },
          metadata: {
            display: {
              type: "file",
              path: "packages/session-ui/src/components/basic-tool.tsx",
              text: 'import { For, Show } from "solid-js"\nimport { Icon } from "@opencode-ai/ui/icon"\n\nexport function BasicTool(props) {\n  return <div>...</div>\n}',
              lineStart: 1,
              lineEnd: 6,
              totalLines: 40,
              truncated: true,
            },
          },
          output: "1\timport { For, Show } from \"solid-js\"\n2\timport { Icon } from \"@opencode-ai/ui/icon\"",
        },
      },
      {
        id: "prt_glob",
        tool: "glob",
        state: {
          status: "completed",
          input: { pattern: "**/*.stories.tsx", path: "packages/session-ui/src" },
          metadata: {},
          output: [
            "/repo/packages/session-ui/src/components/basic-tool.stories.tsx",
            "/repo/packages/session-ui/src/components/message-part-tools.stories.tsx",
          ].join("\n"),
        },
      },
      {
        id: "prt_grep",
        tool: "grep",
        state: {
          status: "completed",
          input: { pattern: "useData", path: "packages/session-ui/src", include: "*.tsx" },
          metadata: {},
          output: [
            "Found 2 matches",
            "",
            "/repo/packages/session-ui/src/components/message-part.tsx:",
            "  Line 1790: const data = useData()",
            "",
            "/repo/packages/session-ui/src/context/data.tsx:",
            "  Line 49: export const { use: useData, provider: DataProvider } = createSimpleContext({",
          ].join("\n"),
        },
      },
    ]
    return (
      <DataProvider data={emptyData} directory="/repo">
        <FileComponentProvider component={File}>
          <div style={{ "max-width": "560px", padding: "12px" }}>
            <mod.ContextToolGroup parts={parts} open />
          </div>
        </FileComponentProvider>
      </DataProvider>
    )
  },
}
