type Vec3 = readonly [number, number, number];

/** A turn about a world axis through the origin, right-handed, in degrees. It matches how an "angle" construction plane is built. */
export interface PlaneTilt {
  readonly axis: "x" | "y" | "z";
  readonly angleDeg: number;
}

const AXES: Readonly<Record<PlaneTilt["axis"], Vec3>> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** The 3x3 rotation matrix (row-major) for a tilt, or its inverse. */
export function tiltMatrix(tilt: PlaneTilt, inverse = false): readonly number[] {
  const n = AXES[tilt.axis];
  const radians = ((inverse ? -tilt.angleDeg : tilt.angleDeg) * Math.PI) / 180;
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const t = 1 - c;
  return [
    t * n[0] * n[0] + c, t * n[0] * n[1] - s * n[2], t * n[0] * n[2] + s * n[1],
    t * n[0] * n[1] + s * n[2], t * n[1] * n[1] + c, t * n[1] * n[2] - s * n[0],
    t * n[0] * n[2] - s * n[1], t * n[1] * n[2] + s * n[0], t * n[2] * n[2] + c
  ];
}

/** Rotates a point or direction by the tilt (or back, with `inverse`). Tiny round-off next to an exact value is cleaned away. */
export function tiltPoint(point: Vec3, tilt: PlaneTilt, inverse = false): Vec3 {
  const m = tiltMatrix(tilt, inverse);
  const clean = (value: number): number => (Math.abs(value) < 1e-12 ? 0 : value);
  return [
    clean(m[0]! * point[0] + m[1]! * point[1] + m[2]! * point[2]),
    clean(m[3]! * point[0] + m[4]! * point[1] + m[5]! * point[2]),
    clean(m[6]! * point[0] + m[7]! * point[1] + m[8]! * point[2])
  ];
}

/** Rotates a flat xyz position list by the tilt (or back, with `inverse`). */
export function tiltPositions(positionsMm: readonly number[], tilt: PlaneTilt, inverse = false): number[] {
  const out: number[] = new Array(positionsMm.length);
  for (let i = 0; i + 2 < positionsMm.length; i += 3) {
    const rotated = tiltPoint([positionsMm[i]!, positionsMm[i + 1]!, positionsMm[i + 2]!], tilt, inverse);
    out[i] = rotated[0];
    out[i + 1] = rotated[1];
    out[i + 2] = rotated[2];
  }
  return out;
}
