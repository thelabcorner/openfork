import { describe, expect, test } from "bun:test";
import { SpadDetector } from "@/session/spad/detector";
import { SpadSupervisor } from "@/session/spad/supervisor";
import { makeTurnPolicy } from "@/session/spad/intent";
import { clearPersistedMotifs } from "@/session/spad/pattern-store";
import fs from "fs";
import path from "path";

function feed(det: SpadDetector, text: string) {
  let hit: any;
  for (let i = 0; i < text.length; i += 256) {
    const h = det.push(text.slice(i, i+256));
    if (h) hit = h;
  }
  return hit;
}

// Load real TS files as negative fixtures (should not trigger raw)
const glob = new Bun.Glob("src/**/*.ts");
const tsFiles = Array.from(glob.scanSync({ cwd: path.join(import.meta.dir, "../../") }));
const sampled = tsFiles.slice(0, 30);

describe("SPAD more fixtures — unseen", () => {
  test("30 real TS files do not trigger raw", async () => {
    clearPersistedMotifs();
    let fps = 0;
    for (const rel of sampled) {
      const full = path.join(path.join(import.meta.dir, "../../"), rel);
      const text = fs.readFileSync(full, "utf8").slice(0, 20000);
      const hit = feed(new SpadDetector({ channel: "text" }), text);
      if (hit?.lane === "raw") {
        fps++;
        // console.log("FP", rel, hit);
      }
    }
    expect(fps).toBe(0);
  });

  test("synthetic negatives — lorem, csv, logs, json", () => {
    clearPersistedMotifs();
    const lorem = Array.from({ length: 500 }, () => "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua").join(" ");
    expect(feed(new SpadDetector({ channel: "text" }), lorem)?.lane).not.toBe("raw");

    let csv = "id,name,score\n";
    for (let i = 0; i < 2000; i++) csv += `${i},user_${i},${(i * 17) % 1000}\n`;
    expect(feed(new SpadDetector({ channel: "text" }), csv)?.lane).not.toBe("raw");

    let logs = "";
    for (let i = 0; i < 2000; i++) logs += `[2024-01-01T00:00:${String(i % 60).padStart(2, "0")}Z] INFO request_id=${i} user=${i % 100} latency=${(i * 13) % 200}ms\n`;
    expect(feed(new SpadDetector({ channel: "text" }), logs)?.lane).not.toBe("raw");

    let jsonl = "";
    for (let i = 0; i < 1000; i++) jsonl += `{"id":${i},"payload":"${"x".repeat(20)}_${i}","ok":${i % 2 === 0}}\n`;
    expect(feed(new SpadDetector({ channel: "text" }), jsonl)?.lane).not.toBe("raw");
  });

  test("positives — exact loops still trigger", () => {
    clearPersistedMotifs();
    expect(feed(new SpadDetector({ channel: "text" }), "abc".repeat(800))).toBeTruthy();
    expect(feed(new SpadDetector({ channel: "text" }), "hello world ".repeat(400))).toBeTruthy();
    const para = "The quick brown fox jumps over the lazy dog. ".repeat(30);
    expect(feed(new SpadDetector({ channel: "text" }), "start\n" + para.repeat(5))).toBeTruthy();
  });

  test("canonical drift still triggers with 0.65 gate", () => {
    clearPersistedMotifs();
    const base = "Re-anchor to the user request and continue with a different continuation";
    const vars = [base, base.toUpperCase(), base.toLowerCase().replaceAll(" ", "  ")];
    let t = "";
    for (let i = 0; i < 30; i++) t += vars[i % vars.length] + "\n";
    const sup = new SpadSupervisor();
    sup.beginTurn(makeTurnPolicy("Continue"));
    sup.startPart("text");
    let a: any;
    for (let i = 0; i < t.length; i += 13) { a = sup.push(t.slice(i, i+13)); if (a) break; }
    expect(a?.type).toBe("recover");
    expect(a?.detection.canonicalDuplicate4GramRatio).toBeGreaterThan(0.65);
  });

  test("tool sequences — 23 reads no trigger, 24 triggers, write resets (resource-aware threshold)", () => {
    clearPersistedMotifs();
    const sup = new SpadSupervisor();
    sup.beginTurn(makeTurnPolicy("explore"));
    for (let i = 0; i < 23; i++) expect(sup.pushTool("read", false)).toBeUndefined();
    expect(sup.pushTool("read", false)?.type).toBe("recover");
    clearPersistedMotifs();
    const sup2 = new SpadSupervisor();
    sup2.beginTurn(makeTurnPolicy("explore"));
    for (let i = 0; i < 23; i++) sup2.pushTool("read", false);
    sup2.pushTool("write", true);
    for (let i = 0; i < 23; i++) expect(sup2.pushTool("read", false)).toBeUndefined();
  });

  test("three user json fixtures as negatives/positives", () => {
    clearPersistedMotifs();
    const files = [
      "C:/Users/slooshied/Downloads/arcfit-admin-overhaul-implementation.json",
      "C:/Users/slooshied/Downloads/grotli-pareto-adaptive-context.json",
      "C:/Users/slooshied/Downloads/optimize-arcfit-c-files-with-dual-agent-swarms.json",
    ];
    for (const fp of files) {
      if (!fs.existsSync(fp)) continue;
      const j = JSON.parse(fs.readFileSync(fp, "utf8"));
      const texts: string[] = [];
      for (const m of j.messages) {
        if (m.info.role !== "assistant") continue;
        for (const p of m.parts) if ((p.type === "text" || p.type === "reasoning") && p.text) texts.push(p.text);
      }
      const concat = texts.join("\n\n");
      // Concatenated across messages is not how SPAD runs (per-part), so we test per-part does not raw-trigger on varied exploration
      let rawHits = 0;
      for (const t of texts) {
        const h = feed(new SpadDetector({ channel: "text" }), t.slice(0, 5000));
        if (h?.lane === "raw") rawHits++;
      }
      // At most the known grotli 29k reasoning should be canonical, not raw — allow 0-1 raw hits
      expect(rawHits).toBeLessThanOrEqual(1);
    }
  });

  test("code fence and low lexical guards", () => {
    clearPersistedMotifs();
    const motif = "const stableValue = computeStableValue(input);\n";
    expect(feed(new SpadDetector({ channel: "text" }), motif.repeat(7))).toBeTruthy();
    expect(feed(new SpadDetector({ channel: "text" }), "```ts\n" + motif.repeat(7))).toBeFalsy();
    expect(feed(new SpadDetector({ channel: "text" }), "-".repeat(900))).toBeFalsy();
    expect(feed(new SpadDetector({ channel: "text" }), "-".repeat(2000))?.period).toBe(1);
  });
});
