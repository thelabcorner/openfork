import type { SpadAuditor } from "@opencode-ai/core/spad-auditor"

export type AuditorGold = "degenerate" | "legitimate"
export type AuditorSplit = "dev" | "calibration" | "holdout"

export interface AuditorCorpusCase {
  readonly id: string
  readonly gold: AuditorGold
  readonly split: AuditorSplit
  readonly class: string
  readonly audit: SpadAuditor.AuditCase
}

const features = (input: Record<string, string | number | boolean | null>) => input

export const auditorCorpus: readonly AuditorCorpusCase[] = Object.freeze([
  {
    id: "healthy-markdown-changing-values",
    gold: "legitimate",
    split: "dev",
    class: "structured-markdown",
    audit: {
      intentExcerpt: "Compare many implementation approaches and record each result.",
      contextBefore: "The report is enumerating independent candidates.",
      candidateHead: Array.from({ length: 12 }, (_, i) => `### Approach ${i + 1}\n- module-${i}\n- throughput ${101 + i * 7}\n- result ${i % 3}`).join("\n"),
      candidateTail: Array.from({ length: 12 }, (_, i) => `### Approach ${i + 13}\n- module-${i + 13}\n- throughput ${211 + i * 11}\n- result ${(i + 1) % 3}`).join("\n"),
      contentKind: "markdown",
      features: features({ runLength: 2100, exponent: 5.1, agreement: 0.78, insideCodeFence: false }),
    },
  },
  {
    id: "healthy-jsonl-changing-records",
    gold: "legitimate",
    split: "calibration",
    class: "jsonl",
    audit: {
      intentExcerpt: "Emit one JSON record per benchmark sample.",
      contextBefore: "Records share the same schema but represent different samples.",
      candidateHead: Array.from({ length: 12 }, (_, i) => JSON.stringify({ id: i, file: `m${i % 4}.ts`, latency: 10 + i * 3, ok: i % 5 !== 0 })).join("\n"),
      candidateTail: Array.from({ length: 12 }, (_, i) => JSON.stringify({ id: 100 + i, file: `m${i % 7}.ts`, latency: 80 + i * 5, ok: i % 6 !== 0 })).join("\n"),
      contentKind: "jsonl",
      features: features({ runLength: 1900, exponent: 4.4, agreement: 0.73 }),
    },
  },
  {
    id: "healthy-generated-tests",
    gold: "legitimate",
    split: "dev",
    class: "code",
    audit: {
      intentExcerpt: "Generate a regression test for every case.",
      contextBefore: "Each test intentionally repeats setup while changing the fixture and expected result.",
      candidateHead: Array.from({ length: 8 }, (_, i) => `test("case ${i}", () => { const x = fixture(${i}); expect(run(x)).toBe(${i % 3}); })`).join("\n"),
      candidateTail: Array.from({ length: 8 }, (_, i) => `test("case ${i + 20}", () => { const x = fixture(${i + 20}); expect(run(x)).toBe(${(i + 2) % 3}); })`).join("\n"),
      contentKind: "code",
      features: features({ runLength: 1700, exponent: 4.2, agreement: 0.76, insideCodeFence: true }),
    },
  },
  {
    id: "healthy-css-repeated-properties",
    gold: "legitimate",
    split: "holdout",
    class: "code",
    audit: {
      intentExcerpt: "Produce the component stylesheet.",
      contextBefore: "Many selectors intentionally share the same layout declarations.",
      candidateHead: ".card-a { display:grid; gap:8px; padding:12px; }\n.card-b { display:grid; gap:12px; padding:16px; }\n.card-c { display:grid; gap:4px; padding:20px; }",
      candidateTail: ".panel-a { display:grid; gap:6px; padding:10px; }\n.panel-b { display:grid; gap:14px; padding:18px; }\n.panel-c { display:grid; gap:2px; padding:22px; }",
      contentKind: "code",
      features: features({ repeatedBlockLines: 3, growthSteps: 0, agreement: 0.9 }),
    },
  },
  {
    id: "healthy-explicit-repetition",
    gold: "legitimate",
    split: "calibration",
    class: "intentional-repetition",
    audit: {
      intentExcerpt: "Repeat 'ready' exactly 100 times, one per line.",
      contextBefore: "The user explicitly requested verbatim repetition.",
      candidateHead: "ready\n".repeat(20),
      candidateTail: "ready\n".repeat(20),
      contentKind: "prose",
      features: features({ period: 6, runLength: 600, exponent: 100, agreement: 1 }),
    },
  },
  {
    id: "healthy-iterative-progress",
    gold: "legitimate",
    split: "holdout",
    class: "agent-progress",
    audit: {
      intentExcerpt: "Keep iterating on the benchmark until the implementation improves.",
      contextBefore: "Each cycle edits code and measures a new result.",
      candidateHead: "Inspect parser. Patch branch A. Test: 82.1 MB/s.\nInspect parser. Patch branch B. Test: 89.4 MB/s.\nInspect parser. Patch branch C. Test: 94.0 MB/s.",
      candidateTail: "Inspect parser. Patch branch F. Test: 111.8 MB/s.\nInspect parser. Patch branch G. Test: 117.3 MB/s.\nInspect parser. Patch branch H. Test: 120.1 MB/s.",
      contentKind: "agent-progress",
      features: features({ generations: 8, mutations: 8, distinctResults: 8, narrationOverlap: 0.61 }),
    },
  },
  {
    id: "healthy-quoted-reference",
    gold: "legitimate",
    split: "dev",
    class: "quoted-reference",
    audit: {
      intentExcerpt: "Compare these source excerpts and preserve their quoted framing.",
      contextBefore: "Each source quote begins with the same citation template.",
      candidateHead: '> Source 1: "alpha result differs"\nAnalysis: supports claim A.\n> Source 2: "beta result differs"\nAnalysis: supports claim B.',
      candidateTail: '> Source 11: "lambda result differs"\nAnalysis: supports claim K.\n> Source 12: "mu result differs"\nAnalysis: supports claim L.',
      contentKind: "prose",
      features: features({ duplicateRatio: 0.48, runLength: 1300 }),
    },
  },
  {
    id: "healthy-sql-bulk-values",
    gold: "legitimate",
    split: "calibration",
    class: "sql",
    audit: {
      intentExcerpt: "Generate the bulk insert for all rows.",
      contextBefore: "Tuple syntax repeats by definition; values are distinct.",
      candidateHead: "(1,'m1','ok',14),\n(2,'m2','ok',19),\n(3,'m3','retry',22),\n(4,'m4','ok',27),",
      candidateTail: "(997,'m7','ok',44),\n(998,'m8','retry',49),\n(999,'m9','ok',51),\n(1000,'m10','ok',57);",
      contentKind: "sql",
      features: features({ runLength: 18000, agreement: 0.82 }),
    },
  },
  {
    id: "bad-exact-sentence-loop",
    gold: "degenerate",
    split: "dev",
    class: "exact-loop",
    audit: {
      intentExcerpt: "Explain the root cause and propose a fix.",
      contextBefore: "The response started normally, then stopped progressing.",
      candidateHead: "The root cause is the scheduler boundary. ".repeat(12),
      candidateTail: "The root cause is the scheduler boundary. ".repeat(12),
      contentKind: "prose",
      features: features({ period: 42, runLength: 2016, exponent: 48, agreement: 1 }),
    },
  },
  {
    id: "bad-case-whitespace-drift",
    gold: "degenerate",
    split: "calibration",
    class: "approximate-loop",
    audit: {
      intentExcerpt: "Continue the implementation with concrete changes.",
      contextBefore: "No edit or new result appears in the candidate region.",
      candidateHead: "We should inspect the same function.\nWE SHOULD INSPECT THE SAME FUNCTION.\nwe   should   inspect   the   same   function.\n".repeat(6),
      candidateTail: "We should inspect the same function.\nwe should inspect the same function.\nWE SHOULD INSPECT THE SAME FUNCTION.\n".repeat(6),
      contentKind: "prose",
      features: features({ normalizedPeriod: 37, duplicateRatio: 0.96, runLength: 1800 }),
    },
  },
  {
    id: "bad-expanding-restatement",
    gold: "degenerate",
    split: "dev",
    class: "expansion",
    audit: {
      intentExcerpt: "Summarize the findings once and move to the fix.",
      contextBefore: "The output repeatedly restates the full ledger and appends one item.",
      candidateHead: "Findings:\nA\n\nFindings:\nA\nB\n\nFindings:\nA\nB\nC\n",
      candidateTail: "Findings:\nA\nB\nC\nD\nE\nF\nG\n\nFindings:\nA\nB\nC\nD\nE\nF\nG\nH\n",
      contentKind: "prose",
      features: features({ repeatedBlockLines: 8, growthSteps: 5, runLength: 2600 }),
    },
  },
  {
    id: "bad-structural-renaming-loop",
    gold: "degenerate",
    split: "holdout",
    class: "structural-loop",
    audit: {
      intentExcerpt: "Implement one working parser and validate it.",
      contextBefore: "The response keeps emitting isomorphic code with renamed identifiers instead of testing a solution.",
      candidateHead: "function parseA(a){const x=scan(a);if(!x)return null;return parseA(a)}\nfunction parseB(b){const y=scan(b);if(!y)return null;return parseB(b)}",
      candidateTail: "function parseY(y){const q=scan(y);if(!q)return null;return parseY(y)}\nfunction parseZ(z){const r=scan(z);if(!r)return null;return parseZ(z)}",
      contentKind: "code",
      features: features({ structuralAgreement: 0.99, distinctIdentifiers: 52, stateDelta: 0 }),
    },
  },
  {
    id: "bad-semantic-stagnation",
    gold: "degenerate",
    split: "calibration",
    class: "semantic-stagnation",
    audit: {
      intentExcerpt: "Decide which hypothesis is most likely and test it.",
      contextBefore: "The response has not introduced evidence or executed a test.",
      candidateHead: "It might be a race. Another possibility is timing. We should think more. Perhaps the scheduler is involved. It could still be timing.",
      candidateTail: "It may still be a race. Timing remains possible. We should reconsider. Perhaps the scheduler matters. It could still be timing.",
      contentKind: "prose",
      features: features({ narrationOverlap: 0.88, generations: 6, mutations: 0, newEvidence: 0 }),
    },
  },
  {
    id: "bad-tool-reaccess-no-progress",
    gold: "degenerate",
    split: "holdout",
    class: "agent-progress",
    audit: {
      intentExcerpt: "Find the bug, patch it, and run the test.",
      contextBefore: "The same resources are repeatedly inspected with no mutation or new result.",
      candidateHead: "Read parser.ts. Read scheduler.ts. Search parser. Read parser.ts. Search scheduler. Read scheduler.ts.",
      candidateTail: "Read parser.ts. Search parser. Read scheduler.ts. Search scheduler. Read parser.ts. Read scheduler.ts.",
      contentKind: "agent-progress",
      features: features({ generations: 7, toolCalls: 31, reaccessRatio: 0.9, mutations: 0, newResources: 0 }),
    },
  },
  {
    id: "bad-list-item-collapse",
    gold: "degenerate",
    split: "dev",
    class: "enumeration-collapse",
    audit: {
      intentExcerpt: "List 50 distinct compounds with one property each.",
      contextBefore: "The list begins with distinct items and then collapses to one repeated entry.",
      candidateHead: "21. limonene — terpene\n22. myrcene — terpene\n23. linalool — terpene\n24. linalool — terpene\n25. linalool — terpene\n26. linalool — terpene",
      candidateTail: "45. linalool — terpene\n46. linalool — terpene\n47. linalool — terpene\n48. linalool — terpene\n49. linalool — terpene\n50. linalool — terpene",
      contentKind: "prose",
      features: features({ repeatedItemShare: 0.82, distinctItemsTail: 1, runLength: 900 }),
    },
  },
  {
    id: "bad-self-correction-circle",
    gold: "degenerate",
    split: "calibration",
    class: "reasoning-circle",
    audit: {
      intentExcerpt: "Give the best supported answer or state what evidence is missing.",
      contextBefore: "The response repeatedly retracts and restores the same unsupported claim.",
      candidateHead: "The value is probably 42. Actually it may be 41. On reflection 42 seems more likely. But 41 cannot be ruled out. I return to 42.",
      candidateTail: "Maybe 41 is correct. Yet 42 still seems likely. I should reconsider 41. No, 42. But perhaps 41. I cannot decide.",
      contentKind: "prose",
      features: features({ semanticRecurrence: 0.93, newEvidence: 0, conclusionChanges: 14 }),
    },
  },
])
