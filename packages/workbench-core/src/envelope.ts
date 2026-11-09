import { circleThroughThreePoints } from "./arc-geometry.js";
import { ENVELOPE_LIMITS, MAX_BODY_MESH_NUMBERS, MAX_BODY_VERTICES } from "./envelope-limits.js";
import { SPLINE_MAX_FIT_POINTS, SPLINE_MIN_FIT_POINTS } from "./spline-limits.js";
import type { WorkbenchDiagnostic } from "./types.js";

/**
 * The model envelope: one documented set of size limits that every layer (operation payloads, project loading, the sketch
 * dimension editor, solid features and the bodies they build) is checked against. A value outside it is refused with a message
 * that names the field, the value and the limit, not with a generic "invalid" text.
 *
 *  - Sketch geometry: coordinates up to +/-100 m, a rectangle side up to 200 m, a circle or ellipse radius up to 100 m, and nothing
 *    smaller than 0.01 mm (a line shorter than that, a radius below it, a spline whose neighbouring fit points are closer).
 *  - Solid features: a distance up to 100 m and at least 0.01 mm; a sketch plane offset up to 100 m.
 *  - Built bodies: every vertex within +/-1000 m, so a 100 m part on a plane 100 m out still fits.
 */
export const MODEL_ENVELOPE = {
  ...ENVELOPE_LIMITS,
  maxSplineFitPoints: SPLINE_MAX_FIT_POINTS,
  minSplineFitPoints: SPLINE_MIN_FIT_POINTS
} as const;

export interface EnvelopeProblem {
  readonly code: WorkbenchDiagnostic["code"];
  readonly message: string;
  /** The entity the problem belongs to, when it has a usable ID. */
  readonly entityId?: string;
}

const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mm(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : String(Number(value.toPrecision(6)));
}

const FIELDS: Readonly<Record<string, readonly string[]>> = {
  line: ["id", "kind", "start", "end", "construction"],
  rectangle: ["id", "kind", "center", "widthMm", "heightMm", "rotationDeg", "construction"],
  circle: ["id", "kind", "center", "radiusMm", "construction"],
  ellipse: ["id", "kind", "center", "majorRadiusMm", "minorRadiusMm", "rotationDeg", "construction"],
  arc: ["id", "kind", "start", "mid", "end", "construction"],
  point: ["id", "kind", "point", "construction"],
  spline: ["id", "kind", "fitPoints", "construction"]
};

/**
 * Explains why a value is not a valid sketch entity, or returns undefined when it is one. The rules are the sketch-entity rules of
 * the project validator, with the limits of MODEL_ENVELOPE; the text always names the entity, the field and the limit.
 */
export function sketchEntityProblem(value: unknown): EnvelopeProblem | undefined {
  if (!isRecord(value)) return { code: "INVALID_OPERATION", message: "A sketch entity must be an object with an id, a kind and its geometry." };
  const rawId = value.id;
  const hasId = typeof rawId === "string" && rawId.length <= 128 && ID_PATTERN.test(rawId);
  const label = hasId ? `Sketch entity ${rawId as string}` : "A sketch entity";
  const withId = (problem: EnvelopeProblem): EnvelopeProblem => (hasId ? { ...problem, entityId: rawId as string } : problem);
  const bad = (message: string, code: WorkbenchDiagnostic["code"] = "INVALID_OPERATION"): EnvelopeProblem => withId({ code, message: `${label} ${message}` });
  if (!hasId) return { code: "INVALID_OPERATION", message: `A sketch entity has the id ${typeof rawId === "string" ? JSON.stringify(rawId.slice(0, 40)) : String(rawId)}, which is not a valid stable id. Use lowercase letters, digits and - . _ in the form entity:name.` };
  if (typeof value.construction !== "boolean") return bad("needs construction set to true or false.");
  if (Object.hasOwn(value, "visible") && typeof value.visible !== "boolean") return bad("has a visible flag that is not true or false.");
  const kind = value.kind;
  const fields = typeof kind === "string" ? FIELDS[kind] : undefined;
  if (fields === undefined) return bad(`has the unknown kind ${JSON.stringify(typeof kind === "string" ? kind.slice(0, 30) : String(kind))}. Use line, rectangle, circle, ellipse, arc, point or spline.`);
  const allowed = new Set([...fields, "visible"]);
  const extra = Object.keys(value).filter((key) => !allowed.has(key));
  if (extra.length > 0) return bad(`(${kind}) has the unsupported field${extra.length === 1 ? "" : "s"} ${extra.map((key) => `"${key}"`).join(", ")}.`);
  const absent = fields.filter((key) => !Object.hasOwn(value, key));
  if (absent.length > 0) return bad(`(${kind}) is missing the field${absent.length === 1 ? "" : "s"} ${absent.map((key) => `"${key}"`).join(", ")}.`);

  const limit = MODEL_ENVELOPE.maxSketchCoordinateMm;
  const point = (name: string, candidate: unknown): EnvelopeProblem | undefined => {
    if (!Array.isArray(candidate) || candidate.length !== 2) return bad(`(${kind}) needs ${name} as [x, y] in millimetres.`);
    for (const [axis, coordinate] of (candidate as readonly unknown[]).entries()) {
      const label2 = `${name} ${axis === 0 ? "x" : "y"}`;
      if (typeof coordinate !== "number" || !Number.isFinite(coordinate)) return bad(`(${kind}) has ${label2} = ${String(coordinate)}, which is not a finite number.`);
      if (Math.abs(coordinate) > limit) return bad(`(${kind}) has ${label2} = ${mm(coordinate)} mm, outside the +/-${mm(limit)} mm sketch limit.`, "OUTSIDE_SUPPORTED_ENVELOPE");
    }
    return undefined;
  };
  const size = (name: string, candidate: unknown, maximum: number): EnvelopeProblem | undefined => {
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) return bad(`(${kind}) has ${name} = ${String(candidate)}, which is not a finite number.`);
    if (candidate < MODEL_ENVELOPE.minGeometryMm) return bad(`(${kind}) has ${name} = ${mm(candidate)} mm; the smallest supported size is ${MODEL_ENVELOPE.minGeometryMm} mm.`, "DEGENERATE_GEOMETRY");
    if (candidate > maximum) return bad(`(${kind}) has ${name} = ${mm(candidate)} mm, above the ${mm(maximum)} mm limit.`, "OUTSIDE_SUPPORTED_ENVELOPE");
    return undefined;
  };
  const angle = (name: string, candidate: unknown): EnvelopeProblem | undefined => {
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) return bad(`(${kind}) has ${name} = ${String(candidate)}, which is not a finite number.`);
    if (candidate < -360 || candidate > 360) return bad(`(${kind}) has ${name} = ${mm(candidate)} degrees, outside -360 to 360.`, "OUTSIDE_SUPPORTED_ENVELOPE");
    return undefined;
  };

  switch (kind) {
    case "line": {
      const problem = point("start", value.start) ?? point("end", value.end);
      if (problem !== undefined) return problem;
      const [sx, sy] = value.start as readonly [number, number];
      const [ex, ey] = value.end as readonly [number, number];
      const length = Math.hypot(ex - sx, ey - sy);
      if (length < MODEL_ENVELOPE.minGeometryMm) return bad(`(line) is ${mm(length)} mm long; the shortest supported line is ${MODEL_ENVELOPE.minGeometryMm} mm.`, "DEGENERATE_GEOMETRY");
      return undefined;
    }
    case "rectangle":
      return point("center", value.center) ?? size("width", value.widthMm, MODEL_ENVELOPE.maxSketchSizeMm) ?? size("height", value.heightMm, MODEL_ENVELOPE.maxSketchSizeMm) ?? angle("rotation", value.rotationDeg);
    case "circle":
      return point("center", value.center) ?? size("radius", value.radiusMm, MODEL_ENVELOPE.maxSketchRadiusMm);
    case "ellipse": {
      const problem = point("center", value.center) ?? size("major radius", value.majorRadiusMm, MODEL_ENVELOPE.maxSketchRadiusMm) ?? size("minor radius", value.minorRadiusMm, MODEL_ENVELOPE.maxSketchRadiusMm) ?? angle("rotation", value.rotationDeg);
      if (problem !== undefined) return problem;
      if ((value.minorRadiusMm as number) > (value.majorRadiusMm as number) + 1e-9) return bad(`(ellipse) has a minor radius (${mm(value.minorRadiusMm as number)} mm) larger than its major radius (${mm(value.majorRadiusMm as number)} mm); swap them and turn the ellipse 90 degrees.`);
      return undefined;
    }
    case "arc": {
      const problem = point("start", value.start) ?? point("mid", value.mid) ?? point("end", value.end);
      if (problem !== undefined) return problem;
      const [a, b, c] = [value.start, value.mid, value.end] as readonly (readonly [number, number])[];
      // Judged relative to the arc's own size (see arc-geometry.ts), so a small well-formed arc is kept and a near-straight one is refused.
      if (circleThroughThreePoints(a!, b!, c!) === undefined) return bad("(arc) has its start, middle and end points on one straight line, so no circle passes through them. Move the middle point off the line.", "DEGENERATE_GEOMETRY");
      return undefined;
    }
    case "point":
      return point("point", value.point);
    case "spline": {
      const fit = value.fitPoints;
      if (!Array.isArray(fit)) return bad("(spline) needs fitPoints as a list of [x, y] points.");
      if (fit.length < MODEL_ENVELOPE.minSplineFitPoints || fit.length > MODEL_ENVELOPE.maxSplineFitPoints) {
        return bad(`(spline) has ${fit.length} fit points; a spline needs ${MODEL_ENVELOPE.minSplineFitPoints} to ${MODEL_ENVELOPE.maxSplineFitPoints}.`, "OUTSIDE_SUPPORTED_ENVELOPE");
      }
      for (const [index, candidate] of fit.entries()) {
        const problem = point(`fit point ${index + 1}`, candidate);
        if (problem !== undefined) return problem;
        if (index > 0) {
          const previous = fit[index - 1] as readonly [number, number];
          const gap = Math.hypot((candidate as readonly [number, number])[0] - previous[0], (candidate as readonly [number, number])[1] - previous[1]);
          if (gap < MODEL_ENVELOPE.minGeometryMm) return bad(`(spline) has fit points ${index} and ${index + 1} only ${mm(gap)} mm apart; keep neighbouring fit points at least ${MODEL_ENVELOPE.minGeometryMm} mm apart.`, "DEGENERATE_GEOMETRY");
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The path of the first number in a payload that is NaN or infinite, or undefined when every number is finite. */
export function firstNonFinitePath(value: unknown, path = "", depth = 0): string | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? undefined : path === "" ? "the value" : path;
  if (depth > 12 || typeof value !== "object" || value === null) return undefined;
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      const found = firstNonFinitePath(entry, `${path}[${index}]`, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  for (const [key, entry] of Object.entries(value)) {
    const found = firstNonFinitePath(entry, path === "" ? key : `${path}.${key}`, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

/** The reasons a solid feature or its body fall outside the envelope, named by field and limit; undefined when no limit is crossed. */
export function solidEnvelopeProblem(feature: unknown, body: unknown): EnvelopeProblem | undefined {
  if (isRecord(feature) && typeof feature.valueMm === "number") {
    const value = feature.valueMm;
    const kind = String(feature.kind);
    if (!Number.isFinite(value)) return { code: "INVALID_OPERATION", message: `The ${kind} feature has a value of ${String(value)}, which is not a finite number.` };
    if (value === 0) return { code: "INVALID_OPERATION", message: `The ${kind} feature has a value of 0; give it a distance or angle.` };
    const linear = kind === "extrude" || kind === "sweep" || kind === "loft";
    if (linear && Math.abs(value) < MODEL_ENVELOPE.minGeometryMm) {
      return { code: "DEGENERATE_GEOMETRY", message: `The ${kind} distance ${mm(Math.abs(value))} mm is below the ${MODEL_ENVELOPE.minGeometryMm} mm minimum a sketch can hold.` };
    }
    if (Math.abs(value) > MODEL_ENVELOPE.maxFeatureDistanceMm) {
      return { code: "OUTSIDE_SUPPORTED_ENVELOPE", message: `The ${kind} value ${mm(Math.abs(value))} is above the ${mm(MODEL_ENVELOPE.maxFeatureDistanceMm)} mm feature limit.` };
    }
  }
  if (isRecord(body) && Array.isArray(body.positionsMm)) {
    const positions = body.positionsMm as readonly unknown[];
    for (let index = 0; index < positions.length; index += 1) {
      const entry = positions[index];
      if (typeof entry !== "number" || !Number.isFinite(entry)) return { code: "INVALID_OPERATION", message: `The solid has a vertex coordinate that is not a finite number (position ${index}).` };
      if (Math.abs(entry) > MODEL_ENVELOPE.maxBodyCoordinateMm) {
        return { code: "OUTSIDE_SUPPORTED_ENVELOPE", message: `The solid reaches ${mm(Math.abs(entry))} mm from the origin; a model must stay within ${mm(MODEL_ENVELOPE.maxBodyCoordinateMm)} mm. Reduce the offset, distance or size of the feature.` };
      }
    }
    if (positions.length > MAX_BODY_MESH_NUMBERS) {
      const vertices = positions.length / 3;
      return { code: "RESOURCE_LIMIT", message: `The solid has ${vertices.toLocaleString("en-US")} vertices and a model stores at most ${MAX_BODY_VERTICES.toLocaleString("en-US")} per solid. Every triangle keeps its own three vertices, so a plate with round holes costs about 1,200 vertices per hole (fewer when the holes are coarser); this one is about ${Math.round(vertices / MAX_BODY_VERTICES * 100)}% over. Use fewer or simpler holes, split the part into two solids, or build the repeats from a pattern.` };
    }
  }
  return undefined;
}

/**
 * Why a batch of rebuild results was refused, in words: the first solid that does not fit the model (too many vertices, out of range) named
 * with its feature, or undefined when the problem is not a body at all. The operation itself only says the results are invalid.
 */
export function rebuildResultProblem(results: readonly unknown[]): string | undefined {
  for (const result of results) {
    if (!isRecord(result)) continue;
    const bodies = [result.body, ...(Array.isArray(result.pieces) ? (result.pieces as readonly unknown[]) : [])];
    for (const body of bodies) {
      const problem = body === undefined ? undefined : solidEnvelopeProblem(undefined, body);
      if (problem !== undefined) return `The rebuilt solid of ${typeof result.featureId === "string" ? result.featureId : "a feature"} cannot be stored: ${problem.message}`;
    }
  }
  return undefined;
}
