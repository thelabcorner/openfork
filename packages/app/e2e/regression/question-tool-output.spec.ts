import { base64Encode } from "@opencode-ai/core/util/encode"
import { expect, test } from "@playwright/test"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/QuestionOutput"
const projectID = "proj_question_output"
const sessionID = "ses_question_output"
const title = "Question output visual"

const userMessageID = "msg_user_question"
const assistantMessageID = "msg_assistant_question"

const questions = [
  {
    header: "SSH goal",
    question: "What do you want to accomplish with SSH on your local network?",
    multiple: true,
    options: [
      {
        label: "Run an SSH server on this machine",
        description: "Install/configure OpenSSH Server on this Windows PC so other LAN machines can connect in",
      },
      {
        label: "Connect out to other LAN machines",
        description: "Set up the SSH client and config so this machine can reach other hosts",
      },
      { label: "Passwordless key auth", description: "Generate/install SSH keys so you can log in without passwords" },
      {
        label: "Verify/audit current setup",
        description: "Check what's already installed and configured before changing anything",
      },
    ],
  },
  {
    header: "Scope",
    question: "Which machine(s) are involved?",
    options: [
      { label: "This Windows machine only", description: "Set up SSH on the current host" },
      { label: "This machine + specific others", description: "I'll tell you the other hosts / OSes" },
      { label: "All machines on the LAN", description: "A full rollout across several hosts" },
    ],
  },
]

const answers = [
  [
    "Run an SSH server on this machine",
    "Connect out to other LAN machines",
    "Passwordless key auth",
    "Verify/audit current setup",
  ],
  ["All machines on the LAN"],
]

test("question tool expanded output", async ({ page }) => {
  await mockOpenCodeServer(page, {
    protocol: "v2",
    directory,
    project: {
      id: projectID,
      worktree: directory,
      vcs: "git",
      name: "question-output",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: {
      all: [
        {
          id: "opencode",
          name: "OpenCode",
          models: {
            "claude-opus-4-6": { id: "claude-opus-4-6", name: "Claude Opus 4.6", limit: { context: 200_000 } },
          },
        },
      ],
      connected: ["opencode"],
      default: { providerID: "opencode", modelID: "claude-opus-4-6" },
    },
    sessions: [
      {
        id: sessionID,
        slug: "question-output",
        projectID,
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    pageMessages: () => ({
      items: [
        {
          info: {
            id: userMessageID,
            sessionID,
            role: "user",
            time: { created: 1700000000000 },
          },
          parts: [
            {
              id: "prt_user_text",
              sessionID,
              messageID: userMessageID,
              type: "text",
              text: "Help me set up SSH.",
            },
          ],
        },
        {
          info: {
            id: assistantMessageID,
            sessionID,
            role: "assistant",
            agent: "build",
            time: { created: 1700000001000, completed: 1700000002000 },
            providerID: "opencode",
            modelID: "claude-opus-4-6",
            cost: 0,
            tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
            path: { cwd: directory, root: directory },
            system: [],
          },
          parts: [
            {
              id: "prt_question_tool",
              sessionID,
              messageID: assistantMessageID,
              type: "tool",
              callID: "call_question",
              tool: "question",
              state: {
                status: "completed",
                input: { questions },
                output: "answered",
                title: "Questions",
                metadata: { answers, details: ["", "(aka my homelab + my workstation)"] },
                time: { start: 1700000001000, end: 1700000002000 },
              },
            },
          ],
        },
      ],
    }),
  })
  await page.addInitScript(() => {
    localStorage.setItem("settings.v3", JSON.stringify({ general: { newLayoutDesigns: true } }))
    localStorage.setItem("opencode-color-scheme", "dark")
  })

  await page.goto(`/${base64Encode(directory)}/session/${sessionID}`)
  await expectSessionTitle(page, title)

  const answersBlock = page.locator('[data-component="question-answers"]')
  await expect(answersBlock).toBeVisible()

  const items = answersBlock.locator('[data-slot="question-answer-item"]')
  await expect(items).toHaveCount(2)

  // Every offered option is recorded, with only the chosen ones marked, so the
  // transcript shows the road not taken alongside the decision.
  const first = items.first()
  await expect(first.locator('[data-slot="question-answer-option"]')).toHaveCount(4)
  await expect(first.locator('[data-slot="question-answer-option"][data-picked="true"]')).toHaveCount(4)

  const second = items.nth(1)
  await expect(second.locator('[data-slot="question-answer-option"]')).toHaveCount(3)
  const picked = second.locator('[data-slot="question-answer-option"][data-picked="true"]')
  await expect(picked).toHaveCount(1)
  await expect(picked).toContainText("All machines on the LAN")

  // Free-form detail survives verbatim.
  await expect(second.locator('[data-slot="question-answer-detail-body"]')).toHaveText(
    "(aka my homelab + my workstation)",
  )

  // The option list shrinks to its content; stretching it paints selected-row
  // highlights across the full width of the transcript pane.
  const listWidth = await first
    .locator('[data-slot="question-answer-options"]')
    .evaluate((el) => el.getBoundingClientRect().width)
  const blockWidth = await answersBlock.evaluate((el) => el.getBoundingClientRect().width)
  expect(listWidth).toBeLessThan(blockWidth)

  // Descriptions share a left edge rather than starting ragged behind labels.
  const descriptionLefts = await first
    .locator('[data-slot="question-answer-option-description"]')
    .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().left)))
  expect(new Set(descriptionLefts).size).toBe(1)

  // The collapsed row shows a gist, not every pick joined end to end.
  const subtitle = page.locator('[data-slot="basic-tool-tool-subtitle"]').first()
  await expect(subtitle).toContainText("+2")
})
