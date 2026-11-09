import {
  failure,
  type SketchEntity,
  type SketchPointRef,
  type Vec2,
  type WorkbenchSketch,
  type WorkbenchSketchConstraint
} from "../../workbench-core/src/index.js";
import { entityPoints, sampleSpline } from "./index.js";
import { pinnedAmong } from "./sketch-clone.js";
import { finishPlan } from "./edit-relations.js";
import { carryRectangleRelations } from "./corner-keep.js";
import {
  arcEntity,
  arcFrame,
  circleHits,
  curvesOf,
  distanceToCurve,
  editPlan,
  intersectInfinite,
  lineHits,
  wrapTwoPi,
  type Curve,
  type SketchEditContext,
  type SketchEditResult
} from "./edit-tools.js";

/**
 * Split, Jog and Delete Curve (with auto-heal). Each returns one atomic `SketchEditPlan` for `apply-sketch-edit`:
 * the original entity keeps its ID for the first piece, relations that still hold are carried onto the new pieces,
 * and relations that cannot hold any more are removed (and counted in the label) instead of being left to fight the edit.
 */

type Line = Extract<SketchEntity, { kind: "line" }>;
type Arc = Extract<SketchEntity, { kind: "arc" }>;
type Circle = Extract<SketchEntity, { kind: "circle" }>;
type Rectangle = Extract<SketchEntity, { kind: "rectangle" }>;
type Spline = Extract<SketchEntity, { kind: "spline" }>;

const TWO_PI = Math.PI * 2;
/** The shortest piece a split or jog may leave. */
const MIN_PIECE_MM = 0.01;

function reject(message: string, ids: readonly string[] = [], recovery = "Adjust the pick or the values and try again."): SketchEditResult {
  return failure("INVALID_OPERATION", message, ids, recovery);
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function find(sketch: WorkbenchSketch, id: string): SketchEntity | undefined {
  return sketch.entities.find((entity) => entity.id === id);
}

function relationsOn(sketch: WorkbenchSketch, id: string): readonly WorkbenchSketchConstraint[] {
  return sketch.constraints.filter((constraint) => constraint.entityIds.includes(id));
}

/** A copy of `constraint` with `fromId` replaced by `toId` (same point reference). */
function repoint(context: SketchEditContext, constraint: WorkbenchSketchConstraint, fromId: string, toId: string): WorkbenchSketchConstraint {
  return { ...constraint, id: context.newId("constraint"), entityIds: constraint.entityIds.map((id) => (id === fromId ? toId : id)) };
}

function coincident(context: SketchEditContext, a: string, aRef: SketchPointRef, b: string, bRef: SketchPointRef): WorkbenchSketchConstraint {
  return { id: context.newId("constraint"), kind: "coincident", entityIds: [a, b], points: [aRef, bRef] };
}

function relation(context: SketchEditContext, kind: WorkbenchSketchConstraint["kind"], entityIds: readonly string[]): WorkbenchSketchConstraint {
  return { id: context.newId("constraint"), kind, entityIds };
}

// ---------------------------------------------------------------------------------------------
// Arc helpers
// ---------------------------------------------------------------------------------------------

/** An arc that starts at angle `startAngle` and travels `signedSweep` radians (positive counter-clockwise). */
function arcByTravel(template: SketchEntity, id: string, center: Vec2, radius: number, startAngle: number, signedSweep: number): Arc {
  const at = (angle: number): Vec2 => [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  return {
    id,
    kind: "arc",
    start: at(startAngle),
    mid: at(startAngle + signedSweep / 2),
    end: at(startAngle + signedSweep),
    construction: template.construction,
    ...(template.visible === undefined ? {} : { visible: template.visible })
  };
}

interface Travel {
  readonly center: Vec2;
  readonly radius: number;
  /** Angle of the arc's `start` point. */
  readonly startAngle: number;
  /** +1 when the arc runs counter-clockwise from start to end, -1 otherwise. */
  readonly sign: 1 | -1;
  /** Unsigned angle between start and end. */
  readonly sweep: number;
}

function travelOf(arc: Arc): Travel | undefined {
  const frame = arcFrame(arc);
  if (frame === undefined) return undefined;
  const sign = frame.clockwise ? -1 : 1;
  const startAngle = Math.atan2(arc.start[1] - frame.center[1], arc.start[0] - frame.center[0]);
  return { center: frame.center, radius: frame.radius, startAngle, sign, sweep: frame.sweep };
}

/** How far along the arc's travel an angle lies, in radians, taken the short way round. */
function travelOffset(travel: Travel, angle: number): number {
  return travel.sign > 0 ? wrapTwoPi(angle - travel.startAngle) : wrapTwoPi(travel.startAngle - angle);
}

function angleAbout(center: Vec2, point: Vec2): number {
  return Math.atan2(point[1] - center[1], point[0] - center[0]);
}

// ---------------------------------------------------------------------------------------------
// Split
// ---------------------------------------------------------------------------------------------

export interface SplitOptions {
  /** How close a pick has to be to a crossing with another curve to land exactly on it. Defaults to the sketch snap tolerance. */
  readonly snapMm?: number;
}

/**
 * Splits a curve at the picked point (or, if a crossing with another curve lies within the snap distance, exactly there).
 * A line, arc or spline becomes two curves; a circle becomes two arcs; a rectangle becomes five lines (its sides plus the split).
 */
export function splitAt(context: SketchEditContext, targetId: string, pick: Vec2, options: SplitOptions = {}): SketchEditResult {
  const target = find(context.sketch, targetId);
  if (target === undefined) return reject("Pick a curve to split.");
  const snap = options.snapMm ?? context.sketch.snapToleranceMm;
  const others = context.sketch.entities.filter((entity) => entity.id !== targetId && entity.visible !== false && entity.kind !== "point");
  const boundaries = others.flatMap(curvesOf);
  const planned = ((): SketchEditResult => {
    switch (target.kind) {
      case "line": return splitLine(context, target, pick, boundaries, snap);
      case "arc": return splitArc(context, target, pick, boundaries, snap);
      case "circle": return splitCircle(context, target, pick, boundaries, snap);
      case "rectangle": return splitRectangle(context, target, pick);
      case "spline": return splitSpline(context, target, pick);
      default: return reject(`Split applies to lines, arcs, circles, rectangles and splines; a ${target.kind} cannot be split.`, [target.id]);
    }
  })();
  return checked(context, planned, target.id);
}

/**
 * Runs a finished split or heal through the same settling every other edit gets: relations the new geometry makes untrue (an arc-length
 * dimension on a half arc, a smooth join on half a spline, an Equal link to a curve whose neighbour moved) are removed with the edit instead
 * of making the operation refuse it with a conflict, relations the other additions already imply are not added, and the entity limits are
 * named. The curve being split or deleted may carry a Fixed relation: its pieces keep it.
 */
function checked(context: SketchEditContext, planned: SketchEditResult, targetId: string): SketchEditResult {
  if (!planned.ok) return planned;
  return finishPlan(context, planned.value, { allowPinned: [targetId], prune: true });
}

function splitLine(context: SketchEditContext, line: Line, pick: Vec2, boundaries: readonly Curve[], snap: number): SketchEditResult {
  const direction: Vec2 = [line.end[0] - line.start[0], line.end[1] - line.start[1]];
  const length = Math.hypot(direction[0], direction[1]);
  if (length < 2 * MIN_PIECE_MM) return reject("The line is too short to split.", [line.id]);
  const along = (point: Vec2): number => ((point[0] - line.start[0]) * direction[0] + (point[1] - line.start[1]) * direction[1]) / (length * length);
  let t = along(pick);
  const crossings = boundaries.flatMap((curve) => lineHits(line.start, line.end, curve)).filter((value) => value > 0 && value < 1);
  const nearest = crossings.map((value) => ({ value, gap: Math.abs(value - t) * length })).sort((a, b) => a.gap - b.gap)[0];
  let snapped = false;
  if (nearest !== undefined && nearest.gap <= snap) { t = nearest.value; snapped = true; }
  if (t * length < MIN_PIECE_MM || (1 - t) * length < MIN_PIECE_MM) return reject("Pick a point between the ends of the line; a split at an end would leave a zero-length piece.", [line.id]);
  const at: Vec2 = [line.start[0] + direction[0] * t, line.start[1] + direction[1] * t];
  const second: Line = { ...line, id: context.newId("entity"), start: at };
  const first: Line = { ...line, end: at };
  const migrated = migrateLineSplit(context, line, second.id);
  // Both halves of a fixed line stay fixed where they are, which already keeps them joined; the solver cannot take joint relations between two fixed lines.
  const pinned = pinnedAmong(context.sketch, [line.id]).length > 0;
  return editPlan(`Split line at (${fmt(at[0])}, ${fmt(at[1])})${snapped ? " on a crossing" : ""}${migrated.note}`, {
    updateEntities: [first],
    addEntities: [second],
    // Joined end to end and parallel is exactly "one straight line in two pieces", with no equation twice: Collinear next to a joint repeats the offset the joint already fixes.
    addConstraints: [...(pinned ? [] : [coincident(context, line.id, "end", second.id, "start"), relation(context, "parallel", [line.id, second.id])]), ...migrated.add],
    removeConstraintIds: migrated.remove
  });
}

/** Whether the line's end is joined (Coincident) to the other curve. */
function touchesAtEnd(sketch: WorkbenchSketch, lineId: string, otherId: string | undefined): boolean {
  if (otherId === undefined) return false;
  return sketch.constraints.some((candidate) => {
    if (candidate.kind !== "coincident" || candidate.suppressed === true || !candidate.entityIds.includes(lineId) || !candidate.entityIds.includes(otherId)) return false;
    const index = candidate.entityIds.indexOf(lineId);
    return candidate.points?.[index] === "end";
  });
}

/** Which relations on a split line survive on its first piece, move to the second piece, or stop being true. */
function migrateLineSplit(context: SketchEditContext, line: Line, secondId: string): { readonly add: WorkbenchSketchConstraint[]; readonly remove: string[]; readonly note: string } {
  const add: WorkbenchSketchConstraint[] = [];
  const remove: string[] = [];
  let dropped = 0;
  for (const constraint of relationsOn(context.sketch, line.id)) {
    const index = constraint.entityIds.indexOf(line.id);
    const ref = constraint.points?.[index];
    if (constraint.kind === "fixed") {
      add.push(repoint(context, constraint, line.id, secondId));
    } else if (constraint.kind === "coincident" || constraint.kind === "midpoint") {
      if (ref === "end") { remove.push(constraint.id); add.push(repoint(context, constraint, line.id, secondId)); }
      else if (ref === "mid" || (constraint.kind === "midpoint" && index === 1)) { remove.push(constraint.id); dropped += 1; }
    } else if (constraint.kind === "tangent" && touchesAtEnd(context.sketch, line.id, constraint.entityIds.find((id) => id !== line.id))) {
      // The tangent is held where the line meets the curve: that is the end of the second piece now, so the tangency goes with it
      // (left on the first piece it would only be a distance to the carrier line, which the solver cannot tell from a collinear joint).
      remove.push(constraint.id);
      add.push(repoint(context, constraint, line.id, secondId));
    } else if (constraint.kind === "equal" || constraint.kind === "distance" || constraint.kind === "symmetry") {
      remove.push(constraint.id);
      dropped += 1;
    }
    // Horizontal, vertical, parallel, perpendicular, collinear and tangent hold for the whole straight line, so the first piece keeps
    // them and the collinear joint carries them to the second piece.
  }
  return { add, remove, note: dropped === 0 ? "" : ` (${dropped} relation${dropped === 1 ? "" : "s"} no longer true and removed)` };
}

function splitArc(context: SketchEditContext, arc: Arc, pick: Vec2, boundaries: readonly Curve[], snap: number): SketchEditResult {
  const travel = travelOf(arc);
  if (travel === undefined) return reject("The arc is degenerate.", [arc.id]);
  const { center, radius, sweep } = travel;
  let offset = travelOffset(travel, angleAbout(center, pick));
  if (offset > sweep) offset = offset - sweep < TWO_PI - offset ? sweep : 0;
  const crossings = boundaries.flatMap((curve) => circleHits(center, radius, curve)).map((angle) => travelOffset(travel, angle)).filter((value) => value > 1e-9 && value < sweep - 1e-9);
  const nearest = crossings.map((value) => ({ value, gap: Math.abs(value - offset) * radius })).sort((a, b) => a.gap - b.gap)[0];
  let snapped = false;
  if (nearest !== undefined && nearest.gap <= snap) { offset = nearest.value; snapped = true; }
  if (offset * radius < MIN_PIECE_MM || (sweep - offset) * radius < MIN_PIECE_MM) return reject("Pick a point between the ends of the arc; a split at an end would leave a zero-length piece.", [arc.id]);
  const firstPiece = arcByTravel(arc, arc.id, center, radius, travel.startAngle, travel.sign * offset);
  const secondPiece = arcByTravel(arc, context.newId("entity"), center, radius, travel.startAngle + travel.sign * offset, travel.sign * (sweep - offset));
  const add: WorkbenchSketchConstraint[] = pinnedAmong(context.sketch, [arc.id]).length > 0 ? [] : [relation(context, "concentric", [arc.id, secondPiece.id])];
  const remove: string[] = [];
  let dropped = 0;
  for (const constraint of relationsOn(context.sketch, arc.id)) {
    const index = constraint.entityIds.indexOf(arc.id);
    const ref = constraint.points?.[index];
    switch (constraint.kind) {
      case "radius":
      case "concentric":
      case "equal":
      case "fixed":
        add.push(repoint(context, constraint, arc.id, secondPiece.id));
        break;
      case "coincident":
        if (ref === "center") add.push(repoint(context, constraint, arc.id, secondPiece.id));
        else if (ref === "end") { remove.push(constraint.id); add.push(repoint(context, constraint, arc.id, secondPiece.id)); }
        else if (ref === "mid") { remove.push(constraint.id); dropped += 1; }
        break;
      case "symmetry":
      case "midpoint":
        remove.push(constraint.id);
        dropped += 1;
        break;
      default:
        break;
    }
  }
  const at = ((): Vec2 => { const angle = travel.startAngle + travel.sign * offset; return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]; })();
  return editPlan(`Split arc at (${fmt(at[0])}, ${fmt(at[1])})${snapped ? " on a crossing" : ""}${dropped === 0 ? "" : ` (${dropped} relation${dropped === 1 ? "" : "s"} no longer true and removed)`}`, {
    updateEntities: [firstPiece],
    addEntities: [secondPiece],
    addConstraints: add,
    removeConstraintIds: remove
  });
}

function splitCircle(context: SketchEditContext, circle: Circle, pick: Vec2, boundaries: readonly Curve[], snap: number): SketchEditResult {
  const { center, radiusMm: radius } = circle;
  let first = angleAbout(center, pick);
  const hits = boundaries.flatMap((curve) => circleHits(center, radius, curve)).map(wrapTwoPi).sort((a, b) => a - b).filter((angle, index, all) => index === 0 || angle - all[index - 1]! > 1e-6);
  let second = first + Math.PI;
  let note = "at the pick and the point opposite it";
  if (hits.length >= 1) {
    const pickAngle = wrapTwoPi(first);
    const circular = (a: number, b: number): number => { const gap = Math.abs(a - b); return Math.min(gap, TWO_PI - gap); };
    const closest = [...hits].sort((a, b) => circular(a, pickAngle) - circular(b, pickAngle))[0]!;
    if (circular(closest, pickAngle) * radius <= snap) first = closest;
    if (hits.length >= 2) {
      // Split at the two crossings on either side of the pick, so the pick lies on one of the two arcs.
      const before = [...hits].reverse().find((angle) => angle <= wrapTwoPi(first) + 1e-9) ?? hits[hits.length - 1]!;
      const after = hits.find((angle) => angle > wrapTwoPi(first) + 1e-9) ?? hits[0]!;
      if (circular(before, after) > 1e-6) { first = before; second = after; note = "at the crossings on either side of the pick"; }
    }
  }
  const sweepA = wrapTwoPi(second - first);
  if (sweepA * radius < MIN_PIECE_MM || (TWO_PI - sweepA) * radius < MIN_PIECE_MM) return reject("The two split points coincide; pick a different point.", [circle.id]);
  const arcA = arcByTravel(circle, context.newId("entity"), center, radius, first, sweepA);
  const arcB = arcByTravel(circle, context.newId("entity"), center, radius, first + sweepA, TWO_PI - sweepA);
  const add: WorkbenchSketchConstraint[] = pinnedAmong(context.sketch, [circle.id]).length > 0 ? [] : [relation(context, "concentric", [arcA.id, arcB.id])];
  let dropped = 0;
  for (const constraint of relationsOn(context.sketch, circle.id)) {
    const index = constraint.entityIds.indexOf(circle.id);
    const ref = constraint.points?.[index];
    if (constraint.kind === "radius" || constraint.kind === "concentric" || constraint.kind === "equal" || constraint.kind === "fixed" || constraint.kind === "tangent" || (constraint.kind === "coincident" && ref === "center")) {
      add.push(repoint(context, constraint, circle.id, arcA.id), repoint(context, constraint, circle.id, arcB.id));
    } else dropped += 1;
  }
  return editPlan(`Split circle into two arcs ${note}${dropped === 0 ? "" : ` (${dropped} relation${dropped === 1 ? "" : "s"} no longer true and removed)`}`, {
    removeEntityIds: [circle.id],
    addEntities: [arcA, arcB],
    addConstraints: add
  });
}

function splitRectangle(context: SketchEditContext, rectangle: Rectangle, pick: Vec2): SketchEditResult {
  const corners = entityPoints(rectangle);
  let side = 0;
  let best = Infinity;
  const sideCurve = (index: number): { readonly a: Vec2; readonly b: Vec2 } => ({ a: corners[index]!, b: corners[(index + 1) % 4]! });
  for (let index = 0; index < 4; index += 1) {
    const { a, b } = sideCurve(index);
    const gap = distanceToCurve(pick, { kind: "line", a, b });
    if (gap < best) { best = gap; side = index; }
  }
  const { a, b } = sideCurve(side);
  const length = dist(a, b);
  const t = Math.max(0, Math.min(1, ((pick[0] - a[0]) * (b[0] - a[0]) + (pick[1] - a[1]) * (b[1] - a[1])) / (length * length)));
  if (t * length < MIN_PIECE_MM || (1 - t) * length < MIN_PIECE_MM) return reject("Pick a point between the corners of the rectangle side.", [rectangle.id]);
  const at: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const chain: Vec2[] = [];
  const cornerAt: number[] = [];
  for (let index = 0; index < 4; index += 1) {
    cornerAt[index] = chain.length;
    chain.push(corners[index]!);
    if (index === side) chain.push(at);
  }
  const lines: Line[] = chain.map((start, index) => ({
    id: context.newId("entity"),
    kind: "line",
    start,
    end: chain[(index + 1) % chain.length]!,
    construction: rectangle.construction,
    ...(rectangle.visible === undefined ? {} : { visible: rectangle.visible })
  }));
  const pinnedRectangle = pinnedAmong(context.sketch, [rectangle.id]).length > 0;
  const constraints: WorkbenchSketchConstraint[] = pinnedRectangle ? [] : lines.map((line, index) => coincident(context, line.id, "end", lines[(index + 1) % lines.length]!.id, "start"));
  const rotation = ((rectangle.rotationDeg % 90) + 90) % 90;
  if (!pinnedRectangle && Math.min(rotation, 90 - rotation) < 1e-6) {
    lines.forEach((line) => {
      const horizontal = Math.abs(line.end[1] - line.start[1]) < Math.abs(line.end[0] - line.start[0]);
      constraints.push(relation(context, horizontal ? "horizontal" : "vertical", [line.id]));
    });
  }
  const carried = relationsOn(context.sketch, rectangle.id).filter((constraint) => constraint.kind === "fixed").flatMap((constraint) => lines.map((line) => repoint(context, constraint, rectangle.id, line.id)));
  // Width and height stay driven: the side that was split is measured between its two corners, the others by their line.
  const cornerLine = cornerAt.map((index) => lines[index]!.id);
  const sizes: WorkbenchSketchConstraint[] = [];
  if (!pinnedRectangle) {
    for (const constraint of relationsOn(context.sketch, rectangle.id)) {
      if (constraint.kind !== "distance" || constraint.driven === true || constraint.suppressed === true || constraint.valueMm === undefined || constraint.entityIds[0] !== rectangle.id) continue;
      if (constraint.dimension !== "width" && constraint.dimension !== "height") continue;
      const sideIndex = constraint.dimension === "height" ? 1 : 0;
      const keepExpression = constraint.expression === undefined ? {} : { expression: constraint.expression };
      if (sideIndex === side) {
        sizes.push({ id: context.newId("constraint"), kind: "distance", dimension: "aligned", entityIds: [cornerLine[sideIndex]!, cornerLine[(sideIndex + 1) % 4]!], points: ["start", "start"], valueMm: constraint.valueMm, ...keepExpression });
      } else {
        sizes.push({ id: context.newId("constraint"), kind: "distance", dimension: "length", entityIds: [cornerLine[sideIndex]!], valueMm: constraint.valueMm, ...keepExpression });
      }
    }
  }
  // A corner pinned to the origin, a line joined to a corner or a hole measured from the centre moves onto the sides.
  const points = pinnedRectangle ? { addEntities: [] as SketchEntity[], addConstraints: [] as WorkbenchSketchConstraint[], lost: [] as WorkbenchSketchConstraint[] } : carryRectangleRelations(context, context.sketch, rectangle, { cornerLine, lines });
  const lost = points.lost.length;
  return editPlan(`Split rectangle side at (${fmt(at[0])}, ${fmt(at[1])}); the rectangle is now ${lines.length} lines${lost === 0 ? "" : ` (${lost} rectangle relation${lost === 1 ? "" : "s"} removed)`}`, {
    removeEntityIds: [rectangle.id],
    addEntities: [...lines, ...points.addEntities],
    addConstraints: [...constraints, ...carried, ...sizes, ...points.addConstraints]
  });
}

/** Cumulative arc length of a sampled polyline. */
function cumulative(points: readonly Vec2[]): number[] {
  const lengths = [0];
  for (let index = 1; index < points.length; index += 1) lengths.push(lengths[index - 1]! + dist(points[index - 1]!, points[index]!));
  return lengths;
}

/**
 * A spline is split by re-fitting each half through points of the original curve on its side of the split. A half is a fresh
 * Catmull-Rom fit, so it cannot reproduce the original exactly with its old fit points alone; instead each half is fitted through as
 * many evenly spaced points of the original curve as it needs (up to the 24 a spline takes) until it follows the original within
 * 0.01 mm. The deviation that is left is reported in the label.
 */
function splitSpline(context: SketchEditContext, spline: Spline, pick: Vec2): SketchEditResult {
  const samplesPerSpan = 32;
  const samples = sampleSpline(spline.fitPoints, samplesPerSpan);
  const lengths = cumulative(samples);
  let bestIndex = 0;
  let bestGap = Infinity;
  let bestAt: Vec2 = samples[0]!;
  for (let index = 0; index < samples.length - 1; index += 1) {
    const a = samples[index]!;
    const b = samples[index + 1]!;
    const span = dist(a, b);
    const t = span < 1e-12 ? 0 : Math.max(0, Math.min(1, ((pick[0] - a[0]) * (b[0] - a[0]) + (pick[1] - a[1]) * (b[1] - a[1])) / (span * span)));
    const point: Vec2 = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const gap = dist(point, pick);
    if (gap < bestGap) { bestGap = gap; bestIndex = index; bestAt = point; }
  }
  const total = lengths[lengths.length - 1]!;
  const position = lengths[bestIndex]! + dist(samples[bestIndex]!, bestAt);
  if (position < 2 * MIN_PIECE_MM || total - position < 2 * MIN_PIECE_MM) return reject("Pick a point between the ends of the spline.", [spline.id]);

  const pointAt = (s: number): Vec2 => {
    if (s <= 0) return samples[0]!;
    if (s >= total) return samples[samples.length - 1]!;
    let index = 1;
    while (index < lengths.length - 1 && lengths[index]! < s) index += 1;
    const span = lengths[index]! - lengths[index - 1]!;
    const t = span < 1e-12 ? 0 : (s - lengths[index - 1]!) / span;
    const a = samples[index - 1]!;
    const b = samples[index]!;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };
  const originalRun = (from: number, to: number): Vec2[] => {
    const run: Vec2[] = [pointAt(from)];
    for (let index = 0; index < samples.length; index += 1) if (lengths[index]! > from + 1e-9 && lengths[index]! < to - 1e-9) run.push(samples[index]!);
    run.push(pointAt(to));
    return run;
  };
  const gapToRun = (point: Vec2, run: readonly Vec2[]): number => {
    let best = Infinity;
    for (let index = 0; index < run.length - 1; index += 1) {
      const a = run[index]!;
      const b = run[index + 1]!;
      const span = dist(a, b);
      const t = span < 1e-12 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1])) / (span * span)));
      best = Math.min(best, dist(point, [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]));
    }
    return best;
  };
  const fitHalf = (from: number, to: number): { readonly points: Vec2[]; readonly deviation: number } | undefined => {
    if (to - from < 2 * MIN_PIECE_MM) return undefined;
    const run = originalRun(from, to);
    let best: { points: Vec2[]; deviation: number } | undefined;
    for (let count = 3; count <= 24; count += 1) {
      const points = Array.from({ length: count }, (_, index) => pointAt(from + ((to - from) * index) / (count - 1)));
      if (points.some((point, index) => index > 0 && dist(points[index - 1]!, point) < MIN_PIECE_MM)) break;
      const fitted = sampleSpline(points, 12);
      const deviation = Math.max(...fitted.map((point) => gapToRun(point, run)));
      if (best === undefined || deviation < best.deviation) best = { points, deviation };
      if (deviation <= 0.01) break;
    }
    return best;
  };
  const firstHalf = fitHalf(0, position);
  const secondHalf = fitHalf(position, total);
  if (firstHalf === undefined || secondHalf === undefined) return reject("The spline cannot be split there into two valid splines.", [spline.id]);
  const first: Spline = { ...spline, fitPoints: firstHalf.points };
  const second: Spline = { ...spline, id: context.newId("entity"), fitPoints: secondHalf.points };
  const worst = Math.max(firstHalf.deviation, secondHalf.deviation);
  return editPlan(`Split spline at (${fmt(bestAt[0])}, ${fmt(bestAt[1])}) (halves follow the curve within ${worst < 0.001 ? "0.001" : fmt(Math.ceil(worst * 1000) / 1000)} mm)`, { updateEntities: [first], addEntities: [second] });
}

function nearestSample(samples: readonly Vec2[], point: Vec2): number {
  let best = 0;
  let bestGap = Infinity;
  samples.forEach((sample, index) => { const gap = dist(sample, point); if (gap < bestGap) { bestGap = gap; best = index; } });
  return best;
}

// ---------------------------------------------------------------------------------------------
// Jog
// ---------------------------------------------------------------------------------------------

export interface JogSpec {
  /** Perpendicular step, positive to the left of the line's direction. */
  readonly offsetMm: number;
  /**
   * Width of the jog along the line. With a width the line steps out and back (a bump) and both ends stay where they were; with 0 it makes a
   * single step and the rest of the line, including its far end, shifts by the offset.
   */
  readonly widthMm: number;
}

/**
 * Inserts an offset step into a line at the picked point. With a width the pick is the centre of the jog.
 */
export function jogLine(context: SketchEditContext, lineId: string, pick: Vec2, spec: JogSpec): SketchEditResult {
  const line = find(context.sketch, lineId);
  if (line?.kind !== "line") return reject("Jog applies to a line. Click on a line.", lineId === "" ? [] : [lineId]);
  const { offsetMm, widthMm } = spec;
  if (!Number.isFinite(offsetMm) || Math.abs(offsetMm) < MIN_PIECE_MM || Math.abs(offsetMm) > 5000) return reject("Enter a jog offset between 0.01 mm and 5000 mm (negative steps to the right of the line).");
  if (!Number.isFinite(widthMm) || widthMm < 0 || widthMm > 5000) return reject("Enter a jog width of 0 (a single step) or between 0.01 mm and 5000 mm.");
  if (widthMm > 0 && widthMm < MIN_PIECE_MM) return reject("A jog width must be 0 (a single step) or at least 0.01 mm.");
  const length = dist(line.start, line.end);
  if (length < 3 * MIN_PIECE_MM) return reject("The line is too short to jog.", [line.id]);
  const unit: Vec2 = [(line.end[0] - line.start[0]) / length, (line.end[1] - line.start[1]) / length];
  const normal: Vec2 = [-unit[1], unit[0]];
  const pickAt = (pick[0] - line.start[0]) * unit[0] + (pick[1] - line.start[1]) * unit[1];
  const from = widthMm > 0 ? pickAt - widthMm / 2 : pickAt;
  const to = widthMm > 0 ? pickAt + widthMm / 2 : pickAt;
  if (from < MIN_PIECE_MM || to > length - MIN_PIECE_MM) return reject(widthMm > 0 ? "The jog does not fit on the line there; pick nearer the middle or use a smaller width." : "Pick a point between the ends of the line.", [line.id]);
  const along = (distanceMm: number): Vec2 => [line.start[0] + unit[0] * distanceMm, line.start[1] + unit[1] * distanceMm];
  const step = (point: Vec2): Vec2 => [point[0] + normal[0] * offsetMm, point[1] + normal[1] * offsetMm];
  const relations = relationsOn(context.sketch, line.id);
  if (pinnedAmong(context.sketch, [line.id]).length > 0) return reject("This line is fixed, so it cannot be jogged.", [line.id], "Relax its Fixed relation first (Relax Relations), then jog it.");
  const endJoined = relations.some((constraint) => constraint.kind === "coincident" && constraint.entityIds.indexOf(line.id) >= 0 && constraint.points?.[constraint.entityIds.indexOf(line.id)] === "end");
  if (widthMm === 0 && endJoined) return reject("This line's far end is joined to another curve and would move by the jog offset.", [line.id], "Give the jog a width (a bump keeps both ends in place), or relax the relation on that end first.");
  const make = (start: Vec2, end: Vec2, keep?: Line): Line => ({ ...line, id: keep === undefined ? context.newId("entity") : keep.id, start, end });
  const dropped = relations.filter((constraint) => constraint.kind === "equal" || constraint.kind === "distance" || constraint.kind === "symmetry" || constraint.kind === "midpoint");
  const removeIds = dropped.map((constraint) => constraint.id);
  if (widthMm > 0) {
    const p1 = along(from);
    const p2 = along(to);
    const q1 = step(p1);
    const q2 = step(p2);
    const a = make(line.start, p1, line);
    const s1 = make(p1, q1);
    const m = make(q1, q2);
    // Drawn from the line out to the step so it runs the same way as the first step: the solver reads parallel as same direction.
    const s2 = make(p2, q2);
    const b = make(p2, line.end);
    const ends = relations.filter((constraint) => constraint.kind === "coincident" && constraint.points?.[constraint.entityIds.indexOf(line.id)] === "end");
    const carried = ends.flatMap((constraint) => { removeIds.push(constraint.id); return [repoint(context, constraint, line.id, b.id)]; });
    const fixed = relations.filter((constraint) => constraint.kind === "fixed").map((constraint) => repoint(context, constraint, line.id, b.id));
    return editPlan(`Jogged line by ${fmt(offsetMm)} mm over ${fmt(widthMm)} mm`, {
      updateEntities: [a],
      addEntities: [s1, m, s2, b],
      addConstraints: [
        coincident(context, a.id, "end", s1.id, "start"),
        coincident(context, s1.id, "end", m.id, "start"),
        coincident(context, m.id, "end", s2.id, "end"),
        coincident(context, s2.id, "start", b.id, "start"),
        relation(context, "perpendicular", [a.id, s1.id]),
        relation(context, "parallel", [a.id, m.id]),
        relation(context, "perpendicular", [a.id, s2.id]),
        relation(context, "collinear", [a.id, b.id]),
        ...carried,
        ...fixed
      ],
      removeConstraintIds: removeIds
    });
  }
  const p = along(from);
  const q = step(p);
  const a = make(line.start, p, line);
  const s = make(p, q);
  const b = make(q, step(line.end));
  const fixed = relations.filter((constraint) => constraint.kind === "fixed").map((constraint) => repoint(context, constraint, line.id, b.id));
  return editPlan(`Jogged line by ${fmt(offsetMm)} mm (the rest of the line shifts)`, {
    updateEntities: [a],
    addEntities: [s, b],
    addConstraints: [
      coincident(context, a.id, "end", s.id, "start"),
      coincident(context, s.id, "end", b.id, "start"),
      relation(context, "perpendicular", [a.id, s.id]),
      relation(context, "parallel", [a.id, b.id]),
      ...fixed
    ],
    removeConstraintIds: removeIds
  });
}

// ---------------------------------------------------------------------------------------------
// Delete Curve with auto-heal
// ---------------------------------------------------------------------------------------------

export type Healable = Line | Arc;

interface Neighbour {
  readonly entity: Healable;
  /** Which end of the neighbour touches the deleted curve. */
  readonly end: "start" | "end";
}

function endOf(entity: Healable, end: "start" | "end"): Vec2 {
  return end === "start" ? entity.start : entity.end;
}

function neighboursAt(sketch: WorkbenchSketch, target: Healable, point: Vec2, tolerance: number): { readonly healable: Neighbour[]; readonly blocked: number } {
  const healable: Neighbour[] = [];
  let blocked = 0;
  for (const entity of sketch.entities) {
    if (entity.id === target.id || entity.construction || entity.visible === false) continue;
    if (entity.kind === "line" || entity.kind === "arc") {
      for (const end of ["start", "end"] as const) if (dist(endOf(entity, end), point) <= tolerance) healable.push({ entity, end });
    } else if (entity.kind === "spline") {
      const first = entity.fitPoints[0]!;
      const last = entity.fitPoints[entity.fitPoints.length - 1]!;
      if (dist(first, point) <= tolerance || dist(last, point) <= tolerance) blocked += 1;
    }
  }
  return { healable, blocked };
}

/** `entity` with the named end moved to `to`, or undefined if that would flip, collapse or wrap the curve. */
export function movedEnd(entity: Healable, end: "start" | "end", to: Vec2): Healable | undefined {
  if (entity.kind === "line") {
    const far = end === "start" ? entity.end : entity.start;
    const old = endOf(entity, end);
    const dir: Vec2 = [old[0] - far[0], old[1] - far[1]];
    const span = Math.hypot(dir[0], dir[1]);
    if (span < 1e-12) return undefined;
    const along = ((to[0] - far[0]) * dir[0] + (to[1] - far[1]) * dir[1]) / span;
    if (along < MIN_PIECE_MM) return undefined;
    // The new end must lie on the line's own direction (heals extend or trim along the line, never swing it).
    const side = Math.abs((to[0] - far[0]) * dir[1] - (to[1] - far[1]) * dir[0]) / span;
    if (side > 1e-6 * Math.max(1, span)) return undefined;
    return end === "start" ? { ...entity, start: to } : { ...entity, end: to };
  }
  const travel = travelOf(entity);
  if (travel === undefined) return undefined;
  const target = angleAbout(travel.center, to);
  if (Math.abs(dist(travel.center, to) - travel.radius) > 1e-6 * Math.max(1, travel.radius)) return undefined;
  if (end === "end") {
    const sweep = travelOffset(travel, target);
    if (sweep * travel.radius < MIN_PIECE_MM || sweep > TWO_PI - 0.05) return undefined;
    return arcByTravel(entity, entity.id, travel.center, travel.radius, travel.startAngle, travel.sign * sweep);
  }
  const endAngle = angleAbout(travel.center, entity.end);
  const sweep = travel.sign > 0 ? wrapTwoPi(endAngle - target) : wrapTwoPi(target - endAngle);
  if (sweep * travel.radius < MIN_PIECE_MM || sweep > TWO_PI - 0.05) return undefined;
  return arcByTravel(entity, entity.id, travel.center, travel.radius, target, travel.sign * sweep);
}

/** Candidate points where the two neighbours' curves meet when extended or trimmed. */
function meetingPoints(first: Healable, second: Healable): readonly Vec2[] {
  if (first.kind === "line" && second.kind === "line") {
    const hit = intersectInfinite(first.start, first.end, second.start, second.end);
    return hit === undefined ? [] : [hit];
  }
  const asCircle = (arc: Arc): Curve | undefined => {
    const frame = arcFrame(arc);
    return frame === undefined ? undefined : { kind: "circle", center: frame.center, radius: frame.radius };
  };
  if (first.kind === "line" && second.kind === "arc") {
    const circle = asCircle(second);
    return circle === undefined ? [] : lineHits(first.start, first.end, circle).map((t): Vec2 => [first.start[0] + (first.end[0] - first.start[0]) * t, first.start[1] + (first.end[1] - first.start[1]) * t]);
  }
  if (first.kind === "arc" && second.kind === "line") return meetingPoints(second, first);
  if (first.kind === "arc" && second.kind === "arc") {
    const a = arcFrame(first);
    const b = asCircle(second);
    if (a === undefined || b === undefined) return [];
    return circleHits(a.center, a.radius, b).map((angle): Vec2 => [a.center[0] + a.radius * Math.cos(angle), a.center[1] + a.radius * Math.sin(angle)]);
  }
  return [];
}

/**
 * Deletes a curve and heals the gap: the curves that met it at either end are extended or trimmed to meet each other
 * (lines along their own direction, arcs along their own circle). When the curve has no neighbour on one side, or is a circle,
 * rectangle, ellipse, spline or point, it is simply removed.
 */
export function deleteCurveHeal(context: SketchEditContext, targetId: string): SketchEditResult {
  const target = find(context.sketch, targetId);
  if (target === undefined) return reject("Pick a curve to delete.");
  return checked(context, healPlan(context, target), target.id);
}

function healPlan(context: SketchEditContext, target: SketchEntity): SketchEditResult {
  if (target.kind !== "line" && target.kind !== "arc") {
    return editPlan(`Deleted ${target.kind} (nothing to heal: it has no ends)`, { removeEntityIds: [target.id] });
  }
  const tolerance = Math.max(context.sketch.snapToleranceMm, 1e-6);
  const startSide = neighboursAt(context.sketch, target, target.start, tolerance);
  const endSide = neighboursAt(context.sketch, target, target.end, tolerance);
  if (startSide.healable.length > 1 || endSide.healable.length > 1 || startSide.blocked + endSide.blocked > 0) {
    if (startSide.healable.length + startSide.blocked === 0 || endSide.healable.length + endSide.blocked === 0) {
      return editPlan(`Deleted ${target.kind} (no curve on one side to heal against)`, { removeEntityIds: [target.id] });
    }
    return reject("More than one curve meets this curve at an end (or a spline does), so the gap cannot be healed unambiguously.", [target.id], "Delete it without healing (Delete key), then Extend or Corner the curves you want joined.");
  }
  const left = startSide.healable[0];
  const right = endSide.healable[0];
  if (left === undefined || right === undefined) {
    return editPlan(`Deleted ${target.kind} (no curve on ${left === undefined && right === undefined ? "either side" : "one side"} to heal against)`, { removeEntityIds: [target.id] });
  }
  const pinnedNeighbours = pinnedAmong(context.sketch, [left.entity.id, right.entity.id]);
  if (pinnedNeighbours.length > 0) return reject(`${pinnedNeighbours.map((id) => id.replace(/^entity:/u, "")).join(" and ")} ${pinnedNeighbours.length === 1 ? "is" : "are"} fixed and would have to be stretched to heal the gap.`, [target.id, ...pinnedNeighbours], "Relax the Fixed relation first, or delete the curve without healing (Delete key).");
  if (left.entity.id === right.entity.id) {
    return reject("The curves on both sides of this one are the same curve, so there is nothing to join.", [target.id], "Delete it without healing (Delete key).");
  }
  const midpoint: Vec2 = [(target.start[0] + target.end[0]) / 2, (target.start[1] + target.end[1]) / 2];
  const candidates = meetingPoints(left.entity, right.entity)
    .map((point) => ({ point, left: movedEnd(left.entity, left.end, point), right: movedEnd(right.entity, right.end, point) }))
    .filter((candidate): candidate is { point: Vec2; left: Healable; right: Healable } => candidate.left !== undefined && candidate.right !== undefined)
    .sort((a, b) => dist(a.point, midpoint) - dist(b.point, midpoint));
  const best = candidates[0];
  if (best === undefined) {
    return reject("The curves on either side cannot be extended or trimmed to meet (they are parallel, or would have to flip).", [target.id, left.entity.id, right.entity.id], "Delete it without healing (Delete key), or draw a connecting curve.");
  }
  const joined = left.entity.kind === "line" && right.entity.kind === "line";
  const constraints = joined ? [coincident(context, left.entity.id, left.end, right.entity.id, right.end)] : [];
  return editPlan(`Deleted ${target.kind} and healed the gap at (${fmt(best.point[0])}, ${fmt(best.point[1])})`, {
    removeEntityIds: [target.id],
    updateEntities: [best.left, best.right],
    addConstraints: constraints
  });
}
