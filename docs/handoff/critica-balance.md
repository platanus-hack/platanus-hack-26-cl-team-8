KIT BALANCE REVIEW (read-only; nothing run, nothing playtested; all numbers hand-computed from 1.20.4 formulas)

VERDICT
The arithmetic is right; the win-rate matrix is not. Every after-armour cell, armour total, Feather Falling value and knob number checks out, and all RCON lines are valid 1.20.4. The "47-55%" matrix does not follow from the design's own numbers: bot melee is metronomic, so a 12-19% DPS edge decides a brawl, and three pairings are decided by the kit rather than the prompt.

CHECKED AND CORRECT
- Armour totals: 15/0, 12/0, 18/4, 14/0. All 20 damage cells recomputed and match.
- Weapons: swords 5/6/7 at 1.6/s; diamond axe 9 at 1.0/s; axe cooldown table by material.
- Bow: full charge 6 plus 0-4 crit, average 8; 1.45 s cycle. Power I average 11.5 (7.25 vs iron). Sharpness I axe 6.0 vs iron.
- Food: steak 8 hunger / 12.8 saturation = 8.5 HP; golden apple 4 absorption + 4 regeneration + up to 6.4 from saturation; 20 saturation = 13.3 HP at 2 HP/s.
- Pearl: 5 fall damage, 2.6 with Feather Falling IV.
- Speed I is applied once (+20%) through the attribute path in prismarine-physics. Not checked: whether the 1.20.4 attribute key matches mcData's (1.20.4 maps to the pc/1.17 attributes file); confirm in game that the bot actually moves faster.

(a) PAIRINGS WHERE ONE KIT WINS ALMOST ALWAYS

A1. Archer vs tank: archer wins or stalls; the design says tank 55%.
- Punch I adds 0.6 b/t on top of the 0.4 base, about 5 blocks in total per arrow, not "about 3". The victim is airborne about 0.65 s, so a sword rival lands at most one hit per 1.45 s shot cycle.
- Point-blank cycle vs tank: 3.09 dealt, 3.10 taken. With the design's own 3-arrow opening (9.3), the archer needs 8 cycles and the tank 11.
- With Speed I the archer is also uncatchable: a pure-pursuit chaser at 5.6 m/s against a 6.7 m/s runner on the r=10.5 perimeter settles 5.8 blocks behind, outside the 3.2 reach. The tank has no bow, speed or gap-closer, so only the archer's prompt matters.
- Fix: remove Speed I from the archer. Punch already gives it the peel.
- Knob if the archer still wins over 60% against tank or ender: chainmail chestplate to leather chestplate (armour 10; stone sword 3.5, diamond sword 5.18 per hit).

A2. Archer vs ender: archer, not "ender 52%".
- Cycle: 5.44 dealt, 4.62 taken. Ender arrives 2.6 (pearl) to 8 (pearl plus one arrow) down, so the archer needs about 5 cycles and ender 7.2.
- Ender is the worst kit in the design's own numbers: classic -2% melee and -8% per pearl, tank -19%, berserker -3%. It has no favourable pairing.
- Fix: ender armour to chain helmet, iron chestplate, iron leggings, chain boots with Feather Falling IV (14 points). Then classic takes 5.40 and deals 4.80; tank 3.86 vs 3.73 (tank +3.5%); berserker 5.31 vs 5.80 (ender +9%); arrows 4.80.

A3. Builder vs classic: builder, not 50%.
- Three apples are up to 43.2 HP, edible from second 0. Four steaks are 34 HP and gated (see C2).
- An apple eaten under iron-sword fire nets +6.4 (14.4 minus 1.8 s at 4.46 DPS); a steak nets +0.5.
- The text "slower-but-larger steak healing" is backwards: a steak is 8.5, an apple 8 to 14.4.
- Fix: `golden_apple 2` (28.8 maximum, 16 guaranteed).

A4. Tank vs berserker (+12.5%) and classic vs berserker (melee +3.5% for berserker, minus one 4.8 arrow, so classic by about 10%).
- Berserker is slightly negative everywhere except against the archer. This is inside playtest noise, so I left it unchanged.
- First knob: Sharpness I on the axe (10 damage; 4.13 vs tank = 3.94 DPS against 3.86 taken; 6.0 vs iron). Warning: it makes berserker vs archer about +23% (7.2 per hit).

A5. Any archer prompt that melees loses every time. Its stone sword deals 3.57 DPS against 5.49 from classic, 6.0 from berserker and 6.6 from ender. This is intended, but the web description should say so.

(b) TIMEOUTS AND DRAWS

B1. Speed I runners. Archer (fixed by A1) and berserker can take a lead and hold `retreat` for the rest of the 180 s; only bow kits can punish it.

B2. Draws by regeneration. Both fighters heal back to 20/20 at 2 HP/s whenever they disengage, and `decideTimeoutResult` (apps/orchestrator/src/result.ts:19-24) returns a draw when health is equal.
- Fix: sudden death at 120 s. Send `gamerule naturalRegeneration false` and `effect clear <P> minecraft:speed` for both sides, and set the gamerule back to true in `prepareFighter`.
- Do not tie-break on `damageDealt` alone: it rewards hit-once-and-run, and absorbed apple hits are not credited.

B3. `eat` with a full food bar calls `enterWait` (packages/agent/src/fighter.ts:589-591), so the bot stands still while being hit. Steak kits fall into this in the opening seconds. Fix: a failed `eat` or `shoot` should keep the current mode, as the design already specifies for `pearl` and `build`.

B4. Tank mirror: 27 s of contact with all steaks, about 78 s real at 35% contact. It stays under 180 s only if both prompts fight. Knob: 3 steaks for the tank.

B5. Tower stall: the eye-to-hitbox reach and `GoalNearXZ` changes are mandatory if the tower ships. Vanilla accepts attacks up to 6 blocks from eye to hitbox with no line-of-sight check, so the 3.0 reach is legitimate.

(c) WRONG OR INCONSISTENT NUMBERS

C1. "33.3 effective life" overstates short fights. Regeneration is capped at 2 HP/s, so for incoming DPS above 5 the time to kill is 20/(DPS-2).

| Cell | Design | Corrected |
|---|---|---|
| ender vs archer | 5.0 s | 4.35 s |
| berserker vs archer or ender | 5.6 s | 5.0 s |
| classic vs archer | 6.1 s | 5.7 s |
| ender vs classic | 6.2 s | 5.9 s |

C2. "4 steaks, 34" is mostly unreachable.
- Food stays at 20 until the 20 saturation is burnt, which takes about 13 HP of regeneration. Under a continuous iron sword that is t≈6.7 s with 3.6 HP left, and death comes at 7.5 s.
- Eating takes 1.8 s in the bot. Net per steak under fire: iron sword +0.5, diamond sword on chain -3.4, axe on iron -0.4. Only the tank profits (+2.9 vs iron sword, +4.1 in the mirror).
- Only kits that can disengage (Speed, pearl, wall) can cash their steaks.

C3. "The bot never crits" is not safe.
- mineflayer sends the sprint packet only when the control state changes (scratchpad mf/physics.js:247-261), and the server clears its sprint flag after a sprint-knockback hit.
- After that, any swing made while falling from knockback meets the vanilla crit conditions (x1.5): iron sword 5.22 vs iron instead of 3.12, axe 9.05 instead of 5.22, stone sword 2.85 vs tank instead of 1.73.
- Fights may run 20-40% shorter, and big hits gain slightly more. Measure it.

C4. The 0.7 s sword period assumes continuous contact. Mutual knockback of about 1.9 blocks each from a 2-block follow range puts the fighters about 5.8 apart, beyond the 3.2 reach, after each exchange. If the real sword interval is 0.8 s or more, the axe gains about 12% in relative terms and the berserker needs no buff. Measure hit intervals before using the Sharpness knob.

C5. Archer identity. Its arrows deal the same damage as classic's, and classic out-trades it in a bow duel (5.44 vs 4.48 per arrow). Its own sword out-DPSes its bow (3.57 vs 3.09 against iron). All its ranged strength is Punch plus ammunition; say that in the description instead of "Fuerte de lejos".

C6. Absorption does not stack; a second apple only refreshes it. It is also outside `bot.health`, so the scoreboard and the timeout rule ignore it. The `eat` description should say "no comas otra mientras tengas corazones amarillos".

C7. Axe cooldown of 1000 ms is exactly 20 ticks. One tick of jitter gives strength 0.975 and damage x0.96. Use 1050 ms.

(d) RCON SYNTAX (1.20.4)

No syntax errors found.
- `item replace entity <P> <slot> with minecraft:item{Enchantments:[{id:"minecraft:punch",lvl:1s}]} N`: valid NBT form; it breaks on 1.20.5+, where items use components.
- `effect give <P> minecraft:speed infinite 0 true`: valid since 1.19.4.
- Slot names, the generator's `item{nbt} count` order, the barrier fill (729 blocks) and the plank cleanup with `replace` (8,748 blocks) are valid.

Notes:
- The barrier lid is unnecessary. A pearl at +6° rises about 0.4 block above the hand, and a fighter on a 3-block tower with 0.5 b/t of upward knockback peaks about 4.7 above the floor; the wall is 6. The camera at y=78 looks through the lid, and I could not check how viewer mode (prismarine-viewer) draws barriers, because node_modules is not installed here. Drop the lid or test it in viewer mode.
- Narrow `inventory.${number}` in `KitSlot` to 0-26.
- If the Sharpness knob is used: `minecraft:diamond_axe{Enchantments:[{id:"minecraft:sharpness",lvl:1s}]}`, and add `sharpness: "Filo"` to `ENCHANTMENT_LABELS`.

(e) ITEMS NO TOOL CAN USE

None strictly; every given item maps to an offered tool. Functional dead weight:
- Steaks for classic and tank (C2).
- Missed arrows stuck in the floor can be picked up by anyone. Tank, berserker and ender collect arrows they cannot fire, which land in hotbar.1 and break the web grid match. The builder's 8-arrow limit and the archer's 32 are soft. Optional: `kill @e[type=minecraft:arrow,nbt={inGround:1b}]` every few seconds.
- Builder: 16 planks are 2 walls, 1 tower and 1 spare; fine.

CORRECTED KIT TABLE (bold = changed)

| Kit | Armour (points/toughness) | hotbar.0 | hotbar.1 | hotbar.2 | hotbar.3 | hotbar.8 | Effect |
|---|---|---|---|---|---|---|---|
| classic | iron x4 (15/0) | iron_sword | bow | cooked_beef 4 | - | arrow 16 | - |
| archer | chainmail x4 (12/0) | stone_sword | bow, Punch I | cooked_beef 4 | - | arrow 32 | **none (Speed I removed)** |
| tank | iron helmet, diamond chestplate, diamond leggings, iron boots (18/4) | stone_sword | - | cooked_beef 4 | - | - | - |
| berserker | chain helmet, iron chestplate, iron leggings, chain boots (14/0) | diamond_axe | - | cooked_beef 4 | - | - | Speed I |
| ender | chain helmet, **iron chestplate, iron leggings**, chain boots Feather Falling IV (**14/0**) | diamond_sword | ender_pearl 4 | cooked_beef 4 | - | - | - |
| builder | iron x4 (15/0) | iron_sword | bow | **golden_apple 2** | oak_planks 16 | arrow 8 | - |

Changed commands:
- archer: delete the `effect give <P> minecraft:speed infinite 0 true` line.
- ender: `item replace entity <P> armor.chest with minecraft:iron_chestplate` and `item replace entity <P> armor.legs with minecraft:iron_leggings`.
- builder: `item replace entity <P> hotbar.2 with minecraft:golden_apple 2`.

Damage per hit after the fix (DPS in parentheses; swords /0.7 s, axe /1.05 s):

| Attacker | vs classic, builder (15) | vs archer (12) | vs tank (18/4) | vs berserker, ender (14) |
|---|---|---|---|---|
| iron sword | 3.12 (4.46) | 3.84 (5.49) | 2.16 (3.09) | 3.36 (4.80) |
| stone sword | 2.50 (3.57) | 3.10 (4.43) | 1.73 (2.47) | 2.70 (3.86) |
| diamond axe 9 | 5.22 (4.97) | 6.30 (6.00) | 3.60 (3.43) | 5.58 (5.31) |
| diamond sword | 3.78 (5.40) | 4.62 (6.60) | 2.61 (3.73) | 4.06 (5.80) |
| arrow, average 8 | 4.48 | 5.44 | 3.09 | 4.80 |

Lopsided pairings that remain: archer over tank and archer over ender through the point-blank Punch peel (about +20-35% if the one-hit-per-cycle model holds), and berserker roughly even with the archer. Everything else is within ±16% in melee, with the bow kits' opening arrows as the compensator.

Measure in the first playtests: sword hits landed per archer shot cycle, real sword hit interval in mutual trades, crit frequency, and arrow hit rate at 8-16 blocks.

Files read: /home/storrealbac/Desktop/phack2026/apps/orchestrator/src/arena.ts, /home/storrealbac/Desktop/phack2026/apps/orchestrator/src/match.ts, /home/storrealbac/Desktop/phack2026/apps/orchestrator/src/result.ts, /home/storrealbac/Desktop/phack2026/packages/agent/src/fighter.ts, /home/storrealbac/Desktop/phack2026/packages/agent/src/geometry.ts, /home/storrealbac/Desktop/phack2026/packages/protocol/src/index.ts, /home/storrealbac/Desktop/phack2026/.env.example, and the saved mineflayer, pathfinder and prismarine-physics sources under /tmp/claude-1000/-home-storrealbac-Desktop-phack2026/fc07f805-ff91-4795-be1c-1ba1d1aeda0d/scratchpad/mf.