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
      metadata={{
        command: "bun test packages/session-ui",
        timeout: 120_000,
        startedAt: Date.now() - 4_200,
        endedAt: Date.now(),
      }}
      output={"PASS  src/components/basic-tool.test.ts\n  ✓ renders icon chip\n  ✓ status coloring\n\n2 tests passed."}
      status="completed"
    />
  ),
}

export const ShellRunning = {
  render: () => (
    <ToolCard
      tool="shell"
      input={{ command: "bun run typecheck" }}
      metadata={{ command: "bun run typecheck", timeout: 120_000, startedAt: Date.now() - 91_000 }}
      status="running"
    />
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

const SKILL_MARKDOWN_BODY = `## Production-grade visual interface system for premium product software

**Purpose:** Produce premium, production-grade interface surfaces rooted in disciplined visual systems. This skill governs **how the product looks and presents**, not application logic.

### Principles

1. Establish a type scale before touching layout.
2. Prefer system spacing tokens over hand-picked pixel values.
3. Motion should clarify state changes, never decorate them.

\`\`\`ts
export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 }
\`\`\`

See \`reference/tokens.md\` for the full palette and elevation scale.`

export const Skill = {
  render: () => (
    <ToolCard
      tool="skill"
      input={{ name: "premium-ui-skill" }}
      metadata={{ mode: "load", name: "premium-ui-skill", dir: "/repo/.opencode/skills/premium-ui-skill", source: "registry" }}
      output={[
        `<skill_content name="premium-ui-skill">`,
        `# Skill: premium-ui-skill`,
        "",
        SKILL_MARKDOWN_BODY,
        "",
        "Base directory for this skill: /repo/.opencode/skills/premium-ui-skill",
        "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
        "Note: file list is sampled.",
        "",
        "<skill_files>",
        "<file>/repo/.opencode/skills/premium-ui-skill/SKILL.md</file>",
        "<file>/repo/.opencode/skills/premium-ui-skill/reference/tokens.md</file>",
        "<file>/repo/.opencode/skills/premium-ui-skill/reference/motion.md</file>",
        "</skill_files>",
        "</skill_content>",
      ].join("\n")}
      status="completed"
    />
  ),
}

export const SkillMultiple = {
  render: () => (
    <ToolCard
      tool="skill"
      input={{ names: ["dataviz", "premium-ui-skill"] }}
      metadata={{ mode: "load", names: ["dataviz", "premium-ui-skill"] }}
      output={[
        [
          `<skill_content name="dataviz">`,
          `# Skill: dataviz`,
          "",
          "Palette guidance, mark specs, and interaction rules for charts. Read before writing chart code.",
          "",
          "Base directory for this skill: /repo/.opencode/skills/dataviz",
          "Note: file list is sampled.",
          "",
          "<skill_files>",
          "<file>/repo/.opencode/skills/dataviz/SKILL.md</file>",
          "<file>/repo/.opencode/skills/dataviz/references/palette.md</file>",
          "</skill_files>",
          "</skill_content>",
        ].join("\n"),
        [
          `<skill_content name="premium-ui-skill">`,
          `# Skill: premium-ui-skill`,
          "",
          SKILL_MARKDOWN_BODY,
          "",
          "Base directory for this skill: /repo/.opencode/skills/premium-ui-skill",
          "Note: file list is sampled.",
          "",
          "<skill_files>",
          "<file>/repo/.opencode/skills/premium-ui-skill/SKILL.md</file>",
          "</skill_files>",
          "</skill_content>",
        ].join("\n"),
      ].join("\n\n")}
      status="completed"
    />
  ),
}

export const SkillList = {
  render: () => (
    <ToolCard
      tool="skill"
      input={{ mode: "list" }}
      metadata={{ mode: "list", count: 4, names: ["dataviz", "premium-ui-skill", "premium-ux-skill", "customize-opencode"] }}
      output={[
        `<skills mode="list" count="4">`,
        "  - dataviz: Chart, graph, plot, dashboard, or data visualization guidance.",
        "  - premium-ui-skill: Production-grade visual interface system for premium product software.",
        "  - premium-ux-skill: Interaction and flow design patterns for premium product software.",
        "  - customize-opencode: opencode's own configuration schemas and agent/skill/plugin authoring.",
        "</skills>",
      ].join("\n")}
      status="completed"
    />
  ),
}

export const SkillNotFound = {
  render: () => (
    <ToolCard
      tool="skill"
      input={{ name: "nonexistent-skill" }}
      metadata={{ mode: "load", name: "nonexistent-skill", count: 4 }}
      output={[
        'Skill "nonexistent-skill" not found. Not in local skills folders (agent-skills/, skills/, .skills/, etc.) or registered.',
        "",
        "Available skills (project folders + previously imported paths):",
        "- dataviz: Chart, graph, plot, dashboard, or data visualization guidance.",
        "- premium-ui-skill: Production-grade visual interface system for premium product software.",
        "",
        'Use skill({ mode: "list" }) to list all.',
      ].join("\n")}
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

export const GitStatus = {
  render: () => (
    <ToolCard
      tool="git"
      input={{ mode: "status" }}
      output={[
        '<status clean="false" entries="3">',
        "  <entry> M src/components/shell-timer.tsx</entry>",
        "  <entry>A  src/components/git-tool.tsx</entry>",
        "  <entry>?? src/components/git-tool.stories.tsx</entry>",
        "</status>",
      ].join("\n")}
    />
  ),
}

export const GitSummary = {
  render: () => (
    <ToolCard
      tool="git"
      input={{ mode: "summary" }}
      output={[
        '<summary branch="openfork">',
        "  <entry> M src/components/shell-timer.tsx</entry>",
        "  <entry>A  src/components/git-tool.tsx</entry>",
        "</summary>",
        "<recent>",
        "  <commit>a1b2c3d (HEAD -> openfork) feat(session-ui): premium tool UI overhaul</commit>",
        "  <commit>9f8e7d6 fix(session-ui): shell timer badge styling</commit>",
        "</recent>",
      ].join("\n")}
    />
  ),
}

export const GitLog = {
  render: () => (
    <ToolCard
      tool="git"
      input={{ mode: "log" }}
      output={[
        "<log>",
        "a1b2c3d (HEAD -> openfork, origin/openfork) feat(session-ui): premium tool UI overhaul",
        "9f8e7d6 fix(session-ui): shell timer badge styling",
        "1234567 chore: regenerate client and sdk-next generated types",
        "</log>",
      ].join("\n")}
    />
  ),
}

export const GitDiff = {
  render: () => (
    <ToolCard
      tool="git"
      input={{ mode: "diff" }}
      output={[
        '<diff staged="false">',
        "diff --git a/src/components/shell-timer.tsx b/src/components/shell-timer.tsx",
        "index 1111111..2222222 100644",
        "--- a/src/components/shell-timer.tsx",
        "+++ b/src/components/shell-timer.tsx",
        "@@ -70,7 +70,7 @@",
        "-  return <span>old</span>",
        "+  return <span>new hourglass badge</span>",
        "</diff>",
      ].join("\n")}
    />
  ),
}

export const GitCommit = {
  render: () => (
    <ToolCard
      tool="git"
      input={{ mode: "commit", message: "feat: add premium tool UI" }}
      output={[
        '<commit applied="true">',
        "  <commit>a1b2c3d feat: add premium tool UI</commit>",
        '  <status clean="true" />',
        "</commit>",
      ].join("\n")}
    />
  ),
}

export const TypecheckPassed = {
  render: () => (
    <ToolCard
      tool="typecheck"
      input={{ mode: "changed" }}
      output={[
        '<typecheck mode="changed" status="passed" errors="0" truncated="false">',
        '<scope mode="changed" files="2">',
        "  <file>packages/session-ui/src/components/shell-timer.tsx</file>",
        "  <file>packages/session-ui/src/components/git-tool.tsx</file>",
        "</scope>",
        "<tsconfig>packages/session-ui/tsconfig.json</tsconfig>",
        '<summary status="passed" errors="0" bin="tsgo" exit="0">',
        "<triage>",
        "  <p0>0</p0>",
        "  <p1>0</p1>",
        "  <p2>0</p2>",
        "  <p3>0</p3>",
        "</triage>",
        "<clusters>",
        "</clusters>",
        "<next>",
        "  No errors detected in the selected scope.",
        "</next>",
        "</typecheck>",
      ].join("\n")}
    />
  ),
}

export const TypecheckFailed = {
  render: () => (
    <ToolCard
      tool="typecheck"
      input={{ mode: "file", filePath: "packages/session-ui/src/components/git-tool.tsx" }}
      output={[
        '<typecheck mode="file" status="failed" errors="2" truncated="false">',
        '<scope mode="file" files="1">',
        "  <file>packages/session-ui/src/components/git-tool.tsx</file>",
        "</scope>",
        "<tsconfig>packages/session-ui/tsconfig.json</tsconfig>",
        '<summary status="failed" errors="2" bin="tsgo" exit="1">',
        "<triage>",
        "  <p0>1</p0>",
        "  <p1>1</p1>",
        "  <p2>0</p2>",
        "  <p3>0</p3>",
        "</triage>",
        "<clusters>",
        '  <cluster code="TS2322" severity="P0" category="type" occurrences="1" files="1"/>',
        "</clusters>",
        "<diagnostics>",
        '  <diagnostic file="packages/session-ui/src/components/git-tool.tsx" line="42" column="10" code="TS2322" severity="P0" category="type">',
        "    <message>Type 'string | undefined' is not assignable to type 'string'.</message>",
        "    <suggestion>Add a fallback value or narrow with a Show/when guard before use.</suggestion>",
        "  </diagnostic>",
        '  <diagnostic file="packages/session-ui/src/components/git-tool.tsx" line="88" column="3" code="TS6133" severity="P1" category="lint">',
        "    <message>'unused' is declared but its value is never read.</message>",
        "    <suggestion>Remove the unused declaration.</suggestion>",
        "  </diagnostic>",
        "</diagnostics>",
        "<next>",
        "  Fix in P0→P1 order first (1 P0, 1 P1).",
        "</next>",
        "</typecheck>",
      ].join("\n")}
    />
  ),
}

export const SqliteQuery = {
  render: () => (
    <ToolCard
      tool="sqlite"
      input={{ action: "query", db: "app.db", sql: "select id, name, created_at from users limit 3" }}
      output={[
        " id | name  | created_at          ",
        "----+-------+---------------------",
        "  1 | alice | 2026-01-01T10:00:00 ",
        "  2 | bob   | 2026-01-02T11:15:00 ",
        "  3 | carol | 2026-01-03T09:30:00 ",
        "(3 rows, 1.2 ms)",
      ].join("\n")}
    />
  ),
}

export const SqliteSchema = {
  render: () => (
    <ToolCard
      tool="sqlite"
      input={{ action: "schema", db: "app.db" }}
      output={[
        "CREATE TABLE users (",
        "  id INTEGER PRIMARY KEY,",
        "  name TEXT NOT NULL,",
        "  created_at TEXT NOT NULL",
        ");",
      ].join("\n")}
    />
  ),
}

export const SympyOk = {
  render: () => (
    <ToolCard
      tool="sympy"
      input={{ expr: "sqrt(8)", operation: "simplify" }}
      output={[
        '<sympy status="ok" kind="expr" duration="12 ms">',
        "  <call>simplify(sqrt(8))</call>",
        "  <result>2*sqrt(2)</result>",
        "</sympy>",
      ].join("\n")}
    />
  ),
}

export const SympyError = {
  render: () => (
    <ToolCard
      tool="sympy"
      input={{ expr: "1/(x-x)", operation: "simplify" }}
      output={[
        '<sympy status="error" kind="expr" duration="8 ms">',
        "  <error>ZeroDivisionError: division by zero</error>",
        "  <suggestion>Check for singularities before simplifying; consider limit() instead.</suggestion>",
        "  <call>simplify(1/(x-x))</call>",
        "</sympy>",
      ].join("\n")}
    />
  ),
}

export const Test = {
  render: () => (
    <ToolCard
      tool="test"
      input={{ action: "run", path: "packages/session-ui" }}
      output={"PASS  src/components/shell-timer.test.ts\n  ✓ formats elapsed time\n\n1 test passed."}
    />
  ),
}

export const Json = {
  render: () => (
    <ToolCard
      tool="json"
      input={{ mode: "query", path: "package.json", query: "$.dependencies" }}
      output={JSON.stringify({ solid: "^1.9.0", effect: "^3.0.0" }, null, 2)}
    />
  ),
}

export const Archive = {
  render: () => (
    <ToolCard
      tool="archive"
      input={{ action: "list", path: "dist/release.zip" }}
      output={["dist/index.js", "dist/index.js.map", "README.md"].join("\n")}
    />
  ),
}

export const Project = {
  render: () => (
    <ToolCard
      tool="project"
      input={{ action: "snapshot", tier: "summary" }}
      output={"Workspace: opencode\nPackages: 24\nPrimary language: TypeScript"}
    />
  ),
}

export const Symbols = {
  render: () => (
    <ToolCard
      tool="symbols"
      input={{ action: "search", query: "ShellTimer" }}
      output={"packages/session-ui/src/components/shell-timer.tsx:41: export function ShellTimer(props)"}
    />
  ),
}

export const BrowserClick = {
  render: () => (
    <ToolCard tool="browser_click" input={{ selector: "button.submit" }} output={"Clicked button.submit"} />
  ),
}

export const BrowserNavigate = {
  render: () => (
    <ToolCard
      tool="browser_navigate"
      input={{ url: "https://opencode.ai" }}
      output={"Navigated to https://opencode.ai"}
    />
  ),
}
