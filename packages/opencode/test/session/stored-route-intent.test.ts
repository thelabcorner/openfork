import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { Session } from "@/session/session"

// SQLite JSON columns predate the canonical kind:"strategy" discriminator.
// Exercise the real row -> session -> HTTP schema path used by session lists.
type Row = Parameters<typeof Session.fromRow>[0]

function storedRow(routeIntent: unknown): Row {
  return {
    id: "ses_legacy-route",
    slug: "legacy-route",
    project_id: "project-legacy-route",
    workspace_id: null,
    parent_id: null,
    directory: "/example",
    path: null,
    title: "Legacy routing session",
    version: "1.0",
    share_url: null,
    summary_additions: null,
    summary_deletions: null,
    summary_files: null,
    summary_diffs: null,
    metadata: null,
    cost: 0,
    tokens_input: 0,
    tokens_output: 0,
    tokens_reasoning: 0,
    tokens_cache_read: 0,
    tokens_cache_write: 0,
    revert: null,
    permission: null,
    agent: null,
    model: { id: "model-a", providerID: "opencode", routeIntent },
    time_created: 100,
    time_updated: 101,
    time_compacting: null,
    time_archived: null,
    paused_at: null,
    group_id: null,
  } as Row
}

describe("persisted session route-intent read compatibility", () => {
  test.each([
    [{ kind: "auto", strategy: "adaptive" }, { kind: "strategy", strategy: "adaptive" }],
    [{ kind: "auto", strategy: "round-robin" }, { kind: "strategy", strategy: "round-robin" }],
    [{ kind: "auto" }, { kind: "strategy" }],
    [{ kind: "strategy", strategy: "adaptive" }, { kind: "strategy", strategy: "adaptive" }],
    [{ kind: "public" }, { kind: "public" }],
    [{ kind: "account", accountID: "acct-1", pin: "hard" }, { kind: "account", accountID: "acct-1", pin: "hard" }],
  ] as const)("loads %j as canonical %j and emits valid Session.Info", (stored, expected) => {
    const loaded = Session.fromRow(storedRow(stored))
    // bun:test test.each widens tuple literal discriminators in callback
    // inference; the canonical expectation is still a verified Session route.
    const canonical = expected as NonNullable<NonNullable<ReturnType<typeof Session.fromRow>["model"]>["routeIntent"]>
    expect(loaded.model?.routeIntent).toEqual(canonical)
    const response = Schema.encodeSync(Session.Info)(loaded)
    expect(response.model?.routeIntent).toEqual(canonical)
  })

  test("rejects unknown persisted account-routing modes instead of guessing", () => {
    expect(() => Session.fromRow(storedRow({ kind: "auto", strategy: "random" }))).toThrow()
  })
})
