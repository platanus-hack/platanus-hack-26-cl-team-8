/* eslint-disable @typescript-eslint/no-explicit-any */
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import type { Bot } from "mineflayer";
import { SIDES, type Side } from "@phack/protocol";
import { activeArena } from "./arena";
import type { Vec } from "./director";
import { errorText, FatalError, log } from "./log";

/**
 * Todo lo que toca three / prismarine-viewer / WebGL vive en este archivo.
 *
 * Está modelado sobre `lib/headless.js` de prismarine-viewer (v1.33), pero con
 * nuestro propio loop: en vez de sacar JPEGs del canvas, leemos el framebuffer
 * con gl.readPixels y se lo pasamos crudo a ffmpeg (ver ffmpeg.ts).
 *
 * IMPORTS: three (0.128, la versión exacta que fija prismarine-viewer),
 * node-canvas-webgl y prismarine-viewer son CommonJS y además exigen un orden
 * de carga (hay que definir los globales THREE y Worker ANTES de cargar el
 * viewer), así que se cargan con createRequire y no con `import`. Ninguno trae
 * tipos, por eso aquí se usa `any` de forma acotada.
 */
const nodeRequire = createRequire(import.meta.url);

/** Campo de visión vertical de la cámara, en grados. */
const FOV_DEGREES = 60;
/** Altura sobre los pies del peleador a la que flota su marcador de color. */
const MARKER_HEIGHT = 3.1;
const MARKER_COLORS: Record<Side, number> = { red: 0xe53935, blue: 0x1e88e5 };

export type WorldHandle = {
  /** Vuelve a pedir todos los chunks cercanos (por si llegaron tarde). */
  refresh(): void;
  /** Suelta los listeners del bot y vacía la escena. Idempotente. */
  detach(): void;
};

export interface Stage {
  /**
   * false hasta que el viewer recibe su primera versión de Minecraft (primer
   * attachWorld). Antes de eso no se debe llamar a update() ni render(): igual que
   * en headless.js, el viewer solo se usa después de setVersion().
   */
  readonly ready: boolean;
  /** Conecta el mundo del bot a la escena. Lanza FatalError si la versión no está soportada. */
  attachWorld(bot: Bot): WorldHandle;
  setCamera(position: Vec, lookAt: Vec): void;
  /** FOV vertical en grados (zoom). */
  setFov(degrees: number): void;
  /** `feet` = posición de los pies del peleador, o null para ocultar el marcador. */
  setMarker(side: Side, feet: Vec | null, timeSeconds: number): void;
  /** Avanza animaciones y sube a la GPU los chunks ya procesados, sin dibujar. */
  update(): void;
  /** Dibuja un frame y lo copia (RGBA, origen abajo-izquierda) en `target`. */
  render(target: Uint8Array): void;
}

type NativeModules = {
  THREE: any;
  createCanvas: (width: number, height: number) => any;
  Viewer: new (renderer: any) => any;
  WorldView: new (world: unknown, viewDistance: number, position: unknown) => any;
  Vec3: new (x: number, y: number, z: number) => unknown;
};

function loadNativeModules(): NativeModules {
  const globals = globalThis as unknown as Record<string, unknown>;

  let THREE: any;
  try {
    THREE = nodeRequire("three");
  } catch (err) {
    throw new FatalError(`No se pudo cargar 'three': ${errorText(err)}`);
  }
  // prismarine-viewer usa THREE como global y crea sus workers con `new Worker(ruta)`.
  globals.THREE = THREE;
  globals.Worker = Worker;

  // prismarine-viewer hace require('node-canvas-webgl/lib') y require('canvas') SIN
  // declararlos como dependencias (y se traga el error si faltan). Con pnpm eso solo
  // funciona gracias al hoisting interno (node_modules/.pnpm/node_modules). Lo
  // verificamos aquí para fallar con un mensaje claro y no con un TypeError raro.
  let fromViewer: ReturnType<typeof createRequire>;
  try {
    fromViewer = createRequire(nodeRequire.resolve("prismarine-viewer/package.json"));
  } catch (err) {
    throw new FatalError(`No se encontró 'prismarine-viewer': ${errorText(err)}`);
  }
  for (const dep of ["node-canvas-webgl/lib", "canvas"]) {
    try {
      fromViewer.resolve(dep);
    } catch {
      throw new FatalError(
        `prismarine-viewer no logra resolver '${dep}'. Revisa que pnpm no tenga 'hoist: false' ` +
          "(ver sección de problemas conocidos en apps/camera/README.md).",
      );
    }
  }
  try {
    if (fromViewer.resolve("three") !== nodeRequire.resolve("three")) {
      log("warn", "prismarine-viewer y la cámara resuelven copias distintas de 'three'; puede fallar el render.");
    }
  } catch {
    // solo es un diagnóstico
  }

  try {
    const { createCanvas } = nodeRequire("node-canvas-webgl/lib");
    const { Viewer, WorldView } = nodeRequire("prismarine-viewer/viewer");
    // vec3 es CommonJS (module.exports = función con .Vec3): se carga con require.
    const { Vec3 } = nodeRequire("vec3");
    return { THREE, createCanvas, Viewer, WorldView, Vec3 };
  } catch (err) {
    throw new FatalError(
      `No se pudieron cargar las librerías nativas de render (canvas / gl): ${errorText(err)}. ` +
        "Suele significar que faltan librerías del sistema o que 'canvas'/'gl' no se compilaron.",
    );
  }
}

/**
 * prismarine-viewer no trae datos de 1.20.4: `setVersion` la reemplaza por 1.20.1 y usa esa
 * versión también para DECODIFICAR los chunks en sus workers. Pero los ids de estado de
 * bloque cambiaron en 1.20.3 (bloques nuevos), así que casi todo se dibujaba como otro
 * bloque (el piso de piedra lisa salía como cubitos rosados). Las texturas y modelos se
 * buscan por NOMBRE de bloque, así que basta con que los workers decodifiquen con la
 * versión real del servidor y sigan usando los assets de 1.20.1.
 */
function useRealVersionInWorkers(viewer: any, realVersion: string): void {
  if (viewer.version === realVersion) return;
  const workers: any[] = viewer.world?.workers ?? [];
  if (workers.length === 0) {
    log("warn", "No se encontraron los workers del viewer: los bloques pueden verse mal.");
    return;
  }
  for (const worker of workers) worker.postMessage({ type: "version", version: realVersion });
  log("info", `Viewer: assets de ${String(viewer.version)}, chunks decodificados como ${realVersion}.`);
}

/**
 * El viewer hace console.log de un Error con stack cada vez que aparece una entidad que no
 * sabe dibujar (flechas, ítems en el suelo) y la reemplaza por un cubo. Es ruido: se filtra.
 */
function silenceUnknownEntityLogs(): void {
  const original = console.log.bind(console);
  console.log = (...args: unknown[]): void => {
    const first = args[0];
    if (first instanceof Error && first.message.startsWith("Unknown entity")) return;
    original(...args);
  };
}

export function createStage(opts: { width: number; height: number; viewDistance: number }): Stage {
  const { width, height, viewDistance } = opts;
  const { THREE, createCanvas, Viewer, WorldView, Vec3 } = loadNativeModules();
  silenceUnknownEntityLogs();

  let renderer: any;
  let gl: any;
  let viewer: any;
  try {
    const canvas = createCanvas(width, height);
    // Igual que headless.js: three pide el contexto al canvas de node-canvas-webgl,
    // que por debajo crea un contexto de headless-gl (necesita un servidor X: Xvfb).
    renderer = new THREE.WebGLRenderer({ canvas });
    gl = renderer.getContext();
    if (!gl) throw new Error("getContext() devolvió null");
    viewer = new Viewer(renderer);
  } catch (err) {
    throw new FatalError(
      `No se pudo crear el contexto WebGL headless: ${errorText(err)}. ` +
        "¿El proceso corre bajo xvfb-run y está instalado mesa (libgl1-mesa-dri)?",
    );
  }

  viewer.camera.fov = FOV_DEGREES;
  viewer.camera.aspect = width / height;
  viewer.camera.updateProjectionMatrix();

  // Marcadores de color sobre cada peleador: el viewer dibuja a todos los jugadores
  // con la misma skin, así que sin esto no se distingue quién es rojo y quién azul.
  const markers = {} as Record<Side, any>;
  for (const side of SIDES) {
    const mesh = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.35),
      new THREE.MeshBasicMaterial({ color: MARKER_COLORS[side] }),
    );
    mesh.visible = false;
    viewer.scene.add(mesh);
    markers[side] = mesh;
  }

  const ARENA = activeArena();
  const center = new Vec3(ARENA.center.x, ARENA.center.y, ARENA.center.z);
  let ready = false;

  return {
    get ready(): boolean {
      return ready;
    },

    attachWorld(bot: Bot): WorldHandle {
      let supported = false;
      let detail = "";
      try {
        // Para 1.20.4 el viewer usa los assets de 1.20.1 (la más cercana que trae).
        // Si la versión no existe, intenta window.alert y lanza: lo tratamos igual.
        supported = Boolean(viewer.setVersion(bot.version));
      } catch (err) {
        detail = ` (${errorText(err)})`;
      }
      if (!supported) {
        throw new FatalError(`prismarine-viewer no soporta la versión de Minecraft ${bot.version}${detail}`);
      }
      useRealVersionInWorkers(viewer, bot.version);
      ready = true;

      // Centrado en la arena (no en el bot): solo se dibujan los chunks cercanos al centro.
      const worldView = new WorldView(bot.world, viewDistance, center);
      viewer.listen(worldView);
      // Primero los listeners y después la carga inicial, para no perder chunks que
      // lleguen entremedio (cargar un chunk dos veces es inofensivo).
      worldView.listenToBot(bot);
      const loadAll = (force: boolean): void => {
        const pending: Promise<unknown> = force ? worldView.updatePosition(center, true) : worldView.init(center);
        Promise.resolve(pending).catch((err: unknown) => {
          log("warn", `No se pudieron cargar los chunks: ${errorText(err)}`);
        });
      };
      loadAll(false);

      let detached = false;
      return {
        refresh(): void {
          if (!detached) loadAll(true);
        },
        detach(): void {
          if (detached) return;
          detached = true;
          try {
            worldView.removeListenersFromBot(bot);
          } catch {
            // nunca alcanzó a escuchar al bot
          }
          try {
            worldView.removeAllListeners();
            viewer.resetAll();
          } catch (err) {
            log("warn", `No se pudo limpiar la escena: ${errorText(err)}`);
          }
        },
      };
    },

    setCamera(position: Vec, lookAt: Vec): void {
      viewer.camera.position.set(position.x, position.y, position.z);
      viewer.camera.lookAt(lookAt.x, lookAt.y, lookAt.z);
    },

    setFov(degrees: number): void {
      if (Math.abs(viewer.camera.fov - degrees) < 0.01) return;
      viewer.camera.fov = degrees;
      viewer.camera.updateProjectionMatrix();
    },

    setMarker(side: Side, feet: Vec | null, timeSeconds: number): void {
      const mesh = markers[side];
      if (!feet) {
        mesh.visible = false;
        return;
      }
      // Por si un reset de la escena lo hubiera sacado.
      if (mesh.parent !== viewer.scene) viewer.scene.add(mesh);
      mesh.visible = true;
      mesh.position.set(feet.x, feet.y + MARKER_HEIGHT, feet.z);
      mesh.rotation.y = timeSeconds * 2;
    },

    update(): void {
      viewer.update();
    },

    render(target: Uint8Array): void {
      viewer.update();
      renderer.render(viewer.scene, viewer.camera);
      gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, target);
    },
  };
}
