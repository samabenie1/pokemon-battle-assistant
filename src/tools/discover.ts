// Phase 1 discovery: while in a battle, read the known flags + wild slot and
// scan the save-data region for checksum-valid PK8s (that's where the party is).
import { GdbClient } from "../reader/gdb.ts";
import { SWSH_132 as O } from "../offsets/swsh-1.3.2.ts";
import { decrypt, parse, SIZE_PARTY, type Mon } from "../pk8.ts";
import { speciesName, moveName, abilityName, NATURES } from "../names.ts";

const show = (m: Mon) =>
  `${speciesName(m.species)} Lv${m.level ?? "?"} HP ${m.hp}/${m.stats?.hp ?? "?"} ${NATURES[m.nature]} ${abilityName(m.ability)} | ` +
  m.moves.map((mv, i) => mv && `${moveName(mv)} (${m.pp[i]}pp)`).filter(Boolean).join(", ");

const gdb = new GdbClient();
await gdb.connect();
const heap = BigInt("0x" + /Heap:\s+0x([0-9a-f]+)/i.exec(await gdb.monitor("get info"))![1]);
const at = (off: number) => heap + BigInt(off);

const SCAN_FROM = 0x45060000, SCAN_LEN = 0xe0000;
const t0 = performance.now();
// Attaching halts the guest, so read now and always resume afterwards.
const [inBattle, menu, wild, region] = await (async () => [
  await gdb.readRaw(at(O.inBattleSword), 2),
  await gdb.readRaw(at(O.battleMenu), 4),
  await gdb.readRaw(at(O.wildPokemon), SIZE_PARTY),
  await gdb.readRaw(at(SCAN_FROM), SCAN_LEN),
])().finally(() => gdb.resume());
console.log(`(game paused ${(performance.now() - t0).toFixed(0)} ms for the scan)`);
console.log(`inBattle flag = 0x${inBattle.toString("hex")}, battleMenu = 0x${menu.toString("hex")}`);

const w = decrypt(wild);
console.log("wild slot:", w ? show(parse(w)) : "(no valid Pokémon)");

console.log("checksum-valid PK8s in save region:");
for (let off = 0; off + SIZE_PARTY <= region.length; off += 4) {
  const d = decrypt(region.subarray(off, off + SIZE_PARTY));
  if (!d || d.readUInt16LE(8) === 0 || d.readUInt16LE(8) > 898) continue;
  console.log(`  heap+0x${(SCAN_FROM + off).toString(16)}  ${show(parse(d))}`);
}
gdb.close();
