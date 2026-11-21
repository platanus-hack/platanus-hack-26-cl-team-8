import { CUSTOM_KIT_POTIONS, ENCHANTMENT_LABELS, kitItemTitle, type Kit, type KitEffect, type KitEnchantment, type KitItem } from "@phack/protocol";
import {
  ALWAYS_EDIBLE,
  attackCooldownMs,
  defaultMeleeWeapon,
  isArrow,
  isAxe,
  isBow,
  isBuildBlock,
  isFoodName,
  isLavaBucket,
  isPearl,
  isPickaxe,
  isShield,
  isSword,
  isWaterBucket,
  meleeDamage,
} from "./items";
import {
  BOW_CHARGE_MS,
  BOW_PAUSE_MS,
  DRINK_MS,
  EAT_MS,
  kitToolNames,
  LAVA_MAX_DISTANCE,
  LAVA_MIN_DISTANCE,
  PEARL_COOLDOWN_MS,
  PEARL_MAX_HEIGHT,
  PEARL_MIN_DISTANCE,
  pearlDamage,
  pearlMinHealth,
  THROW_MAX_DISTANCE,
  WATER_BETWEEN_MIN_DISTANCE,
} from "./tools";

/**
 * Guía de cada objeto del kit para la sección "TU KIT" del prompt. Es el único lugar del
 * prompt con los datos de cada objeto: qué hace (en números de Minecraft 1.20.4 o del
 * cuerpo), con qué herramienta y argumentos se usa y qué límites tiene. Las situaciones
 * son ideas, no órdenes: el objetivo del agente lo fijan solo las instrucciones del usuario.
 */
type Guide = { what: string; how: string; when: string };

/** 8 -> "8", 8.5 -> "8.5": un decimal como mucho. */
const num = (value: number): string => String(Number(value.toFixed(1)));
/** 650 -> "0.65": las recargas del cuerpo, sin redondear de más. */
const seconds = (ms: number): string => String(Number((ms / 1000).toFixed(2)));
const levelOf = (item: KitItem, id: string): number => item.enchantments?.find((e) => e.id === id)?.level ?? 0;
const isArmor = (item: KitItem): boolean => item.slot.startsWith("armor.");

/** Sobre qué objetos hace algo cada encantamiento y qué agrega, en una frase corta. */
const ENCHANTMENTS: Record<string, { on: (item: KitItem) => boolean; effect: (level: number) => string }> = {
  sharpness: { on: (i) => isSword(i.item) || isAxe(i.item), effect: (l) => `suma ${num(0.5 + 0.5 * l)} al daño de cada golpe (ya contado)` },
  fire_aspect: {
    on: (i) => isSword(i.item) || isAxe(i.item),
    effect: (l) => `cada golpe prende fuego al rival ${4 * l} s (el fuego quita 1 de vida por segundo)`,
  },
  power: { on: (i) => isBow(i.item), effect: (l) => `suma un ${25 * (l + 1)}% al daño de cada flecha (ya contado)` },
  punch: { on: (i) => isBow(i.item), effect: () => "cada flecha que acierta empuja al rival hacia atrás" },
  flame: { on: (i) => isBow(i.item), effect: () => "cada flecha prende fuego al rival 5 s" },
  infinity: { on: (i) => isBow(i.item), effect: () => "disparar no gasta flechas, aunque necesitas tener al menos una" },
  protection: { on: isArmor, effect: (l) => `reduce otro ${Math.min(80, 4 * l)}% casi todo el daño, también caídas y pociones` },
  thorns: { on: isArmor, effect: () => "a veces devuelve de 1 a 4 de daño a quien te golpea" },
  feather_falling: { on: isArmor, effect: (l) => `reduce un ${Math.min(80, 12 * l)}% el daño de caída, también el de una perla` },
  unbreaking: {
    on: (i) => isArmor(i) || isSword(i.item) || isAxe(i.item) || isPickaxe(i.item) || isBow(i.item) || isShield(i.item),
    effect: () => "tarda más en gastarse",
  },
};

/** "Filo III: suma 2 al daño…" por cada encantamiento; avisa si en ese objeto no hace nada. Vacío si no tiene. */
function enchantmentNotes(item: KitItem, enchantments: readonly KitEnchantment[] | undefined = item.enchantments): string {
  return (enchantments ?? [])
    .map((e) => {
      const known = ENCHANTMENTS[e.id];
      if (!known) return "";
      const label = ENCHANTMENT_LABELS[e.id] ?? e.id;
      return known.on(item) ? ` ${label}: ${known.effect(e.level)}.` : ` ${label}: en este objeto no hace nada.`;
    })
    .join("");
}

/** Qué hace cada efecto permanente, con su nivel (`amplifier` 0 = nivel I). */
const EFFECTS: Record<string, (level: number) => string> = {
  speed: (l) => `caminas un ${20 * l}% más rápido`,
  strength: (l) => `tus golpes quitan ${3 * l} más (ya contado en tus armas)`,
  resistance: (l) => `recibes un ${Math.min(100, 20 * l)}% menos de daño`,
  regeneration: (l) => `recuperas 1 de vida cada ${num(2.5 / 2 ** (l - 1))} s`,
  jump_boost: () => "saltas más alto",
  fire_resistance: () => "el fuego y la lava no te dañan",
};

/** "Velocidad I (caminas un 20% más rápido)". */
export function effectGuide(effect: KitEffect): string {
  const what = EFFECTS[effect.id]?.(effect.amplifier + 1);
  return what ? `${effect.label} (${what})` : effect.label;
}

/** Daño de un golpe con este objeto, normal y crítico, antes de la armadura del rival. */
function hitDamage(item: KitItem, kit: Kit): { normal: string; crit: string } {
  const strength = kit.effects.find((e) => e.id === "strength");
  const base = meleeDamage(item.item) + (strength ? 3 * (strength.amplifier + 1) : 0);
  const sharpness = levelOf(item, "sharpness");
  const extra = sharpness > 0 ? 0.5 + 0.5 * sharpness : 0;
  // El crítico multiplica el daño del arma; lo que suma Filo va aparte.
  return { normal: num(base + extra), crit: num(base * 1.5 + extra) };
}

function weaponGuide(item: KitItem, kit: Kit): Guide {
  const name = item.item;
  const { normal, crit } = hitDamage(item, kit);
  const weapons = kit.items.filter((i) => isSword(i.item) || isAxe(i.item));
  const isDefault = defaultMeleeWeapon(weapons.map((i) => i.item)) === name;
  const attack = isDefault
    ? `attack; es el arma que saca si no nombras otra${weapons.length > 1 ? ` ("weapon": "${name}" la elige igual)` : ""}`
    : `attack con "weapon": "${name}"`;
  const hits = `quita ${normal} por golpe (${crit} si es crítico) antes de la armadura del rival; un golpe cada ${seconds(attackCooldownMs(name))} s`;
  if (isSword(name)) {
    return {
      what: `arma cuerpo a cuerpo: ${hits}`,
      how: attack,
      when: "con el rival a menos de ~3 bloques; alternada con move (strafe o circle) para no recibir sus golpes de frente; para rematarlo si huye herido",
    };
  }
  return {
    what: `arma cuerpo a cuerpo: ${hits}; un golpe suyo deja sin escudo al rival 5 s; además rompe madera rápido`,
    how: `${attack}; dig la usa sola para la madera`,
    when: "contra un rival con escudo, o para romper un muro de tablones",
  };
}

function bowGuide(item: KitItem, kit: Kit): Guide {
  // A carga completa (como dispara el cuerpo) la flecha sale a velocidad 3 y siempre lleva un extra al azar.
  const power = levelOf(item, "power");
  const base = Math.ceil(3 * (2 + (power > 0 ? 0.5 * power + 0.5 : 0)));
  const offered = kitToolNames(kit).includes("shoot");
  return {
    what: `ataque a distancia: cada flecha quita de ${base} a ${base + Math.floor(base / 2) + 1} antes de la armadura del rival; un disparo cada ~${seconds(BOW_CHARGE_MS + BOW_PAUSE_MS)} s; necesita flechas`,
    how: offered ? "shoot; el cuerpo apunta, carga y suelta solo, una flecha tras otra" : "tu kit no trae flechas, así que shoot no se te ofrece",
    when: "con el rival a más de 5 bloques: mientras se acerca, si huye a curarse o si está construyendo",
  };
}

/** Cuánta comida (de 20) recupera cada una en Minecraft 1.20.4. */
const FOOD_POINTS: Record<string, number> = {
  cooked_beef: 8,
  cooked_porkchop: 8,
  cooked_chicken: 6,
  golden_carrot: 6,
  bread: 5,
  baked_potato: 5,
  apple: 4,
  golden_apple: 4,
  enchanted_golden_apple: 4,
};

/** Cuándo conviene cada poción, según su tipo. */
const POTION_SITUATIONS: Record<string, string> = {
  healing: "con la vida baja, sobre todo en plena pelea, cuando no hay tiempo de comer",
  strong_healing: "con la vida muy baja, para recuperar mucho de golpe",
  regeneration: "antes de un intercambio largo o después de recibir mucho daño",
  strength: "justo antes de cerrar distancia para pelear cuerpo a cuerpo",
  swiftness: "para alcanzar a un rival que huye o escapar de uno que te persigue",
  fire_resistance: "cuando hay lava o fuego cerca, o si te prendieron fuego",
  harming: "con el rival cerca y herido, para rematarlo",
  strong_harming: "con el rival cerca y herido, para rematarlo",
  poison: "al empezar un intercambio: le va quitando vida mientras pelean (no lo mata solo)",
  slowness: "para que no te alcance si quieres distancia, o para que no se te escape",
  weakness: "antes de un intercambio cuerpo a cuerpo, para que sus golpes duelan menos",
};

function potionGuide(item: KitItem): Guide {
  const type = item.potion ?? "";
  const info = CUSTOM_KIT_POTIONS[type];
  const effect = info?.effect ?? "efecto desconocido";
  const situation = POTION_SITUATIONS[type] ?? "cuando su efecto te sirva";
  if (item.item === "potion") {
    if (info?.harmful) {
      return {
        what: `es dañina (${effect}) y bebida te afecta a ti`,
        how: `drink con "potion": "${type}"`,
        when: "casi nunca conviene beberla",
      };
    }
    return {
      what: effect,
      how: `drink con "potion": "${type}"; tarda ${seconds(DRINK_MS)} s y te deja quieto`,
      when: `${situation}; mejor con el rival lejos o detrás de un obstáculo, porque bebiendo no te defiendes`,
    };
  }
  return info?.harmful
    ? {
        what: `al rival: ${effect}`,
        how: `throw con "potion": "${type}" y "at": "rival"; es instantáneo y solo llega si está a ${THROW_MAX_DISTANCE} bloques o menos`,
        when: situation,
      }
    : {
        what: effect,
        how: `throw con "potion": "${type}" y "at": "self" (a tus pies); es instantáneo`,
        when: `${situation}; a diferencia de beber, no te deja quieto`,
      };
}

function foodGuide(item: KitItem, kit: Kit): Guide {
  const foods = [...new Set(kit.items.filter((i) => isFoodName(i.item)).map((i) => i.item))];
  // Qué pasa sin "food" se dice una vez, en la primera comida.
  const unnamed = foods[0] === item.item ? ' (sin "food", la primera que se pueda comer)' : "";
  const pick = foods.length > 1 ? ` con "food": "${item.item}"${unnamed}` : "";
  const always = ALWAYS_EDIBLE.has(item.item);
  const how = `eat${pick}; tarda ${seconds(EAT_MS)} s y te deja quieto; ${always ? "se puede comer aunque la comida esté llena" : "solo con la comida bajo 20"}`;
  const food = `recupera ${FOOD_POINTS[item.item] ?? "algo"} de comida`;
  const yellow = 'los corazones amarillos no se acumulan (otra manzana solo los renueva) y, mientras te quedan, la observación trae "absorption"';
  if (item.item === "golden_apple") {
    return {
      what: `${food}, da Regeneración II por 5 s (unos 4 de vida) y 4 de vida extra en corazones amarillos por 2 min; ${yellow}`,
      how,
      when: "con la vida baja, o justo antes de un intercambio cuerpo a cuerpo",
    };
  }
  if (item.item === "enchanted_golden_apple") {
    return {
      what: `${food}, da Regeneración II por 20 s (unos 16 de vida), 16 de vida extra en corazones amarillos por 2 min, y Resistencia I (20% menos de daño) y resistencia al fuego por 5 min; ${yellow}`,
      how,
      when: "cuando estás por perder o antes de un intercambio decisivo",
    };
  }
  return {
    what: `${food} (de 20); con la comida alta la vida vuelve sola de a poco`,
    how,
    when: "cuando el rival está lejos, tras alejarte o detrás de un muro, porque comiendo no te defiendes",
  };
}

function blockGuide(item: KitItem): Guide {
  return {
    what: "bloques para construir; lo que tarda en romperse cada material está en la línea de dig",
    how: `build con "blocks": una lista de celdas {x,y,z,material: "${item.item}"}`,
    when: "levantar un muro entre tú y un rival con arco, una torre para ganar altura y disparar, encerrarte un momento para comer o beber tranquilo, o cerrarle el paso",
  };
}

/** Guía de un objeto, o null si es armadura (va aparte) o algo que el cuerpo no sabe usar. */
function guideFor(item: KitItem, kit: Kit): Guide | null {
  const name = item.item;
  if (isSword(name) || isAxe(name)) return weaponGuide(item, kit);
  if (isBow(name)) return bowGuide(item, kit);
  if (isArrow(name)) {
    return {
      what: "munición del arco; cada disparo gasta una",
      how: kitToolNames(kit).includes("shoot") ? "las usa shoot solo, no se nombran" : "tu kit no trae arco, así que shoot no se te ofrece",
      when: 'cuántas te quedan lo dice "inventory": sin flechas el arco no dispara',
    };
  }
  if (isPearl(name)) {
    return {
      what: `al lanzarla apareces donde cae; cada caída te quita ${num(pearlDamage(kit))} de vida`,
      how: `pearl con "target": "rival" (caes junto a él) o "away" (lejos de él); entre una y otra pasan ${seconds(PEARL_COOLDOWN_MS)} s (mientras tanto la observación trae "pearlCooldown"); no se lanza con ${pearlMinHealth(kit)} de vida o menos, a más de ${PEARL_MAX_HEIGHT} bloques sobre el piso, ni hacia un rival a menos de ${PEARL_MIN_DISTANCE} bloques`,
      when: "cerrar distancia de golpe contra un rival con arco, escapar si estás acorralado o con poca vida, o salir de un encierro",
    };
  }
  if (isFoodName(name)) return foodGuide(item, kit);
  if (isBuildBlock(name)) return blockGuide(item);
  if (isPickaxe(name)) {
    return {
      what: "rompe la roca rápido y deja el bloque para recoger (los tiempos están en la línea de dig)",
      how: "dig la usa sola cuando hace falta",
      when: "abrirte paso por un muro o una torre de roca del rival, o recoger bloques para construir",
    };
  }
  if (isShield(name)) {
    return {
      what: "levantado bloquea todo el daño de golpes y flechas que llega de frente (no por la espalda); un golpe de hacha lo deja inservible 5 s",
      how: 'shield lo levanta hacia el rival (quieto y sin atacar); attack con "guard": true lo levanta entre golpe y golpe (persigues más lento); va en la mano secundaria, así que no sueltas el arma',
      when: "mientras el rival te dispara, o en un intercambio cuerpo a cuerpo",
    };
  }
  if (isWaterBucket(name)) {
    return {
      what: "el agua corre unos 7 bloques por el piso, empuja y frena a quien esté en ella, apaga el fuego y anula el daño de caída",
      how: `water con "where": "between" (a 2 bloques hacia el rival; no con él a menos de ${WATER_BETWEEN_MIN_DISTANCE}) o "feet" (bajo tus pies, también cayendo); cada cubo se vacía una sola vez`,
      when: "frenar a un rival que te persigue, caer desde altura sin daño (feet) o apagarte si te prendieron fuego",
    };
  }
  if (isLavaBucket(name)) {
    return {
      what: "quema a quien la pise, también a ti, y se extiende unos 3 bloques",
      how: `lava: cae a los pies del rival, solo si está a entre ${LAVA_MIN_DISTANCE} y ${LAVA_MAX_DISTANCE} bloques; cada cubo se vacía una sola vez`,
      when: "obligarlo a alejarse, quitarle vida de a poco o cortarle el paso; después no camines por ahí",
    };
  }
  if (name === "potion" || name === "splash_potion") return potionGuide(item);
  return null;
}

/** Objetos iguales (mismo id y mismo tipo de poción) se describen una sola vez, con la cantidad sumada. */
function groupItems(items: readonly KitItem[]): KitItem[] {
  const groups = new Map<string, KitItem>();
  for (const item of items) {
    const key = `${item.item}:${item.potion ?? ""}`;
    const seen = groups.get(key);
    groups.set(key, seen ? { ...seen, count: seen.count + item.count } : item);
  }
  return [...groups.values()];
}

/** Nombre de un objeto en la guía; las pociones llevan su tipo. */
function guideTitle(item: KitItem): string {
  const info = item.potion ? CUSTOM_KIT_POTIONS[item.potion] : undefined;
  const base = kitItemTitle(item);
  return info && !base.includes(` de ${info.label}`) ? `${base} de ${info.label}` : base;
}

/**
 * Líneas de la guía de objetos (sin la armadura). Cada una:
 * "  - <objeto>. Qué hace: … Cómo usarlo: … Situaciones comunes: …"
 */
export function itemGuideLines(kit: Kit): string[] {
  const objects = groupItems(kit.items.filter((i) => !isArmor(i)));
  return objects.map((item) => {
    const guide = guideFor(item, kit);
    const extras = enchantmentNotes(item);
    if (!guide) return `  - ${guideTitle(item)}.${extras}`;
    return `  - ${guideTitle(item)}. Qué hace: ${guide.what}.${extras} Cómo usarlo: ${guide.how}. Situaciones comunes: ${guide.when}.`;
  });
}

/** Puntos de armadura de casco, peto, grebas y botas de cada material, y dureza por pieza (1.20.4). */
const ARMOR_POINTS: Record<string, readonly [number, number, number, number]> = {
  leather: [1, 3, 2, 1],
  golden: [2, 5, 3, 1],
  chainmail: [2, 5, 4, 1],
  iron: [2, 6, 5, 2],
  diamond: [3, 8, 6, 3],
  netherite: [3, 8, 6, 3],
};
const ARMOR_TOUGHNESS: Record<string, number> = { diamond: 2, netherite: 3 };
const ARMOR_PIECES = ["helmet", "chestplate", "leggings", "boots"];
/** Golpe con que se da el ejemplo: el de una espada de hierro. */
const SAMPLE_HIT = 6;

/** Puntos de armadura del kit y qué parte de un golpe de `damage` detienen. */
export function armorProtection(kit: Kit, damage = SAMPLE_HIT): { points: number; reduction: number } {
  let points = 0;
  let toughness = 0;
  for (const piece of kit.items.filter(isArmor)) {
    const cut = piece.item.lastIndexOf("_");
    const material = piece.item.slice(0, cut);
    points += ARMOR_POINTS[material]?.[ARMOR_PIECES.indexOf(piece.item.slice(cut + 1))] ?? 0;
    toughness += ARMOR_TOUGHNESS[material] ?? 0;
  }
  const effective = Math.min(20, Math.max(points / 5, points - (4 * damage) / (toughness + 8)));
  return { points, reduction: effective / 25 };
}

/** Qué hace la armadura puesta, con sus encantamientos. Vacío si no lleva. */
export function armorGuide(kit: Kit): string {
  const armor = kit.items.filter(isArmor);
  if (armor.length === 0) return "";
  // Un encantamiento repetido en varias piezas se explica una vez, con los niveles sumados.
  const enchants = new Map<string, { piece: KitItem; level: number }>();
  for (const piece of armor) {
    for (const e of piece.enchantments ?? []) {
      const seen = enchants.get(e.id);
      enchants.set(e.id, { piece: seen?.piece ?? piece, level: (seen?.level ?? 0) + e.level });
    }
  }
  const notes = [...enchants].map(([id, { piece, level }]) => enchantmentNotes(piece, [{ id, level }])).join("");
  const { points, reduction } = armorProtection(kit);
  return ` Reduce el daño de golpes y flechas (${points} puntos de armadura: a un golpe de ${SAMPLE_HIT} le quita cerca de un ${Math.round(reduction * 100)}%, y algo menos a los más fuertes); no reduce caídas, pociones ni el fuego que ya llevas encima. No se cambia ni se quita.${notes}`;
}
