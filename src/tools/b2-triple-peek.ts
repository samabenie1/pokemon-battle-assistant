// Ad-hoc: print the battler slots (status, HP, moves) for a triple battle. Foe client = slots 7+.
import { B2Reader } from "../sources/live-b2.ts";
import { B2 } from "../offsets/b2.ts";
import { speciesName, moveName } from "../names.ts";
const r = new B2Reader() as any;
if (!r.connected()) throw new Error("not connected");
for (let i = 0; i < 10; i++) {
  const b = r.ds.ptr(r.base + B2.mainBattleDataPtr + i * 4);
  const m = b ? r.battler(b) : null;
  if (!m) continue;
  const st = m.status & 7 ? `slp(${m.status & 7})` : m.status ? `st=0x${m.status.toString(16)}` : "ok";
  console.log(`[${i}] ${speciesName(m.species)} L${m.level} ${m.hp}/${m.maxHP} ${st} ${m.moves.filter(Boolean).map((x: number) => moveName(x)).join("/")}`);
}
