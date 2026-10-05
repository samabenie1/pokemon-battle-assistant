// Bag planner: one model call that looks at the whole party + bag + TMs at once and returns a short list of steps
// (teach a TM/HM, give/take a held item, use a candy). Every number the model may cite is computed here first
// (effective move power per Pokémon, recoil, coverage), the step text is built here from structured fields, and each
// step is checked against the save before it's shown. The items.ts heuristics are the fallback if this fails.
import Anthropic from "@anthropic-ai/sdk";
import { Generations, Move } from "@smogon/calc";
import type { Mon } from "../pk8.ts";
import { abilityName, moveName, speciesName, moveAccuracy } from "../names.ts";
import { toCalc } from "./calc.ts";
import { GAME } from "../game.ts";
import { canLearn, HM_MOVES, machineLabel, machineSlot } from "../offsets/b2rom.ts";
import { itemLabel, notAble, power, type B2Machines, type Pouch } from "./items.ts";
import { isOPStatus } from "./moves.ts";

const client = new Anthropic();
// Sonnet's plans contradicted themselves and invented numbers (10-01), so this uses Opus.
const MODEL = process.env.PBA_PLAN_MODEL ?? "claude-opus-5-5";
const gen = Generations.get(GAME.gen);

const SYSTEM = `You plan bag usage for a Pokémon ${GAME.name} randomized NUZLOCKE run (a faint is permanent).
Priority: (1) no faints, (2) win fights, (3) EXP. Trainer teams are randomized and secret: never guess or mention them.

Input, per party Pokémon: its moves with "eff" (effective power for THIS Pokémon: base power × STAB × hits × its
matching attack stat ÷ its better attack stat), recoil, and tmOptions (TMs/HMs it can learn, with eff for it).
Compare moves ONLY by these eff numbers. Two-turn moves (Shadow Force, Fly, Dig, Solar Beam, Hyper Beam…) already have eff halved per turn.
Fixed-damage moves (Night Shade, Seismic Toss…) show eff null and do damage
equal to the user's level.

Rules:
- eff already includes accuracy. Never teach an attack with accuracy under 70 (Zap Cannon, Dynamic Punch, Inferno…).
- Moves marked "hm": true can NOT be forgotten; never put one in replaces.
- TMs and HMs are reusable (one TM can go to several Pokémon). HM moves can only be deleted in Mistralton City, so
  teach one only if it's worth keeping.
- Teach a TM only when it clearly beats the move it replaces: eff at least ~25% higher, or a new attacking type the
  Pokémon lacks with similar eff, or it replaces a recoil move with similar eff. Never replace a Pokémon's last
  attack of one of its own types (its only Steel STAB on a Water/Steel, etc.) with a different type.
- What to forget: a weak status move (status move without "op": true) ALWAYS goes first; any decent attack beats it.
  Strong status moves ("op": true: sleep, paralysis, burn, recovery, setup) are kept unless an attack clearly matters more.
- Held items: one per Pokémon. Eviolite on a Pokémon that canEvolve. Exp. Share on the lowest-level Pokémon below
  levelCap; take it off at the cap. A type booster only on a Pokémon whose best eff move is that type.
- Rare Candy / Exp. Candy only on Pokémon below levelCap, never past it.
- Fewer steps is better. Only steps that clearly help; no step is a valid answer. Never two steps for the same
  Pokémon's same move slot or held-item slot.
- hints[] are rough rule-based ideas; follow them only if they pass these rules.
- declined[]: steps the player chose to skip. Never suggest them (or the same thing reworded) again.
- previous[]: your last plan. Keep its steps that are still valid and not done; don't swap one good option for
  another equally good one (no flip-flopping between runs).
- Moving a held item from one party Pokémon to another is ONE "give" step (item = the held item); don't add a
  separate "take" step for it.
- The bar for teaching: the new move's eff must be at least 60% of the Pokémon's best current attack eff (90% for
  an HM) and at least 45. A weak attack is not worth a TM just because it replaces a status move.

Shopping (shop = the last Poké Mart seen; its stock is randomized, so only buy what shop.stock lists, at its price):
- Every shop has one ₽0 item. House rule: the player may take only ONE of it (count 1). Take it if it's useful.
- Total cost of all buy steps must fit in money; keep about ₽1000 spare unless the purchase is important.
- NUZLOCKE: fainted Pokémon are dead, so never buy Revive / Max Revive / Revival Herb / Sacred Ash.
- Worth buying: a held item a party Pokémon should hold (then also add the give step), Eviolite for a Pokémon that
  canEvolve, status cures and healing the team is short on (check medicine[]), X items for boss fights.
- Don't buy what the bag already has enough of. No buy steps at all is fine.

Each step: kind ("buy" = buy count × item from the shop, "tm" = teach tm to pokemon replacing a move, "give" = give item to pokemon, "take" = take item
off pokemon, "use" = use item on pokemon), exact names from the input, and why: ONE short plain sentence (max 15
words) that only uses numbers from the input, e.g. "Ominous Wind eff 65 vs Flare Blitz eff 30, no recoil."`;

const SCHEMA = {
  type: "object",
  properties: {
    steps: { type: "array", items: { type: "object", properties: {
      kind: { type: "string", enum: ["buy", "tm", "give", "take", "use"] },
      count: { type: "integer", description: "kind buy: how many, else 0" },
      pokemon: { type: "string", description: "Exact party[].name (empty for buy)" },
      tm: { type: "string", description: "Exact tmOptions[].tm for kind tm, else empty" },
      item: { type: "string", description: "Exact bag item (give/use) or held item (take), else empty" },
      replaces: { type: "string", description: "kind tm: the exact move it replaces (empty only if the Pokémon has a free slot). kind give: the held item it replaces, else empty" },
      why: { type: "string" },
    }, required: ["kind", "count", "pokemon", "tm", "item", "replaces", "why"], additionalProperties: false } },
  },
  required: ["steps"],
  additionalProperties: false,
} as const;

type Step = { from?: string; kind: "buy" | "tm" | "give" | "take" | "use"; count: number; pokemon: string; tm: string; item: string; replaces: string; why: string };
export interface BagPlan { steps: { id: string; text: string; why: string }[]; dropped: string[]; model: string; ms: number; usage: { in: number; out: number; cached: number } }

/** One move as the planner sees it: effective power for this Pokémon, recoil, type. */
function moveFor(mon: Mon, name: string) {
  const mv = new Move(gen, name);
  return {
    name, type: mv.type, category: mv.category,
    eff: mv.category === "Status" || !mv.bp ? null : Math.round(power(mon, name)),
    ...(mv.recoil ? { recoil: true } : {}),
    ...(HM_MOVES.has(name) ? { hm: true } : {}),
    ...(moveAccuracy(name) < 100 ? { accuracy: moveAccuracy(name) } : {}),
    ...(mv.category === "Status" ? { op: isOPStatus(name) } : {}),
  };
}

export interface PlanInput {
  party: Mon[]; items: Pouch[]; machines: Pouch[]; cap: number; b2?: B2Machines | null; hints: string[];
  /** Steps the player skipped (never suggest again) and the last plan shown (keep it unless something changed). */
  declined: string[]; previous: string[];
  medicine: Pouch[]; money: number;
  /** The last Poké Mart buy list seen (randomized stock), and whether that menu is open right now. */
  shop: { items: { id: number; price: number }[]; openNow: boolean } | null;
}

export function planInput(p: PlanInput) {
  const b2 = p.b2;
  const owned = b2 ? p.machines.filter((t) => t.count > 0).map((t) => machineSlot(t.id)).filter((s) => s >= 0) : [];
  const blocked = notAble();
  const party = p.party.map((m) => {
    const c = toCalc(m);
    const sp = gen.species.get(c.name.toLowerCase().replace(/[^a-z0-9]/g, "") as never) as { nfe?: boolean } | undefined;
    const moves = m.moves.filter(Boolean).map((id) => moveFor(m, moveName(id)));
    const tmOptions = b2?.compat ? owned.filter((slot) => canLearn(b2.compat!, m.species, slot, m.form) && !(blocked[machineLabel(slot)] ?? []).includes(speciesName(m.species)))
      .map((slot) => ({ tm: machineLabel(slot), ...moveFor(m, moveName(b2.moves[slot])) }))
      .filter((o) => !moves.some((x) => x.name === o.name)) : [];
    return {
      name: m.nickname ? `${m.nickname} (${speciesName(m.species)})` : speciesName(m.species), level: m.level ?? 1,
      types: c.types, ability: abilityName(m.ability), canEvolve: !!sp?.nfe, atk: c.stats.atk, spa: c.stats.spa,
      held: m.heldItem ? itemLabel(m.heldItem) : null, moves, tmOptions,
    };
  });
  return {
    levelCap: p.cap, party,
    bag: p.items.filter((i) => i.count > 0).map((i) => ({ item: itemLabel(i.id), count: i.count })), hints: p.hints,
    declined: p.declined, previous: p.previous,
    medicine: p.medicine.filter((i) => i.count > 0).map((i) => ({ item: itemLabel(i.id), count: i.count })),
    money: p.money,
    shop: p.shop && { openNow: p.shop.openNow, stock: p.shop.items.map((x) => ({ item: itemLabel(x.id), price: x.price })) },
  };
}

type Input = ReturnType<typeof planInput>;

/** The other party member holding this step's item (a "give" that moves an item), if any. */
const holder = (st: Step, input?: Input) => input?.party.find((m) => m.name !== st.pokemon && heldBy(m) === st.item);

// Steps are checked in order against a simulated state: items bought, items put back in the bag, and who holds
// what after the earlier steps (so "move X off A, then give Y to A" chains work).
let buying: Set<string> | undefined, freed: Set<string> | undefined, simHeld: Map<string, string | null> | undefined;
const heldBy = (m: { name: string; held: string | null }) => simHeld?.has(m.name) ? simHeld.get(m.name)! : m.held;
/** Apply a step that passed the check to the simulated state. */
function apply(st: Step, input: Input) {
  const mon = input.party.find((m) => m.name === st.pokemon);
  if (!mon || !simHeld || !freed) return;
  if (st.kind === "give") {
    const from = input.bag.some((b) => b.item === st.item) || buying?.has(st.item) || freed.has(st.item) ? undefined : holder(st, input);
    if (from) simHeld.set(from.name, null); else freed.delete(st.item);
    const old = heldBy(mon);
    if (old) freed.add(old);
    simHeld.set(mon.name, st.item);
  } else if (st.kind === "take") { freed.add(st.item); simHeld.set(mon.name, null); }
}

/** Null if the step matches the save, else why it doesn't. */
function check(st: Step, input: Input): string | null {
  if (st.kind === "buy") {
    const sold = input.shop?.stock.find((x) => x.item === st.item);
    if (!sold) return `${st.item} isn't sold in the last shop seen`;
    if (st.count < 1) return "count < 1";
    if (sold.price === 0 && st.count > 1) return "house rule: only one of the free item";
    if (/Revive|Revival Herb|Sacred Ash/.test(st.item)) return "revives are useless in a Nuzlocke";
    return null; // the total is checked across all buy steps
  }
  const mon = input.party.find((m) => m.name === st.pokemon);
  if (!mon) return `no party member "${st.pokemon}"`;
  const moves = mon.moves.map((m) => m.name);
  // An item planned to be bought this round counts as in the bag.
  const inBag = (item: string) => input.bag.some((b) => b.item === item) || !!buying?.has(item) || !!freed?.has(item);
  switch (st.kind) {
    case "tm": {
      const opt = mon.tmOptions.find((o) => o.tm === st.tm);
      if (!opt) return `${mon.name} can't learn ${st.tm} (or already knows it, or it isn't in the bag)`;
      if (moves.length >= 4 && !moves.includes(st.replaces)) return `${mon.name} doesn't know "${st.replaces}"`;
      if (opt.category !== "Status" && moveAccuracy(opt.name) < 70)
        return `${opt.name} only hits ${moveAccuracy(opt.name)}% of the time; too unreliable for a Nuzlocke`;
      if (HM_MOVES.has(st.replaces)) return `${st.replaces} is an HM move and can't be forgotten`;
      const gone = mon.moves.find((m) => m.name === st.replaces);
      if (gone && gone.category !== "Status" && mon.types.includes(gone.type) && opt.type !== gone.type
        && !mon.moves.some((m) => m !== gone && m.category !== "Status" && m.type === gone.type))
        return `${st.replaces} is ${mon.name}'s only ${gone.type} STAB attack`;
      if (gone?.eff && opt.eff !== null && opt.eff < gone.eff * 0.9)
        return `${opt.name} (eff ${opt.eff}) is weaker than ${st.replaces} (eff ${gone.eff})`;
      const best = Math.max(0, ...mon.moves.map((m) => m.eff ?? 0));
      if (opt.eff === null ? !(opt.category === "Status" && "op" in opt && opt.op) : opt.eff < Math.max(45, best * (st.tm.startsWith("HM") ? 0.9 : 0.6)))
        return `${opt.name} (eff ${opt.eff ?? "status"}) isn't worth a slot (best attack eff ${best})`;
      return null;
    }
    case "give":
      if (!inBag(st.item) && !holder(st, input)) return `${st.item} isn't in the bag or held by another party member`;
      if ((heldBy(mon) ?? "") !== st.replaces) return `${mon.name} holds ${heldBy(mon) ?? "nothing"}, not "${st.replaces}"`;
      return null;
    case "take": return heldBy(mon) === st.item ? null : `${mon.name} isn't holding ${st.item}`;
    case "use": return inBag(st.item) ? (mon.level < input.levelCap ? null : `${mon.name} is at the cap`) : `${st.item} isn't in the bag`;
  }
}

/** Stable id for a step (used to remember skipped steps). */
export const stepId = (st: Step) => [st.kind, st.pokemon, st.tm || st.item, st.replaces].join("|"); // buy: count excluded

/** The step's line, built from its fields so it always says exactly what was checked. */
function text(st: Step, input: Input) {
  if (st.kind === "buy") {
    const price = input.shop!.stock.find((x) => x.item === st.item)!.price;
    return `Buy ${st.count}× ${st.item} (₽${price * st.count}${input.shop!.openNow ? "" : ", at the last Poké Mart"})`;
  }
  const mon = input.party.find((m) => m.name === st.pokemon)!;
  switch (st.kind) {
    case "tm": {
      const opt = mon.tmOptions.find((o) => o.tm === st.tm)!;
      return `Teach ${st.tm} (${opt.name}) to ${mon.name}${st.replaces ? `, forgetting ${st.replaces}` : ""}`;
    }
    case "give": {
      const from = st.from;
      return `${from ? `Move ${st.item} from ${from} to` : `Give ${st.item} to`} ${mon.name}${st.replaces ? ` (instead of ${st.replaces})` : ""}`;
    }
    case "take": return `Take ${st.item} off ${mon.name}`;
    case "use": return `Use ${st.item} on ${mon.name}`;
  }
}

export async function planBag(input: Input): Promise<BagPlan> {
  const t0 = performance.now();
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
    output_config: { format: { type: "json_schema", schema: SCHEMA }, effort: "high" },
    messages: [{ role: "user", content: JSON.stringify(input) }],
  }, { timeout: 120_000, maxRetries: 1 });
  if (response.stop_reason === "refusal") throw new Error("planner refused");
  const block = response.content.find((b) => b.type === "text");
  if (!block || block.type !== "text") throw new Error(`planner: no text (stop_reason=${response.stop_reason})`);
  const out = JSON.parse(block.text) as { steps: Step[] };
  const dropped: string[] = [], slots = new Set<string>();
  // Buys: drop the ones that don't fit the budget (in the model's order), then let later steps use what's bought.
  let budget = input.money;
  buying = new Set(); freed = new Set(); simHeld = new Map();
  for (const st of out.steps.filter((x) => x.kind === "buy")) {
    const price = input.shop?.stock.find((x) => x.item === st.item)?.price ?? Infinity;
    if (!check(st, input) && price * st.count <= budget) { budget -= price * st.count; buying.add(st.item); }
    else if (!check(st, input)) { st.count = 0; } // marks it over budget for the filter below
  }
  // A "take" for an item that a "give" step moves to someone else is part of that move.
  const moved = new Set(out.steps.filter((st) => st.kind === "give").map((st) => st.item));
  const steps = out.steps.filter((st) => !(st.kind === "take" && moved.has(st.item))).filter((st) => {
    const slot = `${st.pokemon}|${st.kind === "tm" ? st.replaces : "held"}`;
    const bad = check(st, input) ?? (st.kind === "buy" && st.count === 0 ? "over budget" : null)
      ?? (st.kind !== "buy" && slots.has(slot) ? "a second step for the same slot" : null);
    slots.add(slot);
    if (!bad && st.kind === "give")
      st.from = input.bag.some((b) => b.item === st.item) || buying!.has(st.item) || freed!.has(st.item) ? undefined : holder(st, input)?.name;
    if (!bad) apply(st, input);
    if (bad) dropped.push(`${st.kind} ${st.pokemon} ${st.tm || st.item} (${bad})`);
    return !bad;
  }).map((st) => ({ id: stepId(st), text: text(st, input), why: st.why }));
  const u = response.usage;
  return { steps, dropped, model: response.model, ms: Math.round(performance.now() - t0),
    usage: { in: u.input_tokens + (u.cache_creation_input_tokens ?? 0), out: u.output_tokens, cached: u.cache_read_input_tokens ?? 0 } };
}
