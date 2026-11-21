FEASIBILITY REVIEW: new bot tools vs real code (read-only, nothing run)

Verified in source: `/home/storrealbac/Desktop/phack2026/packages/agent/src/fighter.ts`, mineflayer 4.39.0, mineflayer-pathfinder 2.4.5, prismarine-physics 1.11.1 and minecraft-data 3.119.0 (lockfile versions; copies in `/tmp/claude-1000/-home-storrealbac-Desktop-phack2026/fc07f805-ff91-4795-be1c-1ba1d1aeda0d/scratchpad/mf/`, cited as mf/). mineflayer is not in the local `node_modules`.
From memory, not openable here: vanilla/Paper 1.20.4 server behaviour (reach 6, self-obstruction, pearl teleport point, attack-strength reset).

## Findings that change the design

1. **Speed I does nothing to the bots as designed.**
   - mineflayer stores attributes under `prop.key` (mf/mineflayer/entities.js:584). In minecraft-data the field is `name` for 1.17 to 1.20.4 and `key` only from 1.20.5 (checked the protocol.json of 1.16.2, 1.17, 1.18.2, 1.19, 1.19.4, 1.20.2, 1.20.3, 1.20.5).
   - So `bot.entity.attributes["minecraft:generic.movement_speed"]` is never set. prismarine-physics falls back to base 0.1 (mf/physics/index.js:547-553) and never uses the effect level for ground speed.
   - Movement is client-authoritative, so archer and berserker walk at normal speed and their balance rows are wrong.
   - Fix, in `attachListeners`:
   ```ts
   bot._client.on("entity_update_attributes", (packet: { entityId: number; properties: { name?: string; key?: string; value: number; modifiers: unknown[] }[] }) => {
     const entity = bot.entities[packet.entityId] as unknown as { attributes?: Record<string, unknown> } | undefined;
     if (!entity) return;
     entity.attributes ??= {};
     for (const p of packet.properties) {
       const key = p.key ?? p.name;
       if (typeof key === "string") entity.attributes[key] = { value: p.value, modifiers: p.modifiers };
     }
   });
   ```
   - Physics then applies the server's modifier (0.1 × 1.2) and still handles sprint itself (index.js:557-566).
   - The same bug rules out reading `generic.attack_speed` from attributes; the name table is the right choice.

2. **The arena floats.** The world is FLAT (`docker-compose.yml:67`, `scripts/local/minecraft.sh:114`), so the ground is near y=-61 and the floor disc is at y=64. Anything that leaves the ring falls about 125 blocks. The barrier lid is mandatory, not optional.

3. **`heldItemChanged` fires on every durability update** (mf/mineflayer/inventory.js:815-818), so after every hit. "On heldItemChanged set lastAttackAt = now" must only act when the item name changes. Put it inside the existing name-change branch at fighter.ts:360; otherwise every hit period grows by about 100 ms.

4. **A wall 2 blocks ahead does not stop melee.** The server has no line-of-sight check, and a rival touching the far side is at distXZ 2.8, inside the new 3.0 reach. Put the wall centre 3 blocks ahead (the rival is then at 3.8 or more, out of reach) and require rival distance >= 4.5.

5. **`prepareFighter` ignores RCON replies** (`sendAll`, arena.ts:113). A bad NBT string or slot name silently gives a missing item. Log any reply that does not match `/Replaced a slot|Applied effect/`.

6. **Spawn protection is not a problem**: it is 0 in both server configs. The camera is a spectator, which the server does not broadcast to survival players and does not count as an obstruction.

## pearl: keep with changes (about 90%)

Verified
- `use_item` on 1.20.3/1.20.4 is `{hand, sequence}` only.
- `bot.look(y, p, true)` only sets state; the packet leaves in the next `updatePosition` (mf/mineflayer/physics.js:158-205).
- `physicsTick` is emitted before `updatePosition` in the same call (physics.js:84-90).
- `forcedMove` is emitted synchronously from the `position` packet handler, after `teleport_confirm` (physics.js:374-454).
- hotbar to hand is a synchronous `held_item_slot` (mf/mineflayer/simple_inventory.js:113-117).

What breaks
- **Aim timing.** The 150 ms wait is safe in practice, but a physics-tick counter is exact: one `physicsTick` seen after the look, in a later macrotask, guarantees the look packet was written.
- **`look()` early return.** It returns before forcing `lastSent*` when the rounded yaw and pitch deltas are both 0 (physics.js:336-338). After a non-forced pathfinder look this can leave a stale sent yaw. Call `bot.look(yaw + 0.01, pitch, true)` and then `bot.look(yaw, pitch, true)`.
- **Landing point.** As I recall the 1.20.4 server, the pearl teleports you to its position at the start of the impact tick, so you land 0 to 1.5 blocks short and up to about 0.7 in the air. Fine for both targets, but the reported distance must be measured after landing.
- **`pearlPitch` bisect is unnecessary.** `computeAim` (aim.ts:27) already does lead and drop: pass `arrowSpeed: 30, gravity: 12` (1.5 b/tick, 0.03 b/tick²). It undershoots about 1 block at 20 blocks, which is harmless.
- **Wall hit.** If the pre-impact position is under 0.3 from the glass (about 20% of wall hits), the hitbox overlaps it. Neither prismarine-physics nor the server clips an already-overlapping box, so knockback could push the bot through. The radius-10.5 clamp makes wall hits need an aim error.
- **Global `forcedMove` also fires on the prepare `tp`, on respawn and on server rubber-banding.** Gate the pearl logic on "thrown less than 2 s ago and moved more than 2 blocks". Always reset `goalKind` and `setGoal(null)`.
- **Self-damage window.** 600 ms can swallow one rival hit. Exact alternative: `bot.on("entityHurt", (e, source) => ...)`; `damage_event` gives the source entity (entities.js:381-385) and fall damage has none.
- **"away to eat" rarely completes.** The rival re-closes in 2 to 3.5 s and the next decision takes 1.5 s plus latency. End `away` in `eat` mode when food is below 20, else `wait`.

Opponent: `entity_teleport` gives a velocity spike of about 100 b/s in `estimateVelocity`. Zero any sample above 15 b/s in `trackOpponent`. `GoalFollow.hasChanged` replans by itself.

```ts
// equip stage, once ensureHeld(n => n === "ender_pearl") === "held" and clearGoal() ran:
const eye = { x: self.x, y: self.y + 1.52, z: self.z };
const aim = computeAim({ from: eye, target, targetVelocity: v, arrowSpeed: 30, gravity: 12 });
const c = clampToArena(aim, ARENA.center, ARENA.radius - 1.5);
const dx = c.x - eye.x, dz = c.z - eye.z;
const pitch = Math.max(-1.22, Math.min(0.105, Math.atan2(aim.y - eye.y, Math.hypot(dx, dz))));
const yaw = Math.atan2(-dx, -dz);
void bot.look(yaw + 0.01, pitch, true); void bot.look(yaw, pitch, true);
p.stage = "aim"; p.tick = this.physicsTicks;          // bot.on("physicsTick", () => this.physicsTicks++)
// aim stage: if (this.physicsTicks - p.tick >= 1) { bot.activateItem(); pearlReadyAt = now + 5000; p.stage = "flight"; }
```

## build wall: keep with changes (about 75%)

Verified
- `placeBlock` resolves on `blockUpdate:<dest>`, throws "Server refused" when the type is unchanged, and has a 5 s timeout (mf/mineflayer/place_block.js:11-45).
- Its inner non-forced `lookAt` returns immediately after an identical forced one.
- Passing the promise to `Promise.race` leaves no unhandled rejection.
- `vec3` is not resolvable from `packages/agent`; build vectors with `.floored().offset()`.

What breaks
- The melee reach issue above (finding 4).
- `clearGoal` is a no-op when `goalKind === "none"` (fighter.ts:884).
- `buildBusy` must be cleared in `finally` and in `resetBody`, or the tool is dead for the rest of the match.
- After a 700 ms race loss, count blocks with `bot.blockAt(cell)?.name`, not by resolved promises.
- Extra preconditions: rival distance >= 4.5 and own feet on the arena floor.
- Do not add a line-of-sight check to melee: `GoalFollow` range 2 would be satisfied across a wall and the rival would stall.

Opponent: the pathfinder resets on nearby `blockUpdate` (mf/pathfinder/index.js:357-362) and walks around; arrows are wasted. Partial walls (bottom row only) are 1-high steps the rival hops over.

```ts
const feet = bot.entity.position.floored();
const up = feet.offset(0, 0, 0).set(0, 1, 0);
const ax = Math.abs(dx) >= Math.abs(dz) ? { x: Math.sign(dx), z: 0 } : { x: 0, z: Math.sign(dz) };
await bot.equip(planks, "hand");
for (const dy of [0, 1]) for (const s of [0, -1, 1]) {
  if (gen !== this.buildGen || !this.alive || Date.now() > deadline) break;
  const cell = feet.offset(ax.x * 3 - ax.z * s, dy, ax.z * 3 + ax.x * s);
  const ref = bot.blockAt(cell.offset(0, -1, 0));
  if (bot.blockAt(cell)?.name !== "air" || !ref || ref.boundingBox !== "block" || overlapsEntity(cell)) continue;
  await bot.lookAt(ref.position.offset(0.5, 1, 0.5), true);
  await Promise.race([bot.placeBlock(ref, up).catch(() => undefined), sleep(700)]);
  if (bot.blockAt(cell)?.name === "oak_planks") placed++;
}
```

## build tower: cut, or hand-roll it

The pathfinder route is worse than the design assumes:
- **It places too early.** It sends the placement as soon as `placingBlock.y + 1 < bot.entity.position.y` (index.js:473), that is at feet +0.42. The server refuses until feet are 1.0 or more above (jump ticks 3 to 8). It only converges through `place_error`, replan and retry.
- **A nearby rival breaks the move.** `getMoveUp` returns when any entity intersects the bot's cell (mf/pathfinder/movements.js:526).
- **Block spend is unbounded.** After that, or after knockback mid-climb, A* is free to build stairs towards the fixed `GoalBlock` with all 16 planks, running up to `thinkTimeout`.
- **Movements leak.** They would need restoring in `leaveMode`, `resetBody` and `doStop`.

If kept, hand-roll it: about 30 lines, exactly one block per jump, no A*, no second `Movements`. `await bot.waitForTicks(1)` resumes after that tick's position packet. Wrap it in try/catch, because `waitForTicks` rejects after 5 s without physics.

```ts
for (let n = 0; n < 3 && ok(); ) {
  const ref = bot.blockAt(col.offset(0, n - 1, 0));
  bot.setControlState("jump", true);
  while (bot.entity.position.y < col.y + n + 1.05 && ok()) await bot.waitForTicks(1);
  const place = (bot as any)._placeBlockWithOptions(ref, up, { forceLook: "ignore", swingArm: "right" });
  await Promise.race([place.catch(() => undefined), sleep(600)]);
  bot.setControlState("jump", false);
  if (bot.blockAt(col.offset(0, n, 0))?.name === "oak_planks") n++;
  while (!bot.entity.onGround && ok()) await bot.waitForTicks(1);
}
```

Either way the tower needs the eye-based reach and the `GoalNearXZ` fallback (exported, goals.js:95). Set that goal only when the rival's cell changes, because every `setGoal` clears the control states.

## attack / axe: keep with changes

- `bot.attack` sends `use_entity` then the swing on 1.20.4 (entities.js:843-856), which is the right order for the server's strength reset.
- Add one server tick of margin to the table: sword 650, diamond axe 1050, iron axe 1150, stone and wooden axe 1300, fist 300. A hit at exactly 1000 ms can land at 19 server ticks, about 96% damage.
- The eye-to-hitbox formula is correct, and the server allows 6.

## Interrupted-action audit

- **Still using an item:** only bow and eat set `this.using`, and `leaveMode` releases them. The pearl must not set it. Failed preconditions must return before `leaveMode`.
- **Sneak or jump stuck:** the pathfinder sets sneak only in `moveToEdge`, and `setGoal(null)` clears all control states (index.js:128-147). The hand-rolled tower must release jump on every exit path.
- **Planks or pearl left in hand:** fixed by the next `ensureHeld`, with the first hit correctly delayed by the name-change reset.

## Data model gaps

- **Tool list per kit.** `kitToolNames` lives in `packages/agent`, so the web cannot show which tools a kit has, and prompt authors need those names. Move it and `TOOL_NAMES` to protocol, or add `tools` to `Kit`.
- **Icons.** There is no item-to-icon mapping. The web needs its own table with a fallback, and `heldItemView` (scoreboard.ts:142-150) must learn axe, pearl, planks and golden apple.
- **Live inventory.** `AgentStatus` carries only `heldItem`. The kit preview with dropdown is fully derivable from `KITS`; live counts would need a new status field.
- **Armour points and toughness** are not derivable without a table, if the panel should show them.
- **Slot names.** `inventory.${number}` accepts invalid indices; this pairs with the unchecked RCON replies.
- `kit: KitIdSchema.optional().catch(undefined)` is valid on zod 3 and keeps the key optional. The orchestrator can derive every command from the model.

## Ranking

Keep as designed
- classic and tank kits
- `item replace` generator
- per-kit tool filter
- hotbar convention
- barrier lid (now mandatory)
- `scafoldingBlocks = []`
- pathfinder timeouts
- eat with golden apple

Keep with changes
1. Speed I for archer and berserker: needs the attribute listener, or it is a no-op.
2. Weapon cooldown table: add the margin, reset only on name change.
3. `pearl`: tick-counted aim, `computeAim` reuse, gated `forcedMove`, opponent velocity clamp, `away` ends in eat.
4. `build` wall: 3 blocks ahead, distance >= 4.5, count by block, `finally`.
5. Eye-based reach; `GoalNearXZ` only if the tower ships.
6. Data model: tools in protocol, RCON reply check.

Cut
- Pathfinder-driven tower. Hand-roll it or drop the `shape` argument; I would drop it for the first version.
- `pearlPitch` bisect.
- Line-of-sight raycast in shoot (optional, nothing breaks without it).