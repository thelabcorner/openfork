import { describe, expect, test } from "bun:test";
import { SpadDetector } from "@/session/spad/detector";
import { SpadSupervisor } from "@/session/spad/supervisor";
import { DEFAULT_SPAD_CONFIG } from "@/session/spad/config";
import { makeTurnPolicy } from "@/session/spad/intent";
import { clearPersistedMotifs } from "@/session/spad/pattern-store";
import { ToolResultProgressTracker, isSpadMutatingTool, toolResourceKey } from "@/session/spad/thrash";
import { toolFingerprint } from "@/session/spad/tool-loop";

const canonicalRecovery = { ...DEFAULT_SPAD_CONFIG, autoRecoverCanonical: true };
const toolRecovery = { ...DEFAULT_SPAD_CONFIG, autoRecoverToolLoop: true };
const persistedRecovery = { ...DEFAULT_SPAD_CONFIG, autoRecoverPersistedMotifs: true };
const thrashRecovery = { ...DEFAULT_SPAD_CONFIG, autoRecoverThrash: true };

function feed(detector: SpadDetector, text: string, chunk = 13) {
  let hit: any;
  for (let i = 0; i < text.length; i += chunk) {
    const h = detector.push(text.slice(i, i + chunk));
    if (h) hit = h;
  }
  return hit;
}

function completedTool(sup: SpadSupervisor, tool: string, mutating: boolean, resource: string, output = `stable:${resource}`) {
  const call = sup.pushTool(tool, mutating, resource)
  if (call?.type === "recover" || call?.type === "abort") return call
  return sup.pushToolResult(resource, output)
}

function supPush(sup: SpadSupervisor, text: string, chunk = 17) {
  let a: any;
  for (let i = 0; i < text.length; i += chunk) {
    a = sup.push(text.slice(i, i + chunk));
    if (a) break;
  }
  return a;
}

describe("SPAD frontier — unseen fixtures", () => {
  test("exact period 1 single char long repeat triggers", () => {
    expect(feed(new SpadDetector({ channel: "text" }), "a".repeat(1400), 11)?.period).toBe(1);
  });

  test("exact period 3 word repeat triggers", () => {
    const motif = "foo bar baz ";
    const hit = feed(new SpadDetector({ channel: "text" }), "prefix " + motif.repeat(60), 7);
    expect(hit?.lane).toBe("raw");
    expect(hit?.period).toBe(12);
  });

  test("exact period 120 paragraph triggers", () => {
    const para = "The adaptive context pipeline must preserve token budget while tracking provenance. ".repeat(2);
    const hit = feed(new SpadDetector({ channel: "text" }), "ok\n" + para.repeat(8), 31);
    expect(hit).toBeTruthy();
  });

  test("canonical drift with mixed case and extra spaces triggers recover", () => {
    clearPersistedMotifs();
    const base = "The system should re-anchor to the user request and continue differently";
    const variants = [base, base.toUpperCase(), base.toLowerCase().replaceAll(" ", "   "), "  " + base + "  "];
    let t = "";
    for (let i = 0; i < 25; i++) t += variants[i % variants.length] + "\n";
    const sup = new SpadSupervisor(canonicalRecovery);
    sup.beginTurn(makeTurnPolicy("Continue"));
    sup.startPart("text");
    const a = supPush(sup, t, 13);
    expect(a?.type).toBe("recover");
    expect(a?.detection.lane).toBe("canonical");
  });

  test("high duplicate shingle but not periodic still not false positive at 0.55 gate", () => {
    // varied file reads share boilerplate but not periodic - should not trigger raw or canonical
    const varied = Array.from({ length: 80 }, (_, i) => `Reading file src/lib/module_${i}.ts for analysis`).join("\n");
    const hit = feed(new SpadDetector({ channel: "text" }), varied, 17);
    // canonical may be observe but not raw recover - we ensure no raw recover
    expect(!hit || hit.lane !== "raw").toBe(true);
  });

  test("semantic paraphrase without exact period does not trigger raw", () => {
    const paras = [
      "Let me check the file structure first.",
      "I'll examine the project layout next.",
      "Now I will inspect the directory contents.",
      "Next, I need to look at the file organization.",
    ];
    let t = "";
    for (let i = 0; i < 30; i++) t += paras[i % paras.length] + " ";
    const hit = feed(new SpadDetector({ channel: "text" }), t, 19);
    expect(!hit || hit.lane !== "raw").toBe(true);
  });

  test("code fence raises threshold", () => {
    const motif = "const stableValue = computeStableValue(input);\n";
    expect(feed(new SpadDetector({ channel: "text" }), motif.repeat(7), 11)).toBeTruthy();
    expect(feed(new SpadDetector({ channel: "text" }), "```ts\n" + motif.repeat(7), 11)).toBeFalsy();
    expect(feed(new SpadDetector({ channel: "text" }), "```ts\n" + motif.repeat(18), 11)).toBeTruthy();
  });

  test("low lexical single dash line does not trigger early", () => {
    expect(feed(new SpadDetector({ channel: "text" }), "-".repeat(900), 13)).toBeFalsy();
    expect(feed(new SpadDetector({ channel: "text" }), "-".repeat(1500), 13)?.period).toBe(1);
  });

  test("json lines with varying ids does not trigger", () => {
    let t = "[\n";
    for (let i = 0; i < 800; i++) t += `  {"id":${i},"name":"user_${i}","score":${(i * 13) % 1000}},\n`;
    t += "]";
    const hit = feed(new SpadDetector({ channel: "text" }), t, 64);
    expect(!hit || hit.lane !== "raw").toBe(true);
  });

  test("tool loop period 1 after 24 non-mutating triggers (FP guard) - resource-aware", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor(toolRecovery);
    sup.beginTurn(makeTurnPolicy("do work"));
    let hit: any;
    for (let i = 0; i < 23; i++) hit = sup.pushTool("bash", false);
    expect(hit).toBeUndefined();
    hit = sup.pushTool("bash", false);
    expect(hit?.type).toBe("recover");
    expect(hit?.detection.lane).toBe("tool");
    expect(hit?.detection.source).toBe("tool-loop");
  });

  test("tool loop resets on mutating write", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor(toolRecovery);
    sup.beginTurn(makeTurnPolicy("do work"));
    for (let i = 0; i < 23; i++) sup.pushTool("read", false);
    sup.pushTool("write", true);
    let hit: any;
    for (let i = 0; i < 23; i++) hit = sup.pushTool("read", false);
    expect(hit).toBeUndefined();
  });

  test("tool loop 12 consecutive same tool does NOT trigger (FP guard)", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor(toolRecovery);
    sup.beginTurn(makeTurnPolicy("do work"));
    let hit: any;
    for (let i = 0; i < 12; i++) hit = sup.pushTool("bash", false) ?? hit;
    expect(hit).toBeUndefined();
  });

  test("tool loop with distinct resources does NOT trigger - distinct file exploration is not a loop", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor(toolRecovery);
    sup.beginTurn(makeTurnPolicy("Survey the repo", false));
    let hit: any;
    for (let i = 0; i < 24; i++) hit = sup.pushTool("read", false, `module_${i}.ts`) ?? hit;
    expect(hit).toBeUndefined();
    // Same file repeated 24 times SHOULD trigger (true loop)
    clearPersistedMotifs();
    const sup2 = new SpadSupervisor(toolRecovery);
    sup2.beginTurn(makeTurnPolicy("do work", false));
    let hit2: any;
    for (let i = 0; i < 23; i++) hit2 = sup2.pushTool("read", false, "same.ts");
    expect(hit2).toBeUndefined();
    hit2 = sup2.pushTool("read", false, "same.ts");
    expect(hit2?.type).toBe("recover");
  });

  test("tool-loop narrow hash collisions are terminally verified", () => {
    const seen = new Map<number, string>();
    let collision: [string, string] | undefined;
    for (let i = 0; i < 4000 && !collision; i++) {
      const resource = `collision_probe_${i}.ts`;
      const narrow = toolFingerprint("read", resource).narrow;
      const previous = seen.get(narrow);
      if (previous && previous !== resource) collision = [previous, resource];
      else seen.set(narrow, resource);
    }
    expect(collision).toBeDefined();

    const sup = new SpadSupervisor(toolRecovery);
    sup.beginTurn(makeTurnPolicy("Inspect the same two resources repeatedly."));
    let action: any;
    // Every call has the same lossy Uint16 proposal symbol, but the true
    // full-width sequence alternates A/B. Terminal verification must recover
    // period 2 instead of falsely authorizing period 1.
    for (let i = 0; i < 24; i++) action = sup.pushTool("read", false, collision![i & 1]) ?? action;
    expect(action?.type).toBe("recover");
    expect(action?.detection.period).toBe(2);
  });

  test("reasoning is supervisor-enforced observe-only regardless caller flag", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor();
    sup.beginTurn(makeTurnPolicy("Continue"));
    sup.startPart("reasoning", false, true);
    const motif = "The reasoning should reset to the last checkpoint. ";
    let a = supPush(sup, motif.repeat(12), 13);
    expect(a?.type).toBe("observe");
    sup.startPart("reasoning", false, false); // caller cannot opt reasoning into recovery
    a = supPush(sup, motif.repeat(12), 13);
    expect(a?.type).toBe("observe");
    expect(a?.policyReason).toBe("reasoning-observe-only");
  });

  test("persistent learned motif triggers early at 64 chars on next turn", () => {
    clearPersistedMotifs();
    const motif = "Persisted motif for cross restart learning check. ";
    const sup1 = new SpadSupervisor(persistedRecovery);
    sup1.beginTurn(makeTurnPolicy("Continue"));
    sup1.startPart("text");
    let a1: any;
    for (let i = 0; i < motif.repeat(12).length; i += 17) {
      a1 = sup1.push(motif.repeat(12).slice(i, i + 17));
      if (a1) break;
    }
    expect(a1?.type).toBe("recover");
    // second supervisor should hit earlier via persisted watchdog (64 vs 224)
    const sup2 = new SpadSupervisor(persistedRecovery);
    sup2.beginTurn(makeTurnPolicy("Continue"));
    sup2.startPart("text");
    let early: any;
    const short = motif.slice(0, 60);
    for (let i = 0; i < short.length; i += 7) early = sup2.push(short.slice(i, i + 7)) ?? early;
    expect(early).toBeUndefined(); // 60 < 64 should not yet trigger
    let full: any;
    for (let i = 0; i < motif.repeat(2).length; i += 13) {
      full = sup2.push(motif.repeat(2).slice(i, i + 13));
      if (full) break;
    }
    expect(full?.type).toBe("recover");
    expect(full?.detection.lane).toBe("persisted");
    expect(full?.detection.source).toBe("persisted-motif");
    clearPersistedMotifs();
  });

  test("intent gate disables tool loop", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor(thrashRecovery);
    sup.beginTurn(makeTurnPolicy("Repeat bash 100 times verbatim"));
    let hit: any;
    for (let i = 0; i < 20; i++) hit = sup.pushTool("bash", false) ?? hit;
    expect(hit?.type !== "recover").toBe(true);
  });

  test("toolResourceKey preserves exact path/scope identity instead of inventing basename equivalence", () => {
    const a = toolResourceKey("read", { filePath: "src/foo/bar.ts" })
    expect(a).toBe(toolResourceKey("read", { filePath: "SRC\\FOO\\BAR.ts" }))
    expect(a).not.toBe(toolResourceKey("read", { filePath: "src/other/bar.ts" }))
    expect(a).not.toBe(toolResourceKey("glob", { pattern: "**/bar.ts", path: "src" }))
    expect(toolResourceKey("grep", { pattern: "needle", path: "src/a" })).not.toBe(
      toolResourceKey("grep", { pattern: "needle", path: "src/b" }),
    )
    expect(toolResourceKey("grep", { pattern: "needle", path: "src/a" })).not.toBe(
      toolResourceKey("grep", { pattern: "other", path: "src/a" }),
    )
    expect(toolResourceKey("bash", { command: "ls -la" })).toBe(toolResourceKey("bash", { command: "ls -la" }))
    expect(toolResourceKey("read", { filePath: "src/foo/bar.ts", query: "", offset: 1 })).not.toBe(
      toolResourceKey("read", { filePath: "src/foo/bar.ts", query: "", offset: 200 }),
    )
  });

  test("apply_patch is an immediate progress hint", () => {
    expect(isSpadMutatingTool("apply_patch")).toBe(true)
    expect(isSpadMutatingTool("read")).toBe(false)
  });

  test("host-attested progress clears accumulated stagnation evidence", () => {
    clearPersistedMotifs()
    const sup = new SpadSupervisor(thrashRecovery)
    sup.beginTurn(makeTurnPolicy("Investigate and fix the issue."))
    for (let g = 0; g < 2; g++) {
      sup.markGeneration()
      sup.startPart("text")
      sup.push("Rechecking the same implementation details before the next concrete change.")
      expect(sup.pushTool("read", false, "src/a.ts:o1")?.type).not.toBe("recover")
      expect(sup.pushTool("read", false, "src/b.ts:o1")?.type).not.toBe("recover")
    }
    sup.markProgress()
    for (let g = 0; g < 2; g++) {
      sup.markGeneration()
      sup.startPart("text")
      sup.push("Rechecking the same implementation details after the verified filesystem change.")
      expect(sup.pushTool("read", false, "src/a.ts:o1")?.type).not.toBe("recover")
      expect(sup.pushTool("read", false, "src/b.ts:o1")?.type).not.toBe("recover")
    }
  });

  test("toolResourceKey distinguishes SQLite queries instead of collapsing on action=query", () => {
    const a = toolResourceKey("sqlite", {
      action: "query",
      db: "C:/tmp/opencode.db",
      sql: "SELECT COUNT(*) FROM part",
    })
    const b = toolResourceKey("sqlite", {
      action: "query",
      db: "C:/tmp/opencode.db",
      sql: "SELECT COUNT(*) FROM session",
    })
    const same = toolResourceKey("sqlite", {
      action: "query",
      db: "C:/tmp/opencode.db",
      sql: "  select   count(*)   from part  ",
    })
    expect(a).not.toBe(b)
    expect(a).toBe(same)
    expect(a.length).toBeLessThan(140)
  });

  test("reasoning defaults to exact-only observation while research can opt heuristic lanes back in", () => {
    const base = "The system should re-anchor to the user request and continue differently"
    let text = ""
    let state = 0x9e3779b9 >>> 0
    for (let line = 0; line < 48; line++) {
      let variant = ""
      for (let i = 0; i < base.length; i++) {
        let char = base[i]!
        state ^= state << 13; state ^= state >>> 17; state ^= state << 5
        if (char === " ") {
          variant += " ".repeat(1 + ((state >>> 0) % 4))
          continue
        }
        if (/[A-Za-z]/.test(char)) char = (state >>> 0) & 1 ? char.toUpperCase() : char.toLowerCase()
        variant += char
      }
      text += variant + "\n"
    }

    const production = feed(new SpadDetector({ channel: "reasoning" }), text, 13)
    expect(production).toBeUndefined()

    const research = feed(
      new SpadDetector({ channel: "reasoning", observeHeuristicLanes: true }),
      text,
      13,
    )
    expect(research?.lane).toBe("canonical")
  })

  test("tool result progress tracking is resource-local", () => {
    const tracker = new ToolResultProgressTracker();
    expect(tracker.observe("status:a", "v1")).toBe(false);
    expect(tracker.observe("status:b", "stable")).toBe(false);
    expect(tracker.observe("status:a", "v2")).toBe(true);
    // Changing A must not erase B's baseline or manufacture progress on B.
    expect(tracker.observe("status:b", "stable")).toBe(false);
    expect(tracker.observe("status:a", "v2")).toBe(false);
  });

  test("cross-turn re-exploration without progress (grotli-class) is recovered", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor(thrashRecovery);
    sup.beginTurn(makeTurnPolicy("Implement the benchmark harness."));
    const steps: Array<{ tools: Array<[string, boolean, string]>; text: string }> = [
      { tools: [["read", false, "grotli.ts"]], text: "Let me start by understanding the existing codebase before implementing anything." },
      { tools: [["glob", false, "benchmark.ts"], ["glob", false, "measurement.md"], ["glob", false, "experimental.ts"]], text: "I see the project structure. Let me look at the actual files mentioned in the assignment." },
      { tools: [["read", false, "benchmark.ts"], ["read", false, "measurement.md"]], text: "Let me read the benchmark and measurement files to understand the current implementation." },
      { tools: [["read", false, "grotli.ts"], ["read", false, "unittests.ts"]], text: "Now let me read the rest of grotli and the unit tests to understand the full pipeline." },
      { tools: [["read", false, "measurement.md"], ["read", false, "benchmark.ts"]], text: "Now I have a good understanding of what has been verified and what remains." },
      { tools: [["read", false, "benchmark.ts"]], text: "Let me check the specific part of benchmark that defines the dataset specifications." },
    ]
    let action: any;
    outer: for (const step of steps) {
      sup.markGeneration();
      sup.startPart("text");
      for (const [tool, mut, res] of step.tools) {
        const t = completedTool(sup, tool, mut, res)
        if (t && (t.type === "recover" || t.type === "abort")) { action = t; break outer }
      }
      let a: any
      for (let i = 0; i < step.text.length; i += 17) {
        a = sup.push(step.text.slice(i, i + 17))
        if (a) break
      }
      if (a && (a.type === "recover" || a.type === "abort")) { action = a; break }
    }
    expect(action?.type).toBe("recover");
    expect(action?.detection.lane).toBe("thrash");
    expect(action?.noTruncate).toBe(true);
  });

  test("multi-file refactor that edits is not flagged", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor(thrashRecovery);
    sup.beginTurn(makeTurnPolicy("Refactor the codec into modules."));
    const steps: Array<{ tools: Array<[string, boolean, string]>; text: string }> = [
      { tools: [["read", false, "a.ts"], ["read", false, "b.ts"], ["read", false, "c.ts"]], text: "Let me read the three modules." },
      { tools: [["edit", true, "a.ts"], ["read", false, "d.ts"]], text: "Refactored a and reading d." },
      { tools: [["edit", true, "b.ts"], ["read", false, "e.ts"]], text: "Refactored b and reading e." },
      { tools: [["edit", true, "c.ts"], ["read", false, "f.ts"]], text: "Refactored c and reading f." },
      { tools: [["edit", true, "d.ts"], ["read", false, "g.ts"]], text: "Refactored d and reading g." },
    ]
    let acted = false
    outer: for (const step of steps) {
      sup.markGeneration();
      sup.startPart("text");
      for (const [tool, mut, res] of step.tools) {
        const t = completedTool(sup, tool, mut, res)
        if (t && (t.type === "recover" || t.type === "abort")) { acted = true; break outer }
      }
      let a: any
      for (let i = 0; i < step.text.length; i += 17) {
        a = sup.push(step.text.slice(i, i + 17))
        if (a) break
      }
      if (a && (a.type === "recover" || a.type === "abort")) acted = true
    }
    expect(acted).toBe(false);
  });

  test("read-only exploration that keeps discovering new files is not flagged", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor(thrashRecovery);
    sup.beginTurn(makeTurnPolicy("Survey the repository."));
    const letters = "abcdefghijklmnopqrst".split("");
    let acted = false
    outer: for (let g = 0; g < 5; g++) {
      sup.markGeneration();
      sup.startPart("text");
      const tools: Array<[string, boolean, string]> = [
        ["read", false, `${letters[g * 2]!}.ts`],
        ["read", false, `${letters[g * 2 + 1]!}.ts`],
      ];
      for (const [tool, mut, res] of tools) {
        const t = completedTool(sup, tool, mut, res)
        if (t && (t.type === "recover" || t.type === "abort")) { acted = true; break outer }
      }
      const text = `Surveying module ${letters[g * 2]!} which contains the entrypoint logic.`
      let a: any
      for (let i = 0; i < text.length; i += 13) {
        a = sup.push(text.slice(i, i + 13))
        if (a) break
      }
      if (a && (a.type === "recover" || a.type === "abort")) acted = true
    }
    expect(acted).toBe(false);
  });

  test("pure narration repetition without tool re-access is NOT flagged", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor();
    sup.beginTurn(makeTurnPolicy("Write the report."));
    const narration = "Let me think about this step carefully. I will consider the options and then proceed with the plan.";
    let acted = false
    for (let i = 0; i < 6; i++) {
      sup.markGeneration();
      sup.startPart("text");
      let a: any;
      for (let j = 0; j < narration.length; j += 19) {
        a = sup.push(narration.slice(j, j + 19));
        if (a) break;
      }
      if (a && (a.type === "recover" || a.type === "abort")) acted = true;
    }
    expect(acted).toBe(false);
  });

  test("mild resource re-access combined with recurring narration is recovered", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor(thrashRecovery);
    sup.beginTurn(makeTurnPolicy("Implement the feature."));
    const narration = "Let me re-read the shared module and reconsider the same approach before continuing.";
    let action: any;
    outer: for (let g = 0; g < 8; g++) {
      sup.markGeneration();
      sup.startPart("text");
      // one re-accessed file every generation plus one genuinely new file
      const t1 = completedTool(sup, "read", false, "shared.ts");
      const t2 = completedTool(sup, "read", false, `new_${g}.ts`);
      if ((t1 && (t1.type === "recover" || t1.type === "abort")) || (t2 && (t2.type === "recover" || t2.type === "abort"))) {
        action = t1 ?? t2;
        break;
      }
      let a: any;
      for (let j = 0; j < narration.length; j += 13) {
        a = sup.push(narration.slice(j, j + 13));
        if (a) break;
      }
      if (a && (a.type === "recover" || a.type === "abort")) { action = a; break }
    }
    expect(action?.type).toBe("recover");
    expect(action?.detection.lane).toBe("thrash");
  });

  test("cross-turn thrash escalates to abort after the recovery budget", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor(thrashRecovery);
    sup.beginTurn(makeTurnPolicy("Implement the feature."));
    let recoveries = 0
    let abort = false
    outer: for (let g = 0; g < 12 && !abort; g++) {
      sup.markGeneration();
      sup.startPart("text");
      for (let r = 0; r < 3; r++) {
        const t = completedTool(sup, "read", false, `samefile_${r}.ts`);
        if (t?.type === "recover") { recoveries++; sup.startPart("text", true); continue outer }
        if (t?.type === "abort") { abort = true; break outer }
      }
      const narration = "I am still working through the same approach and re-reading the same context again.";
      let a: any;
      for (let j = 0; j < narration.length; j += 13) {
        a = sup.push(narration.slice(j, j + 13));
        if (a) break;
      }
      if (a?.type === "recover") { recoveries++; sup.startPart("text", true) }
      else if (a?.type === "abort") { abort = true }
    }
    expect(recoveries).toBeGreaterThanOrEqual(1);
    expect(abort).toBe(true);
  });

  test("bounded A/B generation-state cycle is observed without destructive authority", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor(DEFAULT_SPAD_CONFIG);
    sup.beginTurn(makeTurnPolicy("Investigate the lifecycle bug."));
    const states = [
      {
        resources: ["sqlite.bun.ts:o120:l80"],
        narration: "The native layer closes in a finalizer, so I am rechecking the same lifetime question.",
      },
      {
        resources: ["migration.ts:o90:l60", "database.ts:o1:l50"],
        narration: "Neither helper opens a connection, so I am rechecking the same two call sites.",
      },
    ];
    let action: any;
    for (let generation = 0; generation < 4; generation++) {
      sup.markGeneration();
      sup.startPart("text");
      const state = states[generation % 2]!;
      for (const resource of state.resources) {
        sup.pushTool("read", false, resource);
        action = sup.pushToolResult(resource, `stable:${resource}`) ?? action;
      }
      for (let i = 0; i < state.narration.length; i += 17)
        action = sup.push(state.narration.slice(i, i + 17)) ?? action;
    }
    expect(action?.type).toBe("observe");
    expect(action?.policyReason).toBe("state-cycle-observe-only");
    expect(action?.detection.lane).toBe("state");
    expect(action?.detection.source).toBe("generation-state-cycle");
    expect(action?.detection.stateCyclePeriod).toBe(2);
    expect(action?.detection.stateCycleComparisons).toBe(2);
  });

  test("three unchanged passive results produce early information evidence only", () => {
    const sup = new SpadSupervisor(DEFAULT_SPAD_CONFIG);
    sup.beginTurn(makeTurnPolicy("Inspect the same status if needed."));
    let action: any;
    for (let generation = 0; generation < 3; generation++) {
      sup.markGeneration();
      sup.startPart("text");
      sup.pushTool("status", false, "job:42");
      action = sup.pushToolResult("job:42", "still pending") ?? action;
      action = sup.push(`Distinct narration for generation ${generation}, avoiding a state-cycle match.`) ?? action;
    }
    expect(action?.type).toBe("observe");
    expect(action?.policyReason).toBe("information-observe-only");
    expect(action?.detection.lane).toBe("information");
    expect(action?.detection.informationRecurrences).toBe(3);
  });

  test("host progress invalidates stale progress-sensitive auditor evidence", () => {
    const sup = new SpadSupervisor(DEFAULT_SPAD_CONFIG);
    sup.beginTurn(makeTurnPolicy("Inspect status, then continue implementing."));
    for (let generation = 0; generation < 3; generation++) {
      sup.markGeneration();
      sup.startPart("text");
      sup.pushTool("status", false, "job:42");
      sup.pushToolResult("job:42", "still pending");
    }
    sup.markProgress();
    expect(sup.takeAuditCases().some((candidate) => candidate.detection.source === "information-recurrence")).toBe(false);

    for (let generation = 0; generation < 3; generation++) {
      sup.markGeneration();
      sup.startPart("text");
      sup.pushTool("status", false, "job:42");
      sup.pushToolResult("job:42", "still pending");
    }
    expect(sup.takeAuditCases().some((candidate) => candidate.detection.source === "information-recurrence")).toBe(true);
  });
});

