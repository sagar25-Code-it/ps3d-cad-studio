import type { SketchEntity, Vec2 } from "../../workbench-core/src/index.js";
import { sampleArc, sampleSpline } from "./curve-sampling.js";
import { entityPoints } from "./index.js";
import { nearestEntityId, type SketchEditContext, type SketchEditPlan } from "./edit-tools.js";
import { distanceToEntity } from "./select-other.js";
import { trimAt } from "./trim-extend.js";

/**
 * What Trim would remove if the person clicked now, for the highlight that follows the pointer: the stretches of the curve under the
 * pointer that the edit takes away, as polylines in sketch millimetres. It is computed by running the real Trim on the curve under the
 * pointer and keeping the parts of the curve that the result no longer covers, so the highlight is exactly what the click does (and shows
 * nothing when the click would be refused).
 */
export interface TrimPreview {
  readonly targetId: string;
  readonly removed: readonly (readonly Vec2[])[];
}

/** Beyond this many curves the preview is not drawn while the pointer moves, so a large sketch stays smooth. */
export const TRIM_PREVIEW_MAX_ENTITIES = 300;

function lerpPolyline(points: readonly Vec2[], closed: boolean, perSegment: number): readonly Vec2[] {
  const out: Vec2[] = [];
  const count = closed ? points.length : points.length - 1;
  for (let index = 0; index < count; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    for (let step = 0; step < perSegment; step += 1) out.push([a[0] + ((b[0] - a[0]) * step) / perSegment, a[1] + ((b[1] - a[1]) * step) / perSegment]);
  }
  if (!closed) out.push(points[points.length - 1]!);
  return out;
}

/** The outline of a curve as a polyline dense enough to tell the part that stays from the part that goes. */
export function outlineSamples(entity: SketchEntity): readonly Vec2[] {
  switch (entity.kind) {
    case "line": return lerpPolyline([entity.start, entity.end], false, 96);
    case "rectangle": return lerpPolyline(entityPoints(entity), true, 32);
    case "arc": return lerpPolyline(sampleArc(entity.start, entity.mid, entity.end), false, 3);
    case "spline": return lerpPolyline(sampleSpline(entity.fitPoints, 24), false, 2);
    case "circle": return Array.from({ length: 180 }, (_, index): Vec2 => [entity.center[0] + entity.radiusMm * Math.cos((index / 180) * Math.PI * 2), entity.center[1] + entity.radiusMm * Math.sin((index / 180) * Math.PI * 2)]);
    case "ellipse": {
      const radians = (entity.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      return Array.from({ length: 180 }, (_, index): Vec2 => {
        const theta = (index / 180) * Math.PI * 2;
        const x = entity.majorRadiusMm * Math.cos(theta);
        const y = entity.minorRadiusMm * Math.sin(theta);
        return [entity.center[0] + x * cos - y * sin, entity.center[1] + x * sin + y * cos];
      });
    }
    case "point": return [];
  }
}

/** The stretches of `target` that the plan no longer covers: the curve is removed, or its replacement pieces do not reach there. */
export function removedByPlan(target: SketchEntity, plan: SketchEditPlan): readonly (readonly Vec2[])[] {
  const samples = outlineSamples(target);
  if (samples.length < 2) return [];
  const kept = [...plan.updateEntities.filter((entity) => entity.id === target.id), ...plan.addEntities];
  const stays = (point: Vec2, tolerance: number): boolean => kept.some((entity) => distanceToEntity(entity, point) <= tolerance);
  const xs = samples.map((point) => point[0]);
  const ys = samples.map((point) => point[1]);
  const extent = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), 1);
  const tolerance = extent * 0.002;
  // Where a stretch ends between a sample that goes and one that stays: found by halving, so the highlight meets the kept piece.
  const boundary = (goes: Vec2, stayed: Vec2): Vec2 => {
    let near = goes;
    let far = stayed;
    for (let step = 0; step < 14; step += 1) {
      const mid: Vec2 = [(near[0] + far[0]) / 2, (near[1] + far[1]) / 2];
      if (stays(mid, tolerance)) far = mid; else near = mid;
    }
    return near;
  };
  const runs: Vec2[][] = [];
  let current: Vec2[] = [];
  let previous: Vec2 | undefined;
  let previousStays = false;
  for (const point of samples) {
    const keeps = stays(point, tolerance);
    if (keeps) {
      if (current.length > 0) { current.push(boundary(current[current.length - 1]!, point)); runs.push(current); current = []; }
    } else {
      if (current.length === 0 && previous !== undefined && previousStays) current.push(boundary(point, previous));
      current.push(point);
    }
    previous = point;
    previousStays = keeps;
  }
  if (current.length > 0) runs.push(current);
  // A run of one sample draws nothing.
  return runs.filter((run) => run.length >= 2);
}

/** The preview for the curve under `pick`, or undefined when there is none or Trim would refuse it. */
export function trimHoverPreview(context: SketchEditContext, pick: Vec2, toleranceMm: number): TrimPreview | undefined {
  if (context.sketch.entities.length > TRIM_PREVIEW_MAX_ENTITIES) return undefined;
  const targetId = nearestEntityId(context.sketch, pick, toleranceMm);
  if (targetId === undefined) return undefined;
  const target = context.sketch.entities.find((entity) => entity.id === targetId);
  if (target === undefined) return undefined;
  const plan = trimAt(context, targetId, pick);
  if (!plan.ok) return undefined;
  const removed = removedByPlan(target, plan.value);
  return removed.length === 0 ? undefined : { targetId, removed };
}

/** Whether two previews draw the same thing, so the canvas does not re-render for an unchanged highlight. */
export function sameTrimPreview(a: TrimPreview | undefined, b: TrimPreview | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.targetId !== b.targetId || a.removed.length !== b.removed.length) return false;
  return a.removed.every((run, index) => {
    const other = b.removed[index]!;
    return run.length === other.length && run[0]![0] === other[0]![0] && run[0]![1] === other[0]![1] && run[run.length - 1]![0] === other[other.length - 1]![0] && run[run.length - 1]![1] === other[other.length - 1]![1];
  });
}
