import type { SketchEntity, Vec2, WorkbenchSketch } from "../../workbench-core/src/index.js";
import { entityPoints, sampleArc, sampleSpline } from "./index.js";

/**
 * Select Other: when several curves lie under the pointer (two coincident lines, a line along the edge of a rectangle, a
 * circle and an arc of the same radius) a click can only take the top one. This lists everything under the pointer, nearest
 * first, and cycles through the list so Tab or Alt-click can reach the others.
 */
export interface SelectOtherCandidate {
  readonly id: string;
  readonly kind: SketchEntity["kind"];
  /** Distance from the pointer to the curve, in millimetres. */
  readonly distanceMm: number;
  /** Text for the popup list, for example "Line 12.5 mm" or "Circle R5". */
  readonly label: string;
}

function distanceToSegment(point: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared < 1e-18 ? 0 : Math.min(1, Math.max(0, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + dx * t), point[1] - (a[1] + dy * t));
}

function distanceToPolyline(point: Vec2, points: readonly Vec2[], closed: boolean): number {
  let best = Infinity;
  const count = closed ? points.length : points.length - 1;
  for (let index = 0; index < count; index += 1) best = Math.min(best, distanceToSegment(point, points[index]!, points[(index + 1) % points.length]!));
  return best;
}

/** Exact distance from a point to a curve's outline (a polyline approximation only for splines, arcs and ellipses). */
export function distanceToEntity(entity: SketchEntity, point: Vec2): number {
  switch (entity.kind) {
    case "line": return distanceToSegment(point, entity.start, entity.end);
    case "circle": return Math.abs(Math.hypot(point[0] - entity.center[0], point[1] - entity.center[1]) - entity.radiusMm);
    case "rectangle": return distanceToPolyline(point, entityPoints(entity), true);
    case "arc": return distanceToPolyline(point, sampleArc(entity.start, entity.mid, entity.end), false);
    case "spline": return distanceToPolyline(point, sampleSpline(entity.fitPoints), false);
    case "ellipse": {
      const radians = (entity.rotationDeg * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const samples = Array.from({ length: 128 }, (_, index): Vec2 => {
        const theta = (index / 128) * Math.PI * 2;
        const x = entity.majorRadiusMm * Math.cos(theta);
        const y = entity.minorRadiusMm * Math.sin(theta);
        return [entity.center[0] + x * cos - y * sin, entity.center[1] + x * sin + y * cos];
      });
      return distanceToPolyline(point, samples, true);
    }
    case "point": return Math.hypot(point[0] - entity.point[0], point[1] - entity.point[1]);
  }
}

const KIND_NAMES: Readonly<Record<SketchEntity["kind"], string>> = {
  line: "Line", circle: "Circle", arc: "Arc", rectangle: "Rectangle", spline: "Spline", ellipse: "Ellipse", point: "Point"
};

function describe(entity: SketchEntity): string {
  const name = KIND_NAMES[entity.kind];
  const fix = (value: number): string => String(Number(value.toFixed(2)));
  switch (entity.kind) {
    case "line": return `${name} ${fix(Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]))} mm${entity.construction ? " (construction)" : ""}`;
    case "circle": return `${name} R${fix(entity.radiusMm)}${entity.construction ? " (construction)" : ""}`;
    case "rectangle": return `${name} ${fix(entity.widthMm)} × ${fix(entity.heightMm)}${entity.construction ? " (construction)" : ""}`;
    case "ellipse": return `${name} ${fix(entity.majorRadiusMm)} × ${fix(entity.minorRadiusMm)}${entity.construction ? " (construction)" : ""}`;
    default: return `${name}${entity.construction ? " (construction)" : ""}`;
  }
}

/**
 * Every visible curve within `toleranceMm` of `point`, nearest first. Curves at the same distance (coincident duplicates) keep
 * the order they have in the sketch, so cycling is stable from one call to the next.
 */
export function entitiesUnderPoint(sketch: Pick<WorkbenchSketch, "entities">, point: Vec2, toleranceMm: number): readonly SelectOtherCandidate[] {
  const found: (SelectOtherCandidate & { readonly order: number })[] = [];
  sketch.entities.forEach((entity, order) => {
    if (entity.visible === false) return;
    const distanceMm = distanceToEntity(entity, point);
    if (distanceMm <= toleranceMm) found.push({ id: entity.id, kind: entity.kind, distanceMm, label: describe(entity), order });
  });
  // Distances that differ by less than a micron count as equal, so duplicates stay in sketch order.
  found.sort((left, right) => Math.abs(left.distanceMm - right.distanceMm) < 1e-6 ? left.order - right.order : left.distanceMm - right.distanceMm);
  return found.map(({ order: _order, ...candidate }) => candidate);
}

/** The id after `currentId` in the list, wrapping round; the first one when `currentId` is not in it. */
export function nextInCycle(candidates: readonly Pick<SelectOtherCandidate, "id">[], currentId: string | null | undefined, direction: 1 | -1 = 1): string | undefined {
  if (candidates.length === 0) return undefined;
  const index = candidates.findIndex((candidate) => candidate.id === currentId);
  if (index < 0) return candidates[direction === 1 ? 0 : candidates.length - 1]!.id;
  return candidates[(index + direction + candidates.length) % candidates.length]!.id;
}

/** True when the two lists name the same curves in the same order (used to skip a re-render while the pointer moves). */
export function sameCandidates(left: readonly Pick<SelectOtherCandidate, "id">[], right: readonly Pick<SelectOtherCandidate, "id">[]): boolean {
  return left.length === right.length && left.every((candidate, index) => candidate.id === right[index]!.id);
}
