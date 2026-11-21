import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TranscriptEntry } from "@phack/protocol";
import { errorMessage, type LogFn } from "./util";

/** Los ids de pelea son UUID (randomUUID). Cualquier otra cosa se rechaza: evita "../" en la ruta. */
const TRANSCRIPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTranscriptId(id: string): boolean {
  return TRANSCRIPT_ID.test(id);
}

/**
 * Transcripción de cada pelea: DATA_DIR/transcripts/<id>.jsonl, una entrada por línea,
 * escrita mientras la pelea ocurre. Las escrituras van en serie y en el orden en que se
 * pidieron; un fallo de disco se registra pero nunca rompe la pelea.
 */
export class TranscriptStore {
  private readonly dir: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    dataDir: string,
    private readonly log: LogFn,
  ) {
    this.dir = join(dataDir, "transcripts");
  }

  /** Agrega una entrada. No espera ni lanza: la escritura queda en cola. */
  append(matchId: string, entry: TranscriptEntry): void {
    if (!isTranscriptId(matchId)) {
      this.log("warn", `Id de pelea inválido para la transcripción: ${JSON.stringify(matchId)}`);
      return;
    }
    let line: string;
    try {
      line = `${JSON.stringify(entry)}\n`;
    } catch (err) {
      this.log("error", `No se pudo serializar una entrada de la transcripción: ${errorMessage(err)}`);
      return;
    }
    const file = this.file(matchId);
    this.chain = this.chain.then(async () => {
      try {
        await mkdir(this.dir, { recursive: true });
        await appendFile(file, line, "utf8");
      } catch (err) {
        // Sin pasar por el log de la pelea: eso volvería a escribir en la transcripción.
        this.log("error", `No se pudo escribir la transcripción de la pelea ${matchId}: ${errorMessage(err)}`);
      }
    });
  }

  /** El archivo tal cual (JSONL), o null si no existe o el id es inválido. Sirve con la pelea en curso. */
  async read(matchId: string): Promise<string | null> {
    if (!isTranscriptId(matchId)) return null;
    await this.flush();
    try {
      return await readFile(this.file(matchId), "utf8");
    } catch {
      return null;
    }
  }

  /** Espera a que terminen las escrituras pendientes. */
  flush(): Promise<void> {
    return this.chain;
  }

  private file(matchId: string): string {
    return join(this.dir, `${matchId}.jsonl`);
  }
}
