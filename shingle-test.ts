import { ShingleVerifier } from "./src/session/spad/shingle-verifier.ts";
function ratio(text: string) {
  const v = new ShingleVerifier(8192);
  const get = (i: number) => text.charCodeAt(i);
  return v.duplicate4GramRatio(get, 0, text.length);
}
const bulk = (() => {
  let t = "BEGIN;\n";
  for (let i = 0; i < 500; i++) t += `INSERT INTO t(id,name,score) VALUES (${i},'row_${i}',${(i * 17) % 997});\n`;
  return t;
})();
console.log("bulk", bulk.length, ratio(bulk));
const rep = "The implementation should continue from the last stable state. ".repeat(50);
console.log("rep raw", rep.length, ratio(rep));
const grotli = "I've reviewed the existing files. Now let me understand the current state:  1. `src/lib/grotli.ts` - The main Grotli codec library with all the algorithms 2. `src/lib/benchmark.ts` - The benchmark engine with dataset specs 3. `refs/genesis/MEASUREMENT.md` - ".repeat(30);
console.log("grotli", grotli.length, ratio(grotli));
const normal = "A streaming detector should distinguish ordinary lexical reuse from a genuine periodic attractor. ".repeat(20);
console.log("normal", normal.length, ratio(normal));
const varied = Array.from({ length: 100 }, (_, i) => `Let me read file src/lib/file${i}.ts to understand the structure.`).join("\n");
console.log("varied reads", varied.length, ratio(varied));
