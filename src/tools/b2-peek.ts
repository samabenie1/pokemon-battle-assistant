// Black 2 in melonDS: print the party and, in battle, both battlers' live state.
// Usage: node --import tsx src/tools/b2-peek.ts
import { MelonDS } from "../reader/melonds.ts";
import { B2 } from "../offsets/b2.ts";
import { decrypt, parse, SIZE_PARTY } from "../pk5.ts";
import { speciesName, moveName, abilityName, itemName, NATURES } from "../names.ts";
import type { Mon } from "../pk8.ts";

const ds = new MelonDS();
if (!ds.connect()) throw new Error("melonDS isn't running (or has no game loaded)");
console.log(`melonDS pid ${ds.pid}, game ${ds.gameCode} (${B2.gameCodes[ds.gameCode] ?? "unsupported"})`);

const base = ds.ptr(B2.MAIN_POINTER);
const pkm = (off: number) => {
  const d = decrypt(ds.bytes(off, SIZE_PARTY));
  return d ? parse(d) : null;
};
const show = (m: Mon) =>
  `${speciesName(m.species)} Lv${m.level} ${m.hp}/${m.stats?.hp ?? "?"}HP ${NATURES[m.nature]} ` +
  `[${abilityName(m.ability)}]${m.heldItem ? " @" + itemName(m.heldItem) : ""} | ` +
  m.moves.map((mv, i) => mv && `${moveName(mv)} ${m.pp[i]}pp`).filter(Boolean).join(", ");

const count = ds.u32(base + B2.partyCount);
console.log(`\nparty (${count}):`);
for (let i = 0; i < Math.min(count, 6); i++) {
  const m = pkm(base + B2.party + i * SIZE_PARTY);
  console.log(`  ${i + 1}. ${m ? show(m) : "(bad checksum)"}`);
}

const status = ds.u16(B2.battleStatus);
const inBattle = status === 0x2100 || status === 0x2101;
console.log(`\nbattle status 0x${status.toString(16)} → ${inBattle ? "IN BATTLE" : "overworld"}`);
if (inBattle) {
  const bt = B2.battler;
  const battler = (label: string, slotPtr: number) => {
    const b = ds.ptr(slotPtr);
    if (!b) return console.log(`  ${label}: (no battler)`);
    const m = pkm(ds.ptr(b + bt.pkm));
    const st = ds.bytes(b + bt.statStages, 7);
    const moves = [0, 1, 2, 3].map((i) => {
      const o = b + bt.moves + i * bt.moveStride;
      const id = ds.u16(o);
      return id ? `${moveName(id)} ${ds.u8(o + 2)}pp` : "";
    }).filter(Boolean);
    const stats = [0, 1, 2, 3, 4].map((i) => ds.u16(b + bt.stats + i * 2));
    console.log(`  ${label}: ${m ? speciesName(m.species) : "?"} Lv${ds.u16(b + bt.level) & 0xff} ` +
      `HP ${ds.u16(b + bt.curHP)}/${ds.u16(b + bt.maxHP)} status=${ds.u32(b + bt.status)}`);
    console.log(`     stats Atk/Def/SpA/SpD/Spe ${stats.join("/")}  stages ${[...st].map((x) => x - 6).join(",")}`);
    console.log(`     moves ${moves.join(", ")}${m ? `  ability ${abilityName(m.ability)}` : ""}`);
  };
  console.log(`  format flag ${ds.u8(base + B2.doubleTripleFlag)}, trainer id ${ds.u16(base + B2.enemyTrainerID)}`);
  battler("ME   ", base + B2.mainBattleDataPtr);
  battler("ENEMY", base + B2.mainBattleDataPtr + B2.enemyBattlerOffset);
  console.log("  enemy party:");
  for (let i = 0; i < 6; i++) {
    const m = pkm(base + B2.enemyBattleParty + i * SIZE_PARTY);
    if (m) console.log(`    ${i + 1}. ${show(m)}`);
  }
}
ds.close();
