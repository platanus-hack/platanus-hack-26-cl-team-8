import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import type { MatchAttempt, TournamentReport, TournamentSummary } from "@phack/protocol";
import type { Hub } from "./hub";
import { buildServer, type ServerDeps } from "./server";
import { createTournamentReader } from "./tournament";
import { REF_KEY, fakeConfig, tempDataDir } from "./tournament/fixtures";
import { runTournament } from "./tournament/runner";
import { createSimRunner } from "./tournament/sim";
import { FileTournamentStore, acquireLock } from "./tournament/store";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

function deps(tournaments: ServerDeps["tournaments"]): ServerDeps & { started: () => number } {
  let started = 0;
  const state = { id: "", phase: "idle" } as never;
  return {
    hub: { add: () => {}, broadcast: () => {} } as unknown as Hub,
    match: {
      getState: () => state,
      start: () => {
        started++;
        return state;
      },
      stop: async () => state,
    },
    prompts: { get: () => ({}) as never, update: async () => ({}) as never },
    history: { latest: () => [] },
    defaults: { provider: "mock", models: {} } as never,
    tournaments,
    started: () => started,
  };
}

async function setupTournament(): Promise<{ dir: string; id: string }> {
  const dir = await tempDataDir();
  dirs.push(dir);
  const store = new FileTournamentStore(dir);
  const config = fakeConfig(3);
  await store.create(config, "{}");
  await runTournament(store, config.id, createSimRunner());
  return { dir, id: config.id };
}

describe("rutas del torneo", () => {
  it("lista, reporte y pareja con keys codificadas (traen /)", async () => {
    const { dir, id } = await setupTournament();
    const app = await buildServer(deps(createTournamentReader(dir)));
    try {
      const list = await app.inject({ method: "GET", url: "/api/tournaments" });
      expect(list.statusCode).toBe(200);
      const summaries = list.json() as TournamentSummary[];
      expect(summaries.map((s) => s.id)).toEqual([id]);
      expect(summaries[0]!.stage).toBe("done");

      const rep = await app.inject({ method: "GET", url: `/api/tournaments/${id}` });
      expect(rep.statusCode).toBe(200);
      const report = rep.json() as TournamentReport;
      expect(report.config.id).toBe(id);
      expect(report.standings.length).toBeGreaterThan(1);

      const b = "lab/m00";
      const url = `/api/tournaments/${id}/pairs/${encodeURIComponent(b)}/${encodeURIComponent(REF_KEY)}`;
      const pair = await app.inject({ method: "GET", url });
      expect(pair.statusCode).toBe(200);
      const attempts = pair.json() as MatchAttempt[];
      expect(attempts.length).toBeGreaterThan(0);
      for (const a of attempts) expect([a.spec.a, a.spec.b].sort()).toEqual([REF_KEY, b].sort());

      expect((await app.inject({ method: "GET", url: "/api/tournaments/no-existe" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/tournaments/no-existe/pairs/a/b" })).statusCode).toBe(404);
      expect((await app.inject({ method: "GET", url: "/api/tournaments/..%2F..%2Fetc" })).statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("sin DATA_DIR de torneos responde lista vacía", async () => {
    const app = await buildServer(deps(undefined));
    try {
      const list = await app.inject({ method: "GET", url: "/api/tournaments" });
      expect(list.json()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("409 al iniciar una pelea mientras un torneo tiene el lock", async () => {
    const dir = await tempDataDir();
    dirs.push(dir);
    const d = deps(createTournamentReader(dir));
    const app = await buildServer(d);
    try {
      const release = await acquireLock(dir, "t-vivo");
      const busy = await app.inject({ method: "POST", url: "/api/match/start" });
      expect(busy.statusCode).toBe(409);
      expect(busy.json().message).toContain("t-vivo");
      expect(d.started()).toBe(0);
      await release();
      const ok = await app.inject({ method: "POST", url: "/api/match/start" });
      expect(ok.statusCode).toBe(200);
      expect(d.started()).toBe(1);
    } finally {
      await app.close();
    }
  });
});
