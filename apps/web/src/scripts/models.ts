/**
 * Qué modelo usa cada agente y cómo mostrarlo: logo de la marca + nombre legible.
 *
 * El modelo real sale de la configuración del agente ({ provider?, model? }). Si alguno
 * viene vacío, vale el valor por defecto del servidor, que se pide una vez a
 * /api/defaults. Mientras no llega (o si falla), no se inventa nada: se muestra solo
 * lo que se sabe.
 */
import type { AgentConfig, Provider, ServerDefaults } from "@phack/protocol";
// Logos de @lobehub/icons-static-svg (MIT). Son archivos estáticos de confianza, por eso
// se insertan como SVG; todo texto que viene del usuario se sigue escribiendo con textContent.
import claudeIcon from "@lobehub/icons-static-svg/icons/claude-color.svg?raw";
import deepseekIcon from "@lobehub/icons-static-svg/icons/deepseek-color.svg?raw";
import cohereIcon from "@lobehub/icons-static-svg/icons/cohere-color.svg?raw";
import geminiIcon from "@lobehub/icons-static-svg/icons/gemini-color.svg?raw";
import grokIcon from "@lobehub/icons-static-svg/icons/grok.svg?raw";
import kimiIcon from "@lobehub/icons-static-svg/icons/kimi-color.svg?raw";
import metaIcon from "@lobehub/icons-static-svg/icons/meta-color.svg?raw";
import minimaxIcon from "@lobehub/icons-static-svg/icons/minimax-color.svg?raw";
import mistralIcon from "@lobehub/icons-static-svg/icons/mistral-color.svg?raw";
import novaIcon from "@lobehub/icons-static-svg/icons/nova-color.svg?raw";
import nvidiaIcon from "@lobehub/icons-static-svg/icons/nvidia-color.svg?raw";
import openaiIcon from "@lobehub/icons-static-svg/icons/openai.svg?raw";
import qwenIcon from "@lobehub/icons-static-svg/icons/qwen-color.svg?raw";
import zhipuIcon from "@lobehub/icons-static-svg/icons/zhipu-color.svg?raw";
import { el } from "./dom";

type Brand = { name: string; icon: string };

const BRANDS = {
  anthropic: { name: "Anthropic", icon: claudeIcon },
  openai: { name: "OpenAI", icon: openaiIcon },
  google: { name: "Google", icon: geminiIcon },
  meta: { name: "Meta", icon: metaIcon },
  xai: { name: "xAI", icon: grokIcon },
  mistral: { name: "Mistral", icon: mistralIcon },
  deepseek: { name: "DeepSeek", icon: deepseekIcon },
  alibaba: { name: "Alibaba", icon: qwenIcon },
  zai: { name: "Z.ai", icon: zhipuIcon },
  moonshot: { name: "Moonshot", icon: kimiIcon },
  minimax: { name: "MiniMax", icon: minimaxIcon },
  nvidia: { name: "NVIDIA", icon: nvidiaIcon },
  amazon: { name: "Amazon", icon: novaIcon },
  cohere: { name: "Cohere", icon: cohereIcon },
} satisfies Record<string, Brand>;

type BrandId = keyof typeof BRANDS;

/** Prefijo "creador/" de los ids de Vercel AI Gateway y OpenRouter. */
const CREATOR_BRAND: Record<string, BrandId> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  meta: "meta",
  "meta-llama": "meta",
  xai: "xai",
  "x-ai": "xai",
  mistral: "mistral",
  mistralai: "mistral",
  deepseek: "deepseek",
  spacexai: "xai",
  alibaba: "alibaba",
  zai: "zai",
  moonshotai: "moonshot",
  minimax: "minimax",
  nvidia: "nvidia",
  amazon: "amazon",
  cohere: "cohere",
};

/** Para ids sin prefijo (API directa de un laboratorio): se reconoce por el nombre. */
const NAME_BRAND: [RegExp, BrandId][] = [
  [/^claude/, "anthropic"],
  [/^(gpt|chatgpt|o\d)/, "openai"],
  [/^gemini/, "google"],
  [/llama/, "meta"],
  [/^grok/, "xai"],
  [/^(mistral|mixtral|codestral|magistral)/, "mistral"],
  [/^deepseek/, "deepseek"],
];

const PROVIDER_LABEL: Record<Provider, string> = {
  mock: "Simulado",
  vercel: "Vercel AI Gateway",
  openai: "OpenAI",
  anthropic: "Anthropic",
  openrouter: "OpenRouter",
  gateway: "Vercel AI Gateway",
};

export type ModelInfo = {
  /** Nombre para mostrar: "Claude Haiku 5.5". */
  name: string;
  /** Detalle para el tooltip: "Vercel AI Gateway · anthropic/claude-haiku-5.5". */
  detail: string;
  brand: Brand | null;
};

function brandFor(provider: Provider | undefined, model: string): Brand | null {
  const id = model.toLowerCase();
  const slash = id.indexOf("/");
  if (slash > 0) {
    const creator = CREATOR_BRAND[id.slice(0, slash)];
    return creator ? BRANDS[creator] : null;
  }
  if (provider === "anthropic") return BRANDS.anthropic;
  if (provider === "openai") return BRANDS.openai;
  for (const [pattern, brand] of NAME_BRAND) {
    if (pattern.test(id)) return BRANDS[brand];
  }
  return null;
}

/** "anthropic/claude-haiku-5-5" -> "Claude Haiku 5.5"; "openai/gpt-6-luna" -> "GPT-6 Luna". */
export function prettyModel(id: string): string {
  const base = id.slice(id.lastIndexOf("/") + 1);
  const out: string[] = [];
  for (const token of base.split(/[-_]/)) {
    if (token === "") continue;
    const last = out[out.length - 1];
    const numeric = /^\d+(\.\d+)?$/.test(token);
    // Fechas de versión (20260115): no aportan al nombre.
    if (/^\d{8}$/.test(token)) continue;
    if (numeric && last === "GPT") out[out.length - 1] = `GPT-${token}`;
    else if (numeric && last !== undefined && /^\d+$/.test(last)) out[out.length - 1] = `${last}.${token}`;
    else if (token.toLowerCase() === "gpt") out.push("GPT");
    else if (/^[a-z]+$/.test(token)) out.push(token.charAt(0).toUpperCase() + token.slice(1));
    else out.push(token);
  }
  return out.join(" ") || id;
}

// ---------- Valores por defecto del servidor ----------

let defaults: ServerDefaults | null = null;
const listeners: (() => void)[] = [];

/** Avisa cuando llegan los valores por defecto, para volver a dibujar lo que dependa de ellos. */
export function onDefaultsChange(listener: () => void): void {
  listeners.push(listener);
}

export function setDefaults(next: ServerDefaults): void {
  defaults = next;
  for (const listener of listeners) listener();
}

/**
 * Resuelve qué modelo corresponde a una configuración. Devuelve null si no hay cómo
 * saberlo todavía (config sin modelo y sin valores por defecto del servidor).
 */
export function resolveModel(config: Pick<AgentConfig, "provider" | "model">): ModelInfo | null {
  const provider = config.provider ?? defaults?.provider;
  const model = config.model?.trim() || (provider ? defaults?.models[provider] : undefined) || "";

  if (provider === "mock") return { name: "Simulado", detail: "LLM simulado, sin llamadas a ninguna API", brand: null };
  if (model === "") {
    if (!provider) return null;
    return { name: PROVIDER_LABEL[provider], detail: "Modelo por defecto del proveedor", brand: null };
  }
  const detail = provider ? `${PROVIDER_LABEL[provider]} · ${model}` : model;
  return { name: prettyModel(model), detail, brand: brandFor(provider, model) };
}

/**
 * Proveedor con el que se pide un modelo del catálogo de Vercel AI Gateway (ids
 * "creador/modelo"): el del servidor si ya es de ese tipo; si no, "vercel".
 */
export function gatewayProvider(): Provider {
  const provider = defaults?.provider;
  return provider === "vercel" || provider === "gateway" || provider === "openrouter" ? provider : "vercel";
}

/** Un modelo del catálogo, para listarlo: nombre oficial si se conoce, y su marca. */
export function describeModel(id: string, name?: string): ModelInfo {
  return { name: name?.trim() || prettyModel(id), detail: id, brand: brandFor(undefined, id) };
}

// ---------- Dibujo ----------

function iconNode(svg: string): Element | null {
  const parsed = new DOMParser().parseFromString(svg, "image/svg+xml").documentElement;
  if (parsed.nodeName !== "svg") return null;
  parsed.setAttribute("aria-hidden", "true");
  parsed.removeAttribute("style");
  parsed.querySelector("title")?.remove();
  return document.importNode(parsed, true);
}

/** Escribe "logo + nombre" dentro de `target`. Con `info` null lo deja vacío. */
export function renderModelTag(target: HTMLElement, info: ModelInfo | null): void {
  const key = info ? `${info.brand?.name ?? ""}|${info.name}|${info.detail}` : "";
  // Los eventos de estado llegan varias veces por segundo: solo se redibuja si cambió.
  if (target.dataset.model === key) return;
  target.dataset.model = key;
  target.replaceChildren();
  target.hidden = info === null;
  if (!info) return;

  // Ayuda al pasar el mouse: qué proveedor e id exacto hay detrás del nombre.
  if (info.detail !== "") target.dataset.tip = `Modelo de este agente: ${info.detail}`;
  else delete target.dataset.tip;
  const icon = info.brand ? iconNode(info.brand.icon) : null;
  if (icon) {
    const holder = el("span", "model-tag__icon");
    holder.append(icon);
    target.append(holder);
  }
  target.append(el("span", "model-tag__name", info.name));
}
