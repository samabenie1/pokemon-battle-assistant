# Changelog

Notable changes, newest first. Dates are when the change landed on `main`.

## 2026-10-06

### Added
- **Black 2 rotation battles.** The reader detects rotation (battle-type flag 3) and reads the 3 Pokémon on the
  field per side, front first. Their bench is never read. The page shows one calculator pick: which Pokémon to
  rotate to the front and which move to use, judged against every foe on the field, since they can rotate too.
  A move counts as unsafe if any of those foes can KO you with a max-roll crit, unless you're faster and surely KO
  it first. Recoil KOs count too. Slaking-style Truant gets a "rotate it out next turn" note.
- **Foe ability inference.** A hidden foe ability is marked revealed when it visibly acts (entry announcers, absorbs
  and immunities, damage well below the prediction). The page also has an "I saw its ability" button. Both save to
  `data/revealed.json` and redo the advice.
- `src/tools/b2-triple-peek.ts`: dumps the battler slots for triple/rotation debugging.

### Changed
- Advice never recommends catching or throwing a ball. The doubles prompt has no catch mode, and any ball throw
  the AI names is replaced with the calculator's pick. The catch-odds panel still shows the numbers.
- Stall, Lagging Tail and Full Incense count as always moving last.

### Fixed
- **Trapping abilities.** Arena Trap (grounded targets), Shadow Tag and Magnet Pull (Steel targets) now block
  switching and running once the foe's ability is known. Before, the advice still said "switch to COOKIE" while
  Deoxys was stuck against an Arena Trap Jolteon.
- **No more switch ping-pong.** A Pokémon that already switched out against the current foe isn't sent back in if
  another switch-in wins safely (the advice had gone Slaking → Gigalith → Slaking).
- **"Free" switches have to really be free.** A foe that can't hurt the Pokémon currently out (Ghost moves vs
  Slaking) must also do 0% to the switch-in and have no status move. Before, the advice sent Gigalith into a
  Dusknoir that burned it with Will-O-Wisp and then hit it with a doubled Hex.
- **Status threats are counted.** Will-O-Wisp, Toxic, paralysis and sleep moves, Leech Seed and a Ghost's Curse
  are listed for the AI, and Hex is scored as if the switch-in already has a status.
- **No EXP-only switches.** A Pokémon that's winning safely isn't switched out just to spread EXP, because the
  switch-in takes a free hit. EXP only decides who comes in when a switch is needed anyway.
- Wild partner battles (an AI ally beside you in the grass): both wild Pokémon are read. Before, only the first one
  was, which put the page in catch mode with one foe still unaccounted for. The partner's Pokémon have a blank OT
  in RAM and are no longer mistaken for leftovers.
- The page could get stuck on "Waiting for a battle…" mid-battle if a single poll blipped while the AI was
  answering. Leaving the battle view now resets the turn key, and the blip is logged as `[status]`.

## 2026-10-05
- B2 TM/HM compatibility: fixed bit order and use of alternate formes.
- Re-advise on stat changes; a "sure KO" now respects enemy priority moves.

## 2026-10-02
- B2 partner (multi) battles: read the AI ally and both foe trainers.
- Account for move accuracy, ignore 0-PP moves (Struggle when none are left), and account for recoil.
- Switch prompt always answers Stay or Switch.
- B2 bag planner, shop planning, status/sleep fixes, HM protection.

## 2026-10-01
- B2: status awareness (sleep/freeze advice, party status warnings), held-item tips, TM/HM tips from the live bag
  with randomized TM moves and ROM compatibility, ROM catch rates, battler dump for ally battles.
- B2: reject losing switch-ins; no level cap in gym/Elite Four fights.

## 2026-09-30
- Black 2 support (melonDS), level-up move advice, Sword/Shield fixes.

## 2026-09-25
- First release: live battle assistant for Pokémon Sword/Shield in Eden, then trainer battles, Dynamax, safety
  checks, damage learning, double battles, confusion, the run option, bag tips, and a stronger model
  (`PBA_BOSS_MODEL`) for gym leader and Champion battles.
