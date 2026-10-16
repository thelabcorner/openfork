# OpenFork — Harness-Level Prompt Integrity and Autocorrection
Date: 2026-10-10
Status: research + architecture, not implemented or benchmarked
Companion: docs/plans/prompt-autocorrection-architecture-2026-10-10.md
Owner: human-authored prompt normalization, not model/tool/synthetic prompt rewriting.

## 0. Decision and scope

Build a **deterministic, local-first, structured-part-aware pre-send normalization service** for ordinary human-authored prompts. The capability must produce either (A) exactly the same payload or (B) a rigorously checked set of minimal spelling-only patches. Any unresolved ambiguity causes abstention. Neither prompt semantics nor structural metadata may be silently rewritten.

**Do NOT substitute a "rewrite prompt" LLM call** for this feature. The existing Prompt Revisor is a separate, explicitly chosen, model-powered path. Its editing scope and latency are substantially broader.

The first production surface is the first-party V2 composer (and V1 composer where still supported). Build a reusable pure engine behind browser-safe contracts, not a hook injected at every model dispatch. Only later introduce optional host admission semantics for explicitly tagged, trusted human sources, after a provenance/ownership audit.

Do not silently correct API, OXP, OFXP, ACP, MCP, CLI/TUI, scheduled, delegated, synthetic, shell, command, slash-command, or question-controller text. Do not infer "human-authored" merely from the V1 runtime's \`origin === "user"\` flag: user-owned runtime sources are broader than typed composer input.

## 1. External prior art: mechanism-level findings

### Agent harnesses
1. **OpenCode V2 prompt hook**: https://dev.opencode.ai/v2/docs/build/plugins/
   - Runs once during admission, before durable inbox and attachment/skill resolution; hook can replace prompt text and must repair mention offsets.
   - Input has mutable prompt text, attachments and metadata; plugins run in order. The hook is not exactly-once for concurrent submissions; retries of previously admitted message IDs do not re-run.
   - **Transferable:** admission ownership, snapshot consistency, origin eligibility, position mapping.
   - **Not transferable without review:** API surface or complete upstream/V2 runtime to OpenFork's V1 production host.
2. **Cursor beforeSubmitPrompt**: https://prod.cursor.com/docs/hooks
   - Can inspect/veto; current documented output does NOT replace prompt.
   - April 2026 clarification: https://forum.cursor.com/t/bug-beforesubmitprompt-hook-updated-input-is-silently-stripped-modified-prompt-never-reaches-the-model/158883/6
   - **Lesson:** interception != mutation; prove end-to-end model-visible payload.
3. **Claude Code UserPromptSubmit**: https://github.com/anthropics/claude-code/issues/27365
   - Public feature request documents context augmentation but no documented updatedPrompt field; not safe to assume overwrite.
   - **Lesson:** supplementary text increases tokens, alters salience/authority, and is NOT equivalent to correcting the message.
4. **OpenAI Codex UserPromptSubmit**: https://github.com/openai/codex/blob/main/codex-rs/hooks/schema/generated/user-prompt-submit.command.output.schema.json
   - Documented fields allow block and additionalContext, not prompt replacement.
   - Human-origin issue: https://github.com/openai/codex/issues/29640 ; multimodal data-visibility issue: https://github.com/openai/codex/issues/41128 ; execution-order/security issue: https://github.com/openai/codex/issues/35929.
   - **Lesson:** explicit origin, structured attachments, denied-input privacy and hook precedence.
5. **LangChain before_model / modify_model_request**: https://www.langchain.com/blog/agent-middleware
   - Separates persistent agent-state changes from transient per-model-request projection.
   - **Lesson:** normalize once at admission, not on each model continuation; avoid persisted-vs-provider drift.
6. **Semantic Kernel prompt-render filter**: https://learn.microsoft.com/en-us/dotnet/api/microsoft.semantickernel.promptrendercontext.renderedprompt
   - Allows changing rendered prompt; does not automatically change persisted authored source.
   - **Lesson:** normalize a structured source before downstream rendering where possible, and retain visibility.
7. **DSPy GEPA/MIPROv2**: https://github.com/stanfordnlp/dspy/blob/main/docs/docs/learn/optimization/optimizers.md
   - Automated prompt optimizing using task metrics is broader than typo correction.
   - **Lesson:** downstream evaluation, paired baselines, hold-out, avoid optimizing cosmetic smoothness.
8. **Promptfoo**: https://www.promptfoo.dev/docs/configuration/scenarios/
   - Scenario-matrix evaluation, repeats and assertions; a potential experiment runner, not a replacement for actual OpenFork harness E2E.

### Robustness papers
- Bin Wang et al. (2024), *Resilience of Large Language Models for Noisy Instructions*, Findings EMNLP 2024. https://aclanthology.org/2024.findings-emnlp.697/
  - Noisy prompts degrade model outcomes; LLM "re-pass" normalization is not uniformly effective; cannot infer a second inference pass is desirable.
- Zhao et al. (2026), *Evaluating Robustness of Large Language Models Against Multilingual Typographical Errors*, ACL 2026. https://aclanthology.org/2026.acl-long.729/
  - MulTypo evaluates 18 open-source models, several tasks; reasoning/generative tasks often sensitive, but this is not a coding-agent outcome result.
- Romanou et al. (2026), *Brittlebench*, https://arxiv.org/abs/2603.13285
  - Semantics-preserving perturbations can substantially alter results; do not assume clean spelling alone guarantees improvement.
- Gan et al. (2024), *Reasoning Robustness of LLMs to Adversarial Typographical Errors*, https://arxiv.org/abs/2411.05345
  - Single-character adversarial perturbations can alter mathematical accuracy; adversarial targeting is distinct from naturally occurring prompt typos.
- PromptRobust, https://arxiv.org/abs/2306.04528
  - Cross-level prompt-noise benchmarking; useful noise-generators but avoid declaring adversarial synthetic data representative of human typing behavior.

### Candidate correction resources
- typos: https://github.com/crate-ci/typos ; known typo map, emits multiple candidates but abstains from ambiguous automatic corrections. MIT/Apache 2.0.
- codespell: https://github.com/codespell-project/codespell ; curate candidate typo map and exclude unsafe entries.
- GitHub Typo Corpus: https://github.com/mhagiwara/github-typo-corpus ; >350k edits, multilingual, includes formatting/grammar, NOT a directly deployable safe rules list.
- SymSpell: https://github.com/wolfgarbe/symspell ; symmetric deletes are excellent for optional typo suggestions; benchmark memory and negative precision before enabling automatically.
- CSpell: https://cspell.org/docs/dictionaries ; technical glossary, code-domain negative vocabulary; do not conflate detection and safe mutation.
- Harper: https://github.com/Automattic/harper ; optional local grammar/contextual proposals, NOT V1 default replacement.
- Electron/Chromium: https://www.electronjs.org/docs/latest/tutorial/spellchecker/ ; desktop already has a built-in platform checker.
- HTML spellcheck/autocorrect: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/autocorrect ; different native implementations and browser/OS-dependent effects.

## 2. Current OpenFork facts verified in checkout

Checkout: C:\Users\slooshied\WebstormProjects\opencode (numerous unrelated working-tree edits; preserve them).

- packages/app/src/components/prompt-input-v2.tsx:
  - First-party V2 compositor delegates direct submit to createPromptSubmit() and optionally calls Prompt Revisor. Lines ~1999–2105 show preference and recovery/stop/question routing.
  - Prompt revisor is server-backed, model-powered, and can auto-send; revision flow has source fingerprinting and target lifecycle protection.
- packages/app/src/components/prompt-input/send-policy.ts: slash commands excluded; question and recovery own submission.
- packages/app/src/components/prompt-input/submit.ts:
  - handleSubmit starts ~349, captures structured prompt and context, derives \`text\`, and later builds Goal objective, queues or sends.
  - sendFollowupDraft starts ~67, handles command fast path, calls buildRequestParts, generates optimistic request, then session prompt.
  - HostedBrowserWebview separately calls sendFollowupDraft. Do not turn the reusable transport utility into an implicit autocorrect engine.
- packages/app/src/components/prompt-input/build-request-parts.ts:
  - Builds a text part, structured file/agent parts with source offsets, contextual comments, and image attachments.
- packages/app/src/context/prompt-state.ts and packages/session-ui/src/v2/components/prompt-input/types.ts:
  - Plain text parts, atomic file, agent, skill, tool, external-path, image objects. Visible parts contain \`start/end\` offsets in JS UTF-16 string coordinates.
- packages/session-ui/src/v2/components/prompt-input/index.tsx lines ~205–206:
  - Existing V2 \`autocorrect={mode==="normal"?"on":"off"}\` and \`spellcheck={mode==="normal"}\` already enable **browser/OS-native editing correction**.
  - packages/app/src/components/prompt-input.tsx ~1785–1786 has analogous settings for legacy composer.
  - Native browser autocorrection and explicit pre-send normalization MUST be handled as distinct layers; no current test proves that native autocorrect always occurs or that it is safe for code-containing prose.
- packages/opencode/src/session/prompt.ts:
  - \`createUserMessage\` ~2184 resolves structured parts, attachments, formats.
  - \`plugin.trigger("chat.message", ...)\` ~2632 runs after part resolution but before persistence. Existing plugin hook can mutate resolved parts. It is a poor *primary* normalization owner because it can run on other sources, cannot necessarily access true typed-user origin, and occurs after expensive work.
  - \`promptInternal\` ~2903 distinguishes \`origin: "user" | "host"\`; user includes multiple programmatic surfaces. Goal reservation cancellation, provenance, host delegation and lifecycle are critical.
  - \`userActionPrompt\` implements durable user-owned action retries with source-aware identity checks.
- packages/opencode/src/session/prompt-contract.ts: protocol-neutral PromptInput includes sessionID, model, agent, parts and type-safe provenance, suitable source for a future trusted normalization command.
- packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts ~534:
  - \`prompt_async\` validates, persists \`interactivePrompt(noReply:true)\`, then wakes; reply semantics/retries must not be compromised.
- packages/opencode/src/plugin/index.ts ~393: \`plugin.trigger\` executes hook callbacks in plugin order, and message-transform hook clones messages separately.
- docs/map/packages.md lines 101–116:
  - Existing app-to-core dependency is transitional debt. **Do not add a browser-to-core implementation import** merely because other ones exist. Browser-safe domain operation belongs in a browser-safe pure module/package with schema-safe types.
- Existing Prompt Revisor settings: packages/app/src/context/settings.tsx, settings-v2/general.tsx. Autocorrect owns independent settings.

## 3. Refined package decision (supersedes V1 research note)

**Choose a new browser-safe pure module location, not a heavy \`packages/core\` runtime dependency imported into the renderer.**

Preferred:
- \`packages/schema/src/prompt-normalization/\`: wire-safe types and invariants only (no runtime or UI).
- \`packages/app/src/components/prompt-input/correction/\`: initial dependency-free logic colocated with first integration if only app will use it.
- Once a second genuinely supported human input surface arrives, promote pure engine into a small browser-safe \`packages/prompt-normalization\` package (or suitable existing shared pure package), retaining stable schema-safe interfaces.
- \`packages/app\`: UI and submit adapter; \`packages/opencode\`: only future trusted admission opt-in once execution identity is available.
- Do not prematurely introduce a server daemon, background worker, per-keystroke framework, FFI to Rust, or dictionary DB.

**Reason:** OpenFork's package map explicitly warns against new renderer-to-Core coupling. Pure typed logic can be shared without adding a host runtime edge.

## 4. Source-origin and capability contract

Input must carry trusted, externally supplied source:
\`source = composer-human | composer-human-interjection | user-action | programmatic-api | hosted-browser | oxp-worker | automation | shell | slash-command | synthetic | unknown\`

In initial V1, apply only in \`composer-human\`, \`mode=normal\`, when the local setting allows it, no question-controller ownership, no auto-revision ownership, and nonempty text. No inference of trusted provenance from arbitrary prompt wording or untrusted client-provided \`source\` at a server authority boundary.

A later host API should distinguish a user-authorized, trusted first-party sender from an arbitrary caller and must not allow source tags to confer execution permissions. Corrections themselves must not grant capabilities.

## 5. Two-level protection model

### Level A: structural spans from typed composer parts
- Existing non-text part objects are never rewritten. This includes file, agent, skill, tool, external-path and image.
- Semantic attachment identity, metadata, resource URI/path, selection, hash, filename and image BlobRef MUST retain exact values.
- Treat every non-text part as an atomic range in the flattened string; never change or split it.

### Level B: lexical spans inside plain text parts
- Delimited fenced code and inline code; if fence is unclosed, protect through end.
- URLs, email, Windows drive/UNC/POSIX/home paths, anchors, model IDs, session IDs, hashes, reference handles.
- Markdown links' destinations, inline HTML/JSX/XML, Markdown fenced configurations and language tags, shell/code blocks and log blocks.
- JSON keys + values inside block contexts, YAML/TOML, environment variables, flags and switches, mathematical notation/LaTeX, numerical units.
- High-risk commands, reproducible input/output examples, test fixtures, quoted verbatim text, literals marked "exactly"/"verbatim".
- Unicode zero-width, bidi controls, malformed markup: abstain rather than normalize.
- Unknown technical tokens/snake_case/camelCase/SCREAMING_CASE with digits or punctuated identifiers: preserve.

Use a conservative one-pass scanner; regex can help recognize tokens but is NOT a complete parser for nested arbitrary Markdown/HTML. Build a stateful deterministic lexer for common boundaries and abstain on ambiguous cases. Never "strip code then correct the rest" without maintaining offset provenance.

## 6. Candidate pipeline and deterministic policy

\`\`\`text
Immutable draft
  -> trusted source/eligibility gate
  -> structural (part) protected ranges
  -> lexical (raw-text) protected ranges
  -> tokenization in eligible prose
  -> vetted known-error lookup
  -> optional contextual veto/guard
  -> span-scoped proposal list
  -> minimal, non-overlapping patch validation
  -> reconstruct typed parts and source map
  -> full invariant verification
  -> effective immutable draft (or original)
\`\`\`

Order of authority:
1. Absolute protected-span veto.
2. User/project "never replace" allowlist.
3. System-level guarded high-risk vocabulary veto.
4. Explicit user correction rules, but still subject to safety and source boundaries.
5. Curated global unique replacements, contextual guard as appropriate.
6. Fuzzy candidates, **suggest-only** initially.

Rules have \`id, source, locale, from, to, allowedContexts?, blockedContexts?, casePolicy, riskClass, revision\`.
A mapping's risk score is NOT a calibrated probability; do not claim probability until held-out calibration.

Modes:
- OFF: no additional pre-send edits, native editor behavior unchanged.
- SUGGEST: candidates visible, no silent edits.
- SAFE: only vetted unconditional rules with protected-span checks.
- PERSONAL: optional explicit per-user context-dependent rules; still cannot override protected technical spans.

Avoid free-form natural-language rewriting, token insertion/deletion, multiword corrections, punctuation normalization, pluralization, grammar rewriting, whitespace reflow and case conversion outside the exact replaced token. A global \`replaceAll\` across flattened user input is never permitted.

**Dangerous real-word errors:**
- "gaol" is valid English, so default automatic correction is OFF; user may explicitly create contextual \`gaol -> goal\` when surrounding phrase and task semantics pass a vetted predicate.
- "form"/"from", "then"/"than", "now"/"not", "disbale"/"disable" (opposite polarity potential): preserve or suggest unless narrowly proven.
- Preserve all explicit negative imperatives and state toggles by default; false changes can cause destructive agent actions.

## 7. Immutable snapshot / offset map contract

Conceptual pure function:

\`\`\`ts
type SourceKind = "human-composer" | "human-interjection" | "external" | "unknown"
interface NormalizeRequest {
  readonly source: SourceKind
  readonly mode: "off" | "suggest" | "safe"
  readonly parts: readonly PromptPart[]
  readonly locale: string
  readonly dictionaryRevision: string
  readonly policyRevision: string
  readonly projectLexiconRevision?: string
}
interface Patch {
  readonly start: number // UTF-16 positions in original visible string
  readonly end: number
  readonly expectedOriginal: string
  readonly replacement: string
  readonly ruleID: string
  readonly classification: "known" | "contextual"
}
interface NormalizationResult {
  readonly originalParts: readonly PromptPart[]
  readonly effectiveParts: readonly PromptPart[]
  readonly patches: readonly Patch[]
  readonly status: "unchanged" | "corrected" | "bypassed"
  readonly revisions: { dictionary: string; policy: string; project?: string }
}
\`\`\`

Properties:
- sort patches by start, disjoint, exact original substring matching.
- patches cannot touch/overlap structural or protected lexical ranges; cannot cross text part boundaries.
- transform existing text part content locally, preserve semantic part objects, rebuild cumulative visible UTF-16 \`start/end\` for all non-image parts.
- check flatten(originalParts) and flatten(effectiveParts) boundaries, source-map monotonicity, all unchanged semantic fields, counts, attachment identity, Unicode surrogate integrity, idempotency under pinned revisions.
- On any failure return untouched original. Test that normalized \`text\`, request \`legacyParts\`, \`files[].mention\`, agent mentions, optimistic parts, Goal objective, queued payload and composed model-visible user message agree for eligible sends.

**Precise caution:** existing runtime plugin hooks may still change resolved parts after first-party normalization. A claim that the "agent sees exactly the text displayed" must be established at the post-plugin persisted/model-request boundary, not assumed from the renderer send request.

## 8. Send pipeline and composition decisions

Preferred staged integration:
1. First-party composer captures immutable structured draft.
2. resolve pre-existing send policy; bypass question/shell/slash/revisor.
3. preflight normalization happens quickly/synchronously on captured parts; ensure no side effects before a frozen result.
4. store \`authored\` and \`effective\` separately for local undo/review with retention policy.
5. compose one effective \`FollowupDraft\` used for history, new session and Goal objective, queued payload or direct send.
6. existing \`buildRequestParts\` and sendFollowupDraft remain transport owners.
7. sent message uses effective text; user can inspect original in a post-send diff.
8. retry/recovery reuses frozen effective snapshot and versions; no second normalization.

The existing Prompt Revisor has priority in the first release; do not normalize then revise then normalize again. Evaluate a future explicit stage ordering (e.g., safe spelling -> optional LLM revisor -> independent validation) only after semantic fidelity evidence.

**Native editor correction:** current V2 and legacy OpenFork composer enable HTML \`autocorrect="on"\` and \`spellcheck\` for normal prompts. This is OS/browser-dependent and may have already changed visible text before submit. Record no claim of "original keystrokes" unless explicit raw keystroke auditing exists (not recommended). The preflight authored snapshot means **what is in the editor at send time**. Initial implementation should leave native behavior unchanged; test duplication and possible technical token corruption on Windows, macOS, Linux and mobile PWA. Consider disabling native automatic replacement as an *independent opt-in* only after comparative UX measurements.

**Concurrency and immutable claims:** after capture, send can involve asynchronous session creation/worktree selection. Never apply corrections to the live mutable editor after these effects. A typing edit while sending must not mutate the frozen outgoing payload. One messageID -> one effective text/patch list/policy revision.

**Failures:** no dictionary, unsupported language, unsafe lexer state, invalid offset, slow initialization, missing config, exception -> revert to original and keep sending. For an optional strict "review" action that intentionally blocks send, never fake a successful submission.

## 9. Hook precedence, security, and observability

Source text normalization is **not a prompt injection defense**. Avoid presenting it as input sanitization or an authority check. Fixing typos in hostile content can make an attack clearer; tests should confirm that no trust boundary is weakened. Security detectors that operate on submitted content need a documented order and ideally access to both raw and normalized variants where authorized. Do not let third-party plugins see hidden originals without explicit consent; do not log original prompt bodies in aggregate telemetry.

Order at MVP: client policy/normalize -> existing send builder -> V1 runtime attachment resolution -> plugin transforms -> persisted user text -> provider request composition. Attribution of downstream diffs requires optional trace hashes at observed boundaries; do not claim immutable equivalence across arbitrary plugins.

User-control and security require separate levers:
- accept suggestion / undo / never correct / scoped always-correct.
- dictionary version/revision pinning.
- project overrides cannot alter protected structural categories.
- third-party rules may suggest but MUST NOT automatically mutate without explicit opt-in; malicious rule packs are untrusted code/data.

## 10. Native platform integration alternatives

**Alternative A (recommended)**: custom JS known-error map + protected-span scanner. Zero subprocess, zero model, predictable bundle. Suggest-only fuzzy fallback later.

**Alternative B**: Electron/Chromium/Hunspell OS spellcheck. Good existing editor UX, but desktop-only semantics and cannot guarantee a browser-safe batch autocorrection policy. Not an alternative to controlled preflight; may complement UX.

**Alternative C**: SymSpell dictionary deletes. Potential strong recall and fast lookup but bigger index, higher memory, ambiguous technical terms. Offline suggestions only until audits prove safe.

**Alternative D**: Rust/WASM Harper. Local grammar proposals and context; risk bundle footprint, initialization, broader natural-language rewrites. Optional manual review only.

**Alternative E**: Model-based correction using Prompt Revisor. Existing broad workflow with latency/tokens/semantic changes; not justified for automatic routine typo repair.

## 11. Quantitative objective and admission gate

For a population of prompts, estimated gain can be framed as:

Expected Net Value ≈ P(real harmful typo) * P(correct recovery | harmful typo) * benefit_of_recovery
                   - P(harmful false correction) * harm_cost
                   - added_latency_cost - maintenance_cost

False-positive harm is highly asymmetric for code-editing agents with file/tool access. Optimize precision and safety constraints, **not maximum recall**.

Evaluate three distinct questions:
- Lexical: Did patches match intended corrections and leave protected tokens identical?
- Structural: Were source offsets, mentions, queue/history, replay and provider-visible messages handled correctly?
- Downstream: Did an actual coding agent complete the intended task more reliably?

Performance *targets not measurements*: warm 1k-character prompt p95 <=5ms; warm 10k-character prompt p95 <=20ms; zero model tokens/network; no synchronous repo crawl; max heap/bundle size determined experimentally. Bench on representative Windows desktop and mobile PWA, including cold start and many open sessions.

Release precision gate should use held-out samples **and confidence intervals**; 99.9% precision cannot be inferred from a tiny positive corpus. Require no observed critical semantic protected-span mutations in targeted negative fixtures and fuzz tests, plus statistically informative correction precision and downstream utility.

## 12. Outcome benchmark design (paired and blinded)

Variants per task, model and controlled seed:
A. clean human-intended instruction ("oracle");
B. naturally perturbed instruction (single/multi-word typos, transposition, repeated characters, word omissions, real-word confusion);
C. B normalized with known-error map;
D. B normalized with safe + opt-in contextual policy;
E. B processed by existing Prompt Revisor (separate cost arm, not feature default).

Use real user-corrected samples only with consent and redaction, plus synthetic controlled errors generated from a frozen clean target. Sources: GitHub Typo Corpus, MulTypo keyboard-error generator, manually reviewed coding tasks. Include no-noise clean prompts so incorrect edits are observable. Test on code-agent harness, not merely standalone GSM8K accuracy.

Run repeated independent samples to handle model stochasticity. Freeze model/version, repo baseline, tool availability, instructions, compaction state, temperature, max budget, auth quota, server/OS environment. Use a blind objective task pass/fail oracle where possible, plus test adherence and context-consistency. Distinguish:
- score differences vs original noisy prompt,
- distance to clean-prompt oracle,
- false-edit frequency on clean/protected samples,
- time, tokens, completion rate, tool errors and recovery events.

Avoid overfitting: dev/train lexicon, held-out negative corpus, unseen projects, unseen providers, locales, and blind seeded evaluation sets. Statistical analysis: paired win/loss, bootstrap confidence intervals by task/project, explicit cost-benefit and critical-error table.

## 13. Test plan

Unit:
- "contienu" -> "continue" in English prose, capitalization preservation.
- "gaol" untouched by default, suggesting "goal" in suitable contexts; historical jail sentence untouched.
- "goal.ts" untouched, \`SessionPrompt\` untouched, \`--no-retry\` untouched.
- nested Markdown fenced blocks, unclosed fence, Markdown links, JSON, YAML, multiline command, CSS variable, Windows/UNC paths, HTTP/URI, source maps.
- repeated @file same display different underlying selection, tool/resource references, images, metadata and BlobRefs.
- emoji and astral Unicode UTF-16 offsets, combining sequences, CRLF line endings, bidi controls, zero-width, malformed markup.
- negation and polarity words; numbers; numeric units; permissions/security sensitive tokens.
- unresolved or ambiguous candidate -> no edit.
- correction idempotence with version snapshot.
- empty prompt, image-only prompt, very large pasted logs (skip or time-budget).
- order-independence of patches after sorted validation; random discontinuous part splits.

Integration:
- V1 and V2 first-party composers.
- human interjection, command, slash, shell, question-controller bypass.
- Prompt Revisor auto/one-shot sending; no recursive revising.
- queue sends while running, Goal objectives and worker continuation.
- optimistic echo/rollback/restored draft on failure.
- prompt_async 204 durable admission, message ID retries, crash/restart, pending worktree.
- attachment mentions offsets before/after, reference duplication.
- plugin hook after normalized input; display effective-versus-actual with audited plugin modifications (do not pretend guaranteed absence).
- PWA mobile vs desktop OS-native autocorrect composition and IME/Asian language composition.

Fuzz/property:
- no protected edit, exact unchanged semantic metadata, UTF-16 monotonic ranges, no overlap, stable replay, no crash, corrected token manifest and original snapshots coherent.
- malformed input raises no correction-driven send failure.

## 14. UI proposal (compact, Fortune-500 shadcn/zinc New York dense)
Settings > General > Prompt Autocorrection:
- Switch: Enable Safe Corrections.
- Small row: Known corrections (safe) vs Suggestions (optional).
- Per-project glossary / "Never replace" terms; no noisy global settings screen.
- Preview accessible behind detail view; do not add modal every submit.
- Sent message "2 spelling fixes · View / Undo next time". Distinguish "original editor snapshot" from "original keystrokes".
- Native spellcheck remains separately available, not misrepresented as the new harness feature.
- Per-send override: "Send exactly as written". No silent mutation of code snippets, quoted literals or commands.
- Optional learn-from-acceptance mapping only with explicit authorization and safety rules; don't scrape other sessions automatically.

## 15. Delivery gates and ordered plan
P0 Research: complete; codebase source seams and external harnesses inspected. Verify final implementation ownership against current tree before coding.
P1 Pure engine: versioned dictionary, typed spans, lexer, patcher, reason codes and negative corpus; benchmark cold/warm and no-async path.
P2 Integrate first-party composer only; no server request shape changes; disabled by default; native correction interaction checks.
P3 Full E2E: queue/retry/Goal/optimistic/provenance/multimodal/Prompt Revisor, compare persisted and provider-visible text.
P4 Opt-in safe; high-quality user undo/glossary; privacy-preserving counts, local audit and rule revocation.
P5 Comparative agent outcome benchmark, hold-out confidence intervals, measure severe miscorrections, consider default activation only on evidence.
P6 Optional explicit trusted-origin host admission normalization, if a second first-party source requires it. Do NOT add a universal plugin hook without a concrete parity and ownership case.
P7 Optional fuzzy suggest-only offline engine, after bundled size and memory evidence and lexical precision gate.

## 16. Critical open decisions (before implementation)
1. Freeze default mode to OFF until validated; test opt-in Safe later.
2. Determine whether the first component should live adjacent to app or be promoted into a tiny browser-safe package. Avoid app->Core runtime debt.
3. Decide persistence and access controls for original authored text; original-keystroke collection is out of scope.
4. Establish whether per-project dictionary must be isolated per server instance/worktree and how remote/mobile origin is represented.
5. Decide whether unsafe-rule suggestions are discarded or displayed in UI (never silently apply).
6. Decide whether a future host-side origin claim requires signed first-party capabilities/authorization, rather than a loose client-supplied string.
7. Verify behavior of browser native autocorrect (new standard Sept 2026), desktop Electron Hunspell and different IMEs.
8. Define exact post-plugin trace observation without logging secrets or adding hot-path overhead.
9. Reconcile high-risk term taxonomy with user-approved substitutions and verify no untrusted project file can grant arbitrary changes.
10. Ensure any modified plugin or future extension API adheres to OpenFork's tool-surface parity and compatibility architecture documents.

### Final recommendation
Favor ~90% of realistic benefit for ~10% complexity: tiny vetted typo table + token protections + immutable correction manifest. Optimize *safety and actual coding-agent success* over linguistic recall. Admit advanced contextual correction only as suggestions until benchmarked against adversarial negatives.
