import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseTranscript, kitOf, type Side, type TranscriptEntry } from "../packages/protocol/src/index";
import type { ChatMessage } from "../packages/llm/src/types";
import { buildTurnMessages, MAX_HISTORY_MESSAGES, trimHistory } from "../packages/agent/src/history";
import { jsonBytes, profileContext } from "../packages/agent/src/context-profile";
import { packWorld, type RawSpatialSnapshot } from "../packages/agent/src/spatial";
import { kitToolDefs } from "../packages/agent/src/tools";
import { QUEUED_RESULT } from "../packages/agent/src/plan";

const args = process.argv.slice(2);
const files = args.filter((arg) => !arg.startsWith("--"));
if (files.length === 0) throw new Error("Uso: pnpm profile:context /ruta/pelea.jsonl [otra.jsonl] [--json] [--assert-reduction=0.75]");
const thresholdArg = args.find((arg) => arg.startsWith("--assert-reduction="));
const threshold = thresholdArg ? Number(thresholdArg.split("=")[1]) : undefined;
if (threshold !== undefined && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) throw new Error("La reducción debe estar entre 0 y 1");

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return { mean: Math.round(values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length)), p90: sorted[Math.floor((sorted.length - 1) * 0.9)] ?? 0, max: sorted.at(-1) ?? 0 };
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }

function packedObservation(observation: Record<string, unknown>) {
  const world = observation.world;
  if (!record(world) || !Array.isArray(world.blocks)) return observation;
  return { ...observation, world: packWorld(world as unknown as RawSpatialSnapshot) };
}

function legacyTrim(messages: ChatMessage[]) {
  let start = Math.max(0, messages.length - MAX_HISTORY_MESSAGES);
  while (start < messages.length && messages[start]?.role !== "user") start++;
  return messages.slice(start);
}

function replay(entries: TranscriptEntry[], compressWorld: boolean, compactHistory: boolean) {
  const start = entries.find((entry) => entry.type === "start");
  if (!start || start.type !== "start") throw new Error("Falta la entrada start con los prompts y kits");
  const histories: Record<Side, ChatMessage[]> = { red: [], blue: [] };
  const result = [];
  for (const entry of entries) {
    if (entry.type !== "decision" || !entry.observation) continue;
    const side = entry.side;
    const observation = compressWorld ? packedObservation(entry.observation) : entry.observation;
    const json = JSON.stringify(observation);
    const tools = kitToolDefs(kitOf(start.configs[side]), start.settings.comms);
    const messages: ChatMessage[] = [{ role: "system", content: start.systemPrompts[side] }, ...histories[side], { role: "user", content: json }];
    result.push(profileContext(messages, tools));
    const response = {
      text: entry.response?.text ?? "",
      toolCalls: (entry.response?.toolCalls ?? []).map((call, index) => ({ ...call, id: `replay_${result.length}_${index}` })),
    };
    // Las transcripciones antiguas no guardaban el request exacto ni sus IDs/resultados.
    // Los mismos placeholders se usan en las cuatro variantes: la comparación aísla el contexto.
    const turn = buildTurnMessages(json, response, () => QUEUED_RESULT);
    if (!compactHistory) turn[0] = { role: "user", content: json };
    histories[side] = compactHistory ? trimHistory([...histories[side], ...turn], MAX_HISTORY_MESSAGES) : legacyTrim([...histories[side], ...turn]);
  }
  return result;
}

const reports = [];
for (const file of files) {
  const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
  const entries = parseTranscript(await readFile(path, "utf8"));
  const decisions = entries.filter((entry) => entry.type === "decision");
  if (!decisions.length) throw new Error(`Sin decisiones válidas: ${file}`);
  const baseline = replay(entries, false, false);
  const worldOnly = replay(entries, true, false);
  const historyOnly = replay(entries, false, true);
  const optimized = replay(entries, true, true);
  const input = decisions.flatMap((entry) => entry.tokensIn === undefined ? [] : [entry.tokensIn]);
  const output = decisions.flatMap((entry) => entry.tokensOut === undefined ? [] : [entry.tokensOut]);
  const oldMean = stats(baseline.map((profile) => profile.totalBytes)).mean;
  const newMean = stats(optimized.map((profile) => profile.totalBytes)).mean;
  const fields = new Map<string, number>();
  for (const profile of baseline) for (const [key, bytes] of Object.entries(profile.observationFields)) fields.set(key, (fields.get(key) ?? 0) + bytes);
  const live = decisions.flatMap((entry) => entry.contextProfile ? [entry.contextProfile] : []);
  const report = {
    file, decisions: decisions.length,
    measured: { callsWithUsage: input.length, totalInputTokens: input.reduce((a, b) => a + b, 0), totalOutputTokens: output.reduce((a, b) => a + b, 0), inputTokensPerCall: stats(input), recordedContextBytes: live.length ? stats(live.map((profile) => profile.totalBytes)) : null },
    replayBytesPerCall: { baseline: stats(baseline.map((p) => p.totalBytes)), worldOnly: stats(worldOnly.map((p) => p.totalBytes)), historyOnly: stats(historyOnly.map((p) => p.totalBytes)), optimized: stats(optimized.map((p) => p.totalBytes)) },
    meanReduction: Number((1 - newMean / oldMean).toFixed(4)),
    observationFieldsMeanBytes: Object.fromEntries([...fields].sort((a, b) => b[1] - a[1]).map(([key, value]) => [key, Math.round(value / baseline.length)])),
    optimizedMeanComponentsBytes: Object.fromEntries((["systemBytes", "toolsBytes", "historyBytes", "observationBytes"] as const).map((key) => [key, stats(optimized.map((p) => p[key])).mean])),
    note: "Los tokens measured son reales del proveedor. Replay mide bytes UTF-8 del contexto normalizado; reconstruye IDs/resultados de herramientas ausentes en transcripciones antiguas y conserva el prompt original para aislar cambios. La reducción de bytes no es una cotización ni una medición nueva de tokens facturados. No llama al modelo.",
  };
  reports.push(report);
  if (threshold !== undefined && report.meanReduction < threshold) process.exitCode = 1;
}
if (args.includes("--json")) process.stdout.write(`${JSON.stringify(reports, null, 2)}\n`);
else for (const report of reports) {
  process.stdout.write(`${report.file}: ${report.decisions} decisiones; ${report.measured.totalInputTokens.toLocaleString("en-US")} tokens de entrada medidos\n`);
  for (const [variant, values] of Object.entries(report.replayBytesPerCall)) process.stdout.write(`  ${variant}: media ${values.mean} B; p90 ${values.p90} B; máximo ${values.max} B\n`);
  process.stdout.write(`  Reducción media del replay: ${(report.meanReduction * 100).toFixed(1)}%\n${report.note}\n`);
}
