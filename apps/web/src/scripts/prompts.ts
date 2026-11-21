import {
  DEFAULT_KIT,
  DEFAULT_PROMPTS,
  KITS,
  KitIdSchema,
  MAX_PROMPT_LENGTH,
  ProviderSchema,
  SIDES,
  UpdatePromptBodySchema,
  kitOf,
  type AgentConfig,
  type KitId,
  type PromptsResponse,
  type Side,
  type UpdatePromptBody,
} from "@phack/protocol";
import { describeError, fetchPrompts, savePrompt } from "./api";
import { notePresetPrompts } from "./presetpicker";
import { byId, setText } from "./dom";
import { SIDE_LABEL } from "./format";
import { renderInventory } from "./inventory";
import { createModelPicker } from "./modelpicker";
import { onDefaultsChange, renderModelTag, resolveModel } from "./models";
import { showToast } from "./toast";

/** Contenido de un editor: lo que hay en sus campos y lo elegido en el selector de modelo. */
type Draft = { prompt: string; provider: string; model: string; kit: KitId };

type Editor = {
  form: HTMLFormElement;
  textarea: HTMLTextAreaElement;
  /**
   * Proveedor y modelo elegidos. No tienen campo en el formulario: los escribe el
   * selector de modelo (modelpicker.ts) y se guardan aquí.
   */
  provider: string;
  model: string;
  kit: HTMLSelectElement;
  kitDescription: HTMLElement;
  /** Inventario dibujado del kit elegido en el desplegable. */
  inventory: HTMLElement;
  /** Logo + nombre del modelo que usará este prompt, según lo elegido en el selector. */
  modelTag: HTMLElement;
  count: HTMLElement;
  status: HTMLElement;
  save: HTMLButtonElement;
  conflict: HTMLElement;
  reload: HTMLButtonElement;
  /** Último valor que ESTA página escribió en el editor (base para detectar ediciones locales). */
  base: Draft;
  /** Último valor conocido del servidor. */
  remote: Draft | null;
  saving: boolean;
};

/**
 * Un editor recién cargado, antes de que llegue nada del servidor. El kit es el que el
 * desplegable trae marcado en index.astro: si fueran distintos, la primera carga del
 * servidor parecería una edición local y saldría el aviso de conflicto.
 */
const EMPTY: Draft = { prompt: "", provider: "", model: "", kit: DEFAULT_KIT };

let editors: Record<Side, Editor> | null = null;

function toDraft(config: AgentConfig): Draft {
  return {
    // El textarea normaliza los saltos de línea a \n; se normaliza igual para poder comparar.
    prompt: config.prompt.replace(/\r\n?/g, "\n"),
    provider: config.provider ?? "",
    model: config.model ?? "",
    // Sin kit (o con uno que esta página no conoce) vale el kit por defecto, igual que en el
    // servidor. El desplegable no puede mostrar un valor sin opción: quedaría "sin guardar" para siempre.
    kit: kitOf(config).id,
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return a.prompt === b.prompt && a.provider === b.provider && a.model.trim() === b.model.trim() && a.kit === b.kit;
}

function readDraft(editor: Editor): Draft {
  const kit = KitIdSchema.safeParse(editor.kit.value);
  return {
    prompt: editor.textarea.value,
    provider: editor.provider,
    model: editor.model,
    kit: kit.success ? kit.data : DEFAULT_KIT,
  };
}

function writeDraft(editor: Editor, draft: Draft): void {
  if (editor.textarea.value !== draft.prompt) editor.textarea.value = draft.prompt;
  editor.provider = draft.provider;
  editor.model = draft.model;
  if (editor.kit.value !== draft.kit) editor.kit.value = draft.kit;
  editor.base = draft;
}

function refresh(editor: Editor): void {
  const draft = readDraft(editor);
  const length = draft.prompt.length;
  setText(editor.count, `${length} / ${MAX_PROMPT_LENGTH}`);
  const provider = ProviderSchema.safeParse(draft.provider);
  renderModelTag(
    editor.modelTag,
    resolveModel({ provider: provider.success ? provider.data : undefined, model: draft.model }) ?? {
      name: "Por defecto del servidor",
      detail: "",
      brand: null,
    },
  );
  // El kit del desplegable se dibuja al elegirlo, antes de guardar.
  const kit = KITS[draft.kit];
  setText(editor.kitDescription, kit.description);
  renderInventory(editor.inventory, kit);
  editor.count.classList.toggle("is-over", length > MAX_PROMPT_LENGTH);
  editor.save.disabled = editor.saving || length > MAX_PROMPT_LENGTH;
  setText(editor.save, editor.saving ? "Guardando…" : "Guardar");

  const dirty = editor.remote !== null && !sameDraft(draft, editor.remote);
  editor.form.classList.toggle("is-dirty", dirty);
  if (dirty) {
    setText(editor.status, "Cambios sin guardar");
    editor.status.dataset.kind = "dirty";
  } else if (editor.status.dataset.kind === "dirty") {
    setText(editor.status, "");
    editor.status.dataset.kind = "";
  }
  // Si ya no hay diferencia con el servidor, no queda conflicto que resolver.
  if (!dirty) editor.conflict.hidden = true;
}

/**
 * Llega una versión del servidor (carga inicial, evento "prompts" o respuesta
 * de un guardado). Regla: si el usuario no ha tocado el editor se reemplaza;
 * si está escribiendo, NO se le pisa lo que lleva (texto, kit o modelo) y se
 * ofrece cargarla a mano.
 */
function applyRemote(editor: Editor, config: AgentConfig): void {
  const incoming = toDraft(config);
  const currentDraft = readDraft(editor);
  editor.remote = incoming;

  if (sameDraft(currentDraft, editor.base) || sameDraft(currentDraft, incoming)) {
    writeDraft(editor, incoming);
    editor.conflict.hidden = true;
  } else {
    editor.conflict.hidden = false;
  }
  refresh(editor);
}

export function applyRemotePrompts(prompts: PromptsResponse): void {
  notePresetPrompts(prompts);
  if (!editors) return;
  for (const side of SIDES) applyRemote(editors[side], prompts[side]);
}

export async function loadPrompts(): Promise<void> {
  try {
    applyRemotePrompts(await fetchPrompts());
  } catch (err) {
    showToast(`No se pudieron cargar los prompts: ${describeError(err)}`);
  }
}

async function save(side: Side, editor: Editor): Promise<void> {
  if (editor.saving) return;
  const sent = readDraft(editor);

  // El kit va siempre; proveedor y modelo solo si se eligió algo distinto de "por defecto".
  const candidate: UpdatePromptBody = { prompt: sent.prompt, kit: sent.kit };
  const provider = ProviderSchema.safeParse(sent.provider);
  if (provider.success) candidate.provider = provider.data;
  if (sent.model.trim() !== "") candidate.model = sent.model.trim();

  const body = UpdatePromptBodySchema.safeParse(candidate);
  if (!body.success) {
    showToast(`El prompt ${SIDE_LABEL[side]} no es válido (máximo ${MAX_PROMPT_LENGTH} caracteres).`);
    return;
  }

  editor.saving = true;
  refresh(editor);
  try {
    const saved = await savePrompt(side, body.data);
    const savedDraft = toDraft(saved);
    editor.remote = savedDraft;
    // Solo se reescribe el editor si el usuario no siguió cambiándolo mientras se guardaba.
    if (sameDraft(readDraft(editor), sent)) writeDraft(editor, savedDraft);
    editor.conflict.hidden = true;
    editor.status.dataset.kind = "ok";
    setText(editor.status, "Guardado. Se usará en la próxima pelea.");
  } catch (err) {
    editor.status.dataset.kind = "error";
    setText(editor.status, "No se guardó.");
    showToast(`No se pudo guardar el prompt ${SIDE_LABEL[side]}: ${describeError(err)}`);
  } finally {
    editor.saving = false;
    refresh(editor);
  }
}

function createEditor(side: Side): Editor {
  const editor: Editor = {
    form: byId<HTMLFormElement>(`editor-${side}`),
    textarea: byId<HTMLTextAreaElement>(`prompt-${side}`),
    provider: "",
    model: "",
    kit: byId<HTMLSelectElement>(`kit-${side}`),
    kitDescription: byId(`kit-description-${side}`),
    inventory: byId(`inv-${side}`),
    modelTag: byId(`picker-current-${side}`),
    count: byId(`count-${side}`),
    status: byId(`save-status-${side}`),
    save: byId<HTMLButtonElement>(`save-${side}`),
    conflict: byId(`conflict-${side}`),
    reload: byId<HTMLButtonElement>(`reload-${side}`),
    base: EMPTY,
    remote: null,
    saving: false,
  };

  editor.textarea.maxLength = MAX_PROMPT_LENGTH;
  editor.textarea.placeholder = DEFAULT_PROMPTS[side];

  const onInput = (): void => refresh(editor);
  editor.textarea.addEventListener("input", onInput);
  // "input" además de "change": con el teclado algunos navegadores avisan solo con uno de los dos.
  editor.kit.addEventListener("input", onInput);
  editor.kit.addEventListener("change", onInput);
  createModelPicker({
    side,
    getChoice: () => ({ provider: editor.provider, model: editor.model }),
    onPick: (choice) => {
      editor.provider = choice.provider;
      editor.model = choice.model;
      refresh(editor);
    },
  });

  editor.form.addEventListener("submit", (event) => {
    event.preventDefault();
    void save(side, editor);
  });
  editor.textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save(side, editor);
    }
  });
  editor.reload.addEventListener("click", () => {
    if (editor.remote) writeDraft(editor, editor.remote);
    editor.conflict.hidden = true;
    refresh(editor);
  });

  refresh(editor);
  return editor;
}

/**
 * Carga en un editor un prompt del historial (texto, modelo y kit), como cambios sin
 * guardar: no vale para la próxima pelea hasta que alguien presione Guardar.
 */
export function loadIntoEditor(side: Side, config: AgentConfig): void {
  if (!editors) return;
  const editor = editors[side];
  const draft = toDraft(config);
  editor.textarea.value = draft.prompt;
  editor.provider = draft.provider;
  editor.model = draft.model;
  editor.kit.value = draft.kit;
  refresh(editor);
  editor.form.scrollIntoView({ behavior: "smooth", block: "center" });
}

export function initPrompts(): void {
  editors = { red: createEditor("red"), blue: createEditor("blue") };
  onDefaultsChange(() => {
    if (!editors) return;
    refresh(editors.red);
    refresh(editors.blue);
  });
}
