import type {
  ArcGeometry,
  GeometryReference,
  ParametricSketchDocument,
  SketchConstraint,
  SketchDimension,
  SketchGeometry
} from "../../parametric-sketch-core/src/types.js";
import { SKETCH_AXIS_X_ID, SKETCH_AXIS_Y_ID, SKETCH_ORIGIN_ID } from "../../parametric-sketch-core/src/types.js";
import { constraintFit, type SketchEntityKind } from "./constraint-fit.js";
import type { SketchEntity, SketchPointRef, Vec2, WorkbenchSketch, WorkbenchSketchConstraint } from "./types.js";
import { isSketchDatumEntityId, SKETCH_AXIS_X_ID as LIVE_AXIS_X, SKETCH_AXIS_Y_ID as LIVE_AXIS_Y, SKETCH_ORIGIN_ID as LIVE_ORIGIN } from "./types.js";

/**
 * Translates the live sketch (lines, circles, 3-point arcs, rectangles, ellipses, points and their constraints) into the solver's
 * document, and the solved geometry back. Every constraint keeps its ID (a relation that becomes several solver relations gets
 * `id#part` IDs), so a diagnostic about a solver relation can be traced to the constraint the user made. The names given to
 * entities and relations ("Line 2", "Horizontal on Line 2") are built here too.
 */

/** A constraint the solver could not enforce, kept on the sketch as design intent. */
export interface UnsolvedConstraint {
  readonly constraintId: string;
  readonly reason: string;
}

/** How a live 3-point arc maps onto the solver's counter-clockwise centre/angle arc. */
export interface ArcFrame {
  /** True when the live start-mid-end order runs clockwise, so the solver arc starts at the live end. */
  readonly reversed: boolean;
  readonly center: Vec2;
  readonly radiusMm: number;
  readonly startAngleRad: number;
  readonly endAngleRad: number;
  /** Where the live arc's middle point sits along the sweep (0 to 1), kept when the arc is resized or swept. */
  readonly midFraction: number;
}

export interface Translation {
  readonly document: ParametricSketchDocument;
  readonly arcFrames: ReadonlyMap<string, ArcFrame>;
  /** Names for solver relations and entities, by solver ID. */
  readonly labels: Readonly<Record<string, string>>;
  readonly unsolved: readonly UnsolvedConstraint[];
  /** Entities that take part in the solve. */
  readonly present: ReadonlySet<string>;
}

/** A move smaller than this (a tenth of a micrometre) is round-off from a solve, not a move. */
const MOVE_TOLERANCE_MM = 1e-7;
const DEGREES = Math.PI / 180;

/** The solver names a line's middle "midpoint" and a point entity's location "self"; everything else matches. */
export function solverSelector(ref: SketchPointRef | undefined): GeometryReference["selector"] {
  return ref === "mid" ? "midpoint" : ref ?? "self";
}

export function entityKindOf(sketch: Pick<WorkbenchSketch, "entities">, id: string): SketchEntityKind | undefined {
  if (id === LIVE_ORIGIN) return "origin";
  if (id === LIVE_AXIS_X || id === LIVE_AXIS_Y) return "axis";
  return sketch.entities.find((entity) => entity.id === id)?.kind;
}

function reference(id: string, ref: SketchPointRef | undefined): GeometryReference {
  if (id === LIVE_ORIGIN) return { entityId: SKETCH_ORIGIN_ID, selector: "point" };
  if (id === LIVE_AXIS_X) return { entityId: SKETCH_AXIS_X_ID, selector: "curve" };
  if (id === LIVE_AXIS_Y) return { entityId: SKETCH_AXIS_Y_ID, selector: "curve" };
  return { entityId: id, selector: solverSelector(ref) };
}

const whole = (id: string): GeometryReference => reference(id, "self");
const lineRef = (id: string): GeometryReference => (isSketchDatumEntityId(id) ? reference(id, "curve") : { entityId: id, selector: "curve" });

// ---------------------------------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------------------------------

function circumcircle(a: Vec2, b: Vec2, c: Vec2): { readonly center: Vec2; readonly radiusMm: number } | undefined {
  const determinant = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(determinant) < 1e-9) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const center: Vec2 = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / determinant,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / determinant
  ];
  return { center, radiusMm: Math.hypot(a[0] - center[0], a[1] - center[1]) };
}

function cross(a: Vec2, b: Vec2, c: Vec2): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

const wrap = (angle: number): number => ((angle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

function toSolverGeometry(entity: SketchEntity, arcFrames: Map<string, ArcFrame>): SketchGeometry | undefined {
  const base = { id: entity.id, construction: entity.construction, suppressed: false } as const;
  switch (entity.kind) {
    case "point": return { ...base, kind: "point", point: entity.point };
    case "line": return { ...base, kind: "line", start: entity.start, end: entity.end };
    case "circle": return { ...base, kind: "circle", center: entity.center, radiusMm: entity.radiusMm };
    case "rectangle": return { ...base, kind: "rectangle", center: entity.center, widthMm: entity.widthMm, heightMm: entity.heightMm, rotationRad: entity.rotationDeg * DEGREES };
    case "ellipse": {
      const turn = entity.rotationDeg * DEGREES;
      return { ...base, kind: "ellipse", center: entity.center, majorAxis: [entity.majorRadiusMm * Math.cos(turn), entity.majorRadiusMm * Math.sin(turn)], minorToMajorRatio: entity.minorRadiusMm / entity.majorRadiusMm };
    }
    case "arc": {
      const circle = circumcircle(entity.start, entity.mid, entity.end);
      if (circle === undefined) return undefined;
      const reversed = cross(entity.start, entity.mid, entity.end) < 0;
      const startAngle = Math.atan2(entity.start[1] - circle.center[1], entity.start[0] - circle.center[0]);
      const endAngle = Math.atan2(entity.end[1] - circle.center[1], entity.end[0] - circle.center[0]);
      const midAngle = Math.atan2(entity.mid[1] - circle.center[1], entity.mid[0] - circle.center[0]);
      const solverStart = reversed ? endAngle : startAngle;
      const solverEnd = reversed ? startAngle : endAngle;
      const sweep = wrap(solverEnd - solverStart);
      arcFrames.set(entity.id, { reversed, center: circle.center, radiusMm: circle.radiusMm, startAngleRad: solverStart, endAngleRad: solverEnd, midFraction: sweep < 1e-12 ? 0.5 : wrap(midAngle - solverStart) / sweep });
      return { ...base, kind: "arc", center: circle.center, radiusMm: circle.radiusMm, startAngleRad: solverStart, endAngleRad: solverStart + sweep };
    }
    case "spline":
      return undefined;
  }
}

const near2 = (a: Vec2, b: Vec2, tolerance = MOVE_TOLERANCE_MM): boolean => Math.abs(a[0] - b[0]) <= tolerance && Math.abs(a[1] - b[1]) <= tolerance;

/** Returns the updated live entity, or undefined when the solver left it where it was. */
export function fromSolverGeometry(entity: SketchEntity, solved: SketchGeometry, frame: ArcFrame | undefined): SketchEntity | undefined {
  if (entity.kind === "line" && solved.kind === "line") {
    return near2(entity.start, solved.start) && near2(entity.end, solved.end) ? undefined : { ...entity, start: solved.start, end: solved.end };
  }
  if (entity.kind === "circle" && solved.kind === "circle") {
    return near2(entity.center, solved.center) && Math.abs(entity.radiusMm - solved.radiusMm) <= MOVE_TOLERANCE_MM ? undefined : { ...entity, center: solved.center, radiusMm: solved.radiusMm };
  }
  if (entity.kind === "point" && solved.kind === "point") {
    return near2(entity.point, solved.point) ? undefined : { ...entity, point: solved.point };
  }
  if (entity.kind === "rectangle" && solved.kind === "rectangle") {
    const turned = solved.rotationRad / DEGREES;
    // Turns that differ by whole revolutions are the same turn: an untouched rectangle keeps the angle it was stored with.
    const apart = ((((turned - entity.rotationDeg) % 360) + 540) % 360) - 180;
    const normalised = turned > 180 || turned <= -180 ? ((((turned + 180) % 360) + 360) % 360) - 180 : turned;
    const rotationDeg = Math.abs(apart) <= 1e-8 ? entity.rotationDeg : normalised;
    return near2(entity.center, solved.center) && Math.abs(entity.widthMm - solved.widthMm) <= MOVE_TOLERANCE_MM && Math.abs(entity.heightMm - solved.heightMm) <= MOVE_TOLERANCE_MM && rotationDeg === entity.rotationDeg
      ? undefined
      : { ...entity, center: solved.center, widthMm: solved.widthMm, heightMm: solved.heightMm, rotationDeg };
  }
  if (entity.kind === "ellipse" && solved.kind === "ellipse") {
    const major = Math.hypot(solved.majorAxis[0], solved.majorAxis[1]);
    const minor = major * solved.minorToMajorRatio;
    const rotationDeg = Math.atan2(solved.majorAxis[1], solved.majorAxis[0]) / DEGREES;
    const turn = Math.abs(((rotationDeg - entity.rotationDeg + 540) % 360) - 180);
    return near2(entity.center, solved.center) && Math.abs(entity.majorRadiusMm - major) <= MOVE_TOLERANCE_MM && Math.abs(entity.minorRadiusMm - minor) <= MOVE_TOLERANCE_MM && turn <= 1e-8
      ? undefined
      : { ...entity, center: solved.center, majorRadiusMm: major, minorRadiusMm: minor, rotationDeg: Math.abs(rotationDeg - entity.rotationDeg) <= 1e-8 ? entity.rotationDeg : rotationDeg };
  }
  if (entity.kind === "arc" && solved.kind === "arc" && frame !== undefined) {
    const apart = (a: number, b: number): number => { const turn = wrap(a - b); return Math.min(turn, Math.PI * 2 - turn); };
    const sameSweep = apart(wrap(solved.endAngleRad - solved.startAngleRad), wrap(frame.endAngleRad - frame.startAngleRad)) * solved.radiusMm <= MOVE_TOLERANCE_MM
      && apart(solved.startAngleRad, frame.startAngleRad) * solved.radiusMm <= MOVE_TOLERANCE_MM;
    if (near2(frame.center, solved.center) && Math.abs(frame.radiusMm - solved.radiusMm) <= MOVE_TOLERANCE_MM && sameSweep) return undefined;
    return rebuildArc(entity, solved, frame);
  }
  return undefined;
}

function rebuildArc(entity: Extract<SketchEntity, { kind: "arc" }>, solved: ArcGeometry, frame: ArcFrame): SketchEntity {
  const sweep = wrap(solved.endAngleRad - solved.startAngleRad);
  const at = (angle: number): Vec2 => [solved.center[0] + solved.radiusMm * Math.cos(angle), solved.center[1] + solved.radiusMm * Math.sin(angle)];
  const first = at(solved.startAngleRad);
  const last = at(solved.startAngleRad + sweep);
  const mid = at(solved.startAngleRad + sweep * frame.midFraction);
  return frame.reversed ? { ...entity, start: last, mid, end: first } : { ...entity, start: first, mid, end: last };
}

// ---------------------------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------------------------

const KIND_NAMES: Readonly<Record<SketchEntity["kind"], string>> = {
  line: "Line", circle: "Circle", arc: "Arc", rectangle: "Rectangle", ellipse: "Ellipse", point: "Point", spline: "Spline"
};

/** "Line 2", "Circle 1": the position among entities of the same kind in the sketch's own order. The origin and axes get their plain names. */
export function entityNames(sketch: Pick<WorkbenchSketch, "entities">): ReadonlyMap<string, string> {
  const counters = new Map<string, number>();
  const names = new Map<string, string>([[LIVE_ORIGIN, "the origin"], [LIVE_AXIS_X, "the X axis"], [LIVE_AXIS_Y, "the Y axis"]]);
  for (const entity of sketch.entities) {
    const next = (counters.get(entity.kind) ?? 0) + 1;
    counters.set(entity.kind, next);
    names.set(entity.id, `${KIND_NAMES[entity.kind]} ${next}`);
  }
  return names;
}

const POINT_NAMES: Readonly<Record<SketchPointRef, string>> = {
  start: "start", end: "end", mid: "midpoint", center: "centre", self: "", curve: "curve",
  "corner-0": "corner 1", "corner-1": "corner 2", "corner-2": "corner 3", "corner-3": "corner 4"
};

function formatNumber(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

/** A name for a constraint a person can read: "Horizontal on Line 2", "Length 40 on Line 1", "Coincident: Line 1 end and Line 2 start". */
export function describeConstraint(constraint: WorkbenchSketchConstraint, names: ReadonlyMap<string, string>): string {
  const of = (index: number): string => names.get(constraint.entityIds[index] ?? "") ?? constraint.entityIds[index] ?? "?";
  const at = (index: number): string => {
    const ref = constraint.points?.[index];
    const point = ref === undefined ? "" : POINT_NAMES[ref];
    return point === "" ? of(index) : `${of(index)} ${point}`;
  };
  const value = constraint.kind === "angle"
    ? constraint.valueDeg === undefined ? "" : `${formatNumber(constraint.valueDeg)}° `
    : constraint.valueMm === undefined ? "" : `${formatNumber(constraint.valueMm)} `;
  const reference = constraint.driven === true ? " (reference)" : "";
  switch (constraint.kind) {
    case "horizontal": return `Horizontal on ${of(0)}`;
    case "vertical": return `Vertical on ${of(0)}`;
    case "parallel": return `Parallel between ${of(0)} and ${of(1)}`;
    case "perpendicular": return `Perpendicular between ${of(0)} and ${of(1)}`;
    case "collinear": return `Collinear between ${of(0)} and ${of(1)}`;
    case "tangent": return `Tangent between ${of(0)} and ${of(1)}`;
    case "concentric": return `Concentric between ${of(0)} and ${of(1)}`;
    case "equal": return `Equal between ${of(0)} and ${of(1)}`;
    case "midpoint": return `Midpoint of ${of(1)} at ${at(0)}`;
    case "symmetry": return `Symmetric: ${of(0)} and ${of(1)} about ${of(2)}`;
    case "coincident":
      return constraint.points?.[1] === "curve" ? `Point on curve: ${at(0)} on ${of(1)}`
        : constraint.points?.[0] === "curve" ? `Point on curve: ${at(1)} on ${of(0)}`
          : `Coincident: ${at(0)} and ${at(1)}`;
    case "fixed": return `Fix on ${constraint.entityIds.map((_, index) => at(index)).join(" and ")}`;
    case "radius":
      return `${constraint.dimension === "diameter" ? "Diameter" : constraint.dimension === "major-radius" ? "Major radius" : constraint.dimension === "minor-radius" ? "Minor radius" : "Radius"} ${value}on ${of(0)}${reference}`;
    case "distance":
      switch (constraint.dimension) {
        case "aligned": case "horizontal": case "vertical":
          return `${constraint.dimension === "aligned" ? "Distance" : `${constraint.dimension[0]!.toUpperCase()}${constraint.dimension.slice(1)} distance`} ${value}between ${at(0)} and ${at(1)}${reference}`;
        case "point-line": return `Distance ${value}from ${at(0)} to ${of(1)}${reference}`;
        case "line-line": return `Distance ${value}between ${of(0)} and ${of(1)}${reference}`;
        case "width": return `Width ${value}on ${of(0)}${reference}`;
        case "height": return `Height ${value}on ${of(0)}${reference}`;
        default: return `Length ${value}on ${of(0)}${reference}`;
      }
    case "angle": return constraint.entityIds.length === 1 ? `Rotation ${value}of ${of(0)}${reference}` : `Angle ${value}between ${of(0)} and ${of(1)}${reference}`;
    case "arc-length": return `Arc length ${value}on ${of(0)}${reference}`;
    case "perimeter": return `Perimeter ${value}of ${constraint.entityIds.map((_, index) => of(index)).join(" and ")}${reference}`;
    case "smooth": return `Smooth between ${of(0)} and ${of(1)}`;
    case "pierce": return `Pierce on ${of(0)}`;
    case "refraction": return `Refraction at ${of(2)}`;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Constraints
// ---------------------------------------------------------------------------------------------------------------------

interface Translated {
  readonly constraints: readonly SketchConstraint[];
  readonly dimensions: readonly SketchDimension[];
  readonly unsolved?: string;
}

const NOTHING: Translated = { constraints: [], dimensions: [] };

function axisGeometry(id: string): { readonly start: Vec2; readonly end: Vec2 } {
  return id === LIVE_AXIS_Y ? { start: [0, 0], end: [0, 1] } : { start: [0, 0], end: [1, 0] };
}

function reflectPoint(point: Vec2, axis: { readonly start: Vec2; readonly end: Vec2 }): Vec2 {
  const dx = axis.end[0] - axis.start[0];
  const dy = axis.end[1] - axis.start[1];
  const denominator = dx * dx + dy * dy;
  const parameter = denominator <= 1e-18 ? 0 : ((point[0] - axis.start[0]) * dx + (point[1] - axis.start[1]) * dy) / denominator;
  const foot: Vec2 = [axis.start[0] + parameter * dx, axis.start[1] + parameter * dy];
  return [2 * foot[0] - point[0], 2 * foot[1] - point[1]];
}

/** Corner `index` (0 to 3, counter-clockwise from the lower left before the turn) of a rectangle entity. */
function rectangleCorner(rectangle: Extract<SketchEntity, { kind: "rectangle" }>, index: number): Vec2 {
  const sx = index === 0 || index === 3 ? -0.5 : 0.5;
  const sy = index === 0 || index === 1 ? -0.5 : 0.5;
  const radians = (rectangle.rotationDeg * Math.PI) / 180;
  const dx = sx * rectangle.widthMm;
  const dy = sy * rectangle.heightMm;
  return [rectangle.center[0] + dx * Math.cos(radians) - dy * Math.sin(radians), rectangle.center[1] + dx * Math.sin(radians) + dy * Math.cos(radians)];
}

const distanceSquared = (a: Vec2, b: Vec2): number => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2;

function translateConstraint(constraint: WorkbenchSketchConstraint, entities: ReadonlyMap<string, SketchEntity>, present: ReadonlySet<string>): Translated {
  const stable = { id: constraint.id, suppressed: false } as const;
  const kindOf = (id: string): SketchEntityKind | undefined => (isSketchDatumEntityId(id) ? (id === LIVE_ORIGIN ? "origin" : "axis") : entities.get(id)?.kind);
  const none = (reason: string): Translated => ({ constraints: [], dimensions: [], unsolved: reason });
  const ids = constraint.entityIds;
  const [first, second] = ids;
  const kinds = ids.map(kindOf);
  if (kinds.some((kind) => kind === undefined)) return none("A referenced entity no longer exists.");
  const driven = constraint.driven === true;
  const fit = constraintFit(constraint.kind, kinds, constraint.points, { driven, ...(constraint.dimension === undefined ? {} : { dimension: constraint.dimension }) });
  if (!fit.ok) return none(fit.reason);
  // A driven (reference) dimension is only measured; smooth and pierce are solved after the analytic pass (refraction is part of it).
  if (driven || constraint.kind === "smooth" || constraint.kind === "pierce") return NOTHING;
  const solverHas = (id: string): boolean => isSketchDatumEntityId(id) || present.has(id);
  const dimension = (value: number, rest: { readonly kind: SketchDimension["kind"] } & Record<string, unknown>, unit: "mm" | "rad" = "mm"): Translated =>
    ({ constraints: [], dimensions: [{ id: constraint.id, mode: "driving", suppressed: false, value: { value }, unit, ...rest } as unknown as SketchDimension] });

  switch (constraint.kind) {
    case "fixed":
      return { constraints: ids.flatMap((id, index) => (present.has(id) ? [{ id: `${constraint.id}#${index}`, suppressed: false, kind: "fix" as const, target: reference(id, constraint.points?.[index] ?? "self") }] : [])), dimensions: [] };
    case "radius": {
      if (constraint.valueMm === undefined) return none("The dimension has no value.");
      if (!present.has(first!)) return none("The dimensioned curve is not solved by the live solver.");
      const name = constraint.dimension ?? "radius";
      if (name === "major-radius") return dimension(constraint.valueMm, { kind: "radius", target: { entityId: first!, selector: "major-axis" } });
      if (name === "minor-radius") return dimension(constraint.valueMm, { kind: "radius", target: { entityId: first!, selector: "minor-axis" } });
      return dimension(constraint.valueMm, { kind: name === "diameter" ? "diameter" : "radius", target: whole(first!) });
    }
    case "distance": {
      if (constraint.valueMm === undefined) return none("The dimension has no value.");
      const name = constraint.dimension ?? (kinds[0] === "rectangle" ? "width" : ids.length === 2 ? "aligned" : "length");
      if (!ids.every(solverHas)) return none("The dimensioned entities are not solved by the live solver.");
      if (name === "length") return dimension(constraint.valueMm, { kind: "length", target: whole(first!) });
      if (name === "width" || name === "height") return dimension(constraint.valueMm, { kind: name, target: whole(first!) });
      if (name === "aligned" || name === "horizontal" || name === "vertical") {
        return dimension(constraint.valueMm, { kind: "linear", first: reference(first!, constraint.points?.[0]), second: reference(second!, constraint.points?.[1]), orientation: name });
      }
      if (name === "point-line") return dimension(constraint.valueMm, { kind: "point-line-distance", point: reference(first!, constraint.points?.[0]), line: lineRef(second!) });
      if (name === "line-line") return dimension(constraint.valueMm, { kind: "line-line-distance", first: lineRef(first!), second: lineRef(second!) });
      return none(`${name} is not a supported distance.`);
    }
    case "angle": {
      if (constraint.valueDeg === undefined) return none("The angle dimension has no value.");
      if (!ids.every(solverHas)) return none("The dimensioned lines are not solved by the live solver.");
      if (ids.length === 1) return dimension(constraint.valueDeg * DEGREES, { kind: "angle", first: { entityId: SKETCH_AXIS_X_ID, selector: "curve" }, second: { entityId: first!, selector: "major-axis" } }, "rad");
      return dimension(constraint.valueDeg * DEGREES, { kind: "angle", first: lineRef(first!), second: lineRef(second!) }, "rad");
    }
    case "arc-length": {
      if (constraint.valueMm === undefined) return none("The dimension has no value.");
      if (!present.has(first!)) return none("The dimensioned arc is not solved by the live solver.");
      return dimension(constraint.valueMm, { kind: "arc-length", target: whole(first!) });
    }
    case "perimeter": {
      if (constraint.valueMm === undefined) return none("The dimension has no value.");
      if (!present.has(first!)) return none("The dimensioned curve is not solved by the live solver.");
      return dimension(constraint.valueMm, { kind: "perimeter", target: whole(first!) });
    }
    case "coincident": {
      if (!ids.every(solverHas)) return none("The joined entities are not solved by the live solver.");
      const points = constraint.points ?? [];
      if (points[0] === "curve" || points[1] === "curve") {
        const curveIndex = points[0] === "curve" ? 0 : 1;
        const pointIndex = 1 - curveIndex;
        return { constraints: [{ ...stable, kind: "on-curve", point: reference(ids[pointIndex]!, points[pointIndex]), curve: lineRef(ids[curveIndex]!) }], dimensions: [] };
      }
      return { constraints: [{ ...stable, kind: "coincident", first: reference(first!, points[0]), second: reference(second!, points[1]) }], dimensions: [] };
    }
    case "midpoint": {
      if (!ids.every(solverHas)) return none("The joined entities are not solved by the live solver.");
      return { constraints: [{ ...stable, kind: "midpoint", point: reference(first!, constraint.points?.[0]), line: whole(second!) }], dimensions: [] };
    }
    case "horizontal":
    case "vertical":
      if (!present.has(first!)) return none("The entity is not solved by the live solver.");
      return { constraints: [{ ...stable, kind: constraint.kind, line: whole(first!) }], dimensions: [] };
    case "parallel":
    case "perpendicular":
    case "collinear":
      if (!ids.every(solverHas)) return none("The lines are not solved by the live solver.");
      return { constraints: [{ ...stable, kind: constraint.kind, first: lineRef(first!), second: lineRef(second!) }], dimensions: [] };
    case "concentric":
    case "equal":
    case "tangent":
      if (!ids.every(solverHas)) return none("The curves are not solved by the live solver.");
      return { constraints: [{ ...stable, kind: constraint.kind, first: lineRef(first!), second: lineRef(second!) }], dimensions: [] };
    case "symmetry":
      return translateSymmetry(constraint, entities, present);
    case "refraction":
      if (ids.length !== 3 || !ids.every(solverHas) || constraint.ratio === undefined || !(constraint.ratio > 0)) return none("Refraction needs an incident line, a refracted line, an interface line and a positive index ratio.");
      return { constraints: [{ ...stable, kind: "refraction", incident: lineRef(first!), refracted: lineRef(second!), boundary: lineRef(ids[2]!), ratio: constraint.ratio }], dimensions: [] };
    default:
      return none(`${constraint.kind} needs endpoint selection, which the sketch records but does not solve yet.`);
  }
}

function translateSymmetry(constraint: WorkbenchSketchConstraint, entities: ReadonlyMap<string, SketchEntity>, present: ReadonlySet<string>): Translated {
  const none = (reason: string): Translated => ({ constraints: [], dimensions: [], unsolved: reason });
  const [first, second, axisId] = constraint.entityIds;
  if (first === undefined || second === undefined || axisId === undefined) return none("Symmetric needs two entities and an axis line (select the axis last).");
  const a = entities.get(first);
  const b = entities.get(second);
  const axisEntity = entities.get(axisId);
  if (a === undefined || b === undefined || (axisEntity?.kind !== "line" && !isSketchDatumEntityId(axisId))) return none("Symmetric needs an axis line as the last selection.");
  // A spline is not an analytic curve: the image of a spline follows its source in the closed-form pass after the solve (sketch-solve-mirror.ts).
  if (a.kind === "spline" && b.kind === "spline") return NOTHING;
  if (![first, second, axisId].every((id) => isSketchDatumEntityId(id) || present.has(id))) return none("The mirrored entities are not solved by the live solver.");
  const axis: { readonly start: Vec2; readonly end: Vec2 } = axisEntity?.kind === "line" ? axisEntity : axisGeometry(axisId);
  const axisRef = lineRef(axisId);
  const mirror = (id: string, one: GeometryReference, other: GeometryReference): SketchConstraint => ({ id, suppressed: false, kind: "symmetric", first: one, second: other, axis: axisRef });
  const point = (entityId: string, selector: GeometryReference["selector"]): GeometryReference => ({ entityId, selector });
  if (a.kind === "line" && b.kind === "line") {
    // Pair the endpoints that are nearer once mirrored, so a drawn mirror image keeps its orientation.
    const straight = distanceSquared(reflectPoint(a.start, axis), b.start) + distanceSquared(reflectPoint(a.end, axis), b.end);
    const crossed = distanceSquared(reflectPoint(a.start, axis), b.end) + distanceSquared(reflectPoint(a.end, axis), b.start);
    const startMate: "start" | "end" = straight <= crossed ? "start" : "end";
    const endMate: "start" | "end" = startMate === "start" ? "end" : "start";
    return { constraints: [mirror(`${constraint.id}#start`, point(first, "start"), point(second, startMate)), mirror(`${constraint.id}#end`, point(first, "end"), point(second, endMate))], dimensions: [] };
  }
  if (a.kind === "circle" && b.kind === "circle") {
    return {
      constraints: [
        mirror(`${constraint.id}#centre`, point(first, "center"), point(second, "center")),
        { id: `${constraint.id}#radius`, suppressed: false, kind: "equal", first: whole(first), second: whole(second) }
      ],
      dimensions: []
    };
  }
  if (a.kind === "point" && b.kind === "point") return { constraints: [mirror(constraint.id, point(first, "self"), point(second, "self"))], dimensions: [] };
  if (a.kind === "arc" && b.kind === "arc") {
    // Both ends and the middle pin the image arc exactly; the ends are paired the way they are nearer once mirrored, so a drawn image keeps its direction.
    const straight = distanceSquared(reflectPoint(a.start, axis), b.start) + distanceSquared(reflectPoint(a.end, axis), b.end);
    const crossed = distanceSquared(reflectPoint(a.start, axis), b.end) + distanceSquared(reflectPoint(a.end, axis), b.start);
    const startMate: "start" | "end" = straight <= crossed ? "start" : "end";
    const endMate: "start" | "end" = startMate === "start" ? "end" : "start";
    return {
      constraints: [
        mirror(`${constraint.id}#start`, point(first, "start"), point(second, startMate)),
        mirror(`${constraint.id}#end`, point(first, "end"), point(second, endMate)),
        mirror(`${constraint.id}#mid`, point(first, "midpoint"), point(second, "midpoint"))
      ],
      dimensions: []
    };
  }
  if (a.kind === "rectangle" && b.kind === "rectangle") {
    // Centre, size and the corner that lands on the image's nearest corner fix the image rectangle, turn included.
    const target = reflectPoint(rectangleCorner(a, 0), axis);
    const nearest = [0, 1, 2, 3].map((index) => ({ index, gap: distanceSquared(target, rectangleCorner(b, index)) })).sort((x, y) => x.gap - y.gap)[0]!.index;
    return {
      constraints: [
        mirror(`${constraint.id}#centre`, point(first, "center"), point(second, "center")),
        { id: `${constraint.id}#size`, suppressed: false, kind: "equal", first: whole(first), second: whole(second) },
        mirror(`${constraint.id}#corner`, point(first, "corner-0"), point(second, `corner-${nearest}` as GeometryReference["selector"]))
      ],
      dimensions: []
    };
  }
  if (a.kind === "ellipse" && b.kind === "ellipse") {
    // Centre and size here; the turn of the image follows its source in the closed-form pass after the solve.
    return {
      constraints: [
        mirror(`${constraint.id}#centre`, point(first, "center"), point(second, "center")),
        { id: `${constraint.id}#size`, suppressed: false, kind: "equal", first: whole(first), second: whole(second) }
      ],
      dimensions: []
    };
  }
  return none("Symmetric solves two lines, circles, arcs, rectangles, ellipses, splines or points about a line axis; mixed pairs are not supported.");
}

/** Strips the part suffix a decomposed relation carries, giving the ID of the constraint the user made. */
export function liveConstraintId(solverId: string): string {
  const cut = solverId.indexOf("#");
  return cut < 0 ? solverId : solverId.slice(0, cut);
}

/** Entities reachable from the focus through constraints; every entity when there is no focus. The origin and axes never connect anything. */
export function constraintComponent(sketch: Pick<WorkbenchSketch, "entities" | "constraints">, focusEntityIds: readonly string[] | undefined): ReadonlySet<string> {
  if (focusEntityIds === undefined) return new Set(sketch.entities.map((entity) => entity.id));
  const reached = new Set<string>(focusEntityIds.filter((id) => !isSketchDatumEntityId(id)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const constraint of sketch.constraints) {
      if (!constraint.entityIds.some((id) => reached.has(id))) continue;
      for (const id of constraint.entityIds) {
        if (!isSketchDatumEntityId(id) && !reached.has(id)) {
          reached.add(id);
          grew = true;
        }
      }
    }
  }
  return reached;
}

export interface TranslateOptions {
  /** The entities whose relations and geometry are handed to the solver (default: all). */
  readonly component?: ReadonlySet<string>;
  /** Also translate relaxed (suppressed) relations as active; used to ask "what would restoring these do". */
  readonly forceActive?: ReadonlySet<string>;
}

export function translateSketch(sketch: WorkbenchSketch, options: TranslateOptions = {}): Translation {
  const component = options.component ?? new Set(sketch.entities.map((entity) => entity.id));
  const entities = sketch.entities.filter((entity) => component.has(entity.id));
  const entityById = new Map(entities.map((entity) => [entity.id, entity] as const));
  const names = entityNames(sketch);
  const arcFrames = new Map<string, ArcFrame>();
  const geometry: SketchGeometry[] = [];
  for (const entity of entities) {
    const converted = toSolverGeometry(entity, arcFrames);
    if (converted !== undefined) geometry.push(converted);
  }
  const present = new Set(geometry.map((candidate) => candidate.id));
  const constraints: SketchConstraint[] = [];
  const dimensions: SketchDimension[] = [];
  const unsolved: UnsolvedConstraint[] = [];
  const labels: Record<string, string> = {};
  for (const [id, name] of names) labels[id] = name;
  const active = sketch.constraints.filter((constraint) => (constraint.suppressed !== true || options.forceActive?.has(constraint.id) === true) && constraint.entityIds.some((id) => component.has(id)));
  for (const constraint of active) {
    const translated = translateConstraint(constraint, entityById, present);
    const label = describeConstraint(constraint, names);
    if (translated.unsolved !== undefined) unsolved.push({ constraintId: constraint.id, reason: translated.unsolved });
    for (const item of translated.constraints) {
      constraints.push(item);
      labels[item.id] = label;
    }
    for (const item of translated.dimensions) {
      dimensions.push(item);
      labels[item.id] = label;
    }
  }
  const reversedArcs = new Set([...arcFrames].filter(([, frame]) => frame.reversed).map(([id]) => id));
  const document: ParametricSketchDocument = {
    schemaVersion: "1.0",
    id: sketch.id,
    revision: 0,
    plane: { kind: "principal", referenceId: sketch.plane, originMm: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] },
    parameters: {},
    geometry,
    constraints: reversedArcs.size === 0 ? constraints : constraints.map((item) => swapReversedArcEnds(item, reversedArcs)),
    dimensions: reversedArcs.size === 0 ? dimensions : dimensions.map((item) => swapReversedArcEnds(item, reversedArcs))
  };
  return { document, arcFrames, labels, unsolved, present };
}

/**
 * A live arc runs start, middle, end in the order it was drawn; the solver's arc always runs counter-clockwise. For an arc drawn
 * clockwise the solver's start is the live end, so a reference to one of its ends has to name the other one.
 */
export function swapReversedArcEnds<T>(value: T, reversedArcs: ReadonlySet<string>): T {
  if (Array.isArray(value)) return value.map((item) => swapReversedArcEnds(item, reversedArcs)) as unknown as T;
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  const swapped: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) swapped[key] = swapReversedArcEnds(item, reversedArcs);
  if (typeof record.entityId === "string" && reversedArcs.has(record.entityId) && (record.selector === "start" || record.selector === "end")) {
    swapped.selector = record.selector === "start" ? "end" : "start";
  }
  return swapped as T;
}
