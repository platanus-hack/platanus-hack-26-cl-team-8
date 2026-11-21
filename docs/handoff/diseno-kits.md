KIT SYSTEM DESIGN (read-only; nothing in the repo was changed, nothing was run)

All balance numbers are computed from the 1.20.4 damage formulas; win rates and real fight durations are estimates and were not playtested.

DESIGN SUMMARY
- 6 kits, 2 new tools (`pearl`, `build`). Four kits need no new tool at all.
- Shield, cobweb, buckets, splash and drinkable potions are left out. Shields stalemate unless every other kit has an axe counter; buckets are rated hard; potions add healing and draws.
- Kit identity comes from armour tier, weapon, enchantments and a permanent `effect give` (Speed I), as in class KitPvP. Effects need no bot code: prismarine-physics reads the server speed attribute (scratchpad mf/physics/index.js:547-570).
- Healing is the same for every kit (4 steaks), except the builder (3 golden apples).
- Lightest armour is chainmail. Full leather takes 5.0 per iron-sword hit and 7.0 per arrow, which is too swingy.
- No Slowness on the tank: a slow melee-only bot cannot close on a retreating one and the fight goes to timeout. It pays with a stone sword and no bow instead.
- Hotbar convention for every kit: h0 melee weapon, h1 secondary (bow or pearls), h2 food, h3 blocks, h8 arrows. Everything is given with `item replace`, so equipping is always one `held_item_slot` packet and the web grid matches the game.

====================================================================
1. KITS
====================================================================
`<P>` = AgenteRojo / AgenteAzul. Commands run in `prepareFighter` after `clear`, `effect clear`, the tp and the instant_health/saturation lines (apps/orchestrator/src/arena.ts:143-157). Effects must come after `effect clear`.

Armour block used below (replace MAT per slot):
```
item replace entity <P> armor.head with minecraft:MAT_helmet
item replace entity <P> armor.chest with minecraft:MAT_chestplate
item replace entity <P> armor.legs with minecraft:MAT_leggings
item replace entity <P> armor.feet with minecraft:MAT_boots
```

### classic — "Clásico" (default)
- Description: "Armadura de hierro, espada, arco con 16 flechas y 4 filetes. El kit equilibrado de siempre."
- Style: all-rounder; same items as today (Hypixel Classic / MCCentral Iron).
- Armour: iron helmet, chestplate, leggings, boots (15 armour, toughness 0). Off hand: empty.
- Hotbar: h0 iron_sword, h1 bow, h2 cooked_beef x4, h8 arrow x16.
- Tools: approach, attack, retreat, shoot, eat, wait.
```
(armour block with iron)
item replace entity <P> hotbar.0 with minecraft:iron_sword
item replace entity <P> hotbar.1 with minecraft:bow
item replace entity <P> hotbar.2 with minecraft:cooked_beef 4
item replace entity <P> hotbar.8 with minecraft:arrow 16
```

### archer — "Arquero"
- Description: "Armadura de malla, arco con Empuje I y 32 flechas, espada de piedra y Velocidad I. Fuerte de lejos, débil cuerpo a cuerpo."
- Style: ranged kiter. Punch knocks the rival back about 3 blocks per hit; Speed I re-opens the range.
- Armour: full chainmail (12 armour).
- Hotbar: h0 stone_sword, h1 bow (Punch I), h2 cooked_beef x4, h8 arrow x32. Effect: Speed I.
- Tools: approach, attack, retreat, shoot, eat, wait.
```
(armour block with chainmail)
item replace entity <P> hotbar.0 with minecraft:stone_sword
item replace entity <P> hotbar.1 with minecraft:bow{Enchantments:[{id:"minecraft:punch",lvl:1s}]}
item replace entity <P> hotbar.2 with minecraft:cooked_beef 4
item replace entity <P> hotbar.8 with minecraft:arrow 32
effect give <P> minecraft:speed infinite 0 true
```

### tank — "Tanque"
- Description: "Peto y grebas de diamante con casco y botas de hierro. Aguanta mucho, pero solo lleva una espada de piedra y no tiene arco."
- Style: brawler that wins long melee trades; no ranged option, no mobility.
- Armour: iron_helmet, diamond_chestplate, diamond_leggings, iron_boots (18 armour, toughness 4). This is the cervinakuy Tank armour.
- Hotbar: h0 stone_sword, h2 cooked_beef x4.
- Tools: approach, attack, retreat, eat, wait.
```
item replace entity <P> armor.head with minecraft:iron_helmet
item replace entity <P> armor.chest with minecraft:diamond_chestplate
item replace entity <P> armor.legs with minecraft:diamond_leggings
item replace entity <P> armor.feet with minecraft:iron_boots
item replace entity <P> hotbar.0 with minecraft:stone_sword
item replace entity <P> hotbar.2 with minecraft:cooked_beef 4
```

### berserker — "Berserker"
- Description: "Hacha de diamante que pega fuerte pero lento, armadura mixta de hierro y malla, y Velocidad I. Sin arco: todo es cerrar distancia."
- Style: fast rusher with burst (9 damage per hit, one hit per second).
- Armour: chainmail_helmet, iron_chestplate, iron_leggings, chainmail_boots (14 armour).
- Hotbar: h0 diamond_axe, h2 cooked_beef x4. Effect: Speed I.
- Tools: approach, attack (axe), retreat, eat, wait.
```
item replace entity <P> armor.head with minecraft:chainmail_helmet
item replace entity <P> armor.chest with minecraft:iron_chestplate
item replace entity <P> armor.legs with minecraft:iron_leggings
item replace entity <P> armor.feet with minecraft:chainmail_boots
item replace entity <P> hotbar.0 with minecraft:diamond_axe
item replace entity <P> hotbar.2 with minecraft:cooked_beef 4
effect give <P> minecraft:speed infinite 0 true
```

### ender — "Enderman"
- Description: "Espada de diamante, armadura de malla y 4 perlas de ender para caerle encima al rival o escapar al otro lado de la arena."
- Style: teleporter (cervinakuy Warper: 4 pearls, light armour). Pearl in to skip the rival's arrows, pearl out to eat in peace.
- Armour: full chainmail (12 armour); boots with Feather Falling IV, so a pearl costs 2.6 life instead of 5.
- Hotbar: h0 diamond_sword, h1 ender_pearl x4, h2 cooked_beef x4.
- Tools: approach, attack, retreat, eat, wait, pearl.
```
item replace entity <P> armor.head with minecraft:chainmail_helmet
item replace entity <P> armor.chest with minecraft:chainmail_chestplate
item replace entity <P> armor.legs with minecraft:chainmail_leggings
item replace entity <P> armor.feet with minecraft:chainmail_boots{Enchantments:[{id:"minecraft:feather_falling",lvl:4s}]}
item replace entity <P> hotbar.0 with minecraft:diamond_sword
item replace entity <P> hotbar.1 with minecraft:ender_pearl 4
item replace entity <P> hotbar.2 with minecraft:cooked_beef 4
```

### builder — "Constructor"
- Description: "Estilo UHC: armadura y espada de hierro, arco con 8 flechas, 3 manzanas doradas y 16 bloques para levantar muros o una torre."
- Style: Build-UHC lite. Wall off the rival to eat an apple; tower to shoot from above.
- Armour: full iron (15 armour).
- Hotbar: h0 iron_sword, h1 bow, h2 golden_apple x3, h3 oak_planks x16, h8 arrow x8.
- Tools: approach, attack, retreat, shoot, eat, wait, build.
- Blocks are oak_planks, not cobblestone: the pathfinder's default scaffolding list is [dirt, cobblestone] and would spend cobblestone while following.
```
(armour block with iron)
item replace entity <P> hotbar.0 with minecraft:iron_sword
item replace entity <P> hotbar.1 with minecraft:bow
item replace entity <P> hotbar.2 with minecraft:golden_apple 3
item replace entity <P> hotbar.3 with minecraft:oak_planks 16
item replace entity <P> hotbar.8 with minecraft:arrow 8
```

Generator for apps/orchestrator/src/arena.ts (replaces `fighterKitCommands`, line 94):
```ts
function itemNbt(item: KitItem): string {
  if (!item.enchantments?.length) return "";
  const list = item.enchantments.map((e) => `{id:"minecraft:${e.id}",lvl:${e.level}s}`).join(",");
  return `{Enchantments:[${list}]}`;
}

export function fighterKitCommands(username: string, kit: Kit): string[] {
  return [
    ...kit.items.map(
      (i) => `item replace entity ${username} ${i.slot} with minecraft:${i.item}${itemNbt(i)}${i.count > 1 ? ` ${i.count}` : ""}`,
    ),
    ...kit.effects.map((e) => `effect give ${username} minecraft:${e.id} infinite ${e.amplifier} true`),
  ];
}
```
`prepareFighter(rcon, side, kit)` takes the kit from `state.configs[side]` (match.ts:258). No existing test asserts the old `give` strings; the tests only mention `heldItem: "iron_sword"`, which stays true for classic.

====================================================================
2. TOOLS
====================================================================
Tools offered per kit (filter `TOOL_DEFS` before fighter.ts:478; the list is static for the whole fight, so a spent item returns a failure text):

| Tool | classic | archer | tank | berserker | ender | builder |
|---|---|---|---|---|---|---|
| approach, attack, retreat, wait | yes | yes | yes | yes | yes | yes |
| shoot | yes | yes | no | no | no | yes |
| eat | yes | yes | yes | yes | yes | yes |
| pearl | no | no | no | no | yes | no |
| build | no | no | no | no | no | yes |

Derive it from the kit items in packages/agent/src/tools.ts, so the data cannot drift:
```ts
export const TOOL_NAMES = ["approach", "attack", "retreat", "shoot", "eat", "pearl", "build", "wait"] as const;

export function kitToolNames(kit: Kit): ToolName[] {
  const has = (name: string): boolean => kit.items.some((i) => i.item === name);
  const names: ToolName[] = ["approach", "attack", "retreat"];
  if (has("bow") && has("arrow")) names.push("shoot");
  if (has("cooked_beef") || has("golden_apple")) names.push("eat");
  if (has("ender_pearl")) names.push("pearl");
  if (has("oak_planks")) names.push("build");
  names.push("wait");
  return names;
}
```
- A tool that is not in the kit, if called anyway, returns `"tu kit no tiene esa herramienta; usa: <lista>"` and keeps the current mode.
- The mock LLM already picks only among the tools it is offered (packages/llm/src/mock.ts:166-168), so a kit without `shoot` is safe.
- `parseToolArgs` gains `target` (default "rival") and `shape` (default "wall"), tolerant like `seconds`.

### Existing tools
**approach** — "Camina hacia el rival hasta quedar a unos 2 bloques, sin atacar." Unchanged, plus the elevated-rival goal described under attack.

**attack(seconds?)** — "Ataque cuerpo a cuerpo: equipa tu arma (espada o hacha), persigue al rival y lo golpea respetando la recarga del arma. Sigue atacando hasta tu próxima decisión (o por 'seconds' segundos)."
- Weapon: first sword, else first axe (already the logic at fighter.ts:707-709). No kit has both, so no argument is needed.
- Cooldown by held item replaces the constant at fighter.ts:31: sword 625 ms; diamond, golden or netherite axe 1000 ms; iron axe 1111 ms; stone or wooden axe 1250 ms; empty hand 250 ms.
- On `heldItemChanged`, set `lastAttackAt = now`. The server resets attack strength on an item switch, so today the first hit after bow or food is weak.
- Reach: replace feet-to-feet `distance3 <= 3.2` with eye-to-hitbox <= 3.0: `hypot(max(0, distXZ - 0.3), clamp(eyeY, rival.y, rival.y + 1.8) - eyeY) <= 3.0`. On flat ground this is the same range as today; it also reaches a rival on a 3-block tower from the base.
- If the rival's feet are 1.5 or more above yours, replace `GoalFollow` with `goals.GoalNearXZ(rival.x, rival.z, 1)`, refreshed every 400 ms. `GoalFollow` measures in 3D and gives `noPath` for a rival on a tower.
- Result text names the weapon: "atacando cuerpo a cuerpo con el hacha" / "con la espada".

**retreat** — unchanged.

**shoot** — "Dispara con el arco: te detienes, apuntas, cargas cerca de 1 segundo y sueltas. Sigue disparando hasta tu próxima decisión. Necesita arco y flechas." Unchanged. Optional: before releasing, `bot.world.raycast` from the eye to the rival; if a block is in the way, do not release and set `lastResult = "sin línea de tiro: hay bloques en medio"`.

**eat** — "Come para recuperar vida: filete (solo si tu barra de comida no está llena) o manzana dorada (siempre; da 4 de vida extra y regeneración). Tarda cerca de 2 segundos y te deja quieto." Logic unchanged: no kit mixes steak and golden apples, and fighter.ts:804-805 already eats a golden apple with a full bar.

**wait** — unchanged.

### pearl(target: "rival" | "away") — ender kit
Description for the LLM: "Lanza una perla de ender y te teletransporta donde cae. target='rival': caes junto al rival y pasas a atacar automáticamente. target='away': caes lejos del rival, al otro lado de la arena, y quedas en espera (buen momento para comer). Cada perla te quita unos 2.5 de vida al caer. Recarga de 5 segundos. Tienes 4."

Preconditions, checked in `executeTool`. A failure does not change the current mode and spends nothing; the returned text ends with `; sigues con "<modo>"`:
- No pearls: "no puedes usar la perla: no te quedan perlas".
- `now < pearlReadyAt`: "la perla está en recarga: faltan N s".
- Health <= 4: "no puedes usar la perla: te queda muy poca vida (caer quita ~2.5)".
- Feet more than 1.5 above the arena floor: "no puedes usar la perla desde altura".
- target "rival" and rival not visible: "no ves al rival".
- target "rival" and distance < 4: "el rival ya está a N bloques: usa attack".

State machine (mode `pearl`, one-shot):
1. EQUIP: `ensureHeld(ender_pearl)` and `clearGoal`. Still pending after 1 s: `enterWait("no pudiste equipar la perla")`.
2. AIM: compute the landing point.
   - rival: `opponent.position + opponentVelocity * 0.35 s`, velocity capped at 8 b/s.
   - away: `retreatTarget({ self, opponent, center, radius, step: 12 })`.
   - Both are clamped to radius 10.5 from the centre.
   - yaw = `atan2(-dx, -dz)`; pitch = `pearlPitch(distXZ, drop)` clamped to [-70°, +6°]; `bot.look(yaw, pitch, true)`; store `aimedAt`.
   - `pearlPitch` is a pure function in aim.ts: simulate 1.5 b/tick, gravity 0.03, drag 0.99 and bisect. Reference values from the mineflayer report: -20° lands at 4 blocks, -10° at 7, -4° at 11, 0° at 15.3.
3. THROW: when `now - aimedAt >= 150 ms` (the look packet must leave first), call `bot.activateItem()` without setting `this.using`. Set `pearlReadyAt = now + 5000`.
4. FLIGHT: wait for `bot.once("forcedMove")` or 1500 ms. On `forcedMove`: `goalKind = "none"`, `pathfinder.setGoal(null)`, reset `opponentSample`, and mark `selfDamageUntil = now + 600`.
5. DONE:
   - rival: mode becomes `attack`, `lastResult = "te teletransportaste junto al rival (distancia N); atacando"`.
   - away: `enterWait("te teletransportaste lejos del rival (distancia N); te quedan K perlas")`.
   - timeout: `enterWait("lanzaste la perla pero no te teletransportaste")`.
- Interruption: another tool during EQUIP or AIM cancels without throwing. After THROW the teleport happens anyway, so the `forcedMove` handler must be global.
- Cooldown: 5 s in the tool (vanilla is 1 s). With 4 pearls this stops an LLM from burning them in a row.

### build(shape: "wall" | "tower") — builder kit
Description for the LLM: "Coloca bloques. shape='wall': levanta un muro de 3 de ancho y 2 de alto entre tú y el rival; frena las flechas y lo obliga a rodearlo (útil para comer detrás). Gasta hasta 6 bloques. shape='tower': subes a una torre de 3 bloques bajo tus pies para disparar desde arriba. Gasta 3 bloques. Tarda 1 a 2 segundos, te deja quieto y al terminar quedas en espera. Recarga de 4 segundos."

Preconditions (same non-interrupting rule as pearl):
- No blocks: "no te quedan bloques".
- Cooldown: "todavía no puedes construir: faltan N s".
- wall with no visible rival: "no ves al rival: no hay dónde poner el muro".
- tower with fewer than 3 blocks: "necesitas 3 bloques para la torre".
- tower when already more than 0.5 above the floor: "ya estás en altura".

Wall state machine:
1. EQUIP: planks to hand, `clearGoal`, `bot.clearControlStates()`.
2. PLACE: an async chain behind a `buildBusy` flag and a generation counter. Never await inside `bodyTick`.
   - Geometry: snap the self-to-rival direction to its dominant axis. Centre cell = 2 blocks ahead of your own cell; the wall is that cell plus one on each side, at feet level and one above.
   - Order: bottom row (centre first), then top row.
   - Per cell: skip if not air; skip if it overlaps you or the rival (|dx| < 0.8 and |dz| < 0.8); the reference is the block below and must be solid. Then `await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true)` and `await Promise.race([bot.placeBlock(ref, up), sleep(700)])`; a rejection skips the cell.
   - Abort if the mode changed, the bot died, or 2.5 s have passed.
3. DONE:
   - `enterWait("muro de N bloques entre tú y el rival; te quedan K bloques")`.
   - With N = 0: `enterWait("no pudiste colocar ningún bloque (no hay espacio o el rival está encima)")`.

Tower state machine:
1. SETUP: `clearGoal`; `setMovements(towerMovements)`, a second `Movements` with `allow1by1towers = true`, `scafoldingBlocks = [bot.registry.itemsByName.oak_planks.id]`, `canDig = false`, `allowParkour = false`; then `setGoal(new goals.GoalBlock(x, y + 3, z))`. The pathfinder's own jump-and-place move does the work (scratchpad mf/pathfinder/movements.js:537-548, index.js:533-560).
2. CLIMB: finish on `goal_reached`, on feet >= start + 2.9, or after 4 s.
3. DONE: restore the normal movements and `clearGoal`.
   - Success: `enterWait("subiste a una torre de 3 bloques; desde aquí puedes disparar")`.
   - Timeout: `enterWait("torre incompleta: subiste H bloques")`.
- `leaveMode` must restore the normal movements whenever the mode was `build`.
- Height is capped at 3: no fall damage coming down (the pathfinder's `maxDropDown` is 4), the head stays below the wall top, and the rival can still hit from the base with the new reach check.
- The normal `Movements` (fighter.ts:377) must set `scafoldingBlocks = []`.

### Supporting changes outside the tools
- System prompt: add a "TU KIT" section generated from the kit (items, counts, effect, and one line of mechanics per offered tool), and generate the HERRAMIENTAS list from `kitToolNames`.
- Do not put the kit name or description in the system prompt. The mock's style regex matches `arquer` anywhere in it (packages/llm/src/mock.ts:45, 72-78) and would turn both mock sides ranged. Alternatively restrict `readStyle` to the `<estrategia>` block.
- Observation: `inventory` already reports `ender_pearl`, `oak_planks` and `golden_apple` counts. Add only `pearlCooldown` (seconds, when above 0) and, if the raycast is implemented, `lineOfSight`.
- `onDamageTaken(amount, health, bySelf)`: match.ts:381-388 credits every health drop to the rival, so pearl damage would count as the rival's. Pass `bySelf = now < selfDamageUntil`.
- Arena: after the clear fill (arena.ts:79) add a barrier lid, `fill -13 71 -13 13 71 13 minecraft:barrier` (y = wall top + 1). It is invisible to the camera and inside the existing clear volume (y 64..76).
- Optional: when a match ends, run `fill -13 65 -13 13 76 13 minecraft:air replace minecraft:oak_planks`, so leftover walls do not stay on the stream until the next match.

====================================================================
3. BALANCE
====================================================================
Inputs
- Armour formula: `final = dmg * (1 - clamp(armor - 4*dmg/(toughness + 8), armor/5, 20) / 25)`.
- Weapons at full charge: stone sword 5, iron sword 6, diamond sword 7, diamond axe 9. The bot never crits because it never jumps.
- Hit period with the 100 ms body tick: swords 0.7 s, diamond axe about 1.05 s.
- Bow at full charge (the bot holds 1100 ms): 6 plus a crit bonus of 0 to 4, average 8. One shot every 1.45 s. Punch adds knockback, not damage.
- Natural regeneration is on and prepareFighter gives 20 saturation, which is 13.3 life of fast regeneration. So every fighter starts with 33.3 effective life.
- Healing items: steak = 8.5 life (its 12.8 saturation), only edible once the food bar drops below 20. Golden apple = 4 absorption + 4 regeneration, plus up to 6.4 from its saturation, edible at any time.
- Pearl: 5 fall damage, 2.6 with Feather Falling IV.

| Kit | Armour / toughness | Melee | Ranged | Healing (effective life) | Extra |
|---|---|---|---|---|---|
| classic | 15 / 0 | iron sword 6 | 16 arrows | 4 steaks, 34 | none |
| archer | 12 / 0 | stone sword 5 | 32 arrows, Punch I | 4 steaks, 34 | Speed I |
| tank | 18 / 4 | stone sword 5 | none | 4 steaks, 34 | none |
| berserker | 14 / 0 | diamond axe 9 | none | 4 steaks, 34 | Speed I |
| ender | 12 / 0 | diamond sword 7 | none | 4 steaks, 34 | 4 pearls |
| builder | 15 / 0 | iron sword 6 | 8 arrows | 3 golden apples, 24 to 43 | 16 blocks |

Damage per hit after armour (melee DPS in parentheses):

| Attacker | vs classic, builder (15) | vs archer, ender (12) | vs tank (18/4) | vs berserker (14) |
|---|---|---|---|---|
| iron sword (classic, builder) | 3.12 (4.46) | 3.84 (5.49) | 2.16 (3.09) | 3.36 (4.80) |
| stone sword (archer, tank) | 2.50 (3.57) | 3.10 (4.43) | 1.73 (2.47) | 2.70 (3.86) |
| diamond axe (berserker) | 5.22 (4.97) | 6.30 (6.00) | 3.60 (3.43) | 5.58 (5.31) |
| diamond sword (ender) | 3.78 (5.40) | 4.62 (6.60) | 2.61 (3.73) | 4.06 (5.80) |
| arrow, average 8 | 4.48 | 5.44 | 3.09 | 4.80 |

Matchup matrix. Each cell is the estimated win rate of the row kit, then the seconds of continuous melee contact the row kit needs to remove 33.3 effective life:

| Row vs column | classic | archer | tank | berserker | ender | builder |
|---|---|---|---|---|---|---|
| classic | 50%, 7.5 s | 50%, 6.1 s | 50%, 10.8 s | 53%, 6.9 s | 50%, 6.1 s | 50%, 7.5 s |
| archer | 50%, 9.3 s | 50%, 7.5 s | 45%, 13.5 s | 48%, 8.6 s | 48%, 7.5 s | 50%, 9.3 s |
| tank | 50%, 9.3 s | 55%, 7.5 s | 50%, 13.5 s | 53%, 8.6 s | 54%, 7.5 s | 50%, 9.3 s |
| berserker | 47%, 6.7 s | 52%, 5.6 s | 47%, 9.7 s | 50%, 6.3 s | 50%, 5.6 s | 47%, 6.7 s |
| ender | 50%, 6.2 s | 52%, 5.0 s | 46%, 8.9 s | 50%, 5.7 s | 50%, 5.0 s | 50%, 6.2 s |
| builder | 50%, 7.5 s | 50%, 6.1 s | 50%, 10.8 s | 53%, 6.9 s | 50%, 6.1 s | 50%, 7.5 s |

Real duration: assuming the bots are in melee contact about 35% of the time and use about half their healing (50 effective life), a fight lasts 25 to 45 s in most pairings and 60 to 80 s in the slowest one, tank against tank (27 s of contact with all four steaks). All are under MATCH_DURATION_SECONDS = 180.

Why each pairing holds
- Mirrors: identical items and symmetric spawns.
- classic vs builder: same armour and sword. Builder trades 8 arrows and slower-but-larger steak healing for apples it can eat at any time, and for blocks.
- classic vs tank: tank wins the melee race by 16% (3.57 DPS dealt against 3.09 taken). Classic gets 2 or 3 arrows on the approach (about 6 damage at 3.09 each), which cancels it.
- classic vs archer:
  - Opening: the archer lands about 3 of 4 arrows before contact (about 14 damage) and takes 2 hits.
  - Close range: per 1.45 s shot cycle the archer deals 3.8 and takes about 4.8, because Punch limits classic to roughly one hit per cycle.
  - Net: both reach zero within one cycle of each other.
- classic vs berserker: melee is even (4.97 dealt, 4.80 taken). Classic's arrows deal 4.8 each on the approach; Speed I cuts the number that land.
- classic vs ender: melee is even (5.40 against 5.49). Classic has the bow; ender skips the approach with a pearl (2.6 life) and can pearl away to eat a whole steak (net +5.9 per pearl).
- archer vs tank: tank is favoured. The archer's cycle deals 2.6 and takes 3.9; it wins only by re-opening range with Speed I. This is the largest gap in the matrix.
- archer vs berserker: both have Speed I, so the archer cannot kite. Its cycle deals 4.1 and takes one axe hit, 6.3, after about 11 damage of opening arrows. Both reach zero in about 5 cycles.
- archer vs ender: ender pearls in after at most one arrow. The cycle is 4.6 dealt against 5.8 taken, with ender starting about 7 life down (one arrow plus the pearl).
- tank vs berserker: tank deals 3.86 DPS and takes 3.43; the berserker's speed lets it leave and eat.
- tank vs ender: tank deals 4.43 and takes 3.73, a 19% edge in a straight brawl. Ender has to use the pearls to eat.
- tank vs builder: same as tank vs classic, with 8 arrows instead of 16 and instant-use apples.
- berserker vs ender: 6.00 DPS dealt against 5.80 taken; speed against pearls.
- berserker vs builder, ender vs builder: same numbers as against classic.

Tuning knobs if playtests disagree
- Archer too weak: add Power I to the bow (arrow average becomes 11.5; 7.25 against iron).
- Archer too strong: remove Speed I.
- Tank too strong or fights too long: 3 steaks instead of 4, or add Slowness I.
- Berserker too weak: Sharpness I on the axe (6.0 per hit against iron).
- Ender too weak: iron chestplate (13 armour).
- Builder stalls: 2 golden apples.

====================================================================
4. DATA MODEL (packages/protocol/src/index.ts)
====================================================================
Pure data, browser-safe. Insert after the "Agentes" block and add `kit` to `AgentConfigSchema`.
```ts
// ---------- Kits ----------

export const KIT_IDS = ["classic", "archer", "tank", "berserker", "ender", "builder"] as const;
export const KitIdSchema = z.enum(KIT_IDS);
export type KitId = z.infer<typeof KitIdSchema>;
export const DEFAULT_KIT: KitId = "classic";

type HotbarIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
/** Nombres de slot del comando `item replace entity` de Minecraft Java 1.20.4. */
export type KitSlot =
  | "armor.head"
  | "armor.chest"
  | "armor.legs"
  | "armor.feet"
  | "weapon.offhand"
  | `hotbar.${HotbarIndex}`
  | `inventory.${number}`;

/** `id` sin el prefijo "minecraft:" (ids de 1.20.4: "punch", "feather_falling", "sharpness"...). */
export type KitEnchantment = { id: string; level: number };

export type KitItem = {
  slot: KitSlot;
  /** Id de Minecraft sin prefijo: "iron_sword". */
  item: string;
  count: number;
  /** Nombre en español para tooltips y lectores de pantalla. */
  label: string;
  enchantments?: readonly KitEnchantment[];
};

/** Efecto permanente que se da con `effect give ... infinite`. `amplifier` 0 = nivel I. */
export type KitEffect = { id: string; amplifier: number; label: string };

export type Kit = {
  id: KitId;
  name: string;
  description: string;
  items: readonly KitItem[];
  effects: readonly KitEffect[];
};

const ARMOR_SLOTS = ["armor.head", "armor.chest", "armor.legs", "armor.feet"] as const;
const ARMOR_PIECES = ["helmet", "chestplate", "leggings", "boots"] as const;
const ARMOR_LABELS = {
  iron: ["Casco de hierro", "Peto de hierro", "Grebas de hierro", "Botas de hierro"],
  chainmail: ["Casco de malla", "Cota de malla", "Grebas de malla", "Botas de malla"],
  diamond: ["Casco de diamante", "Peto de diamante", "Grebas de diamante", "Botas de diamante"],
} as const;
type ArmorMaterial = keyof typeof ARMOR_LABELS;

/** Cuatro piezas en orden casco, peto, grebas, botas; cada una con su material. */
function armor(
  materials: readonly [ArmorMaterial, ArmorMaterial, ArmorMaterial, ArmorMaterial],
  bootEnchantments?: readonly KitEnchantment[],
): KitItem[] {
  return ARMOR_SLOTS.map((slot, i) => {
    const material = materials[i] as ArmorMaterial;
    const piece: KitItem = {
      slot,
      item: `${material}_${ARMOR_PIECES[i]}`,
      count: 1,
      label: ARMOR_LABELS[material][i] as string,
    };
    if (i === 3 && bootEnchantments) piece.enchantments = bootEnchantments;
    return piece;
  });
}

function item(slot: KitSlot, id: string, label: string, count = 1, enchantments?: readonly KitEnchantment[]): KitItem {
  return enchantments ? { slot, item: id, count, label, enchantments } : { slot, item: id, count, label };
}

const SPEED_I: KitEffect = { id: "speed", amplifier: 0, label: "Velocidad I" };

export const KITS: Record<KitId, Kit> = {
  classic: {
    id: "classic",
    name: "Clásico",
    description: "Armadura de hierro, espada, arco con 16 flechas y 4 filetes. El kit equilibrado de siempre.",
    items: [
      ...armor(["iron", "iron", "iron", "iron"]),
      item("hotbar.0", "iron_sword", "Espada de hierro"),
      item("hotbar.1", "bow", "Arco"),
      item("hotbar.2", "cooked_beef", "Filete", 4),
      item("hotbar.8", "arrow", "Flechas", 16),
    ],
    effects: [],
  },
  archer: {
    id: "archer",
    name: "Arquero",
    description:
      "Armadura de malla, arco con Empuje I y 32 flechas, espada de piedra y Velocidad I. Fuerte de lejos, débil cuerpo a cuerpo.",
    items: [
      ...armor(["chainmail", "chainmail", "chainmail", "chainmail"]),
      item("hotbar.0", "stone_sword", "Espada de piedra"),
      item("hotbar.1", "bow", "Arco", 1, [{ id: "punch", level: 1 }]),
      item("hotbar.2", "cooked_beef", "Filete", 4),
      item("hotbar.8", "arrow", "Flechas", 32),
    ],
    effects: [SPEED_I],
  },
  tank: {
    id: "tank",
    name: "Tanque",
    description:
      "Peto y grebas de diamante con casco y botas de hierro. Aguanta mucho, pero solo lleva una espada de piedra y no tiene arco.",
    items: [
      ...armor(["iron", "diamond", "diamond", "iron"]),
      item("hotbar.0", "stone_sword", "Espada de piedra"),
      item("hotbar.2", "cooked_beef", "Filete", 4),
    ],
    effects: [],
  },
  berserker: {
    id: "berserker",
    name: "Berserker",
    description:
      "Hacha de diamante que pega fuerte pero lento, armadura mixta de hierro y malla, y Velocidad I. Sin arco: todo es cerrar distancia.",
    items: [
      ...armor(["chainmail", "iron", "iron", "chainmail"]),
      item("hotbar.0", "diamond_axe", "Hacha de diamante"),
      item("hotbar.2", "cooked_beef", "Filete", 4),
    ],
    effects: [SPEED_I],
  },
  ender: {
    id: "ender",
    name: "Enderman",
    description:
      "Espada de diamante, armadura de malla y 4 perlas de ender para caerle encima al rival o escapar al otro lado de la arena.",
    items: [
      ...armor(["chainmail", "chainmail", "chainmail", "chainmail"], [{ id: "feather_falling", level: 4 }]),
      item("hotbar.0", "diamond_sword", "Espada de diamante"),
      item("hotbar.1", "ender_pearl", "Perla de ender", 4),
      item("hotbar.2", "cooked_beef", "Filete", 4),
    ],
    effects: [],
  },
  builder: {
    id: "builder",
    name: "Constructor",
    description:
      "Estilo UHC: armadura y espada de hierro, arco con 8 flechas, 3 manzanas doradas y 16 bloques para levantar muros o una torre.",
    items: [
      ...armor(["iron", "iron", "iron", "iron"]),
      item("hotbar.0", "iron_sword", "Espada de hierro"),
      item("hotbar.1", "bow", "Arco"),
      item("hotbar.2", "golden_apple", "Manzana dorada", 3),
      item("hotbar.3", "oak_planks", "Tablones de roble", 16),
      item("hotbar.8", "arrow", "Flechas", 8),
    ],
    effects: [],
  },
};

export const KIT_LIST: readonly Kit[] = KIT_IDS.map((id) => KITS[id]);

export const ENCHANTMENT_LABELS: Record<string, string> = {
  punch: "Empuje",
  feather_falling: "Caída de pluma",
};
const ROMAN = ["", "I", "II", "III", "IV", "V"];

/** "Arco (Empuje I)", "Flechas x32": texto del tooltip de un slot. */
export function kitItemTitle(i: KitItem): string {
  const enchants = (i.enchantments ?? []).map((e) => `${ENCHANTMENT_LABELS[e.id] ?? e.id} ${ROMAN[e.level] ?? e.level}`);
  const base = enchants.length > 0 ? `${i.label} (${enchants.join(", ")})` : i.label;
  return i.count > 1 ? `${base} x${i.count}` : base;
}

/** Slot de la ventana de inventario del jugador (el que usa mineflayer): armadura 5-8, principal 9-35, hotbar 36-44, mano secundaria 45. */
export function kitWindowSlot(slot: KitSlot): number {
  switch (slot) {
    case "armor.head":
      return 5;
    case "armor.chest":
      return 6;
    case "armor.legs":
      return 7;
    case "armor.feet":
      return 8;
    case "weapon.offhand":
      return 45;
    default: {
      const [group, index] = slot.split(".");
      return (group === "hotbar" ? 36 : 9) + Number(index);
    }
  }
}

/** Kit de una configuración; si falta o es desconocido, el kit por defecto. */
export function kitOf(config: { kit?: KitId | undefined }): Kit {
  return KITS[config.kit ?? DEFAULT_KIT];
}
```
`AgentConfigSchema` (protocol:45-51) gains one field:
```ts
  /**
   * Kit con el que pelea este lado. Opcional y tolerante: si falta (registros viejos,
   * servidor más antiguo que la web) o trae un id desconocido, vale DEFAULT_KIT (ver kitOf).
   */
  kit: KitIdSchema.optional().catch(undefined),
```
- I chose `.optional().catch(undefined)` plus `kitOf()` instead of `.default(DEFAULT_KIT)`. `.default` makes `kit` required in the inferred type and breaks every `AgentConfig` literal (store.ts:22-23 and 29, apps/web/src/scripts/mock.ts, tests). Web and orchestrator also deploy separately, so the field must parse on both sides of a version skew.
- If a required field is preferred, use `KitIdSchema.default(DEFAULT_KIT).catch(DEFAULT_KIT)` and fix those literals.
- `normalizeConfig` (store.ts:28-34) must copy the kit: `config.kit = kitOf(body).id`. It drops unknown fields today.
- `FighterOptions` (packages/agent/src/types.ts:23) gains `kit: KitId`, passed at match.ts:225-234.
- Web icons needed for these kits: sword, axe, arrow, golden apple, pearl, block tile, helmet, chestplate, leggings, boots, plus the existing bow and steak. Materials: iron, stone, diamond, wood, and a new chainmail triple. The crossbow, shield, potion, cobweb and bucket drafts from the web report are not needed.
- apps/web/src/scripts/actions.ts needs labels for `pearl` ("Lanza una perla") and `build` ("Construye"), and a neutral label for `attack` ("Ataca cuerpo a cuerpo").

====================================================================
5. RISKS AND CUT ORDER
====================================================================
Risks
- Balance is arithmetic, not measured. The contact-time model ignores LLM latency and knockback chains; the archer and tank rows are the least certain. Use the knobs in section 3.
- Pearl aim: on 1.20.4 `use_item` carries no rotation, so a throw before the look packet goes out lands wherever the bot last looked. The 150 ms wait covers it.
- Arena escape: closed by the pitch clamp, the radius-10.5 target clamp, the height precondition and the barrier lid. Nothing detects a bot outside the ring today.
- Wall placement can be refused (rival standing in the cell, stale look). The chain degrades to fewer blocks and reports the count; `placeBlock` has a 5 s internal timeout, hence the 700 ms race.
- Tower: the pathfinder holds the planks while climbing, so nothing may call `ensureHeld` during `build`. If the normal movements are not restored, the bot keeps towering while following.
- A tower camper with a life lead could stall against tank or berserker. The eye-based reach check and the `GoalNearXZ` fallback are what prevent it; they are required if the tower ships.
- Placed blocks change pathfinding for both bots. Keep `scafoldingBlocks = []`, and on this weak host set `bot.pathfinder.thinkTimeout = 1500`, `tickTimeout = 15`.
- Speed I is hidden (`true` = no particles), so viewers do not see it in the video. The web kit panel must show it; switch the flag to `false` if particles are wanted.
- Golden apple absorption is not part of `bot.health`. The timeout winner by health (match.ts:409-413) ignores it and absorbed hits are not credited as damage.
- Blocks stay in the arena on the stream after the match unless the optional end-of-match fill is added.

Cut order, first to cut at the top
1. Tower shape of `build` (keep the wall; drop the `shape` argument, the second `Movements`, the reach change and `GoalNearXZ`).
2. Line-of-sight raycast in `shoot` (bots waste arrows into walls, nothing breaks).
3. `bySelf` damage attribution (pearl damage shows as the rival's damage; cosmetic).
4. The builder kit and the `build` tool entirely (5 kits, 1 new tool).
5. The ender kit and `pearl` (4 kits, no new tool).
- Never cut: classic, archer, tank, berserker. They need only the kit data, the RCON generator, the per-kit tool filter, the weapon cooldown table and the `effect give` line.

Files read: /home/storrealbac/Desktop/phack2026/apps/orchestrator/src/arena.ts, /home/storrealbac/Desktop/phack2026/apps/orchestrator/src/match.ts, /home/storrealbac/Desktop/phack2026/apps/orchestrator/src/store.ts, /home/storrealbac/Desktop/phack2026/packages/protocol/src/index.ts, /home/storrealbac/Desktop/phack2026/packages/agent/src/fighter.ts, /home/storrealbac/Desktop/phack2026/packages/agent/src/tools.ts, /home/storrealbac/Desktop/phack2026/packages/agent/src/prompt.ts, /home/storrealbac/Desktop/phack2026/packages/agent/src/observation.ts, /home/storrealbac/Desktop/phack2026/packages/agent/src/geometry.ts, /home/storrealbac/Desktop/phack2026/packages/agent/src/types.ts, /home/storrealbac/Desktop/phack2026/packages/llm/src/mock.ts.