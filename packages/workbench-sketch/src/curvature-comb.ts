import type { SketchEntity, Vec2 } from "../../workbench-core/src/index.js";
import { sampleArc, sampleSpline } from "./index.js";

/** One tooth of a curvature comb: it stands on the curve at `base` and points away from the centre of curvature. */
export interface CombTooth {
  readonly base: Vec2;
  readonly tip: Vec2;
  /** Unsigned curvature at the base, 1/mm. */
  readonly curvature: number;
  /** +1 when the curve turns left (counter-clockwise) here, -1 when it turns right, 0 when straight. */
  readonly turn: -1 | 0 | 1;
}

export interface CurvatureComb {
  readonly teeth: readonly CombTooth[];
  /** The tooth tips joined in order: the comb's envelope, whose smoothness shows the curve's G2 quality. */
  readonly envelope: readonly Vec2[];
  readonly maxCurvature: number;
  /** Smallest radius of curvature on the curve (mm), or Infinity for a straight curve. */
  readonly minRadiusMm: number;
}

const CIRCLE_SAMPLES = 96;
const MAX_TEETH = 160;

/**
 * Discrete curvature comb along a sampled curve. Curvature at each vertex is the reciprocal of the circumradius of it and
 * its two neighbours, and the tooth length is `curvature × scaleMm`. Teeth point away from the centre of curvature, so a
 * circle gets outward teeth and an S-curve flips sides at its inflection point. Open curves take their end teeth from the
 * nearest interior vertex.
 */
export function curvatureCombOf(points: readonly Vec2[], closed: boolean, scaleMm: number): CurvatureComb {
  const count = points.length;
  if (count < 3 || !Number.isFinite(scaleMm) || scaleMm <= 0) return { teeth: [], envelope: [], maxCurvature: 0, minRadiusMm: Infinity };
  const curvature = new Array<number>(count).fill(0);
  const turn = new Array<-1 | 0 | 1>(count).fill(0);
  const normal = new Array<Vec2>(count).fill([0, 0]);
  const evaluate = (index: number, before: Vec2, at: Vec2, after: Vec2): void => {
    const abx = at[0] - before[0];
    const aby = at[1] - before[1];
    const bcx = after[0] - at[0];
    const bcy = after[1] - at[1];
    const acx = after[0] - before[0];
    const acy = after[1] - before[1];
    const lengths = Math.hypot(abx, aby) * Math.hypot(bcx, bcy) * Math.hypot(acx, acy);
    const crossValue = abx * bcy - aby * bcx;
    const tangentLength = Math.hypot(acx, acy);
    if (lengths < 1e-12 || tangentLength < 1e-12) return;
    const value = (2 * Math.abs(crossValue)) / lengths;
    // Skip numerical noise from collinear samples.
    if (value < 1e-9) return;
    curvature[index] = value;
    turn[index] = crossValue > 0 ? 1 : -1;
    const tx = acx / tangentLength;
    const ty = acy / tangentLength;
    // Left turn: the centre is on the left, so the tooth points right (and the other way for a right turn).
    normal[index] = crossValue > 0 ? [ty, -tx] : [-ty, tx];
  };
  if (closed) {
    for (let i = 0; i < count; i += 1) evaluate(i, points[(i - 1 + count) % count]!, points[i]!, points[(i + 1) % count]!);
  } else {
    for (let i = 1; i < count - 1; i += 1) evaluate(i, points[i - 1]!, points[i]!, points[i + 1]!);
    curvature[0] = curvature[1]!; turn[0] = turn[1]!; normal[0] = normal[1]!;
    curvature[count - 1] = curvature[count - 2]!; turn[count - 1] = turn[count - 2]!; normal[count - 1] = normal[count - 2]!;
  }
  const stride = Math.max(1, Math.ceil(count / MAX_TEETH));
  const teeth: CombTooth[] = [];
  let maxCurvature = 0;
  for (let i = 0; i < count; i += stride) {
    const k = curvature[i]!;
    if (k > maxCurvature) maxCurvature = k;
    const base = points[i]!;
    const n = normal[i]!;
    teeth.push({ base, tip: [base[0] + n[0] * k * scaleMm, base[1] + n[1] * k * scaleMm], curvature: k, turn: turn[i]! });
  }
  return { teeth, envelope: teeth.map((tooth) => tooth.tip), maxCurvature, minRadiusMm: maxCurvature > 0 ? 1 / maxCurvature : Infinity };
}

/** Polyline of an entity's curve and whether it closes on itself, or undefined for entities that have no smooth curvature. */
export function combSamplesOf(entity: SketchEntity): { readonly points: readonly Vec2[]; readonly closed: boolean } | undefined {
  if (entity.kind === "arc") return { points: sampleArc(entity.start, entity.mid, entity.end), closed: false };
  if (entity.kind === "spline") return { points: sampleSpline(entity.fitPoints), closed: false };
  if (entity.kind === "circle") {
    const points: Vec2[] = [];
    for (let i = 0; i < CIRCLE_SAMPLES; i += 1) {
      const angle = (i / CIRCLE_SAMPLES) * Math.PI * 2;
      points.push([entity.center[0] + entity.radiusMm * Math.cos(angle), entity.center[1] + entity.radiusMm * Math.sin(angle)]);
    }
    return { points, closed: true };
  }
  if (entity.kind === "ellipse") {
    const rotation = (entity.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);
    const points: Vec2[] = [];
    for (let i = 0; i < CIRCLE_SAMPLES; i += 1) {
      const angle = (i / CIRCLE_SAMPLES) * Math.PI * 2;
      const x = entity.majorRadiusMm * Math.cos(angle);
      const y = entity.minorRadiusMm * Math.sin(angle);
      points.push([entity.center[0] + x * cos - y * sin, entity.center[1] + x * sin + y * cos]);
    }
    return { points, closed: true };
  }
  return undefined;
}

/**
 * Combs for every curved entity of a sketch, all drawn at one common scale so their lengths compare. `targetLengthMm` is
 * the length the tallest tooth gets, which keeps the comb readable at any zoom level.
 */
export function sketchCurvatureCombs(entities: readonly SketchEntity[], targetLengthMm: number): readonly { readonly entityId: string; readonly comb: CurvatureComb }[] {
  const sampled = entities.flatMap((entity) => {
    if (entity.visible === false) return [];
    const samples = combSamplesOf(entity);
    return samples === undefined ? [] : [{ entityId: entity.id, samples }];
  });
  const unit = sampled.map(({ entityId, samples }) => ({ entityId, samples, probe: curvatureCombOf(samples.points, samples.closed, 1) }));
  const peak = Math.max(0, ...unit.map((item) => item.probe.maxCurvature));
  if (peak <= 0) return [];
  const scaleMm = targetLengthMm / peak;
  return unit.map(({ entityId, samples }) => ({ entityId, comb: curvatureCombOf(samples.points, samples.closed, scaleMm) }));
}
