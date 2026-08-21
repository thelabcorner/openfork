import { describe, expect, test } from "bun:test";
import { SpadDetector } from "@/session/spad/detector";
import { SpadSupervisor } from "@/session/spad/supervisor";
import { makeTurnPolicy } from "@/session/spad/intent";
import { clearPersistedMotifs } from "@/session/spad/pattern-store";
import { toolResourceKey } from "@/session/spad/thrash";

function feed(detector: SpadDetector, text: string, chunk = 13) {
  let hit: any;
  for (let i = 0; i < text.length; i += chunk) {
    const h = detector.push(text.slice(i, i + chunk));
    if (h) hit = h;
  }
  return hit;
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
    const sup = new SpadSupervisor();
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

  test("tool loop period 1 after 16 non-mutating triggers (FP guard)", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor();
    sup.beginTurn(makeTurnPolicy("do work"));
    let hit: any;
    for (let i = 0; i < 15; i++) hit = sup.pushTool("bash", false);
    expect(hit).toBeUndefined();
    hit = sup.pushTool("bash", false);
    expect(hit?.type).toBe("recover");
  });

  test("tool loop resets on mutating write", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor();
    sup.beginTurn(makeTurnPolicy("do work"));
    for (let i = 0; i < 15; i++) sup.pushTool("read", false);
    sup.pushTool("write", true);
    let hit: any;
    for (let i = 0; i < 15; i++) hit = sup.pushTool("read", false);
    expect(hit).toBeUndefined();
  });

  test("tool loop 12 consecutive same tool does NOT trigger (FP guard)", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor();
    sup.beginTurn(makeTurnPolicy("do work"));
    let hit: any;
    for (let i = 0; i < 12; i++) hit = sup.pushTool("bash", false) ?? hit;
    expect(hit).toBeUndefined();
  });

  test("reasoning unsigned can recover, signed stays observe via processor path simulated via supervisor observeOnly", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor();
    sup.beginTurn(makeTurnPolicy("Continue"));
    sup.startPart("reasoning", false, true); // signed -> observe
    const motif = "The reasoning should reset to the last checkpoint. ";
    let a = supPush(sup, motif.repeat(12), 13);
    expect(a?.type).toBe("observe");
    sup.startPart("reasoning", false, false); // unsigned -> recover
    a = supPush(sup, motif.repeat(12), 13);
    expect(a?.type).toBe("recover");
  });

  test("persistent learned motif triggers early at 64 chars on next turn", () => {
    clearPersistedMotifs();
    const motif = "Persisted motif for cross restart learning check. ";
    const sup1 = new SpadSupervisor();
    sup1.beginTurn(makeTurnPolicy("Continue"));
    sup1.startPart("text");
    let a1: any;
    for (let i = 0; i < motif.repeat(12).length; i += 17) {
      a1 = sup1.push(motif.repeat(12).slice(i, i + 17));
      if (a1) break;
    }
    expect(a1?.type).toBe("recover");
    // second supervisor should hit earlier via persisted watchdog (64 vs 224)
    const sup2 = new SpadSupervisor();
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
    clearPersistedMotifs();
  });

  test("intent gate disables tool loop", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor();
    sup.beginTurn(makeTurnPolicy("Repeat bash 100 times verbatim"));
    let hit: any;
    for (let i = 0; i < 20; i++) hit = sup.pushTool("bash", false) ?? hit;
    expect(hit?.type !== "recover").toBe(true);
  });

  test("toolResourceKey collapses read and glob of the same file", () => {
    expect(toolResourceKey("read", { filePath: "src/foo/bar.ts" })).toBe("bar.ts")
    expect(toolResourceKey("glob", { pattern: "**/bar.ts" })).toBe("bar.ts")
    expect(toolResourceKey("read", { filePath: "BAR.ts" })).toBe("bar.ts")
    expect(toolResourceKey("read", { path: "x/y/z.ts" })).toBe("z.ts")
    // non-file tools stay distinct via name + signature
    expect(toolResourceKey("bash", { command: "ls -la" })).toBe("bash:ls -la")
  });

  test("cross-turn re-exploration without progress (grotli-class) is recovered", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor();
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
        const t = sup.pushTool(tool, mut, res)
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
    const sup = new SpadSupervisor();
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
        const t = sup.pushTool(tool, mut, res)
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
    const sup = new SpadSupervisor();
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
        const t = sup.pushTool(tool, mut, res)
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
    const sup = new SpadSupervisor();
    sup.beginTurn(makeTurnPolicy("Implement the feature."));
    const narration = "Let me re-read the shared module and reconsider the same approach before continuing.";
    let action: any;
    outer: for (let g = 0; g < 8; g++) {
      sup.markGeneration();
      sup.startPart("text");
      // one re-accessed file every generation plus one genuinely new file
      const t1 = sup.pushTool("read", false, "shared.ts");
      const t2 = sup.pushTool("read", false, `new_${g}.ts`);
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
    const sup = new SpadSupervisor();
    sup.beginTurn(makeTurnPolicy("Implement the feature."));
    let recoveries = 0
    let abort = false
    outer: for (let g = 0; g < 12 && !abort; g++) {
      sup.markGeneration();
      sup.startPart("text");
      for (let r = 0; r < 3; r++) {
        const t = sup.pushTool("read", false, `samefile_${r}.ts`);
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
});

