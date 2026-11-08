import { MODEL_ENVELOPE, type SketchEntity, type Vec2 } from "../../workbench-core/src/index.js";

/**
 * The sketch size limits, checked where a shape is built so the refusal names the limit. Before this the builders
 * accepted NaN, Infinity and coordinates a million times too large, and the operation layer then refused the edit with
 * "A sketch entity is invalid or has a duplicate ID" or threw while serialising it.
 */
const COORDINATE_LIMIT = MODEL_ENVELOPE.maxSketchCoordinateMm;
/** Rectangle width and height limit, as the sketch validator has it. */
export const MAX_RECTANGLE_SIDE_MM = MODEL_ENVELOPE.maxSketchSizeMm;
/** Radius limit of circles and ellipse semi-axes. */
export const MAX_RADIUS_MM = MODEL_ENVELOPE.maxSketchRadiusMm;

function limit(value: number): string {
  return value.toLocaleString("en-US");
}

/** Why a clicked point cannot be used (not finite, or beyond the sketch limit), or undefined when it can. */
export function sketchPointProblem(point: Vec2): string | undefined {
  if (!Number.isFinite(point[0]) || !Number.isFinite(point[1])) return "A point has a coordinate that is not a finite number.";
  if (Math.abs(point[0]) > COORDINATE_LIMIT || Math.abs(point[1]) > COORDINATE_LIMIT) {
    return `The point (${trim(point[0])}, ${trim(point[1])}) is outside the sketch limit of ±${limit(COORDINATE_LIMIT)} mm in each direction.`;
  }
  return undefined;
}

/** The first problem among several points. */
export function sketchPointsProblem(points: readonly Vec2[]): string | undefined {
  for (const point of points) {
    const problem = sketchPointProblem(point);
    if (problem !== undefined) return problem;
  }
  return undefined;
}

/**
 * Why a built entity would be refused by the sketch validator, in words, or undefined when it fits every limit:
 * finite numbers, coordinates, circle and ellipse radii and rectangle sides within the model envelope (see workbench-core envelope.ts).
 */
export function sketchEntityLimitProblem(entity: SketchEntity): string | undefined {
  switch (entity.kind) {
    case "line": return sketchPointsProblem([entity.start, entity.end]);
    case "arc": return sketchPointsProblem([entity.start, entity.mid, entity.end]);
    case "point": return sketchPointProblem(entity.point);
    case "spline": return sketchPointsProblem(entity.fitPoints);
    case "circle": {
      const problem = sketchPointProblem(entity.center);
      if (problem !== undefined) return problem;
      return entity.radiusMm > MAX_RADIUS_MM ? `A circle radius of ${trim(entity.radiusMm)} mm is above the ${limit(MAX_RADIUS_MM)} mm sketch limit.` : undefined;
    }
    case "ellipse": {
      const problem = sketchPointProblem(entity.center);
      if (problem !== undefined) return problem;
      return entity.majorRadiusMm > MAX_RADIUS_MM ? `An ellipse radius of ${trim(entity.majorRadiusMm)} mm is above the ${limit(MAX_RADIUS_MM)} mm sketch limit.` : undefined;
    }
    case "rectangle": {
      const problem = sketchPointProblem(entity.center);
      if (problem !== undefined) return problem;
      return Math.max(entity.widthMm, entity.heightMm) > MAX_RECTANGLE_SIDE_MM ? `A rectangle side of ${trim(Math.max(entity.widthMm, entity.heightMm))} mm is above the ${limit(MAX_RECTANGLE_SIDE_MM)} mm sketch limit.` : undefined;
    }
  }
}

function trim(value: number): string {
  return Number.isFinite(value) ? String(Math.round(value * 1000) / 1000) : String(value);
}
