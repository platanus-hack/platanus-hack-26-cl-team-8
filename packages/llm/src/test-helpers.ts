import type { ToolDef } from "./types";

/** Solo para tests: las herramientas del kit clásico, con la forma que reciben los clientes. */
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
