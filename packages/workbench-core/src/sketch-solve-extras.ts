import { arcShape, ellipsePerimeterMm } from "./sketch-measure.js";
import { adaptSplineEnd, splineEndFrame, type SplinePoint } from "./spline-curvature.js";
import type { SketchEntity, SketchPointRef, Vec2, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";

/**
 * The relations the live sketch solves after the analytic pass, because they act on entities the analytic backend does not
 * model (rectangles, ellipses, fit-point splines) or need a closed-form step of their own:
 *
 *  - Perimeter of a rectangle or ellipse (a circle's perimeter is a radius, solved by the backend).
 *  - Smooth (G2): a spline end that continues a line, arc or spline with matching position, tangent and curvature.
 *  - Refraction: a line bent at an interface line by Snell's law.
 *
 * Each runs on the geometry the analytic pass produced, so a neighbour that moved in that pass is followed.
 */

export interface ExtraUnsolved {
  readonly constraintId: string;
  readonly reason: string;
}

export type ExtraPassResult =
  | {
      readonly ok: true;
      readonly entities: readonly SketchEntity[];
      readonly movedIds: readonly string[];
      readonly notes: readonly string[];
      readonly unsolved: readonly ExtraUnsolved[];
    }
  | { readonly ok: false; readonly message: string; readonly relatedIds: readonly string[]; readonly recovery: string };

const EPS = 1e-9;
const JOIN_TOLERANCE_MM = 1e-6;

type Line = Extract<SketchEntity, { kind: "line" }>;

export function applyExtraConstraints(sketch: Pick<WorkbenchSketch, "entities" | "constraints">, inComponent: (id: string) => boolean): ExtraPassResult {
  const entities = new Map(sketch.entities.map((entity) => [entity.id, entity] as const));
  const moved = new Set<string>();
  const notes: string[] = [];
  const unsolved: ExtraUnsolved[] = [];
  const active = sketch.constraints.filter((constraint) => constraint.suppressed !== true && constraint.entityIds.some(inComponent));
  const fail = (message: string, relatedIds: readonly string[], recovery: string): ExtraPassResult => ({ ok: false, message, relatedIds, recovery });
  const put = (entity: SketchEntity): void => {
    entities.set(entity.id, entity);
    moved.add(entity.id);
  };

  for (const constraint of active) {
    if (constraint.kind === "perimeter" && constraint.driven !== true) {
      const entity = entities.get(constraint.entityIds[0] ?? "");
      if (entity === undefined || constraint.valueMm === undefined) continue;
      if (entity.kind === "rectangle") {
        const result = resizeRectangleToPerimeter(entity, constraint, active, entities);
        if (typeof result === "string") return fail(result, [constraint.id, entity.id], "Remove one of the width, height and perimeter dimensions, or make them agree.");
        if (result !== entity) { put(result); notes.push(`Resized rectangle ${label(entity.id)} to a perimeter of ${format(constraint.valueMm)} mm`); }
      } else if (entity.kind === "ellipse") {
        const current = ellipsePerimeterMm(entity.majorRadiusMm, entity.minorRadiusMm);
        const scale = constraint.valueMm / current;
        if (Math.abs(scale - 1) > EPS) {
          put({ ...entity, majorRadiusMm: entity.majorRadiusMm * scale, minorRadiusMm: entity.minorRadiusMm * scale });
          notes.push(`Scaled ellipse ${label(entity.id)} to a perimeter of ${format(constraint.valueMm)} mm`);
        }
      }
      continue;
    }
    if (constraint.kind === "smooth") {
      const outcome = applySmooth(constraint, entities, active);
      if (typeof outcome === "string") unsolved.push({ constraintId: constraint.id, reason: outcome });
      else if (outcome !== undefined) { put(outcome.entity); notes.push(outcome.note); }
      continue;
    }
    if (constraint.kind === "refraction") {
      const outcome = applyRefraction(constraint, entities);
      if (outcome.error !== undefined) return fail(outcome.error, [constraint.id, ...constraint.entityIds], "Change the refractive-index ratio or the incident line so the ray is not totally reflected.");
      if (outcome.entity !== undefined) { put(outcome.entity); notes.push(outcome.note!); }
    }
  }
  return { ok: true, entities: sketch.entities.map((entity) => entities.get(entity.id) ?? entity), movedIds: [...moved], notes, unsolved };
}

function label(id: string): string {
  return id.replace(/^entity:/u, "");
}

function format(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function resizeRectangleToPerimeter(
  rectangle: Extract<SketchEntity, { kind: "rectangle" }>,
  perimeter: WorkbenchSketchConstraint,
  constraints: readonly WorkbenchSketchConstraint[],
  _entities: ReadonlyMap<string, SketchEntity>
): SketchEntity | string {
  const half = perimeter.valueMm! / 2;
  const held = (dimension: "width" | "height"): boolean => constraints.some((candidate) => candidate.kind === "distance" && candidate.driven !== true && candidate.dimension === dimension && candidate.entityIds[0] === rectangle.id);
  const widthHeld = held("width");
  const heightHeld = held("height");
  let width = rectangle.widthMm;
  let height = rectangle.heightMm;
  if (widthHeld && heightHeld) {
    return Math.abs(2 * (width + height) - perimeter.valueMm!) <= 1e-6 ? rectangle : "The width, height and perimeter dimensions of this rectangle disagree.";
  }
  if (widthHeld) height = half - width;
  else if (heightHeld) width = half - height;
  else {
    const scale = perimeter.valueMm! / (2 * (width + height));
    width *= scale;
    height *= scale;
  }
  if (width <= 0.01 || height <= 0.01) return "That perimeter is too small for the rectangle's held side.";
  return Math.abs(width - rectangle.widthMm) <= EPS && Math.abs(height - rectangle.heightMm) <= EPS ? rectangle : { ...rectangle, widthMm: width, heightMm: height };
}

// ---------------------------------------------------------------------------------------------
// Smooth (G2)
// ---------------------------------------------------------------------------------------------

/** How a curve arrives at (or leaves) one of its end points, travelling toward the joint. */
interface JointFrame {
  readonly point: Vec2;
  /** Unit tangent in the direction of travel toward the joint. */
  readonly tangent: Vec2;
  /** Signed curvature in the direction of travel toward the joint. */
  readonly curvature: number;
}

function jointFrame(entity: SketchEntity, ref: SketchPointRef): JointFrame | string {
  if (ref !== "start" && ref !== "end") return "A smooth joint is at the start or the end of a curve.";
  if (entity.kind === "line") {
    const length = Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]);
    if (length < EPS) return "The line is too short to give a direction.";
    const along: Vec2 = [(entity.end[0] - entity.start[0]) / length, (entity.end[1] - entity.start[1]) / length];
    return ref === "end" ? { point: entity.end, tangent: along, curvature: 0 } : { point: entity.start, tangent: [-along[0], -along[1]], curvature: 0 };
  }
  if (entity.kind === "arc") {
    const shape = arcShape(entity.start, entity.mid, entity.end);
    if (shape === undefined) return "The arc is degenerate.";
    const point = ref === "end" ? entity.end : entity.start;
    const radial: Vec2 = [(point[0] - shape.center[0]) / shape.radiusMm, (point[1] - shape.center[1]) / shape.radiusMm];
    // Counter-clockwise travel at a point is the radius turned a quarter turn left; clockwise is the opposite.
    const natural: Vec2 = shape.counterClockwise ? [-radial[1], radial[0]] : [radial[1], -radial[0]];
    const naturalCurvature = (shape.counterClockwise ? 1 : -1) / shape.radiusMm;
    return ref === "end" ? { point, tangent: natural, curvature: naturalCurvature } : { point, tangent: [-natural[0], -natural[1]], curvature: -naturalCurvature };
  }
  if (entity.kind === "spline") {
    const frame = splineEndFrame(entity.fitPoints, ref);
    if (frame === undefined) return "The spline is degenerate at that end.";
    return ref === "end" ? { point: frame.point, tangent: frame.tangent, curvature: frame.curvature } : { point: frame.point, tangent: [-frame.tangent[0], -frame.tangent[1]], curvature: -frame.curvature };
  }
  return `A ${entity.kind} has no end to continue smoothly.`;
}

function applySmooth(
  constraint: WorkbenchSketchConstraint,
  entities: Map<string, SketchEntity>,
  active: readonly WorkbenchSketchConstraint[]
): { readonly entity: SketchEntity; readonly note: string } | string | undefined {
  const [firstId, secondId] = constraint.entityIds;
  const [firstRef, secondRef] = constraint.points ?? [];
  const first = entities.get(firstId ?? "");
  const second = entities.get(secondId ?? "");
  if (first === undefined || second === undefined || firstRef === undefined || secondRef === undefined) return "Smooth needs the two curves and the end of each that meets.";
  // The spline adapts to its neighbour; with two splines the first one adapts.
  const adaptsFirst = first.kind === "spline";
  const spline = adaptsFirst ? first : second;
  const splineRef = adaptsFirst ? firstRef : secondRef;
  const neighbour = adaptsFirst ? second : first;
  const neighbourRef = adaptsFirst ? secondRef : firstRef;
  if (spline.kind !== "spline" || (splineRef !== "start" && splineRef !== "end")) return "Smooth acts on the end of a spline.";
  if (spline.fitPoints.length < 3) return "The spline needs at least three fit points.";
  const bothEnds = active.filter((candidate) => candidate.kind === "smooth" && candidate.id !== constraint.id && candidate.entityIds.includes(spline.id));
  if (bothEnds.length > 0 && spline.fitPoints.length < 6) return "A spline needs at least six fit points to be smooth at both of its ends.";
  const joint = jointFrame(neighbour, neighbourRef);
  if (typeof joint === "string") return joint;
  const adapted = adaptSplineEnd(spline.fitPoints as readonly SplinePoint[], splineRef, joint.point, joint.tangent, joint.curvature);
  if (!adapted.ok) return adapted.reason;
  const before = spline.fitPoints;
  const same = adapted.fitPoints.every((point, index) => Math.abs(point[0] - before[index]![0]) <= EPS && Math.abs(point[1] - before[index]![1]) <= EPS);
  return same ? undefined : { entity: { ...spline, fitPoints: adapted.fitPoints as readonly Vec2[] }, note: `Blended the ${splineRef} of spline ${label(spline.id)} into ${neighbour.kind} ${label(neighbour.id)} (position, tangent and curvature)` };
}

// ---------------------------------------------------------------------------------------------
// Refraction
// ---------------------------------------------------------------------------------------------

/**
 * Snell's law at an interface line. `entityIds` are the incident line, the refracted line and the interface line. The incident
 * line runs toward the interface and meets it at its end point; the refracted line leaves that point. With r = n2 / n1 the
 * component of the direction along the interface is divided by r, and the component across it keeps its side, so
 * sin(theta1) = r sin(theta2). The refracted line keeps its length and is moved to start at the incident line's end.
 */
function applyRefraction(
  constraint: WorkbenchSketchConstraint,
  entities: Map<string, SketchEntity>
): { readonly entity?: SketchEntity; readonly note?: string; readonly error?: string } {
  const [incidentId, refractedId, interfaceId] = constraint.entityIds;
  const incident = entities.get(incidentId ?? "");
  const refracted = entities.get(refractedId ?? "");
  const boundary = entities.get(interfaceId ?? "");
  const ratio = constraint.ratio;
  if (incident?.kind !== "line" || refracted?.kind !== "line" || boundary?.kind !== "line" || ratio === undefined || !(ratio > 0)) return {};
  const unitOf = (line: Line): Vec2 | undefined => {
    const length = Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]);
    return length < EPS ? undefined : [(line.end[0] - line.start[0]) / length, (line.end[1] - line.start[1]) / length];
  };
  const tangent = unitOf(boundary);
  const incoming = unitOf(incident);
  if (tangent === undefined || incoming === undefined) return {};
  const normal: Vec2 = [-tangent[1], tangent[0]];
  const across = incoming[0] * normal[0] + incoming[1] * normal[1];
  if (Math.abs(across) < 1e-9) return { error: "The incident line runs along the interface, so there is no refraction." };
  const alongOut = (incoming[0] * tangent[0] + incoming[1] * tangent[1]) / ratio;
  if (Math.abs(alongOut) > 1) return { error: "Total internal reflection: at this index ratio the ray cannot cross the interface." };
  const crossOut = Math.sign(across) * Math.sqrt(1 - alongOut * alongOut);
  const outgoing: Vec2 = [tangent[0] * alongOut + normal[0] * crossOut, tangent[1] * alongOut + normal[1] * crossOut];
  const length = Math.hypot(refracted.end[0] - refracted.start[0], refracted.end[1] - refracted.start[1]);
  const start: Vec2 = incident.end;
  const end: Vec2 = [start[0] + outgoing[0] * length, start[1] + outgoing[1] * length];
  if (Math.hypot(start[0] - refracted.start[0], start[1] - refracted.start[1]) <= JOIN_TOLERANCE_MM && Math.hypot(end[0] - refracted.end[0], end[1] - refracted.end[1]) <= JOIN_TOLERANCE_MM) return {};
  return { entity: { ...refracted, start, end }, note: `Bent line ${label(refracted.id)} at the interface (index ratio ${format(ratio)})` };
}

/** The refracted direction's angle from the interface normal, for tests and read-outs: returns [incidence, refraction] in degrees. */
export function refractionAngles(incident: Line, refracted: Line, boundary: Line): readonly [number, number] {
  const unit = (line: Line): Vec2 => {
    const length = Math.hypot(line.end[0] - line.start[0], line.end[1] - line.start[1]);
    return [(line.end[0] - line.start[0]) / length, (line.end[1] - line.start[1]) / length];
  };
  const t = unit(boundary);
  const n: Vec2 = [-t[1], t[0]];
  const angleFromNormal = (d: Vec2): number => Math.abs(Math.atan2(d[0] * t[0] + d[1] * t[1], Math.abs(d[0] * n[0] + d[1] * n[1]))) * 180 / Math.PI;
  return [angleFromNormal(unit(incident)), angleFromNormal(unit(refracted))];
}
