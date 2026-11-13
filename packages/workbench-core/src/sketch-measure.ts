import { splineLengthMm } from "./spline-curvature.js";
import type { SketchEntity, SketchPointRef, Vec2, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";
import { SKETCH_AXIS_X_ID, SKETCH_AXIS_Y_ID, SKETCH_ORIGIN_ID } from "./types.js";

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

/** Where a named defining point of an entity is, or the origin; undefined when the entity has no such point. */
export function livePointOf(entity: SketchEntity | undefined, ref: SketchPointRef | undefined): Vec2 | undefined {
  if (entity === undefined) return undefined;
  switch (entity.kind) {
    case "point": return ref === undefined || ref === "self" ? entity.point : undefined;
    case "line": return ref === "start" ? entity.start : ref === "end" ? entity.end : ref === "mid" ? [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2] : undefined;
    case "circle":
    case "ellipse": return ref === "center" ? entity.center : undefined;
    case "arc": {
      if (ref === "start") return entity.start;
      if (ref === "end") return entity.end;
      if (ref === "mid") return entity.mid;
      return ref === "center" ? arcShape(entity.start, entity.mid, entity.end)?.center : undefined;
    }
    case "rectangle": {
      if (ref === "center") return entity.center;
      const corner = /^corner-([0-3])$/u.exec(ref ?? "");
      if (corner === null) return undefined;
      const k = Number(corner[1]);
      const sx = (k === 0 || k === 3 ? -0.5 : 0.5) * entity.widthMm;
      const sy = (k === 0 || k === 1 ? -0.5 : 0.5) * entity.heightMm;
      const turn = (entity.rotationDeg * Math.PI) / 180;
      return [entity.center[0] + Math.cos(turn) * sx - Math.sin(turn) * sy, entity.center[1] + Math.sin(turn) * sx + Math.cos(turn) * sy];
    }
    case "spline": return undefined;
  }
}

function datumLine(id: string): { readonly start: Vec2; readonly end: Vec2 } | undefined {
  return id === SKETCH_AXIS_X_ID ? { start: [0, 0], end: [1, 0] } : id === SKETCH_AXIS_Y_ID ? { start: [0, 0], end: [0, 1] } : undefined;
}

/** What a dimension constraint measures in the current geometry: degrees for an angle, millimetres otherwise; undefined when it cannot be measured. */
export function measureDimensionConstraint(sketch: Pick<WorkbenchSketch, "entities">, constraint: WorkbenchSketchConstraint): number | undefined {
  const entities = constraint.entityIds.map((id) => sketch.entities.find((entity) => entity.id === id));
  const datum = constraint.entityIds.map((id) => id === SKETCH_ORIGIN_ID || datumLine(id) !== undefined);
  if (entities.some((entity, index) => entity === undefined && !datum[index])) return undefined;
  const [first, second] = entities as readonly SketchEntity[];
  const lineOf = (index: number): { readonly start: Vec2; readonly end: Vec2 } | undefined => {
    const entity = entities[index];
    return entity?.kind === "line" ? entity : datumLine(constraint.entityIds[index] ?? "");
  };
  const pointOf = (index: number): Vec2 | undefined => constraint.entityIds[index] === SKETCH_ORIGIN_ID ? [0, 0] : livePointOf(entities[index], constraint.points?.[index]);
  switch (constraint.kind) {
    case "angle": {
      if (entities.length === 1) return first?.kind === "ellipse" ? ((first.rotationDeg % 360) + 360) % 360 : undefined;
      const a = lineOf(0);
      const b = lineOf(1);
      if (a === undefined || b === undefined) return undefined;
      const turn = ((Math.atan2(b.end[1] - b.start[1], b.end[0] - b.start[0]) - Math.atan2(a.end[1] - a.start[1], a.end[0] - a.start[0])) * 180) / Math.PI;
      const wrapped = ((turn % 360) + 360) % 360;
      return wrapped > 360 - 1e-9 ? 0 : wrapped;
    }
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
    case "radius": {
      const scale = constraint.dimension === "diameter" ? 2 : 1;
      if (first?.kind === "ellipse") return constraint.dimension === "minor-radius" ? first.minorRadiusMm : first.majorRadiusMm;
      return first?.kind === "circle" ? scale * first.radiusMm : first?.kind === "arc" ? scale * (arcShape(first.start, first.mid, first.end)?.radiusMm ?? NaN) : undefined;
    }
    case "distance": {
      switch (constraint.dimension) {
        case "aligned": case "horizontal": case "vertical": {
          const a = pointOf(0);
          const b = pointOf(1);
          if (a === undefined || b === undefined) return undefined;
          return constraint.dimension === "horizontal" ? Math.abs(b[0] - a[0]) : constraint.dimension === "vertical" ? Math.abs(b[1] - a[1]) : Math.hypot(b[0] - a[0], b[1] - a[1]);
        }
        case "point-line": case "line-line": {
          const line = constraint.dimension === "point-line" ? lineOf(1) : lineOf(0);
          const other = constraint.dimension === "point-line" ? pointOf(0) : (() => { const l = lineOf(1); return l === undefined ? undefined : ([(l.start[0] + l.end[0]) / 2, (l.start[1] + l.end[1]) / 2] as Vec2); })();
          if (line === undefined || other === undefined) return undefined;
          const ux = line.end[0] - line.start[0];
          const uy = line.end[1] - line.start[1];
          // A diameter across the line reads twice the distance to it.
          return (constraint.doubled === true ? 2 : 1) * Math.abs(ux * (other[1] - line.start[1]) - uy * (other[0] - line.start[0])) / Math.max(Math.hypot(ux, uy), 1e-12);
        }
        case "offset": {
          const radiusOf = (entity: SketchEntity | undefined): number | undefined => entity?.kind === "circle" ? entity.radiusMm : entity?.kind === "arc" ? arcShape(entity.start, entity.mid, entity.end)?.radiusMm : undefined;
          const a = radiusOf(first);
          const b = radiusOf((entities as readonly (SketchEntity | undefined)[])[1]);
          return a === undefined || b === undefined ? undefined : Math.abs(b - a);
        }
        default:
          break;
      }
      if (first?.kind === "line") return Math.hypot(first.end[0] - first.start[0], first.end[1] - first.start[1]);
      if (first?.kind === "rectangle") return constraint.dimension === "height" ? first.heightMm : first.widthMm;
      return undefined;
    }
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
