// Small, fast read of party + wild slot, to see what changes turn to turn.
import { GdbClient } from "../reader/gdb.ts";
import { SWSH_132 as O } from "../offsets/swsh-1.3.2.ts";
import { decrypt, parse, SIZE_PARTY, type Mon } from "../pk8.ts";
import { speciesName, moveName } from "../names.ts";

const show = (m: Mon) =>
  `${speciesName(m.species).padEnd(10)} Lv${m.level} HP ${m.hp}/${m.stats?.hp ?? "?"} | ` +
  m.moves.map((mv, i) => mv && `${moveName(mv)} ${m.pp[i]}pp`).filter(Boolean).join(", ");

const gdb = new GdbClient();
await gdb.connect();
const heap = BigInt("0x" + /Heap:\s+0x([0-9a-f]+)/i.exec(await gdb.monitor("get info"))![1]);
const at = (off: number) => heap + BigInt(off);
const [party, wild, flag] = await (async () => [
  await gdb.readRaw(at(O.party), SIZE_PARTY * 6),
  await gdb.readRaw(at(O.wildPokemon), SIZE_PARTY),
  await gdb.readRaw(at(O.inBattleSword), 2),
])().finally(() => gdb.resume());
gdb.close();

console.log(`inBattle=0x${flag.toString("hex")}`);
const w = decrypt(wild);
console.log("ENEMY  " + (w ? show(parse(w)) : "(none)"));
for (let i = 0; i < 6; i++) {
  const d = decrypt(party.subarray(i * SIZE_PARTY, (i + 1) * SIZE_PARTY));
  console.log(`PARTY${i + 1} ` + (d ? show(parse(d)) : "(empty)"));
}
