import { benchmark, expect } from "../benchmark"
import { expectSessionTitle } from "../../utils/waits"
import { fixture } from "./session-timeline-stress.fixture"
import {
  collectCachedRepaintTrace,
  compressCachedRepaintTrace,
  installCachedRepaintProbe,
  waitForCachedRepaintWindow,
} from "./session-tab-repaint-probe"
import { waitForStableTimeline } from "./session-tab-switch-probe"
import {
  installStressSessionTabs,
  installTimelineSettings,
  mockStressTimeline,
  stressSessionHref,
} from "./timeline-test-helpers"

benchmark("samples cached session repaint after the click", async ({ page, report }) => {
  benchmark.setTimeout(120_000)
  await mockStressTimeline(page)
  await installStressSessionTabs(page)
  await installTimelineSettings(page)
  await page.goto(stressSessionHref(fixture.targetID))
  await expectSessionTitle(page, fixture.expected.targetTitle)
  await waitForStableTimeline(page, fixture.expected.targetMessageIDs.at(-1)!)
  await page
    .locator(`[data-slot="titlebar-tabs"] a[href="${stressSessionHref(fixture.sourceID)}"]`)
    .first()
    .click()
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await waitForStableTimeline(page, fixture.expected.sourceMessageIDs.at(-1)!)

  await installCachedRepaintProbe(page, {
    targetHref: stressSessionHref(fixture.targetID),
    destination: fixture.messages[fixture.targetID].map((message) => message.info.id),
    source: fixture.messages[fixture.sourceID].map((message) => message.info.id),
    last: fixture.expected.targetMessageIDs.at(-1)!,
    windowMs: 1_000,
  })

  await page
    .locator(`[data-slot="titlebar-tabs"] a[href="${stressSessionHref(fixture.targetID)}"]`)
    .first()
    .click()
  await Promise.all([expectSessionTitle(page, fixture.expected.targetTitle), waitForCachedRepaintWindow(page, 1_000)])
  const result = await collectCachedRepaintTrace(page)
  report(compressCachedRepaintTrace(result))
  expect(result.samples.length).toBeGreaterThan(0)
})

benchmark("serves cached timeline when switching to an open session tab", async ({ page, report }) => {
  // Warming is zero-network by design (bulk cache / child store / lineage peek),
  // so load-time HTTP cannot observe it. The observable contract: after the
  // initial session settles, switching to another open tab must paint its
  // timeline WITHOUT any further messages fetch -- whatever served the cache.
  const messageStarts: { sessionID: string; before?: string }[] = []
  await mockStressTimeline(page, {
    onMessages: (input) => {
      if (input.phase !== "start") return
      messageStarts.push({ sessionID: input.sessionID, before: input.before })
    },
  })
  await installStressSessionTabs(page, {
    sessionIDs: [fixture.sourceID, fixture.targetID, fixture.childID],
  })
  await installTimelineSettings(page)
  await page.goto(stressSessionHref(fixture.sourceID))
  await expectSessionTitle(page, fixture.expected.sourceTitle)
  await waitForStableTimeline(page, fixture.expected.sourceMessageIDs.at(-1)!)

  const warmCalls = messageStarts.length
  await page
    .locator(`[data-slot="titlebar-tabs"] a[href="${stressSessionHref(fixture.childID)}"]`)
    .first()
    .click()
  await Promise.all([
    expectSessionTitle(page, fixture.expected.childTitle),
    waitForStableTimeline(page, fixture.expected.childMessageIDs.at(-1)!),
  ])

  const switchFetches = messageStarts.slice(warmCalls)
  report({
    warmSessions: [...new Set(messageStarts.slice(0, warmCalls).map((call) => call.sessionID))],
    switchFetches,
  })
  expect(switchFetches.filter((call) => call.sessionID === fixture.childID)).toEqual([])
})
