import { COMMS_LABELS, KITS, type AgentConfig, type AgentStatus, type MatchRecord, type Side, type TranscriptEntry } from "./index";

/**
 * Transcripción de una pelea como texto para leer: quién vio, pensó, dijo e hizo qué,
 * con el tiempo contado desde que empezó el duelo. El archivo JSONL sigue siendo el
 * registro completo (observaciones enteras, cambios de estado); esto es su resumen legible.
 */

const SIDE_NAME: Record<Side, string> = { red: "Rojo", blue: "Azul" };
const WHO_WIDTH = 6;

/** "1:05.3" desde el inicio del duelo; "prep" para lo que pasó antes de empezar. */
function clock(at: number, startedAt: number | null): string {
  if (startedAt === null || at < startedAt) return "prep".padStart(7);
  const tenths = Math.round((at - startedAt) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${tenths % 10}`.padStart(7);
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function short(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function modelLine(side: Side, config: AgentConfig): string {
  const model = config.model ? config.model : "modelo por defecto";
  const provider = config.provider ? ` (${config.provider})` : "";
  const kit = config.kit ? `, kit ${KITS[config.kit].name}` : "";
  return `${SIDE_NAME[side]}: ${model}${provider}${kit}`;
}

/** Lo que el agente tenía a la vista al decidir, sacado de la observación. */
function seen(observation: Record<string, unknown> | undefined): string {
  if (!observation) return "";
  const parts: string[] = [];
  const health = num(observation["health"]);
  if (health !== null) parts.push(`vida ${short(health)}`);
  const distance = num(observation["distance"]);
  const opponentHealth = num(observation["opponentHealth"]);
  if (distance === null) parts.push("no ve al rival");
  else parts.push(`rival a ${short(distance)}${opponentHealth !== null ? ` con vida ${short(opponentHealth)}` : ""}`);
  return parts.join(", ");
}

function resultLine(record: MatchRecord): string {
  const { winner, reason } = record.result;
  const length = clock(record.endedAt, record.startedAt).trim();
  if (winner && reason === "kill") return `Gana ${SIDE_NAME[winner]} por K.O. a los ${length}.`;
  if (winner && reason === "rounds" && record.series) {
    return `Gana ${SIDE_NAME[winner]} la serie: ${record.series.wins[winner]} rondas a ${record.series.wins[winner === "red" ? "blue" : "red"]}.`;
  }
  if (winner) return `Gana ${SIDE_NAME[winner]}: se acabó el tiempo y tenía más vida.`;
  if (reason === "draw" && record.series) return "Empate: la serie terminó con las mismas rondas ganadas.";
  if (reason === "draw") return "Empate: se acabó el tiempo con la misma vida.";
  if (reason === "stopped") return `Pelea detenida a los ${length}.`;
  return "La pelea terminó por un error.";
}

function finalLine(side: Side, agent: AgentStatus): string {
  const tokens = agent.tokensIn + agent.tokensOut;
  const parts = [
    `vida ${short(agent.health)}`,
    `daño hecho ${short(agent.damageDealt)}`,
    `${agent.decisions} decisiones`,
  ];
  if (agent.avgDecisionMs > 0) parts.push(`${short(agent.avgDecisionMs / 1000)} s por decisión`);
  if (tokens > 0) parts.push(`${agent.tokensIn} tokens de entrada y ${agent.tokensOut} de salida`);
  return `${SIDE_NAME[side]}: ${parts.join(", ")}.`;
}

export function formatTranscript(entries: TranscriptEntry[]): string {
  const out: string[] = [];
  // El reloj parte cuando la pelea pasa a "running"; antes de eso es preparación.
  const running = entries.find((entry) => entry.type === "phase" && entry.phase === "running");
  const startedAt = running ? running.at : null;

  const line = (at: number, who: Side | null, text: string): void => {
    out.push(`${clock(at, startedAt)}  ${(who ? SIDE_NAME[who] : "Arena").padEnd(WHO_WIDTH)}  ${oneLine(text)}`);
  };

  for (const entry of entries) {
    switch (entry.type) {
      case "start":
        out.push(`Pelea ${entry.matchId}`);
        out.push(
          `${new Date(entry.at).toISOString()}. ${entry.durationSeconds === null ? "Sin límite de tiempo" : `Dura hasta ${entry.durationSeconds} s`}; cada agente decide en cuanto responde, con al menos ${short(entry.tickMs / 1000)} s entre decisiones.`,
        );
        out.push("");
        for (const side of ["red", "blue"] as const) {
          out.push(modelLine(side, entry.configs[side]));
          out.push(`  Prompt: ${oneLine(entry.configs[side].prompt) || "(vacío)"}`);
        }
        out.push(`Comunicación: ${COMMS_LABELS[entry.settings.comms].name}.`);
        out.push("");
        break;
      case "decision": {
        const context = seen(entry.observation);
        const took = `decide en ${short(entry.ms / 1000)} s`;
        // Lo que no es "una herramienta" se dice: una respuesta puede traer varias o ninguna.
        const calls = entry.response?.toolCalls.map((call) => call.name) ?? null;
        const shape =
          calls === null || calls.length === 1
            ? ""
            : calls.length === 0
              ? "; no llama ninguna herramienta"
              : `; llama ${calls.length} herramientas: ${calls.join(", ")}`;
        line(entry.at, entry.side, `${context ? `ve: ${context}; ${took}` : took}${shape}`);
        break;
      }
      case "thought":
        line(entry.at, entry.side, `piensa: ${entry.text}`);
        break;
      case "action":
        line(entry.at, entry.side, `hace: ${entry.tool} → ${entry.result}`);
        break;
      case "message":
        line(entry.at, entry.side, `dice: «${entry.text}»`);
        break;
      case "damage":
        line(entry.at, entry.side, `recibe ${short(entry.amount)} de daño (queda con vida ${short(entry.health)})`);
        break;
      case "death":
        line(entry.at, entry.side, "cae en combate");
        break;
      case "injected":
        line(entry.at, entry.side, `recibe ${entry.kind === "injection" ? "una orden falsa" : "un aviso falso"}: «${entry.text}»`);
        break;
      case "round_start":
        out.push("");
        line(entry.at, null, `Empieza la ronda ${entry.round}.`);
        break;
      case "round_end": {
        const { result, series } = entry;
        const how =
          result.reason === "kill"
            ? "por K.O."
            : result.reason === "surrender"
              ? "porque el otro se rindió"
              : "por tener más vida al acabarse el tiempo";
        const outcome = result.winner ? `gana ${SIDE_NAME[result.winner]} ${how}` : "empate";
        line(entry.at, null, `Termina la ronda ${result.round}: ${outcome}. Serie: Rojo ${series.wins.red}, Azul ${series.wins.blue}.`);
        break;
      }
      case "log":
        line(entry.at, null, entry.level === "info" ? entry.text : `[${entry.level === "warn" ? "aviso" : "error"}] ${entry.text}`);
        break;
      case "end":
        out.push("");
        out.push(resultLine(entry.record));
        out.push(finalLine("red", entry.record.final.red));
        out.push(finalLine("blue", entry.record.final.blue));
        break;
      case "explanation":
        out.push(`Por qué: ${oneLine(entry.text)}`);
        break;
      // "phase" y "status" solo van en el JSONL: aquí serían ruido.
      case "phase":
      case "status":
        break;
    }
  }
  return `${out.join("\n")}\n`;
}
