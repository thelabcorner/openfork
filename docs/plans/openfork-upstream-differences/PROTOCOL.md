# OpenFork upstream-difference inventory protocol

This directory is campaign evidence for the exhaustive OpenFork ↔ stock OpenCode inventory. It is not product documentation and must not be treated as a shipped feature claim.

## Comparator

- Stock comparator: OpenCode `v1.18.34`, commit `aec0b9a6d8898f68f923aaf08b7306d931fd9d76`.
- OpenFork campaign HEAD at initial realignment: `1d9690291159d425a6efc8bb8bf39fb02d3cf22e`.
- Sync provenance: merge `62b53deaeb977172c460382179f630921a3454a4`, whose second parent is the stock comparator.
- `upstream/dev` is a separate drift axis. Never classify post-`v1.18.34` upstream development as an OpenFork feature.

## Hard completeness rule

The inventory is incomplete while any meaningful divergence from the comparator is unclassified. No “representative”, “major”, “user-facing”, or “worth documenting” filter is permitted.

Account for:

1. rename-aware committed path delta;
2. tracked unstaged delta;
3. staged delta, including explicit zero;
4. every untracked path, including generated/temp/build/debris classification;
5. deletions, replacements, renames, and deliberately pruned upstream paths;
6. semantic/non-path differences: defaults, flags, authority, lifecycle, APIs, protocols, persistence, security, packaging, platform behavior, generated surfaces;
7. live worktree drift that occurs during the campaign;
8. three independent omission-verifier passes.

## Lane shards

Each lane owns only its own shard under `ledger/invXX.md`. Do not overwrite another lane's shard and do not concurrently append to the central ledger.

Each finding must include:

- stable ID
- category
- exact OpenFork path(s)
- exact comparator ref/path(s), or explicit upstream absence
- state: committed / tracked-dirty / untracked / deleted-pruned / mixed
- semantic delta
- impact
- reproducible evidence
- confidence
- README relevance
- documentation destination
- verification state
- observed live-snapshot marker

Every lane must do a final lane-local drift sweep before claiming completion.

## Safety

Never reset, stash, clean, restore, broad-checkout, rebase, stage, commit, mass-format, or overwrite unrelated concurrent work.

README, docs/map, architecture/reference product docs remain blocked until machine coverage is reconciled to zero unexplained meaningful paths and inv27/inv28/inv29 independently pass.
