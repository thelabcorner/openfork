import { expect, test, type Page, type TestInfo } from "@playwright/test"
import {
  assistantMessage,
  sessionID,
  setupTimeline,
  shell,
  textPart,
  userMessage,
} from "../performance/timeline-stability/fixture"
import { auditAccessibility, formatViolations } from "../utils/accessibility/axe"
import { describeAcknowledged, partitionViolations } from "../utils/accessibility/baseline"
import { assertInertFixtureText, assertInertFixtureTree } from "../utils/accessibility/fixture-admission"

test("space activates a focused timeline button instead of scrolling", async ({ page }) => {
  const shellID = "prt_space_button_shell"
  await setupTimeline(page, {
    messages: [userMessage(), assistantMessage([shell(shellID, "completed", lines(5))])],
    settings: { shellToolPartsExpanded: false },
    reducedMotion: true,
  })
  const scroller = page.locator(".scroll-view__viewport", { has: page.locator("[data-timeline-row]") })
  const trigger = page.locator(`[data-timeline-part-id="${shellID}"] [data-slot="collapsible-trigger"]`)
  await trigger.focus()
  const before = await scroller.evaluate((element) => element.scrollTop)
  await trigger.press("Space")
  await expect(trigger).toHaveAttribute("aria-expanded", "true")
  expect(await scroller.evaluate((element) => element.scrollTop)).toBe(before)
})

function lines(count: number) {
  return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n")
}

/**
 * axe-core accessibility gate.
 *
 * Scope decisions, so this stays a gate rather than a flaky reporter:
 *
 * - Conformance only: WCAG 2.0/2.1 A+AA tags. `best-practice` rules are
 *   advisory and subjective, so they are excluded upstream in `axe.ts`.
 * - Every scenario asserts its own representative state BEFORE auditing. If the
 *   surface failed to reach the state under test, the run fails on that
 *   assertion instead of quietly auditing whatever idle control happened to be
 *   in scope.
 * - Each scenario audits its own scope, and `auditAccessibility` refuses an empty
 *   scope or a missing axe runtime rather than reporting a clean run.
 * - Themes are the desktop shell default (`oc-2`) plus a high-contrast
 *   alternative (`amoled`), both pinned to `dark` so the palette is deterministic
 *   instead of following the host OS.
 * - These scenarios pass `waitForConnection: false` because they consume only
 *   the initial HTTP-mocked snapshot and send no SSE events, so an event-stream
 *   connection is irrelevant to what they assert. The pre-existing Space-key
 *   regression above keeps the default.
 */
const ACCESSIBILITY_THEMES = [
  { id: "oc-2", colorScheme: "dark" },
  { id: "amoled", colorScheme: "dark" },
] as const

/**
 * Audits `page` and fails on anything outside the reviewed debt baseline.
 *
 * Findings already recorded in `baseline.ts` are attached to the Playwright
 * report as annotations rather than silently dropped, so tolerated debt stays
 * visible on every run and the table can only shrink as the product is fixed.
 */
async function expectNoAccessibilityRegressions(
  page: Page,
  input: { label: string; scope: string },
  testInfo: TestInfo,
) {
  const audit = await auditAccessibility(page, input)
  const { regressed, acknowledged } = partitionViolations(audit.violations)
  testInfo.annotations.push({
    type: "acknowledged-a11y-debt",
    description: `${input.label}: ${describeAcknowledged(acknowledged)}`,
  })
  expect(regressed, formatViolations({ ...audit, violations: regressed })).toEqual([])
}

/**
 * Registered before `setupTimeline` runs, because that helper owns the
 * `page.goto`. Theme keys are disjoint from the `settings.v3` key it writes, so
 * init-script registration order does not matter.
 */
async function applyDeterministicTheme(page: Page, id: string, colorScheme: string) {
  await page.addInitScript(
    ([themeId, scheme]) => {
      localStorage.setItem("opencode-theme-id", themeId)
      localStorage.setItem("opencode-color-scheme", scheme)
    },
    [id, colorScheme] as const,
  )
}

/** Proves the theme really applied, so a themed run cannot silently degrade to the default. */
async function expectThemeApplied(page: Page, id: string, colorScheme: string) {
  const applied = await page.evaluate(() => ({
    theme: document.documentElement.dataset.theme,
    colorScheme: document.documentElement.dataset.colorScheme,
  }))
  expect(applied).toEqual({ theme: id, colorScheme })
}

const TIMELINE_SCOPE = "[data-timeline-row]"
const QUESTION_SCOPE = '[data-component="session-question-card"]'

for (const theme of ACCESSIBILITY_THEMES) {
  test.describe(`${theme.id}/${theme.colorScheme}`, () => {
    test("active working session has no accessibility regressions", async ({ page }, testInfo) => {
      await applyDeterministicTheme(page, theme.id, theme.colorScheme)

      const shellID = assertInertFixtureText("prt_a11y_active_shell", "audit.id")
      const command = assertInertFixtureText("bun install --frozen-lockfile", "audit.command")
      const partial = assertInertFixtureText("Resolving dependencies", "audit.partial")
      // Every fixture string crosses the admission boundary before it can reach
      // the page axe is injected into.
      const messages = assertInertFixtureTree([
        userMessage(),
        assistantMessage([shell(shellID, "running", partial, command)], { completed: false }),
      ])

      await setupTimeline(page, { messages, reducedMotion: true, waitForConnection: false })
      await expectThemeApplied(page, theme.id, theme.colorScheme)

      // Active, not idle: a running shell part on a session the fixture derived
      // a busy status from (the assistant turn has no `time.completed`).
      const tool = page.locator(`[data-timeline-part-id="${shellID}"]`)
      await expect(tool).toBeVisible()
      await expect(tool.locator('[data-component="shell-submessage"]')).toHaveText(command)
      await expect(tool.locator('[data-slot="collapsible-trigger"]')).toHaveAttribute("aria-expanded", "false")

      await expectNoAccessibilityRegressions(page, { label: `active/${theme.id}`, scope: TIMELINE_SCOPE }, testInfo)
    })

    test("settled read-only transcript has no accessibility regressions", async ({ page }, testInfo) => {
      await applyDeterministicTheme(page, theme.id, theme.colorScheme)

      const partID = assertInertFixtureText("prt_a11y_readonly_text", "audit.id")
      const summary = assertInertFixtureText("Audit complete. No further action is required.", "audit.summary")
      // A completed assistant turn makes the transcript read-only: no live
      // execution state remains, unlike the active scenario above.
      const messages = assertInertFixtureTree([
        userMessage(),
        assistantMessage([textPart(partID, summary)], { completed: true }),
      ])

      await setupTimeline(page, { messages, reducedMotion: true, waitForConnection: false })
      await expectThemeApplied(page, theme.id, theme.colorScheme)

      const row = page.locator(`[data-timeline-part-id="${partID}"]`)
      await expect(row).toBeVisible()
      await expect(row).toContainText(summary)
      await expect(page.locator('[data-timeline-row="Thinking"]')).toHaveCount(0)

      await expectNoAccessibilityRegressions(page, { label: `read-only/${theme.id}`, scope: TIMELINE_SCOPE }, testInfo)
    })

    test("selected and disabled question controls are accessible and inert-aware", async ({ page }, testInfo) => {
      await applyDeterministicTheme(page, theme.id, theme.colorScheme)

      const question = assertInertFixtureText("Which environment should ship first?", "audit.question")
      const followUp = assertInertFixtureText("How should we roll out?", "audit.question.followup")
      const staging = assertInertFixtureText("Staging", "audit.option.staging")
      const production = assertInertFixtureText("Production", "audit.option.production")
      const canary = assertInertFixtureText("Canary rollout", "audit.option.canary")
      const allAtOnce = assertInertFixtureText("All at once", "audit.option.all")
      // The live question card is populated by `/api/question/request`, not by a
      // timeline tool part — same source `session-request-docks.spec.ts` uses.
      const questions = assertInertFixtureTree([
        {
          id: "question-a11y",
          sessionID,
          questions: [
            { header: "Deploy", question, options: [{ label: staging }, { label: production }] },
            { header: "Rollout", question: followUp, options: [{ label: canary }, { label: allAtOnce }] },
          ],
        },
      ])

      await setupTimeline(page, { questions, reducedMotion: true, waitForConnection: false })
      await expectThemeApplied(page, theme.id, theme.colorScheme)

      const card = page.locator(QUESTION_SCOPE)
      await expect(card).toBeVisible()

      // selected: exactly one step tab owns the selection, the other is unselected.
      await expect(card.locator('[role="tab"][aria-selected="true"]')).toHaveCount(1)
      await expect(card.locator('[role="tab"][aria-selected="false"]')).toHaveCount(1)

      const options = card.getByRole("radiogroup").getByRole("radio")
      await expect(options).toHaveCount(2)

      // Picking an option moves selection down to aria-checked. Regex name
      // matching mirrors `session-request-docks.spec.ts` for this same card.
      await card.getByRole("radio", { name: new RegExp(staging) }).click()
      const checked = card.locator('[role="radio"][aria-checked="true"]')
      await expect(checked).toHaveCount(1)
      await expect(checked).toContainText(staging)

      // disabled: Back is unreachable on the first step while the header Next
      // stays usable, so the card exercises a disabled and an enabled icon
      // button together. Attribute-selected rather than role+name because the
      // footer also renders a button whose visible text is "Next".
      await expect(card.locator('button[aria-label="Back"]')).toBeDisabled()
      await expect(card.locator('button[aria-label="Next"]')).toBeEnabled()

      // Hidden/inert semantics: the decorative marks are aria-hidden, and none
      // may become a focus stop, which is what `aria-hidden-focus` checks.
      const marks = checked.locator('[aria-hidden="true"]')
      expect(await marks.count()).toBeGreaterThan(0)
      expect(
        await marks.evaluateAll((nodes) =>
          nodes.filter((node) => node.matches("a, button, input, select, textarea, [tabindex]")).length,
        ),
      ).toBe(0)

      await expectNoAccessibilityRegressions(
        page,
        { label: `selected-disabled/${theme.id}`, scope: QUESTION_SCOPE },
        testInfo,
      )
    })

    test("hostile fixture payloads are refused before reaching the audited page", async () => {
      // Admission is the safety property this gate depends on: executable
      // markup in a fixture would run inside the document axe is injected into,
      // and a sanitized payload would audit a document the product can never
      // render. Both are refused outright rather than rewritten.
      expect(() => assertInertFixtureText("prt_a11y_admitted", "audit.id")).not.toThrow()
      expect(() => assertInertFixtureTree({ label: "Staging", output: "sleep 10 && echo done" })).not.toThrow()

      const hostile = [
        "<script>globalThis.__a11yGatePwned = true</script>",
        "<img src=x onerror=alert(1)>",
        "&#x3C;svg onload=alert(1)&#x3E;",
        "javascript:alert(1)",
        "${globalThis.process}",
      ]
      for (const payload of hostile) {
        expect(() => assertInertFixtureText(payload, "audit.leaf")).toThrow(/refusing unsafe accessibility fixture/)
      }
    })
  })
}