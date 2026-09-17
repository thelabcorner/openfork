# T1 — Schema contracts, tables, migration

**Depends on:** T0  
**Blocks:** T3  
**Read first:** `01-architecture.md` § 3

## Scope

1. Add a `scheduled-task` schema module to the schema package, mirroring
the
   shape and conventions of the existing `goal` schema module: branded ID,
   `Info` struct, `Schedule` union, `Target` union, `Action`, `Policy`,
   `Run`, and an `Event` object exporting `Definitions`.
2. Register the event definitions in the event manifest the same way
the
   goal definitions are spread in. Do not add a side-channel.
3. Add `sql.ts` for the core package defining `scheduled_task`,
   `scheduled_task_lease`, and `scheduled_task_run` exactly as specified
in
   01 § 3, including every index.
4. Generate a timestamped migration using the repo's existing migration
   generation flow. **Hand-writing a migration file is not
acceptable** —
   follow the same path every other migration in `database/migration/`
   was produced by, and let `migration.gen.ts` and `schema.gen.ts`
update
   themselves.

## Non-negotiables

- The unique index on `(task_id, fire_for)` **must** exist. It is the
  last line of defence against duplicate unattended runs.
- `scheduled_task_run` external references (`session_id`, `workspace_id`)
  are **scalar columns, not foreign keys**, following the `goal_evidence`
  precedent — deleting a session must not erase run history.
- `target_directory` is `NOT NULL`.
- All timestamps are integer epoch millis, UTC. No local-time columns.

## Verification

- Migration applies cleanly on a fresh database and on a copy of an
  existing one.
- Inserting two rows with the same `(task_id, fire_for)` fails (this
is
  fixture C3 from 05).
- Workspace typechecks.
