import { expect, test } from "bun:test"
import { Database as NativeDatabase } from "bun:sqlite"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { EffectDrizzleSqlite } from "@opencode-ai/effect-drizzle-sqlite"
import { layer as sqliteLayer } from "@opencode-ai/core/database/sqlite.bun"
import dropDuplicateUnique from "../../src/database/migration/20261015194010_oxp_link_redundant_unique"

test("OXP link migration removes only redundant unique index; composite PK remains enforcing deduplication", async () => {
  const directory = await mkdtemp(join(tmpdir(), "openfork-oxp-index-"))
  const filename = join(directory, "legacy.db")
  try {
    const native = new NativeDatabase(filename)
    try {
      native.exec(`
        CREATE TABLE oxp_invocation_link (
          invocation_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          ref TEXT NOT NULL,
          relation TEXT NOT NULL,
          label TEXT,
          PRIMARY KEY(invocation_id, kind, ref, relation)
        );
        CREATE UNIQUE INDEX oxp_invocation_link_invocation_ref_idx
          ON oxp_invocation_link(invocation_id, kind, ref, relation);
        CREATE INDEX oxp_invocation_link_ref_idx ON oxp_invocation_link(kind, ref);
        INSERT INTO oxp_invocation_link(invocation_id,kind,ref,relation)
          VALUES ('i1','session','abc','referenced');
      `)
      const initial = native.query("PRAGMA index_list('oxp_invocation_link')").all() as {name: string}[]
      expect(initial.map(x => x.name)).toContain("oxp_invocation_link_invocation_ref_idx")
      expect(initial.map(x => x.name)).toContain("sqlite_autoindex_oxp_invocation_link_1")
    } finally { native.close() }

    await Effect.runPromise(Effect.gen(function* () {
      const db = yield* EffectDrizzleSqlite.makeWithDefaults()
      yield* db.transaction((tx) => dropDuplicateUnique.up(tx), { behavior: "immediate" })
      // Re-applying the forward migration remains idempotent.
      yield* db.transaction((tx) => dropDuplicateUnique.up(tx), { behavior: "immediate" })
    }).pipe(Effect.provide(sqliteLayer({ filename }))))

    const verify = new NativeDatabase(filename, { readonly: true, create: false })
    try {
      const indexes = verify.query("PRAGMA index_list('oxp_invocation_link')").all() as {name: string}[]
      const names = indexes.map(x => x.name)
      expect(names).not.toContain("oxp_invocation_link_invocation_ref_idx")
      expect(names).toContain("sqlite_autoindex_oxp_invocation_link_1")
      expect(names).toContain("oxp_invocation_link_ref_idx")
      const query = verify.query("EXPLAIN QUERY PLAN SELECT 1 FROM oxp_invocation_link WHERE invocation_id=? AND kind=? AND ref=? AND relation=?").all("i1","session","abc","referenced") as {detail: string}[]
      expect(query.some(x => x.detail.includes("sqlite_autoindex_oxp_invocation_link_1"))).toBe(true)
      expect(verify.query("SELECT count(*) AS total FROM oxp_invocation_link").get()).toEqual({ total: 1 })
    } finally { verify.close() }

    const writable = new NativeDatabase(filename)
    try {
      expect(() => writable.query("INSERT INTO oxp_invocation_link(invocation_id,kind,ref,relation) VALUES ('i1','session','abc','referenced')").run()).toThrow()
      expect(writable.query("SELECT count(*) AS total FROM oxp_invocation_link").get()).toEqual({ total: 1 })
    } finally { writable.close() }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 12_000)
