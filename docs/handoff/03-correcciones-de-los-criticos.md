# Amendments to SPEC.md (from the balance and feasibility critiques)

Full critiques, with code sketches and source references:
- `docs/handoff/critica-balance.md`
- `docs/handoff/critica-factibilidad.md`

Apply every item below unless the code already does it. Where an amendment contradicts SPEC.md or the design, the amendment wins.

## Kit data (packages/protocol/src/index.ts, plus every test, doc and maqueta text that repeats it)
1. archer: remove the Speed I effect (Punch I already gives it the peel). Description without "Velocidad I";
   say its strength is the knockback of its arrows and the ammunition, and that it is weak in melee.
2. ender: armour = chainmail helmet, iron chestplate, iron leggings, chainmail boots with Feather Falling IV. Update the description.
3. builder: 2 golden apples instead of 3. Update the description.
4. `KitSlot`: the `inventory.N` part only accepts 0 to 26.

## Bot (packages/agent)
5. Speed I does nothing today: mineflayer stores attributes under `prop.key`, but on 1.20.4 the packet field is `name`,
   so prismarine-physics never sees the speed modifier. Add the `entity_update_attributes` listener from the feasibility
   critique (finding 1) in `attachListeners` so the berserker really moves faster.
6. Weapon cooldown table with one server tick of margin: sword 650 ms, diamond/golden/netherite axe 1050, iron axe 1150,
   stone/wooden axe 1300, empty hand 300. Reset `lastAttackAt` only when the held item NAME changes
   (`heldItemChanged` also fires on every durability update).
7. pearl:
   - Aim with the existing `computeAim` (arrowSpeed 30, gravity 12) instead of a bisect; if a separate `pearlPitch`
     function already exists and is tested and correct, it may stay.
   - Send the look as `bot.look(yaw + 0.01, pitch, true)` then `bot.look(yaw, pitch, true)`, and throw only after at
     least one `physicsTick` has passed since the look (a tick counter), not on a fixed 150 ms timer alone.
   - The `forcedMove` handler is global but only counts as the pearl landing when a pearl was thrown less than 2 s ago
     and the bot moved more than 2 blocks; it always resets the path goal.
   - Report the distance to the rival measured AFTER landing.
   - target "away": when it lands, go to `eat` if food is below 20 and there is food; otherwise wait.
   - In `trackOpponent`, ignore (zero) any opponent velocity sample above 15 blocks/s (a teleport is not a velocity).
   - Landing target clamped to radius `ARENA.radius - 1.5` from the centre.
8. build (wall): centre of the wall 3 blocks ahead of the bot (not 2), precondition rival distance >= 4.5 and own feet on
   the arena floor; count placed blocks by reading the world (`bot.blockAt(cell)?.name`), not by resolved promises;
   the busy flag is cleared in a `finally` and in `resetBody`; a generation counter aborts the chain when the mode changes.
9. A failed `eat` (food bar full and no golden apple, or nothing to eat) or `shoot` (no bow or no arrows) must NOT drop
   the bot into `wait`: it returns the failure text and keeps the current mode, like `pearl` and `build` preconditions.
   Keep the existing result texts recognisable; update tests that asserted the old behaviour.
10. `eat` description: mention that a golden apple gives yellow hearts that do not stack ("no comas otra mientras
    tengas corazones amarillos").

## Orchestrator (apps/orchestrator)
11. The barrier lid is mandatory: the arena floats about 125 blocks above the ground of a flat world.
12. `prepareFighter` checks the RCON reply of each kit command and logs a warning (through whatever logging the caller
    already has; a thrown error is too strong) when it does not look like success (`/Replaced a slot|Applied effect/i`).
    Keep `prepareFighter`'s signature compatible with its callers and tests.

## Web (apps/web)
13. Kit descriptions and the maqueta data follow items 1 to 3. Nothing else.

## Docs
14. README kit table follows items 1 to 3.
