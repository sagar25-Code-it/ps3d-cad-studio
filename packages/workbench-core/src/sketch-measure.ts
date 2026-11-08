import { splineLengthMm } from "./spline-curvature.js";
import type { SketchEntity, Vec2, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";

/** Measuring the sketch: lengths, arc sweeps, perimeters and angles, and the value any dimension constraint reads off the geometry. */

export interface ArcShape {
  readonly center: Vec2;
  readonly radiusMm: number;
  /** True when start → mid → end runs counter-clockwise. */
  readonly counterClockwise: boolean;
  /** Angle swept from start through mid to end, in radians (0 to 2π). */
  readonly sweepRad: number;
}

/** The circle through a 3-point arc and how far the arc sweeps; undefined for three points in a line. */
export function arcShape(start: Vec2, mid: Vec2, end: Vec2): ArcShape | undefined {
  const determinant = 2 * (start[0] * (mid[1] - end[1]) + mid[0] * (end[1] - start[1]) + end[0] * (start[1] - mid[1]));
  if (Math.abs(determinant) < 1e-9) return undefined;
  const a2 = start[0] ** 2 + start[1] ** 2;
  const b2 = mid[0] ** 2 + mid[1] ** 2;
  const c2 = end[0] ** 2 + end[1] ** 2;
  const center: Vec2 = [
    (a2 * (mid[1] - end[1]) + b2 * (end[1] - start[1]) + c2 * (start[1] - mid[1])) / determinant,
    (a2 * (end[0] - mid[0]) + b2 * (start[0] - end[0]) + c2 * (mid[0] - start[0])) / determinant
  ];
  const radiusMm = Math.hypot(start[0] - center[0], start[1] - center[1]);
  const counterClockwise = (mid[0] - start[0]) * (end[1] - start[1]) - (mid[1] - start[1]) * (end[0] - start[0]) > 0;
  const startAngle = Math.atan2(start[1] - center[1], start[0] - center[0]);
  const endAngle = Math.atan2(end[1] - center[1], end[0] - center[0]);
  const turn = counterClockwise ? endAngle - startAngle : startAngle - endAngle;
  const sweepRad = ((turn % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
  return { center, radiusMm, counterClockwise, sweepRad };
}

/** Ramanujan's second approximation of an ellipse's perimeter (error below 1e-5 relative for any axis ratio met in a sketch). */
export function ellipsePerimeterMm(majorRadiusMm: number, minorRadiusMm: number): number {
  const a = Math.max(majorRadiusMm, minorRadiusMm);
  const b = Math.min(majorRadiusMm, minorRadiusMm);
  const h = ((a - b) / (a + b)) ** 2;
  return Math.PI * (a + b) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
}

/** Length of one curve: a line, the arc, the circumference of a circle, the perimeter of a rectangle or ellipse, a spline's arc length. */
export function entityLengthMm(entity: SketchEntity): number | undefined {
  switch (entity.kind) {
    case "line": return Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]);
    case "arc": {
      const shape = arcShape(entity.start, entity.mid, entity.end);
      return shape === undefined ? undefined : shape.radiusMm * shape.sweepRad;
    }
    case "circle": return 2 * Math.PI * entity.radiusMm;
    case "rectangle": return 2 * (entity.widthMm + entity.heightMm);
    case "ellipse": return ellipsePerimeterMm(entity.majorRadiusMm, entity.minorRadiusMm);
    case "spline": return splineLengthMm(entity.fitPoints);
    default: return undefined;
  }
}

/** Direction of a line, counter-clockwise from +X, in degrees (-180, 180]. */
export function lineDirectionDeg(line: Extract<SketchEntity, { kind: "line" }>): number {
  return (Math.atan2(line.end[1] - line.start[1], line.end[0] - line.start[0]) * 180) / Math.PI;
}

/** The angle counter-clockwise from the direction of `first` to the direction of `second`, in degrees in [0, 360). */
export function angleBetweenLinesDeg(first: Extract<SketchEntity, { kind: "line" }>, second: Extract<SketchEntity, { kind: "line" }>): number {
  const turn = (lineDirectionDeg(second) - lineDirectionDeg(first)) % 360;
  const wrapped = (turn + 360) % 360;
  // Round-off can leave 359.99999999999 for an exact zero; snap it.
  return wrapped > 360 - 1e-9 ? 0 : wrapped;
}

/** What a dimension constraint measures in the current geometry: degrees for an angle, millimetres otherwise; undefined when it cannot be measured. */
export function measureDimensionConstraint(sketch: Pick<WorkbenchSketch, "entities">, constraint: WorkbenchSketchConstraint): number | undefined {
  const entities = constraint.entityIds.map((id) => sketch.entities.find((entity) => entity.id === id));
  if (entities.some((entity) => entity === undefined)) return undefined;
  const [first, second] = entities as readonly SketchEntity[];
  switch (constraint.kind) {
    case "angle":
      return first?.kind === "line" && second?.kind === "line" ? angleBetweenLinesDeg(first, second) : undefined;
    case "arc-length":
      return first === undefined || entities.length !== 1 ? undefined : first.kind === "arc" || first.kind === "spline" || first.kind === "line" ? entityLengthMm(first) : undefined;
    case "perimeter": {
      let total = 0;
      for (const entity of entities as readonly SketchEntity[]) {
        const length = entity.kind === "point" ? undefined : entityLengthMm(entity);
        if (length === undefined) return undefined;
        total += length;
      }
      return total;
    }
    case "radius":
      return first?.kind === "circle" ? first.radiusMm : first?.kind === "arc" ? arcShape(first.start, first.mid, first.end)?.radiusMm : undefined;
    case "distance":
      if (first?.kind === "line") return Math.hypot(first.end[0] - first.start[0], first.end[1] - first.start[1]);
      if (first?.kind === "rectangle") return constraint.dimension === "height" ? first.heightMm : first.widthMm;
      return undefined;
    default:
      return undefined;
  }
}

/** True for constraints that are dimensions (they carry a value, or are measured when driven). */
export function isDimensionConstraint(constraint: Pick<WorkbenchSketchConstraint, "kind">): boolean {
  return constraint.kind === "radius" || constraint.kind === "distance" || constraint.kind === "angle" || constraint.kind === "arc-length" || constraint.kind === "perimeter";
}

/** The value a driving dimension holds: degrees for an angle, millimetres otherwise. */
export function dimensionTargetValue(constraint: WorkbenchSketchConstraint): number | undefined {
  return constraint.kind === "angle" ? constraint.valueDeg : constraint.valueMm;
}
