# T4 — Updater and identity

**Lane:** branding  
**After:** T2  
**Parallel with:** T3 T5 T6

## Do

1. Read `../../../../packages/desktop/src/main/updater.ts` and wherever the GitHub releases feed is set.
2. **Disable auto-update** for this fork (default). If the human already decided to publish installers, retarget the feed to `thelabcorner/openfork` instead — do not leave anomalyco.
3. Confirm channel DB stays fork-specific (`opencode-openfork.db` or equivalent) in `../../../../packages/desktop/src/renderer/storage.ts`.
4. Set root `../../../../package.json` `repository.url` to `https://github.com/thelabcorner/openfork`.
5. Do not mass-rebrand the UI to "OpenFork" in this task unless T0 asked. Identity in git/updater is enough.

## Do not

Touch session/tool code. Delete official icons unless asked.

## Done when

A packaged or long-running build cannot install official OpenCode over this tree. `repository.url` is this repo.

Commit: `chore(desktop): disable official updater on OpenFork`
