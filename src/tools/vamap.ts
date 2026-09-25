// Build the guest-VA → HostMemory-offset map for the heap: sample 64 bytes at
// the start of every 2 MiB heap block via GDB (one short pause), then locate
// each sample in the memfd. Output: data/vamap.json [[vaOffset, physOffset, len]...]
import { GdbClient } from "../reader/gdb.ts";
import { openSync, readSync, fstatSync, writeFileSync } from "node:fs";

const pid = process.argv[2];
const BLOCK = 0x200000, HEAP_LEN = 0xc0000000;
const gdb = new GdbClient();
await gdb.connect();
const heap = BigInt("0x" + /Heap:\s+0x([0-9a-f]+)/i.exec(await gdb.monitor("get info"))![1]);
const samples = new Map<number, Buffer>();
const t0 = performance.now();
try {
  for (let off = 0; off < HEAP_LEN; off += BLOCK) {
    const r = await gdb.command(`m${(heap + BigInt(off)).toString(16)},40`);
    if (!/^E[0-9a-f]{2}$/i.test(r)) samples.set(off, Buffer.from(r, "hex"));
  }
} finally { gdb.resume(); gdb.close(); }
console.log(`sampled ${samples.size} blocks, game paused ${(performance.now() - t0).toFixed(0)} ms`);

// Read the whole memfd once in 2 MiB-aligned pages and index by first 64 bytes.
const fd = openSync(`/proc/${pid}/fd/${process.argv[3]}`, "r");
const index = new Map<string, number[]>();
const page = Buffer.alloc(0x40);
for (let p = 0; p < 0x100000000; p += 0x1000) {
  readSync(fd, page, 0, 0x40, p);
  const k = page.toString("hex");
  const arr = index.get(k); if (arr) { if (arr.length < 4) arr.push(p); } else index.set(k, [p]);
}
const map: [number, number][] = [];
for (const [va, s] of samples) {
  const hits = index.get(s.toString("hex"));
  if (hits && hits.length === 1) map.push([va, hits[0]]);
}
map.sort((a, b) => a[0] - b[0]);
// Collapse consecutive blocks with a constant delta into runs.
const runs: [number, number, number][] = [];
for (const [va, pa] of map) {
  const r = runs[runs.length - 1];
  if (r && va === r[0] + r[2] && pa - va === r[1] - r[0]) r[2] += BLOCK;
  else runs.push([va, pa, BLOCK]);
}
writeFileSync("data/vamap.json", JSON.stringify(runs));
console.log(`${map.length} blocks located uniquely, ${runs.length} runs:`);
for (const [va, pa, len] of runs.slice(0, 30)) console.log(`  heap+0x${va.toString(16)} → phys 0x${pa.toString(16)} (0x${len.toString(16)})`);
