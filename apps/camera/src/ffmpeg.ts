import { spawn, type ChildProcess } from "node:child_process";
import { errorText, log } from "./log";

export type FfmpegOptions = {
  width: number;
  height: number;
  fps: number;
  rtmpUrl: string;
  bitrateKbps: number;
  silentAudio: boolean;
  /** Se llama cuando no tiene sentido reintentar (p. ej. ffmpeg no está instalado). */
  onFatal(message: string): void;
};

/** Si ffmpeg no consume un frame en este tiempo lo damos por colgado y lo matamos. */
const STALL_MS = 15_000;
const MIN_RESTART_MS = 1_000;
const MAX_RESTART_MS = 10_000;
/** Si ffmpeg vivió al menos esto, el próximo reinicio vuelve a ser rápido. */
const HEALTHY_RUN_MS = 30_000;

/**
 * Argumentos de ffmpeg: entra video crudo RGBA por stdin (tal como sale de
 * gl.readPixels, es decir, con el origen abajo: por eso el `vflip`) y sale
 * H.264 en FLV hacia RTMP.
 *
 * - `-use_wallclock_as_timestamps 1`: cada frame se marca con la hora en que llegó.
 *   Así, si el render va más lento que CAMERA_FPS o botamos frames, el video sigue
 *   en tiempo real (no "cámara rápida" ni un stream que se atrasa).
 * - filtro `fps`: rellena duplicando frames para entregar un framerate constante,
 *   que es lo que esperan RTMP/HLS.
 * - `-g fps`: un keyframe por segundo, para segmentos HLS cortos.
 */
export function buildFfmpegArgs(opts: Omit<FfmpegOptions, "onFatal">): string[] {
  const fps = String(opts.fps);
  const bitrate = `${opts.bitrateKbps}k`;
  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-nostats",
    // --- entrada 0: frames crudos por stdin ---
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgba",
    "-s",
    `${opts.width}x${opts.height}`,
    "-use_wallclock_as_timestamps",
    "1",
    "-i",
    "pipe:0",
  ];
  if (opts.silentAudio) {
    // --- entrada 1 (opcional): silencio ---
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100");
  }
  args.push(
    "-vf",
    `vflip,fps=${fps},format=yuv420p`,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-g",
    fps,
    "-keyint_min",
    fps,
    "-sc_threshold",
    "0",
    "-b:v",
    bitrate,
    "-maxrate",
    bitrate,
    "-bufsize",
    `${opts.bitrateKbps * 2}k`,
  );
  if (opts.silentAudio) {
    args.push("-c:a", "aac", "-b:a", "64k", "-ar", "44100");
  } else {
    args.push("-an");
  }
  args.push("-f", "flv", opts.rtmpUrl);
  return args;
}

/**
 * Mantiene vivo un proceso ffmpeg y le entrega frames con contrapresión:
 * solo hay UN frame en vuelo a la vez. Mientras ffmpeg no lo haya consumido,
 * `canWrite` es false y quien renderiza debe botar el frame (no se acumula nada
 * en memoria).
 */
export class FfmpegStreamer {
  private proc: ChildProcess | null = null;
  private busy = false;
  private busySince = 0;
  private startedAt = 0;
  private restartDelay = MIN_RESTART_MS;
  private restartTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private readonly args: string[];

  constructor(private readonly opts: FfmpegOptions) {
    this.args = buildFfmpegArgs(opts);
  }

  start(): void {
    if (this.stopped || this.proc) return;
    log("info", `Iniciando ffmpeg -> ${this.opts.rtmpUrl}`);
    const proc = spawn("ffmpeg", this.args, { stdio: ["pipe", "ignore", "pipe"] });
    this.proc = proc;
    this.busy = false;
    this.startedAt = Date.now();

    proc.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        this.opts.onFatal("No se encontró el binario 'ffmpeg' en el PATH.");
        return;
      }
      log("error", `Error del proceso ffmpeg: ${errorText(err)}`);
      this.handleExit(proc, null, null);
    });

    // EPIPE cuando ffmpeg muere con un frame a medio escribir: se maneja en "exit".
    proc.stdin?.on("error", () => {});

    let pending = "";
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n|\r/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim() !== "") log("warn", `[ffmpeg] ${line.trim()}`);
      }
    });

    proc.on("exit", (code, signal) => {
      if (pending.trim() !== "") log("warn", `[ffmpeg] ${pending.trim()}`);
      this.handleExit(proc, code, signal);
    });
  }

  private handleExit(proc: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void {
    if (this.proc !== proc) return;
    this.proc = null;
    this.busy = false;
    if (this.stopped) return;

    const ranMs = Date.now() - this.startedAt;
    if (ranMs >= HEALTHY_RUN_MS) this.restartDelay = MIN_RESTART_MS;
    const delay = this.restartDelay;
    this.restartDelay = Math.min(MAX_RESTART_MS, this.restartDelay * 2);
    log(
      "warn",
      `ffmpeg terminó (código ${code ?? "-"}, señal ${signal ?? "-"}) tras ${Math.round(ranMs / 1000)} s. ` +
        `Reintentando en ${delay} ms (¿está arriba MediaMTX en ${this.opts.rtmpUrl}?).`,
    );
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, delay);
  }

  /** true si se puede entregar un frame ahora mismo. */
  get canWrite(): boolean {
    const proc = this.proc;
    if (!proc || !proc.stdin || proc.stdin.destroyed || !proc.stdin.writable) return false;
    if (this.busy) {
      if (Date.now() - this.busySince > STALL_MS) {
        log("warn", `ffmpeg no consume frames hace ${STALL_MS / 1000} s; se reinicia.`);
        this.busySince = Date.now();
        proc.kill("SIGKILL");
      }
      return false;
    }
    return true;
  }

  /**
   * Entrega un frame completo (width*height*4 bytes RGBA). Devuelve false si se
   * descartó. IMPORTANTE: el buffer NO se copia; quien llama no debe modificarlo
   * hasta que `canWrite` vuelva a ser true.
   */
  write(frame: Buffer): boolean {
    if (!this.canWrite) return false;
    const proc = this.proc;
    const stdin = proc?.stdin;
    if (!proc || !stdin) return false;
    this.busy = true;
    this.busySince = Date.now();
    stdin.write(frame, () => {
      // Se llama cuando el frame terminó de escribirse (o falló). Si mientras tanto
      // ffmpeg fue reemplazado, el estado ya lo reinició handleExit/start.
      if (this.proc === proc) this.busy = false;
    });
    return true;
  }

  /** Detiene ffmpeg y no lo vuelve a levantar. Idempotente. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const proc = this.proc;
    if (!proc) return;
    await new Promise<void>((resolve) => {
      const killTimer = setTimeout(() => {
        proc.kill("SIGKILL");
        resolve();
      }, 2_000);
      proc.once("exit", () => {
        clearTimeout(killTimer);
        resolve();
      });
      try {
        proc.stdin?.end();
      } catch {
        // ya estaba cerrado
      }
      proc.kill("SIGTERM");
    });
  }
}
