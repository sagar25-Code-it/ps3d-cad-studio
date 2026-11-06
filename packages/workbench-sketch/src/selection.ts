import type { SketchEntity, Vec2 } from "../../workbench-core/src/index.js";
import { entityExtents, entityPoints, sampleArc, sampleSpline } from "./index.js";

/** An axis-aligned selection rectangle in sketch millimetres. */
export interface SketchSelectionRect {
  readonly min: Vec2;
  readonly max: Vec2;
}

/**
 * Window selection (dragging left to right) takes only curves that lie entirely inside the box;
 * crossing selection (right to left) also takes every curve the box touches.
 */
export type SketchSelectionBoxMode = "window" | "crossing";

export function selectionBoxMode(startMm: Vec2, endMm: Vec2): SketchSelectionBoxMode {
  return endMm[0] >= startMm[0] ? "window" : "crossing";
}

export function selectionRect(startMm: Vec2, endMm: Vec2): SketchSelectionRect {
  return {
    min: [Math.min(startMm[0], endMm[0]), Math.min(startMm[1], endMm[1])],
    max: [Math.max(startMm[0], endMm[0]), Math.max(startMm[1], endMm[1])]
  };
}

/** The outline of an entity as a polyline; `closed` outlines repeat their first vertex implicitly. */
function entityPolyline(entity: SketchEntity): { readonly points: readonly Vec2[]; readonly closed: boolean } {
  if (entity.kind === "line") return { points: [entity.start, entity.end], closed: false };
  if (entity.kind === "rectangle") return { points: entityPoints(entity), closed: true };
  if (entity.kind === "circle") {
    const points = Array.from({ length: 64 }, (_, index): Vec2 => {
      const angle = (index / 64) * Math.PI * 2;
      return [entity.center[0] + entity.radiusMm * Math.cos(angle), entity.center[1] + entity.radiusMm * Math.sin(angle)];
    });
    return { points, closed: true };
  }
  if (entity.kind === "arc") return { points: sampleArc(entity.start, entity.mid, entity.end), closed: false };
  if (entity.kind === "spline") return { points: sampleSpline(entity.fitPoints), closed: false };
  return { points: [entity.point], closed: false };
}

/** Liang-Barsky: does the segment from a to b touch the rectangle (inside or crossing an edge)? */
function segmentTouchesRect(a: Vec2, b: Vec2, rect: SketchSelectionRect): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const p = [-dx, dx, -dy, dy] as const;
  const q = [a[0] - rect.min[0], rect.max[0] - a[0], a[1] - rect.min[1], rect.max[1] - a[1]] as const;
  for (let index = 0; index < 4; index += 1) {
    const pi = p[index]!;
    const qi = q[index]!;
    if (pi === 0) {
      if (qi < 0) return false;
    } else {
      const t = qi / pi;
      if (pi < 0) {
        if (t > t1) return false;
        if (t > t0) t0 = t;
      } else {
        if (t < t0) return false;
        if (t < t1) t1 = t;
      }
    }
  }
  return true;
}

export function entityTouchesRect(entity: SketchEntity, rect: SketchSelectionRect): boolean {
  const { points, closed } = entityPolyline(entity);
  if (points.length === 1) {
    const point = points[0]!;
    return point[0] >= rect.min[0] && point[0] <= rect.max[0] && point[1] >= rect.min[1] && point[1] <= rect.max[1];
  }
  const count = closed ? points.length : points.length - 1;
  for (let index = 0; index < count; index += 1) {
    if (segmentTouchesRect(points[index]!, points[(index + 1) % points.length]!, rect)) return true;
  }
  return false;
}

export function entityInsideRect(entity: SketchEntity, rect: SketchSelectionRect): boolean {
  const extents = entityExtents(entity);
  return extents.min[0] >= rect.min[0] && extents.max[0] <= rect.max[0] && extents.min[1] >= rect.min[1] && extents.max[1] <= rect.max[1];
}

/** Ids of the visible entities a selection box picks, in sketch order. */
export function entitiesInSelectionBox(entities: readonly SketchEntity[], rect: SketchSelectionRect, mode: SketchSelectionBoxMode): readonly string[] {
  return entities
    .filter((entity) => entity.visible !== false)
    .filter((entity) => mode === "window" ? entityInsideRect(entity, rect) : entityTouchesRect(entity, rect))
    .map((entity) => entity.id);
}
