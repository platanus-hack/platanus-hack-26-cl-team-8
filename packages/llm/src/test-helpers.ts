import { vi } from "vitest";
import type { ToolDef } from "./types";

/** Solo para tests: reemplaza el fetch global y registra las llamadas. */

export type FetchReply = { status?: number; body: unknown };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FetchCall = { url: string; method: string; headers: Record<string, string>; body: any };

type Init = { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal };

/** Responde con `replies` en orden; la última se repite si hay más llamadas. */
export function stubFetch(replies: FetchReply[]): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal("fetch", async (url: string, init: Init) => {
    calls.push({ url, method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    if (!reply) throw new Error("stubFetch: sin respuestas configuradas");
    const text = typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
    return new Response(text, { status: reply.status ?? 200 });
  });
  return calls;
}

export const TOOLS: ToolDef[] = [
  { name: "approach", description: "Acercarse al rival", parameters: { type: "object", properties: {} } },
  { name: "attack", description: "Golpear al rival", parameters: { type: "object", properties: {} } },
  { name: "retreat", description: "Alejarse del rival", parameters: { type: "object", properties: {} } },
  { name: "shoot", description: "Disparar el arco", parameters: { type: "object", properties: {} } },
  { name: "eat", description: "Comer", parameters: { type: "object", properties: {} } },
  {
    name: "wait",
    description: "Esperar",
    parameters: {
      type: "object",
      properties: { seconds: { type: "number", minimum: 0.5 } },
      required: ["seconds"],
    },
  },
];
