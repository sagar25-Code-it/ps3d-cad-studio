import { booleanMeshes } from "./mesh-boolean.js";
import type { ReliefCorner, SheetFrame, SheetMesh } from "./sheet-edge-flange.js";

type Vec3 = readonly [number, number, number];

const OVERSHOOT_MM = 0.5;

/**
 * The prism that cuts a corner relief notch out of a plate: the corner's footprint (a square of the relief's size, or a quarter
 * disc of that radius) taken straight through the plate's thickness. Its two straight sides lie along the plate's two edge walls
 * and stop where the flanges start, which is the relief size from the corner.
 */
export function reliefNotchCutter(frame: SheetFrame, corner: ReliefCorner, arcSegments = 16): SheetMesh {
  const n = corner.sizeMm;
  const a = corner.alongMm;
  const b = corner.backMm;
  const p = corner.pointMm;
  const point = (s: number, t: number): Vec3 => [p[0] + a[0] * s + b[0] * t, p[1] + a[1] * s + b[1] * t, p[2] + a[2] * s + b[2] * t];
  let footprint: Vec3[];
  if (corner.shape === "square") {
    footprint = [point(0, 0), point(n, 0), point(n, n), point(0, n)];
  } else {
    // A sector of radius n about the corner, from the edge that starts there round to the edge that ends there.
    const cosTurn = Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
    const turn = Math.acos(cosTurn);
    footprint = [point(0, 0)];
    // Angle measured from `a` towards `b` in the plane they span.
    const side: Vec3 = (() => {
      const w: Vec3 = [b[0] - a[0] * cosTurn, b[1] - a[1] * cosTurn, b[2] - a[2] * cosTurn];
      const length = Math.hypot(w[0], w[1], w[2]);
      return length < 1e-9 ? [0, 0, 0] : [w[0] / length, w[1] / length, w[2] / length];
    })();
    for (let step = 0; step <= arcSegments; step += 1) {
      const angle = (turn * step) / arcSegments;
      const along = Math.cos(angle) * n;
      const across = Math.sin(angle) * n;
      footprint.push([p[0] + a[0] * along + side[0] * across, p[1] + a[1] * along + side[1] * across, p[2] + a[2] * along + side[2] * across]);
    }
  }
  const up = OVERSHOOT_MM;
  const down = frame.thicknessMm + OVERSHOOT_MM;
  const positions: number[] = [];
  for (const level of [up, -down]) for (const q of footprint) positions.push(q[0] + frame.normal[0] * level, q[1] + frame.normal[1] * level, q[2] + frame.normal[2] * level);
  const count = footprint.length;
  const indices: number[] = [];
  // Side walls.
  for (let i = 0; i < count; i += 1) {
    const j = (i + 1) % count;
    indices.push(i, j, count + j, i, count + j, count + i);
  }
  // Caps, fanned from the first footprint point (the footprint is convex).
  for (let i = 1; i + 1 < count; i += 1) {
    indices.push(0, i + 1, i);
    indices.push(count, count + i, count + i + 1);
  }
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const [ia, ib, ic] = [indices[t]! * 3, indices[t + 1]! * 3, indices[t + 2]! * 3];
    volume += (positions[ia]! * (positions[ib + 1]! * positions[ic + 2]! - positions[ib + 2]! * positions[ic + 1]!)
      - positions[ia + 1]! * (positions[ib]! * positions[ic + 2]! - positions[ib + 2]! * positions[ic]!)
      + positions[ia + 2]! * (positions[ib]! * positions[ic + 1]! - positions[ib + 1]! * positions[ic]!)) / 6;
  }
  if (volume < 0) for (let t = 0; t < indices.length; t += 3) { const swap = indices[t + 1]!; indices[t + 1] = indices[t + 2]!; indices[t + 2] = swap; }
  return { positionsMm: positions, indices };
}

export type ReliefNotchResult =
  | { readonly ok: true; readonly positionsMm: readonly number[]; readonly indices: readonly number[] }
  | { readonly ok: false; readonly message: string };

/** Cuts the corner's relief notch out of a plate that already carries the flanges either side of it. */
export function cutReliefNotch(body: SheetMesh, frame: SheetFrame, corner: ReliefCorner): ReliefNotchResult {
  const cutter = reliefNotchCutter(frame, corner);
  const cut = booleanMeshes({ positionsMm: body.positionsMm, indices: body.indices }, cutter, "cut");
  if (!cut.ok) return { ok: false, message: `The ${corner.shape} corner relief could not be cut: ${cut.message}` };
  return { ok: true, positionsMm: cut.value.positionsMm, indices: cut.value.indices };
}
