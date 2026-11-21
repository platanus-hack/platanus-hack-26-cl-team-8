# SPEC: kits, modelos baratos y solo Vercel AI

Working copy for ALL edits: `/home/storrealbac/Desktop/phack2026-kits` (git worktree, branch `kits`).
NEVER edit `/home/storrealbac/Desktop/phack2026` (it has another agent's uncommitted work).

Background reports (read the ones that concern your part; file:line references in them point at
the same files inside the working copy):
- R = `/tmp/claude-1000/-home-storrealbac-Desktop-phack2026/fc07f805-ff91-4795-be1c-1ba1d1aeda0d/scratchpad/wf1`
- `R/diseño_kits.md` — the kit design. It is the base of this spec; where this spec differs, THIS SPEC WINS.
- `R/mapa_agente_mineflayer.md` — how fighter.ts works and how to use mineflayer for each item.
- `R/mapa_web.md` — the website map (DOM id contract, PixelIcon, CSS conventions, mock.ts).
- `R/mapa_proveedores.md` — the provider removal plan and the model allowlist plan.

## Hard rules
- This PC is weak: do NOT run node, npm, pnpm, npx, tsc, vitest, astro, docker or any dev server locally.
  Only read and edit files, and run read-only git commands. Typecheck and tests run later on a server.
  Since you cannot compile, be extra careful with types, imports and every call site.
- Do not commit, push, stash or switch branches. Do not touch files outside your assigned area.
- Code comments, UI text, log texts and LLM-facing texts are in Spanish, like the rest of the repo.
  Follow the existing style of each file. No new dependencies (the lockfile must not change).
- Do not create planning or notes files in the repo.

## Product decisions
1. Each side picks its own kit: a dropdown inside each prompt editor, with the full inventory of
   the chosen kit drawn below it. The kit is saved with the prompt (`kit` field of AgentConfig).
2. Six kits exactly as in `R/diseño_kits.md` section 1 and section 4 (classic, archer, tank,
   berserker, ender, builder). Default: classic.
3. Two new tools: `pearl(target: "rival" | "away")` and `build()`.
   **CUT from the design: the tower.** `build` has NO `shape` argument and only makes the wall
   (3 wide, 2 high, between the bot and the rival). So also cut: the second `Movements`, the
   eye-to-hitbox reach change, `GoalNearXZ`, and the line-of-sight raycast in `shoot`.
   Keep: weapon cooldown table by held item, `lastAttackAt` reset on held item change,
   `scafoldingBlocks = []`, the 5 s pearl cooldown, the 4 s build cooldown, `bySelf` damage.
   `build` description for the LLM: "Coloca bloques: levanta un muro de 3 de ancho y 2 de alto
   entre tú y el rival; frena las flechas y lo obliga a rodearlo (útil para comer detrás). Gasta
   hasta 6 bloques. Tarda 1 a 2 segundos, te deja quieto y al terminar quedas en espera. Recarga de 4 segundos."
4. Only two LLM providers remain: `vercel` (Vercel AI SDK) and `mock` (scripted, for tests).
   Delete openai, anthropic, openrouter and gateway everywhere.
5. Expensive models are removed. A model is allowed when its catalog price is
   input <= 1 USD per million tokens AND output <= 5 USD per million tokens. The orchestrator
   downloads the public catalog, filters it, serves it at `GET /api/models`, and enforces it.
   The website only offers that list; typing a free model id is no longer possible.

## Shared contract (packages/protocol/src/index.ts) — written first, by the protocol agent
- `ProviderSchema = z.enum(["mock", "vercel"])`.
- Kits block exactly as in `R/diseño_kits.md` section 4 (KIT_IDS, KitIdSchema, KitId, DEFAULT_KIT,
  KitSlot, KitEnchantment, KitItem, KitEffect, Kit, KITS, KIT_LIST, ENCHANTMENT_LABELS,
  kitItemTitle, kitWindowSlot, kitOf). `AgentConfigSchema.kit = KitIdSchema.optional().catch(undefined)`.
- `ServerDefaultsSchema.models = z.object({ mock: z.string(), vercel: z.string() })`.
- Models:
  ```ts
  /** Tope de precio de un modelo permitido, en dólares por millón de tokens. */
  export const MODEL_PRICE_CAP = { inputPerMillion: 1, outputPerMillion: 5 } as const;
  export const AllowedModelSchema = z.object({
    id: z.string(),
    name: z.string(),
    /** Dólares POR TOKEN. */
    inputPrice: z.number(),
    outputPrice: z.number(),
  });
  export type AllowedModel = z.infer<typeof AllowedModelSchema>;
  export const ModelsResponseSchema = z.object({
    models: z.array(AllowedModelSchema),
    /** "catalog" = lista viva del catálogo; "fallback" = lista fija porque no se pudo descargar. */
    source: z.enum(["catalog", "fallback"]),
    /** Epoch ms de la última descarga buena; null si nunca hubo una. */
    updatedAt: z.number().nullable(),
  });
  export type ModelsResponse = z.infer<typeof ModelsResponseSchema>;
  ```
  `API_ROUTES.models = "/api/models"` and the route comment updated (also `{ prompt, provider?, model?, kit? }`).
- Tool names are owned by packages/agent/src/tools.ts:
  `TOOL_NAMES = ["approach", "attack", "retreat", "shoot", "eat", "pearl", "build", "wait"]`.
- `FighterOptions` (packages/agent/src/types.ts) gains `kit: KitId`.
  `FighterEvents.onDamageTaken(amount: number, health: number, bySelf: boolean): void`
  (`bySelf` = true when the damage came from the bot's own ender pearl landing).

## Areas (one agent each; do not edit outside yours)
### A. packages/llm (except mock.ts and mock.test.ts), libs/env, apps/orchestrator
Follow `R/mapa_proveedores.md` sections 1 to 4 for the removal, the store migration
(`migrateStoredConfig` in store.ts, applied to prompts and to match history lines) and the model
allowlist (new `apps/orchestrator/src/models.ts` with pure `parseCatalog` + `ModelCatalog` class with
injectable fetch, `start()`, `stop()`, `isAllowed(id)`, `snapshot(): ModelsResponse`; compare prices
in dollars per million with rounding so models exactly at the cap pass; always allow the server
default model; static fallback list from the report). Wire it in index.ts, server.ts
(`GET /api/models`; `PUT /api/prompts/:side` answers 400 "Modelo no permitido: elige uno de la lista"
when a model is given, the effective provider is not mock and it is not allowed; when the provider is
mock the model is dropped) and match.ts (`makeLlm` second gate: fall back to the server default and
log a warning). Kits: `normalizeConfig` copies `kit` (`kitOf(body).id`);
`fighterKitCommands(username, kit)` and `prepareFighter(rcon, side, kit)` as in the design (item
replace + `effect give ... infinite`, after `effect clear`); match.ts passes `kit` to the fighter and
to prepareFighter, and does NOT credit `bySelf` damage to the rival's `damageDealt` (still broadcast
the damage event). Arena: add the invisible barrier lid at y = wall top + 1 over the arena footprint
right after the clear fill, and when a match ends clear leftover planks
(`fill ... minecraft:air replace minecraft:oak_planks` over the inner volume). explain.ts: print only
the model (or "simulado" for mock) and mention each side's kit name so the commentator can use it.
Tests: update the ones that used removed providers; add models.test.ts, migration tests in
store.test.ts, kit command tests for arena (new arena.test.ts is fine), and a match.test.ts case for
the model gate. Keep every existing test meaningful.
IMPORTANT: arena.ts in this working copy is the committed (square arena) version. Another agent has
uncommitted edits to lines 1-90 of that file in a different checkout. Keep your edits to arena.ts
small and local (the kit function, prepareFighter, the lid line, the cleanup helper) and do not
reformat or reorder the rest, so both changes merge cleanly.

### B. packages/agent (all of it) + packages/llm/src/mock.ts + packages/llm/src/mock.test.ts
Implement the tools as in `R/diseño_kits.md` section 2 with the cuts above, using the API names
verified in `R/mapa_agente_mineflayer.md`. `kitToolNames(kit)` filters the tools offered to the LLM;
a tool that is not in the kit returns "tu kit no tiene esa herramienta; usa: <lista>" and keeps the
current mode. `parseToolArgs` gains `target` ("rival" default | "away"). System prompt: generate the
HERRAMIENTAS list from the kit's tools and add a "TU KIT" section (items with counts and
enchantments, effects, one line of mechanics per offered tool); do not put the kit name or
description in it. Observation: add `pearlCooldown` (seconds, only when above 0) and
`buildCooldown` likewise. `pearlPitch` is a pure, tested function in aim.ts.
IMPORTANT: prompt.ts in this working copy says "arena cerrada" on the first line of the prompt;
another checkout has an uncommitted one-word change on that line. Do not modify that line.
Mock LLM (mock.ts): restrict the style detection to the text between <estrategia> and </estrategia>;
keep choosing only among offered tools; add deterministic use of the new tools when they are offered
so a mock fight exercises them (for example: `pearl` target "rival" when the rival is farther than
8 blocks and health is above 8; `pearl` target "away" when health is low and food can be eaten;
`build` when the rival is between 5 and 10 blocks away and health is below 12, at most when the
observation shows no build cooldown). Keep MOCK_TOOL_NAMES consistent. Update and extend tests
(tools, prompt, observation, aim, mock). Existing tests must keep passing with the classic kit.

### C. apps/web (all of it)
Follow `R/mapa_web.md`. Kit UI inside each editor, between the textarea and the model row: a
labelled `<select id="kit-{side}">` (options from KIT_LIST), a one-line muted description, and
below it the inventory: a Minecraft-style panel with the 4 armour slots and the 9 hotbar slots
(empty slots drawn empty, counts in the corner when above 1, enchanted items with a subtle glint or
marker, tooltip = `kitItemTitle`), plus the kit's permanent effects as small chips ("Velocidad I").
The grid re-renders when the dropdown changes, before saving. Use approach C of the report: a pure
TS module with the icon grids + materials + run merging, used by PixelIcon.astro at build time and by
a client helper at run time; an `itemIcon(minecraftId)` mapping shared with the scoreboard held-item
slot (replace the three hardcoded held icons). Icons needed: sword, axe, bow, arrow, steak, golden
apple, ender pearl, block tile, helmet, chestplate, leggings, boots; materials iron, stone, diamond,
wood, chainmail. Draft pixel grids are in the report (section 2); fix any row that is not exactly
11 characters. Actions: one table in actions.ts with label + icon per tool, including `pearl`
("Lanza una perla") and `build` ("Construye un muro"), neutral label for attack.
Providers: remove the provider select, the free-text model id and the "Avanzado" block (keep the
state in the script; remember byId() throws on a missing id, so remove every matching lookup).
Model picker: "Por defecto del servidor", "Simulado" and the list from `GET /api/models` (through
api.ts so the ?mock maqueta mode can answer it), showing each model's price as a hint; no free-text
id. catalog.ts no longer calls Vercel from the browser. models.ts: PROVIDER_LABEL only mock and
vercel; keep the brand logos (they are model creators, not connections). Maqueta (mock.ts): kits in
the configs, `/api/models` route, defaults with two providers. Save sends `kit` always.
The conflict logic of prompts.ts must treat `kit` like the other fields (see the two traps in the report).
Keep the look consistent with global.css tokens; the page must not scroll sideways because of the new block.

### D. Docs and config
README.md, docs/ARQUITECTURA.md, .env.example, docker-compose.yml (remove the four key variables),
apps/camera/README.md if it mentions providers, scripts/smoke.sh (add a `GET /api/models` check that
expects a non-empty list; keep everything else working). Document: the six kits (a table), the two
new tools, the price cap and `/api/models`, only-Vercel configuration. Remove stale counts of tests
rather than guessing new numbers.
