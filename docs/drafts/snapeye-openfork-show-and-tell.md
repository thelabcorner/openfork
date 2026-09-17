# Show & Tell: SnapEye as a first-party visual layer inside OpenFork

I wanted to share something I just merged into **OpenFork**, my performance-focused fork of OpenCode:

**OpenFork:** https://github.com/thelabcorner/openfork

**Integration commit:** https://github.com/thelabcorner/openfork/commit/3364b5ae1c4a23da185f638e84350d302796e0a5

SnapEye ended up becoming much more than a thin wrapper around a browser screenshot command. I integrated it as a **first-party visual-observation layer** in OpenFork's built-in browser system, while deliberately keeping SnapEye's role separate from browser control itself.

The basic split is:

> OpenFork owns navigation, interaction, tab authority, permissions, transport, and persistence. SnapEye owns deterministic DOM capture, comparison, region extraction, and bounded visual recording.

The integration currently uses **SnapEye 0.4.0 + SnapDOM 3.0.0**, exact-pinned because renderer changes can legitimately change baseline pixels. SnapEye also brings in **SnapDiff 0.3.1**, so the resulting stack is very much built on the SnapEye / SnapDOM / SnapDiff work from Zumerlab.

## What it can do now

OpenFork exposes five first-party visual operations through its existing browser tool family:

```text
visual_capture
visual_diff
visual_record
visual_history
visual_artifact
```

That gives an agent a deterministic visual workflow instead of only "take a screenshot and look at it."

It can:

- capture a document, CSS target, or existing OpenFork element reference;
- create and replace named visual baselines;
- diff the current deterministic render against an approved baseline;
- return changed/unchanged verdicts plus changed-region metadata;
- record bounded motion as a filmstrip, GIF, and browser-supported video;
- inspect prior runs and baselines without dumping large image/video blobs into model context;
- review baseline/current/diff output inside the OpenFork browser UI;
- explicitly promote the **exact reviewed `current.png`** to the new baseline without recapturing the live page afterward.

That last part was important to me: if a human reviews state A and clicks "Approve current as baseline," OpenFork promotes the exact pixels that were reviewed. It cannot silently recapture a later state B and approve that instead.

## It works in both OpenFork browser lanes

The same browser-safe visual runtime is used in both:

1. OpenFork Desktop's sandboxed Electron `<webview>` browser.
2. OpenFork's Chrome extension + native-messaging/CDP browser lane.

The target web app does **not** need SnapEye installed and does not need a plugin, endpoint, global, or any other integration code.

For Electron, the SnapEye/SnapDOM runtime executes in the isolated world while preserving:

```text
sandbox: true
contextIsolation: true
nodeIntegration: false
```

For Chrome, the visual runtime also stays in the extension isolated world. Normal document/CSS captures do not even require attaching the debugger; CDP is only brought in when OpenFork needs to resolve one of its own element references.

## The heavy visual runtime is lazy

I wanted SnapEye to be effectively free when nobody is using it.

So the normal browser path has:

- no SnapEye/SnapDOM import in the ordinary Chrome content script;
- no SnapEye/SnapDOM import in the ordinary Electron guest preload;
- no eager Visual Inspector import;
- no polling loop for visual artifacts;
- no permanent visual pointer/key/wheel listeners;
- no eager baseline reads;
- no base64 transport in Electron IPC;
- no repeated heavy runtime parsing for warm operations in the same document.

Current certified bundle sizes are roughly:

| Surface | Raw | gzip |
| --- | ---: | ---: |
| Chrome ordinary content script | 16.1 KB | 4.2 KB |
| Chrome lazy visual runtime | 460.5 KB | 123.9 KB |
| Electron ordinary guest preload | 35.3 KB | 9.9 KB |
| Electron lazy visual runtime | 430.6 KB | 121.7 KB |
| Desktop ordinary browser panel | 112.8 KB | 23.3 KB |
| Lazy Visual Inspector | 35.9 KB | 7.4 KB |

So the relatively heavy deterministic-rendering machinery stays out of the hot path until a visual operation actually requests it.

## Artifact transport became its own subsystem

One architecture rule I kept throughout the implementation was:

> Large visual artifacts should never travel through ordinary browser/agent response objects.

PNG, SVG, GIF, video, and baseline bytes use a separate bounded artifact path, while normal browser responses stay small and semantic.

The host owns a project-local `.snapeye/` store containing baselines and terminal runs. The store has path validation, traversal/symlink defenses, fixed artifact allowlists, byte ceilings, retention rules, integrity hashes, atomic-ish baseline replacement semantics, and explicit run lifecycle state.

For the Chrome/native-host lane, the artifact protocol is chunked and independently correlated. The certification suite exercises **1 MiB, 8 MiB, and 32 MiB** baseline transfers with ordering, offset, size, reconnect, and correlation checks.

## A fun performance problem: background tabs

One of the more interesting issues showed up in inactive Chrome tabs.

SnapEye correctly uses frame waits as part of stabilization, but background-tab `requestAnimationFrame` can effectively stop firing and page timers can become heavily throttled. That produced an observed ~6 second floor for otherwise trivial background-tab diffs.

Rather than forking SnapEye or weakening its settling algorithm, OpenFork uses SnapEye's documented timing seam and gives the Chrome visual runtime an internal timing facade backed by bounded MV3 service-worker timers.

The algorithm and number of waits remain unchanged; only the timing provider changes for that lane.

Afterward, warm concurrent inactive-tab diff samples landed around:

```text
[210, 206, 214, 203, 195] ms
median: 206 ms
```

versus the original ~6005 ms diagnostic run.

## Some other optimizations that fell out of the integration

After getting correctness green, I did a separate pass looking specifically for work that could be removed without weakening any correctness barriers.

A few examples:

- baseline verification during browser diffs became single-pass, eliminating a redundant full-file scan; a synthetic 32 MiB warm-cache workload moved from 32.41 ms median to 27.11 ms;
- history scanning moved to a bounded eight-worker pool; an 80-baseline synthetic workload moved from 68.69 ms to 45.36 ms warm median;
- Chrome uses native typed-array base64 when available while keeping the bounded fallback;
- record review no longer reads baseline data it never displays;
- baseline approval no longer rescans the entire baseline set after committing one known baseline;
- Chrome rejects duplicate visual work on the same tab before doing expensive target/runtime work, while still allowing independent tabs to operate concurrently.

## Recording

`visual_record` works through both browser lanes and is bounded by duration, FPS, frame count, pixel count, and artifact size.

The current real-browser certification covers filmstrip PNGs, GIFs, video, cancellation, navigation interruption, tab-close interruption, trusted human takeover, and a real 15-second MV3 recording.

I also ended up replacing the default GIF quantization path in the OpenFork shipping bundles with a bounded deterministic global-palette encoder through SnapEye's documented `encodeGif` dependency seam. The goal there was predictable memory/CPU behavior and stable palettes across frames without modifying SnapEye itself.

## Upstream interoperability was a hard requirement

I did not want OpenFork to create some private "SnapEye-ish" format that happened to work only inside the fork.

The certification suite verifies both directions against the published SnapEye 0.4.0 runtime:

1. an OpenFork-created baseline can be consumed by upstream SnapEye and diffs unchanged;
2. an upstream SnapEye baseline can be consumed by OpenFork and diffs unchanged.

OpenFork adds some environment/redaction metadata around its own workflow, but it does not break upstream baseline readers.

## Current certification status

The integration was tested across the protocol, browser host, Electron, Chrome extension, artifact transport, real Chromium rendering, MV3 lifecycle behavior, and upstream interoperability.

The final feature merge was **92 files / ~26k insertions**, so this turned into a much deeper experiment than I originally expected when I first started looking at SnapEye.

Most importantly, the project gave OpenFork a way to distinguish two separate questions:

- **Screenshot:** what is Chromium visibly displaying right now?
- **SnapEye:** does the deterministic DOM render still match the approved reference, exactly what changed, and what deterministic capture produced that verdict?

That distinction has been extremely useful for an agent-controlled browser.

Huge credit to **Juan and Zumerlab** for SnapEye, SnapDOM, and SnapDiff. I tried pretty hard to build this around the public seams rather than fork or reach into private internals, and the resulting architecture ended up fitting OpenFork surprisingly well.

I'd be especially interested in feedback on the integration boundaries, the ArtifactStore usage, and whether any of the first-party browser work suggests upstream SnapEye APIs that might be useful to generalize later.

Again, the repo is here:

https://github.com/thelabcorner/openfork

And the main integration commit is here:

https://github.com/thelabcorner/openfork/commit/3364b5ae1c4a23da185f638e84350d302796e0a5

