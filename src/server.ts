// Local web server: polls Eden's memory, serves the advice page and pushes
// updates over SSE. PBA_SOURCE=demo shows the sample battle instead.
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { analyze, type Analysis, type BattleState } from "./engine/calc.ts";
import { advise, adviseDouble, type Advice, type DoubleAdvice } from "./engine/advisor.ts";
import { analyzeDouble, checkDoubleAdvice, type DoubleAnalysis } from "./engine/doubles.ts";
import { demoState } from "./sources/demo.ts";
import { LiveReader } from "./sources/live.ts";
import { B2Reader } from "./sources/live-b2.ts";
import { GAME } from "./game.ts";
import { B2_BOSSES } from "./offsets/b2.ts";
import { monLabel, moveName, speciesName } from "./names.ts";
import { catchOdds } from "./engine/catch.ts";
import { training, type Training } from "./engine/training.ts";
import type { Mon } from "./pk8.ts";
import { battleHeal, cureFor, healItems, topUp } from "./engine/heal.ts";
import { checkAdvice, fallbackAdvice } from "./engine/safety.ts";
import { bagTips } from "./engine/items.ts";
import { dropCandidate, newMoves, type NewMove } from "./engine/moves.ts";
import { toCalc } from "./engine/calc.ts";

const TARGET = Number(process.env.PBA_TARGET_LEVEL) || 0;
// Stronger (pricier) model for gym leader / Champion battles only; unset = same model everywhere.
const BOSS_MODEL = process.env.PBA_BOSS_MODEL;
let bossBattle = false;
let bossName: string | undefined; // Black 2 gym leader / Elite Four: the level cap is off for this fight
const NUZLOCKE = process.env.PBA_NUZLOCKE === "1";

const PORT = Number(process.env.PBA_PORT ?? 7878);
const DEMO = process.env.PBA_SOURCE === "demo";
const page = new URL("../public/index.html", import.meta.url);

type Status = "no-emulator" | "waiting" | "trainer" | "battle";
let latest: { status: Status; analysis?: Analysis; advice?: Advice; error?: string; estimated?: boolean; catch?: ReturnType<typeof catchOdds>; training?: Training; nuzlocke?: boolean;
  heal?: ReturnType<typeof battleHeal>; bagTips?: string[];
  levelUp?: ReturnType<typeof dropCandidate> & { level: number; at: number }; newMoves?: NewMove[];
  doubles?: DoubleAnalysis; doubleAdvice?: DoubleAdvice; cure?: { item: string; count: number; target: string; status: string } | null; topUp?: ReturnType<typeof topUp>; nextOptions?: { foe: string; action: string; choice: string; reason: string }[]; at: number } = { status: "waiting", at: Date.now() };
const clients = new Set<http.ServerResponse>();
// Level-up move offers (Black 2 learnsets), attached to every update so the page always shows them.
let moveTips: NewMove[] = [];
const push = () => { latest.newMoves = moveTips; for (const c of clients) c.write(`data: ${JSON.stringify(latest)}\n\n`); };
const setStatus = (status: Status, extra: Partial<typeof latest> = {}) => {
  const changed = latest.status !== status || latest.analysis || JSON.stringify(extra.topUp) !== JSON.stringify(latest.topUp)
    || JSON.stringify(extra.bagTips) !== JSON.stringify(latest.bagTips);
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
// Poké Dolls in the battle-items pouch (guaranteed escape from wild battles).
const pokeDolls = () => { try { return reader.battleItems().find((i) => i.id === 63)?.count ?? 0; } catch { return 0; } };
let dynamaxAllowed = false; // this battle permits Dynamax (gym/stadium, or someone is Dynamaxed)
async function update(state: BattleState, estimated: boolean, balls: { id: number; count: number }[] = [], team?: TeamCtx, meds: { id: number; count: number }[] = [], nextFoes: Mon[] = []) {
  const capOn = TARGET > 0 && !bossName;
  const analysis = analyze(state, { preferLowLevel: capOn, dynamaxUsed: dynamaxUsed || !dynamaxAllowed, freeSwitch: between,
    myDamageScale: damageScale.get(state.enemy.active.ec) ?? 1 });
  const seq = ++adviceSeq;
  const e = analysis.enemy;
  const odds = balls.length && !state.trainer ? catchOdds({
    speciesNum: state.enemy.active.species, speciesName: e.name, level: e.level, types: e.types, status: e.status,
    maxHP: e.maxHP, hpPercent: e.hpPercent, myLevel: analysis.me.level, turn: battleTurn, balls,
  }) : undefined;
  console.log(`[turn] ${analysis.me.name} ${analysis.me.hp}/${analysis.me.maxHP} vs ${analysis.enemy.name} Lv${analysis.enemy.level} ~${analysis.enemy.hpPercent}%`);
  const train = capOn && team ? training({
    target: TARGET, team: team.team, activeEC: team.activeEC, participants: team.participants,
    enemySpecies: state.enemy.active.species, enemyLevel: e.level, trainer: state.trainer, analysis, nuzlocke: NUZLOCKE,
  }) : undefined;
  const heal = meds.length ? battleHeal(analysis, meds, NUZLOCKE) : null;
  const c = cureFor(analysis.me.status, meds);
  const cure = c && { item: c.name, count: c.count, target: analysis.me.name, status: analysis.me.status };
  latest = { status: "battle", analysis, estimated, catch: odds, training: train, nuzlocke: NUZLOCKE, heal, cure, at: Date.now() };
  push(); // numbers show immediately; advice follows a few seconds later
  // Between foes with more than one left: the next one isn't known until it's sent out (trainers don't
  // go in stored order), so show the calculator's pick against each candidate instead of guessing.
  if (nextFoes.length > 1) {
    latest.nextOptions = nextFoes.map((f) => {
      const a = analyze({ ...state, enemy: { active: f, bench: nextFoes.filter((x) => x !== f), abilityKnown: abilityKnown(f.species) } },
        { preferLowLevel: capOn, dynamaxUsed: dynamaxUsed || !dynamaxAllowed, freeSwitch: true, myDamageScale: damageScale.get(f.ec) ?? 1 });
      const fb = fallbackAdvice(a, NUZLOCKE);
      return { foe: speciesName(f.species), action: fb.action, choice: fb.choice, reason: fb.reason };
    });
    push();
    console.log(`[advice] next foe unknown: ${latest.nextOptions.map((o) => `${o.foe} → ${o.action} ${o.choice}`).join("; ")}`);
    return;
  }
  // Obvious turns don't need the AI (saves API cost): a KO that lands before the enemy moves, or a safe,
  // winning matchup with no KO risk and no better switch. The calculator's pick is shown directly.
  const sureKO = analysis.iMoveFirst === true && analysis.myMoves.some((m) => m.category !== "Status" && m.ofCurrent[0] >= analysis.enemy.hp);
  const easy = !analysis.between && !analysis.swap && !analysis.koRisk.maxRoll && !analysis.koRisk.withCrit
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
const reader: Pick<LiveReader, "poll" | "balls" | "medicine" | "generalItems" | "battleItems" | "machines" | "ownedSpecies"> =
  GAME.id === "b2" ? new B2Reader() : new LiveReader();
let battleEC = 0;           // EC of the wild Pokémon in the current battle
let enemyPct = 100;         // estimated enemy HP %, lowered when the player reports a move
let lastKey = "", stableSince = 0, lastCounter = -1;
let battleTurn = 1;
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

// Level-up watcher: when a party member's level goes up, say which move to forget if it wants a new one.
const levels = new Map<number, number>();
let levelUp: (ReturnType<typeof dropCandidate> & { level: number; at: number }) | null = null;
function watchLevels(team: Mon[]) {
  for (const m of team) {
    const prev = levels.get(m.ec), lv = m.level ?? 0;
    if (prev !== undefined && lv > prev) {
      const d = dropCandidate(m);
      if (d) { levelUp = { ...d, level: lv, at: Date.now() }; console.log(`[levelup] ${d.pokemon} → Lv ${lv}; if offered a move, drop ${d.drop}`); }
    }
    levels.set(m.ec, lv);
  }
  if (levelUp && Date.now() - levelUp.at > 120_000) levelUp = null;
}

function poll() {
  const s = reader.poll();
  if (!s) return setStatus("no-emulator");
  watchLevels(s.inBattle && s.battleParty.length ? s.battleParty : s.party);
  try {
    const tipsNow = newMoves(s.inBattle && s.battleParty.length ? s.battleParty : s.party);
    if (JSON.stringify(tipsNow) !== JSON.stringify(moveTips)) { moveTips = tipsNow; push(); }
  } catch (e) { console.log("[newmoves]", (e as Error).message); }
  // (Level-up banner removed from the page at Sam's request; the watcher only logs now.)
  if (!s.inBattle) {
    battleEC = 0; current = null; lastKey = ""; dynamaxUsed = false;
    // Between battles: who needs healing before the next fight (save-copy HP is current here).
    const team = s.party.map((m) => ({ name: monLabel(m), hp: m.hp, maxHP: toCalc(m).maxHP() }));
    // Bag tips (held items, candies, TMs) between battles; recomputed at most every 30 s.
    if (Date.now() - tipsAt > 30_000) {
      try { tips = bagTips(s.party, reader.generalItems(), reader.machines(), TARGET || 100); } catch (e) { console.log("[bag]", (e as Error).message); }
      tipsAt = Date.now();
    }
    return setStatus("waiting", { topUp: topUp(team, reader.medicine()), bagTips: tips });
  }
  // The opponent's party blocks start at the wild slot: 1 Pokémon for wild battles, more for trainers.
  // ---- Double battles: separate analysis and advice ----
  if (s.double) {
    const byEC = (list: Mon[], ec: number) => list.find((m) => m.ec === ec);
    const mine = s.myActives.map((ec) => byEC(s.battleParty, ec)).filter((m): m is Mon => !!m && m.hp > 0);
    const foes = s.foeActives.map((ec) => byEC(s.enemyTeam, ec)).filter((m): m is Mon => !!m && m.hp > 0);
    if (!mine.length || !foes.length) return;
    const key = `D:${mine.map((m) => `${m.ec}:${m.hp}`).join(",")}|${foes.map((m) => `${m.ec}:${m.hp}`).join(",")}`;
    const now = Date.now();
    if (s.counter !== lastCounter) { lastCounter = s.counter; stableSince = now; }
    if (key === lastKey || now - stableSince < 800) return;
    lastKey = key;
    const d = analyzeDouble({ mine, foes, bench: s.battleParty.filter((m) => !s.myActives.includes(m.ec)), abilityKnown }, NUZLOCKE);
    const seq = ++adviceSeq;
    latest = { status: "battle", doubles: d, nuzlocke: NUZLOCKE, at: now };
    push();
    console.log(`[doubles] ${d.actives.map((a) => `${a.name} ${a.hp}/${a.maxHP}`).join(" + ")} vs ${d.foes.map((f) => `${f.name} ${f.hp}/${f.maxHP}`).join(" + ")}`);
    const foeOT = s.enemyTeam[0]?.ot ?? "";
    adviseDouble(d, DYNAMAX_TRAINERS.has(foeOT) && BOSS_MODEL ? BOSS_MODEL : undefined).then((adv) => {
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
  const foeLive = { ...enemyMon, dynamax: expectDmax || reallyDmax, hp: expectDmax && !reallyDmax ? enemyMon.hp * 2 : enemyMon.hp };
  dynamaxAllowed = dynamaxBattle || reallyDmax || !!meLive.dynamax;
  bossName = GAME.id === "b2" ? B2_BOSSES.get(s.trainerId ?? 0) : undefined;
  bossBattle = dynamaxBattle || !!bossName;
  current = {
    trainer,
    me: { active: meLive, bench: team.filter((m) => m !== me) },
    enemy: exact
      ? { active: foeLive, bench: s.enemyTeam.filter((m) => m !== foe), abilityKnown: abilityKnown(enemyMon.species) }
      : { active: foeLive, bench: [], hpPercent: enemyPct, abilityKnown: abilityKnown(enemyMon.species) },
  };
  // Advise once the battle counter has settled (the game is waiting for input).
  const now = Date.now();
  if (s.counter !== lastCounter) { lastCounter = s.counter; stableSince = now; return; }
  const key = `${between}:${battleEC}:${me.species}:${current.me.active.hp}:${exact ? enemyMon.hp : enemyPct}:${meLive.dynamax}:${foeLive.dynamax}`;
  if (now - stableSince >= 800 && key !== lastKey) { lastKey = key; void update(current, !exact, reader.balls(), { team, activeEC: s.activeEC, participants: s.participants }, reader.medicine(), between ? s.enemyTeam.filter((m) => m.hp > 0) : []); }
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
  } else if (url.pathname === "/enemy-hp" && req.method === "POST") {
    enemyPct = Math.min(100, Math.max(0, Number(url.searchParams.get("pct"))));
    if (current) { current.enemy.hpPercent = enemyPct; lastKey = ""; void update(current, true); }
    res.end("ok");
  } else {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(page)); // re-read each time so edits show on reload
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
