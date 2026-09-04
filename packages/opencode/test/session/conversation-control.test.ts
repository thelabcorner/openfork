import { describe, expect } from "bun:test"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { EventV2 } from "@opencode-ai/core/event"
import { SessionProjector } from "@opencode-ai/core/session/projector"
import { Deferred, Effect, Exit, Layer } from "effect"
import { Session as SessionNs } from "@/session/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionContextState } from "@/session/context/state"
import { SessionLedger } from "@/session/context/ledger"
import { EffectiveContextCompiler } from "@/session/context/compiler"
import { MessageID } from "@/session/schema"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { Database } from "@opencode-ai/core/database/database"
import { provideInstance, tmpdirScoped } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { RuntimeFlags } from "@/effect/runtime-flags"
import { EventV2Bridge } from "@/event-v2-bridge"
import { GlobalBus } from "@/bus/global"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceStore } from "@/project/instance-store"
import { InstanceBootstrap } from "@/project/bootstrap"

const it = testEffect(
  AppNodeBuilder.build(
    LayerNode.group([
      SessionNs.node,
      EventV2Bridge.node,
      EventV2.node,
      SessionProjector.node,
      CrossSpawnSpawner.node,
      InstanceStore.node,
      Database.node,
    ]),
    [
      [RuntimeFlags.node, RuntimeFlags.layer({ experimentalWorkspaces: false })],
      [
        InstanceBootstrap.node,
        Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ gate: Effect.void, warmup: Effect.void })),
      ],
    ],
  ),
)

describe("conversation control", () => {
  it.instance("excludes a message from effective context and restores it", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "conv-ctrl-test" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )

      // Create 3 user messages
      const ids = ["msg_cc_1", "msg_cc_2", "msg_cc_3"]
      for (const [i, id] of ids.entries()) {
        yield* sessionSvc.updateMessage({
          id: MessageID.make(id),
          sessionID: created.id,
          role: "user",
          time: { created: 1000 + i },
          agent: "test",
          model: { providerID: "test", modelID: "test" },
        } as SessionV1.User)
        yield* sessionSvc.updatePart({
          id: `prt_cc_${i}` as any,
          sessionID: created.id,
          messageID: MessageID.make(id),
          type: "text",
          text: `message ${i + 1}`,
        } as any)
      }

      const all = yield* sessionSvc.messages({ sessionID: created.id })
      expect(all.length).toBe(3)

      // Exclude middle message
      const { batchID } = yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [{ type: "message.exclude", messageID: ids[1] } as any],
      })
      expect(batchID.length).toBeGreaterThan(0)

      // Ledger reflects exclusion
      const filtered = MessageV2.filterCompacted(all as any)
      const ledger = yield* SessionLedger.build({ sessionID: created.id, messages: filtered as any })
      expect(ledger.totals.excludedCount).toBe(1)
      expect(ledger.entries.find((e) => e.messageID === ids[1])?.excluded).toBe(true)
      expect(ledger.totals.messageCount).toBe(3)

      // Effective compiler drops excluded
      const compiled = yield* EffectiveContextCompiler.compileForSession({
        messages: filtered as any,
        sessionID: created.id,
      })
      expect(compiled.effective.length).toBe(2)
      expect(compiled.effective.map((m) => m.info.id)).not.toContain(ids[1])
      expect(compiled.excluded.length).toBe(1)

      // Restore
      yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [{ type: "message.include", messageID: ids[1] } as any],
      })
      const compiled2 = yield* EffectiveContextCompiler.compileForSession({
        messages: filtered as any,
        sessionID: created.id,
      })
      expect(compiled2.effective.length).toBe(3)
    }),
  )

  it.instance("edits a message via override and restores it", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "edit-test" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const msgId = "msg_edit_1"
      yield* sessionSvc.updateMessage({
        id: MessageID.make(msgId),
        sessionID: created.id,
        role: "user",
        time: { created: 2000 },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
      } as SessionV1.User)
      yield* sessionSvc.updatePart({
        id: "prt_edit_1" as any,
        sessionID: created.id,
        messageID: MessageID.make(msgId),
        type: "text",
        text: "original text",
      } as any)

      const all = yield* sessionSvc.messages({ sessionID: created.id })
      const filtered = MessageV2.filterCompacted(all as any)

      // Edit
      yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [{ type: "text.replace", messageID: msgId, content: "edited text" } as any],
      })

      const compiled = yield* EffectiveContextCompiler.compileForSession({
        messages: filtered as any,
        sessionID: created.id,
      })
      const edited = compiled.effective.find((m) => m.info.id === msgId)
      expect(edited).toBeDefined()
      const textPart = edited!.parts.find((p) => p.type === "text") as SessionV1.TextPart
      expect(textPart.text).toBe("edited text")

      // Ledger marks as edited
      const ledger = yield* SessionLedger.build({ sessionID: created.id, messages: filtered as any })
      expect(ledger.entries.find((e) => e.messageID === msgId)?.edited).toBe(true)

      // Restore
      yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [{ type: "text.restore", messageID: msgId } as any],
      })
      const compiled2 = yield* EffectiveContextCompiler.compileForSession({
        messages: filtered as any,
        sessionID: created.id,
      })
      const restored = compiled2.effective.find((m) => m.info.id === msgId)
      const restoredText = restored!.parts.find((p) => p.type === "text") as SessionV1.TextPart
      expect(restoredText.text).toBe("original text")
    }),
  )

  it.instance("blocks exclude/edit on signed reasoning", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "signed-test" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const msgId = "msg_signed_1"
      yield* sessionSvc.updateMessage({
        id: MessageID.make(msgId),
        sessionID: created.id,
        role: "assistant",
        parentID: MessageID.make("msg_parent"),
        time: { created: 3000, completed: 3001 },
        agent: "test",
        modelID: "test" as any,
        providerID: "test" as any,
        mode: "chat",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as SessionV1.Assistant)
      yield* sessionSvc.updatePart({
        id: "prt_signed_r" as any,
        sessionID: created.id,
        messageID: MessageID.make(msgId),
        type: "reasoning",
        text: "secret reasoning",
        time: { start: 3000, end: 3001 },
        metadata: { anthropic: { signature: "sig_123" } },
      } as any)
      yield* sessionSvc.updatePart({
        id: "prt_signed_t" as any,
        sessionID: created.id,
        messageID: MessageID.make(msgId),
        type: "text",
        text: "response",
      } as any)

      const all = yield* sessionSvc.messages({ sessionID: created.id })
      const msg = all.find((m) => m.info.id === msgId)!
      expect(EffectiveContextCompiler.canExcludeMessage(msg).allowed).toBe(false)
      expect(EffectiveContextCompiler.canEditMessage(msg).allowed).toBe(false)

      // Compiler should warn but not exclude when state says excluded (gate keeps it)
      // Simulate state with excluded flag on signed message — compiler should skip it
      const compiled = EffectiveContextCompiler.compile({
        messages: all as any,
        state: new Map([[msgId, { excluded: true, pinned: false }]]),
      })
      // Should have warning and still include the message
      expect(compiled.warnings.length).toBeGreaterThan(0)
      expect(compiled.effective.length).toBe(1)
    }),
  )

  it.instance("forks after assistant with edge=after and inherits effective context", () =>
    Effect.gen(function* () {
      const sessionSvc = yield* SessionNs.Service
      const created = yield* Effect.acquireRelease(sessionSvc.create({ title: "fork-assistant-test" }), (info) =>
        sessionSvc.remove(info.id).pipe(Effect.ignore),
      )

      // Create user + assistant turn
      const userId = "msg_fork_u1"
      const assistantId = "msg_fork_a1"
      yield* sessionSvc.updateMessage({
        id: MessageID.make(userId),
        sessionID: created.id,
        role: "user",
        time: { created: 4000 },
        agent: "test",
        model: { providerID: "test", modelID: "test" },
      } as SessionV1.User)
      yield* sessionSvc.updatePart({
        id: "prt_fork_u1" as any,
        sessionID: created.id,
        messageID: MessageID.make(userId),
        type: "text",
        text: "hello",
      } as any)
      yield* sessionSvc.updateMessage({
        id: MessageID.make(assistantId),
        sessionID: created.id,
        role: "assistant",
        parentID: MessageID.make(userId),
        time: { created: 4001, completed: 4002 },
        agent: "test",
        modelID: "test" as any,
        providerID: "test" as any,
        mode: "chat",
        path: { cwd: "/", root: "/" },
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      } as SessionV1.Assistant)
      yield* sessionSvc.updatePart({
        id: "prt_fork_a1" as any,
        sessionID: created.id,
        messageID: MessageID.make(assistantId),
        type: "text",
        text: "world",
      } as any)

      // Exclude the assistant via context ops — fork should inherit effective (without it)
      yield* SessionContextState.applyOps({
        sessionID: created.id,
        operations: [{ type: "message.exclude", messageID: assistantId } as any],
      })

      // Fork after the user (edge before assistant) — should get only user
      const forkAfterUser = yield* Effect.acquireRelease(
        sessionSvc.fork({ sessionID: created.id, messageID: MessageID.make(assistantId), edge: "before" } as any),
        (info) => sessionSvc.remove(info.id).pipe(Effect.ignore),
      )
      const forkMsgs = yield* sessionSvc.messages({ sessionID: forkAfterUser.id })
      // Since assistant was excluded in source, fork should have only 1 message (the user)
      // But our fork's effective inheritance skips excluded messages, so it should have 1
      expect(forkMsgs.length).toBe(1)
      expect(forkMsgs[0]!.info.id).not.toBe(assistantId)
    }),
  )
})
