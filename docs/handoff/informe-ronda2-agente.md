## Area X2 (packages/agent + mock LLM): amendments 5 to 10 written, NOT compiled or run

Nothing was typechecked or tested (hard rules); I re-read every diff by hand. All paths are under `/home/storrealbac/Desktop/phack2026-kits/`.

### 1. Files
Created: none. Deleted: none. No dependency changes.

Changed:
- `packages/agent/src/`: `fighter.ts`, `tools.ts`, `prompt.ts`, `observation.ts`, `items.ts`, `geometry.ts`, `aim.ts`
- `packages/agent/src/` tests: `tools.test.ts`, `prompt.test.ts`, `observation.test.ts`, `items.test.ts`, `geometry.test.ts`, `aim.test.ts`
- `packages/llm/src/mock.ts`, `packages/llm/src/mock.test.ts`

`index.ts` and `types.ts` are untouched, so the public contract of `@phack/agent` (`createFighter`, `FighterOptions.kit`, `onDamageTaken(amount, health, bySelf)`, `TOOL_NAMES`, `kitToolNames`, `kitToolDefs`) is unchanged.

### 2. Behaviour and names other areas depend on

**Item 5, Speed I**
- `attachListeners` now listens to `bot._client.on("entity_update_attributes", ...)` and stores the bot's own attributes under `key ?? name`, as `{ value, modifiers }`.
- It only stores attributes for the bot's own entity, not for every entity as in the critique sketch.

**Item 6, weapon cooldowns** (`attackCooldownMs` in `items.ts`)
- sword 650, diamond/golden/netherite axe 1050, iron axe 1150, stone/wooden axe 1300, empty hand or non-weapon 300.
- `lastAttackAt` was already reset only when the held item name changes; no change needed.
- The system prompt now says "da un golpe cada ~0.7 s" for swords and "~1.1 s" for the diamond axe.

**Item 7, pearl**
- `pearlPitch` stays (I hand-checked the −20° reference value against the tick simulation); `computeAim` is not used for the pearl.
- The look is sent as `bot.look(yaw + 0.01, pitch, true)` then `bot.look(yaw, pitch, true)`. The throw happens only after a `physicsTick` counter has advanced; the 150 ms timer is gone. If no tick arrives in 1 s the result is `no pudiste lanzar la perla` and the bot waits.
- `forcedMove` always clears the path goal. It counts as the pearl landing only if a pearl was thrown less than 2 s ago and the bot moved more than 2 blocks since the last physics tick.
- Target "away": on landing the bot switches to `eat` when the kit has `eat`, food is below 20 and it holds food; otherwise it waits. The result text becomes `te teletransportaste lejos del rival (distancia N); te quedan K perlas; comiendo (tarda unos 2 segundos)`.
- The reported distance is measured on the body tick after the teleport.
- `estimateVelocity` zeroes samples above 15 blocks/s (exported `MAX_TRACKED_SPEED = 15`, was 20).
- The landing clamp was already `ARENA.radius - 1.5`.

**Item 8, wall**
- `WALL_GAP = 3` (exported from `geometry.ts`): the wall centre is 3 blocks ahead.
- New export `BUILD_MIN_DISTANCE = 4.5` in `tools.ts`.
- New refusals, which keep the current mode:
  - `el rival está a N bloques: muy cerca para levantar un muro (mínimo 4.5)`
  - `no puedes construir desde arriba de un bloque: baja al piso de la arena`
- If the bot is airborne from a jump or knockback, the call is accepted and the body waits up to 1 s to land. After that: `no pudiste construir: no estás parado en el piso de la arena`, and the bot waits.
- Placed blocks are counted with `bot.blockAt(cell)?.name` over the attempted cells.
- `buildBusy` is cleared in `finally` and in `resetBody`. A chain number makes sure a stale chain cannot release a newer one. The generation counter still aborts the chain on a mode change.

**Item 9, failed `eat` and `shoot`**
- They no longer enter `wait`. The result is the old text plus `; sigues con "<modo>"`, for example `no puedes comer: no tienes hambre (comida 20/20); sigues con "attack"`.
- New pure exports in `tools.ts`:
  - `shootRefusal(itemNames): string | null`
  - `eatRefusal(itemNames, food, isFood?): string | null`
  - `refusalText(reason, mode): string`
- Failures in the middle of a mode still go to `wait` (arrows run out while shooting, food disappears before the bite).

**Item 10 and tool descriptions**
- `eat`: "...manzana dorada (siempre; da regeneración y 4 de vida extra en corazones amarillos, que no se acumulan: no comas otra mientras tengas corazones amarillos)..."
- `pearl`: the "away" part now says the bot starts eating at once if it has food and the food bar is not full.
- `build`: the spec text is kept, with one sentence appended: "Solo funciona con el rival a 4.5 bloques o más y contigo parado en el piso de la arena."
- The "TU KIT" lines for golden apple, pearl and build say the same.

**Addition beyond the amendments: `absorption`**
- `Observation.absorption?: number` (yellow hearts, one decimal) appears only while above 0. It is read from player metadata index 15.
- I added it because the LLM cannot otherwise see yellow hearts, so the item 10 instruction could not be followed.
- `docs/ARQUITECTURA.md` (X1) lists only `pearlCooldown` and `buildCooldown` as optional observation fields; it needs `absorption` added.

**Mock LLM**
- `MockObservation.absorption: number` is a new required field (0 when absent). No other package uses this type.
- In the kit rules, a golden apple counts as edible only when `absorption === 0`, so the mock builder no longer eats its second apple right after the first.
- The base policy and `MOCK_TOOL_NAMES` are unchanged.

**Tests**
- They use the amended kit data: archer has no "Efectos permanentes" line, the Speed I assertion moved to berserker, and the builder apple count comes from `kitItemTitle`, not a literal.
- `prompt.test.ts` now fails if `packages/protocol` loses amendments 1 or 3. They are present in the working copy now.

### 3. Unsure or not finished
- **Not run in game.** Pearl aim timing, wall placement at 3 blocks and the speed fix are unverified against a 1.20.4 server.
- **Speed I depends on the attribute name.** The fix works only if the server sends `minecraft:generic.movement_speed`, which is the name prismarine-physics looks up. I believe it does on 1.20.4; confirm that the berserker actually walks faster.
- **API details I could not compile against:**
  - `bot._client.on(...)` with a handler typed `(packet: unknown) => void`.
  - The `physicsTick` event name (present in the saved mineflayer 4.39 `index.d.ts`).
  - `bot.entity.onGround`.
  - Metadata index 15 for absorption (confirmed in the saved minecraft-data `entities.json` as `player_absorption`).
- **Pearl that moves the bot 2 blocks or less** (for example it hits a plank wall right in front) is not counted as a landing. The mode ends after 1.5 s with `lanzaste la perla pero no te teletransportaste`, and its fall damage is credited to the rival.
- **Self-damage window** is still the 600 ms rule; the `entityHurt` alternative from the critique is not in the amendment list.
- **Wall count can be one short.** If the last block is confirmed more than 700 ms late, it is missed, because the world is read right after the loop.
- **"away" to eat follows the amendment literally** (food below 20 and any food). A kit with pearls and golden apples, which does not exist today, would not auto-eat at a full food bar.
- **Web maqueta (X3).** If it scripts result texts for a failed `eat` or `shoot`, they now end with `; sigues con "<modo>"`. I found no such text outside my area.
- I ran one empty `python3` heredoc by mistake; it executed nothing and touched no file.