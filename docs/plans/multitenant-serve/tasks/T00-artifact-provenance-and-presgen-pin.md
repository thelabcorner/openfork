# T00 - OpenFork artifact provenance and PresGen pin

**Lane:** artifact ownership  
**After:** nothing  
**Unlocks:** T13; provides an early reversible win independent of hosted mode  
**Primary repos:** OpenFork + PresGen  
**Architecture refs:** sections 5.14, 23, 30 phase 0, D1, production operations gates

## Objective

Make PresGen consume a reproducibly identified OpenFork Linux binary while
keeping the current one-serve-per-session topology and API behavior unchanged.

This task intentionally separates **binary ownership** from **multi-tenancy**.
If the hosted architecture is later delayed, PresGen should still be running a
known OpenFork build that we control.

## Why this task exists

PresGen currently downloads `opencode-linux-x64-<version>.tgz` from upstream
npm inside `backend/scripts/prepare_opencode.py`. That prevents PresGen from
depending on OpenFork-only server capabilities without either patching the
container after download or drifting from the source repository.

OpenFork already has a build pipeline in:

- `packages/opencode/script/build.ts`
- output `packages/opencode/dist/opencode-linux-x64/bin/opencode`

The build also supports release tarball packaging. We should use that boundary
rather than teach PresGen to compile OpenFork from source on every sandbox
image build.

## Owned surfaces

### OpenFork

Primary:

- `packages/opencode/script/build.ts`
- build/release metadata helpers under `packages/opencode/script/`
- version/build identity surface under `packages/opencode/src/installation/`
  or an equivalent narrowly scoped build-manifest module
- targeted build tests/smokes

Avoid unrelated desktop/app release machinery unless proven necessary.

### PresGen

Primary:

- `backend/scripts/prepare_opencode.py`
- `backend/agent-sandbox.Dockerfile`
- Docker/build config that supplies the OpenFork version/artifact reference
- focused tests for binary preparation/provenance

Do not alter session spawning semantics in this task.

## Required design

### 1. Define an OpenFork build identity

The runtime must expose enough immutable build identity to distinguish:

- OpenFork vs an upstream binary with the same semantic version;
- exact OpenFork source commit;
- build channel;
- target/platform;
- artifact digest or build-manifest digest where practical.

Do not overload `--version` with a format that breaks existing callers. Prefer
an additive machine-readable command/health/build-manifest surface.

Minimum metadata:

```text
product = openfork
upstreamCompatibleVersion = <semver>
forkCommit = <git sha>
channel = <channel>
target = linux-x64
buildTimestamp or reproducible build id
```

### 2. Produce a pinned artifact

Use OpenFork's existing Bun compile pipeline. Artifact naming may stay
upstream-compatible internally, but PresGen's source URL/pin must point to an
OpenFork-controlled release namespace or build artifact store.

Record SHA-256 in PresGen configuration/build arguments. PresGen must verify the
digest before installing the binary.

### 3. Preserve an explicit rollback artifact

Until T18, retain configuration for the previously known-good upstream binary
or previous OpenFork binary. Rollback must not require a source rebuild.

### 4. Keep runtime topology unchanged

After this task:

```text
PresGen session -> supervisor -> one OpenFork serve process
```

not shared serve.

## Implementation steps

1. Capture current PresGen OpenCode version/source/digest behavior in a focused
   test before changing it.
2. Add OpenFork build identity metadata at compile time.
3. Add a machine-readable probe/smoke that validates the identity.
4. Build Linux x64 using the repo-native script and archive it in the selected
   release/artifact shape.
5. Add checksum generation to the release artifact workflow if absent.
6. Change `prepare_opencode.py` to consume an explicit artifact source +
   expected digest.
7. Fail closed on digest mismatch, malformed archive, missing binary, or build
   identity mismatch.
8. Update sandbox Docker build arguments/configuration.
9. Build the sandbox and run a normal per-session OpenFork smoke.
10. Verify session creation, messaging, tool invocation, stop/abort and cleanup
    are unchanged.

## Validation

Mandatory:

- OpenFork package typecheck for edited TS.
- targeted build metadata tests.
- `bun run script/build.ts --single --skip-embed-web-ui` or the agreed
  reproducible Linux build path in CI/container.
- built binary `--version` smoke.
- built binary build-identity probe.
- SHA-256 verification test: correct digest passes, modified digest fails.
- archive traversal/malformed member test for PresGen extractor.
- PresGen sandbox image build.
- PresGen current per-session agent integration smoke.

## Adversarial checks

- Same upstream-compatible version but wrong product/build identity must fail.
- Digest mismatch must fail before install.
- Missing expected archive member must fail.
- Cache hit path must still validate the cached binary/digest; do not trust a
  filename alone.
- A transient artifact server failure must not silently fall back to an
  unpinned latest build.

## Performance guard

This task must not materially increase container build time for cache hits.
Record:

- cached install duration before/after;
- uncached artifact download + verification duration;
- binary size.

No strict optimization target is imposed, but regressions above 20% on cached
installation need explanation.

## Exit criteria

PASS only when:

- PresGen sandbox contains a cryptographically pinned OpenFork artifact;
- runtime identity proves it is OpenFork, not merely version-compatible
  upstream OpenCode;
- current per-session topology is unchanged;
- rollback artifact/pin is documented and tested;
- focused integration tests pass.

## Handoff to downstream tasks

Record in `../results/T00.md`:

- exact artifact coordinate/source;
- exact digest;
- build-identity probe command and output shape;
- PresGen config/env/build args introduced;
- rollback procedure;
- any assumptions T13 must preserve when switching to `shared-openfork`.

