# Worktree-store sidecar packaging contract

Normative contract for how the desktop stages, verifies, discovers, and pins the
managed `worktree-store` sidecar. Current status: the checked-in
`packages/desktop/worktree-store.lock.json` intentionally pins **no** target
(`version: null`, every target `null`). No release URL, version, or digest is
recorded until a real producer artifact exists; nothing in this repository may
invent one.

## Channel behavior (fail closed)

Source resolution lives in `packages/desktop/scripts/worktree-store-lock.ts`
(`resolveWorktreeStoreSource`) and is preflighted before any expensive build step
by `preflightWorktreeStore` in `packages/desktop/scripts/fetch-worktree-store.ts`.

| Channel | Lock pins target | `OPENFORK_WORKTREE_STORE_DEV_ARCHIVE` | Result |
| --- | --- | --- | --- |
| `dev` | no | unset | staging skipped; a stale staged payload is removed |
| `dev` | no | explicit local path | dev-local payload staged from that path |
| `dev` | yes | unset | pinned archive staged and verified |
| `dev` | yes | set | **error** (`dev-override-rejected`) |
| `beta` / `prod` | no | anything | **error** (`missing-target`), before any download or output write |
| `beta` / `prod` | yes | set | **error** (`dev-override-rejected`) |
| `beta` / `prod` | yes | unset | pinned archive staged and verified |

`dev` staging accepts a directory, `.zip`, or `.tar.gz` payload with any file
names. A dev-local payload can never be released: its `STAGE.json` records
`source: "dev-local"`, replacing it requires an unlock/relock decision, and
`assertPackagedStageStamp` rejects any dev-local stamp found in a packaged
artifact (`dev-local-stamp`).

## Staged layout and runtime discovery

The staged payload root is `packages/desktop/resources/worktree-store/`
(gitignored, produced by `bun run stage:worktree-store`). Electron Builder copies
it outside `app.asar` to `<resources>/worktree-store/`.

The runtime contract is defined once in
`packages/desktop/src/main/worktree-store-layout.ts` and imported by both the
build scripts and `src/main/worktree-store-env.ts`:

- resource directory: `worktree-store` (must land directly under the app's
  `resources` directory, never inside `app.asar` / `app.asar.unpacked`);
- discoverable CLI names: `worktree-store.exe` or `bin/worktree-store.exe`;
- discovery publishes `OPENFORK_WORKTREE_STORE_ROOT` and
  `OPENFORK_WORKTREE_STORE_CLI` only when the root and CLI both exist on disk,
  never overrides explicit environment, and is Windows-only.

Gates enforcing this contract:

- staging: `verifyWorktreeStoreCliDiscoverable` rejects a pinned `cli` outside
  the candidate list (`layout-mismatch`) before downloading anything;
- packaged verification: `scripts/verify-worktree-store-package.ts` checks the
  payload directory name, the pinned `cli`, and that
  `resolveWorktreeStoreSidecarEnv` would publish exactly this root and CLI
  (`layout-mismatch` otherwise).

## Updating the lock (after a real artifact exists)

`packages/desktop/scripts/worktree-store-lock-update.ts`
(`bun run lock:worktree-store`) fills one target from an artifact the operator
names explicitly. It never searches for, guesses, or invents a URL, version, or
digest:

1. Obtain the released artifact and its published URL from the producer release
   (out of scope for this repository).
2. Run, from `packages/desktop`:

   ```sh
   bun ./scripts/worktree-store-lock-update.ts \
     --target <os-arch> \
     --url <https artifact URL> \
     [--archive </local/copy/of/artifact.zip>] \
     [--version <semver must match the bundle manifest>] \
     [--cli <archive-relative CLI path>] [--helper <archive-relative helper path>] \
     [--dry-run]
   ```

3. The updater downloads (or reads `--archive`) the bytes, computes `size` and
   `sha256` from those bytes, extracts the archive, and requires a valid producer
   bundle manifest for the target (`win32-x64` / `win32-arm64` only; the producer
   manifest schema is Windows-only). It refuses non-https URLs, missing
   artifacts, manifest/target mismatches, versions that disagree with the
   bundle manifest, and `cli`/`helper` paths the manifest does not declare.
4. Review the diff (`--dry-run` prints it without writing), run the focused
   tests below, and commit the lock file with the artifact.

The top-level `version` is set only when every pinned target shares one version;
otherwise it stays `null`.

## Focused verification

```sh
cd packages/desktop
bun run test:worktree-store            # lock, stage, verify, packaged, runtime-env, updater tests
bun run typecheck
bun ./scripts/verify-worktree-store-package.ts dist   # after packaging; channel-aware
```

CI runs `bun run test:worktree-store` (`.github/workflows/ci.yml`) and the
packaged verifier after Electron packaging
(`.github/workflows/dev-pre-release.yml`).
