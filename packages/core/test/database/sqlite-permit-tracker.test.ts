import { expect, test } from "bun:test"
import { Effect, Exit, Fiber, Semaphore } from "effect"
import { makeSqlitePermitTracker } from "../../src/database/sqlite-permit-tracker"

test("timed-out SQLite waiters report the owning permit and the active statement class", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const permit = makeSqlitePermitTracker(yield* Semaphore.make(1), 25, "primary")
    yield* permit.take
    const endStatement = permit.statement("/* comment */ SELECT secret_value FROM sensitive_table WHERE id = ?", "SessionSearch.search")
    const timedWaiter = yield* permit.take.pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
    const timeout = yield* Fiber.join(timedWaiter)
    expect(Exit.isFailure(timeout)).toBe(true)
    if (Exit.isFailure(timeout)) {
      const description = JSON.stringify(timeout.cause)
      expect(description).toContain("sql=SELECT")
      expect(description).toContain("lane=primary")
      expect(description).toMatch(/heldMs=\d+/)
      expect(description).toContain("pending=1")
      expect(description).toContain("sqlShape=tables=other joins=0")
      expect(description).toContain("sqlOrigin=SessionSearch.search")
      expect(description).not.toContain("secret_value")
      expect(description).not.toContain("sensitive_table")
    }
    endStatement()

    const idleWaiter = yield* permit.take.pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
    const idle = yield* Fiber.join(idleWaiter)
    expect(Exit.isFailure(idle)).toBe(true)
    if (Exit.isFailure(idle)) {
      const description = JSON.stringify(idle.cause)
      expect(description).toContain("sql=idle")
      expect(description).toContain("lastSql=SELECT")
      expect(description).toContain("statements=1")
      expect(description).toMatch(/idleMs=\d+/)
    }

    yield* permit.release
    yield* permit.take
    yield* permit.release
  }))
})

test("reentrant acquisition in the owner fiber fails immediately without releasing the owner", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const permit = makeSqlitePermitTracker(yield* Semaphore.make(1), 5_000, "primary")
    yield* permit.take
    const start = performance.now()
    const attempt = yield* Effect.exit(permit.take)
    expect(Exit.isFailure(attempt)).toBe(true)
    expect(performance.now() - start).toBeLessThan(100)
    if (Exit.isFailure(attempt)) {
      const reason = JSON.stringify(attempt.cause)
      expect(reason).toContain("already owned by current fiber")
      expect(reason).toContain("ownerFiber=")
      expect(reason).toContain("pending=0")
    }
    const follower = yield* permit.take.pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
    const early = yield* Effect.race(
      Fiber.await(follower).pipe(Effect.as(true)),
      Effect.sleep("20 millis").pipe(Effect.as(false)),
    )
    expect(early).toBe(false)
    yield* permit.release
    expect(Exit.isSuccess(yield* Fiber.join(follower))).toBe(true)
    yield* permit.release
  }))
})

test("one contention watcher reports a held connection before timeout, without per-waiter fanout", async () => {
  const reports: string[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const permit = makeSqlitePermitTracker(yield* Semaphore.make(1), 1_000, "primary", {
      firstWarningMs: 15,
      warn: (snapshot) => Effect.sync(() => { reports.push(snapshot) }),
    })
    yield* permit.take
    const a = yield* permit.take.pipe(Effect.forkChild({ startImmediately: true }))
    const b = yield* permit.take.pipe(Effect.forkChild({ startImmediately: true }))
    yield* Effect.sleep(110)
    expect(reports.length).toBe(2)
    expect(reports[0]).toContain("pending=2")
    expect(reports[0]).toContain("ownerFiber=")
    expect(reports[1]).toContain("heldMs=")
    yield* permit.release
    yield* Fiber.join(a)
    yield* permit.release
    yield* Fiber.join(b)
    yield* permit.release
  }))
})

test("diagnostics show the oldest outstanding RPC when multiple statements overlap", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const permit = makeSqlitePermitTracker(yield* Semaphore.make(1), 25, "primary")
    yield* permit.take
    const finishOldest = permit.statement("SELECT secret_oldest FROM private_table WHERE id = ?")
    const finishNewer = permit.statement("UPDATE other_table SET payload = ?")
    const first = yield* permit.take.pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
    const blocked = yield* Fiber.join(first)
    expect(Exit.isFailure(blocked)).toBe(true)
    if (Exit.isFailure(blocked)) {
      const detail = JSON.stringify(blocked.cause)
      expect(detail).toContain("sql=SELECT")
      expect(detail).toContain("sqlInFlight=2")
      expect(detail).toMatch(/sqlHash=[a-f0-9]{8}/)
      expect(detail).toContain("sqlShape=tables=other joins=0")
      expect(detail).not.toContain("secret_oldest")
      expect(detail).not.toContain("private_table")
    }
    finishOldest()
    const second = yield* permit.take.pipe(Effect.exit, Effect.forkChild({ startImmediately: true }))
    const blockedNext = yield* Fiber.join(second)
    expect(Exit.isFailure(blockedNext)).toBe(true)
    if (Exit.isFailure(blockedNext)) {
      const detail = JSON.stringify(blockedNext.cause)
      expect(detail).toContain("sql=UPDATE")
      expect(detail).toContain("sqlInFlight=1")
    }
    finishNewer()
    yield* permit.release
  }))
})

test("a canceled permit waiter does not consume or release the owner's connection", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const permit = makeSqlitePermitTracker(yield* Semaphore.make(1), 5_000)
    yield* permit.take
    const blocked = yield* permit.take.pipe(Effect.forkChild({ startImmediately: true }))
    yield* Effect.sleep(10)
    yield* Fiber.interrupt(blocked)
    const stillBlockedWaiter = yield* permit.take.pipe(
      Effect.timeout("35 millis"), Effect.exit, Effect.forkChild({ startImmediately: true }),
    )
    const stillBlocked = yield* Fiber.join(stillBlockedWaiter)
    expect(Exit.isFailure(stillBlocked)).toBe(true)
    yield* permit.release
    yield* permit.take
    yield* permit.release
  }))
})

test("slow SQLite reports stay privacy-safe and deduplicate repeated query fingerprints", async () => {
  const reports: string[] = []
  await Effect.runPromise(Effect.gen(function* () {
    const permit = makeSqlitePermitTracker(yield* Semaphore.make(1), 1_000, "primary", {
      slowWarningMs: 10,
      slowWarn: (snapshot) => Effect.sync(() => { reports.push(snapshot) }),
    })
    yield* permit.take
    for (let attempt = 0; attempt < 2; attempt++) {
      const end = permit.statement(
        "SELECT token FROM `session` WHERE password = 'private-value' AND session_id = ?",
        "SessionSearch.search",
      )
      yield* Effect.sleep(20)
      end()
    }
    expect(reports).toHaveLength(1)
    expect(reports[0]).toContain("lane=primary sql=SELECT")
    expect(reports[0]).toContain("sqlShape=tables=session")
    expect(reports[0]).toContain("sqlOrigin=SessionSearch.search")
    expect(reports[0]).toMatch(/sqlHash=[a-f0-9]{8}/)
    expect(reports[0]).not.toContain("private-value")
    expect(reports[0]).not.toContain("password")
    expect(reports[0]).not.toContain("session_id")
    yield* permit.release
  }))
})
