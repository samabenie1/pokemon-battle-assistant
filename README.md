# Pokémon Battle Assistant (Sword/Shield on Eden)

A live battle advisor for **Pokémon Sword/Shield** running in the **[Eden](https://eden-emu.dev) Switch emulator on Linux**.
It reads the battle straight from the emulator's memory and shows a page (meant for a second monitor) with:

- **The recommended action** for this turn, with a one-line reason (from Claude)
- **Your moves ranked** by damage, KO chance and PP (from [`@smogon/calc`](https://github.com/smogon/damage-calc), Gen 8 rules)
- **The enemy's moves** and how hard each one hits you
- **Switch options**: how much each bench Pokémon takes and deals back
- **Catch chance** per throw for every ball in your bag, including the Gen 8 level penalty
- **Swap suggestions** only when a bench Pokémon actually wins the matchup (switching costs a turn), including
  a **stay-or-swap** call between an opponent's Pokémon, when switching is free
- **Wild, trainer and double battles** (incl. two-trainer doubles): opponents' full teams, live HP, PP, stat boosts,
  confusion, and who's on the field for every battle position; per-Pokémon targets in doubles, with friendly-fire warnings
- **Run away** option in wild battles (escape odds, or a Poké Doll when running might fail)
- **Dynamax** in gym battles: detection, Max Move damage, and when to use your one Dynamax
- **Healing and status cures** from your bag, and top-up suggestions between battles
- **Safety checks** on every AI recommendation (setup moves, stat boosts, KO risk incl. crits), with a
  calculator fallback when the AI is slow or wrong
- **Learns from real hits**: if your attacks do less than predicted (a hidden ability, Intimidate…), later numbers are scaled
- **Bag tips** between battles: which held items to give whom, candies for your lowest levels, TM/TR upgrades
- **Cheap to run**: obvious turns (a sure KO, a safe winning matchup) use the calculator's pick without an AI call
- Optional **training mode**: levels the team evenly toward a target level (shows who should take the EXP)
- Optional **Nuzlocke mode**: strict priority of no faints, then winning, then EXP

It works with randomized saves: abilities and movesets are read from memory, not assumed.

It doesn't pause the game and needs no debugger, root or mods. It reads Eden's guest RAM through `/proc/<pid>/fd`.

## Requirements

- Linux, with Eden running Pokémon Sword or Shield **v1.3.2** (memory offsets are version-specific)
- Node.js 22+ and a C compiler (`cc`)
- An [Anthropic API key](https://console.anthropic.com). At roughly $0.002 per turn with Claude Haiku 4.5, an hour of play costs cents.

You need your own legally dumped copy of the game. This project contains no game data.

## Setup

```sh
git clone <this repo> && cd pokemon-battle-assistant
npm install
npm run setup          # downloads Pokémon data, compiles the memory scanners
cp .env.example .env   # then put your ANTHROPIC_API_KEY in .env
npm start              # open http://localhost:7878
```

`npm run demo` shows a sample battle without the emulator.

## How it works

| What | Where it comes from |
|---|---|
| Your party (species, stats, moves, ability, item) | Save-block party, decrypted PK8 structures (crypto ported from [PKHeX](https://github.com/kwsch/PKHeX)) |
| Wild opponent (exact species, level, ability, moves, IVs/EVs) | Wild-encounter slot ([SysBot.NET](https://github.com/kwsch/SysBot.NET) offset) |
| Your team's live HP | Per-slot in-battle status records (fixed offset, one per party slot) |
| Which move you just used | PP drops in the in-battle party copy |
| Opponent team (wild or trainer), live HP, PP, stat stages | Its in-battle blocks, which start at the SysBot wild slot |
| Who's on the field (both sides) | "On-field" records (species + encryption constant), found per battle; stale copies are filtered out |
| Turn timing | A battle step counter; advice is requested when it stops changing (the game is waiting for input) |
| Bag (Poké Balls) | Save-block ball pouch |

The address of the in-battle data shifts every time the game boots, so the reader recalibrates on every poll.
See [docs/RESEARCH.md](docs/RESEARCH.md) for the memory layout notes and how each piece was found.

## Limitations

- Live sleep/paralysis/burn/poison and field effects (screens, terrain, weather) aren't decoded yet (confusion is);
  major status comes from the saved data (correct at battle start and after a switch-out).
- TM/TR compatibility can't be known in randomized saves, so TM tips say "if it can learn it".
- Enemy abilities are hidden until you've caught that species or listed it in `data/revealed.json`
  (`{"<species number>": "<ability>"}`), so the numbers don't give away information you wouldn't have.
- Singles only (no doubles or Max Raids), Sword/Shield v1.3.2 only, and tested on one Linux machine.
- Catch odds ignore critical captures (slightly conservative) and don't know if you've caught the species before (Repeat Ball).

Contributions welcome, especially live status conditions and double battles.

## Configuration

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | in `.env` |
| `PBA_MODEL` | `claude-haiku-4-5` | any Claude model; `claude-sonnet-5` gives noticeably better advice (~1–2¢/turn) |
| `PBA_TARGET_LEVEL` | off | training mode: level the team evenly toward this level |
| `PBA_NUZLOCKE` | off | `1` = never accept KO risk when a safe option exists |
| `PBA_PORT` | `7878` | |
| `PBA_SOURCE` | live | `demo` for the sample battle |

## Per-save notes (optional files in `data/`, all ignored by git)

| File | Purpose |
|---|---|
| `revealed.json` | `{"<species number>": "<ability>"}`: enemy abilities you've seen revealed |
| `ignored-items.json` | item ids to never suggest (e.g. if the bag data disagrees with what you have) |
| `not-able.json`, `tms-checked.json` | TMs a Pokémon can't learn / TMs you've already tried (randomized compatibility) |
| `dead.json` | Nuzlocke deaths, for your own records |

## Credits

Damage calc: [@smogon/calc](https://github.com/smogon/damage-calc). Dex data: [Pokémon Showdown](https://github.com/smogon/pokemon-showdown).
Growth and catch rates: [PokeAPI](https://pokeapi.co). PK8 format: [PKHeX](https://github.com/kwsch/PKHeX). RAM offsets: [SysBot.NET](https://github.com/kwsch/SysBot.NET).
Capture formula: [The Cave of Dragonflies](https://www.dragonflycave.com/mechanics/gen-viii-capturing/).

Pokémon is © Nintendo / Creatures / GAME FREAK. This is an unofficial fan project, not affiliated with or endorsed by them.
