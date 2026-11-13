import { SKETCH_AXIS_X_ID, SKETCH_AXIS_Y_ID, SKETCH_ORIGIN_ID, SOLVABLE_POINT_REFS, type SketchEntity, type SketchPointRef, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import type { InferenceCandidate, InferenceGuide, InferenceSelector } from "./inference.js";
import { entityPoints, type SketchTool } from "./index.js";

/** What the pointer was snapped to when one point of a shape was placed. */
export interface PlacedPointInference {
  readonly point: Vec2;
  readonly primary?: InferenceCandidate;
  readonly guides?: readonly InferenceGuide[];
  /** The point placed just before this one, which horizontal and vertical guides are measured from. */
  readonly anchor?: Vec2;
}

export interface AutoConstraintInput {
  readonly tool: SketchTool;
  /** The shape that was just built from `placed`. */
  readonly entity: SketchEntity;
  /** One entry per placed point, in the order the tool used them. */
  readonly placed: readonly PlacedPointInference[];
  /** The sketch before the new shape was added. */
  readonly sketch: WorkbenchSketch;
  readonly newId: () => string;
  /** The new shape is an arc whose stored mid is the middle of its sweep (a half-circle slot cap): a point placed there is joined to that exact point, not just put on the arc. */
  readonly exactArcMid?: boolean;
}

const SAME = 1e-7;
/** How far a drawn point may be from a reference point and still count as being on it (millimetres). */
const AT = 1e-6;
/** A tangent arc drawn from the end of a line or arc continues it unless it leaves more than this many degrees off the curve's direction (the app inherits the exact direction, so only a hand-built arc can differ). */
const TANGENT_INTENT_DEG = 60;
/** Snaps onto an exact point of other geometry: a line that ends there and is level or plumb with its start is Horizontal or Vertical. */
const POINT_SNAPS: ReadonlySet<InferenceCandidate["kind"]> = new Set(["endpoint", "center", "origin", "midpoint", "quadrant", "intersection"]);
const near = (a: Vec2, b: Vec2): boolean => Math.abs(a[0] - b[0]) <= SAME && Math.abs(a[1] - b[1]) <= SAME;
const apart = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

function circleThrough(a: Vec2, b: Vec2, c: Vec2): { readonly center: Vec2; readonly radius: number } | undefined {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const center: Vec2 = [(a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / d, (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / d];
  return { center, radius: apart(center, a) };
}

/** Where a defining point of the entity is, if it has that point. */
export function refLocation(entity: SketchEntity, ref: SketchPointRef): Vec2 | undefined {
  switch (entity.kind) {
    case "line": return ref === "start" ? entity.start : ref === "end" ? entity.end : ref === "mid" ? [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2] : undefined;
    case "arc":
      if (ref === "start") return entity.start;
      if (ref === "end") return entity.end;
      if (ref === "mid") return entity.mid;
      return ref === "center" ? circleThrough(entity.start, entity.mid, entity.end)?.center : undefined;
    case "circle":
    case "ellipse": return ref === "center" ? entity.center : undefined;
    case "point": return ref === "self" ? entity.point : undefined;
    case "rectangle": {
      if (ref === "center") return entity.center;
      const index = ref === "corner-0" ? 0 : ref === "corner-1" ? 1 : ref === "corner-2" ? 2 : ref === "corner-3" ? 3 : undefined;
      return index === undefined ? undefined : entityPoints(entity)[index];
    }
    default: return undefined;
  }
}

/** The defining point of an entity at a position, in the order centre, ends, corners. A line's middle is not a placed point. */
export function refAt(entity: SketchEntity, point: Vec2): SketchPointRef | undefined {
  const order: readonly SketchPointRef[] = ["center", "start", "end", "self", "corner-0", "corner-1", "corner-2", "corner-3", "mid"];
  for (const ref of order) {
    if (entity.kind === "line" && ref === "mid") continue;
    if (!SOLVABLE_POINT_REFS[entity.kind].includes(ref)) continue;
    const at = refLocation(entity, ref);
    if (at !== undefined && apart(at, point) <= AT) return ref;
  }
  return undefined;
}

/** The defining point an inference landed on in an existing entity, if the live solver can move it. */
export function pointRefOf(entity: SketchEntity, candidate: Pick<InferenceCandidate, "selector" | "point">): SketchPointRef | undefined {
  const selector: InferenceSelector | undefined = candidate.selector;
  let ref: SketchPointRef | undefined;
  if (entity.kind === "line") ref = selector === "start" ? "start" : selector === "end" ? "end" : selector === "mid" ? "mid" : undefined;
  else if (entity.kind === "arc") ref = selector === "center" ? "center" : selector === "start" ? "start" : selector === "end" ? "end" : selector === "mid" ? "mid" : undefined;
  else if (entity.kind === "circle" || entity.kind === "ellipse") ref = selector === "center" ? "center" : undefined;
  else if (entity.kind === "rectangle") ref = selector === "center" ? "center" : selector === "corner" ? refAt(entity, candidate.point) : undefined;
  else if (entity.kind === "point") ref = "self";
  return ref !== undefined && SOLVABLE_POINT_REFS[entity.kind].includes(ref) ? ref : undefined;
}

/**
 * The live solver reads an arc's "mid" as the middle of its sweep, but the through-point of a 3-point arc is any point between its ends, so a
 * Coincident that names an arc's mid pulls the arc (or whatever it touches) sideways and the edit is refused as a conflict. A point that is to
 * meet an arc's through-point is therefore put ON the arc instead, which is what the designer drew and what the solver can hold.
 */
const isArcMid = (entity: SketchEntity, ref: SketchPointRef | undefined): boolean => entity.kind === "arc" && ref === "mid";

/** The curves a point can be put on (see constraintFit): a line, circle, arc or ellipse. */
const onCurveCapable = (entity: SketchEntity | undefined): entity is SketchEntity => entity !== undefined && (entity.kind === "line" || entity.kind === "circle" || entity.kind === "arc" || entity.kind === "ellipse");

/** The unit direction in which a line or arc leaves the given end, going away from the curve (the way a continuation would run). */
function leavingDirection(entity: SketchEntity, which: "start" | "end"): Vec2 | undefined {
  if (entity.kind === "line") {
    const length = apart(entity.start, entity.end);
    if (length < 1e-9) return undefined;
    const along: Vec2 = [(entity.end[0] - entity.start[0]) / length, (entity.end[1] - entity.start[1]) / length];
    return which === "end" ? along : [-along[0], -along[1]];
  }
  if (entity.kind === "arc") {
    const circle = circleThrough(entity.start, entity.mid, entity.end);
    if (circle === undefined) return undefined;
    const counterClockwise = (entity.mid[0] - entity.start[0]) * (entity.end[1] - entity.start[1]) - (entity.mid[1] - entity.start[1]) * (entity.end[0] - entity.start[0]) > 0;
    const point = which === "end" ? entity.end : entity.start;
    const radial: Vec2 = [(point[0] - circle.center[0]) / circle.radius, (point[1] - circle.center[1]) / circle.radius];
    const travel: Vec2 = counterClockwise ? [-radial[1], radial[0]] : [radial[1], -radial[0]];
    return which === "end" ? travel : [-travel[0], -travel[1]];
  }
  return undefined;
}

/**
 * The direction a tangent arc starts in when its first click lands on the end of a line or arc: the curve's own direction there, running away from
 * the curve. Undefined when the first click is not on such an end, when the arc then has to be given its direction by hand.
 */
export function inheritedTangentDirection(first: PlacedPointInference, sketch: WorkbenchSketch): { readonly direction: Vec2; readonly entityId: string; readonly ref: "start" | "end" } | undefined {
  const primary = first.primary;
  if (primary === undefined || primary.kind !== "endpoint" || primary.entityId === undefined) return undefined;
  if (primary.selector !== "start" && primary.selector !== "end") return undefined;
  const other = sketch.entities.find((candidate) => candidate.id === primary.entityId);
  if (other === undefined) return undefined;
  const direction = leavingDirection(other, primary.selector);
  return direction === undefined ? undefined : { direction, entityId: other.id, ref: primary.selector };
}

/**
 * The three points of a tangent arc with its direction point replaced by the curve's own tangent direction, when the first point is on the
 * end of a line or arc (the direction point keeps its distance from the start, so only its direction changes). The arc built from these points
 * leaves the curve without a kink, which is what lets the Coincident and Tangent relations be added without the solver having to turn it.
 */
export function tangentArcPoints(points: readonly Vec2[], placed: readonly PlacedPointInference[], sketch: WorkbenchSketch): readonly Vec2[] {
  const first = placed[0];
  if (first === undefined || points.length < 2) return points;
  const inherited = inheritedTangentDirection(first, sketch);
  if (inherited === undefined) return points;
  const anchor = points[0]!;
  const reach = Math.max(apart(anchor, points[1]!), 0.01);
  return points.map((point, index): Vec2 => index === 1 ? [anchor[0] + inherited.direction[0] * reach, anchor[1] + inherited.direction[1] * reach] : point);
}

/** Whether the existing point a click was snapped to is already held on the X or Y axis (or at the origin) by a relation of the sketch. */
function pointIsOnAxis(sketch: WorkbenchSketch, primary: InferenceCandidate | undefined, point: Vec2, axis: "x" | "y"): boolean {
  if (primary?.kind === "origin" && primary.entityId === undefined) return true;
  if (primary?.entityId === undefined || (primary.kind !== "endpoint" && primary.kind !== "center")) return false;
  const other = sketch.entities.find((candidate) => candidate.id === primary.entityId);
  const ref = other === undefined ? undefined : pointRefOf(other, primary);
  if (other === undefined || ref === undefined) return false;
  const axisId = axis === "x" ? SKETCH_AXIS_X_ID : SKETCH_AXIS_Y_ID;
  return Math.abs(point[axis === "x" ? 1 : 0]) <= AT && sketch.constraints.some((constraint) => constraint.kind === "coincident" && constraint.suppressed !== true && constraint.points !== undefined
    && constraint.entityIds.length === 2
    && constraint.entityIds.some((id, index) => id === other.id && constraint.points?.[index] === ref)
    && constraint.entityIds.some((id, index) => constraint.points?.[index] !== undefined && (id === SKETCH_ORIGIN_ID || id === axisId)));
}

/**
 * The relations a freshly drawn shape should carry, read off what each of its points was snapped to, the way Fusion does:
 * an end that lands on another shape's endpoint, arc end, rectangle corner or centre is Coincident with it; one that lands on the origin is
 * Coincident with the sketch origin and one aligned with the origin's horizontal or vertical is on that axis; one that lands on a line's
 * middle is a Midpoint; one that lands on a curve, or at a crossing, is on that curve (or both); a line that follows a level or plumb
 * guide from its start is Horizontal or Vertical; and a line that ends on a perpendicular, tangent, parallel, equal-length or collinear hint
 * is Perpendicular, Tangent, Parallel, Equal or Collinear to that curve. A tangent arc that starts on the end of a line or arc is tangent to it.
 * Hints that are not relations (grid, quadrant) produce nothing.
 */
export function autoConstraintsFor(input: AutoConstraintInput): readonly WorkbenchSketchConstraint[] {
  const { entity, placed, sketch } = input;
  const found: WorkbenchSketchConstraint[] = [];
  const existing = (id: string | undefined): SketchEntity | undefined => id === undefined ? undefined : sketch.entities.find((candidate) => candidate.id === id);
  const add = (constraint: Omit<WorkbenchSketchConstraint, "id">): void => { found.push({ id: input.newId(), ...constraint }); };
  // Which defining point of the new shape each placed point became: the one that sits at the placed position.
  const ownRefs: readonly (SketchPointRef | undefined)[] = placed.map((inference) => refAt(entity, inference.point));

  ownRefs.forEach((ownRef, index) => {
    const inference = placed[index];
    const primary = inference?.primary;
    if (ownRef === undefined || inference === undefined) return;
    const throughPoint = input.exactArcMid !== true && isArcMid(entity, ownRef);
    if (primary?.kind === "origin" && primary.entityId === undefined) {
      add(throughPoint ? { kind: "coincident", entityIds: [SKETCH_ORIGIN_ID, entity.id], points: ["self", "curve"] } : { kind: "coincident", entityIds: [SKETCH_ORIGIN_ID, entity.id], points: ["self", ownRef] });
      return;
    }
    if (primary !== undefined && primary.entityId !== undefined) {
      const other = existing(primary.entityId);
      if (other === undefined || other.id === entity.id) return;
      if (primary.kind === "endpoint" || primary.kind === "center") {
        const otherRef = pointRefOf(other, primary);
        if (otherRef === undefined) return;
        // (An existing arc's "mid" snap is the middle of its sweep, which is exactly what the solver reads, so it is joined as usual.)
        add({ kind: "coincident", entityIds: [other.id, entity.id], points: [otherRef, throughPoint ? "curve" : ownRef] });
        return;
      }
      if (primary.kind === "midpoint") {
        if (other.kind === "line") add(throughPoint ? { kind: "coincident", entityIds: [other.id, entity.id], points: ["mid", "curve"] } : { kind: "midpoint", entityIds: [entity.id, other.id], points: [ownRef] });
        else if (other.kind === "arc") add(throughPoint ? { kind: "coincident", entityIds: [other.id, entity.id], points: ["mid", "curve"] } : { kind: "coincident", entityIds: [other.id, entity.id], points: ["mid", ownRef] });
        return;
      }
      // A through-point of a 3-point arc that lands on a curve or a crossing cannot be held (it is free along the arc): nothing is recorded.
      if (throughPoint && (primary.kind === "on-curve" || primary.kind === "intersection")) return;
      if (primary.kind === "on-curve" && onCurveCapable(other)) {
        add({ kind: "coincident", entityIds: [entity.id, other.id], points: [ownRef, "curve"] });
        return;
      }
      if (primary.kind === "intersection") {
        const second = existing(primary.otherEntityId);
        for (const curve of [other, second]) if (onCurveCapable(curve) && curve.id !== entity.id) add({ kind: "coincident", entityIds: [entity.id, curve.id], points: [ownRef, "curve"] });
        return;
      }
    }
    // A point level or plumb with the origin (and not merely with the point placed before it) lies on the X or Y axis.
    if (throughPoint) return;
    const guides = inference.guides ?? [];
    const fromAnchor = (guide: InferenceGuide): boolean => inference.anchor !== undefined && near(guide.from, inference.anchor);
    if (guides.some((guide) => guide.kind === "horizontal" && near(guide.from, [0, 0]) && !fromAnchor(guide))) add({ kind: "coincident", entityIds: [entity.id, SKETCH_AXIS_X_ID], points: [ownRef, "curve"] });
    if (guides.some((guide) => guide.kind === "vertical" && near(guide.from, [0, 0]) && !fromAnchor(guide))) add({ kind: "coincident", entityIds: [entity.id, SKETCH_AXIS_Y_ID], points: [ownRef, "curve"] });
  });

  if (entity.kind === "line" && placed.length >= 2) {
    const last = placed[1]!;
    const start = placed[0]!.point;
    const primary = last.primary;
    const target = existing(primary?.entityId);
    const collinear = primary?.kind === "collinear" && target?.kind === "line";
    const fromStart = (guide: InferenceGuide): boolean => near(guide.from, start);
    if (!collinear) {
      if (last.guides?.some((guide) => guide.kind === "horizontal" && fromStart(guide)) === true) add({ kind: "horizontal", entityIds: [entity.id] });
      if (last.guides?.some((guide) => guide.kind === "vertical" && fromStart(guide)) === true) add({ kind: "vertical", entityIds: [entity.id] });
    }
    // A segment that lands on an existing point (the chain closing on its first point, a bridge between two ends) follows no
    // guide, because a snapped point has none, yet it can be exactly level or plumb. That is a relation too; without it the
    // last side of a drawn rectangle was free and the whole shape could skew.
    if (!collinear && primary !== undefined && POINT_SNAPS.has(primary.kind) && !found.some((constraint) => constraint.kind === "horizontal" || constraint.kind === "vertical")) {
      const end = entity.end;
      const dx = Math.abs(end[0] - entity.start[0]);
      const dy = Math.abs(end[1] - entity.start[1]);
      // Both ends already on the same axis make the line level or plumb already; saying so again would be a redundant relation.
      const bothOn = (axis: "x" | "y"): boolean => placed.slice(0, 2).every((inference) => pointIsOnAxis(sketch, inference.primary, inference.point, axis));
      if (dy <= SAME && dx > SAME && !bothOn("x")) add({ kind: "horizontal", entityIds: [entity.id] });
      else if (dx <= SAME && dy > SAME && !bothOn("y")) add({ kind: "vertical", entityIds: [entity.id] });
    }
    if (primary?.kind === "perpendicular" && target?.kind === "line") add({ kind: "perpendicular", entityIds: [entity.id, target.id] });
    if (primary?.kind === "tangent" && target !== undefined && (target.kind === "circle" || target.kind === "arc")) add({ kind: "tangent", entityIds: [entity.id, target.id] });
    if (primary?.kind === "parallel" && target?.kind === "line") add({ kind: "parallel", entityIds: [target.id, entity.id] });
    if (primary?.kind === "equal" && target?.kind === "line") add({ kind: "equal", entityIds: [target.id, entity.id] });
    if (collinear && target !== undefined) add({ kind: "collinear", entityIds: [target.id, entity.id] });
  }

  // A tangent arc drawn from the end of a line or arc continues it without a kink.
  if (input.tool === "arc-tangent" && entity.kind === "arc" && placed.length >= 1) {
    const inherited = inheritedTangentDirection(placed[0]!, sketch);
    // The new arc runs into itself from its start, which is the opposite of the way it leaves its start going away from the arc.
    const leaving = leavingDirection(entity, "start");
    if (inherited !== undefined && leaving !== undefined) {
      const aligned = -(inherited.direction[0] * leaving[0] + inherited.direction[1] * leaving[1]) >= Math.cos((TANGENT_INTENT_DEG * Math.PI) / 180);
      if (aligned) add({ kind: "tangent", entityIds: [inherited.entityId, entity.id] });
    }
  }
  return found;
}

/**
 * The relations a shape is born with, whatever it snapped to. A rectangle drawn corner to corner or from its centre is level: it gets
 * Horizontal (on a rectangle this holds its sides level and plumb), as a rectangle of four lines has Horizontal and Vertical on its
 * sides. Without it the rectangle's turn was a free degree of freedom unless a corner sat on a point, so a rectangle sized by a width and
 * a height and placed by two distances still read as under-constrained. A 3-point rectangle is drawn at its own angle and gets nothing.
 */
export function bornConstraintsFor(input: { readonly tool: SketchTool; readonly entity: SketchEntity; readonly newId: () => string }): readonly WorkbenchSketchConstraint[] {
  const { tool, entity } = input;
  if (entity.kind !== "rectangle" || (tool !== "rectangle" && tool !== "rectangle-center")) return [];
  if (Math.abs(entity.rotationDeg) > 1e-9) return [];
  return [{ id: input.newId(), kind: "horizontal", entityIds: [entity.id] }];
}

export interface DropConstraintInput {
  /** The curve whose point was dragged. */
  readonly entity: SketchEntity;
  /** Which defining point of that curve was dragged. */
  readonly ref: SketchPointRef;
  /** What the pointer was snapped to where it was released. */
  readonly primary: InferenceCandidate | undefined;
  readonly sketch: WorkbenchSketch;
  readonly newId: () => string;
}

/**
 * The relation a dragged point earns when it is dropped on other geometry, the way Fusion joins an end you drag onto
 * another end: Coincident on an endpoint, arc end, corner or centre (or the origin), Midpoint on a line's middle. A joint that already exists is not repeated.
 */
export function dropConstraintFor(input: DropConstraintInput): WorkbenchSketchConstraint | undefined {
  const { entity, ref, primary, sketch } = input;
  if (primary === undefined || primary.entityId === entity.id) return undefined;
  if (!SOLVABLE_POINT_REFS[entity.kind].includes(ref)) return undefined;
  const joined = (firstId: string, firstRef: SketchPointRef, secondId: string, secondRef: SketchPointRef): boolean => sketch.constraints.some((constraint) => constraint.kind === "coincident" && constraint.suppressed !== true
    && constraint.entityIds.length === 2 && constraint.points !== undefined
    && ((constraint.entityIds[0] === firstId && constraint.points[0] === firstRef && constraint.entityIds[1] === secondId && constraint.points[1] === secondRef)
      || (constraint.entityIds[1] === firstId && constraint.points[1] === firstRef && constraint.entityIds[0] === secondId && constraint.points[0] === secondRef)));
  const droppedMid = isArcMid(entity, ref);
  if (primary.kind === "origin" && primary.entityId === undefined) {
    const toRef: SketchPointRef = droppedMid ? "curve" : ref;
    return joined(SKETCH_ORIGIN_ID, "self", entity.id, toRef) ? undefined : { id: input.newId(), kind: "coincident", entityIds: [SKETCH_ORIGIN_ID, entity.id], points: ["self", toRef] };
  }
  if (primary.entityId === undefined) return undefined;
  const other = sketch.entities.find((candidate) => candidate.id === primary.entityId);
  if (other === undefined) return undefined;
  if (primary.kind === "endpoint" || primary.kind === "center") {
    const otherRef = pointRefOf(other, primary);
    if (otherRef === undefined) return undefined;
    if (droppedMid) return joined(other.id, otherRef, entity.id, "curve") ? undefined : { id: input.newId(), kind: "coincident", entityIds: [other.id, entity.id], points: [otherRef, "curve"] };
    return joined(other.id, otherRef, entity.id, ref) ? undefined : { id: input.newId(), kind: "coincident", entityIds: [other.id, entity.id], points: [otherRef, ref] };
  }
  if (primary.kind === "midpoint" && other.kind === "line" && entity.kind !== "line") {
    return droppedMid ? { id: input.newId(), kind: "coincident", entityIds: [other.id, entity.id], points: ["mid", "curve"] } : { id: input.newId(), kind: "midpoint", entityIds: [entity.id, other.id], points: [ref] };
  }
  return undefined;
}
