import { resampleClosedPolygon, type TessellatedMesh, type TessellatePlane } from "./tessellate.js";
import type { FlatLayout } from "./flat-pattern.js";

type Point2 = readonly [number, number];
type Vec3 = readonly [number, number, number];

/** Moves points built with the sketch plane's z axis as height onto the plane, the way the other tessellators place their meshes. */
function placeOnPlane(positions: readonly number[], plane: TessellatePlane): number[] {
  if (plane === "xy") return positions.slice();
  const out: number[] = [];
  for (let i = 0; i + 2 < positions.length; i += 3) {
    const x = positions[i]!;
    const y = positions[i + 1]!;
    const z = positions[i + 2]!;
    if (plane === "xz") out.push(x, -z, y);
    else if (plane === "yz-zup") out.push(z, x, y);
    else out.push(z, y, -x);
  }
  return out;
}

function signedArea(polygon: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]!;
    const b = polygon[(i + 1) % polygon.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

function cleanRing(ring: readonly Point2[]): Point2[] {
  const out: Point2[] = [];
  for (const point of ring) {
    const previous = out[out.length - 1];
    if (previous !== undefined && Math.hypot(point[0] - previous[0], point[1] - previous[1]) < 1e-9) continue;
    out.push([point[0], point[1]]);
  }
  const first = out[0];
  const last = out[out.length - 1];
  if (out.length > 1 && first !== undefined && last !== undefined && Math.hypot(first[0] - last[0], first[1] - last[1]) < 1e-9) out.pop();
  return out;
}

export interface LoftedBendSpec {
  /** Inner surface of the transition at the bottom and the top, as closed outlines in the sketch plane. */
  readonly bottomMm: readonly Point2[];
  readonly topMm: readonly Point2[];
  readonly heightMm: number;
  readonly thicknessMm: number;
}

const sub3 = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const unit3 = (a: Vec3): Vec3 => { const length = Math.hypot(a[0], a[1], a[2]); return length < 1e-12 ? [0, 0, 0] : [a[0] / length, a[1] / length, a[2] / length]; };

/**
 * A sheet-metal transition between two profiles: a ruled skin from the bottom outline to the top outline, `thicknessMm` thick, open
 * at both ends. The outlines are the inner surface; the outer surface is the same skin pushed out by the thickness along the surface
 * normal (mitred at corners so a polygon keeps a constant wall), cut square by the bottom and top planes. For a cone or cylinder the
 * skin is developable; for other pairs of outlines it is an honest ruled approximation of a lofted bend.
 */
export function tessellateLoftedBend(spec: LoftedBendSpec, plane: TessellatePlane): TessellatedMesh {
  const empty: TessellatedMesh = { positionsMm: [], indices: [] };
  const { heightMm, thicknessMm } = spec;
  if (![heightMm, thicknessMm].every(Number.isFinite) || !(heightMm > 0) || !(thicknessMm > 0)) return empty;
  let bottom = cleanRing(spec.bottomMm);
  let top = cleanRing(spec.topMm);
  if (bottom.length < 3 || top.length < 3) return empty;
  if (signedArea(bottom) < 0) bottom = bottom.reverse();
  if (signedArea(top) < 0) top = top.reverse();
  if (bottom.length !== top.length) {
    const count = Math.max(bottom.length, top.length, 24);
    bottom = resampleClosedPolygon(bottom, count).map((point): Point2 => [point[0], point[1]]);
    top = resampleClosedPolygon(top, count).map((point): Point2 => [point[0], point[1]]);
    if (bottom.length !== top.length) return empty;
  }
  const n = bottom.length;
  const bottomAt = (k: number): Vec3 => [bottom[k]![0], bottom[k]![1], 0];
  const topAt = (k: number): Vec3 => [top[k]![0], top[k]![1], heightMm];
  // Outward normal of the ruled face between generators j and j+1.
  const faceNormals: Vec3[] = [];
  for (let j = 0; j < n; j += 1) {
    const next = (j + 1) % n;
    const alongBottom = sub3(bottomAt(next), bottomAt(j));
    const alongTop = sub3(topAt(next), topAt(j));
    const slantFrom = sub3(topAt(j), bottomAt(j));
    const slantTo = sub3(topAt(next), bottomAt(next));
    const slant: Vec3 = [(slantFrom[0] + slantTo[0]) / 2, (slantFrom[1] + slantTo[1]) / 2, (slantFrom[2] + slantTo[2]) / 2];
    const edge: Vec3 = [(alongBottom[0] + alongTop[0]) / 2, (alongBottom[1] + alongTop[1]) / 2, (alongBottom[2] + alongTop[2]) / 2];
    faceNormals.push(unit3(cross3(edge, slant)));
  }
  const positions: number[] = [];
  const offsetOf: Vec3[] = [];
  for (let k = 0; k < n; k += 1) {
    const before = faceNormals[(k + n - 1) % n]!;
    const after = faceNormals[k]!;
    const denominator = 1 + dot3(before, after);
    if (denominator < 0.05) return empty;
    // Mitre vector: both neighbouring faces are pushed out by exactly the thickness.
    const mitre: Vec3 = [(before[0] + after[0]) / denominator, (before[1] + after[1]) / denominator, (before[2] + after[2]) / denominator];
    const slant = sub3(topAt(k), bottomAt(k));
    const slide = mitre[2] / slant[2];
    // Slide along the generator so the offset lands back on the bottom and top planes.
    offsetOf.push([thicknessMm * (mitre[0] - slide * slant[0]), thicknessMm * (mitre[1] - slide * slant[1]), 0]);
  }
  for (let k = 0; k < n; k += 1) positions.push(...bottomAt(k));
  for (let k = 0; k < n; k += 1) positions.push(...topAt(k));
  for (let k = 0; k < n; k += 1) positions.push(bottomAt(k)[0] + offsetOf[k]![0], bottomAt(k)[1] + offsetOf[k]![1], 0);
  for (let k = 0; k < n; k += 1) positions.push(topAt(k)[0] + offsetOf[k]![0], topAt(k)[1] + offsetOf[k]![1], heightMm);
  const innerBottom = (k: number): number => k % n;
  const innerTop = (k: number): number => n + (k % n);
  const outerBottom = (k: number): number => 2 * n + (k % n);
  const outerTop = (k: number): number => 3 * n + (k % n);
  const indices: number[] = [];
  for (let k = 0; k < n; k += 1) {
    indices.push(outerBottom(k), outerBottom(k + 1), outerTop(k + 1), outerBottom(k), outerTop(k + 1), outerTop(k));
    indices.push(innerBottom(k), innerTop(k + 1), innerBottom(k + 1), innerBottom(k), innerTop(k), innerTop(k + 1));
    indices.push(outerBottom(k), innerBottom(k + 1), outerBottom(k + 1), outerBottom(k), innerBottom(k), innerBottom(k + 1));
    indices.push(outerTop(k), outerTop(k + 1), innerTop(k + 1), outerTop(k), innerTop(k + 1), innerTop(k));
  }
  return { positionsMm: placeOnPlane(positions, plane), indices };
}

/** A circular outline's centre and radius when `outline` is (nearly) a circle, else undefined. */
export function circleOfOutline(outline: readonly Point2[]): { readonly centre: Point2; readonly radiusMm: number } | undefined {
  const ring = cleanRing(outline);
  if (ring.length < 12) return undefined;
  const cx = ring.reduce((sum, point) => sum + point[0], 0) / ring.length;
  const cy = ring.reduce((sum, point) => sum + point[1], 0) / ring.length;
  const radii = ring.map((point) => Math.hypot(point[0] - cx, point[1] - cy));
  const mean = radii.reduce((sum, value) => sum + value, 0) / radii.length;
  if (!(mean > 0) || radii.some((value) => Math.abs(value - mean) > mean * 1e-3)) return undefined;
  return { centre: [cx, cy], radiusMm: mean };
}

export interface ConeDevelopment {
  readonly layout: FlatLayout;
  /** Radius of the neutral surface at the bottom and the top ring. */
  readonly bottomNeutralRadiusMm: number;
  readonly topNeutralRadiusMm: number;
  /** Straight distance between the two rings along the surface. */
  readonly slantMm: number;
  /** Angle of the unrolled sector (360 degrees for a cylinder is a rectangle instead, so 0 there). */
  readonly sectorDeg: number;
  /** Outer and inner radius of the unrolled sector (the apex distance of each ring); 0 for a cylinder. */
  readonly outerRadiusMm: number;
  readonly innerRadiusMm: number;
  /** Length of the developed blank along the seam-free direction (a cylinder's circumference, or the sector's outer arc). */
  readonly outerArcMm: number;
}

/**
 * Unrolls a circular cone or cylinder transition into its flat blank. The inner surface radii are `bottomRadiusMm` and `topRadiusMm`;
 * the blank is developed along the neutral surface, which sits K × thickness inside the wall measured along its normal. A cone
 * unrolls to an annular sector of angle 360° × sin(half-angle), a cylinder to a rectangle. The seam is where the blank is cut.
 */
export function coneDevelopment(bottomRadiusMm: number, topRadiusMm: number, heightMm: number, thicknessMm: number, kFactor: number): ConeDevelopment | undefined {
  if (![bottomRadiusMm, topRadiusMm, heightMm, thicknessMm, kFactor].every(Number.isFinite) || bottomRadiusMm <= 0 || topRadiusMm <= 0 || heightMm <= 0 || thicknessMm <= 0) return undefined;
  const difference = bottomRadiusMm - topRadiusMm;
  const slant = Math.hypot(heightMm, difference);
  // The wall is tilted `phi` from the axis; a normal offset d moves the surface horizontally by d / cos(phi).
  const cosPhi = heightMm / slant;
  const horizontal = kFactor * thicknessMm / cosPhi;
  const bottomNeutral = bottomRadiusMm + horizontal;
  const topNeutral = topRadiusMm + horizontal;
  if (Math.abs(difference) < 1e-9 * slant) {
    const circumference = 2 * Math.PI * bottomNeutral;
    return {
      layout: { outlinesMm: [[[0, 0], [circumference, 0], [circumference, heightMm], [0, heightMm]]], bendLinesMm: [] },
      bottomNeutralRadiusMm: bottomNeutral, topNeutralRadiusMm: topNeutral, slantMm: slant, sectorDeg: 0, outerRadiusMm: 0, innerRadiusMm: 0, outerArcMm: circumference
    };
  }
  const sinPhi = Math.abs(difference) / slant;
  const big = Math.max(bottomNeutral, topNeutral);
  const small = Math.min(bottomNeutral, topNeutral);
  const outer = big / sinPhi;
  const inner = small / sinPhi;
  const sweep = 2 * Math.PI * sinPhi;
  const steps = Math.max(8, Math.ceil(sweep * 180 / Math.PI / 2));
  const points: Point2[] = [];
  for (let i = 0; i <= steps; i += 1) points.push([outer * Math.cos(sweep * i / steps), outer * Math.sin(sweep * i / steps)]);
  for (let i = steps; i >= 0; i -= 1) points.push([inner * Math.cos(sweep * i / steps), inner * Math.sin(sweep * i / steps)]);
  return {
    layout: { outlinesMm: [points], bendLinesMm: [] },
    bottomNeutralRadiusMm: bottomNeutral, topNeutralRadiusMm: topNeutral, slantMm: slant, sectorDeg: sweep * 180 / Math.PI, outerRadiusMm: outer, innerRadiusMm: inner, outerArcMm: 2 * Math.PI * big
  };
}
