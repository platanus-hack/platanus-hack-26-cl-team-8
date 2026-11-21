import {
  DEFAULT_PROMPTS,
  MAX_PROMPT_LENGTH,
  ProviderSchema,
  SIDES,
  UpdatePromptBodySchema,
  type AgentConfig,
  type PromptsResponse,
  type Side,
  type UpdatePromptBody,
} from "@phack/protocol";
import { describeError, fetchPrompts, savePrompt } from "./api";
import { byId, setText } from "./dom";
import { SIDE_LABEL } from "./format";
import { onDefaultsChange, renderModelTag, resolveModel } from "./models";
import { showToast } from "./toast";

/** Contenido de un editor tal como está en los campos del formulario. */
type Draft = { prompt: string; provider: string; model: string };

type Editor = {
  form: HTMLFormElement;
  textarea: HTMLTextAreaElement;
  provider: HTMLSelectElement;
  model: HTMLInputElement;
  /** Logo + nombre del modelo que usará este prompt, según lo elegido en el formulario. */
  modelTag: HTMLElement;
  count: HTMLElement;
  status: HTMLElement;
  save: HTMLButtonElement;
  conflict: HTMLElement;
  reload: HTMLButtonElement;
  /** Último valor que ESTA página escribió en los campos (base para detectar ediciones locales). */
  base: Draft;
  /** Último valor conocido del servidor. */
  remote: Draft | null;
  saving: boolean;
};

const EMPTY: Draft = { prompt: "", provider: "", model: "" };

let editors: Record<Side, Editor> | null = null;

function toDraft(config: AgentConfig): Draft {
  return {
    // El textarea normaliza los saltos de línea a \n; se normaliza igual para poder comparar.
    prompt: config.prompt.replace(/\r\n?/g, "\n"),
    provider: config.provider ?? "",
    model: config.model ?? "",
  };
}

function sameDraft(a: Draft, b: Draft): boolean {
  return a.prompt === b.prompt && a.provider === b.provider && a.model.trim() === b.model.trim();
}

function readDraft(editor: Editor): Draft {
  return { prompt: editor.textarea.value, provider: editor.provider.value, model: editor.model.value };
}

function writeDraft(editor: Editor, draft: Draft): void {
  if (editor.textarea.value !== draft.prompt) editor.textarea.value = draft.prompt;
  if (editor.provider.value !== draft.provider) editor.provider.value = draft.provider;
  if (editor.model.value !== draft.model) editor.model.value = draft.model;
  editor.base = draft;
}

function refresh(editor: Editor): void {
  const draft = readDraft(editor);
  const length = draft.prompt.length;
  setText(editor.count, `${length} / ${MAX_PROMPT_LENGTH}`);
  const provider = ProviderSchema.safeParse(draft.provider);
  renderModelTag(
    editor.modelTag,
    resolveModel({ provider: provider.success ? provider.data : undefined, model: draft.model }),
  );
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
 * si está escribiendo, NO se le pisa el texto y se ofrece cargarla a mano.
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

  const candidate: UpdatePromptBody = { prompt: sent.prompt };
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
    // Solo se reescriben los campos si el usuario no siguió escribiendo mientras se guardaba.
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
    provider: byId<HTMLSelectElement>(`provider-${side}`),
    model: byId<HTMLInputElement>(`model-${side}`),
    modelTag: byId(`editor-model-${side}`),
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
  editor.model.addEventListener("input", onInput);
  editor.provider.addEventListener("change", onInput);

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

export function initPrompts(): void {
  editors = { red: createEditor("red"), blue: createEditor("blue") };
  onDefaultsChange(() => {
    if (!editors) return;
    refresh(editors.red);
    refresh(editors.blue);
  });
}
