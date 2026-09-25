// Deterministic battle math: turn a BattleState into damage ranges, KO odds,
// speed order and switch-in safety using @smogon/calc (Gen 8 rules).
import { calculate, Generations, Move, Pokemon, Field } from "@smogon/calc";
import type { StatusName } from "@smogon/calc/dist/data/interface.js";
import { NATURES, abilityName, itemName, moveName, speciesName } from "../names.ts";
import type { Mon } from "../pk8.ts";

const gen = Generations.get(8);

export interface Side { active: Mon; bench: Mon[]; }
export interface BattleState {
  me: Side;
  enemy: Side & { hpPercent?: number; abilityKnown?: boolean }; // hpPercent: estimate when live HP is unknown
  trainer: boolean;
}

// PK8 status bits: 0-2 sleep turns, 3 poison, 4 burn, 5 freeze, 6 paralysis, 7 toxic.
function statusOf(s: number): StatusName | "" {
  if (s & 0x7) return "slp";
  if (s & 0x80) return "tox";
  if (s & 0x8) return "psn";
  if (s & 0x10) return "brn";
  if (s & 0x20) return "frz";
  if (s & 0x40) return "par";
  return "";
}

const STAT_ORDER = ["hp", "atk", "def", "spe", "spa", "spd"] as const; // PK8 EV/IV order

// A no-effect ability for when the player can't know the real one (randomized saves):
// the calc must not leak it, e.g. via an immunity showing up as 0% damage.
const NEUTRAL_ABILITY = "Ball Fetch";

export function toCalc(m: Mon, curHPOverride?: number, hideAbility = false, withBoosts = false) {
  const evs: Record<string, number> = {}, ivs: Record<string, number> = {};
  STAT_ORDER.forEach((k, i) => { evs[k] = m.evs[i]; ivs[k] = m.ivs[i]; });
  const p = new Pokemon(gen, speciesName(m.species), {
    level: m.level ?? 50,
    nature: NATURES[m.nature],
    ability: hideAbility ? NEUTRAL_ABILITY : abilityName(m.ability),
    item: itemName(m.heldItem) || undefined,
    evs, ivs,
    status: statusOf(m.status),
    moves: m.moves.filter(Boolean).map(moveName),
    ...(withBoosts && m.boosts ? { boosts: { atk: m.boosts.atk, def: m.boosts.def, spa: m.boosts.spa, spd: m.boosts.spd, spe: m.boosts.spe } } : {}),
  });
  const hp = curHPOverride ?? m.hp;
  if (hp > 0 && hp <= p.maxHP()) p.originalCurHP = hp;
  return p;
}

function hit(att: Pokemon, def: Pokemon, move: string, field = new Field()) {
  const mv = new Move(gen, move);
  const r = calculate(gen, att, def, mv, field);
  const [lo, hi] = r.range();
  const max = def.maxHP();
  let ko = "";
  try { ko = r.kochance().text; } catch { /* status moves have no KO chance */ }
  const eff = mv.category === "Status" ? 1 : gen.types.get(mv.type.toLowerCase() as never)
    ? def.types.reduce((e, t) => e * (gen.types.get(mv.type.toLowerCase() as never)!.effectiveness[t] ?? 1), 1) : 1;
  return {
    move, type: mv.type, category: mv.category, power: mv.bp,
    pctMax: [+(100 * lo / max).toFixed(1), +(100 * hi / max).toFixed(1)],
    ofCurrent: [lo, hi], defenderHP: def.curHP(), ko, effectiveness: eff,
  };
}

export type Hit = ReturnType<typeof hit>;

// Setup moves: the stage gain a switch gives away (a switch = a free turn for the enemy to use one).
const SETUP: Record<string, Partial<Record<"atk" | "spa" | "spe" | "def" | "spd", number>>> = {
  "Nasty Plot": { spa: 2 }, "Swords Dance": { atk: 2 }, "Shell Smash": { atk: 2, spa: 2, spe: 2 },
  "Calm Mind": { spa: 1, spd: 1 }, "Dragon Dance": { atk: 1, spe: 1 }, "Bulk Up": { atk: 1, def: 1 },
  "Quiver Dance": { spa: 1, spd: 1, spe: 1 }, "Work Up": { atk: 1, spa: 1 }, "Growth": { atk: 1, spa: 1 },
  "Hone Claws": { atk: 1 }, "Coil": { atk: 1, def: 1 }, "Tail Glow": { spa: 3 }, "Agility": { spe: 2 },
  "Autotomize": { spe: 2 }, "Rock Polish": { spe: 2 }, "Belly Drum": { atk: 6 }, "Victory Dance": { atk: 1, def: 1, spe: 1 },
  "Howl": { atk: 1 }, "Meditate": { atk: 1 }, "Sharpen": { atk: 1 }, "Charge Beam": { spa: 1 },
};

/** Speed after stat stages and paralysis (what decides who moves first). */
function effSpeed(p: Pokemon) {
  const stage = p.boosts.spe ?? 0;
  const mult = stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
  return Math.floor(p.stats.spe * mult * (p.status === "par" ? 0.5 : 1));
}

const nonzero = (b?: Mon["boosts"]) => (b ? Object.fromEntries(Object.entries(b).filter(([, v]) => v !== 0)) : {});

const avg = (h?: Hit | { ofCurrent: number[] }) => (h ? (h.ofCurrent[0] + h.ofCurrent[1]) / 2 : 0);
const hitsToKO = (dmg: number, hp: number) => (dmg <= 0 ? 10 : Math.min(10, Math.ceil(hp / dmg)));

function matchup(mine: Hit | undefined, theirs: Hit | undefined, myHP: number, theirHP: number, faster: boolean, switchingIn: boolean) {
  const hpAfterEntry = switchingIn ? myHP - avg(theirs) : myHP;
  if (hpAfterEntry <= 0) return { myHits: 10, theirHits: 0, wins: false, margin: -10 };
  const myHits = hitsToKO(avg(mine), theirHP), theirHits = hitsToKO(avg(theirs), hpAfterEntry);
  const wins = faster ? myHits <= theirHits : myHits < theirHits;
  return { myHits, theirHits, wins, margin: theirHits - myHits + (faster ? 0.5 : 0) - (switchingIn ? 1 : 0) };
}

/** preferLowLevel: among bench Pokémon that win the matchup, suggest the lowest level (training mode). */
export function analyze(s: BattleState, opts: { preferLowLevel?: boolean } = {}) {
  // Boosts apply to the two Pokémon on the field; a switch-in starts neutral.
  const me = toCalc(s.me.active, undefined, false, true);
  const enemyMon = s.enemy.active;
  const hideAbility = s.enemy.abilityKnown === false;
  const enemy = toCalc(enemyMon, undefined, hideAbility, true);
  if (s.enemy.hpPercent !== undefined) enemy.originalCurHP = Math.max(1, Math.round(enemy.maxHP() * s.enemy.hpPercent / 100));

  const myMoves = s.me.active.moves.filter(Boolean).map((m, i) => ({ ...hit(me, enemy, moveName(m)), pp: s.me.active.pp[i] }))
    .sort((a, b) => b.pctMax[1] - a.pctMax[1]);
  const enemyMoves = enemyMon.moves.filter(Boolean).map((m) => hit(enemy, me, moveName(m)))
    .sort((a, b) => b.pctMax[1] - a.pctMax[1]);

  // Matchup: hits each side needs to KO the other (average damage), plus speed.
  // margin > 0 means we should win the exchange; a switch-in eats one free hit and loses a turn.
  const activeMatch = matchup(myMoves[0], enemyMoves[0], me.curHP(), enemy.curHP(), effSpeed(me) > effSpeed(enemy), false);

  // If the enemy can set up, a switch-in must also survive a hit after one more boost.
  const setupMove = enemyMon.moves.filter(Boolean).map(moveName).find((mv) => SETUP[mv]);
  let enemyAfterSetup = enemy;
  if (setupMove) {
    enemyAfterSetup = toCalc({ ...enemyMon, boosts: { atk: 0, def: 0, spa: 0, spd: 0, spe: 0, accuracy: 0, evasion: 0, ...enemyMon.boosts } }, undefined, hideAbility, true);
    enemyAfterSetup.originalCurHP = enemy.curHP();
    for (const [k, v] of Object.entries(SETUP[setupMove])) {
      const key = k as keyof typeof enemyAfterSetup.boosts;
      enemyAfterSetup.boosts[key] = Math.min(6, (enemyAfterSetup.boosts[key] ?? 0) + (v ?? 0));
    }
  }

  const switches = s.me.bench.filter((m) => m.hp > 0).map((b) => {
    const bp = toCalc(b);
    const worstNow = enemyMon.moves.filter(Boolean).map((m) => hit(enemy, bp, moveName(m))).sort((a, c) => c.pctMax[1] - a.pctMax[1])[0];
    const worstBoosted = setupMove ? enemyMon.moves.filter(Boolean).map((m) => hit(enemyAfterSetup, bp, moveName(m))).sort((a, c) => c.pctMax[1] - a.pctMax[1])[0] : undefined;
    const worstIn = worstBoosted && worstBoosted.pctMax[1] > (worstNow?.pctMax[1] ?? 0) ? worstBoosted : worstNow;
    const bestOut = b.moves.filter(Boolean).map((m) => hit(bp, enemy, moveName(m))).sort((a, c) => c.pctMax[1] - a.pctMax[1])[0];
    const st = statusOf(b.status);
    const disabled = st === "slp" || st === "frz"; // can't act after switching in
    return {
      name: speciesName(b.species), level: b.level, hp: `${b.hp}/${bp.maxHP()}`, types: bp.types, status: st,
      takesWorst: worstIn && { move: worstIn.move, pctMax: worstIn.pctMax }, bestMove: bestOut && { move: bestOut.move, pctMax: bestOut.pctMax, ko: bestOut.ko },
      speed: effSpeed(bp),
      matchup: disabled
        ? { myHits: 10, theirHits: 0, wins: false, margin: -10 }
        : matchup(bestOut, worstIn, bp.curHP(), enemy.curHP(), effSpeed(bp) > effSpeed(enemy), true),
    };
  });

  // Can the enemy KO my active Pokémon this turn? (max roll, and max roll + crit)
  const myPct = (100 * me.curHP()) / me.maxHP();
  const worstMax = enemyMoves[0]?.pctMax[1] ?? 0;
  const koRisk = { move: enemyMoves[0]?.move ?? null, maxRoll: worstMax >= myPct, withCrit: worstMax * 1.5 >= myPct };

  // Only suggest a swap when it clearly beats staying in.
  const best = [...switches].filter((x) => x.matchup.wins)
    .sort((a, b) => (opts.preferLowLevel ? (a.level ?? 0) - (b.level ?? 0) : 0) || b.matchup.margin - a.matchup.margin)[0];
  // Enemy has no damaging moves: switching is free, so bring in the hardest hitter (chip damage
  // loses to Pain Split / Recover / screens, and there's nothing to fear).
  const enemyHarmless = enemyMoves.every((m) => m.category === "Status" || m.pctMax[1] === 0);
  const hitter = enemyHarmless ? [...switches].sort((x, y) => (y.bestMove?.pctMax[0] ?? 0) - (x.bestMove?.pctMax[0] ?? 0))[0] : undefined;
  const freeSwap = hitter && (hitter.bestMove?.pctMax[0] ?? 0) > (myMoves[0]?.pctMax[0] ?? 0) * 1.5
    ? { to: hitter.name, reason: `${enemy.name} has no damaging moves, so switching is free: ${hitter.name}'s ${hitter.bestMove?.move} does ${hitter.bestMove?.pctMax.join("–")}% vs ${me.name}'s best ${myMoves[0]?.pctMax.join("–")}%.` }
    : null;
  const swap = freeSwap ?? (best && (!activeMatch.wins || best.matchup.margin >= activeMatch.margin + 2)
    ? {
      to: best.name,
      reason: `${best.name} takes ${best.takesWorst?.pctMax[1] ?? 0}% from ${best.takesWorst?.move ?? "its attacks"} and KOs in ${best.matchup.myHits} hit${best.matchup.myHits > 1 ? "s" : ""} with ${best.bestMove?.move}` +
        (activeMatch.wins ? "" : `; ${me.name} is likely KO'd first (${activeMatch.theirHits} hit${activeMatch.theirHits > 1 ? "s" : ""} vs ${activeMatch.myHits} needed)`),
    }
    : null);

  return {
    me: { name: me.name, level: me.level, types: me.types, hp: me.curHP(), maxHP: me.maxHP(), ability: me.ability, item: me.item, status: me.status, speed: effSpeed(me), boosts: nonzero(s.me.active.boosts) },
    enemy: { name: enemy.name, level: enemy.level, types: enemy.types, hp: enemy.curHP(), maxHP: enemy.maxHP(), hpPercent: Math.round(100 * enemy.curHP() / enemy.maxHP()), ability: hideAbility ? "???" : enemy.ability, status: enemy.status, speed: effSpeed(enemy), boosts: nonzero(enemyMon.boosts) },
    enemyBench: s.enemy.bench.filter((m) => m.hp > 0).map((m) => ({ name: speciesName(m.species), level: m.level })),
    iMoveFirst: effSpeed(me) > effSpeed(enemy) ? true : effSpeed(me) < effSpeed(enemy) ? false : "speed tie",
    myMoves, enemyMoves, switches, trainer: s.trainer,
    activeMatchup: activeMatch, swap, koRisk, enemySetupMove: setupMove ?? null,
  };
}

export type Analysis = ReturnType<typeof analyze>;
