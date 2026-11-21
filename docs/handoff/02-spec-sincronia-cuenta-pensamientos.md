# SPEC 2: pensamientos en vivo a los lados, cuenta regresiva y sincronía con el video

Same working copy and the same hard rules as SPEC.md (read its "Hard rules" section first):
`/home/storrealbac/Desktop/phack2026-kits`. Nothing heavy runs on this PC.

The kits / models / providers change described in SPEC.md is ALREADY implemented in the working copy
(uncommitted). Build on top of it; read the current files, not your memory of the reports.

## Measured facts (taken today on the live site with a real fight)
- A game event appears on the viewer's screen 1.31 to 1.55 s after it happens on the server
  (mean about 1.43 s). The stream is LL-HLS from MediaMTX played with hls.js; the playlist carries
  `EXT-X-PROGRAM-DATE-TIME`, so `hls.playingDate` works.
- The page today applies an inconsistent delay to the telemetry: 0.24 s, 0.92 s, 1.05 s and 1.87 s were
  measured for four consecutive phase changes. So the health bars and the rest of the data run
  0.4 to 1.2 s AHEAD of the picture. Causes, in apps/web/src/scripts/main.ts (`receiveEvent`) and player.ts
  (`videoDelayMs`): the delay is sampled once when the event arrives and smoothed starting from 0 with a 0.2
  factor per event; the date-based delay ignores the time between the game event and the timestamp MediaMTX
  puts on the frame (the Minecraft client drawing it, the screen capture and the encoder: about 0.4 s).

## Shared contract added by this spec (packages/protocol/src/index.ts)
`MatchStateSchema` gains one field, tolerant like the other late additions:
```ts
  /**
   * Epoch ms en que termina la cuenta regresiva y empieza la pelea. Solo tiene valor durante la
   * fase "preparing", desde que los dos peleadores están listos; null el resto del tiempo.
   */
  countdownEndsAt: z.number().nullable().default(null),
```
And a constant next to it: `export const COUNTDOWN_SECONDS = 3;`

## 1. Sincronía (apps/web) — the queue becomes a clock
Replace "delay each event by an estimated number of ms" with "apply each event when the picture reaches it".
- `player.ts` exposes the stream clock:
  - `serverNow(): number` = `Date.now() + clockOffset`, where `clockOffset` is a robust estimate of
    (server clock − browser clock): the maximum of `event.at − Date.now()` over the events of the last
    ~30 s (the event that travelled fastest), not simply the last event.
  - `videoServerNow(): number` = the server time of the game moment that is on screen right now:
    - hls.js with dates: `hls.playingDate.getTime() − PIPELINE_MS`;
    - hls.js without dates: `serverNow() − (hls.latency * 1000 + FALLBACK_PIPELINE_MS)`;
    - native HLS (Safari): `video.getStartDate()` + currentTime when it is valid, else the live-edge distance as today;
    - no picture on screen (signal off, paused, maqueta without video): `serverNow()` (no delay).
    Always clamp the result to `[serverNow() − MAX_VIDEO_DELAY_MS, serverNow()]`.
  - `PIPELINE_MS`: default 400; build-time override `PUBLIC_STREAM_PIPELINE_MS`; run-time override with the
    URL parameter `?sync=<ms>` (for calibration; ignore values outside 0..5000).
- `main.ts`: events wait in arrival order and are applied when `event.at <= videoServerNow()`. Drain on a
  short timer (30 to 50 ms) and also right after an event arrives. Safeguards: an event never waits more
  than 6 s after it arrived (stalled or reloading video); order of arrival is always preserved; `prompts`
  events are still applied immediately; the start/stop buttons keep their instant response (flush the queue).
  The HTTP polling fallback (`pollState`) goes through the same path so it cannot overwrite newer data
  with an older state or jump ahead of the picture.
- Everything the viewer sees that is derived from time uses `videoServerNow()` instead of `Date.now()`:
  the match clock (remaining time), the countdown (section 2) and the "stale" fading of thoughts.
- Health bars must change in step with the hit on screen: keep the damage flash and the bar change in
  the same event application, and keep (or add) a short CSS transition (120 to 180 ms) so it reads as smooth.
- Debug hook for measuring: `window.__arenaSync = () => ({ serverNow, videoNow, delayMs, source, queued, pipelineMs })`
  with `source` one of "dates" | "latency" | "native" | "none". It must be cheap and side-effect free.
- The maqueta mode (`?mock`) keeps working: it has its own fake delay (`MOCK_VIDEO_DELAY_MS`); feed it through the same clock.

## 2. Cuenta regresiva
- Orchestrator (apps/orchestrator/src/match.ts and arena.ts): when both fighters are prepared, set
  `state.countdownEndsAt = now + COUNTDOWN_SECONDS * 1000`, broadcast the state right away (not waiting for
  the state throttle), wait until that instant (cancellable, as `runCountdown` is today), then clear it
  (null) in the same state update that switches the phase to "running". It is also null in idle, finished,
  and when a match is cancelled or fails during the countdown. `runCountdown` may change its signature;
  update its callers and tests. Nothing is shown inside the game.
- Web: a big centred overlay on the stage, in the pixel font already used by the clock, showing "3", "2",
  "1" and then "¡Pelea!" for about 0.8 s. The number is computed every animation frame from
  `countdownEndsAt − videoServerNow()`, so it is in step with the picture and with the first hit. Each
  number gets a small pop animation (respect `prefers-reduced-motion`) and a short beep; the existing
  start sound plays at zero (do not play it twice). Add the beep to sound.ts in the style of the existing
  synthesised sounds; it must respect the sound toggle. The overlay is `aria-hidden`; the phase label
  already tells screen readers what is happening. While the countdown runs, the phase label says "Cuenta regresiva".
- Maqueta: its fake match goes through a countdown too.

## 3. Pensamientos en vivo a los lados
Today the bottom corners of the stage (`.minds` in index.astro, `mind-{side}`, `thought-{side}`,
`action-{side}`, `action-label-{side}`, `action-result-{side}`; scoreboard.ts `applyThought` / `applyAction`)
show only the last thought plus a briefing of the last action and its result text. Replace that with a
live column of thoughts per agent, one on each side of the stage:
- Left side = Rojo, right side = Azul, overlaid on the video between the scoreboard and the bottom, each
  about `clamp(220px, 24vw, 340px)` wide, not capturing pointer events, legible over a bright picture
  (text shadow and/or a soft gradient backdrop, in the page's existing visual language).
- Each column is a stack of that agent's recent thoughts, newest at the bottom. Show up to 5; older
  ones get progressively dimmer and smaller and the oldest leaves with a short transition. A new thought
  enters with a typewriter reveal (about 25 ms per character, whole text within 1.2 s; instant when
  `prefers-reduced-motion`). If a new thought arrives while the previous one is still typing, the previous
  one completes instantly.
- Each thought carries a small chip with the action that came with it: the tool's pixel icon and its
  short label from actions.ts ("Ataca cuerpo a cuerpo", "Lanza una perla"...). The action event arrives
  right after the thought of the same side: attach it to the newest thought of that side if that thought
  has no chip yet and is less than 2 s old (stream clock); otherwise add an entry with only the chip.
  The result text of the action ("atacando: 2 golpes lanzados...") is NOT shown in the columns any more;
  it stays available as the chip's tooltip (`data-tip`) and in the events list below.
- The same thought text twice in a row for the same side does not add an entry: pulse the existing one.
- While the fight is running and the agent is alive, the bottom of its column shows a subtle "thinking"
  indicator (three pulsing dots) whenever its newest thought is older than 1.2 s; it disappears when the
  fight is not running. When a new fight starts preparing, both columns are emptied.
- Keep a visually hidden "último pensamiento" text per side for screen readers (no `aria-live` spam).
- Narrow screens (below about 700 px wide): show only the 2 newest thoughts per side, smaller.
- The start/stop buttons stay at the bottom centre and must not be covered.
- The "Eventos" list below the stage stays as it is (it is the detailed log).
- Thoughts and chips are applied through the synchronised queue of section 1, like every other event.
- Maqueta: its fake events must exercise the columns (thought + action pairs for both sides).
- Remember: byId() throws on a missing id, so remove every lookup of an id you delete, and keep the
  action labels/icons table in actions.ts as the single source.

## Areas
- X1 = packages/protocol + apps/orchestrator + README.md + docs: the countdown contract and orchestrator part,
  plus AMENDMENTS.md items 1 to 4, 11, 12 and 14 (and the tests that repeat kit data).
- X2 = packages/agent + packages/llm/src/mock.ts + mock.test.ts: AMENDMENTS.md items 5 to 10.
- X3a = apps/web, sections 1 and 2 of this spec (sync clock, queue, countdown overlay, beep) + AMENDMENTS item 13.
- X3b = apps/web, section 3 (thought columns), after X3a has finished.
