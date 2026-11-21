import { CUSTOM_KIT_POTIONS, ENCHANTMENT_LABELS, kitItemTitle, type Kit, type KitEnchantment, type KitItem } from "@phack/protocol";
import {
  isArrow,
  isAxe,
  isBow,
  isBuildBlock,
  isFoodName,
  isLavaBucket,
  isPearl,
  isPickaxe,
  isShears,
  isShield,
  isSword,
  isWaterBucket,
} from "./items";
import { LAVA_MAX_DISTANCE, LAVA_MIN_DISTANCE, THROW_MAX_DISTANCE } from "./tools";

/**
 * Guía de cada objeto del kit para la sección "TU KIT" del prompt: qué hace, cómo se usa
 * (con qué herramienta y argumentos) y en qué situaciones suele servir. Las situaciones
 * son ideas, no órdenes: el objetivo del agente lo fijan solo las instrucciones del usuario.
 */
type Guide = { what: string; how: string; when: string };

/** Qué agrega cada encantamiento, en una frase corta. */
const ENCHANTMENT_EFFECTS: Record<string, string> = {
  sharpness: "cada golpe quita más vida",
  fire_aspect: "cada golpe prende fuego al rival, que sigue perdiendo vida unos segundos",
  power: "cada flecha quita más vida",
  punch: "cada flecha que acierta empuja al rival hacia atrás",
  flame: "las flechas prenden fuego al rival",
  infinity: "disparar no gasta flechas, aunque necesitas tener al menos una",
  protection: "reduce todavía más el daño que recibes",
  thorns: "a veces daña al rival cuando te golpea",
  feather_falling: "reduce el daño de caída (por ejemplo al caer de una perla o de una torre)",
  unbreaking: "tarda más en gastarse",
};

/** "Filo III: cada golpe quita más vida." por cada encantamiento; vacío si no tiene. */
function enchantmentNotes(enchantments: readonly KitEnchantment[] | undefined): string {
  return (enchantments ?? [])
    .map((e) => {
      const effect = ENCHANTMENT_EFFECTS[e.id];
      return effect ? ` ${ENCHANTMENT_LABELS[e.id] ?? e.id}: ${effect}.` : "";
    })
    .join("");
}

/** Arma por defecto de attack: la primera espada y, si no hay, la primera hacha. */
function defaultWeapon(kit: Kit): string | undefined {
  return (kit.items.find((i) => isSword(i.item)) ?? kit.items.find((i) => isAxe(i.item)))?.item;
}

function attackHow(item: string, kit: Kit): string {
  return defaultWeapon(kit) === item
    ? "con attack; es tu arma por defecto, no hace falta nombrarla"
    : `con attack y "weapon": "${item}"`;
}

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
      how: `drink con "potion": "${type}"; tarda cerca de 2 s y te deja quieto`,
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
  const foods = new Set(kit.items.filter((i) => isFoodName(i.item)).map((i) => i.item));
  const how = `eat${foods.size > 1 ? ` con "food": "${item.item}"` : ""}; te deja quieto unos 2 s`;
  if (item.item === "golden_apple") {
    return {
      what: "da regeneración y 4 de vida extra en corazones amarillos",
      how,
      when: "con la vida baja, o justo antes de un intercambio cuerpo a cuerpo; se puede comer aunque la comida esté llena",
    };
  }
  if (item.item === "enchanted_golden_apple") {
    return {
      what: "regeneración fuerte, mucha vida extra en corazones amarillos y resistencia al daño y al fuego durante varios minutos",
      how,
      when: "cuando estás por perder o antes de un intercambio decisivo; se puede comer aunque la comida esté llena",
    };
  }
  return {
    what: "recupera comida; con la comida alta la vida vuelve sola de a poco",
    how: `${how}; solo con la comida bajo 20`,
    when: "cuando el rival está lejos, tras alejarte o detrás de un muro, porque comiendo no te defiendes",
  };
}

function blockGuide(item: KitItem): Guide {
  const name = item.item;
  const toughness = name.endsWith("_wool")
    ? "la lana se rompe rápido (~1 s a mano, al instante con tijeras): sirve para estructuras rápidas, no para aguantar"
    : name.endsWith("_planks")
      ? "los tablones tardan ~3 s en romperse a mano (rápido con hacha)"
      : name === "dirt"
        ? "la tierra se rompe rápido a mano"
        : "la roca y la obsidiana solo se rompen con pico: un rival sin pico no puede atravesarlas";
  return {
    what: `bloques para construir; ${toughness}`,
    how: `build con "blocks": una lista de celdas {x,y,z,material: "${name}"}`,
    when: "levantar un muro entre tú y un rival con arco, una torre para ganar altura y disparar, encerrarte un momento para comer o beber tranquilo, o cerrarle el paso",
  };
}

/** Guía de un objeto, o null si es armadura (va aparte) o algo que el cuerpo no sabe usar. */
function guideFor(item: KitItem, kit: Kit): Guide | null {
  const name = item.item;
  if (isSword(name)) {
    return {
      what: "arma cuerpo a cuerpo rápida",
      how: attackHow(name, kit),
      when: "con el rival a menos de ~3 bloques; combinada con move (strafe o circle) para no recibir sus golpes de frente; para rematarlo si huye herido",
    };
  }
  if (isAxe(name)) {
    return {
      what: "arma cuerpo a cuerpo lenta pero con golpes fuertes; además rompe madera rápido y puede bajarle el escudo al rival unos segundos",
      how: `${attackHow(name, kit)}; dig la usa sola para la madera`,
      when: "contra un rival con escudo, o para romper un muro de tablones",
    };
  }
  if (isBow(name)) {
    return {
      what: "ataque a distancia; necesita flechas",
      how: 'shoot; con move "keep" y "distance" (por ejemplo 8) mantienes la distancia entre disparos',
      when: "con el rival a más de 5 bloques: mientras se acerca, si huye a curarse o si está construyendo",
    };
  }
  if (isArrow(name)) {
    return {
      what: "munición del arco; cada disparo gasta una",
      how: "las usa shoot solo, no se nombran",
      when: 'revisa "inventory": sin flechas el arco no sirve',
    };
  }
  if (isPearl(name)) {
    return {
      what: "al lanzarla apareces donde cae",
      how: 'pearl con "target": "rival" (caes junto a él) o "away" (lejos de él)',
      when: "cerrar distancia de golpe contra un rival con arco, escapar si estás acorralado o con poca vida, o salir de un encierro",
    };
  }
  if (isFoodName(name)) return foodGuide(item, kit);
  if (isBuildBlock(name)) return blockGuide(item);
  if (isPickaxe(name)) {
    return {
      what: "rompe roca y obsidiana (sin pico no se pueden romper)",
      how: "dig la usa sola cuando hace falta",
      when: "abrirte paso por un muro o una torre de piedra del rival, o recoger bloques para construir",
    };
  }
  if (isShears(name)) {
    return {
      what: "rompe la lana al instante",
      how: "dig las usa solas con la lana",
      when: "atravesar un muro de lana del rival o recuperar lana para construir",
    };
  }
  if (isShield(name)) {
    return {
      what: "bloquea todo el daño que llega de frente (no por la espalda)",
      how: 'shield para quedarte cubierto, o attack con "guard": true para cubrirte entre golpe y golpe',
      when: "mientras el rival te dispara, o en un intercambio cuerpo a cuerpo; un hacha te lo puede bajar unos segundos",
    };
  }
  if (isWaterBucket(name)) {
    return {
      what: "el agua corre unos 7 bloques y empuja y frena a quien esté en ella; apaga el fuego",
      how: 'water con "where": "between" (entre tú y el rival) o "feet" (a tus pies); se vacía una sola vez',
      when: "frenar a un rival que te persigue, caer desde altura sin daño (feet) o apagarte si te prendieron fuego",
    };
  }
  if (isLavaBucket(name)) {
    return {
      what: "quema a quien la pise, también a ti, y se extiende unos 3 bloques",
      how: `lava, con el rival a entre ${LAVA_MIN_DISTANCE} y ${LAVA_MAX_DISTANCE} bloques; se vacía una sola vez`,
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
  return info ? `${base} de ${info.label}` : base;
}

/**
 * Líneas de la guía de objetos (sin la armadura). Cada una:
 * "  - <objeto>. Qué hace: … Cómo usarlo: … Situaciones comunes: …"
 */
export function itemGuideLines(kit: Kit): string[] {
  const objects = groupItems(kit.items.filter((i) => !i.slot.startsWith("armor.")));
  return objects.map((item) => {
    const guide = guideFor(item, kit);
    const extras = enchantmentNotes(item.enchantments);
    if (!guide) return `  - ${guideTitle(item)}.${extras}`;
    return `  - ${guideTitle(item)}. Qué hace: ${guide.what}.${extras} Cómo usarlo: ${guide.how}. Situaciones comunes: ${guide.when}.`;
  });
}

/** Qué hace la armadura puesta, con sus encantamientos. Vacío si no lleva. */
export function armorGuide(kit: Kit): string {
  const armor = kit.items.filter((i) => i.slot.startsWith("armor."));
  if (armor.length === 0) return "";
  const enchants = new Map<string, KitEnchantment>();
  for (const piece of armor) for (const e of piece.enchantments ?? []) if (!enchants.has(e.id)) enchants.set(e.id, e);
  return ` Reduce el daño de golpes, flechas y caídas sin que hagas nada; no se cambia ni se quita.${enchantmentNotes([...enchants.values()])}`;
}
