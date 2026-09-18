# Handoff: Design UI/UX agent brief — OpenCode chat sessions UI

## 0. Handoff metadata

- Date: 2026-08-13 (exact UTC time not recorded)
- Sending agent: coordinator session (opencode-go / deepseek-v4-flash)
- Receiving agent: **uxsmith** — design UI/UX / frontend engineer (visual sign-off, UI
  implementation). Currently idle in swarm `tab-stop-pause`.
- Reason for handoff (user's words, verbatim):
  1. > "find the code in the desktop for the agent tool ui in the chat sessions"
  2. > "put together a comprehensive handoff for my design ui/ux agent"
  3. > "make sure it is TRUSTWORTHY"
  The third message is escalation-flavored: the user is signaling that a plausible-looking
  but unverified brief would be worse than none. Treat that as the controlling requirement.
- Trust guidance for prior work: **MIXED** — every file location, line number, and
  command in §3 was verified on disk during this session (grep/read; see §10 table).
  Everything about *design intent, conventions, or how the user will use this brief* is
  my synthesis, not user-confirmed. Re-verify line refs before editing; they drift.

## 1. The user's actual goal

- User's words: as quoted in §0. The goal is a comprehensive, trustworthy handoff the
  design agent can act on — with the agent tool UI in chat sessions as the anchor topic.
- My interpretation: a working brief for uxsmith covering (a) where the UI code lives,
  (b) the design-system rules to honor, (c) the repo rules that constrain edits,
  (d) how to verify work. Trustworthiness = every claim sourced, hedged where uncertain.
- Known ambiguities I inferred, flag for confirmation:
  - Whether the user wants the brief *delivered to uxsmith in the swarm* or merely stored
    in the repo. I stored it at `docs/swarm-design-uiux-handoff.md`; not yet sent.
  - Whether "design ui/ux agent" is uxsmith specifically. Only one swarm exists
    (`tab-stop-pause`) and uxsmith is its frontend engineer — consistent, but unconfirmed.

## 2. Current state of the task

- **Done and verified (on disk, this session):**
  - Located the agent tool UI stack: desktop shell → `@opencode-ai/app` →
    `session-ui` tool components (§3). Every line ref cross-checked with grep/read.
  - Wrote `docs/swarm-design-uiux-handoff.md` (this file) following the
    AGENT_HANDOFF_SKILL structure (`C:\Program Files\Adobe\Adobe Illustrator
    2026\Presets\en_US\Scripts\agent-skills\AGENT_HANDOFF_SKILL.md`).
  - Ran the skill's §11 quality checklist over this draft; the attempted/verified
    distinction, quoted user language, validation table, do-not-touch list, and
    synthesis instruction are all present.
- **Done but NOT verified:**
  - Whether uxsmith's own working context (prior feature docs `docs/swarm-*.md`) matches
    the line refs here — I did not read the swarm's blackboard or uxsmith's history.
- **Not started:** delivering the brief to uxsmith (message, task, or file reference);
  any UI code change.
- **Blocked:** nothing.

## 3. Concrete artifacts, paths, and identifiers

Files read (not modified): all verified present on disk.

| Path | Role | Verified |
|---|---|---|
| `packages/desktop/src/renderer/index.tsx:407` | `<AppInterface>` — desktop mounts the shared app; desktop itself has NO chat UI | read |
| `packages/app/src/pages/session/timeline/message-timeline.tsx` | Chat timeline; renders tool parts via `Part`/`MessagePart` (:1072), `ContextToolGroup` (:1039), `partDefaultOpen` (:1064, uses `shellToolPartsExpanded`/`editToolPartsExpanded`) | read + grep |
| `packages/session-ui/src/components/message-part.tsx` | Tool part renderer; `BasicTool` dispatch from ~:1792, `ToolErrorCard` (:1587), `question` handling (:1541–1577) | grep |
| `packages/session-ui/src/components/basic-tool.tsx:86` | `BasicTool` — generic tool card (icon/status/title/details) | grep |
| `packages/session-ui/src/components/tool-error-card.tsx:22` | `ToolErrorCard` | grep |
| `packages/session-ui/src/components/tool-status-title.tsx` | Status labels | grep |
| `packages/session-ui/src/v2/components/basic-tool-v2.tsx`, `tool-error-card-v2.tsx` | V2 variants (used when `settings.general.newLayoutDesigns()` is on — verified at message-timeline.tsx:1077) | grep |
| `packages/session-ui/src/components/session-turn.tsx:105` | Hides pending `question` tools | grep |
| `packages/ui/src/v2/styles/colors.css`, `tailwind.css`, `theme.css` | V2 tokens (`--v2-grey-*`, `--v2-alpha-*`); Tailwind utils like `bg-v2-background-bg-accent/8` | read |
| `packages/ui/src/theme/` | Theme engine; JSON themes in `themes/*.json`; `useTheme` from `@opencode-ai/ui/theme/context` | glob |
| `packages/storybook/package.json` | Storybook 9, `storybook dev -p 6006` | read |
| `.opencode/skills/rtl-aware-development/SKILL.md` | Mandatory RTL guidance | read |
| Root `handoff/AGENTS.md`, `packages/app/AGENTS.md`, `packages/desktop/AGENTS.md`, `packages/ui/AGENTS.md` | Repo rules (§4) | read |

Files created: `docs/swarm-design-uiux-handoff.md` (this file — the only artifact).

Commands run this session (all read-only): glob over desktop/session-ui/ui sources;
grep for `BasicTool`/`ToolErrorCard`/`ToolPart` usage; `swarm_list`; `swarm_roster`.
No exit-status failures; no writes other than this file.

## 4. What I actually attempted (recency-weighted)

Attempt 2 (most recent — this rewrite):
- Tried: restructure the first draft to the AGENT_HANDOFF_SKILL's 14-section shape
  (metadata, attempted-vs-verified, validation table, do-not-touch, synthesis).
- Why: user's "make sure it is TRUSTWORTHY" pointed at the skill's core failure mode —
  a confident-sounding brief with unverified claims. The first draft stated file
  locations as fact but lacked provenance tags.
- What happened: I re-ran the greps/reads behind every claim and tagged them in §3/§10.
- Outcome: worked (this file). Confidence: high that structure now matches the skill;
  unverified that the user is satisfied.

Attempt 1 (superseded):
- Tried: write a plain onboarding/reference brief at the same path.
- Why: "comprehensive handoff" read as a reference doc.
- Outcome: it was a valid reference but violated the skill's core principles — no
  metadata, no attempted/verified split, no trust markers, no synthesis instruction,
  claims indistinguishable from facts. Superseded by this rewrite (not deleted history;
  fully replaced in the file).

Dead ends worth recording (from the exploration):
- `apps/desktop/...` does not exist in this repo — UI lives under `packages/`; my first
  glob targeted `apps/desktop` and returned nothing. Do not re-look there.
- `packages/desktop/src/renderer/` contains NO chat UI — only shell glue (platform
  provider, onboarding, i18n, zoom). Chat UI must not be searched for there.

## 5. User feedback on prior attempts

- Approved: nothing in this session (no artifact shown to the user before this one).
- Rejected: nothing explicit, but message 3 ("make sure it is TRUSTWORTHY") is a
  directive that reads as a correction-by-anticipation: the previous draft's unhedged
  style would not have been acceptable. Recorded verbatim in §0.
- Open user questions: (1) deliver to uxsmith in-swarm, or keep as a file? (2) is
  uxsmith the intended recipient at all?

## 6. Decisions made and rationale

- Decision: store the brief at `docs/swarm-design-uiux-handoff.md` (repo convention —
  sibling docs `swarm-*.md` exist for agent-produced work).
  Alternatives: chat-only (lost), a new skills file (not a skill), `docs/design-*.md`.
  Reversibility: easy (delete file). Approved by: me alone — flag if user prefers
  another location.
- Decision: verify every line reference on disk before writing it down.
  Alternatives: rely on memory of prior exploration. Rejected because the user's
  trustworthiness directive makes unverified refs the one unforgivable error.
  Reversibility: n/a. Approved by: me alone.
- Decision: structure follows AGENT_HANDOFF_SKILL (user-supplied spec).
  Reversibility: easy. Approved by: user (implied by pointing me at the skill).
- Decision: do NOT send anything to the swarm yet (ambiguity in §1).
  Reversibility: easy. Approved by: me alone.

## 7. Known constraints and invariants (from repo AGENTS.md — quoted/paraphrased)

- Runtime deps flow Schema → Core/Protocol → Server; client code (`app`, `session-ui`,
  `ui`) may depend on Schema/Protocol, never Core/Server; `sdk-next` composes all.
- Branch names: ≤3 hyphenated words, no `feat/` prefixes. Commits/PRs conventional:
  `type(scope): summary`. Default branch is `dev`.
- Tests run from package dirs only (never repo root); no mocks; `bun typecheck` from
  package dirs, never bare `tsc`.
- App priorities: stability → simplicity → performance. **Benchmark session/timeline
  changes before AND after.**
- NEVER restart the app/server during dev. Local dev: backend
  `bun run --conditions=browser ./src/index.ts serve --port 4096` (from
  `packages/opencode`), app `bun dev -- --port 4444` from `packages/app` →
  `http://localhost:4444`. `opencode dev web` proxies app.opencode.ai — local UI
  changes will NOT show there.
- SolidJS: prefer `createStore` over multiple `createSignal`s.
- i18n: NEVER hardcode user-visible English; use keys (`language.t`/`language.plural`;
  desktop main process: typed `nativeT`). Preserve existing English byte-for-byte;
  never reword English to help translators. App keys: `packages/app/src/i18n/en.ts`;
  desktop renderer keys: `packages/desktop/src/renderer/i18n/`.
- Style: no `any`, no try/catch where avoidable, `const`+ternaries/early returns,
  no import aliases / star imports, functional array methods with type-guard filters.
- RTL: see `.opencode/skills/rtl-aware-development/SKILL.md` — logical CSS, `bdi`
  isolation, direction-aware scroll (`scrollIntoView({ inline: "nearest" })`), Electron
  titlebar `titleBarOverlay`/`env(titlebar-area-*)`. Test LTR + forced RTL + a real
  RTL locale + mixed content.
- Design system: v2 components in `packages/ui/src/v2/components/` with co-located
  `.css`; tokens `--v2-*`; themes are JSON under `packages/ui/src/theme/themes/` — do
  not hardcode hex in components.

## 8. Dead ends and things already ruled out

- `apps/desktop` — does not exist; the desktop package is `packages/desktop`.
- Chat UI inside `packages/desktop/src/renderer` — ruled out; desktop only shells
  `AppInterface`. (Evidence: index.tsx imports `AppInterface` from `@opencode-ai/app`
  at :407 and renders no chat components itself.)
- First draft's "reference brief" format — ruled out by the skill (§3–§5 above).

## 9. Risks, suspicions, and unknowns

- RISK: line refs in §3 will drift as the repo changes; uxsmith should re-grep before
  editing. The refs are correct as of 2026-08-13.
- RISK: I have not read uxsmith's prior context (its feature docs, swarm blackboard);
  this brief may repeat things it already knows or conflict with its working notes.
- UNKNOWN: whether the user wants this delivered in-swarm (message/task) or kept as a
  file; whether uxsmith is the right recipient.
- UNKNOWN: whether the user considers "trustworthy" fully satisfied; the final judge
  is the user, not my checklist.
- ASSUMPTION (could be wrong): the AGENT_HANDOFF_SKILL from the Adobe path is the
  authoritative spec the user wants followed. It is plausible (user-supplied path) but
  not confirmed in words.

## 10. Validation status summary

| Item | Status | How verified |
|---|---|---|
| Desktop has no chat UI; mounts `AppInterface` | Verified | Read index.tsx:376–425 (:407) |
| Timeline renders tools via `MessagePart`/`ContextToolGroup` | Verified | Read message-timeline.tsx:22–29, 1024–1090 |
| `newLayoutDesigns` gates V2 tool UI | Verified | Read message-timeline.tsx:1077 |
| `BasicTool` at basic-tool.tsx:86, dispatch in message-part.tsx ~:1792 | Verified | grep hits |
| `ToolErrorCard` at tool-error-card.tsx:22, used at message-part.tsx:1587 | Verified | grep hits |
| session-turn.tsx:105 hides pending questions | Verified | grep hit |
| V2 tokens/CSS layout in `packages/ui/src/v2/` | Verified | glob + read colors.css |
| Storybook port 6006 command | Verified | Read storybook/package.json scripts |
| Repo rules quoted in §7 | Verified | Read root/app/desktop/ui AGENTS.md |
| uxsmith exists, idle, frontend engineer | Verified | swarm_roster |
| RTL skill content | Verified | Read SKILL.md |
| User's exact words in §0 | Verified | Quoted from this session's messages |
| Brief conforms to AGENT_HANDOFF_SKILL | Partially | Self-check against §11 questions; not user-reviewed |
| Delivered to uxsmith | Not done | Not attempted (open question) |

## 11. Recommended next actions

1. **User confirms recipient + delivery channel** — because §1 ambiguity is
   load-bearing. Expected signal: "yes, send to uxsmith" (or a correction).
2. **Deliver to uxsmith** (if confirmed): reference `docs/swarm-design-uiux-handoff.md`
   and the anchor topic (agent tool UI in chat sessions). Expected signal: uxsmith's
   read-back restates the goal before acting (per §13).
3. **Re-verify §3 line refs** at edit time — because refs drift. Expected signal:
   greps still match before the first edit.
4. If UI work starts: run the app AGENTS.md benchmark-before protocol first (session
   code), then local dev flow (`packages/app` `bun dev -- --port 4444`).

## 12. Do-not-touch / do-not-repeat list

- Do NOT reword or "improve" existing English UI copy to help translators — it is
  intentional, designer-written source copy; translate around it.
- Do NOT hardcode new user-visible strings; always i18n keys.
- Do NOT edit `src/generated` / `src/generated-effect` in `packages/client` by hand;
  regenerate via `bun run generate` from `packages/client` after Protocol/HttpApi
  changes (legacy JS SDK: `./packages/sdk/js/script/build.ts`).
- Do NOT restart the app or server during dev; do NOT use `opencode dev web` to verify
  local UI (proxies production).
- Do NOT run tests or `bun typecheck` from the repo root.
- Do NOT add `any`, star imports, or import aliases; keep components in one function
  unless genuinely composable.
- Do NOT hardcode hex colors in components — use theme tokens / `--v2-*` vars.
- Do NOT skip the benchmark-before/after protocol when touching session/timeline code.
- Do NOT re-explore `apps/desktop` or hunt for chat UI inside `packages/desktop` — both
  ruled out (§8).
- Do NOT change theme JSON files without checking `packages/ui/src/theme/v2/mapping.ts`
  and `resolve.ts` (v2 mapping owns token resolution).

## 13. Synthesis instruction to the receiving agent (uxsmith)

Before taking any state-changing action (editing files, running commands, sending
messages), please:
1. Restate the user's goal in your own words: a trustworthy, comprehensive working
   brief for you as the design UI/UX agent on the OpenCode chat-sessions UI.
2. Restate the current state: brief written and verified on disk; nothing sent to you
   in-swarm yet; no UI changes made.
3. Flag any part of this handoff you do not trust or do not understand — especially
   the §3 line refs (re-grep them) and the §1 ambiguities.
4. Confirm with the user before acting on anything where the §1 unknowns or §9
   assumptions are load-bearing (recipient, delivery channel, skill spec authority).

> One-line summary: you are not receiving a finished story — you are receiving a
> live, partially-known situation. The verified parts are tagged (§3/§10); everything
> else is labeled as my inference, and the user's trustworthiness directive is the
> standard to hold this work to.
