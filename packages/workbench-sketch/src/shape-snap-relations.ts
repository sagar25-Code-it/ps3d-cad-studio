import { SKETCH_ORIGIN_ID, type SketchEntity, type SketchPointRef, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { autoConstraintsFor, pointRefOf, refAt, type PlacedPointInference } from "./auto-constraints.js";
import type { SketchTool } from "./index.js";
import type { SketchShape } from "./shapes.js";

/**
 * The relations a whole shape (polygon, slot, midpoint line, centerline, parallelogram, arc slot ...) earns from what its clicks were
 * snapped to. A single curve gets these from autoConstraintsFor; the shape tools used to ignore their snaps, so a slot started on the origin
 * or an endpoint only looked attached and could not be located parametrically. Each placed point that was snapped to an endpoint, centre,
 * the origin, a midpoint, a curve or a crossing is matched with the point of the new shape that sits at it (a slot's cap centre, a polygon's
 * corner, a line's end ...) and joined to it, by the same rules a clicked point of a single curve follows.
 */

/** Tools whose clicks are points of the shape they build (the others pick curves, or are control points of a spline, and earn nothing). */
const SNAPPING_SHAPE_TOOLS: ReadonlySet<SketchTool> = new Set<SketchTool>([
  "polygon", "slot", "slot-straight", "line-midpoint", "centerline", "parallelogram", "rectangle-rounded", "slot-arc-three-point", "slot-arc-center", "ellipse-arc"
]);

export interface ShapeSnapInput {
  readonly tool: SketchTool;
  readonly shape: SketchShape;
  /** One entry per click, in the order the tool used them. */
  readonly placed: readonly PlacedPointInference[];
  readonly sketch: WorkbenchSketch;
  readonly newId: () => string;
  /** Clicks (by index) whose relations are made elsewhere, such as a polygon's centre. */
  readonly skip?: ReadonlySet<number>;
}

const apart = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);
const AT = 1e-6;

/** A half-circle cap (or any arc) whose stored middle is the middle of its sweep, so the solver's "mid" is that very point. */
function middleIsExact(entity: SketchEntity): boolean {
  return entity.kind === "arc" && Math.abs(apart(entity.mid, entity.start) - apart(entity.mid, entity.end)) <= 1e-9;
}

/** The distance from a point to the curve of a line, circle or arc (infinite for the other kinds). */
function distanceToCurve(entity: SketchEntity, point: Vec2): number {
  if (entity.kind === "line") {
    const dx = entity.end[0] - entity.start[0];
    const dy = entity.end[1] - entity.start[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-12) return Infinity;
    const t = ((point[0] - entity.start[0]) * dx + (point[1] - entity.start[1]) * dy) / (length * length);
    if (t < -1e-9 || t > 1 + 1e-9) return Infinity;
    return Math.abs((point[0] - entity.start[0]) * dy - (point[1] - entity.start[1]) * dx) / length;
  }
  if (entity.kind === "circle") return Math.abs(apart(point, entity.center) - entity.radiusMm);
  return Infinity;
}

/** A stable name for a relation, used to leave out one that the shape already carries. */
export function relationKey(constraint: WorkbenchSketchConstraint): string {
  const parts = constraint.entityIds.map((id, index) => `${id}.${constraint.points?.[index] ?? ""}`);
  return `${constraint.kind}|${(constraint.kind === "coincident" ? [...parts].sort() : parts).join("|")}`;
}

export function shapeSnapRelations(input: ShapeSnapInput): readonly WorkbenchSketchConstraint[] {
  if (!SNAPPING_SHAPE_TOOLS.has(input.tool)) return [];
  const found: WorkbenchSketchConstraint[] = [];
  const existing = (id: string | undefined): SketchEntity | undefined => id === undefined ? undefined : input.sketch.entities.find((candidate) => candidate.id === id);
  const taken = new Set<string>();
  input.placed.forEach((inference, index) => {
    const primary = inference.primary;
    if (primary === undefined || input.skip?.has(index) === true) return;
    // The shape's own point at this click: the first one, in the order a single curve uses (centre, ends, ...).
    let own: { readonly entity: SketchEntity; readonly ref: SketchPointRef } | undefined;
    for (const entity of input.shape.entities) {
      const ref = refAt(entity, inference.point);
      if (ref === undefined) continue;
      if (ref === "mid" && !middleIsExact(entity)) continue;
      own = { entity, ref };
      break;
    }
    if (own !== undefined) {
      const key = `${own.entity.id}.${own.ref}`;
      if (taken.has(key)) return;
      taken.add(key);
      const relations = autoConstraintsFor({ tool: input.tool, entity: own.entity, placed: [inference], sketch: input.sketch, newId: input.newId, exactArcMid: true });
      // autoConstraintsFor only reads this one click; a level or plumb line guide belongs to a line being drawn, not to a shape's corner.
      found.push(...relations.filter((relation) => relation.kind === "coincident" || relation.kind === "midpoint"));
      return;
    }
    // The click is on the shape's curve without being one of its points (a centerline passes through the point that was clicked): put the point on it.
    const curve = input.shape.entities.find((entity) => distanceToCurve(entity, inference.point) <= AT);
    if (curve === undefined) return;
    if (primary.kind === "origin" && primary.entityId === undefined) {
      found.push({ id: input.newId(), kind: "coincident", entityIds: [SKETCH_ORIGIN_ID, curve.id], points: ["self", "curve"] });
      return;
    }
    const other = existing(primary.entityId);
    if (other === undefined) return;
    if (primary.kind === "endpoint" || primary.kind === "center") {
      const otherRef = pointRefOf(other, primary);
      if (otherRef !== undefined) found.push({ id: input.newId(), kind: "coincident", entityIds: [other.id, curve.id], points: [otherRef, "curve"] });
    } else if (primary.kind === "midpoint" && other.kind === "line") {
      found.push({ id: input.newId(), kind: "coincident", entityIds: [other.id, curve.id], points: ["mid", "curve"] });
    }
  });
  return found;
}

export interface ProfileSnapInput {
  /** The segment that was just built. */
  readonly entity: SketchEntity;
  /** What its start (first segment only) and its end were snapped to; a click that snapped to nothing is left out. */
  readonly placed: readonly PlacedPointInference[];
  /** The relations the profile chain already made for this segment, so none is repeated. */
  readonly own: readonly WorkbenchSketchConstraint[];
  readonly sketch: WorkbenchSketch;
  readonly newId: () => string;
}

/** The joints a Profile segment earns from its start and end clicks being snapped to other geometry (the chain's own joints are not repeated). */
export function profileSnapRelations(input: ProfileSnapInput): readonly WorkbenchSketchConstraint[] {
  if (input.placed.length === 0) return [];
  const known = new Set(input.own.map(relationKey));
  return autoConstraintsFor({ tool: input.entity.kind === "arc" ? "arc" : "line", entity: input.entity, placed: input.placed, sketch: input.sketch, newId: input.newId, exactArcMid: false })
    .filter((relation) => relation.kind === "coincident" && !known.has(relationKey(relation)));
}
