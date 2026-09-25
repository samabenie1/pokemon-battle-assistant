# Pokémon Battle Assistant (Sword/Shield on Eden)

A live battle advisor for **Pokémon Sword/Shield** running in the **[Eden](https://eden-emu.dev) Switch emulator on Linux**.
It reads the battle straight from the emulator's memory and shows a page (meant for a second monitor) with:

- **The recommended action** for this turn, with a one-line reason (from Claude)
- **Your moves ranked** by damage, KO chance and PP (from [`@smogon/calc`](https://github.com/smogon/damage-calc), Gen 8 rules)
- **The enemy's moves** and how hard each one hits you
- **Switch options**: how much each bench Pokémon takes and deals back
- **Catch chance** per throw for every ball in your bag, including the Gen 8 level penalty
- **Swap suggestions** when a bench Pokémon has a clearly better matchup
- Optional **training mode**: levels the team evenly toward a target level (shows who should take the EXP)
- Optional **Nuzlocke mode**: safety-first advice with a KO-risk warning (max roll and crit)

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
| Wild enemy's live HP | Its in-battle status record (same layout as the player's). Falls back to an estimate from your moves' average damage |
| Your Pokémon on the field | A fixed "on field" record holding its species and encryption constant |
| Turn timing | A battle step counter; advice is requested when it stops changing (the game is waiting for input) |
| Bag (Poké Balls) | Save-block ball pouch |

The address of the in-battle data shifts every time the game boots, so the reader recalibrates on every poll.
See [docs/RESEARCH.md](docs/RESEARCH.md) for the memory layout notes and how each piece was found.

## Limitations

- Trainer battles assume the trainer sends Pokémon out in order (true for in-game trainers).
- Status conditions aren't read live yet.
- Singles only (no doubles or Max Raids), Sword/Shield v1.3.2 only, and tested on one Linux machine.
- Catch odds ignore critical captures (slightly conservative) and don't know if you've caught the species before (Repeat Ball).

Contributions welcome, especially live status conditions and double battles.

## Configuration

| Variable | Default | |
|---|---|---|
| `ANTHROPIC_API_KEY` | (required) | in `.env` |
| `PBA_MODEL` | `claude-haiku-4-5` | any Claude model, e.g. `claude-sonnet-5` for stronger advice |
| `PBA_TARGET_LEVEL` | off | training mode: level the team evenly toward this level |
| `PBA_NUZLOCKE` | off | `1` = never accept KO risk when a safe option exists |
| `PBA_PORT` | `7878` | |
| `PBA_SOURCE` | live | `demo` for the sample battle |

## Credits

Damage calc: [@smogon/calc](https://github.com/smogon/damage-calc). Dex data: [Pokémon Showdown](https://github.com/smogon/pokemon-showdown).
Growth and catch rates: [PokeAPI](https://pokeapi.co). PK8 format: [PKHeX](https://github.com/kwsch/PKHeX). RAM offsets: [SysBot.NET](https://github.com/kwsch/SysBot.NET).
Capture formula: [The Cave of Dragonflies](https://www.dragonflycave.com/mechanics/gen-viii-capturing/).

Pokémon is © Nintendo / Creatures / GAME FREAK. This is an unofficial fan project, not affiliated with or endorsed by them.
