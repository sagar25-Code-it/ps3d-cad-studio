import type { ConstructionAxis, ConstructionPlane, GeneralSolidBody, PatternAxisRef, PatternPlaneRef, PatternShape } from "../../workbench-core/src/index.js";
import { evaluateConstructionAxis, evaluateConstructionPlane } from "./construction-geometry.js";

type Vec3 = readonly [number, number, number];

/**
 * A rigid or mirroring map of space as a row-major 3x4 matrix: [m00 m01 m02 tx, m10 m11 m12 ty, m20 m21 m22 tz].
 * Patterns are lists of these, one per copy; the original is the identity and is not listed.
 */
export type Affine = readonly number[];

export const IDENTITY_AFFINE: Affine = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

/** Round-off next to an exact value is cleaned away so a quarter turn leaves flat faces exactly flat. */
const clean = (value: number): number => {
  const rounded = Math.round(value * 1e9) / 1e9;
  return Object.is(rounded, -0) ? 0 : rounded;
};

const unit = (vector: Vec3): Vec3 | undefined => {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length < 1e-9 ? undefined : [vector[0] / length, vector[1] / length, vector[2] / length];
};

export function translationAffine(offset: Vec3): Affine {
  return [1, 0, 0, offset[0], 0, 1, 0, offset[1], 0, 0, 1, offset[2]];
}

/** A right-handed turn of `angleRad` about the line through `origin` along `axis`. */
export function rotationAffine(origin: Vec3, axis: Vec3, angleRad: number): Affine {
  const n = unit(axis) ?? [0, 0, 1];
  const c = Math.cos(angleRad);
  const s = Math.sin(angleRad);
  const t = 1 - c;
  const r = [
    t * n[0] * n[0] + c, t * n[0] * n[1] - s * n[2], t * n[0] * n[2] + s * n[1],
    t * n[0] * n[1] + s * n[2], t * n[1] * n[1] + c, t * n[1] * n[2] - s * n[0],
    t * n[0] * n[2] - s * n[1], t * n[1] * n[2] + s * n[0], t * n[2] * n[2] + c
  ];
  // The origin stays where it is: translation = origin - R * origin.
  const tx = origin[0] - (r[0]! * origin[0] + r[1]! * origin[1] + r[2]! * origin[2]);
  const ty = origin[1] - (r[3]! * origin[0] + r[4]! * origin[1] + r[5]! * origin[2]);
  const tz = origin[2] - (r[6]! * origin[0] + r[7]! * origin[1] + r[8]! * origin[2]);
  return [r[0]!, r[1]!, r[2]!, tx, r[3]!, r[4]!, r[5]!, ty, r[6]!, r[7]!, r[8]!, tz].map(clean);
}

/** A reflection across the plane through `point` with the given normal. */
export function reflectionAffine(point: Vec3, normal: Vec3): Affine {
  const n = unit(normal) ?? [0, 0, 1];
  const d = n[0] * point[0] + n[1] * point[1] + n[2] * point[2];
  return [
    1 - 2 * n[0] * n[0], -2 * n[0] * n[1], -2 * n[0] * n[2], 2 * d * n[0],
    -2 * n[1] * n[0], 1 - 2 * n[1] * n[1], -2 * n[1] * n[2], 2 * d * n[1],
    -2 * n[2] * n[0], -2 * n[2] * n[1], 1 - 2 * n[2] * n[2], 2 * d * n[2]
  ].map(clean);
}

export function affineDeterminant(m: Affine): number {
  return m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!);
}

export function invertAffine(m: Affine): Affine | undefined {
  const det = affineDeterminant(m);
  if (Math.abs(det) < 1e-12) return undefined;
  const a = m[0]!; const b = m[1]!; const c = m[2]!; const d = m[4]!; const e = m[5]!; const f = m[6]!; const g = m[8]!; const h = m[9]!; const i = m[10]!;
  const inv = [
    (e * i - f * h) / det, (c * h - b * i) / det, (b * f - c * e) / det,
    (f * g - d * i) / det, (a * i - c * g) / det, (c * d - a * f) / det,
    (d * h - e * g) / det, (b * g - a * h) / det, (a * e - b * d) / det
  ];
  const tx = -(inv[0]! * m[3]! + inv[1]! * m[7]! + inv[2]! * m[11]!);
  const ty = -(inv[3]! * m[3]! + inv[4]! * m[7]! + inv[5]! * m[11]!);
  const tz = -(inv[6]! * m[3]! + inv[7]! * m[7]! + inv[8]! * m[11]!);
  return [inv[0]!, inv[1]!, inv[2]!, tx, inv[3]!, inv[4]!, inv[5]!, ty, inv[6]!, inv[7]!, inv[8]!, tz];
}

export function transformPoint(m: Affine, p: Vec3): Vec3 {
  return [
    clean(m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!),
    clean(m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!),
    clean(m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!)
  ];
}

/** Turns a direction (no translation), such as a hole's axis. A mirror flips it across the plane. */
export function transformDirection(m: Affine, d: Vec3): Vec3 {
  return [
    clean(m[0]! * d[0] + m[1]! * d[1] + m[2]! * d[2]),
    clean(m[4]! * d[0] + m[5]! * d[1] + m[6]! * d[2]),
    clean(m[8]! * d[0] + m[9]! * d[1] + m[10]! * d[2])
  ];
}

export function transformPositions(positionsMm: readonly number[], m: Affine): number[] {
  const out = new Array<number>(positionsMm.length);
  for (let i = 0; i + 2 < positionsMm.length; i += 3) {
    const p = transformPoint(m, [positionsMm[i]!, positionsMm[i + 1]!, positionsMm[i + 2]!]);
    out[i] = p[0]; out[i + 1] = p[1]; out[i + 2] = p[2];
  }
  return out;
}

/** A mirror turns the mesh inside out: the winding of every triangle is reversed so the faces still point outward. */
export function transformIndices(indices: readonly number[], m: Affine): number[] {
  const out = Array.from(indices);
  if (affineDeterminant(m) < 0) {
    for (let corner = 0; corner + 2 < out.length; corner += 3) {
      const swap = out[corner + 1]!;
      out[corner + 1] = out[corner + 2]!;
      out[corner + 2] = swap;
    }
  }
  return out;
}

export interface MeshLike {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
}

/** The mesh moved by `m`, with the winding corrected when `m` reflects. Triangle order is kept, so per-triangle face labels stay valid. */
export function transformMesh(mesh: MeshLike, m: Affine): { readonly positionsMm: number[]; readonly indices: number[] } {
  return { positionsMm: transformPositions(mesh.positionsMm, m), indices: transformIndices(mesh.indices, m) };
}

/** Two meshes as one body without a Boolean: for copies that do not touch. */
export function concatMeshes(first: MeshLike, second: MeshLike): { readonly positionsMm: number[]; readonly indices: number[] } {
  const offset = first.positionsMm.length / 3;
  return { positionsMm: [...first.positionsMm, ...second.positionsMm], indices: [...first.indices, ...second.indices.map((index) => index + offset)] };
}

export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

export function meshBounds(positionsMm: readonly number[]): Bounds | undefined {
  if (positionsMm.length < 3) return undefined;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < positionsMm.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positionsMm[i + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return { min, max };
}

/** Whether two boxes share volume (not merely a face), within `tolerance`. */
export function boundsOverlap(a: Bounds, b: Bounds, tolerance = 1e-6): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (a.max[axis]! <= b.min[axis]! + tolerance || b.max[axis]! <= a.min[axis]! + tolerance) return false;
  }
  return true;
}

/** Whether two boxes touch or overlap at all, within `tolerance`: the case where a Boolean join has something to work with. */
export function boundsTouch(a: Bounds, b: Bounds, tolerance = 1e-6): boolean {
  for (let axis = 0; axis < 3; axis += 1) {
    if (a.max[axis]! < b.min[axis]! - tolerance || b.max[axis]! < a.min[axis]! - tolerance) return false;
  }
  return true;
}

export interface PatternContext {
  readonly axes?: readonly ConstructionAxis[];
  readonly planes?: readonly ConstructionPlane[];
  readonly bodies?: readonly GeneralSolidBody[];
}

export type PatternLayout =
  | { readonly ok: true; readonly transforms: readonly Affine[] }
  | { readonly ok: false; readonly message: string };

/** The line a circular pattern turns about, with a construction axis followed from the part. */
export function resolvePatternAxis(ref: PatternAxisRef, context: PatternContext = {}): { readonly origin: Vec3; readonly direction: Vec3 } | { readonly error: string } {
  if (ref.kind === "datum") return { origin: [0, 0, 0], direction: ref.axis === "x" ? [1, 0, 0] : ref.axis === "y" ? [0, 1, 0] : [0, 0, 1] };
  const axis = context.axes?.find((candidate) => candidate.id === ref.axisId);
  if (axis === undefined) return { error: "The construction axis this pattern turns about is no longer in the part." };
  const frame = evaluateConstructionAxis(axis, context.bodies ?? []);
  return "error" in frame ? { error: frame.error } : { origin: frame.origin, direction: frame.direction };
}

/** The plane a mirror reflects across: a datum plane (optionally moved along its axis) or a construction plane followed from the part. */
export function resolvePatternPlane(ref: PatternPlaneRef, context: PatternContext = {}): { readonly point: Vec3; readonly normal: Vec3 } | { readonly error: string } {
  if (ref.kind === "datum") {
    const offset = ref.offsetMm ?? 0;
    if (ref.plane === "xy") return { point: [0, 0, offset], normal: [0, 0, 1] };
    if (ref.plane === "xz") return { point: [0, offset, 0], normal: [0, 1, 0] };
    return { point: [offset, 0, 0], normal: [1, 0, 0] };
  }
  const plane = context.planes?.find((candidate) => candidate.id === ref.planeId);
  if (plane === undefined) return { error: "The construction plane this mirror reflects across is no longer in the part." };
  const frame = evaluateConstructionPlane(plane, context.bodies ?? [], context.axes ?? []);
  return "error" in frame ? { error: frame.error } : { point: frame.origin, normal: frame.normal };
}

/** The maps for every copy after the original, in the order the copies are numbered. */
export function patternTransforms(shape: PatternShape, context: PatternContext = {}): PatternLayout {
  if (shape.type === "rectangular") {
    const a = unit(shape.directionA);
    const b = unit(shape.directionB);
    if (a === undefined || (shape.countB > 1 && b === undefined)) return { ok: false, message: "A pattern direction has zero length." };
    if (shape.countA > 1 && shape.countB > 1 && b !== undefined) {
      const cross = Math.hypot(a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]);
      if (cross < 1e-6) return { ok: false, message: "The two pattern directions are parallel, so the copies would land on each other." };
    }
    const stepA = shape.countA > 1 ? (shape.sizing === "extent" ? shape.spacingAMm / (shape.countA - 1) : shape.spacingAMm) : 0;
    const stepB = shape.countB > 1 ? (shape.sizing === "extent" ? shape.spacingBMm / (shape.countB - 1) : shape.spacingBMm) : 0;
    if ((shape.countA > 1 && !(stepA > 0)) || (shape.countB > 1 && !(stepB > 0))) return { ok: false, message: "The pattern spacing must be greater than zero." };
    const transforms: Affine[] = [];
    for (let j = 0; j < shape.countB; j += 1) {
      for (let i = 0; i < shape.countA; i += 1) {
        if (i === 0 && j === 0) continue;
        const offset: Vec3 = [
          a[0] * stepA * i + (b === undefined ? 0 : b[0] * stepB * j),
          a[1] * stepA * i + (b === undefined ? 0 : b[1] * stepB * j),
          a[2] * stepA * i + (b === undefined ? 0 : b[2] * stepB * j)
        ];
        transforms.push(translationAffine([clean(offset[0]), clean(offset[1]), clean(offset[2])]));
      }
    }
    return { ok: true, transforms };
  }
  if (shape.type === "circular") {
    const axis = resolvePatternAxis(shape.axis, context);
    if ("error" in axis) return { ok: false, message: axis.error };
    const full = Math.abs(shape.totalAngleDeg) >= 360 - 1e-9;
    const step = full ? shape.totalAngleDeg / shape.count : shape.totalAngleDeg / (shape.count - 1);
    const transforms: Affine[] = [];
    for (let i = 1; i < shape.count; i += 1) transforms.push(rotationAffine(axis.origin, axis.direction, (step * i * Math.PI) / 180));
    return { ok: true, transforms };
  }
  const plane = resolvePatternPlane(shape.plane, context);
  if ("error" in plane) return { ok: false, message: plane.error };
  return { ok: true, transforms: [reflectionAffine(plane.point, plane.normal)] };
}

export interface PatternSummary {
  /** Instances including the original. */
  readonly instances: number;
  readonly copies: number;
  readonly minMm: Vec3;
  readonly maxMm: Vec3;
  readonly extentMm: Vec3;
  /** Pairs of instances whose bounding boxes share volume: copies that probably overlap and need Join. */
  readonly overlappingPairs: number;
  readonly text: string;
}

/** The numbers the pattern dialog previews: how many copies there are, how far the pattern reaches and whether copies overlap. */
export function summarizePattern(transforms: readonly Affine[], positionsMm: readonly number[]): PatternSummary | undefined {
  const own = meshBounds(positionsMm);
  if (own === undefined) return undefined;
  const boxes: Bounds[] = [own];
  for (const transform of transforms) {
    const moved = meshBounds(transformPositions(positionsMm, transform));
    if (moved !== undefined) boxes.push(moved);
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const box of boxes) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, box.min[axis]!);
      max[axis] = Math.max(max[axis]!, box.max[axis]!);
    }
  }
  let overlappingPairs = 0;
  for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) if (boundsOverlap(boxes[i]!, boxes[j]!, 1e-4)) overlappingPairs += 1;
  const extent: Vec3 = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const fixed = (value: number): string => String(Number(value.toFixed(2)));
  const text = `${boxes.length} instances (${transforms.length} ${transforms.length === 1 ? "copy" : "copies"}), reaching ${fixed(extent[0])} × ${fixed(extent[1])} × ${fixed(extent[2])} mm${overlappingPairs === 0 ? "" : `; ${overlappingPairs} pair${overlappingPairs === 1 ? "" : "s"} overlap, so Join them or widen the spacing`}`;
  return { instances: boxes.length, copies: transforms.length, minMm: min, maxMm: max, extentMm: extent, overlappingPairs, text };
}
