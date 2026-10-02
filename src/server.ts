// Local web server: polls Eden's memory, serves the advice page and pushes
// updates over SSE. PBA_SOURCE=demo shows the sample battle instead.
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { analyze, preferNotAhead, WEATHER_ABILITY, type Weather, type Analysis, type BattleState } from "./engine/calc.ts";
import { advise, adviseDouble, type Advice, type DoubleAdvice } from "./engine/advisor.ts";
import { analyzeDouble, checkDoubleAdvice, type DoubleAnalysis } from "./engine/doubles.ts";
import { demoState } from "./sources/demo.ts";
import { LiveReader } from "./sources/live.ts";
import { B2Reader } from "./sources/live-b2.ts";
import { GAME } from "./game.ts";
import { B2_BOSSES } from "./offsets/b2.ts";
import { abilityName, monLabel, moveName, speciesName } from "./names.ts";
import { catchOdds } from "./engine/catch.ts";
import { training, type Training } from "./engine/training.ts";
import type { Mon } from "./pk8.ts";
import { battleHeal, cureFor, healItems, topUp } from "./engine/heal.ts";
import { checkAdvice, fallbackAdvice } from "./engine/safety.ts";
import { bagTips, itemLabel } from "./engine/items.ts";
import { planBag, planInput, type BagPlan } from "./engine/planner.ts";
import { newMoves, type NewMove } from "./engine/moves.ts";
import { toCalc } from "./engine/calc.ts";

const TARGET = Number(process.env.PBA_TARGET_LEVEL) || 0;
// Stronger (pricier) model for gym leader / Champion battles only; unset = same model everywhere.
const BOSS_MODEL = process.env.PBA_BOSS_MODEL;
let bossBattle = false;
let bossName: string | undefined; // Black 2 gym leader / Elite Four: the level cap is off for this fight
const NUZLOCKE = process.env.PBA_NUZLOCKE === "1";

const PORT = Number(process.env.PBA_PORT ?? 7878);
const DEMO = process.env.PBA_SOURCE === "demo";
/** The occasional Buy Me a Coffee note at the bottom of the page. PBA_SUPPORT=0 hides it (the author's own copy). */
const SUPPORT = process.env.PBA_SUPPORT !== "0";
const page = new URL("../public/index.html", import.meta.url);

type Status = "no-emulator" | "waiting" | "trainer" | "battle";
let latest: { status: Status; analysis?: Analysis; advice?: Advice; error?: string; estimated?: boolean; catch?: ReturnType<typeof catchOdds>; catchKO?: string[]; training?: Training; nuzlocke?: boolean;
  heal?: ReturnType<typeof battleHeal>; bagTips?: string[]; planSteps?: { id: string; text: string; why: string }[];
  newMoves?: NewMove[];
  doubles?: DoubleAnalysis; doubleAdvice?: DoubleAdvice; cure?: { item: string; count: number; target: string; status: string } | null; topUp?: ReturnType<typeof topUp>; nextPick?: { action: string; choice: string; reason: string }; at: number } = { status: "waiting", at: Date.now() };
const clients = new Set<http.ServerResponse>();
// Level-up move offers (Black 2 learnsets), attached to every update so the page always shows them.
let moveTips: NewMove[] = [];
const levelSeen = new Map<number, number>(), leveledAt = new Map<number, number>();
let tipsInBattle = false;
const push = () => { latest.newMoves = moveTips; for (const c of clients) c.write(`data: ${JSON.stringify(latest)}\n\n`); };
const setStatus = (status: Status, extra: Partial<typeof latest> = {}) => {
  const changed = latest.status !== status || latest.analysis || JSON.stringify(extra.topUp) !== JSON.stringify(latest.topUp)
    || JSON.stringify(extra.bagTips) !== JSON.stringify(latest.bagTips) || JSON.stringify(extra.planSteps) !== JSON.stringify(latest.planSteps);
  if (changed) { latest = { status, ...extra, at: Date.now() }; push(); }
};

// Advice runs are keyed so a stale response never overwrites a newer turn.
let adviceSeq = 0;
interface TeamCtx { team: Mon[]; activeEC: number; participants: Set<number> }

// Observed vs predicted damage of my attacks, per enemy (EC): catches hidden abilities, Intimidate, etc.
const damageScale = new Map<number, number>();
const HEALS = new Set(["Slack Off", "Recover", "Roost", "Soft-Boiled", "Milk Drink", "Synthesis", "Moonlight", "Morning Sun",
  "Shore Up", "Heal Order", "Wish", "Rest", "Strength Sap", "Aqua Ring", "Ingrain", "Leech Seed", "Giga Drain", "Drain Punch",
  "Horn Leech", "Leech Life", "Draining Kiss", "Oblivion Wing", "Mega Drain", "Absorb", "Parabolic Charge"]);
let pendingHit: { foe: number; predicted: number; hpBefore: number; at: number } | null = null;
let tips: string[] = [], tipsAt = 0;
const seenFoes = new Set<number>(); // opponent Pokémon (by EC) that have been on the field this battle
// Sonnet bag plan: re-planned only when the party/bag/TMs change (not the rule-based hints), one request at a time.
let plan: BagPlan | null = null, planKey = "", planning = false;
// Steps Sam skipped (✕ on the page), by step id → text; never shown again and passed to the planner as declined.
const DECLINED_FILE = new URL("../data/plan-declined.json", import.meta.url);
const declined: Record<string, string> = (() => { try { return JSON.parse(readFileSync(DECLINED_FILE, "utf8")); } catch { return {}; } })();
// Re-plan only when something that changes the plan changes: who's in the party, their moves and held items, which
// TMs/items are in the bag, who's lowest level, who's at the cap, and skipped steps. Not every level-up or HP change.
function planKeyOf(input: ReturnType<typeof planInput>) {
  const lowest = [...input.party].sort((x, y) => x.level - y.level)[0]?.name;
  return JSON.stringify({
    party: input.party.map((m) => [m.name, m.held, m.moves.map((x) => x.name), m.tmOptions.map((x) => x.tm), m.canEvolve, m.level >= input.levelCap]),
    bag: input.bag.map((b) => b.item).sort(), lowest, declined: input.declined,
    shop: input.shop?.stock, money: Math.floor(input.money / 1000), meds: input.medicine.map((m) => `${m.item}:${Math.min(m.count, 3)}`),
  });
}
function replan(input: ReturnType<typeof planInput>) {
  const key = planKeyOf(input);
  if (key === planKey || planning) return;
  planning = true;
  planBag(input).then((p) => {
    planKey = key; plan = p;
    console.log(`[plan] ${p.model} ${p.ms} ms, ${p.usage.in}+${p.usage.cached} cached in / ${p.usage.out} out tokens: ${p.steps.map((x) => `${x.text} — ${x.why}`).join(" | ") || "(no steps)"}`);
    if (p.dropped.length) console.log(`[plan] dropped: ${p.dropped.join(" | ")}`);
  }).catch((e) => { planKey = key; plan = null; console.log("[plan]", (e as Error).message); })
    .finally(() => { planning = false; });
}
/** Plan steps for the page (skipped ones removed); the rule-based tips only when there's no plan. */
// The last Poké Mart buy list seen (stock is randomized per shop), kept across restarts.
const SHOP_FILE = new URL("../data/last-shop.json", import.meta.url);
let lastShop: { id: number; price: number }[] | null = (() => { try { return JSON.parse(readFileSync(SHOP_FILE, "utf8")); } catch { return null; } })();
let shopOpen = false, shopSig = "", shopAt = 0;
const planSteps = () => plan?.steps.filter((x) => !declined[x.id]) ?? [];
const planTips = () => plan
  ? (planSteps().length ? [] : ["📋 Moves and items look fine; nothing to change."])
  : planning ? ["📋 Planning items and TMs…", ...tips] : tips;
// Poké Dolls in the battle-items pouch (guaranteed escape from wild battles).
const pokeDolls = () => { try { return reader.battleItems().find((i) => i.id === 63)?.count ?? 0; } catch { return 0; } };
let dynamaxAllowed = false; // this battle permits Dynamax (gym/stadium, or someone is Dynamaxed)
async function update(state: BattleState, estimated: boolean, balls: { id: number; count: number }[] = [], team?: TeamCtx, meds: { id: number; count: number }[] = [], nextFoes: Mon[] = []) {
  const capOn = TARGET > 0 && !bossName;
  // Between foes with more than one left: which one comes next isn't readable from RAM, and Sam doesn't get to know
  // their team. One stay/switch call that's safe against every remaining Pokémon, naming none of them.
  if (nextFoes.length > 1) {
    const per = nextFoes.map((f) => analyze({ ...state, enemy: { active: f, bench: [], abilityKnown: abilityKnown(f.species) } },
      { preferLowLevel: capOn, dynamaxUsed: dynamaxUsed || !dynamaxAllowed, freeSwitch: true, myDamageScale: damageScale.get(f.ec) ?? 1, weather: weather?.kind }));
    const risky = (a: Analysis) => a.koRisk.maxRoll || (NUZLOCKE && a.koRisk.withCrit);
    const meName = per[0].me.name, hpPct = (hp: string) => { const [c, m] = hp.split("/").map(Number); return (100 * c) / m; };
    let pick: { action: string; choice: string; reason: string };
    if (!per.some(risky)) pick = { action: "move", choice: "Stay", reason: `${meName} survives the best hit of every Pokémon they have left${NUZLOCKE ? ", even with a crit" : ""}.` };
    else {
      const options = per[0].switches.map((sw) => {
        const worst = Math.max(...per.map((a) => a.switches.find((x) => x.name === sw.name)?.takesWorst?.pctMax[1] ?? 0));
        return { ...sw, worst, safe: worst * (NUZLOCKE ? 1.5 : 1) < hpPct(sw.hp) };
      }).filter((o) => o.safe).sort((x, y) => x.worst - y.worst);
      const best = preferNotAhead(options)[0];
      pick = best
        ? { action: "switch", choice: best.name, reason: `${meName} could be KO'd by one of their remaining Pokémon. ${best.name} takes at most ${Math.round(best.worst)}% from any of them.` }
        : { action: "move", choice: "Stay", reason: `${meName} is at risk against one of them, but no switch-in is safe against all of them. Stay, and switch next turn once you see it.` };
    }
    latest = { status: "battle", nextPick: pick, nuzlocke: NUZLOCKE, at: Date.now() };
    push();
    console.log(`[advice] next foe hidden (${nextFoes.length} left): ${pick.action} ${pick.choice}: ${pick.reason}`);
    return;
  }
  const bideNow = bide && bide.ec === state.enemy.active.ec ? { storedHP: Math.max(0, bide.hpStart - state.enemy.active.hp) } : undefined;
  const analysis = analyze(state, { preferLowLevel: capOn, dynamaxUsed: dynamaxUsed || !dynamaxAllowed, freeSwitch: between,
    myDamageScale: damageScale.get(state.enemy.active.ec) ?? 1, bide: bideNow, weather: weather?.kind });
  const seq = ++adviceSeq;
  const e = analysis.enemy;
  const tf = state.enemy.active as Mon & { realSpecies?: number; transformPending?: boolean };
  if (tf.realSpecies) (e as { name: string }).name = `${speciesName(tf.realSpecies)} (${tf.transformPending ? "will Transform into" : "as"} ${e.name})`;
  const realSpecies = tf.realSpecies ?? state.enemy.active.species;
  const odds = balls.length && !state.trainer ? catchOdds({
    speciesNum: realSpecies, speciesName: speciesName(realSpecies), level: e.level, types: e.types, status: e.status,
    maxHP: e.maxHP, hpPercent: e.hpPercent, myLevel: analysis.me.level, turn: battleTurn, balls,
    baseRate: romCatchRate(realSpecies),
  }) : undefined;
  console.log(`[turn] ${analysis.me.name} ${analysis.me.hp}/${analysis.me.maxHP}${analysis.me.status ? ` [${analysis.me.status}]` : ""} vs ${analysis.enemy.name} Lv${analysis.enemy.level} ~${analysis.enemy.hpPercent}%${analysis.enemy.status ? ` [${analysis.enemy.status}]` : ""}${b2Reader ? ` ${b2Reader.debugStatus()}` : ""}`);
  const train = capOn && team ? training({
    target: TARGET, team: team.team, activeEC: team.activeEC, participants: team.participants,
    enemySpecies: state.enemy.active.species, enemyLevel: e.level, trainer: state.trainer, analysis, nuzlocke: NUZLOCKE,
  }) : undefined;
  const heal = meds.length ? battleHeal(analysis, meds, NUZLOCKE) : null;
  const c = cureFor(analysis.me.status, meds);
  const cure = c && { item: c.name, count: c.count, target: analysis.me.name, status: analysis.me.status };
  latest = { status: "battle", analysis, estimated, catch: odds, training: train, nuzlocke: NUZLOCKE, heal, cure, at: Date.now() };
  push(); // numbers show immediately; advice follows a few seconds later
  // Obvious turns don't need the AI (saves API cost): a KO that lands before the enemy moves, or a safe,
  // winning matchup with no KO risk and no better switch. The calculator's pick is shown directly.
  // Asleep/frozen: attacking usually does nothing, so the full advisor (cure / switch) decides, never a shortcut.
  // Bide up: the shortcuts don't account for the doubled release, so the full advisor + checks decide.
  const cantAct = analysis.me.status === "slp" || analysis.me.status === "frz" || !!analysis.enemyBide;
  const sureKO = !cantAct && analysis.iMoveFirst === true && analysis.myMoves.some((m) => m.category !== "Status" && m.ofCurrent[0] >= analysis.enemy.hp && !m.recoilKO);
  const easy = !cantAct && !analysis.between && !analysis.swap && !analysis.koRisk.maxRoll && !analysis.koRisk.withCrit
    && analysis.activeMatchup.wins && !Object.values(analysis.enemy.boosts ?? {}).some((v) => (v as number) > 0) && !analysis.dynamaxOption?.recommend;
  if (sureKO || easy) {
    const fb = fallbackAdvice(analysis, NUZLOCKE);
    if (seq === adviceSeq) { latest.advice = { ...fb, model: "calculator (obvious turn, no AI call)" }; push(); }
    console.log(`[advice] (no AI: ${sureKO ? "sure KO" : "easy"}) ${fb.action} ${fb.choice}: ${fb.reason}`);
    return;
  }
  try {
    const advice = await advise(analysis, {
      pokeDolls: pokeDolls(),
      ...(train ? { training: { target: train.target, tip: train.tip, members: train.members } } : {}),
      healOption: heal, cureOption: cure, healItems: healItems(meds),
      ...(bossName ? { bossBattle: `${bossName} (gym leader / Elite Four): the level cap does NOT apply in this fight. Ignore EXP and levelling entirely; just win with no faints.` } : {}),
    }, bossBattle && BOSS_MODEL ? BOSS_MODEL : undefined);
    // At the "Will you switch Pokémon?" prompt the only answers are Stay or a switch (Sam, 10-02: the AI said
    // "Power Gem" there and the page showed no stay/switch call). A move pick means: stay, then use that move.
    if (analysis.between && advice.action === "move" && advice.choice !== "Stay")
      Object.assign(advice, { choice: "Stay", reason: `Stay in, then use ${advice.choice}. ${advice.reason}` });
    const warning = checkAdvice(advice, analysis, NUZLOCKE);
    // Never headline advice the numbers reject: show the calculator's pick and mention the rejected one.
    const shown = warning
      ? { ...fallbackAdvice(analysis, NUZLOCKE), rejected: `AI suggested ${advice.action === "switch" ? "switching to " : ""}${advice.choice}. Rejected: ${warning}` }
      : advice;
    if (seq === adviceSeq) latest.advice = shown;
    console.log(`[advice] ${advice.action} ${advice.choice}: ${advice.reason} (${advice.ms} ms)${warning ? ` ⚠ REJECTED: ${warning} → ${shown.choice}` : ""}`);
  } catch (e) {
    // Timeout or API error: fall back to the calculator's own recommendation.
    const fb = fallbackAdvice(analysis, NUZLOCKE);
    if (seq === adviceSeq) { latest.advice = fb; latest.error = undefined; }
    console.log(`[advice] (fallback: ${(e as Error).message}) ${fb.action} ${fb.choice}: ${fb.reason}`);
  }
  if (seq === adviceSeq) push();
}

// ---- live polling ----
const b2Reader = GAME.id === "b2" ? new B2Reader() : null;
const reader: Pick<LiveReader, "poll" | "balls" | "medicine" | "generalItems" | "battleItems" | "machines" | "ownedSpecies"> =
  b2Reader ?? new LiveReader();
let battlerDumpKey = "";
/** PKM status bits → calc status (sleep 0-2, poison 3, burn 4, freeze 5, paralysis 6, toxic 7). */
const statusName = (st = 0) => (st & 7 ? "slp" : st & 0x20 ? "frz" : st & 0x40 ? "par" : st & 0x10 ? "brn" : st & 0x80 ? "tox" : st & 0x08 ? "psn" : "") as "slp" | "frz" | "par" | "brn" | "tox" | "psn" | "";
/** Black 2: the ROM's (randomized) catch rate for a species. */
const romCatchRate = (species: number) => { try { return b2Reader?.machineData()?.catchRate?.[species]; } catch { return undefined; } };
let battleEC = 0;           // EC of the wild Pokémon in the current battle
let enemyPct = 100;         // estimated enemy HP %, lowered when the player reports a move
let lastKey = "", stableSince = 0, lastCounter = -1;
let battleTurn = 1;
// Enemy Bide: set when its Bide PP drops; storedHP = its HP lost since. Cleared when the release lands (my HP drops),
// the foe leaves the field, or after 3 of my turns (Bide failed / missed the release).
const BIDE = 117;
let bide: { ec: number; hpStart: number; turn: number; myEC: number; myHP: number } | null = null;
const foeHPPrev = new Map<number, number>();
// Battle weather: a weather ability sets it on entry for the rest of the battle (Gen 5); Sunny Day etc. for 5 turns.
const WEATHER_MOVE: Record<number, Weather> = { 241: "Sun", 240: "Rain", 201: "Sand", 258: "Hail" };
let weather: { kind: Weather; until: number } | null = null, prevMyEC = 0, prevFoeEC = 0;
// Transform / Imposter: the foe becomes a copy of my Pokémon (species, types, stats except HP, moves at 5 PP, ability,
// boosts) until it leaves the field. Before it transforms, a foe that knows Transform is modelled as a copy of my
// active Pokémon (the worst case: it hits back with my own moves).
const TRANSFORM = 144;
let transform: { ec: number; copy: Mon } | null = null;
let dynamaxUsed = false; // one Dynamax per battle
// Persist "Dynamax used" per battle (keyed by the opponent team's ECs) so a server restart doesn't forget it.
const BATTLE_STATE = new URL("../data/battle-state.json", import.meta.url);
const loadDmax = (key: string) => { try { const j = JSON.parse(readFileSync(BATTLE_STATE, "utf8")); return j.key === key && j.dynamaxUsed === true; } catch { return false; } };
const saveDmax = (key: string) => { try { writeFileSync(BATTLE_STATE, JSON.stringify({ key, dynamaxUsed: true })); } catch { /* best effort */ } };
let between = false;      // enemy fainted, next one not out yet: switching is free
// Dynamax only exists in gym/stadium battles (and raids). Gym leaders + Champion, by OT name.
const DYNAMAX_TRAINERS = new Set(["Milo", "Nessa", "Kabu", "Bea", "Allister", "Opal", "Gordie", "Melony", "Raihan", "Leon"]);
let owned = new Set<number>(); // species caught so far: their randomized ability is known
// Abilities the player has seen revealed in battle (species number → ability name), kept across restarts.
const REVEALED = new URL("../data/revealed.json", import.meta.url);
const revealed = (): Record<string, string> => { try { return JSON.parse(readFileSync(REVEALED, "utf8")); } catch { return {}; } };
const abilityKnown = (species: number) => owned.has(species) || species in revealed();
let current: BattleState | null = null;

function poll() {
  const s = reader.poll();
  if (!s) return setStatus("no-emulator");
  // Level-up move offers: only right after a Pokémon actually levels up (when the game asks), never "coming up"
  // (Sam, 10-01). The game asks right away, so the tip clears after 45 s, when the battle starts or ends, or as soon
  // as the move is learned (Sam, 10-02: a skipped Aqua Ring tip lingered for minutes).
  try {
    if (s.inBattle !== tipsInBattle) { tipsInBattle = s.inBattle; leveledAt.clear(); }
    const team = s.inBattle && s.battleParty.length ? s.battleParty : s.party;
    for (const m of team) {
      const prev = levelSeen.get(m.ec), lv = m.level ?? 0;
      if (prev !== undefined && lv > prev) leveledAt.set(m.ec, Date.now());
      levelSeen.set(m.ec, lv);
    }
    const fresh = team.filter((m) => Date.now() - (leveledAt.get(m.ec) ?? 0) < 45_000);
    const tipsNow = newMoves(fresh).filter((t) => t.when === "now");
    if (JSON.stringify(tipsNow) !== JSON.stringify(moveTips)) {
      moveTips = tipsNow; push();
      for (const t of tipsNow) console.log(`[newmove] ${t.pokemon} Lv ${t.level} offered ${t.move}: ${t.skip ? "skip it" : t.forget ? `forget ${t.forget}` : "free slot"} (${t.why})`);
    }
  } catch (e) { console.log("[newmoves]", (e as Error).message); }
  if (!s.inBattle) {
    battleEC = 0; current = null; lastKey = ""; dynamaxUsed = false; seenFoes.clear(); weather = null; prevMyEC = prevFoeEC = 0; transform = null;
    // Between battles: who needs healing before the next fight (save-copy HP is current here).
    const team = s.party.map((m) => ({ name: monLabel(m), hp: m.hp, maxHP: toCalc(m).maxHP() }));
    // Poké Mart buy menu: checked every 2 s; a list seen twice in a row is the open shop. Opening one re-plans now.
    if (b2Reader && Date.now() - shopAt > 2_000) {
      shopAt = Date.now();
      const list = b2Reader.shop(), sig = JSON.stringify(list);
      const open = !!list && sig === shopSig;
      shopSig = sig;
      if (open && (!shopOpen || JSON.stringify(lastShop) !== sig)) {
        lastShop = list; shopOpen = true; tipsAt = 0;
        try { writeFileSync(SHOP_FILE, sig); } catch { /* best effort */ }
        console.log(`[shop] open: ${list!.map((x) => `${itemLabel(x.id)} ₽${x.price}`).join(", ")}`);
      } else if (!list && shopOpen) { shopOpen = false; tipsAt = 0; console.log("[shop] closed"); }
    }
    // Bag tips (held items, candies, TMs) between battles; recomputed at most every 30 s.
    if (Date.now() - tipsAt > 30_000) {
      try {
        const items = reader.generalItems(), machines = reader.machines(), b2 = b2Reader?.machineData();
        tips = bagTips(s.party, items, machines, TARGET || 100, b2);
        replan(planInput({ party: s.party, items, machines, cap: TARGET || 100, b2, hints: tips,
          declined: Object.values(declined), previous: plan?.steps.map((x) => x.text) ?? [],
          medicine: reader.medicine(), money: b2Reader?.money() ?? 0, shop: lastShop && { items: lastShop, openNow: shopOpen } }));
      } catch (e) { console.log("[bag]", (e as Error).message); }
      tipsAt = Date.now();
    }
    // Status conditions persist after battle in Gen 5 (sleep included): warn and name the cure in the bag.
    const NAMES: Record<string, string> = { slp: "asleep", frz: "frozen", par: "paralyzed", brn: "burned", psn: "poisoned", tox: "badly poisoned" };
    const statusTips = s.party.flatMap((m) => {
      const st = statusName(m.status);
      if (!st) return [];
      const cure = cureFor(st, reader.medicine());
      const turns = st === "slp" ? ` (${m.status & 7} turn${(m.status & 7) === 1 ? "" : "s"} left)` : "";
      return [`⚠ ${monLabel(m)} is ${NAMES[st]}${turns}: ${cure ? `use ${cure.name} (×${cure.count})` : "no cure in the bag; heal at a Pokémon Center"}${st === "slp" ? ", or don't lead with it" : ""}.`];
    });
    return setStatus("waiting", { topUp: topUp(team, reader.medicine()), bagTips: [...statusTips, ...planTips()], planSteps: planSteps() });
  }
  // The opponent's party blocks start at the wild slot: 1 Pokémon for wild battles, more for trainers.
  // ---- Double battles: separate analysis and advice ----
  if (s.double) {
    const byEC = (list: Mon[], ec: number) => list.find((m) => m.ec === ec);
    const mine = s.myActives.map((ec) => byEC(s.battleParty, ec)).filter((m): m is Mon => !!m && m.hp > 0);
    const foes = s.foeActives.map((ec) => byEC(s.enemyTeam, ec)).filter((m): m is Mon => !!m && m.hp > 0);
    if (!mine.length || !foes.length) return;
    const key = `D:${mine.map((m) => `${m.ec}:${m.hp}:${m.status}`).join(",")}|${foes.map((m) => `${m.ec}:${m.hp}:${m.status}`).join(",")}`;
    const now = Date.now();
    if (s.counter !== lastCounter) { lastCounter = s.counter; stableSince = now; }
    if (key === lastKey || now - stableSince < 800) return;
    lastKey = key;
    // Partner (multi) battles aren't mapped yet: an AI ally's Pokémon gets misread as my 2nd party member.
    // Log every battler slot once per battle so the ally's location can be found.
    const dumpKey = s.enemyTeam.map((m) => m.ec).join(",");
    if (b2Reader && dumpKey !== battlerDumpKey) { battlerDumpKey = dumpKey; console.log(`[battlers] ${b2Reader.debugBattlers().join(" | ")}`); }
    const d = analyzeDouble({ mine, foes, bench: s.battleParty.filter((m) => !s.myActives.includes(m.ec)), abilityKnown }, NUZLOCKE);
    const seq = ++adviceSeq;
    // A lone wild foe (the other one fainted or was caught): show catch odds, and which of my moves could KO it.
    // Wild double battles in B2 only happen in dark grass: ×0.3 catch rate with ≤30 species caught (assumed).
    let catchMode: { foe: string; hpPercent: number; odds: ReturnType<typeof catchOdds>; koMoves: string[] } | undefined;
    if (!s.trainer && foes.length === 1) {
      const f = d.foes[0], balls = reader.balls();
      const hpPercent = Math.round(100 * f.hp / f.maxHP);
      const koMoves = d.actives.flatMap((x) => x.moves.filter((m) => m.category !== "Status" && (m.vs[0]?.pctMax[1] ?? 0) >= hpPercent)
        .map((m) => `${x.name}'s ${m.move}`));
      if (balls.length) catchMode = { foe: f.name, hpPercent, koMoves, odds: catchOdds({
        speciesNum: foes[0].species, speciesName: f.name, level: f.level ?? 1, types: f.types, status: statusName(foes[0].status),
        maxHP: f.maxHP, hpPercent, myLevel: d.actives[0].level ?? 1, turn: 2, balls, baseRate: romCatchRate(foes[0].species), grassMod: 0.3 }) };
    }
    latest = { status: "battle", doubles: d, nuzlocke: NUZLOCKE, catch: catchMode?.odds, catchKO: catchMode?.koMoves, at: now };
    push();
    console.log(`[doubles] ${d.actives.map((a) => `${a.name} ${a.hp}/${a.maxHP}`).join(" + ")} vs ${d.foes.map((f) => `${f.name} ${f.hp}/${f.maxHP}`).join(" + ")}`);
    const foeOT = s.enemyTeam[0]?.ot ?? "";
    adviseDouble(catchMode ? { ...d, catchMode: { foe: catchMode.foe, bestBall: catchMode.odds.odds[0], movesThatCouldKO: catchMode.koMoves } } : d, DYNAMAX_TRAINERS.has(foeOT) && BOSS_MODEL ? BOSS_MODEL : undefined).then((adv) => {
      if (seq !== adviceSeq) return;
      const chk = checkDoubleAdvice(d, adv.actions);
      if (chk.notes.length) { adv.actions = chk.actions; adv.reason = `${adv.reason} [Overruled: ${chk.notes.join("; ")}.]`; console.log(`[advice2] overruled: ${chk.notes.join("; ")}`); }
      latest.doubleAdvice = adv; push();
      console.log(`[advice2] ${adv.actions.map((x) => `${x.pokemon}: ${x.choice} → ${x.target}`).join(" | ")} (${adv.ms} ms)`);
    }).catch((e) => {
      if (seq !== adviceSeq) return;
      latest.doubleAdvice = { actions: d.picks.map((p) => ({ pokemon: p.pokemon, choice: p.move, target: p.target })), reason: "Calculator pick (AI unavailable).", model: "calculator", ms: 0 };
      push(); console.log(`[advice2] fallback: ${(e as Error).message}`);
    });
    return;
  }

  // The opponent's on-field record says who's out; fallback: the first one still standing.
  const byRecord = s.enemyTeam.find((m) => m.ec === s.foeFieldEC && m.hp > 0);
  const foe = byRecord ?? s.enemyTeam.find((m) => m.hp > 0) ?? s.enemyTeam[0];
  // The on-field enemy just fainted and more remain: the "switch before the next one?" moment.
  const fainted = s.enemyTeam.find((m) => m.ec === s.foeFieldEC && m.hp === 0);
  between = !!fainted && s.enemyTeam.some((m) => m.hp > 0);
  if (!foe && !s.wild) return setStatus("waiting");
  // Sam doesn't get to know an opponent's team: only Pokémon that have been on the field are ever analyzed or shown.
  if (byRecord) seenFoes.add(byRecord.ec);
  const alive = s.enemyTeam.filter((m) => m.hp > 0);
  if (foe && !seenFoes.has(foe.ec)) {
    if (!between) return setStatus("waiting");
    // At the "Will you switch?" prompt the game names the next Pokémon. With one left that's certain; with more,
    // RAM can't tell which is coming, so update() gives one stay/switch call that's safe against all of them.
    if (alive.length === 1) seenFoes.add(alive[0].ec);
  }
  // A trainer's Pokémon carry the trainer's name; wild ones have no OT name yet (they do come
  // pre-stamped with the player's TID, so the ID can't be used). Catches one-Pokémon trainers.
  const foeMon = foe ?? s.wild!;
  const trainer = s.trainer ?? (s.enemyTeam.length > 1 || foeMon.ot !== "");
  const foeKey = foe?.ec ?? s.wildEC;
  if (foeKey !== battleEC) {
    battleEC = foeKey; enemyPct = 100; battleTurn = 1; owned = reader.ownedSpecies();
    console.log(`[foe] ${speciesName(foeMon.species)} OT="${foeMon.ot}" TID=${foeMon.tid} team=${s.enemyTeam.length} → ${trainer ? `trainer${s.trainerId ? ` #${s.trainerId}` : ""}${B2_BOSSES.has(s.trainerId ?? 0) && GAME.id === "b2" ? ` (${B2_BOSSES.get(s.trainerId!)}: cap off)` : ""}` : "wild"} (on-field via ${byRecord ? "record" : "fallback"})`);
  }
  const exact = foe !== undefined;
  if (s.used.length) battleTurn++;
  // Learn from real damage: when I use an attack, compare the enemy's HP drop with the prediction.
  if (foe && latest.analysis) {
    const pct = (100 * foe.hp) / foe.maxHP;
    for (const [, move] of s.used) {
      const h = latest.analysis.myMoves.find((x) => x.move === moveName(move));
      if (h && h.category !== "Status") pendingHit = { foe: foe.ec, predicted: (h.pctMax[0] + h.pctMax[1]) / 2 / (damageScale.get(foe.ec) ?? 1), hpBefore: latest.analysis.enemy.hpPercent, at: Date.now() };
    }
    if (pendingHit && pendingHit.foe === foe.ec && pct < pendingHit.hpBefore - 0.5 && pendingHit.predicted > 0) {
      const observed = pendingHit.hpBefore - pct;
      // Ignore capped results (a KO can't show more than the HP that was left), and foes that can heal:
      // a same-turn heal (Slack Off vs Mewtwo) reads as my attack doing less and drags the scale down.
      if (pct > 0 && !foe.moves.some((mv) => HEALS.has(moveName(mv)))) {
        const ratio = Math.min(2, Math.max(0.15, observed / pendingHit.predicted));
        const prev = damageScale.get(foe.ec);
        damageScale.set(foe.ec, prev ? (prev + ratio) / 2 : ratio);
        console.log(`[calib] ${speciesName(foe.species)}: predicted ${pendingHit.predicted.toFixed(0)}%, observed ${observed.toFixed(0)}% → scale ${damageScale.get(foe.ec)!.toFixed(2)}`);
      }
      pendingHit = null;
    } else if (pendingHit && Date.now() - pendingHit.at > 15_000) pendingHit = null;
  }
  // In-battle party (party order, live HP); fall back to the save party.
  const team = s.battleParty.length ? s.battleParty : s.party;
  const me = team.find((m) => m.species === s.active?.species) ?? team[0];
  const enemyMon = foe ?? s.wild!;
  // Bide window (see `bide` above). The release is the first HP drop on my active Pokémon after Bide starts.
  const myHP = s.active?.hp ?? me.hp;
  if (foe && s.foeUsed?.includes(BIDE) && bide?.ec !== foe.ec) {
    bide = { ec: foe.ec, hpStart: foeHPPrev.get(foe.ec) ?? foe.hp, turn: battleTurn, myEC: me.ec, myHP };
    console.log(`[bide] ${speciesName(foe.species)} used Bide (its HP ${bide.hpStart})`);
  }
  if (bide) {
    const released = bide.myEC === me.ec && myHP < bide.myHP;
    const why = !foe || foe.ec !== bide.ec ? "foe left" : foe.hp === 0 ? "foe fainted" : released ? `released for ${bide.myHP - myHP} HP` : battleTurn - bide.turn > 3 ? "timed out" : "";
    if (why) { console.log(`[bide] over: ${why}`); bide = null; }
    else { bide.myEC = me.ec; bide.myHP = myHP; }
  }
  if (foe) foeHPPrev.set(foe.ec, foe.hp);
  // Weather: entries (foe first, then mine; their order at the same moment isn't known) and weather moves.
  const setW = (kind: Weather, until: number, why: string) => {
    if (weather?.kind !== kind || weather.until !== until) console.log(`[weather] ${kind} (${why})`);
    weather = { kind, until };
  };
  if (foe && foe.ec !== prevFoeEC && WEATHER_ABILITY[abilityName(foe.ability)]) setW(WEATHER_ABILITY[abilityName(foe.ability)], Infinity, `${speciesName(foe.species)}'s ${abilityName(foe.ability)}`);
  if (me.ec !== prevMyEC && WEATHER_ABILITY[abilityName(me.ability)]) setW(WEATHER_ABILITY[abilityName(me.ability)], Infinity, `${monLabel(me)}'s ${abilityName(me.ability)}`);
  for (const id of [...s.used.map(([, mv]) => mv), ...(s.foeUsed ?? [])]) if (WEATHER_MOVE[id]) setW(WEATHER_MOVE[id], battleTurn + 5, moveName(id));
  if (weather && battleTurn >= weather.until) { console.log(`[weather] ${weather.kind} ended`); weather = null; }
  if (transform && foe?.ec !== transform.ec) transform = null; // it reverts when it leaves the field
  if (foe && !transform && (s.foeUsed?.includes(TRANSFORM) || foe.ec !== prevFoeEC && abilityName(foe.ability) === "Imposter")) {
    transform = { ec: foe.ec, copy: { ...me } };
    console.log(`[transform] ${speciesName(foe.species)} transformed into ${speciesName(me.species)}`);
  }
  prevMyEC = me.ec; prevFoeEC = foe?.ec ?? 0;
  // Dynamax: the live max HP roughly doubles (1.5–2×) vs the stat-computed max.
  const isDmax = (m: Mon & { maxHP?: number }) => !!m.maxHP && m.maxHP >= 1.4 * toCalc({ ...m, dynamax: false }).maxHP();
  const meLive = { ...me, hp: s.active?.hp ?? me.hp, maxHP: s.active?.maxHP };
  meLive.dynamax = isDmax(meLive);
  const battleKey = s.enemyTeam.map((m) => m.ec.toString(16)).sort().join("-") || String(s.wildEC);
  if (!dynamaxUsed && loadDmax(battleKey)) dynamaxUsed = true;
  // Any of my Pokémon showing Dynamax HP (on the field or its battle block) means it's been used.
  if (meLive.dynamax || team.some((m) => isDmax(m as Mon & { maxHP?: number }))) { if (!dynamaxUsed) saveDmax(battleKey); dynamaxUsed = true; }
  // Gym leaders Dynamax their last Pokémon: plan for it before it happens (gym battles only).
  const dynamaxBattle = DYNAMAX_TRAINERS.has(foeMon.ot);
  const lastOne = trainer && s.enemyTeam.filter((m) => m.hp > 0).length === 1;
  const expectDmax = between && lastOne && dynamaxBattle;
  const reallyDmax = isDmax(enemyMon as Mon & { maxHP?: number });
  // Expected (not yet real) Dynamax: live HP isn't doubled yet, so double it to match the calc's Dynamax scaling.
  const copyOf = transform?.ec === enemyMon.ec ? transform.copy : enemyMon.moves.includes(TRANSFORM) ? me : null;
  const asCopy = copyOf && {
    ...copyOf, ec: enemyMon.ec, hp: enemyMon.hp, maxHP: enemyMon.maxHP, heldItem: enemyMon.heldItem, ot: enemyMon.ot, tid: enemyMon.tid,
    nickname: undefined, pp: copyOf.moves.map((m) => (m ? 5 : 0)), transformHP: enemyMon.maxHP,
    realSpecies: enemyMon.species, transformPending: transform?.ec !== enemyMon.ec,
  };
  const foeLive = { ...(asCopy ?? enemyMon), dynamax: expectDmax || reallyDmax, hp: expectDmax && !reallyDmax ? enemyMon.hp * 2 : enemyMon.hp };
  dynamaxAllowed = dynamaxBattle || reallyDmax || !!meLive.dynamax;
  bossName = GAME.id === "b2" ? B2_BOSSES.get(s.trainerId ?? 0) : undefined;
  bossBattle = dynamaxBattle || !!bossName;
  current = {
    trainer,
    me: { active: meLive, bench: team.filter((m) => m !== me) },
    enemy: exact
      ? { active: foeLive, bench: s.enemyTeam.filter((m) => m !== foe && seenFoes.has(m.ec)), abilityKnown: !!asCopy || abilityKnown(enemyMon.species) }
      : { active: foeLive, bench: [], hpPercent: enemyPct, abilityKnown: !!asCopy || abilityKnown(enemyMon.species) },
  };
  // Advise once the battle counter has settled (the game is waiting for input).
  const now = Date.now();
  if (s.counter !== lastCounter) { lastCounter = s.counter; stableSince = now; return; }
  const key = `${between}:${battleEC}:${me.species}:${current.me.active.hp}:${meLive.status}:${foeLive.status}:${exact ? enemyMon.hp : enemyPct}:${meLive.dynamax}:${foeLive.dynamax}:${bide ? bide.hpStart : ""}:${weather?.kind ?? ""}`;
  if (now - stableSince >= 800 && key !== lastKey) { lastKey = key; void update(current, !exact, reader.balls(), { team, activeEC: s.activeEC, participants: s.participants }, reader.medicine(), between ? alive : []); }
}

// ---- http ----
http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  if (url.pathname === "/events") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    clients.add(res);
    res.write(`data: ${JSON.stringify(latest)}\n\n`);
    req.on("close", () => clients.delete(res));
  } else if (url.pathname === "/used" && req.method === "POST") {
    // Player reports the move they used: subtract its average damage from the estimate.
    const m = latest.analysis?.myMoves.find((x) => x.move === url.searchParams.get("move"));
    if (m && current) {
      enemyPct = Math.max(0, Math.round(enemyPct - (m.pctMax[0] + m.pctMax[1]) / 2));
      current.enemy.hpPercent = enemyPct;
      lastKey = "";
      void update(current, true);
    }
    res.end("ok");
  } else if (url.pathname === "/plan-skip" && req.method === "POST") {
    // Sam skipped a plan step: hide it and tell the planner never to suggest it again.
    const id = url.searchParams.get("id") ?? "", step = plan?.steps.find((x) => x.id === id);
    if (step) {
      declined[id] = step.text;
      try { writeFileSync(DECLINED_FILE, JSON.stringify(declined, null, 1)); } catch (e) { console.log("[plan]", (e as Error).message); }
      console.log(`[plan] skipped: ${step.text}`);
      if (latest.planSteps) { latest.planSteps = planSteps(); if (!latest.planSteps.length) latest.bagTips = [...(latest.bagTips ?? []), ...planTips()]; push(); }
    }
    res.end("ok");
  } else if (url.pathname === "/enemy-hp" && req.method === "POST") {
    enemyPct = Math.min(100, Math.max(0, Number(url.searchParams.get("pct"))));
    if (current) { current.enemy.hpPercent = enemyPct; lastKey = ""; void update(current, true); }
    res.end("ok");
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // Re-read each time so edits show on reload.
    res.end(readFileSync(page, "utf8").replace("<body>", `<body data-support="${SUPPORT ? 1 : 0}">`));
  }
}).listen(PORT, "127.0.0.1", () => console.log(`battle assistant on http://localhost:${PORT} (${DEMO ? "demo" : `live, ${GAME.name}`})`));

if (DEMO) void update(demoState(), false);
else {
  // One bad read (garbage memory, an unknown species) must not take the page down mid-battle.
  let lastErr = "";
  setInterval(() => {
    try { poll(); } catch (e) {
      const msg = (e as Error).stack?.split("\n").slice(0, 3).join(" | ") ?? String(e);
      if (msg !== lastErr) { lastErr = msg; console.log("[poll error]", msg); }
    }
  }, 500);
}
