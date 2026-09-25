// Local web server: polls Eden's memory, serves the advice page and pushes
// updates over SSE. PBA_SOURCE=demo shows the sample battle instead.
import http from "node:http";
import { readFileSync } from "node:fs";
import { analyze, type Analysis, type BattleState } from "./engine/calc.ts";
import { advise, type Advice } from "./engine/advisor.ts";
import { demoState } from "./sources/demo.ts";
import { LiveReader } from "./sources/live.ts";
import { moveName, speciesName } from "./names.ts";
import { catchOdds } from "./engine/catch.ts";
import { training, type Training } from "./engine/training.ts";
import type { Mon } from "./pk8.ts";
import { battleHeal, cureFor, healItems, topUp } from "./engine/heal.ts";
import { checkAdvice, fallbackAdvice } from "./engine/safety.ts";
import { toCalc } from "./engine/calc.ts";

const TARGET = Number(process.env.PBA_TARGET_LEVEL) || 0;
const NUZLOCKE = process.env.PBA_NUZLOCKE === "1";

const PORT = Number(process.env.PBA_PORT ?? 7878);
const DEMO = process.env.PBA_SOURCE === "demo";
const page = new URL("../public/index.html", import.meta.url);

type Status = "no-emulator" | "waiting" | "trainer" | "battle";
let latest: { status: Status; analysis?: Analysis; advice?: Advice; error?: string; estimated?: boolean; catch?: ReturnType<typeof catchOdds>; training?: Training; nuzlocke?: boolean;
  heal?: ReturnType<typeof battleHeal>; cure?: { item: string; count: number; target: string; status: string } | null; topUp?: ReturnType<typeof topUp>; at: number } = { status: "waiting", at: Date.now() };
const clients = new Set<http.ServerResponse>();
const push = () => { for (const c of clients) c.write(`data: ${JSON.stringify(latest)}\n\n`); };
const setStatus = (status: Status, extra: Partial<typeof latest> = {}) => {
  const changed = latest.status !== status || latest.analysis || JSON.stringify(extra.topUp) !== JSON.stringify(latest.topUp);
  if (changed) { latest = { status, ...extra, at: Date.now() }; push(); }
};

// Advice runs are keyed so a stale response never overwrites a newer turn.
let adviceSeq = 0;
interface TeamCtx { team: Mon[]; activeEC: number; participants: Set<number> }

async function update(state: BattleState, estimated: boolean, balls: { id: number; count: number }[] = [], team?: TeamCtx, meds: { id: number; count: number }[] = []) {
  const analysis = analyze(state, { preferLowLevel: TARGET > 0 });
  const seq = ++adviceSeq;
  const e = analysis.enemy;
  const odds = balls.length && !state.trainer ? catchOdds({
    speciesNum: state.enemy.active.species, speciesName: e.name, level: e.level, types: e.types, status: e.status,
    maxHP: e.maxHP, hpPercent: e.hpPercent, myLevel: analysis.me.level, turn: battleTurn, balls,
  }) : undefined;
  console.log(`[turn] ${analysis.me.name} ${analysis.me.hp}/${analysis.me.maxHP} vs ${analysis.enemy.name} Lv${analysis.enemy.level} ~${analysis.enemy.hpPercent}%`);
  const train = TARGET && team ? training({
    target: TARGET, team: team.team, activeEC: team.activeEC, participants: team.participants,
    enemySpecies: state.enemy.active.species, enemyLevel: e.level, trainer: state.trainer, analysis, nuzlocke: NUZLOCKE,
  }) : undefined;
  const heal = meds.length ? battleHeal(analysis, meds, NUZLOCKE) : null;
  const c = cureFor(analysis.me.status, meds);
  const cure = c && { item: c.name, count: c.count, target: analysis.me.name, status: analysis.me.status };
  latest = { status: "battle", analysis, estimated, catch: odds, training: train, nuzlocke: NUZLOCKE, heal, cure, at: Date.now() };
  push(); // numbers show immediately; advice follows a few seconds later
  try {
    const advice = await advise(analysis, {
      ...(train ? { training: { target: train.target, tip: train.tip, members: train.members } } : {}),
      healOption: heal, cureOption: cure, healItems: healItems(meds),
    });
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
const reader = new LiveReader();
let battleEC = 0;           // EC of the wild Pokémon in the current battle
let enemyPct = 100;         // estimated enemy HP %, lowered when the player reports a move
let lastKey = "", stableSince = 0, lastCounter = -1;
let battleTurn = 1;
let owned = new Set<number>(); // species caught so far: their randomized ability is known
let current: BattleState | null = null;

function poll() {
  const s = reader.poll();
  if (!s) return setStatus("no-emulator");
  if (!s.inBattle) {
    battleEC = 0; current = null; lastKey = "";
    // Between battles: who needs healing before the next fight (save-copy HP is current here).
    const team = s.party.map((m) => ({ name: speciesName(m.species), hp: m.hp, maxHP: toCalc(m).maxHP() }));
    return setStatus("waiting", { topUp: topUp(team, reader.medicine()) });
  }
  // The opponent's party blocks start at the wild slot: 1 Pokémon for wild battles, more for trainers.
  // The opponent's on-field record says who's out; fallback: the first one still standing.
  const byRecord = s.enemyTeam.find((m) => m.ec === s.foeFieldEC && m.hp > 0);
  const foe = byRecord ?? s.enemyTeam.find((m) => m.hp > 0) ?? s.enemyTeam[0];
  if (!foe && !s.wild) return setStatus("waiting");
  // A trainer's Pokémon carry the trainer's name; wild ones have no OT name yet (they do come
  // pre-stamped with the player's TID, so the ID can't be used). Catches one-Pokémon trainers.
  const foeMon = foe ?? s.wild!;
  const trainer = s.enemyTeam.length > 1 || foeMon.ot !== "";
  const foeKey = foe?.ec ?? s.wildEC;
  if (foeKey !== battleEC) {
    battleEC = foeKey; enemyPct = 100; battleTurn = 1; owned = reader.ownedSpecies();
    console.log(`[foe] ${speciesName(foeMon.species)} OT="${foeMon.ot}" TID=${foeMon.tid} team=${s.enemyTeam.length} → ${trainer ? "trainer" : "wild"} (on-field via ${byRecord ? "record" : "fallback"})`);
  }
  const exact = foe !== undefined;
  if (s.used.length) battleTurn++;
  // In-battle party (party order, live HP); fall back to the save party.
  const team = s.battleParty.length ? s.battleParty : s.party;
  const me = team.find((m) => m.species === s.active?.species) ?? team[0];
  const enemyMon = foe ?? s.wild!;
  current = {
    trainer,
    me: { active: { ...me, hp: s.active?.hp ?? me.hp }, bench: team.filter((m) => m !== me) },
    enemy: exact
      ? { active: enemyMon, bench: s.enemyTeam.filter((m) => m !== foe), abilityKnown: owned.has(enemyMon.species) }
      : { active: enemyMon, bench: [], hpPercent: enemyPct, abilityKnown: owned.has(enemyMon.species) },
  };
  // Advise once the battle counter has settled (the game is waiting for input).
  const now = Date.now();
  if (s.counter !== lastCounter) { lastCounter = s.counter; stableSince = now; return; }
  const key = `${battleEC}:${me.species}:${current.me.active.hp}:${exact ? enemyMon.hp : enemyPct}`;
  if (now - stableSince >= 800 && key !== lastKey) { lastKey = key; void update(current, !exact, reader.balls(), { team, activeEC: s.activeEC, participants: s.participants }, reader.medicine()); }
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
}).listen(PORT, "127.0.0.1", () => console.log(`battle assistant on http://localhost:${PORT} (${DEMO ? "demo" : "live"})`));

if (DEMO) void update(demoState(), false);
else setInterval(poll, 500);
