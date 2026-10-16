import { describe, expect, test } from "bun:test"
import type { Auth } from "../../src/auth"
import {
  TelegramNotificationHub,
  type NotificationSource,
} from "../../src/notification/telegram/hub"

function source(id: string, active = true): NotificationSource {
  return {
    id,
    title: id,
    async initialize() {},
    active() { return active },
    async collect() { return [] },
    async clear() {},
  }
}

describe("Telegram notification hub source architecture", () => {
  // These tests intentionally avoid initialize(): tests must not read/write
  // the user's live Telegram configuration or bot token.
  test("supports independent services without importing provider/quota logic", () => {
    const hub = new TelegramNotificationHub({} as Auth.Interface, [
      source("quota"),
      source("agent-runs"),
      source("builds"),
    ])
    expect(hub.sources.map((item) => item.id)).toEqual(["quota", "agent-runs", "builds"])
    expect(hub.sources[1]?.active()).toBe(true)
  })

  test("rejects source identity collisions at construction", () => {
    expect(() => new TelegramNotificationHub({} as Auth.Interface, [source("quota"), source("quota")])).toThrow(
      /Duplicate Telegram notification source identifier/,
    )
  })

  test("independent service opt-in is not tied to a quota source", () => {
    const hub = new TelegramNotificationHub({} as Auth.Interface, [
      source("quota", false),
      source("builds", true),
    ])
    expect(hub.sources[0]?.active()).toBe(false)
    expect(hub.sources[1]?.active()).toBe(true)
  })
})
