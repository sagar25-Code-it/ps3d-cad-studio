import { failure, type SketchEntity, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { sampleSpline } from "./index.js";
import {
  arcFrame,
  circleHits,
  curvesOf,
  distanceToCurve,
  lineHits,
  nearestEntityId,
  wrapTwoPi,
  type Curve,
  type SketchEditContext,
  type SketchEditPlan,
  type SketchEditResult
} from "./edit-tools.js";
import { explodeRectangle } from "./corner-tools.js";
import { splitAt } from "./split-jog.js";
import { carriedRelations, diffPlan, finishPlan, sketchAfter } from "./edit-relations.js";

/**
 * Trim and Extend for lines, arcs, circles, rectangles, ellipses and splines. A relation the edit makes untrue is removed by the plan
 * (never a conflict), the pieces a trim leaves keep the relations of the curve they came from, and a rectangle is a set of lines for
 * the purpose of trimming. Power Trim cuts everything a dragged path crosses in one edit.
 */

type Line = Extract<SketchEntity, { kind: "line" }>;
type Arc = Extract<SketchEntity, { kind: "arc" }>;
type Circle = Extract<SketchEntity, { kind: "circle" }>;
type Ellipse = Extract<SketchEntity, { kind: "ellipse" }>;
type Spline = Extract<SketchEntity, { kind: "spline" }>;

const TWO_PI = Math.PI * 2;
const MIN_PIECE_MM = 0.01;

function reject(message: string, ids: readonly string[] = [], recovery = "Adjust the pick and try again."): SketchEditResult {
  return failure("INVALID_OPERATION", message, ids, recovery);
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

function rawPlan(label: string, parts: Partial<Omit<SketchEditPlan, "label">>): SketchEditResult {
  return { ok: true, value: { label, removeEntityIds: parts.removeEntityIds ?? [], updateEntities: parts.updateEntities ?? [], addEntities: parts.addEntities ?? [], addConstraints: parts.addConstraints ?? [] } };
}

function boundariesOf(sketch: WorkbenchSketch, excludeId: string): readonly Curve[] {
  return sketch.entities.filter((entity) => entity.id !== excludeId && entity.visible !== false && entity.kind !== "point").flatMap(curvesOf);
}

/** Joints at one end of a curve (`ref`), re-pointed at a new piece that now owns that end. */
function carriedJoints(context: SketchEditContext, sketch: WorkbenchSketch, fromId: string, toId: string, ref: "start" | "end"): readonly WorkbenchSketchConstraint[] {
  const carried: WorkbenchSketchConstraint[] = [];
  for (const constraint of sketch.constraints) {
    if (constraint.kind !== "coincident" || constraint.suppressed === true) continue;
    const index = constraint.entityIds.indexOf(fromId);
    if (index < 0 || constraint.points?.[index] !== ref) continue;
    carried.push({ ...constraint, id: context.newId("constraint"), entityIds: constraint.entityIds.map((id) => (id === fromId ? toId : id)) });
  }
  return carried;
}

/** The relations that describe a whole circle, carried to an arc or another piece of the same circle. */
function carriedRoundRelations(context: SketchEditContext, sketch: WorkbenchSketch, fromId: string, toId: string): readonly WorkbenchSketchConstraint[] {
  return sketch.constraints
    .filter((constraint) => constraint.suppressed !== true && constraint.driven !== true && constraint.entityIds.includes(fromId))
    .filter((constraint) => constraint.kind === "radius" || constraint.kind === "concentric" || constraint.kind === "equal" || constraint.kind === "tangent"
      || (constraint.kind === "coincident" && (constraint.points ?? []).every((ref, index) => constraint.entityIds[index] !== fromId || ref === "center")))
    .map((constraint): WorkbenchSketchConstraint => ({ ...constraint, id: context.newId("constraint"), entityIds: constraint.entityIds.map((id) => (id === fromId ? toId : id)) }));
}

// ---------------------------------------------------------------------------------------------
// Trim
// ---------------------------------------------------------------------------------------------

function arcOnCircle(template: SketchEntity, id: string, center: Vec2, radius: number, startAngle: number, sweep: number, clockwise: boolean): Arc {
  const at = (angle: number): Vec2 => [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  const first = at(startAngle);
  const last = at(startAngle + sweep);
  const mid = at(startAngle + sweep / 2);
  return { id, kind: "arc", start: clockwise ? last : first, mid, end: clockwise ? first : last, construction: template.construction, ...(template.visible === undefined ? {} : { visible: template.visible }) };
}

function trimLine(context: SketchEditContext, target: Line, pick: Vec2): SketchEditResult {
  const sketch = context.sketch;
  const direction: Vec2 = [target.end[0] - target.start[0], target.end[1] - target.start[1]];
  const length = Math.hypot(direction[0], direction[1]);
  const hits = boundariesOf(sketch, target.id).flatMap((curve) => lineHits(target.start, target.end, curve)).filter((t) => t > 1e-6 && t < 1 - 1e-6).sort((a, b) => a - b);
  const pickT = clamp(((pick[0] - target.start[0]) * direction[0] + (pick[1] - target.start[1]) * direction[1]) / (length * length), 0, 1);
  let lower = [...hits].reverse().find((t) => t <= pickT) ?? 0;
  let upper = hits.find((t) => t >= pickT) ?? 1;
  if (lower === 0 && upper === 1) return rawPlan("Trim (deleted the whole line: nothing crosses it)", { removeEntityIds: [target.id] });
  // A leftover shorter than the model minimum is a sliver of the same cut, not a piece worth keeping.
  if (lower * length < MIN_PIECE_MM) lower = 0;
  if ((1 - upper) * length < MIN_PIECE_MM) upper = 1;
  if (lower === 0 && upper === 1) return rawPlan("Trim (deleted the whole line)", { removeEntityIds: [target.id] });
  const at = (t: number): Vec2 => [target.start[0] + direction[0] * t, target.start[1] + direction[1] * t];
  const updates: Line[] = [];
  const additions: Line[] = [];
  const constraints: WorkbenchSketchConstraint[] = [];
  if (lower > 0) updates.push({ ...target, end: at(lower) });
  if (upper < 1) {
    if (lower > 0) {
      const second: Line = { ...target, id: context.newId("entity"), start: at(upper) };
      additions.push(second);
      constraints.push(...carriedRelations(context, sketch, target.id, second.id), ...carriedJoints(context, sketch, target.id, second.id, "end"));
    } else updates.push({ ...target, start: at(upper) });
  }
  return rawPlan("Trim line", { updateEntities: updates, addEntities: additions, addConstraints: constraints });
}

function trimCircle(context: SketchEditContext, target: Circle, pick: Vec2): SketchEditResult {
  const boundaries = boundariesOf(context.sketch, target.id);
  const angles = boundaries.flatMap((curve) => circleHits(target.center, target.radiusMm, curve)).map(wrapTwoPi).sort((a, b) => a - b);
  const unique = angles.filter((angle, index) => index === 0 || angle - angles[index - 1]! > 1e-6);
  if (unique.length < 2) return reject(unique.length === 0 ? "Nothing crosses this circle, so there is nothing to trim against." : "A circle needs at least two crossings to trim an arc out of it.", [target.id]);
  const pickAngle = wrapTwoPi(Math.atan2(pick[1] - target.center[1], pick[0] - target.center[0]));
  const before = [...unique].reverse().find((angle) => angle <= pickAngle) ?? unique[unique.length - 1]!;
  const after = unique.find((angle) => angle > pickAngle) ?? unique[0]!;
  // Keep the arc from `after` counter-clockwise round to `before`.
  const kept = arcOnCircle(target, context.newId("entity"), target.center, target.radiusMm, after, wrapTwoPi(before - after), false);
  return rawPlan("Trim circle into an arc", { removeEntityIds: [target.id], addEntities: [kept], addConstraints: [...carriedRoundRelations(context, context.sketch, target.id, kept.id)] });
}

function trimArc(context: SketchEditContext, target: Arc, pick: Vec2): SketchEditResult {
  const frame = arcFrame(target);
  if (frame === undefined) return reject("The arc is degenerate.", [target.id]);
  const boundaries = boundariesOf(context.sketch, target.id);
  const offsets = boundaries.flatMap((curve) => circleHits(frame.center, frame.radius, curve)).map((angle) => wrapTwoPi(angle - frame.startAngle)).filter((offset) => offset > 1e-6 && offset < frame.sweep - 1e-6).sort((a, b) => a - b);
  const pickOffset = wrapTwoPi(Math.atan2(pick[1] - frame.center[1], pick[0] - frame.center[0]) - frame.startAngle);
  const pickClamped = pickOffset > frame.sweep ? (pickOffset - frame.sweep < TWO_PI - pickOffset ? frame.sweep : 0) : pickOffset;
  let lower = [...offsets].reverse().find((offset) => offset <= pickClamped) ?? 0;
  let upper = offsets.find((offset) => offset >= pickClamped) ?? frame.sweep;
  if (lower === 0 && upper === frame.sweep) return rawPlan("Trim (deleted the whole arc: nothing crosses it)", { removeEntityIds: [target.id] });
  if (lower * frame.radius < MIN_PIECE_MM) lower = 0;
  if ((frame.sweep - upper) * frame.radius < MIN_PIECE_MM) upper = frame.sweep;
  if (lower === 0 && upper === frame.sweep) return rawPlan("Trim (deleted the whole arc)", { removeEntityIds: [target.id] });
  const additions: Arc[] = [];
  const updates: Arc[] = [];
  const constraints: WorkbenchSketchConstraint[] = [];
  if (lower > 0) updates.push(arcOnCircle(target, target.id, frame.center, frame.radius, frame.startAngle, lower, frame.clockwise));
  if (upper < frame.sweep) {
    const second = arcOnCircle(target, lower > 0 ? context.newId("entity") : target.id, frame.center, frame.radius, frame.startAngle + upper, frame.sweep - upper, frame.clockwise);
    if (lower > 0) {
      additions.push(second);
      constraints.push(...carriedRoundRelations(context, context.sketch, target.id, second.id), ...carriedJoints(context, context.sketch, target.id, second.id, "end"));
    } else updates.push(second);
  }
  return rawPlan("Trim arc", { updateEntities: updates, addEntities: additions, addConstraints: constraints });
}

/** Parameter values (0 to 2 pi) where an ellipse meets the boundary curves, found by sign changes along the ellipse and bisection. */
function ellipseCrossings(ellipse: Ellipse, boundaries: readonly Curve[]): readonly number[] {
  const radians = (ellipse.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const pointAt = (t: number): Vec2 => {
    const x = ellipse.majorRadiusMm * Math.cos(t);
    const y = ellipse.minorRadiusMm * Math.sin(t);
    return [ellipse.center[0] + x * cos - y * sin, ellipse.center[1] + x * sin + y * cos];
  };
  const found: number[] = [];
  const steps = 720;
  for (const curve of boundaries) {
    let signed: (point: Vec2) => number;
    let within: (point: Vec2) => boolean;
    if (curve.kind === "line") {
      const d: Vec2 = [curve.b[0] - curve.a[0], curve.b[1] - curve.a[1]];
      const length = Math.hypot(d[0], d[1]);
      if (length < 1e-12) continue;
      signed = (point) => ((point[0] - curve.a[0]) * d[1] - (point[1] - curve.a[1]) * d[0]) / length;
      within = (point) => {
        const u = ((point[0] - curve.a[0]) * d[0] + (point[1] - curve.a[1]) * d[1]) / (length * length);
        return u >= -1e-9 && u <= 1 + 1e-9;
      };
    } else {
      signed = (point) => dist(point, curve.center) - curve.radius;
      within = curve.kind === "circle" ? () => true : (point) => wrapTwoPi(Math.atan2(point[1] - curve.center[1], point[0] - curve.center[0]) - curve.startAngle) <= curve.sweep + 1e-9;
    }
    let previousT = 0;
    let previous = signed(pointAt(0));
    for (let step = 1; step <= steps; step += 1) {
      const t = (step / steps) * TWO_PI;
      const value = signed(pointAt(t));
      if (previous === 0 || previous * value < 0) {
        let low = previousT;
        let high = t;
        let lowValue = previous;
        for (let iteration = 0; iteration < 60; iteration += 1) {
          const middle = (low + high) / 2;
          const middleValue = signed(pointAt(middle));
          if (lowValue * middleValue <= 0) high = middle;
          else { low = middle; lowValue = middleValue; }
        }
        const t0 = (low + high) / 2;
        if (within(pointAt(t0))) found.push(wrapTwoPi(t0));
      }
      previousT = t;
      previous = value;
    }
  }
  return found.sort((a, b) => a - b).filter((t, index, all) => index === 0 || t - all[index - 1]! > 1e-6);
}

function splineThrough(template: SketchEntity, id: string, points: readonly Vec2[]): Spline | Line | undefined {
  const spaced = points.filter((point, index) => index === 0 || dist(points[index - 1]!, point) >= MIN_PIECE_MM);
  const shared = { construction: template.construction, ...(template.visible === undefined ? {} : { visible: template.visible }) };
  if (spaced.length >= 3) return { id, kind: "spline", fitPoints: spaced, ...shared };
  if (spaced.length === 2 || (spaced.length === 1 && points.length > 1)) return dist(points[0]!, points[points.length - 1]!) >= MIN_PIECE_MM ? { id, kind: "line", start: points[0]!, end: points[points.length - 1]!, ...shared } : undefined;
  return undefined;
}

function trimEllipse(context: SketchEditContext, target: Ellipse, pick: Vec2): SketchEditResult {
  const crossings = ellipseCrossings(target, boundariesOf(context.sketch, target.id));
  if (crossings.length < 2) return reject(crossings.length === 0 ? "Nothing crosses this ellipse, so there is nothing to trim against." : "An ellipse needs at least two crossings to trim a piece out of it.", [target.id]);
  const radians = (target.rotationDeg * Math.PI) / 180;
  const local: Vec2 = [(pick[0] - target.center[0]) * Math.cos(radians) + (pick[1] - target.center[1]) * Math.sin(radians), -(pick[0] - target.center[0]) * Math.sin(radians) + (pick[1] - target.center[1]) * Math.cos(radians)];
  const pickT = wrapTwoPi(Math.atan2(local[1] / target.minorRadiusMm, local[0] / target.majorRadiusMm));
  const before = [...crossings].reverse().find((t) => t <= pickT) ?? crossings[crossings.length - 1]!;
  const after = crossings.find((t) => t > pickT) ?? crossings[0]!;
  const sweep = wrapTwoPi(before - after);
  const count = clamp(Math.ceil((sweep / TWO_PI) * 22) + 4, 5, 24);
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const points: Vec2[] = Array.from({ length: count }, (_, index): Vec2 => {
    const t = after + (sweep * index) / (count - 1);
    const x = target.majorRadiusMm * Math.cos(t);
    const y = target.minorRadiusMm * Math.sin(t);
    return [target.center[0] + x * cos - y * sin, target.center[1] + x * sin + y * cos];
  });
  const kept = splineThrough(target, context.newId("entity"), points);
  if (kept === undefined) return reject("The remaining piece would be shorter than the model minimum.", [target.id]);
  return rawPlan("Trim ellipse into a spline", { removeEntityIds: [target.id], addEntities: [kept] });
}

interface Polyline {
  readonly points: readonly Vec2[];
  readonly cumulative: readonly number[];
}

function polylineOf(points: readonly Vec2[]): Polyline {
  const cumulative = [0];
  for (let index = 1; index < points.length; index += 1) cumulative.push(cumulative[index - 1]! + dist(points[index - 1]!, points[index]!));
  return { points, cumulative };
}

function pointAtLength(line: Polyline, s: number): Vec2 {
  const total = line.cumulative[line.cumulative.length - 1]!;
  const clamped = clamp(s, 0, total);
  let index = 1;
  while (index < line.cumulative.length - 1 && line.cumulative[index]! < clamped) index += 1;
  const from = line.points[index - 1]!;
  const to = line.points[index]!;
  const span = line.cumulative[index]! - line.cumulative[index - 1]!;
  const t = span < 1e-12 ? 0 : (clamped - line.cumulative[index - 1]!) / span;
  return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t];
}

/** A run of the polyline between two lengths, re-fitted with a spline that passes through points of the original curve. */
function sliceSpline(template: SketchEntity, id: string, line: Polyline, from: number, to: number, fitCount: number, total: number): Spline | Line | undefined {
  const piece = to - from;
  if (piece < MIN_PIECE_MM) return undefined;
  const count = clamp(Math.ceil((piece / total) * (fitCount - 1)) + 2, 3, 24);
  const points = Array.from({ length: count }, (_, index) => pointAtLength(line, from + (piece * index) / (count - 1)));
  return splineThrough(template, id, points);
}

function trimSpline(context: SketchEditContext, target: Spline, pick: Vec2): SketchEditResult {
  const samples = sampleSpline(target.fitPoints, 16);
  const line = polylineOf(samples);
  const total = line.cumulative[line.cumulative.length - 1]!;
  const crossings: number[] = [];
  const boundaries = boundariesOf(context.sketch, target.id);
  for (let index = 0; index < samples.length - 1; index += 1) {
    const a = samples[index]!;
    const b = samples[index + 1]!;
    for (const curve of boundaries) for (const t of lineHits(a, b, curve)) if (t >= -1e-9 && t <= 1 + 1e-9) crossings.push(line.cumulative[index]! + t * (line.cumulative[index + 1]! - line.cumulative[index]!));
  }
  crossings.sort((x, y) => x - y);
  const distinct = crossings.filter((s, index) => (index === 0 || s - crossings[index - 1]! > 1e-6) && s > 1e-6 && s < total - 1e-6);
  let pickS = 0;
  let best = Infinity;
  for (let index = 0; index < samples.length - 1; index += 1) {
    const a = samples[index]!;
    const b = samples[index + 1]!;
    const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
    const lengthSquared = d[0] * d[0] + d[1] * d[1];
    const t = lengthSquared < 1e-18 ? 0 : clamp(((pick[0] - a[0]) * d[0] + (pick[1] - a[1]) * d[1]) / lengthSquared, 0, 1);
    const gap = dist(pick, [a[0] + d[0] * t, a[1] + d[1] * t]);
    if (gap < best) { best = gap; pickS = line.cumulative[index]! + t * (line.cumulative[index + 1]! - line.cumulative[index]!); }
  }
  const lower = [...distinct].reverse().find((s) => s <= pickS) ?? 0;
  const upper = distinct.find((s) => s >= pickS) ?? total;
  if (lower === 0 && upper === total) return rawPlan("Trim (deleted the whole spline: nothing crosses it)", { removeEntityIds: [target.id] });
  const first = lower >= MIN_PIECE_MM ? sliceSpline(target, target.id, line, 0, lower, target.fitPoints.length, total) : undefined;
  const second = total - upper >= MIN_PIECE_MM ? sliceSpline(target, first === undefined ? target.id : context.newId("entity"), line, upper, total, target.fitPoints.length, total) : undefined;
  const pieces = [first, second].filter((piece): piece is Spline | Line => piece !== undefined);
  if (pieces.length === 0) return rawPlan("Trim (deleted the whole spline)", { removeEntityIds: [target.id] });
  // The piece that keeps the spline's ID replaces it (even as a line, when a short stub is left); the other is new.
  return rawPlan("Trim spline", { updateEntities: pieces.filter((piece) => piece.id === target.id), addEntities: pieces.filter((piece) => piece.id !== target.id) });
}

function rawTrim(context: SketchEditContext, target: SketchEntity, pick: Vec2): SketchEditResult {
  switch (target.kind) {
    case "line": return trimLine(context, target, pick);
    case "circle": return trimCircle(context, target, pick);
    case "arc": return trimArc(context, target, pick);
    case "ellipse": return trimEllipse(context, target, pick);
    case "spline": return trimSpline(context, target, pick);
    default: return reject(`Trim applies to lines, arcs, circles, rectangles, ellipses and splines; a ${target.kind} cannot be trimmed.`, [target.id]);
  }
}

function nearestRectangleEdge(lineIds: readonly string[], sketch: WorkbenchSketch, pick: Vec2): string {
  let best = lineIds[0]!;
  let bestGap = Infinity;
  for (const id of lineIds) {
    const entity = sketch.entities.find((candidate) => candidate.id === id);
    if (entity?.kind !== "line") continue;
    const d: Vec2 = [entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]];
    const t = clamp(((pick[0] - entity.start[0]) * d[0] + (pick[1] - entity.start[1]) * d[1]) / (d[0] * d[0] + d[1] * d[1]), 0, 1);
    const gap = dist(pick, [entity.start[0] + d[0] * t, entity.start[1] + d[1] * t]);
    if (gap < bestGap) { bestGap = gap; best = id; }
  }
  return best;
}

/**
 * Removes the part of a curve between its neighbouring intersections that is nearest the pick point. A rectangle becomes four joined
 * lines first, an ellipse or spline keeps its remaining piece as a spline. The pieces keep the relations of the curve they came from.
 */
export function trimAt(context: SketchEditContext, targetId: string, pick: Vec2): SketchEditResult {
  const target = context.sketch.entities.find((entity) => entity.id === targetId);
  if (target === undefined) return reject("Pick a curve to trim.");
  if (!Number.isFinite(pick[0]) || !Number.isFinite(pick[1])) return reject("The pick point is not a number.");
  if (target.kind === "rectangle") {
    const exploded = explodeRectangle(context, target);
    const working = sketchAfter(context.sketch, exploded.plan);
    if (typeof working === "string") return reject(working);
    const edge = nearestRectangleEdge(exploded.lineIds, working, pick);
    const edgeEntity = working.entities.find((entity) => entity.id === edge)!;
    const stepContext: SketchEditContext = { sketch: working, newId: context.newId };
    const trimmed = rawTrim(stepContext, edgeEntity, pick);
    if (!trimmed.ok) return trimmed;
    const step = finishPlan(stepContext, trimmed.value, { solve: false });
    if (!step.ok) return step;
    const after = sketchAfter(working, step.value);
    if (typeof after === "string") return reject(after);
    return finishPlan(context, diffPlan(context.sketch, after, "Trim rectangle edge"));
  }
  const raw = rawTrim(context, target, pick);
  return raw.ok ? finishPlan(context, raw.value) : raw;
}

/** Trim to the closest crossing: removes the end of the curve nearest the pick, up to the first crossing from that end. */
export function trimToClosest(context: SketchEditContext, targetId: string, pick: Vec2): SketchEditResult {
  const target = context.sketch.entities.find((entity) => entity.id === targetId);
  if (target === undefined) return reject("Pick a curve to trim.");
  if (target.kind === "line") {
    const toStart = dist(pick, target.start) <= dist(pick, target.end);
    const length = dist(target.start, target.end);
    const inset = Math.min(1e-4, length / 4);
    const near: Vec2 = toStart
      ? [target.start[0] + ((target.end[0] - target.start[0]) / length) * inset, target.start[1] + ((target.end[1] - target.start[1]) / length) * inset]
      : [target.end[0] - ((target.end[0] - target.start[0]) / length) * inset, target.end[1] - ((target.end[1] - target.start[1]) / length) * inset];
    return trimAt(context, targetId, near);
  }
  return trimAt(context, targetId, pick);
}

/** Cuts every curve a dragged path crosses, at the crossing, in one edit. */
export function powerTrim(context: SketchEditContext, path: readonly Vec2[]): SketchEditResult {
  if (path.length < 2 || path.some((point) => !Number.isFinite(point[0]) || !Number.isFinite(point[1]))) return reject("Drag across the curves you want to trim.");
  const hits: Vec2[] = [];
  const segments = path.slice(0, -1).map((point, index) => ({ a: point, b: path[index + 1]! }));
  for (const entity of context.sketch.entities) {
    if (entity.visible === false || entity.kind === "point") continue;
    for (const curve of curvesOf(entity)) {
      for (const segment of segments) {
        for (const t of lineHits(segment.a, segment.b, curve)) {
          if (t < -1e-9 || t > 1 + 1e-9) continue;
          hits.push([segment.a[0] + (segment.b[0] - segment.a[0]) * t, segment.a[1] + (segment.b[1] - segment.a[1]) * t]);
        }
      }
    }
  }
  if (hits.length === 0) return reject("The dragged path crosses no curve.");
  // Several tessellated pieces of one curve can report the same crossing.
  const unique = hits.filter((hit, index) => hits.findIndex((other) => dist(other, hit) < 1e-6) === index).slice(0, 60);
  let working: WorkbenchSketch = context.sketch;
  let trimmed = 0;
  let firstFailure: SketchEditResult | undefined;
  for (const hit of unique) {
    const target = nearestEntityId(working, hit, 1e-4);
    if (target === undefined) continue;
    const stepContext: SketchEditContext = { sketch: working, newId: context.newId };
    const result = trimAt(stepContext, target, hit);
    if (!result.ok) { firstFailure ??= result; continue; }
    const next = sketchAfter(working, result.value);
    if (typeof next === "string") continue;
    working = next;
    trimmed += 1;
  }
  if (trimmed === 0) return firstFailure ?? reject("Nothing under the dragged path could be trimmed.");
  return finishPlan(context, diffPlan(context.sketch, working, `Power trim: cut ${trimmed} crossing${trimmed === 1 ? "" : "s"}`));
}

// ---------------------------------------------------------------------------------------------
// Extend
// ---------------------------------------------------------------------------------------------

function extendLine(context: SketchEditContext, target: Line, pick: Vec2): SketchEditResult {
  const nearStart = dist(pick, target.start) <= dist(pick, target.end);
  const from = nearStart ? target.start : target.end;
  const away: Vec2 = nearStart ? [target.start[0] - target.end[0], target.start[1] - target.end[1]] : [target.end[0] - target.start[0], target.end[1] - target.start[1]];
  const length = Math.hypot(away[0], away[1]);
  const ray: Vec2 = [from[0] + away[0] / length, from[1] + away[1] / length];
  const hits = boundariesOf(context.sketch, target.id).flatMap((curve) => lineHits(from, ray, curve)).filter((t) => t > 1e-6).sort((a, b) => a - b);
  if (hits.length === 0) return reject("Nothing lies beyond that end of the line, so it cannot be extended.", [target.id]);
  const reach: Vec2 = [from[0] + (ray[0] - from[0]) * hits[0]!, from[1] + (ray[1] - from[1]) * hits[0]!];
  return rawPlan("Extend line", { updateEntities: [nearStart ? { ...target, start: reach } : { ...target, end: reach }] });
}

function extendArc(context: SketchEditContext, target: Arc, pick: Vec2): SketchEditResult {
  const frame = arcFrame(target);
  if (frame === undefined) return reject("The arc is degenerate.", [target.id]);
  const angleOf = (point: Vec2): number => Math.atan2(point[1] - frame.center[1], point[0] - frame.center[0]);
  // Work in counter-clockwise terms: the start of the sweep is the CCW start, the end is the CCW end.
  const ccwStart = frame.startAngle;
  const ccwEnd = frame.startAngle + frame.sweep;
  const pickOffset = wrapTwoPi(angleOf(pick) - ccwStart);
  const nearEnd = pickOffset <= frame.sweep ? pickOffset > frame.sweep / 2 : pickOffset - frame.sweep < TWO_PI - pickOffset;
  const boundaries = boundariesOf(context.sketch, target.id);
  const angles = boundaries.flatMap((curve) => circleHits(frame.center, frame.radius, curve));
  // How far past the chosen end each crossing lies, going on round the circle in the arc's own direction.
  const reach = angles
    .map((angle) => (nearEnd ? wrapTwoPi(angle - ccwEnd) : wrapTwoPi(ccwStart - angle)))
    .filter((turn) => turn > 1e-6 && turn < TWO_PI - 1e-6 - frame.sweep)
    .sort((a, b) => a - b);
  if (reach.length === 0) return reject("Nothing lies beyond that end of the arc, so it cannot be extended.", [target.id]);
  const turn = reach[0]!;
  const sweep = frame.sweep + turn;
  const start = nearEnd ? ccwStart : ccwStart - turn;
  return rawPlan("Extend arc", { updateEntities: [arcOnCircle(target, target.id, frame.center, frame.radius, start, sweep, frame.clockwise)] });
}

function extendSpline(context: SketchEditContext, target: Spline, pick: Vec2): SketchEditResult {
  if (target.fitPoints.length >= 24) return reject("A spline takes at most 24 fit points, so it cannot take another.", [target.id]);
  const samples = sampleSpline(target.fitPoints, 16);
  const nearStart = dist(pick, target.fitPoints[0]!) <= dist(pick, target.fitPoints[target.fitPoints.length - 1]!);
  const from = nearStart ? samples[0]! : samples[samples.length - 1]!;
  const behind = nearStart ? samples[1]! : samples[samples.length - 2]!;
  const away: Vec2 = [from[0] - behind[0], from[1] - behind[1]];
  const length = Math.hypot(away[0], away[1]);
  if (length < 1e-12) return reject("The spline end has no direction to extend along.", [target.id]);
  const ray: Vec2 = [from[0] + away[0] / length, from[1] + away[1] / length];
  const hits = boundariesOf(context.sketch, target.id).flatMap((curve) => lineHits(from, ray, curve)).filter((t) => t > 1e-6).sort((a, b) => a - b);
  if (hits.length === 0) return reject("Nothing lies beyond that end of the spline, so it cannot be extended.", [target.id]);
  const reach: Vec2 = [from[0] + (ray[0] - from[0]) * hits[0]!, from[1] + (ray[1] - from[1]) * hits[0]!];
  const fitPoints = nearStart ? [reach, ...target.fitPoints] : [...target.fitPoints, reach];
  return rawPlan("Extend spline (straight along its end tangent)", { updateEntities: [{ ...target, fitPoints }] });
}

/** Extends the end of a line, arc or spline nearest the pick point to the first curve it reaches. */
export function extendAt(context: SketchEditContext, targetId: string, pick: Vec2): SketchEditResult {
  const target = context.sketch.entities.find((entity) => entity.id === targetId);
  if (!Number.isFinite(pick[0]) || !Number.isFinite(pick[1])) return reject("The pick point is not a number.");
  let raw: SketchEditResult;
  if (target?.kind === "line") raw = extendLine(context, target, pick);
  else if (target?.kind === "arc") raw = extendArc(context, target, pick);
  else if (target?.kind === "spline") raw = extendSpline(context, target, pick);
  else return reject("Extend applies to lines, arcs and splines. Pick near the end of one.");
  return raw.ok ? finishPlan(context, raw.value) : raw;
}

// ---------------------------------------------------------------------------------------------
// Break at crossings
// ---------------------------------------------------------------------------------------------

/**
 * Break / Intersect: splits the given curves (all visible lines, arcs and circles when none are given) at every crossing with another
 * curve in one edit, so a drawing full of crossings is cut into pieces ready for trimming or extruding. Relations migrate to the pieces.
 */
export function breakAtCrossings(context: SketchEditContext, ids: readonly string[] = []): SketchEditResult {
  const sketch = context.sketch;
  const targets = sketch.entities.filter((entity): entity is Line | Arc | Circle => (ids.length === 0 || ids.includes(entity.id)) && entity.visible !== false && !entity.construction && (entity.kind === "line" || entity.kind === "arc" || entity.kind === "circle"));
  if (targets.length === 0) return reject("Select lines, arcs or circles to break, or select nothing to break every curve.");
  let working: WorkbenchSketch = sketch;
  let cuts = 0;
  for (const target of targets) {
    const others = sketch.entities.filter((entity) => entity.id !== target.id && entity.visible !== false && entity.kind !== "point");
    const boundaries = others.flatMap(curvesOf);
    const points: Vec2[] = [];
    if (target.kind === "line") {
      for (const curve of boundaries) for (const t of lineHits(target.start, target.end, curve)) if (t > 1e-6 && t < 1 - 1e-6) points.push([target.start[0] + (target.end[0] - target.start[0]) * t, target.start[1] + (target.end[1] - target.start[1]) * t]);
    } else {
      const circle = target.kind === "circle" ? { center: target.center, radius: target.radiusMm } : (() => { const frame = arcFrame(target); return frame === undefined ? undefined : { center: frame.center, radius: frame.radius }; })();
      if (circle === undefined) continue;
      for (const curve of boundaries) for (const angle of circleHits(circle.center, circle.radius, curve)) points.push([circle.center[0] + circle.radius * Math.cos(angle), circle.center[1] + circle.radius * Math.sin(angle)]);
    }
    const unique = points.filter((point, index) => points.findIndex((other) => dist(other, point) < 1e-6) === index).slice(0, 40);
    if (target.kind === "circle" && unique.length < 2) continue;
    const family = new Set([target.id]);
    for (const point of unique) {
      // The piece of this curve that holds the point now (earlier cuts may have replaced it).
      const piece = [...family].map((id) => working.entities.find((entity) => entity.id === id)).filter((entity): entity is SketchEntity => entity !== undefined)
        .find((entity) => curvesOf(entity).some((curve) => distanceToCurve(point, curve) < 1e-6));
      if (piece === undefined) continue;
      const stepContext: SketchEditContext = { sketch: working, newId: context.newId };
      const step = splitAt(stepContext, piece.id, point, { snapMm: 1e-4 });
      if (!step.ok) continue;
      const next = sketchAfter(working, step.value);
      if (typeof next === "string") continue;
      for (const added of step.value.addEntities) family.add(added.id);
      working = next;
      cuts += 1;
    }
  }
  if (cuts === 0) return reject("No curves cross each other, so there is nothing to break.");
  return finishPlan(context, diffPlan(sketch, working, `Break at crossings: ${cuts} cut${cuts === 1 ? "" : "s"}`));
}
