# OpenFork multimodal Read + transport parity (2026-10-12)

## Status and scope

Implementation evidence is **source and targeted runtime-test evidence**. A sidecar with
OXP host status `runtime.refreshable=false` **does not hot-load these source changes**;
rebuild/restart is required. No live inference through OpenCode Go's MiMo gateway was
executed. Its successful acceptance of these payloads remains an explicit release
verification gate. Do not infer successful visual perception from `model.capabilities`
or an attachment descriptor.

The authoritative V1 Session Read tool is `packages/opencode/src/tool/read.ts`.
Media detection is centralized in `packages/opencode/src/util/media.ts`. Independent,
principal-neutral read semantics for external transports are in
`packages/opencode/src/exchange/read.ts`, with caller-owned root admission,
commit/egress revalidation and cancellation. The OXP adapter is
`packages/opencode/src/oxp/read.ts`. OXP MCP output projection lives in
`packages/opencode/src/oxp/server.ts`; native Chat multimodal lowering is
`packages/llm/src/protocols/openai-chat.ts`.

## `.ts` / `.mts` collision: source code vs MPEG transport-stream video

TypeScript source, AVCHD/MPEG-TS recordings, and Qt Linguist XML translations
can share a `.ts` suffix. `.mts` also names TypeScript ESM modules and AVCHD.
An extension or client-supplied MIME is not evidence of file content.
The single authoritative content detector in
`packages/opencode/src/util/media.ts` serves native Read, OXP/OFXP exchange
Read, CLI file attachment, and V1 Session prompt ingress.

| Evidence | Classification and MIME | Model-facing behavior |
| --- | --- | --- |
| Strict UTF-8 text (including BOM and 4096-byte sample boundary) | TypeScript *candidate*, `text/plain` | Show code text with explicit type evidence; syntax/compilation not verified |
| Qt Linguist `<TS>` XML header | Translation XML, `application/xml` | Show text, never misreport as TypeScript or video |
| 4+ valid MPEG-TS packet headers and recurring sync at 188/192/204-byte cadence | MPEG-TS video, `video/mp2t` | Native Read, CLI and Session ingress attempt bounded **lossless container remux to a real MP4**; OXP can deliver sampled JPEG evidence |
| Binary bytes without reliable text or packet evidence | Unknown, `application/octet-stream` | Fail closed, give a reason; no guessed syntax or frame observations |
| Unrelated strongly signed image/audio renamed `.ts` | Actual signed MIME | Follow the validated media path |

The packet probe checks recurring `0x47` sync **and** adaptation/header validity.
A single 'G', a short binary blob, malformed headers or a forged MIME do not
qualify. Printable UTF-8 source with coincidental repeated bytes is not promoted
to video. Only 4096 bytes are sampled on the cheap path; it is not a syntax
parser or complete-file video validation.

Native **multi-file batch Read** is also guarded: each target gets the same
content sniff **before** any text-window decoding. Verified source text remains
in the compact combined result, while TS video/other binary/unknown members
produce typed `<skipped>` receipts with recovery instructions; valid siblings
are retained and no binary replacement characters or base64 are emitted.
The TS video is never silently decoded as lines of TypeScript merely because
the caller supplied `filePaths[]` or `reads[]`.

MPEG-TS is **not** MP4, and changing MIME labels does not convert containers.
For native model delivery, FFmpeg reads already-authorized in-memory TS bytes
through a restricted pipe, remuxes compatible video/optional audio without
transcoding, and validates the returned fragmented ISO-BMFF `ftyp` header under
20 MiB/8-second bounds. Failure means no fabricated media attachment, plus
an actionable remux instruction. Successful remux is not proof that a remote
model decoded every frame.

At user-upload admission, spoofed `data:video/mp2t` TypeScript is reclassified
and **both the MIME and data URL** become `text/plain`. For `file:` references,
the true Session-owned Read dispatcher makes the classification. The OXP
external reader shares the same content detector while preserving approved-root
handles, error typing, independent grants and egress checks.

Executable evidence: `test/util/media.test.ts` (source, MPEG packets and
false positives), `test/exchange/media-preview.test.ts` (real FFmpeg TS→MP4),
`test/tool/read.test.ts` (real native source vs model MP4 attachment, mixed
multi-file batch text/media/unknown isolation),
`test/oxp/read.test.ts` (typed OXP media, a real TS→JPEG contact sheet,
approved-root isolation and no private bytes),
and `test/session/prompt.test.ts` (spoofed inline upload and file reference).
Live upstream provider acceptance still requires separate certification.

## Behavior

- Signature-first MIME recognition accepts PNG/JPEG/GIF/WebP, PDF, MP4/MOV/WebM/AVI/WMV,
  and WAV/FLAC/OGG/MP3/M4A/AIFF/AAC. Claimed audio/video file extensions and
  header MIME values are **not trusted** when the signature is unrecognized: such
  input remains octet-stream, never silently passed to a decoder as media.
  A recognizable header alone is not proof that the complete file is decodable.
- Native Read attaches image/PDF/video/audio to the V1 tool result as a data URI.
  Audio/video are capped at 20 MiB decoded before reading/allocation. Tool
  output text does not include base64. Existing image/PDF semantics are retained.
- On capable OpenAI-compatible models, the session runtime opts into native
  `@opencode-ai/llm` for audio/video-bearing user turns and emits
  `video_url.url` / `input_audio.data` with data URLs. The provider still has
  the final authority to accept/reject the wire format. Generic OpenAI-compatible
  labels **do not guarantee** all model endpoints support these blocks.
- Replayed tool attachments that the selected model cannot process are extracted
  to a separate user-role attachment message and run through the modality guard;
  an unsupported nested binary must not silently corrupt all future turns.
- Direct OXP Read is independently authorized by the approved root and sends
  **virtual approved-root handles**, not raw local paths. A single target can
  return bounded MCP image/audio content. Video has no MCP native content block,
  so the optional contact sheet emits JPEG image content sampled from the video
  by FFmpeg. FFprobe attempts to obtain a bounded duration from the same
  already-authorized input bytes; when available, six temporal sampling positions
  span approximately the clip length (`duration / 6` seconds apart; minimum
  interval 0.5 s). On a failed probe the conservative fallback samples the
  first 24 seconds at four-second intervals, explicitly stating that coverage
  is unknown. Sampling emits at most one six-tile JPEG (1 MiB output bound),
  with a 2-second duration probe and 6-second decode limit per attempted decoder.
  Both processes read only in-memory media bytes via restricted pipes.
  If FFmpeg is unavailable, malformed video or too large, only the virtual
  descriptor is provided: **the model has not watched the video**.
- OXP Read reports `mediaDelivery` as `inline-image`, `inline-audio`,
  `sampled-video`, or `descriptor-only` with `mediaReason` for omitted
  content and bounded `videoSampling` evidence when a contact sheet exists.
  The text output repeats this crucial distinction so an agent that only
  reads text still cannot mistake a descriptor for a perceived frame.
- Batch OXP Read yields media descriptors only, to avoid eight concurrent
  full binary encodings. OXP Code accumulates a bounded subset of media from
  its independently authorized calls and exposes it in MCP output content,
   not Code's textual JSON value; imported MCP image/audio blocks are MIME/signature
   verified and bounded to 4 MiB total encoded data. Omitted non-text items
   receive a concise text receipt: they must not be hallucinated as inspected.
- The Read path offers visual sampling, **not** a frame-accurate forensic
  analyzer. In particular, single-frame flashes can evade sampling: use the
  shell/FFmpeg full-frame `signalstats`, `tblend` and `blackdetect`/metrics as
  appropriate, and inspect adjacent frames.

## AX-16 task-evidence and recovery map

Task: an agent investigating a short UI flicker reads `capture.mp4` through
the approved project root, while the file may have been renamed or malformed.

| Agent phase | Trusted owner / observable evidence | Failure and recovery semantics |
| --- | --- | --- |
| Discovery and selection | Native Read or OXP Read; no new permanent tool registration; concise prose identifies media vs Find and text-window operations | The surface is selected by intent, not an implicit privilege or executable route inferred from catalog |
| Input and permission | `FSUtil` signature-first detection; native Session authority or independent approved OXP root grant | Forged `.mp4`/audio filename without matching signature is rejected as media; no invented Session credentials |
| Execution and safety | 20 MiB native audio/video cap; 20 MiB OXP video inline cap; 2 MiB OXP audio cap; bounded restricted-pipe FFprobe/FFmpeg | Unavailable codec/invalid video returns a virtual descriptor and explicit no-frames status, not a fabricated model observation |
| Observable state | `mediaDelivery`, `mediaReason`, `videoSampling` in OXP result; non-text MCP output only for actual samples/media | Agents can distinguish received JPEG sample, native audio/image bytes, and handle-only media |
| Context economy | Six-frame contact sheet (1 MiB JPEG cap), batch handles rather than 8× encoded video, 4 MiB imported MCP budget | Re-read individually to get content; use full-rate FFmpeg for transient events rather than retrying the same insufficient preview |
| Verification and continuity | OXP direct, OXP Code, native Read, native Chat serialization, GUI projection and MCP bridge regression fixtures | Neither a unit test nor registered capability proves live Go gateway acceptance, ACP audio/video or OFXP peer transfer |

Classification: signature spoof and missing-preview weaknesses were **observed
in source**; signature checks, failure receipts and duration-aware extraction are
**implemented and experimentally tested**. Cross-provider model inference,
end-user browser playback, OFXP media byte transfer, ACP video semantics and
model-driven task-success deltas remain **unverified**. No invented AX score or
model throughput improvement is claimed.

## Executable surface matrix

| Surface | Dispatcher and authorization | Implementation / evidence | Remaining limitations |
| --- | --- | --- | --- |
| V1 chat / worker / lazy native Read | `ToolRegistry` → `ReadTool`; real Session and read/external-directory permission | Test: `test/tool/read.test.ts` recognizes renamed MP4/WAV, oversize rejection | Provider acceptance and UI video/audio player not yet certified |
| Native OpenAI-compatible model transport | `LLMNativeRuntime` with selected model/provider route | `test/provider/openai-chat.test.ts` validates exact video/audio request shape and invalid MIME | Live Go/other hosted gateway requests unverified |
| OXP direct read | `OxpRead.one` → `ExchangeRead.execute`; root grant + egress revalidation | `test/oxp/read.test.ts`, `test/oxp/server.test.ts`; image/audio MCP blocks, approved-root media handles | Video preview requires FFmpeg; no full native video content in MCP |
| OXP Code Mode | `OxpCapability.code` → independently authorized leaf; bounded media collector → MCP content | `test/oxp/capability.test.ts` real Code `read("image.png")` verifies native media, metadata and root isolation | Code-internal return remains compact text/handles, not full raw binary |
| Imported MCP → OXP | `OxpMcp` → configured integration authority; media bound, decoded only by receiving MCP client | `test/oxp/mcp.test.ts`; invalid/oversized excluded | External MCP server/tool policy remains independently authorized; no automatic re-export |
| OFXP peer read / OXP OFXP proxy | Peer-gated `OfxpCapability` → `ExchangeRead`; peer/root grants; OXP remote call wrapper | Shared media descriptor shape and existing OFXP dispatch tests | **Reviewed scope exception:** peer transfer carries bounded descriptors/handles, **not** full video/audio bytes; separate authenticated transfer required |
| ACP / IDE/TUI | Existing V1 Session tool events and ACP `completedToolContent` | ACP V1 Read now delivers signature-validated, bounded native audio content blocks (2 MiB total) alongside existing image/text results; `test/acp/tool.test.ts` verifies normal/denied shapes | **Reviewed scope exception:** no ACP video block: tool update explicitly notes footage was not decoded, use authorized frame extraction; runtime client playback unverified |
| GUI / desktop / mobile | Existing V1 session attachment persistence, shared session timeline | New shared `read-tool-playable-model.ts` / `read-tool-playable-media.tsx`: bounded MIME/data-URL checks and user-opened `<video>`/`<audio>` player; model tests + `session-ui` typecheck passing | **Browser playback not independently certified:** codecs are browser-dependent; the video/audio player mounts lazily and does not alter image/SVG rendering |

Status terms are deliberate. `Executable` means a real tested invocation. Descriptor
presence is not media delivery, and tested OXP does not certify peer/ACP/client playback.
The OFXP, ACP and UI rows require separate integration tests before a universal
multimodal-experience claim (the GUI model is unit-tested; actual playback remains
unverified). These are narrow presentation/transport format limitations,
not implicit permission escalation or a fabricated Session context.

## Run evidence / release gates

- `cd packages/llm && bun test test/provider/openai-chat.test.ts`
- `cd packages/opencode && bun test test/tool/read.test.ts test/session/message-v2.test.ts`
- `cd packages/opencode && bun test test/oxp/read.test.ts test/oxp/server.test.ts test/oxp/mcp.test.ts`
- `cd packages/opencode && bun test test/exchange/media-preview.test.ts` exercises real
  FFmpeg-generated MP4 → bounded JPEG, with optional FFprobe duration-based
  interval evidence. Windows FFmpeg is available in
  `%LOCALAPPDATA%\\Microsoft\\WinGet\\Links\\ffmpeg.exe` on the development host,
  even if `ffmpeg` isn't in PATH.
- `cd packages/opencode && bun test test/util/media.test.ts` verifies 11 MIME signatures,
  truncated unknown files, spoofed media extensions and video/audio admission.
- `cd packages/opencode && bun test test/oxp/capability.test.ts --test-name-pattern "exposes stateless Code"`:
  OXP Code Mode → independently authorized Read → MCP image media content.
- `cd packages/llm && bun run typecheck`: passing in the tested state.
- `cd packages/session-ui && bun test src/components/read-tool-playable-media.test.ts src/components/read-tool-visual-model.test.ts`:
  16 passing tests, with the existing image/SVG visual model intact.
- `cd packages/session-ui && bun run typecheck`: passing.
- `cd packages/opencode && bun test test/acp/tool.test.ts`: ACP Read audio
  content blocks, MIME mismatch, bounded aggregate budget, and no invented
  video-content block. This verifies actual tool-update construction, not an
  external IDE client's ability to play or transcribe audio.
- `cd packages/opencode && bun run typecheck`: the checkout already has unrelated
  errors in CLI support bundle, legacy compatibility, global handler and Session
  timeline endpoints. Source-introduced diagnostics must be zero before closeout.
- Real-world provider acceptance gate: restart OpenFork sidecar with the new
  source, attach a small video showing a clearly timed event, inspect outgoing
  sanitized route/payload, verify MiMo answers a frame-content question,
  and compare against a full-rate FFmpeg frame-statistics control. Repeat for
  audio, model without the modality, and unsupported hosted route. Verify
  URL and base64 forms only where explicitly accepted by the upstream route.

## References

- [Xiaomi MiMo video input](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/video-understanding):
  `video_url.url` base64/URL, provider frame sampling and limits.
- [Xiaomi MiMo audio input](https://mimo.mi.com/docs/en-US/quick-start/usage-guide/multimodal-understanding/audio-understanding):
  `input_audio.data` for audio.
- [MCP 2026-07-28 tool content](https://modelcontextprotocol.io/specification/2026-07-28/server/tools):
  text, image, audio, and resource forms; no native video block.
- [Gemini video understanding](https://ai.google.dev/gemini-api/docs/video-understanding):
  separate provider-specific inline/file video pathways. Do not force Gemini
  through OpenAI Chat's `video_url` format.
- [ACP V2 content: audio](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/content.mdx):
  tool content can carry `audio` blocks and ACP clients negotiate capabilities
  separately; no generic native video block is assumed.
- [ACP V2 tool call updates](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/tool-calls.mdx):
  tool content updates are replace-by-array, with separate append-only chunks.
