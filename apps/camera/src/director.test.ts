import { describe, expect, it } from "vitest";
import {
  cameraPose,
  framingFov,
  lookAngles,
  lookDirection,
  orbitPosition,
  pickAimTarget,
  pickShot,
  quantizeAngle,
  smoothScalar,
  smoothToward,
} from "./director";

const center = { x: 0, y: 64, z: 0 };

describe("pickAimTarget", () => {
  it("mira al centro si no hay peleadores", () => {
    expect(pickAimTarget([], center)).toEqual(center);
  });

  it("mira al punto medio entre los dos peleadores", () => {
    const target = pickAimTarget(
      [
        { x: -8, y: 65, z: 2 },
        { x: 4, y: 67, z: -6 },
      ],
      center,
    );
    expect(target).toEqual({ x: -2, y: 66, z: -2 });
  });

  it("con un solo peleador mira entre él y el centro", () => {
    expect(pickAimTarget([{ x: 8, y: 66, z: 4 }], center)).toEqual({ x: 4, y: 65, z: 2 });
  });
});

describe("smoothToward", () => {
  it("se acerca al objetivo sin pasarse", () => {
    const next = smoothToward({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 }, 0.1, 0.5);
    expect(next.x).toBeGreaterThan(0);
    expect(next.x).toBeLessThan(10);
  });

  it("salta directo al objetivo si tau es 0", () => {
    expect(smoothToward({ x: 0, y: 0, z: 0 }, { x: 10, y: 5, z: 1 }, 0.1, 0)).toEqual({ x: 10, y: 5, z: 1 });
  });
});

describe("orbitPosition", () => {
  const base = { x: 0, y: 78, z: -18 };

  it("queda fija si el periodo es 0", () => {
    expect(orbitPosition(base, center, 123, 0)).toEqual(base);
  });

  it("parte desde la posición base", () => {
    const pos = orbitPosition(base, center, 0, 60);
    expect(pos.x).toBeCloseTo(0, 6);
    expect(pos.y).toBe(78);
    expect(pos.z).toBeCloseTo(-18, 6);
  });

  it("a media vuelta queda al lado opuesto, misma altura y radio", () => {
    const pos = orbitPosition(base, center, 30, 60);
    expect(pos.x).toBeCloseTo(0, 6);
    expect(pos.y).toBe(78);
    expect(pos.z).toBeCloseTo(18, 6);
  });
});

describe("framingFov", () => {
  const camera = { x: 0, y: 78, z: 18 };
  const aim = { x: 0, y: 65, z: 0 };
  const options = { aspect: 16 / 9, minFov: 18, maxFov: 60, idleFov: 50, margin: 1.3 };

  it("usa el FOV de reposo si no hay a quién encuadrar", () => {
    expect(framingFov(camera, aim, [], options)).toBe(50);
  });

  it("hace más zoom cuando los peleadores están juntos que cuando están lejos", () => {
    const far = framingFov(camera, aim, [{ x: -8, y: 65, z: 0 }, { x: 8, y: 65, z: 0 }], options);
    const near = framingFov(camera, aim, [{ x: -1, y: 65, z: 0 }, { x: 1, y: 65, z: 0 }], options);
    expect(near).toBeLessThan(far);
    expect(near).toBe(18);
    expect(far).toBeGreaterThan(20);
    expect(far).toBeLessThan(45);
  });

  it("deja a los sujetos dentro de la imagen", () => {
    const subject = { x: -8, y: 65, z: 0 };
    const fov = framingFov(camera, aim, [subject], { ...options, margin: 1 });
    // Con margen 1 el sujeto queda justo en el borde horizontal: tan(fov/2) * aspect = |x| / profundidad.
    const depth = (13 * 13 + 18 * 18) / Math.hypot(13, 18);
    expect(Math.tan((fov * Math.PI) / 360) * options.aspect).toBeCloseTo(8 / depth, 5);
  });

  it("nunca sale del rango permitido", () => {
    const fov = framingFov(camera, aim, [{ x: 200, y: 65, z: 0 }], options);
    expect(fov).toBe(60);
  });
});

describe("smoothScalar", () => {
  it("se acerca al objetivo sin pasarse", () => {
    const next = smoothScalar(60, 20, 0.1, 0.5);
    expect(next).toBeLessThan(60);
    expect(next).toBeGreaterThan(20);
  });

  it("salta al objetivo si no hay suavizado", () => {
    expect(smoothScalar(60, 20, 0.1, 0)).toBe(20);
  });
});

describe("lookAngles / lookDirection", () => {
  it("usa la convención de mineflayer: yaw 0 mira hacia -z", () => {
    const { yaw, pitch } = lookAngles({ x: 0, y: 70, z: 10 }, { x: 0, y: 70, z: 0 });
    expect(yaw).toBeCloseTo(0, 9);
    expect(pitch).toBeCloseTo(0, 9);
  });

  it("pitch negativo cuando mira hacia abajo", () => {
    const { pitch } = lookAngles({ x: 0, y: 78, z: 18 }, { x: 0, y: 65, z: 0 });
    expect(pitch).toBeLessThan(0);
    expect(pitch).toBeCloseTo(-Math.atan2(13, 18), 9);
  });

  it("lookDirection es la inversa de lookAngles", () => {
    const from = { x: 3, y: 80, z: 14 };
    const to = { x: -5, y: 66, z: -2 };
    const { yaw, pitch } = lookAngles(from, to);
    const dir = lookDirection(yaw, pitch);
    const length = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    expect(dir.x).toBeCloseTo((to.x - from.x) / length, 9);
    expect(dir.y).toBeCloseTo((to.y - from.y) / length, 9);
    expect(dir.z).toBeCloseTo((to.z - from.z) / length, 9);
  });
});

describe("quantizeAngle", () => {
  it("redondea a pasos de 1/256 de vuelta", () => {
    const step = (2 * Math.PI) / 256;
    expect(quantizeAngle(step * 10.4)).toBeCloseTo(step * 10, 12);
    expect(quantizeAngle(-step * 25.6)).toBeCloseTo(-step * 26, 12);
    expect(quantizeAngle(Math.PI)).toBeCloseTo(Math.PI, 12);
  });
});

describe("cameraPose", () => {
  const position = { x: 0, y: 78, z: 18 };

  it("usa ángulos que el protocolo puede transmitir", () => {
    const pose = cameraPose(position, { x: 3.3, y: 66, z: -1.7 });
    expect(quantizeAngle(pose.yaw)).toBeCloseTo(pose.yaw, 12);
    expect(quantizeAngle(pose.pitch)).toBeCloseTo(pose.pitch, 12);
  });

  it("el objetivo queda exactamente en el centro de la imagen", () => {
    const aim = { x: 3.3, y: 66, z: -1.7 };
    const pose = cameraPose(position, aim);
    const again = lookAngles(pose.eye, aim);
    expect(again.yaw).toBeCloseTo(pose.yaw, 9);
    expect(again.pitch).toBeCloseTo(pose.pitch, 9);
  });

  it("el ojo casi no se mueve de su sitio", () => {
    const pose = cameraPose(position, { x: 3.3, y: 66, z: -1.7 });
    const moved = Math.hypot(pose.eye.x - position.x, pose.eye.y - position.y, pose.eye.z - position.z);
    // A ~23 bloques, medio paso de ángulo (0,7°) en cada eje son a lo más unos 40 cm.
    expect(moved).toBeLessThan(0.45);
  });
});

describe("pickShot", () => {
  it("sin pelea muestra la cámara general", () => {
    expect(pickShot(false, 3, 20, 6)).toBe("wide");
  });

  it("con pelea alterna: primero la que sigue, después la general", () => {
    expect(pickShot(true, 0, 20, 6)).toBe("follow");
    expect(pickShot(true, 19.9, 20, 6)).toBe("follow");
    expect(pickShot(true, 20.1, 20, 6)).toBe("wide");
    expect(pickShot(true, 25.9, 20, 6)).toBe("wide");
    expect(pickShot(true, 26.1, 20, 6)).toBe("follow");
  });

  it("se puede dejar una sola cámara", () => {
    expect(pickShot(true, 500, 20, 0)).toBe("follow");
    expect(pickShot(true, 5, 0, 6)).toBe("wide");
  });
});
