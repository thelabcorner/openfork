# OpenFork — Prompt Autocorrection Architecture (Research and Design)
Status: DESIGN ONLY — no implementation, benchmark, behavioral change, or enablement is claimed.
Date: 2026-10-10
Scope: Human-authored, ordinary-language prompts submitted through the first-party OpenFork composer.

## Executive decision
Build an opt-in, conservative, local-first spelling correction stage, separate from the existing Prompt Revisor. The new stage changes eligible natural-language tokens only, never technical syntax, commands, exact references, user quotations, tool arguments, model outputs, or automation payloads. Keep the human-authored draft and the effective sent text distinct, inspectable, and recoverable. Reject unsafe candidate transformations; never call an LLM for ordinary autocorrection.

Prioritize a vetted known-error map (akin to typos-cli/codespell) and a project-aware allowlist. Introduce fuzzy suggestions only as an optional, offline enhancement after error audits prove adequate precision. A user-targeted exception such as 'gaol' => 'goal' needs contextual matching because 'gaol' is a valid English word meaning jail.

## Verified codebase findings (2026-10-10 checkout)
- packages/app/src/components/prompt-input-v2.tsx: revisionSend, directSubmit, automatic revise-before-send and optional auto-send; question answering bypass; controller and revision flow.
- packages/app/src/components/prompt-input/send-policy.ts: excludes slash commands and prioritizes question and recovery states.
- packages/app/src/components/prompt-input/submit.ts: createPromptSubmit/handleSubmit captures a structured draft, creates sessions/worktrees, queues drafts, sends shell or commands, and uses sendFollowupDraft; sendFollowupDraft builds optimistic and HTTP request parts.
- packages/app/src/components/prompt-input/build-request-parts.ts: serializes full text plus structured file/agent references and source offsets, attachments, and contextual comments.
- packages/app/src/context/prompt-state.ts and packages/session-ui/src/v2/components/prompt-input/types.ts: editor model comprises text parts and atomic file, agent, skill, tool, external-path, and image parts, with UTF-16 JavaScript string offsets.
- packages/app/src/components/prompt-input/prompt-revision.ts: revision drafts, structured mentions, part reconstruction, and draft fingerprinting.
- packages/app/src/context/settings.tsx and packages/app/src/components/settings-v2/general.tsx: existing local general settings and separate Prompt Revision preference; new setting should not share promptRevision semantics.
- packages/opencode/src/server/routes/instance/httpapi/handlers/prompt-revisor.ts: existing server-side LLM-based revisor.
- The checkout contains many unrelated uncommitted source edits. Do not replace them or assume the inherited upstream implementation is identical to local OpenFork.

## Requirements
R1. Safe: protected bytes and protected semantic part identities must remain exactly unchanged.
R2. Deterministic: identical input, lexicon version, policy, and project dictionary yield identical patches.
R3. Local-first: no network/provider calls and no newly disclosed prompt content.
R4. Fail-open: errors, missing dictionaries, invalid spans, timeout, and ambiguous corrections submit the original text without blocking the prompt.
R5. Reversible/auditable: authored input, effective input, patch list, lexicon/policy revision, and decision rationale are available to user UI, subject to privacy retention policy.
R6. Lightweight: no per-keystroke heavyweight grammar pipeline; no synchronous filesystem crawl on sending; bounded resources.
R7. Single ownership: correction proposal and patch validation live in a pure shared domain module; composer/UI owns whether to apply corrections.
R8. Composition: no double correction with existing Prompt Revision and no second independent composer send implementation.
R9. Idempotency: correction(corrected text) equals corrected text for an identical policy and dictionary version.
R10. Integrity: correction must not alter identities, attachment counts, source locations, context, command strings, user-specified exact substrings, or task polarity.

## Proposed package and responsibility boundaries
A. packages/core/src/prompt-correction/ (or a smaller dependency-free shared package, subject to the local package map):
  - types.ts: immutable CorrectionRequest, Candidate, Patch, CorrectionResult, immutable Policy snapshot.
  - protect.ts: deterministic lexer/protection intervals, part-aware protected range builder.
  - tokenize.ts: Unicode-safe natural-language tokenization, offsets in JavaScript UTF-16 code units.
  - lookup.ts: vetted typo mapping, allowlists, exclusions, and optional lazy fuzzy suggestions.
  - score.ts: confidence/context policy, conservative admission.
  - apply.ts: sorted non-overlapping patches; validation and immutable reconstructed part offsets.
  - corpus/: versioned, attributable dictionary assets, licenses and sample fixtures.
B. packages/app/src/components/prompt-input/: thin preflight adapter and UX; integrates with actual handleSubmit path and optionally other explicitly supported human-authored sources.
C. packages/app/src/context/settings.tsx and Settings General UI: own autocorrection settings; independent from Prompt Revision.
D. packages/app tests + package-level tests: semantic references/offset invariants, send/queue/retry/revisor interactions, fuzz/property tests, user-visible diff.

Avoid installing another server, IPC boundary, worker pool, LLM model or database table for the MVP.

## Effective send path
1. User presses send.
2. Existing send-policy controls stop/question/shell/revisor/recovery and handles appropriate bypasses.
3. Capture a stable, immutable structured draft snapshot (including raw text, file/agent/tool/skill/external-path parts, images, contextual file selections).
4. If enabled and eligible, segment only editable prose portions, generate small patch proposals, apply strict safety guards, rebase all part offsets, validate invariants, then choose corrected or original draft.
5. Execute all subsequent operations exactly once using the same effective snapshot: goal objective, queued draft, optimistic display, request parts, HTTP text, and any retry.
6. Preserve original authored text separately (local history or optional user-visible audit); preserve actual sent effective text as the source of truth for execution.
7. Send to existing API; no server-side recomputation or hidden prompt injection.
8. On failure/recovery use the original draft for editable composer restore, and the frozen effective snapshot for any exactly-once retry policy as appropriate.

IMPORTANT: In current code createPromptSubmit captures text and adds draft history BEFORE session/worktree effects, then queues/sends; any integration must select the effective draft early enough to keep the goal objective and request parts consistent. sendFollowupDraft also serves other callers, including HostedBrowserWebview; do not indiscriminately enable for non-composer sources.

## Structured part transform contract
Input is an immutable sequence of existing ContentParts. Never flatten and recreate semantic attachments from text alone. Apply candidate replacements exclusively inside existing plain text parts. Rebuild text parts, preserve semantic part objects/metadata, and recompute every subsequent non-image start/end offset in UTF-16 code units. Preserve the exact content of all semantic parts, URL/path, selection, display token, object identity (where possible), relative order, attachments, images and BlobReferences. Use a position map from original to effective string offsets. Do not split edits across part boundaries. Verify concatenated effective visible text, monotonic non-overlapping ranges and 1:1 correspondence of atomic semantic parts. Abort entire normalization (use original) on any failed invariant.

Separate part-level atomic protection from lexical protection for pasted raw text in an ordinary text part. Lexically protect fenced/inline code, raw identifiers, paths (Windows/POSIX/UNC), URLs, emails, commands, options/flags, checksums, versions, JSON/YAML keys, Markdown link destinations, environment variables, handles, IDs, placeholders, math/LaTeX, tags, hashes, source/log blocks, explicit verbatim spans and malformed/unclosed code fences. Prefer over-protecting ambiguous spans. Quoted text may be exact user data: default to review/skip. Do not silently autocorrect shell-mode or registered slash commands, including their argument strings.

## Candidate policy
TIER 0: explicit project/user "do not correct" terms and structural protected spans; absolute veto.
TIER 1: curated high-certainty misspelling maps (e.g., "contienu" -> "continue") only in editable prose; supports case transfer if safe.
TIER 2: contextual special cases (e.g., "overarching gaol" -> "overarching goal"); MUST require independently audited context predicate; otherwise offer suggestion or abstain.
TIER 3: optional SymSpell-style delete-index fuzzy candidates from vetted frequency lexicon and technology glossary; suggestions by default, NOT silent autocorrection.
TIER 4: optional Harper / context-sensitive grammar analysis only for user-initiated review; do not silently rewrite grammar or sentence meaning.

Veto automatic edits of negations and logical polarity (no/not/don't/never/without), comparators, numbers/units, "on/off", "true/false", "enable/disable", imperative verb changes, code tokens, task-specific protected vocabulary, words with multiple near-equal candidates, and valid uncommon words unless a tested contextual rule exists. Avoid global replacement and multiword segmentation in automatic mode. "form/from" and other valid-word confusion requires explicit context and should be suggestion-only initially.

Candidate ranking proposal: conditional user typo mapping > approved project mapping > vetted global mapping; error-model plausibility + word-frequency prior + bounded context; high uncertainty -> abstain. Do not treat a score as calibrated probability until held-out reliability calibration is measured. Auto correction should be possible only from an explicit allowlisted candidate type. Store rule IDs and dictionary revision.

## Settings and UI
Independent General > Prompt Autocorrection setting:
- Off (initial default before certification).
- Safe autocorrect (recommended after validation).
- Suggest only / review edits.
- Optionally allow per-project dictionaries or always-protected terms.
Existing Prompt Revision remains separate: explain "spelling fixes" vs "AI prompt rewrite" with no model charge for corrections.
Show a compact "2 typos corrected · Undo / View" disclosure on changed submissions, or accessible diff in sent-message metadata; no modal, spinner or compulsory review on safe corrections.
Provide "Undo for this prompt", "Never correct this term", "Always correct this typo" (with a safety guard and context scope), plus global temporary bypass in send menu.
Do not give access to reconstructed sensitive text in analytics; collect only aggregate counts and rule/category labels, with user privacy preference.

## Interaction policy matrix
- First-party typed human prose: eligible in Safe or Suggest mode.
- Queued human follow-up: correct ONCE when accepted into queue, frozen with dictionary revision.
- Human interjection through composer: eligible if text and no protected mode, subject to its own correctness tests.
- Images/attachments/structured @mentions: immutable.
- Shell input: bypass.
- Slash command + arguments: bypass.
- Pending question answers: bypass initially (question controller owns the composer); consider later only with explicit tests.
- Goal initiation: include only if objective and sent prompt are provably derived from same effective snapshot; otherwise bypass until audited against Goal Mode.
- Existing Prompt Revisor: initially let revisor own revision when enabled to avoid conflicting double transforms; evaluate one clearly ordered integrated preflight later.
- Browser annotation submissions: explicit opt-in future surface; no accidental activation merely because it uses sendFollowupDraft.
- OXP/OFXP/ACP/SDK/CLI/automation/worker-generated text: no implicit rewrite; opt-in capability only with explicitly declared source and consent.

## Failure and race invariants
- Fingerprint immutable captured draft before asynchronous work. If user modifies or target session/directory changes while preflight is pending, apply to captured send payload only; never overwrite a newly edited live draft.
- Freeze policy/dictionary version per submission; avoid changing queued/retried text after settings reload.
- Support AbortSignal where available, bounded deadline, and original-text fallback.
- Never mutate a globally shared Prompt array; reconstruct immutable data.
- No partial correction if patch overlaps protected range or offset remapping fails.
- Maintain consistent attribution: the user-visible effective sent text must match the text actually delivered to the agent.
- Protect extension failure from delaying/mangling prompt dispatch.

## Performance targets — NOT MEASURED RESULTS
- Warm preflight p95 <= 5ms for ordinary ~1,000-character English prose; p95 <= 20ms for 10,000 characters; p99 <= 50ms.
- Zero provider tokens and zero network requests.
- No meaningful render/main-event-loop stalls, no per-keystroke filesystem reads; lazy-load dictionary asset off critical route mount and warm in idle time where possible.
- Memory budget and binary size must be profiled before selecting SymSpell, CSpell, Harper WASM or custom trie. Known-error map should be substantially smaller than full frequency delete index.
- Benchmark latency distributions, precomputed lexical interval cost, object allocations, cold-start dictionary load, heap footprint, bundle cost and false-correction rate.

## Correctness and evidence gates
1. Curate 200+ positive cases with known intended spelling and 500+ protected negatives, including developer slang, chemistry names, code references, Windows paths, model IDs, and realistic project language.
2. Add curated tests for 'gaol' as jail vs goal, 'contienu', negation words, ambiguous real-word confusions, malformed markdown, CRLF, emoji and surrogate pairs.
3. Mutation/property fuzz: preservation of semantic part counts and metadata, monotonic offsets, edit idempotency, no edits in protected spans, absence of crashes, rollback to original on validation failures.
4. Cross-flow integration: direct send, queue, recovery, existing revision, reference attachments, question bypass, shell/slash bypass, Goal Mode consistency.
5. Paired agent benchmark: same model/settings/tasks across clean / noisy / conservatively corrected prompts; measure task correctness, test-pass rate, instruction adherence, tool-call errors, inference tokens, and cost, not merely typo-detection recall.
6. Require an observed high precision threshold before enabling Safe as a default; suggested release gate >= 99.9% precision on held-out supported corrections with sufficient sample size and ZERO observed protected-span, reference, negation, or command mutation. Report confidence intervals, not a point estimate alone.
7. Rollout: off-by-default audit/suggestion, opt-in safe, controlled cohort, only then consider default-on; flags to disable immediately, no logs containing prompt bodies.

## Investigated prior work / implementation candidates
- typos-cli: known typo correction table, ambiguous suggestions withheld, fast source-oriented design. https://docs.rs/crate/typos-cli/latest
- codespell: known misspelling dictionaries and ambiguity/false-positive handling. https://github.com/codespell-project/codespell
- SymSpell: symmetric delete index, efficient dictionary candidate search; carefully account for memory/build and false positives. https://github.com/wolfgarbe/SymSpell
- CSpell: developer-specific dictionaries and camelCase handling; useful lexicon source, not a default auto-rewrite policy. https://cspell.org/docs/dictionaries
- Harper: offline Rust/WASM English lint engine for optional contextual proposals; investigate size, licensing, browser/Node compatibility and runtime latency before adoption. https://github.com/Automattic/harper
- GitHub Typo Corpus: domain-relevant typo/error examples; clean and audit for safe licensing, content quality and label leakage. https://github.com/mhagiwara/github-typo-corpus
- SCOWL/ESDB: wordlist and locale resources; preserve required notices and evaluate shipping/licensing. https://sourceforge.net/projects/wordlist/files/speller/2026.02.25/
- MulTypo ACL 2026: degradation of 18 open-source LLMs under typos (not proof of OpenFork agent improvement). https://aclanthology.org/2026.acl-long.729/

## Explicit non-goals for V1
No grammar/style paraphrasing; no provider/model requirement; no automatic command correction; no hidden server-side rewriting; no blanket correction of API-submitted prompts; no rewriting comments/logs/code as user facts; no attempting to solve ambiguous intent with a model; no default-on without outcome tests; no full-project crawl during submit.

## Recommended delivery phases
P0 — Pure engine and negative-corpus tests; curated corrections, no app integration.
P1 — Composer preflight behind off-by-default setting, explicit audit/undo, keep existing revisor independent.
P2 — Correctness audit of references/offsets/queue/Goal/question/shell/recovery; dedicated E2E coverage and performance baselines.
P3 — Opt-in production dogfood; collect aggregate acceptance/corrections, audit miscorrections locally.
P4 — Optional dictionary and fuzzy suggestion experiments; selective repo glossary integration; safe policy calibration.
P5 — Model-outcome A/B evaluation; consider safe default only with demonstrated positive expected utility and no critical semantic mutations.

## Open decisions
- Whether reusable engine should live in core or a smaller shared package, following existing ownership/import constraints.
- Whether the authored original should be session-persistent or only local history/audit (privacy and schema implications).
- Exact queue and Goal Mode normalization ownership, to be decided with executable integration tests.
- Which dictionary licenses and build sizes justify bundling, and how to avoid regressions for locales other than en-US.
- Whether Context-sensitive correction of valid English words such as 'gaol' should require explicit user opt-in per substitution.

## Closeout
This document records codebase-informed design and external references only. No feature is implemented, enabled, or benchmarked as part of this research artifact.
