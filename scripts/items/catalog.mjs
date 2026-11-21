#!/usr/bin/env node
/**
 * Catálogo completo de ítems de Minecraft 1.20.4, con imagen y nombre en español.
 *
 *   node scripts/items/catalog.mjs            # usa lo descargado si ya está
 *   node scripts/items/catalog.mjs --refresh  # vuelve a descargar del servidor de Mojang
 *
 * De dónde sale cada cosa:
 * - ids, nombre en inglés, stack y si es bloque: minecraft-data (dependencia de mineflayer).
 * - nombre en español: el archivo de idioma es_es.json del juego.
 * - imagen: las texturas del cliente oficial (el .jar de la versión), en item/ o block/.
 *
 * Lo descargado queda en .local/minecraft-assets/ (ignorado por git). Escribe:
 * - docs/items/minecraft-items-1.20.4.json   el catálogo (sí va al repo: solo texto).
 * - apps/web/public/items/<id>.png           las imágenes (NO van al repo: son de Mojang).
 * La página /items del sitio dibuja el catálogo con sus imágenes.
 */
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = "1.20.4";
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const CACHE = join(ROOT, ".local/minecraft-assets", VERSION);
const OUT_JSON = join(ROOT, "docs/items", `minecraft-items-${VERSION}.json`);
const OUT_IMAGES = join(ROOT, "apps/web/public/items");
const MANIFEST = "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const RESOURCES = "https://resources.download.minecraft.net";
const refresh = process.argv.includes("--refresh");

/** minecraft-data no es dependencia directa de nadie: se llega a ella a través de mineflayer. */
function loadMinecraftData() {
  const fromAgent = createRequire(join(ROOT, "packages/agent/package.json"));
  const fromMineflayer = createRequire(fromAgent.resolve("mineflayer"));
  return fromMineflayer("minecraft-data")(VERSION);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
  return res.json();
}

async function download(url, path) {
  if (!refresh && (await exists(path))) return;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} respondió ${res.status}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, Buffer.from(await res.arrayBuffer()));
}

/** Baja el cliente y el archivo de idioma, y extrae las texturas de ítems y bloques. */
async function fetchAssets() {
  const jar = join(CACHE, "client.jar");
  const lang = join(CACHE, "es_es.json");
  const textures = join(CACHE, "assets/minecraft/textures");
  if (refresh || !(await exists(jar)) || !(await exists(lang))) {
    console.log(`Descargando el cliente ${VERSION} y el idioma es_es desde Mojang…`);
    const manifest = await fetchJson(MANIFEST);
    const entry = manifest.versions.find((v) => v.id === VERSION);
    if (!entry) throw new Error(`La versión ${VERSION} no está en el manifiesto de Mojang`);
    const version = await fetchJson(entry.url);
    await download(version.downloads.client.url, jar);
    const index = await fetchJson(version.assetIndex.url);
    const object = index.objects["minecraft/lang/es_es.json"];
    if (!object) throw new Error("El índice de recursos no trae es_es.json");
    await download(`${RESOURCES}/${object.hash.slice(0, 2)}/${object.hash}`, lang);
  }
  if (refresh || !(await exists(textures))) {
    await rm(join(CACHE, "assets"), { recursive: true, force: true });
    execFileSync(
      "unzip",
      ["-q", "-o", jar, "assets/minecraft/textures/item/*", "assets/minecraft/textures/block/*", "-d", CACHE],
      { stdio: "inherit" },
    );
  }
  return { lang: JSON.parse(await readFile(lang, "utf8")), textures };
}

/** Casos sueltos: ítems cuya textura tiene otro nombre. */
const ALIASES = {
  clock: ["item/clock_00.png"],
  compass: ["item/compass_00.png"],
  recovery_compass: ["item/recovery_compass_00.png"],
  crossbow: ["item/crossbow_standby.png"],
  enchanted_golden_apple: ["item/golden_apple.png"],
  tipped_arrow: ["item/tipped_arrow_base.png"],
  magma_block: ["block/magma.png"],
  snow_block: ["block/snow.png"],
  dried_kelp_block: ["block/dried_kelp_top.png"],
  sticky_piston: ["block/piston_top_sticky.png"],
  smooth_quartz: ["block/quartz_block_bottom.png"],
  smooth_sandstone: ["block/sandstone_top.png"],
  smooth_red_sandstone: ["block/red_sandstone_top.png"],
  moss_carpet: ["block/moss_block.png"],
  quartz_block: ["block/quartz_block_side.png"],
  heavy_weighted_pressure_plate: ["block/iron_block.png"],
  light_weighted_pressure_plate: ["block/gold_block.png"],
  petrified_oak_slab: ["block/oak_planks.png"],
  suspicious_sand: ["block/suspicious_sand_0.png"],
  suspicious_gravel: ["block/suspicious_gravel_0.png"],
};

/**
 * Nombres de textura a probar para un id: el propio y los de su bloque base (una escalera
 * usa la textura de su bloque, una alfombra o una cama la de su lana, etc.).
 */
function baseNames(id) {
  const names = [id];
  const push = (name) => {
    if (name && !names.includes(name)) names.push(name);
  };
  // Prefijos que no cambian el aspecto.
  for (const prefix of ["waxed_", "infested_"]) if (id.startsWith(prefix)) push(id.slice(prefix.length));
  const plain = names[names.length - 1];
  // Variantes de forma: escaleras, losas, muros, vallas, placas, botones.
  const shape = plain.match(/^(.*?)_(stairs|slab|wall|fence_gate|fence|pressure_plate|button)$/);
  if (shape) {
    const base = shape[1];
    for (const candidate of [base, `${base}s`, `${base}_planks`, `${base}_block`]) push(candidate);
    if (base.endsWith("_brick")) push(`${base}s`);
  }
  // Troncos "wood" (las 6 caras de corteza) y tallos del Nether.
  if (plain.endsWith("_wood")) push(plain.replace(/_wood$/, "_log"));
  if (plain.endsWith("_hyphae")) push(plain.replace(/_hyphae$/, "_stem"));
  // Lo que se tiñe de un color: alfombras, camas y estandartes muestran su lana.
  const dyed = plain.match(/^(.*)_(carpet|bed|banner)$/);
  if (dyed) push(`${dyed[1]}_wool`);
  if (plain.endsWith("_spawn_egg")) push("spawn_egg");
  return names;
}

/** Textura que mejor representa un ítem: la de ítem; si no hay, la del bloque (o su cara de frente / lado / arriba). */
async function textureFor(id, textures) {
  const candidates = [];
  for (const name of baseNames(id)) {
    // Un alias vale también para el bloque base (la losa de cuarzo liso usa el del cuarzo liso).
    candidates.push(...(ALIASES[name] ?? []));
    candidates.push(
      `item/${name}.png`,
      `block/${name}.png`,
      `block/${name}_front.png`,
      `block/${name}_side.png`,
      `block/${name}_top.png`,
    );
  }
  for (const candidate of candidates) {
    if (await exists(join(textures, candidate))) return candidate;
  }
  return null;
}

async function main() {
  const md = loadMinecraftData();
  const { lang, textures } = await fetchAssets();
  await rm(OUT_IMAGES, { recursive: true, force: true });
  await mkdir(OUT_IMAGES, { recursive: true });
  await mkdir(dirname(OUT_JSON), { recursive: true });

  const items = [];
  let withImage = 0;
  for (const item of md.itemsArray) {
    if (item.name === "air") continue;
    const block = md.blocksByName[item.name];
    const texture = await textureFor(item.name, textures);
    if (texture) {
      await copyFile(join(textures, texture), join(OUT_IMAGES, `${item.name}.png`));
      withImage += 1;
    }
    items.push({
      id: item.name,
      name: item.displayName,
      nameEs: lang[`item.minecraft.${item.name}`] ?? lang[`block.minecraft.${item.name}`] ?? null,
      stackSize: item.stackSize,
      block: Boolean(block),
      texture,
    });
  }
  items.sort((a, b) => a.id.localeCompare(b.id));

  await writeFile(
    OUT_JSON,
    `${JSON.stringify({ version: VERSION, generatedBy: "scripts/items/catalog.mjs", count: items.length, items }, null, 1)}\n`,
  );
  console.log(`${items.length} ítems (${withImage} con imagen) -> ${OUT_JSON}`);
  console.log(`Imágenes -> ${OUT_IMAGES}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
