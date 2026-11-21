import { loadConfig } from "./config";
import { errorText, log } from "./log";

/**
 * Punto de entrada de la cámara. Elige quién dibuja el video según CAMERA_MODE:
 *  - "client": el cliente real de Minecraft (infra/stream); aquí solo se vuela el bot cámara.
 *  - "viewer" (por defecto fuera de Docker): render propio con prismarine-viewer + ffmpeg.
 *
 * Los módulos se cargan con import() para que el modo "client" no arrastre el render
 * (three, headless-gl, canvas) ni necesite un DISPLAY.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  if (config.mode === "client") {
    const { runOperator } = await import("./operator");
    await runOperator(config);
    return;
  }
  // index.ts arranca solo al importarse.
  await import("./index");
}

main().catch((err: unknown) => {
  log("error", `Error irrecuperable: ${errorText(err)}`);
  process.exit(1);
});
