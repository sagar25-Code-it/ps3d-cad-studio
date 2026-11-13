import type { GeometryReference, SolveAnchor } from "../../parametric-sketch-core/src/types.js";
import { solverSelector } from "./sketch-translate.js";
import type { SketchEntity, SketchPointRef, WorkbenchSketchConstraint } from "./types.js";
import { isSketchDatumEntityId } from "./types.js";

/**
 * Which geometry should stay put when a relation can be satisfied several ways. The solver always moves as little as it can; these
 * hints say whose motion is cheap: the curve you picked first is the reference and the later ones adjust, a line turns about its
 * start, a circle is resized before it is moved, the edited dimension's own curve keeps its place while its neighbours follow.
 */
export interface LiveAnchor {
  readonly entityId: string;
  readonly ref: SketchPointRef | "self" | "radius" | "major-axis" | "minor-axis";
  /** 2 holds almost rigidly, 1 moves only if it must, 0 sets the geometry free again. */
  readonly priority: 0 | 1 | 2;
}

export function toSolverAnchors(anchors: readonly LiveAnchor[] | undefined): readonly SolveAnchor[] {
  if (anchors === undefined) return [];
  const result: SolveAnchor[] = [];
  for (const anchor of anchors) {
    if (isSketchDatumEntityId(anchor.entityId)) continue;
    const reference: GeometryReference = anchor.ref === "radius" || anchor.ref === "major-axis" || anchor.ref === "minor-axis"
      ? { entityId: anchor.entityId, selector: anchor.ref }
      : { entityId: anchor.entityId, selector: solverSelector(anchor.ref) };
    result.push({ reference, priority: anchor.priority });
  }
  return result;
}

const hold = (entityId: string, priority: 0 | 1 | 2 = 2): LiveAnchor => ({ entityId, ref: "self", priority });
const free = (entityId: string, ref: LiveAnchor["ref"]): LiveAnchor => ({ entityId, ref, priority: 0 });
const keep = (entityId: string, ref: LiveAnchor["ref"], priority: 0 | 1 | 2 = 2): LiveAnchor => ({ entityId, ref, priority });

/**
 * The curve that gives way to a joint at one of its points, with the least change to its shape. A rectangle corner or an arc end is
 * derived from the curve's centre, size and turn, so freeing the point would free all of those and the solver would stretch or turn
 * the curve a little to save moving it; only the centre is freed instead, which carries the point by sliding the whole curve.
 */
function carry(entities: ReadonlyMap<string, SketchEntity>, entityId: string, ref: LiveAnchor["ref"]): readonly LiveAnchor[] {
  const kind = entities.get(entityId)?.kind;
  const derived = (kind === "rectangle" && String(ref).startsWith("corner-")) || (kind === "arc" && (ref === "start" || ref === "end" || ref === "mid"));
  return holdExcept(entityId, derived ? "center" : ref);
}

/** Everything of the entity is held except the named part, which is free to move. */
const holdExcept = (entityId: string, ref: LiveAnchor["ref"], priority: 0 | 1 | 2 = 2): readonly LiveAnchor[] => [hold(entityId, priority), free(entityId, ref)];

const DIMENSION_KINDS: readonly WorkbenchSketchConstraint["kind"][] = ["radius", "distance", "angle", "arc-length", "perimeter"];

/** The hints for enforcing one constraint, in the order the user picked its curves. */
export function anchorsForConstraint(constraint: WorkbenchSketchConstraint, entities: ReadonlyMap<string, SketchEntity>, siblings: readonly WorkbenchSketchConstraint[] = []): readonly LiveAnchor[] {
  const ids = constraint.entityIds;
  const [first, second] = ids;
  const points = constraint.points ?? [];
  const kindOf = (id: string | undefined): SketchEntity["kind"] | undefined => (id === undefined ? undefined : entities.get(id)?.kind);
  if (DIMENSION_KINDS.includes(constraint.kind)) return anchorsForDimension(constraint, entities, siblings);
  switch (constraint.kind) {
    case "horizontal":
    case "vertical":
      // Two points: the first pick stays and the second curve is carried level with it (or in line with it).
      if (ids.length === 2) return [hold(first!), ...carry(entities, second!, points[1] ?? "self")];
      return kindOf(first) === "rectangle" ? [keep(first!, "center", 1)] : [keep(first!, "start")];
    case "parallel":
    case "perpendicular":
      return [hold(first!), ...(kindOf(second) === "line" ? [keep(second!, "start")] : [])];
    case "collinear":
      return [hold(first!)];
    case "refraction":
      // The incident line and the interface are the references; the refracted line is bent and carried to the incident line's end.
      return [hold(first!), hold(ids[2]!)];
    case "coincident": {
      if (points[0] === "curve") return [...carry(entities, second!, points[1] ?? "self"), hold(first!)];
      if (points[1] === "curve") return [...carry(entities, first!, points[0] ?? "self"), hold(second!)];
      // A curve joined at both ends to others (part of a chain or loop) moves with its chain instead of being anchored by its far end.
      if (isChained(second!, siblings)) return [hold(first!)];
      return [hold(first!), ...carry(entities, second!, points[1] ?? "self")];
    }
    case "midpoint":
      return [hold(second!), ...carry(entities, first!, points[0] ?? "self")];
    case "tangent": {
      if (kindOf(first) === "line" || isSketchDatumEntityId(first!)) return [hold(first!), keep(second!, "center", 1)];
      if (kindOf(second) === "line" || isSketchDatumEntityId(second!)) return [hold(second!), keep(first!, "center", 1)];
      return [hold(first!), keep(second!, "center", 1)];
    }
    case "concentric":
      return [hold(first!), ...holdExcept(second!, "center")];
    case "equal": {
      if (kindOf(second) === "line") return [hold(first!), keep(second!, "start")];
      return [hold(first!), keep(second!, "center")];
    }
    case "symmetry":
      return [hold(ids[2]!), hold(first!)];
    default:
      return [];
  }
}

/**
 * The curves whose size must survive while they turn or travel to satisfy a relation: the line a Parallel, Perpendicular or Collinear
 * turns keeps its length, and so does the second line of an angle dimension.
 */
export function preserveForConstraint(constraint: WorkbenchSketchConstraint, entities: ReadonlyMap<string, SketchEntity>): readonly string[] {
  const [first, second] = constraint.entityIds;
  // The refracted line keeps its length while it is bent and carried.
  if (constraint.kind === "refraction" && second !== undefined && entities.get(second)?.kind === "line") return [second];
  // A line turned horizontal or vertical keeps its length: a relation that only asks for a direction does not shorten the line.
  if ((constraint.kind === "horizontal" || constraint.kind === "vertical") && constraint.entityIds.length === 1 && first !== undefined && entities.get(first)?.kind === "line") return [first];
  // The line turned to an angle with a sketch axis keeps its length.
  if (constraint.kind === "angle" && constraint.driven !== true && first !== undefined && second !== undefined && isSketchDatumEntityId(second) && entities.get(first)?.kind === "line") return [first];
  if (second === undefined || entities.get(second)?.kind !== "line") return [];
  return constraint.kind === "parallel" || constraint.kind === "perpendicular" || constraint.kind === "collinear" || (constraint.kind === "angle" && constraint.driven !== true) ? [second] : [];
}

/** Whether the entity has Coincident joints at both its start and its end. */
function isChained(id: string, constraints: readonly WorkbenchSketchConstraint[]): boolean {
  const refs = new Set<string>();
  for (const candidate of constraints) {
    if (candidate.kind !== "coincident" || candidate.suppressed === true || candidate.points === undefined) continue;
    candidate.entityIds.forEach((entityId, index) => {
      const ref = candidate.points?.[index];
      if (entityId === id && (ref === "start" || ref === "end")) refs.add(ref);
    });
  }
  return refs.has("start") && refs.has("end");
}

/** Arcs and circles that have a Coincident joint with an end of the line. */
export function joinedRounds(lineId: string, entities: ReadonlyMap<string, SketchEntity>, constraints: readonly WorkbenchSketchConstraint[]): readonly string[] {
  const rounds = new Set<string>();
  for (const candidate of constraints) {
    if (candidate.kind !== "coincident" || candidate.suppressed === true || !candidate.entityIds.includes(lineId)) continue;
    for (const id of candidate.entityIds) {
      const kind = entities.get(id)?.kind;
      if (id !== lineId && (kind === "arc" || kind === "circle")) rounds.add(id);
    }
  }
  return [...rounds];
}

/** Circles and arcs held tangent to the given circle or arc. */
function tangentCircles(circleId: string, entities: ReadonlyMap<string, SketchEntity>, constraints: readonly WorkbenchSketchConstraint[]): readonly string[] {
  return constraints
    .filter((candidate) => candidate.kind === "tangent" && candidate.suppressed !== true && candidate.entityIds.includes(circleId))
    .flatMap((candidate) => candidate.entityIds.filter((id) => id !== circleId && (entities.get(id)?.kind === "circle" || entities.get(id)?.kind === "arc")));
}

/** Lines held tangent to a circle or arc: when the circle is resized they stay put and the circle's centre gives way. */
function tangentLines(circleId: string, entities: ReadonlyMap<string, SketchEntity>, constraints: readonly WorkbenchSketchConstraint[]): readonly string[] {
  const lines = constraints
    .filter((candidate) => candidate.kind === "tangent" && candidate.suppressed !== true && candidate.entityIds.includes(circleId))
    .flatMap((candidate) => candidate.entityIds.filter((id) => id !== circleId && entities.get(id)?.kind === "line"));
  // With two tangent lines (a circle between rails) neither is the reference: they open or close around the circle.
  return lines.length === 1 ? lines : [];
}

/** The hints for (re)enforcing a dimension: the dimensioned curve keeps its place where it can, so the curves joined to it follow. */
export function anchorsForDimension(constraint: WorkbenchSketchConstraint, entities: ReadonlyMap<string, SketchEntity>, siblings: readonly WorkbenchSketchConstraint[] = []): readonly LiveAnchor[] {
  const ids = constraint.entityIds;
  const [first, second] = ids;
  const points = constraint.points ?? [];
  const kindOf = (id: string | undefined): SketchEntity["kind"] | undefined => (id === undefined ? undefined : entities.get(id)?.kind);
  const entity = entities.get(first ?? "");
  switch (constraint.kind) {
    case "radius":
      if (entity?.kind === "ellipse") {
        return constraint.dimension === "minor-radius"
          ? [keep(first!, "center"), keep(first!, "major-axis")]
          : [keep(first!, "center"), keep(first!, "minor-axis")];
      }
      // A line tangent to the circle stays put and so does the size of a circle tangent to it: the circle's centre (and the partner's centre) give way.
      return [keep(first!, "center", 1), ...tangentLines(first!, entities, siblings).map((line) => hold(line)), ...tangentCircles(first!, entities, siblings).map((other) => keep(other, "radius", 1))];
    case "distance": {
      switch (constraint.dimension) {
        case "aligned":
        case "horizontal":
        case "vertical":
          return [hold(first!), ...carry(entities, second!, points[1] ?? "self")];
        case "point-line":
          return [hold(second!), ...carry(entities, first!, points[0] ?? "self")];
        case "line-line":
          return [hold(first!)];
        case "width":
        case "height":
          // Nothing holds the centre: a rectangle whose corner is pinned (a Fix, a joint) lets the centre move rather than turn or stretch.
          return [];
        default:
          // A line's length: it grows from its start, and the arcs and circles joined to its ends keep their radius (a slot's cap or a
          // plate's fillet slides with the line instead of being quietly resized).
          return entity?.kind === "line" ? [keep(first!, "start"), ...joinedRounds(first!, entities, siblings).map((round) => keep(round, "radius", 1))] : [hold(first!)];
      }
    }
    case "angle": {
      if (ids.length === 1) return [keep(first!, "center")];
      const a = entities.get(first!);
      const b = entities.get(second!);
      // A line turned to an angle with a sketch axis keeps its start and its length and swings about the start.
      if (a?.kind === "line" && second !== undefined && isSketchDatumEntityId(second)) return [keep(first!, "start")];
      if (b?.kind === "line" && first !== undefined && isSketchDatumEntityId(first)) return [keep(second!, "start")];
      if (a?.kind !== "line" || b?.kind !== "line") return [hold(first!)];
      // The second line turns about the end it shares with the first, so the corner they form stays closed.
      const shared = (point: readonly [number, number]): boolean => [a.start, a.end].some((other) => Math.hypot(other[0] - point[0], other[1] - point[1]) <= 1e-6);
      const pivot: "start" | "end" = shared(b.end) && !shared(b.start) ? "end" : "start";
      return [hold(first!), keep(second!, pivot, 1)];
    }
    case "arc-length":
      return [keep(first!, "radius"), keep(first!, "start")];
    case "perimeter":
      return [];
    default:
      return [];
  }
}

/**
 * The construction circles that carry a line's corners (a regular polygon's guide circle): a Coincident of the line's start or end with the
 * circle's curve. Resizing such a side scales the whole shape about the circle's centre, because the circle is what holds the polygon regular.
 */
export function guideCirclesOf(lineId: string, entities: ReadonlyMap<string, SketchEntity>, constraints: readonly WorkbenchSketchConstraint[]): readonly string[] {
  const circles = new Set<string>();
  for (const candidate of constraints) {
    if (candidate.kind !== "coincident" || candidate.suppressed === true || candidate.points === undefined || !candidate.entityIds.includes(lineId)) continue;
    candidate.entityIds.forEach((id, index) => {
      const other = candidate.entityIds[1 - index];
      const circle = entities.get(id);
      if (other === lineId && circle?.kind === "circle" && circle.construction && candidate.points?.[index] === "curve") circles.add(id);
    });
  }
  return [...circles];
}

/** The hints for the solve that follows a direct resize of the dimensioned curve: it keeps its place and its neighbours follow (a regular polygon's side scales the polygon about its centre). */
export function anchorsAfterResize(target: SketchEntity, entities: ReadonlyMap<string, SketchEntity>, constraints: readonly WorkbenchSketchConstraint[]): readonly LiveAnchor[] {
  if (target.kind !== "line") return [hold(target.id)];
  const guides = guideCirclesOf(target.id, entities, constraints);
  if (guides.length > 0) return guides.map((id) => keep(id, "center", 2));
  return [hold(target.id), ...joinedRounds(target.id, entities, constraints).map((round) => keep(round, "radius", 1))];
}
