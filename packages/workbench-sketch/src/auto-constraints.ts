import { SOLVABLE_POINT_REFS, type SketchEntity, type SketchPointRef, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import type { InferenceCandidate, InferenceGuide, InferenceSelector } from "./inference.js";
import type { SketchTool } from "./index.js";

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
}

const SAME = 1e-7;
const near = (a: Vec2, b: Vec2): boolean => Math.abs(a[0] - b[0]) <= SAME && Math.abs(a[1] - b[1]) <= SAME;

/** The defining point an inference selector names on an existing entity, if the live solver can move it. */
function pointRefOf(entity: SketchEntity, selector: InferenceSelector | undefined): SketchPointRef | undefined {
  let ref: SketchPointRef | undefined;
  if (entity.kind === "line") ref = selector === "start" ? "start" : selector === "end" ? "end" : selector === "mid" ? "mid" : undefined;
  else if (entity.kind === "circle" || entity.kind === "arc") ref = selector === "center" ? "center" : undefined;
  else if (entity.kind === "point") ref = "self";
  return ref !== undefined && SOLVABLE_POINT_REFS[entity.kind].includes(ref) ? ref : undefined;
}

/**
 * The relations a freshly drawn shape should carry, read off what each of its points was snapped to, the way Fusion does:
 * an end that lands on another shape's endpoint or centre is Coincident with it, one that lands on a line's middle is a
 * Midpoint, a line that follows a level or plumb guide from its start is Horizontal or Vertical, and a line that ends on a
 * perpendicular or tangent hint is Perpendicular or Tangent to that curve. Points the solver cannot move (arc ends,
 * rectangle corners) and hints that are not relations (on-curve, intersection, grid) produce nothing.
 */
export function autoConstraintsFor(input: AutoConstraintInput): readonly WorkbenchSketchConstraint[] {
  const { entity, placed, sketch } = input;
  const found: WorkbenchSketchConstraint[] = [];
  const existing = (id: string | undefined): SketchEntity | undefined => id === undefined ? undefined : sketch.entities.find((candidate) => candidate.id === id);

  /** Which defining point of the new shape each placed point became. */
  const ownRefs: readonly (SketchPointRef | undefined)[] = entity.kind === "line" ? ["start", "end"] : entity.kind === "circle" && input.tool === "circle" ? ["center"] : entity.kind === "point" ? ["self"] : [];

  ownRefs.forEach((ownRef, index) => {
    const inference = placed[index];
    const primary = inference?.primary;
    if (ownRef === undefined || primary === undefined || primary.entityId === undefined) return;
    const other = existing(primary.entityId);
    if (other === undefined || other.id === entity.id) return;
    if (primary.kind === "endpoint" || primary.kind === "center") {
      const otherRef = pointRefOf(other, primary.selector);
      if (otherRef === undefined) return;
      // The existing point stays; the new point is the one that would move.
      found.push({ id: input.newId(), kind: "coincident", entityIds: [other.id, entity.id], points: [otherRef, ownRef] });
    } else if (primary.kind === "midpoint" && other.kind === "line") {
      found.push({ id: input.newId(), kind: "midpoint", entityIds: [entity.id, other.id], points: [ownRef] });
    }
  });

  if (entity.kind === "line" && placed.length >= 2) {
    const last = placed[1]!;
    const start = placed[0]!.point;
    const primary = last.primary;
    const fromStart = (guide: InferenceGuide): boolean => near(guide.from, start);
    if (last.guides?.some((guide) => guide.kind === "horizontal" && fromStart(guide)) === true) found.push({ id: input.newId(), kind: "horizontal", entityIds: [entity.id] });
    if (last.guides?.some((guide) => guide.kind === "vertical" && fromStart(guide)) === true) found.push({ id: input.newId(), kind: "vertical", entityIds: [entity.id] });
    const target = existing(primary?.entityId);
    if (primary?.kind === "perpendicular" && target?.kind === "line") found.push({ id: input.newId(), kind: "perpendicular", entityIds: [entity.id, target.id] });
    if (primary?.kind === "tangent" && target !== undefined && (target.kind === "circle" || target.kind === "arc")) found.push({ id: input.newId(), kind: "tangent", entityIds: [entity.id, target.id] });
  }
  return found;
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
 * another end: Coincident on an endpoint or centre, Midpoint on a line's middle. A joint that already exists is not repeated.
 */
export function dropConstraintFor(input: DropConstraintInput): WorkbenchSketchConstraint | undefined {
  const { entity, ref, primary, sketch } = input;
  if (primary === undefined || primary.entityId === undefined || primary.entityId === entity.id) return undefined;
  if (!SOLVABLE_POINT_REFS[entity.kind].includes(ref)) return undefined;
  const other = sketch.entities.find((candidate) => candidate.id === primary.entityId);
  if (other === undefined) return undefined;
  if (primary.kind === "endpoint" || primary.kind === "center") {
    const otherRef = pointRefOf(other, primary.selector);
    if (otherRef === undefined) return undefined;
    const alreadyJoined = sketch.constraints.some((constraint) => constraint.kind === "coincident" && constraint.suppressed !== true
      && constraint.entityIds.length === 2 && constraint.points !== undefined
      && ((constraint.entityIds[0] === other.id && constraint.points[0] === otherRef && constraint.entityIds[1] === entity.id && constraint.points[1] === ref)
        || (constraint.entityIds[1] === other.id && constraint.points[1] === otherRef && constraint.entityIds[0] === entity.id && constraint.points[0] === ref)));
    return alreadyJoined ? undefined : { id: input.newId(), kind: "coincident", entityIds: [other.id, entity.id], points: [otherRef, ref] };
  }
  if (primary.kind === "midpoint" && other.kind === "line" && entity.kind !== "line") {
    return { id: input.newId(), kind: "midpoint", entityIds: [entity.id, other.id], points: [ref] };
  }
  return undefined;
}
