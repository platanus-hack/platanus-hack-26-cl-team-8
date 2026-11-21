/**
 * Pensar rápido al oír: un mensaje del rival hace que el agente decida de nuevo enseguida,
 * sin esperar el resto de su pausa entre decisiones. Solo lleva la cuenta; el bucle de
 * decisiones es el que duerme y despierta.
 *
 * - Si llega mientras el bucle duerme, hay que despertarlo ya.
 * - Si llega mientras hay una decisión en curso (el LLM todavía no responde), esa decisión
 *   no lo vio: la siguiente empieza apenas termine esta, sin dormir.
 *
 * Nunca hay dos decisiones a la vez, así que el agente decide como mucho una vez más por
 * cada tanda de mensajes que llega, y nunca más rápido de lo que responde el LLM.
 */
export class HearWake {
  private deciding = false;
  private pending = false;

  /** Empieza una decisión: lo que ya llegó entra en su observación. */
  beginDecision(): void {
    this.deciding = true;
    this.pending = false;
  }

  /** Terminó la decisión. true si llegó un mensaje mientras tanto: decidir otra vez sin dormir. */
  endDecision(): boolean {
    this.deciding = false;
    const again = this.pending;
    this.pending = false;
    return again;
  }

  /** Llegó un mensaje. true si el bucle está durmiendo y hay que despertarlo ahora. */
  heard(): boolean {
    if (this.deciding) {
      this.pending = true;
      return false;
    }
    return true;
  }
}
