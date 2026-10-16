import type { Meta, StoryObj } from "storybook-solidjs"
import { CodeOutput } from "./code-tool"
import { BasicTool } from "./basic-tool"
import { DataProvider } from "../context"

const meta: Meta<typeof CodeOutput> = {
  title: "UI/CodeTool",
  component: CodeOutput,
  decorators: [
    (Story) => (
      <DataProvider
        data={{
          session: [],
          session_status: {},
          session_diff: {},
          message: {},
          part: {},
        }}
        directory="/workspace/openfork"
      >
        <div style={{ "max-width": "640px", padding: "16px" }}>
          <Story />
        </div>
      </DataProvider>
    ),
  ],
}

export default meta
type Story = StoryObj<typeof CodeOutput>

export const CodeRunSuccess: Story = {
  render: () => (
    <BasicTool
      icon="code"
      trigger={{
        title: "Code",
        subtitle: "Run",
        result: "4 calls · exit 0",
        resultTone: "success",
      }}
      defaultOpen
    >
      <CodeOutput
        input={{
          action: "run",
          code: `// Confined orchestration run
const files = await call("glob", { pattern: "**/*.ts" });
const target = files.slice(0, 3);
const contents = await Promise.all(
  target.map(f => call("read", { filePath: f }))
);
return { analyzed: contents.length, files: target };`,
        }}
        metadata={{
          action: "run",
          runID: "run_8f9a2b1c4e",
          sourceHash: "sha256_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          calls: { total: 4, failed: 0 },
          trace: {
            counters: { calls: 4, failed: 0, active: 0 },
            frames: [
              { ref: "builtin/glob", kind: "tool", status: "succeeded", durationMs: 14 },
              { ref: "builtin/read", kind: "tool", status: "succeeded", durationMs: 4 },
              { ref: "builtin/read", kind: "tool", status: "succeeded", durationMs: 6 },
              { ref: "builtin/read", kind: "tool", status: "succeeded", durationMs: 5 },
            ],
          },
        }}
        output={JSON.stringify({
          ok: true,
          runID: "run_8f9a2b1c4e",
          sourceHash: "sha256_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          replayable: true,
          value: {
            analyzed: 3,
            files: ["src/index.ts", "src/runtime.ts", "src/schema.ts"],
          },
          calls: { total: 4, failed: 0 },
        })}
      />
    </BasicTool>
  ),
}

export const CodeRunWithFailedTrace: Story = {
  render: () => (
    <BasicTool
      icon="code"
      status="error"
      trigger={{
        title: "Code",
        subtitle: "Run",
        result: "1 failed call",
        resultTone: "danger",
      }}
      defaultOpen
    >
      <CodeOutput
        input={{
          action: "run",
          code: `const data = await call("fetch_api", { endpoint: "/v1/metrics" });
return data;`,
        }}
        metadata={{
          action: "run",
          runID: "run_7c11a0f9",
          sourceHash: "sha256_9182aef1",
          error: true,
          calls: { total: 1, failed: 1 },
          trace: {
            counters: { calls: 1, failed: 1, active: 0 },
            frames: [
              { ref: "network/fetch_api", kind: "tool", status: "failed", durationMs: 1042 },
            ],
          },
        }}
        output={JSON.stringify({
          ok: false,
          runID: "run_7c11a0f9",
          error: {
            kind: "CapabilityFailed",
            message: "HTTP 502 Bad Gateway: Upstream endpoint timed out after 1000ms.",
            recovery: "Inspect the exact capability contract with code.describe, retry with a higher timeout or verify server status.",
          },
          calls: { total: 1, failed: 1 },
        })}
      />
    </BasicTool>
  ),
}

export const CodeSearchCapabilities: Story = {
  render: () => (
    <BasicTool
      icon="code"
      trigger={{
        title: "Code",
        subtitle: "Search",
        result: "3 capabilities",
        resultTone: "neutral",
      }}
      defaultOpen
    >
      <CodeOutput
        input={{
          action: "search",
          query: "git",
          target: "callable",
        }}
        metadata={{
          action: "search",
        }}
        output={JSON.stringify({
          items: [
            {
              ref: "host/git.status",
              description: "Query repository working directory status, staged and unstaged changes.",
              kind: "capability",
              scope: "project",
              tags: ["git", "vcs", "status"],
            },
            {
              ref: "host/git.diff",
              description: "Compute unified diff against target commit, branch or staging index.",
              kind: "capability",
              scope: "project",
              tags: ["git", "diff", "patch"],
            },
            {
              ref: "host/git.commit",
              description: "Create a signed durable git commit from current staged changes.",
              kind: "capability",
              scope: "project",
              tags: ["git", "commit"],
            },
          ],
        })}
      />
    </BasicTool>
  ),
}

export const CodeDescribeCapability: Story = {
  render: () => (
    <BasicTool
      icon="code"
      trigger={{
        title: "Code",
        subtitle: "Describe",
        result: "host/git.diff",
        resultTone: "neutral",
      }}
      defaultOpen
    >
      <CodeOutput
        input={{
          action: "describe",
          ref: "host/git.diff",
        }}
        metadata={{
          action: "describe",
        }}
        output={JSON.stringify({
          ref: "host/git.diff",
          kind: "capability",
          description: "Compute unified diff between tree objects or working copy.",
          executionContract: "confined-async-v1",
          schema: {
            type: "object",
            properties: {
              target: { type: "string", description: "Target ref or commit hash" },
              staged: { type: "boolean", default: false },
            },
            required: ["target"],
          },
        })}
      />
    </BasicTool>
  ),
}

export const CodeSavePromotion: Story = {
  render: () => (
    <BasicTool
      icon="code"
      trigger={{
        title: "Code",
        subtitle: "Save",
        result: "saved:project:repo-analyzer",
        resultTone: "success",
      }}
      defaultOpen
    >
      <CodeOutput
        input={{
          action: "save",
          runID: "run_8f9a2b1c4e",
          save: {
            name: "repo-analyzer",
            description: "Analyze project code files and extract high-level metrics",
            scope: "project",
          },
        }}
        metadata={{
          action: "save",
          runID: "run_8f9a2b1c4e",
          sourceHash: "sha256_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          saved: {
            id: "repo-analyzer",
            revision: "rev_01j8f9a2b1",
            handle: "project:repo-analyzer",
            path: ".openfork/saved/project/repo-analyzer.json",
          },
        }}
        output={JSON.stringify({
          ok: true,
          runID: "run_8f9a2b1c4e",
          sourceHash: "sha256_e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          saved: {
            id: "repo-analyzer",
            revision: "rev_01j8f9a2b1",
            handle: "project:repo-analyzer",
            path: ".openfork/saved/project/repo-analyzer.json",
          },
        })}
      />
    </BasicTool>
  ),
}
