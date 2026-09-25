// One-shot: run calc + Claude on the demo battle and print the result.
import { analyze } from "../engine/calc.ts";
import { advise } from "../engine/advisor.ts";
import { demoState } from "../sources/demo.ts";

const a = analyze(demoState());
console.log(`${a.me.name} (${a.me.hp}/${a.me.maxHP}) vs ${a.enemy.name} (${a.enemy.hpPercent}%, ${a.enemy.status || "healthy"}); I move first: ${a.iMoveFirst}`);
for (const m of a.myMoves) console.log(`  ${m.move.padEnd(14)} ${m.pctMax[0]}–${m.pctMax[1]}%  ${m.ko}`);
console.log("enemy threats:", a.enemyMoves.map((m) => `${m.move} ${m.pctMax[1]}%`).join(", "));
console.log("advice:", await advise(a));
