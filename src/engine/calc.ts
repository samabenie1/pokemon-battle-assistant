// Deterministic battle math: turn a BattleState into damage ranges, KO odds,
// speed order and switch-in safety using @smogon/calc (the game's generation rules, see game.ts).
import { calculate, Generations, Move, Pokemon, Field } from "@smogon/calc";
import type { StatusName } from "@smogon/calc/dist/data/interface.js";
import { NATURES, abilityName, itemName, monLabel, moveName, speciesName } from "../names.ts";
import type { Mon } from "../pk8.ts";
import { GAME } from "../game.ts";

const gen = Generations.get(GAME.gen);

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

// PK8 form index → Showdown forme. Showdown lists otherFormes alphabetically, so species with several
// forms need the game's order; a single alternate forme is unambiguous.
const FORMS: Record<string, string[]> = {
  Meowth: ["Alola", "Galar"], Darmanitan: ["Zen", "Galar", "Galar-Zen"], Slowbro: ["Mega", "Galar"],
  Rotom: ["Heat", "Wash", "Frost", "Fan", "Mow"], Lycanroc: ["Midnight", "Dusk"],
};
// Species the calc only knows by a forme name (no plain entry): the battle-start forme.
const DEFAULT_FORME: Record<string, string> = { Aegislash: "Aegislash-Shield" };
export function calcSpecies(m: Mon) {
  const base = speciesName(m.species);
  if (DEFAULT_FORME[base]) return DEFAULT_FORME[base];
  if (!m.form) return base;
  if (FORMS[base]) return FORMS[base][m.form - 1] ? `${base}-${FORMS[base][m.form - 1]}` : base;
  const formes = gen.species.get(base.toLowerCase().replace(/[^a-z0-9]/g, "") as never)?.otherFormes ?? [];
  return formes.length === 1 && m.form === 1 ? formes[0] : base;
}

export function toCalc(m: Mon, curHPOverride?: number, hideAbility = false, withBoosts = false, dynamax = m.dynamax ?? false) {
  const evs: Record<string, number> = {}, ivs: Record<string, number> = {};
  STAT_ORDER.forEach((k, i) => { evs[k] = m.evs[i]; ivs[k] = m.ivs[i]; });
  const p = new Pokemon(gen, calcSpecies(m), {
    level: m.level ?? 50,
    nature: NATURES[m.nature],
    ability: hideAbility ? NEUTRAL_ABILITY : abilityName(m.ability),
    // Slow Start (halved Atk/Spe) is active for the first 5 turns on the field: assume it's on.
    abilityOn: !hideAbility && abilityName(m.ability) === "Slow Start",
    item: itemName(m.heldItem) || undefined,
    evs, ivs,
    status: statusOf(m.status),
    moves: m.moves.filter(Boolean).map(moveName),
    isDynamaxed: dynamax,
    ...(withBoosts && m.boosts ? { boosts: { atk: m.boosts.atk, def: m.boosts.def, spa: m.boosts.spa, spd: m.boosts.spd, spe: m.boosts.spe } } : {}),
  });
  // @smogon/calc doubles originalCurHP for a Dynamaxed Pokémon, while the live HP from memory is already
  // Dynamax-scaled, so halve it back.
  const hp = curHPOverride ?? m.hp;
  const base = dynamax ? Math.round(hp / 2) : hp;
  if (base > 0 && base <= p.rawStats.hp) p.originalCurHP = base;
  return p;
}

export function hit(att: Pokemon, def: Pokemon, move: string, field = new Field()) {
  const mv = new Move(gen, move, { useMax: att.isDynamaxed });
  const r = calculate(gen, att, def, mv, field);
  const [lo, hi] = r.range();
  const max = def.maxHP();
  let ko = "";
  try { ko = r.kochance().text; } catch { /* status moves have no KO chance */ }
  const eff = mv.category === "Status" ? 1 : gen.types.get(mv.type.toLowerCase() as never)
    ? def.types.reduce((e, t) => e * (gen.types.get(mv.type.toLowerCase() as never)!.effectiveness[t] ?? 1), 1) : 1;
  return {
    move, maxMove: att.isDynamaxed ? mv.name : undefined, type: mv.type, category: mv.category, power: mv.bp,
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
export function effSpeed(p: Pokemon) {
  const stage = p.boosts.spe ?? 0;
  const mult = stage >= 0 ? (2 + stage) / 2 : 2 / (2 - stage);
  const slowStart = p.ability === "Slow Start" && p.abilityOn ? 0.5 : 1;
  return Math.floor(p.stats.spe * mult * (p.status === "par" ? 0.5 : 1) * slowStart);
}

/** Moves a Pokémon can still use (PP left). */
export const usableMoves = (m: Mon) => m.moves.filter((mv, i) => mv && (m.pp[i] ?? 1) > 0);

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

/** preferLowLevel: among bench Pokémon that win the matchup, suggest the lowest level (training mode).
 *  dynamaxUsed: the player already Dynamaxed this battle (one per battle). */
/** myDamageScale: observed/predicted damage ratio for my attacks on this enemy (hidden ability, Intimidate…). */
export function analyze(s: BattleState, opts: { preferLowLevel?: boolean; dynamaxUsed?: boolean; freeSwitch?: boolean; myDamageScale?: number; runAttempts?: number } = {}) {
  const k = opts.myDamageScale ?? 1;
  const scaleHit = <T extends { pctMax: number[]; ofCurrent: number[]; ko: string; defenderHP: number }>(h: T): T => {
    if (k === 1) return h;
    const ofCurrent = h.ofCurrent.map((x) => Math.round(x * k));
    const pctMax = h.pctMax.map((x) => +(x * k).toFixed(1));
    const n = ofCurrent[0] > 0 ? Math.ceil(h.defenderHP / ofCurrent[0]) : 0;
    return { ...h, ofCurrent, pctMax, ko: n ? `${n === 1 ? "OHKO" : `${n}HKO`} (adjusted to observed damage)` : "" };
  };
  // Boosts apply to the two Pokémon on the field; a switch-in starts neutral.
  const me = toCalc(s.me.active, undefined, false, true);
  const enemyMon = s.enemy.active;
  const hideAbility = s.enemy.abilityKnown === false;
  const enemy = toCalc(enemyMon, undefined, hideAbility, true);
  if (s.enemy.hpPercent !== undefined) enemy.originalCurHP = Math.max(1, Math.round(enemy.maxHP() * s.enemy.hpPercent / 100));

  const myMoves = s.me.active.moves.filter(Boolean).map((m, i) => ({ ...scaleHit(hit(me, enemy, moveName(m))), pp: s.me.active.pp[i] }))
    .sort((a, b) => b.pctMax[1] - a.pctMax[1]);
  const enemyMoves = usableMoves(enemyMon).map((m) => ({ ...hit(enemy, me, moveName(m)), pp: enemyMon.pp[enemyMon.moves.indexOf(m)] }))
    .sort((a, b) => b.pctMax[1] - a.pctMax[1]);

  // Matchup: hits each side needs to KO the other (average damage), plus speed.
  // margin > 0 means we should win the exchange; a switch-in eats one free hit and loses a turn.
  const activeMatch = matchup(myMoves[0], enemyMoves[0], me.curHP(), enemy.curHP(), effSpeed(me) > effSpeed(enemy), false);

  // If the enemy can set up, a switch-in must also survive a hit after one more boost.
  // Between Pokémon (after a KO) a switch is free: no entry hit, no free setup turn for the enemy.
  const setupMove = opts.freeSwitch ? undefined : usableMoves(enemyMon).map(moveName).find((mv) => SETUP[mv]);
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
    const worstNow = usableMoves(enemyMon).map((m) => hit(enemy, bp, moveName(m))).sort((a, c) => c.pctMax[1] - a.pctMax[1])[0];
    const worstBoosted = setupMove ? usableMoves(enemyMon).map((m) => hit(enemyAfterSetup, bp, moveName(m))).sort((a, c) => c.pctMax[1] - a.pctMax[1])[0] : undefined;
    const worstIn = worstBoosted && worstBoosted.pctMax[1] > (worstNow?.pctMax[1] ?? 0) ? worstBoosted : worstNow;
    const bestOut = b.moves.filter(Boolean).map((m) => scaleHit(hit(bp, enemy, moveName(m)))).sort((a, c) => c.pctMax[1] - a.pctMax[1])[0];
    const st = statusOf(b.status);
    const disabled = st === "slp" || st === "frz"; // can't act after switching in
    return {
      name: monLabel(b), level: b.level, hp: `${b.hp}/${bp.maxHP()}`, types: bp.types, status: st,
      takesWorst: worstIn && { move: worstIn.move, pctMax: worstIn.pctMax }, bestMove: bestOut && { move: bestOut.move, pctMax: bestOut.pctMax, ko: bestOut.ko },
      speed: effSpeed(bp),
      matchup: disabled
        ? { myHits: 10, theirHits: 0, wins: false, margin: -10 }
        : matchup(bestOut, worstIn, bp.curHP(), enemy.curHP(), effSpeed(bp) > effSpeed(enemy), !opts.freeSwitch),
    };
  });

  // Can the enemy KO my active Pokémon this turn? (max roll, and max roll + crit)
  const myPct = (100 * me.curHP()) / me.maxHP();
  const worstMax = enemyMoves[0]?.pctMax[1] ?? 0;
  const koRisk = { move: enemyMoves[0]?.move ?? null, maxRoll: worstMax >= myPct, withCrit: worstMax * 1.5 >= myPct };

  // Only suggest a swap when it clearly beats staying in.
  // Safety first: the winning switch-in that takes the least damage; level only breaks near-ties (training mode).
  const taken = (x: (typeof switches)[number]) => x.takesWorst?.pctMax[1] ?? 0;
  const best = [...switches].filter((x) => x.matchup.wins)
    .sort((a, b) => (Math.abs(taken(a) - taken(b)) > 10 ? taken(a) - taken(b) : 0)
      || (opts.preferLowLevel ? (a.level ?? 0) - (b.level ?? 0) : 0) || b.matchup.margin - a.matchup.margin)[0];
  // Enemy has no damaging moves: switching is free, so bring in the hardest hitter (chip damage
  // loses to Pain Split / Recover / screens, and there's nothing to fear).
  const enemyHarmless = enemyMoves.every((m) => m.category === "Status" || m.pctMax[1] === 0);
  const hitter = enemyHarmless ? [...switches].sort((x, y) => (y.bestMove?.pctMax[0] ?? 0) - (x.bestMove?.pctMax[0] ?? 0))[0] : undefined;
  const freeSwap = hitter && (hitter.bestMove?.pctMax[0] ?? 0) > (myMoves[0]?.pctMax[0] ?? 0) * 1.5
    ? { to: hitter.name, reason: `${enemy.name} has no damaging moves, so switching is free: ${hitter.name}'s ${hitter.bestMove?.move} does ${hitter.bestMove?.pctMax.join("–")}% vs ${monLabel(s.me.active)}'s best ${myMoves[0]?.pctMax.join("–")}%.` }
    : null;
  const swap = freeSwap ?? (best && (!activeMatch.wins || best.matchup.margin >= activeMatch.margin + 2)
    ? {
      to: best.name,
      reason: `${best.name} takes ${best.takesWorst?.pctMax[1] ?? 0}% from ${best.takesWorst?.move ?? "its attacks"} and KOs in ${best.matchup.myHits} hit${best.matchup.myHits > 1 ? "s" : ""} with ${best.bestMove?.move}` +
        (activeMatch.wins ? "" : `; ${monLabel(s.me.active)} is likely KO'd first (${activeMatch.theirHits} hit${activeMatch.theirHits > 1 ? "s" : ""} vs ${activeMatch.myHits} needed)`),
    }
    : null);

  return {
    me: { confused: !!s.me.active.confused, dynamax: me.isDynamaxed, name: monLabel(s.me.active), level: me.level, types: me.types, hp: me.curHP(), maxHP: me.maxHP(), ability: me.ability, item: me.item, status: me.status, speed: effSpeed(me), boosts: nonzero(s.me.active.boosts) },
    enemy: { confused: !!enemyMon.confused, dynamax: enemy.isDynamaxed, name: enemy.name, level: enemy.level, types: enemy.types, hp: enemy.curHP(), maxHP: enemy.maxHP(), hpPercent: Math.round(100 * enemy.curHP() / enemy.maxHP()), ability: hideAbility ? "???" : enemy.ability, status: enemy.status, speed: effSpeed(enemy), boosts: nonzero(enemyMon.boosts) },
    enemyBench: s.enemy.bench.filter((m) => m.hp > 0).map((m) => ({ name: speciesName(m.species), level: m.level })),
    iMoveFirst: effSpeed(me) > effSpeed(enemy) ? true : effSpeed(me) < effSpeed(enemy) ? false : "speed tie",
    myMoves, enemyMoves, switches, trainer: s.trainer,
    enemyOutOfPP: enemyMon.moves.filter((mv, i) => mv && enemyMon.pp[i] === 0).map(moveName),
    damageScale: k, activeMatchup: activeMatch, swap, koRisk,
    // Wild battles: escape odds (Gen 3+): always if at least as fast, else (A×128/B + 30×attempts)/256.
    run: s.trainer ? null : (() => {
      const A = effSpeed(me), B = effSpeed(enemy);
      return { chance: A >= B ? 1 : Math.min(1, (Math.floor((A * 128) / Math.max(1, B)) + 30 * ((opts.runAttempts ?? 0) + 1)) / 256) };
    })(), between: !!opts.freeSwitch, enemySetupMove: setupMove ?? null,
    dynamaxOption: !GAME.dynamax || me.isDynamaxed || opts.dynamaxUsed ? null : dynamaxOption(s, enemy, activeMatch, koRisk),
  };
}

/** What Dynamaxing the active Pokémon would change: Max Move damage, and the enemy's best hit vs doubled HP. */
function dynamaxOption(s: BattleState, enemy: Pokemon, now: { wins: boolean }, koRisk: { maxRoll: boolean; withCrit: boolean }) {
  const dm = toCalc(s.me.active, undefined, false, true, true);
  dm.originalCurHP = Math.min(dm.rawStats.hp, s.me.active.hp); // calc doubles it for Dynamax
  const maxMoves = s.me.active.moves.filter(Boolean).map((m) => hit(dm, enemy, moveName(m)))
    .filter((h) => h.category !== "Status").sort((a, b) => b.pctMax[1] - a.pctMax[1]);
  const worstIn = usableMoves(s.enemy.active).map((m) => hit(enemy, dm, moveName(m))).sort((a, b) => b.pctMax[1] - a.pctMax[1])[0];
  // Would Dynamax make this safe? Survive the enemy's best hit with a crit (on doubled HP), and KO within
  // the 3 Dynamax turns with the best Max Move (average damage vs the enemy's current HP).
  const myPct = (100 * dm.curHP()) / dm.maxHP();
  const survives = (worstIn?.pctMax[1] ?? 0) * 1.5 < myPct;
  const best = maxMoves[0];
  const avgHit = best ? (best.ofCurrent[0] + best.ofCurrent[1]) / 2 : 0;
  const hitsToKO = avgHit > 0 ? Math.ceil(enemy.curHP() / avgHit) : 99;
  const lastFoe = s.trainer && s.enemy.bench.every((m) => m.hp <= 0);
  const safeWin = survives && hitsToKO <= 3;
  let recommend: string | null = null;
  if (enemy.isDynamaxed && survives) recommend = `${enemy.name} is Dynamaxed. Match it: doubled HP means its best hit does at most ${worstIn?.pctMax[1]}%.`;
  else if (safeWin && (!now.wins || koRisk.maxRoll || koRisk.withCrit)) recommend = `Turns a risky matchup safe: you survive ${worstIn?.move ?? "its best hit"} even with a crit, and ${best?.maxMove} KOs in ${hitsToKO}.`;
  else if (safeWin && lastFoe) recommend = `Trainer's last Pokémon, and your Dynamax is otherwise wasted: ${best?.maxMove} KOs in ${hitsToKO} while you stay safe.`;
  return {
    best: best && { move: best.maxMove, from: best.move, pctMax: best.pctMax, ko: best.ko },
    takesWorst: worstIn && { move: worstIn.maxMove ?? worstIn.move, pctMax: worstIn.pctMax, ko: worstIn.ko },
    hitsToKO, recommend,
  };
}

export type Analysis = ReturnType<typeof analyze>;
