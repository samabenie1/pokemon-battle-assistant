// Phase 0: prove we can read Sword's RAM through Eden's GDB stub and measure
// how long each halt→read→resume stalls the game.
import { GdbClient } from "../reader/gdb.ts";
import { SWSH_132 as O } from "../offsets/swsh-1.3.2.ts";

const gdb = new GdbClient();
await gdb.connect();
const info = await gdb.monitor("get info");
console.log("--- monitor get info ---\n" + info);

const heap = BigInt("0x" + (/heap[^\n]*?0x([0-9a-f]+)/i.exec(info)?.[1] ?? "0"));
if (!heap) throw new Error("couldn't find heap base in `get info` output");
console.log(`heap base = 0x${heap.toString(16)}`);

// Eden holds the game at its entry point until a debugger attaches, so the
// save data isn't in memory yet: let it boot, then retry until the read works.
gdb.resume();
let name = "";
for (;;) {
  const trainer = await gdb.paused(() => gdb.readRaw(heap + BigInt(O.trainerData), O.trainerDataLength)).catch(() => null);
  name = trainer?.subarray(0xb0, 0xb0 + 26).toString("utf16le").split("\0")[0] ?? "";
  if (name) break;
  console.log("waiting for save data (get to the title screen / load your save)...");
  await new Promise((r) => setTimeout(r, 3000));
}
console.log(`trainer name: "${name}"`);
const times: number[] = [];
for (let i = 0; i < 20; i++) {
  await new Promise((r) => setTimeout(r, 250));
  const t0 = performance.now();
  const inBattle = await gdb.paused(() => gdb.readRaw(heap + BigInt(O.inBattleSword), 2));
  times.push(performance.now() - t0);
  process.stdout.write(`inBattle=0x${inBattle.toString("hex")} `);
}
times.sort((a, b) => a - b);
console.log(`\nstall per read: median ${times[10].toFixed(1)} ms, max ${times[19].toFixed(1)} ms`);
gdb.close();
