import { failure, type SketchEntity, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { entityPoints } from "./index.js";
import type { SketchEditContext, SketchEditPlan, SketchEditResult } from "./edit-tools.js";
import { carriedRelations, diffPlan, finishPlan, jointRelation, pairRelation, radiusDimensionRelation, sketchAfter } from "./edit-relations.js";

/**
 * Corner, Fillet and Chamfer for lines and arcs. One engine cuts the two curves back from their meeting point, so a fillet works on
 * line-line, line-arc and arc-arc corners alike, on a corner of a drawn outline (the joint relation is replaced, never a conflict), on
 * crossing curves (the picked quadrant is kept), on every corner of a chain or rectangle, and at a clicked vertex. The results carry
 * their relations: joints, tangents, a radius dimension (or equal radii), equal chamfers.
 */

type Line = Extract<SketchEntity, { kind: "line" }>;
type Arc = Extract<SketchEntity, { kind: "arc" }>;
type Rectangle = Extract<SketchEntity, { kind: "rectangle" }>;
type Cuttable = Line | Arc;

const TWO_PI = Math.PI * 2;
const MIN_PIECE_MM = 0.01;
const JOIN_MM = 1e-6;

function reject(message: string, ids: readonly string[] = [], recovery = "Adjust the selection or the values and try again."): SketchEditResult {
  return failure("INVALID_OPERATION", message, ids, recovery);
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function wrap(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function unit(v: Vec2): Vec2 {
  const length = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / length, v[1] / length];
}

function isCuttable(entity: SketchEntity | undefined): entity is Cuttable {
  return entity?.kind === "line" || entity?.kind === "arc";
}

function find(sketch: WorkbenchSketch, id: string): SketchEntity | undefined {
  return sketch.entities.find((entity) => entity.id === id);
}

function circumcircle(a: Vec2, b: Vec2, c: Vec2): { readonly center: Vec2; readonly radius: number } | undefined {
  const determinant = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(determinant) < 1e-9) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const center: Vec2 = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / determinant,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / determinant
  ];
  return { center, radius: dist(center, a) };
}

// ---------------------------------------------------------------------------------------------
// Curves and how they are cut back from a meeting point
// ---------------------------------------------------------------------------------------------

interface ArcTravel {
  readonly center: Vec2;
  readonly radius: number;
  /** +1 when start to end runs counter-clockwise, -1 when clockwise. */
  readonly dir: 1 | -1;
  readonly startAngle: number;
  readonly endAngle: number;
  readonly sweep: number;
}

export function arcTravel(arc: Arc): ArcTravel | undefined {
  const circle = circumcircle(arc.start, arc.mid, arc.end);
  if (circle === undefined) return undefined;
  const crossValue = (arc.mid[0] - arc.start[0]) * (arc.end[1] - arc.start[1]) - (arc.mid[1] - arc.start[1]) * (arc.end[0] - arc.start[0]);
  const dir: 1 | -1 = crossValue < 0 ? 1 : -1;
  const angleOf = (point: Vec2): number => Math.atan2(point[1] - circle.center[1], point[0] - circle.center[0]);
  const startAngle = angleOf(arc.start);
  const endAngle = angleOf(arc.end);
  return { center: circle.center, radius: circle.radius, dir, startAngle, endAngle, sweep: wrap(dir * (endAngle - startAngle)) };
}

/** An arc on the circle (center, radius) from angle `from` travelling `dir` through `sweep`, keeping the template's flags. */
function arcOn(template: SketchEntity, id: string, center: Vec2, radius: number, from: number, dir: 1 | -1, sweep: number): Arc {
  const at = (angle: number): Vec2 => [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  return { id, kind: "arc", start: at(from), mid: at(from + (dir * sweep) / 2), end: at(from + dir * sweep), construction: template.construction, ...(template.visible === undefined ? {} : { visible: template.visible }) };
}

interface Cut {
  readonly entity: Cuttable;
  readonly travel: ArcTravel | undefined;
  /** The meeting point on this curve's carrier. */
  readonly at: Vec2;
  readonly cutEnd: "start" | "end";
  readonly keepEnd: "start" | "end";
  readonly keepPoint: Vec2;
  /** Length of the retained path from the meeting point to the kept end. */
  readonly retained: number;
  /** Unit tangent at the meeting point along the retained path. */
  readonly tangent: Vec2;
  /** Absolute angular direction of the retained path (arcs): +1 counter-clockwise. */
  readonly sgn: 1 | -1;
  /** True when the meeting point lies inside the curve, so a piece beyond it would be left over. */
  readonly interior: boolean;
}

function endpointOf(entity: Cuttable, end: "start" | "end"): Vec2 {
  return end === "start" ? entity.start : entity.end;
}

/** Decides which end of a curve is cut back at `at` (which side survives), by the pick when the curve crosses the point. */
function planCut(entity: Cuttable, at: Vec2, pick: Vec2 | undefined): Cut | string {
  if (entity.kind === "line") {
    const d: Vec2 = [entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]];
    const length = Math.hypot(d[0], d[1]);
    if (length < MIN_PIECE_MM) return "A line has no length.";
    const t = ((at[0] - entity.start[0]) * d[0] + (at[1] - entity.start[1]) * d[1]) / (length * length);
    const toStart = dist(at, entity.start);
    const toEnd = dist(at, entity.end);
    let keepEnd: "start" | "end";
    let interior = false;
    if (toStart <= JOIN_MM) keepEnd = "end";
    else if (toEnd <= JOIN_MM) keepEnd = "start";
    else if (t < 0) keepEnd = "end";
    else if (t > 1) keepEnd = "start";
    else {
      interior = true;
      if (pick !== undefined) keepEnd = ((pick[0] - at[0]) * d[0] + (pick[1] - at[1]) * d[1]) > 0 ? "end" : "start";
      else keepEnd = toEnd > toStart ? "end" : "start";
    }
    const keepPoint = endpointOf(entity, keepEnd);
    const retained = dist(at, keepPoint);
    return { entity, travel: undefined, at, cutEnd: keepEnd === "end" ? "start" : "end", keepEnd, keepPoint, retained, tangent: unit([keepPoint[0] - at[0], keepPoint[1] - at[1]]), sgn: 1, interior };
  }
  const travel = arcTravel(entity);
  if (travel === undefined) return "An arc is degenerate.";
  const { center, radius, dir, startAngle, endAngle, sweep } = travel;
  const angleAt = Math.atan2(at[1] - center[1], at[0] - center[0]);
  const offset = wrap(dir * (angleAt - startAngle));
  const eps = JOIN_MM / radius;
  let keepEnd: "start" | "end";
  let interior = false;
  if (offset <= eps || offset >= TWO_PI - eps) keepEnd = "end";
  else if (Math.abs(offset - sweep) <= eps) keepEnd = "start";
  else if (offset < sweep) {
    interior = true;
    if (pick !== undefined) keepEnd = wrap(dir * (Math.atan2(pick[1] - center[1], pick[0] - center[0]) - angleAt)) < Math.PI ? "end" : "start";
    else keepEnd = sweep - offset > offset ? "end" : "start";
  } else keepEnd = offset - sweep < TWO_PI - offset ? "start" : "end";
  const sgn: 1 | -1 = keepEnd === "end" ? dir : (dir === 1 ? -1 : 1);
  const keepPoint = endpointOf(entity, keepEnd);
  const keepAngle = keepEnd === "end" ? endAngle : startAngle;
  const extent = wrap(sgn * (keepAngle - angleAt));
  const radial: Vec2 = [-Math.sin(angleAt), Math.cos(angleAt)];
  return { entity, travel, at, cutEnd: keepEnd === "end" ? "start" : "end", keepEnd, keepPoint, retained: radius * extent, tangent: [radial[0] * sgn, radial[1] * sgn], sgn, interior };
}

/** The point at path length `s` from the meeting point along the retained path. */
function pointAlong(cut: Cut, s: number): Vec2 {
  if (cut.travel === undefined) return [cut.at[0] + cut.tangent[0] * s, cut.at[1] + cut.tangent[1] * s];
  const { center, radius } = cut.travel;
  const angle = Math.atan2(cut.at[1] - center[1], cut.at[0] - center[0]) + (cut.sgn * s) / radius;
  return [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
}

/** The curve with its cut end moved to `point`. */
function cutBackTo(cut: Cut, point: Vec2): Cuttable {
  const entity = cut.entity;
  if (entity.kind === "line") return cut.cutEnd === "start" ? { ...entity, start: point } : { ...entity, end: point };
  const { center, radius, dir, startAngle, endAngle } = cut.travel!;
  const angleOf = Math.atan2(point[1] - center[1], point[0] - center[0]);
  if (cut.cutEnd === "end") return arcOn(entity, entity.id, center, radius, startAngle, dir, wrap(dir * (angleOf - startAngle)));
  return arcOn(entity, entity.id, center, radius, angleOf, dir, wrap(dir * (endAngle - angleOf)));
}

/** The piece between the meeting point and the cut end, as a copy of the curve with a fresh ID (the part a crossing leaves behind). */
function stubOf(cut: Cut, id: string): Cuttable {
  const entity = cut.entity;
  if (entity.kind === "line") return cut.cutEnd === "start" ? { ...entity, id, end: cut.at } : { ...entity, id, start: cut.at };
  const { center, radius, dir, startAngle, endAngle } = cut.travel!;
  const angleOf = Math.atan2(cut.at[1] - center[1], cut.at[0] - center[0]);
  if (cut.cutEnd === "end") return arcOn(entity, id, center, radius, angleOf, dir, wrap(dir * (endAngle - angleOf)));
  return arcOn(entity, id, center, radius, startAngle, dir, wrap(dir * (angleOf - startAngle)));
}

// ---------------------------------------------------------------------------------------------
// Meeting point
// ---------------------------------------------------------------------------------------------

function lineCircle(origin: Vec2, direction: Vec2, center: Vec2, radius: number): readonly Vec2[] {
  const length = Math.hypot(direction[0], direction[1]);
  const u: Vec2 = [direction[0] / length, direction[1] / length];
  const f: Vec2 = [origin[0] - center[0], origin[1] - center[1]];
  const b = f[0] * u[0] + f[1] * u[1];
  const c = f[0] * f[0] + f[1] * f[1] - radius * radius;
  const discriminant = b * b - c;
  if (discriminant < -1e-9) return [];
  const root = Math.sqrt(Math.max(0, discriminant));
  const ts = root < 1e-9 ? [-b] : [-b - root, -b + root];
  return ts.map((t): Vec2 => [origin[0] + u[0] * t, origin[1] + u[1] * t]);
}

function circleCircle(c1: Vec2, r1: number, c2: Vec2, r2: number): readonly Vec2[] {
  const between = dist(c1, c2);
  if (between < 1e-12 || between > r1 + r2 + 1e-9 || between < Math.abs(r1 - r2) - 1e-9) return [];
  const along = (r1 * r1 - r2 * r2 + between * between) / (2 * between);
  const height = Math.sqrt(Math.max(0, r1 * r1 - along * along));
  const ux = (c2[0] - c1[0]) / between;
  const uy = (c2[1] - c1[1]) / between;
  const base: Vec2 = [c1[0] + ux * along, c1[1] + uy * along];
  return height < 1e-9 ? [base] : [[base[0] - uy * height, base[1] + ux * height], [base[0] + uy * height, base[1] - ux * height]];
}

function lineLine(a: Vec2, ad: Vec2, b: Vec2, bd: Vec2): Vec2 | undefined {
  const denominator = ad[0] * bd[1] - ad[1] * bd[0];
  if (Math.abs(denominator) < 1e-12 * Math.max(1, Math.hypot(ad[0], ad[1]) * Math.hypot(bd[0], bd[1]))) return undefined;
  const t = ((b[0] - a[0]) * bd[1] - (b[1] - a[1]) * bd[0]) / denominator;
  return [a[0] + ad[0] * t, a[1] + ad[1] * t];
}

function carrierIntersections(first: Cuttable, second: Cuttable): readonly Vec2[] {
  const dirOf = (line: Line): Vec2 => [line.end[0] - line.start[0], line.end[1] - line.start[1]];
  if (first.kind === "line" && second.kind === "line") {
    const hit = lineLine(first.start, dirOf(first), second.start, dirOf(second));
    return hit === undefined ? [] : [hit];
  }
  if (first.kind === "line" && second.kind === "arc") {
    const t = arcTravel(second);
    return t === undefined ? [] : lineCircle(first.start, dirOf(first), t.center, t.radius);
  }
  if (first.kind === "arc" && second.kind === "line") {
    const t = arcTravel(first);
    return t === undefined ? [] : lineCircle(second.start, dirOf(second), t.center, t.radius);
  }
  if (first.kind === "arc" && second.kind === "arc") {
    const a = arcTravel(first);
    const b = arcTravel(second);
    return a === undefined || b === undefined ? [] : circleCircle(a.center, a.radius, b.center, b.radius);
  }
  return [];
}

function endpointsOf(entity: Cuttable): readonly Vec2[] {
  return [entity.start, entity.end];
}

/** Which of the carriers' meeting points is the corner: the one nearest the hint, else the pick, else the nearest pair of ends. */
function chooseMeeting(first: Cuttable, second: Cuttable, near: Vec2 | undefined): Vec2 | undefined {
  const candidates = carrierIntersections(first, second);
  if (candidates.length === 0) return undefined;
  const score = (point: Vec2): number => {
    if (near !== undefined) return dist(point, near);
    const nearestEnd = (entity: Cuttable): number => Math.min(...endpointsOf(entity).map((end) => dist(end, point)));
    return nearestEnd(first) + nearestEnd(second);
  };
  return candidates.reduce((best, candidate) => (score(candidate) < score(best) ? candidate : best));
}

// ---------------------------------------------------------------------------------------------
// Fillet geometry
// ---------------------------------------------------------------------------------------------

interface Locus {
  readonly line?: { readonly origin: Vec2; readonly direction: Vec2 };
  readonly circle?: { readonly center: Vec2; readonly radius: number };
}

function lociOf(cut: Cut, radius: number): readonly Locus[] {
  if (cut.travel === undefined) {
    const normal: Vec2 = [-cut.tangent[1], cut.tangent[0]];
    return [1, -1].map((side): Locus => ({ line: { origin: [cut.at[0] + normal[0] * radius * side, cut.at[1] + normal[1] * radius * side], direction: cut.tangent } }));
  }
  const { center, radius: r } = cut.travel;
  const loci: Locus[] = [{ circle: { center, radius: r + radius } }];
  if (Math.abs(r - radius) > 1e-9) loci.push({ circle: { center, radius: Math.abs(r - radius) } });
  return loci;
}

function intersectLoci(a: Locus, b: Locus): readonly Vec2[] {
  if (a.line !== undefined && b.line !== undefined) {
    const hit = lineLine(a.line.origin, a.line.direction, b.line.origin, b.line.direction);
    return hit === undefined ? [] : [hit];
  }
  if (a.line !== undefined && b.circle !== undefined) return lineCircle(a.line.origin, a.line.direction, b.circle.center, b.circle.radius);
  if (a.circle !== undefined && b.line !== undefined) return lineCircle(b.line.origin, b.line.direction, a.circle.center, a.circle.radius);
  return a.circle !== undefined && b.circle !== undefined ? circleCircle(a.circle.center, a.circle.radius, b.circle.center, b.circle.radius) : [];
}

/** Where the fillet circle touches the curve, and how far along the retained path that is; undefined when it touches nowhere sensible. */
function tangentPoint(cut: Cut, center: Vec2, radius: number): { readonly point: Vec2; readonly along: number } | undefined {
  if (cut.travel === undefined) {
    const along = (center[0] - cut.at[0]) * cut.tangent[0] + (center[1] - cut.at[1]) * cut.tangent[1];
    return { point: [cut.at[0] + cut.tangent[0] * along, cut.at[1] + cut.tangent[1] * along], along };
  }
  const { center: c, radius: r } = cut.travel;
  const between = dist(center, c);
  if (between < 1e-12) return undefined;
  // The fillet circle touches from outside, from inside, or (when it is the larger one) around the curve's circle.
  const s = radius > r && Math.abs(between - (radius - r)) < 1e-6 && Math.abs(between - (r + radius)) > 1e-6 ? -1 : 1;
  const direction = unit([(center[0] - c[0]) * s, (center[1] - c[1]) * s]);
  const point: Vec2 = [c[0] + direction[0] * r, c[1] + direction[1] * r];
  const angle = Math.atan2(point[1] - c[1], point[0] - c[0]);
  const from = Math.atan2(cut.at[1] - c[1], cut.at[0] - c[0]);
  return { point, along: r * wrap(cut.sgn * (angle - from)) };
}

interface FilletSolution {
  readonly first: Vec2;
  readonly second: Vec2;
  readonly center: Vec2;
  readonly mid: Vec2;
}

function solveFillet(a: Cut, b: Cut, radius: number): FilletSolution | string {
  let tooLarge = false;
  let best: { readonly first: Vec2; readonly second: Vec2; readonly center: Vec2; readonly score: number } | undefined;
  for (const la of lociOf(a, radius)) {
    for (const lb of lociOf(b, radius)) {
      for (const center of intersectLoci(la, lb)) {
        const ta = tangentPoint(a, center, radius);
        const tb = tangentPoint(b, center, radius);
        if (ta === undefined || tb === undefined) continue;
        if (ta.along <= 1e-9 || tb.along <= 1e-9) continue;
        if (ta.along > a.retained - MIN_PIECE_MM || tb.along > b.retained - MIN_PIECE_MM) { tooLarge = true; continue; }
        const score = dist(center, a.at);
        if (best === undefined || score < best.score) best = { first: ta.point, second: tb.point, center, score };
      }
    }
  }
  if (best === undefined) return tooLarge ? "The fillet radius is too large for these curves." : "No fillet of this radius fits between these curves.";
  const v1: Vec2 = [best.first[0] - best.center[0], best.first[1] - best.center[1]];
  const v2: Vec2 = [best.second[0] - best.center[0], best.second[1] - best.center[1]];
  const sum: Vec2 = [v1[0] + v2[0], v1[1] + v2[1]];
  if (Math.hypot(sum[0], sum[1]) < 1e-9 * radius) return "The fillet would be a half circle; use a different radius.";
  const direction = unit(sum);
  return { first: best.first, second: best.second, center: best.center, mid: [best.center[0] + direction[0] * radius, best.center[1] + direction[1] * radius] };
}

// ---------------------------------------------------------------------------------------------
// One corner between two curves
// ---------------------------------------------------------------------------------------------

export type CornerSpec =
  | { readonly kind: "corner" }
  | { readonly kind: "fillet"; readonly radiusMm: number; readonly dimension: boolean; readonly equalTo?: string }
  | { readonly kind: "chamfer"; readonly firstMm: number; readonly secondMm: number; readonly equalTo?: string }
  | { readonly kind: "chamfer-angle"; readonly distanceMm: number; readonly angleDeg: number; readonly equalTo?: string };

/** Where the user picked: one point per curve (AutoCAD style), or one point for the quadrant (it serves both curves). */
export interface CornerPicks {
  readonly first?: Vec2;
  readonly second?: Vec2;
  readonly quadrant?: Vec2;
}

export interface CornerOptions {
  readonly picks?: CornerPicks;
  /** The vertex being rounded, when it is known (it chooses between two meeting points). */
  readonly near?: Vec2;
  /** Fillet only: add a driving radius dimension to the new arc (default true). */
  readonly dimension?: boolean;
}

function inheritFlags(a: SketchEntity, b: SketchEntity): { readonly construction: boolean; readonly visible?: boolean } {
  return { construction: a.construction && b.construction, ...(a.visible === false && b.visible === false ? { visible: false } : {}) };
}

interface CornerWork {
  readonly plan: SketchEditPlan;
  /** The new arc or chamfer line, if any. */
  readonly madeId: string | undefined;
}

/** The raw plan for one corner (not yet settled against the sketch's relations), or the reason it cannot be made. */
function planCorner(context: SketchEditContext, firstId: string, secondId: string, spec: CornerSpec, options: CornerOptions): CornerWork | string {
  const sketch = context.sketch;
  const first = find(sketch, firstId);
  const second = find(sketch, secondId);
  if (!isCuttable(first) || !isCuttable(second) || first.id === second.id) return "Select two lines or arcs that meet at a corner.";
  const picks = options.picks;
  const near = options.near ?? (picks?.quadrant ?? (picks?.first !== undefined && picks.second !== undefined ? ([(picks.first[0] + picks.second[0]) / 2, (picks.first[1] + picks.second[1]) / 2] as Vec2) : undefined));
  const meeting = chooseMeeting(first, second, near);
  if (meeting === undefined) return first.kind === "line" && second.kind === "line" ? (spec.kind === "corner" ? "The two lines are parallel, so they never meet." : "The two lines are parallel, so they have no corner.") : "These curves never meet, so there is no corner.";
  const cutA = planCut(first, meeting, picks?.first ?? picks?.quadrant);
  const cutB = planCut(second, meeting, picks?.second ?? picks?.quadrant);
  if (typeof cutA === "string") return cutA;
  if (typeof cutB === "string") return cutB;
  if (cutA.retained < MIN_PIECE_MM || cutB.retained < MIN_PIECE_MM) return "A curve has no length beyond the corner.";
  const cosine = Math.max(-1, Math.min(1, cutA.tangent[0] * cutB.tangent[0] + cutA.tangent[1] * cutB.tangent[1]));
  const angle = Math.acos(cosine);
  if (spec.kind !== "corner" && angle < 0.01) return "The curves run side by side at the corner, so it cannot be rounded or cut.";
  if (spec.kind !== "corner" && angle > Math.PI - 0.01) return "The curves are already tangent at the corner, so there is nothing to round.";

  const arcFlags = inheritFlags(first, second);
  const additions: SketchEntity[] = [];
  const constraints: WorkbenchSketchConstraint[] = [];
  let firstEdge: Vec2;
  let secondEdge: Vec2;
  let madeId: string | undefined;
  let label: string;
  if (spec.kind === "corner") {
    firstEdge = meeting;
    secondEdge = meeting;
    label = "Corner";
  } else if (spec.kind === "fillet") {
    const solution = solveFillet(cutA, cutB, spec.radiusMm);
    if (typeof solution === "string") return solution;
    firstEdge = solution.first;
    secondEdge = solution.second;
    madeId = context.newId("entity");
    additions.push({ id: madeId, kind: "arc", start: solution.first, mid: solution.mid, end: solution.second, ...arcFlags });
    constraints.push(
      jointRelation(context, first.id, cutA.cutEnd, madeId, "start"),
      jointRelation(context, madeId, "end", second.id, cutB.cutEnd),
      pairRelation(context, "tangent", first.id, madeId),
      pairRelation(context, "tangent", madeId, second.id)
    );
    if (spec.equalTo !== undefined) constraints.push(pairRelation(context, "equal", madeId, spec.equalTo));
    else if (spec.dimension) constraints.push(radiusDimensionRelation(context, madeId, spec.radiusMm));
    label = `Fillet R${fmt(spec.radiusMm)}`;
  } else {
    let d1: number;
    let d2: number;
    if (spec.kind === "chamfer") {
      d1 = spec.firstMm;
      d2 = spec.secondMm;
      label = spec.firstMm === spec.secondMm ? `Chamfer ${fmt(spec.firstMm)} mm` : `Chamfer ${fmt(spec.firstMm)} × ${fmt(spec.secondMm)} mm`;
    } else {
      if (cutA.travel !== undefined || cutB.travel !== undefined) return "A distance-and-angle chamfer applies to two lines.";
      const theta = (spec.angleDeg * Math.PI) / 180;
      const limit = Math.PI - angle;
      if (theta >= limit - (0.5 * Math.PI) / 180) {
        return `The chamfer angle must be smaller than ${fmt(180 - (angle * 180) / Math.PI)}° for this ${fmt((angle * 180) / Math.PI)}° corner; at that angle or more the cut never meets the second line.`;
      }
      d1 = spec.distanceMm;
      d2 = (spec.distanceMm * Math.sin(theta)) / Math.sin(theta + angle);
      if (d2 < MIN_PIECE_MM) return "The chamfer collapses the corner; try a larger angle.";
      label = `Chamfer ${fmt(spec.distanceMm)} mm @ ${fmt(spec.angleDeg)}°`;
    }
    if (d1 > cutA.retained - MIN_PIECE_MM) return spec.kind === "chamfer" && spec.firstMm !== spec.secondMm ? "The first chamfer distance is too large for the first line." : "The chamfer distance is too large for these lines.";
    if (d2 > cutB.retained - MIN_PIECE_MM) return spec.kind === "chamfer" && spec.firstMm !== spec.secondMm ? "The second chamfer distance is too large for the second line." : spec.kind === "chamfer-angle" ? "The chamfer reaches past the second line's far end." : "The chamfer distance is too large for these lines.";
    firstEdge = pointAlong(cutA, d1);
    secondEdge = pointAlong(cutB, d2);
    if (dist(firstEdge, secondEdge) < MIN_PIECE_MM) return "The chamfer would be shorter than 0.01 mm.";
    madeId = context.newId("entity");
    additions.push({ id: madeId, kind: "line", start: firstEdge, end: secondEdge, ...arcFlags });
    constraints.push(jointRelation(context, first.id, cutA.cutEnd, madeId, "start"), jointRelation(context, madeId, "end", second.id, cutB.cutEnd));
    if (spec.equalTo !== undefined) constraints.push(pairRelation(context, "equal", madeId, spec.equalTo));
  }

  const updates: SketchEntity[] = [];
  const removals: string[] = [];
  let leftOver = 0;
  const handle = (cut: Cut, edge: Vec2): void => {
    const cutOne = cutBackTo(cut, edge);
    updates.push(cutOne);
    if (cut.interior && spec.kind !== "corner") {
      // The curve crossed the corner: keep the part beyond it as its own curve instead of silently deleting it.
      const stubId = context.newId("entity");
      additions.push(stubOf(cut, stubId));
      constraints.push(...carriedRelations(context, sketch, cut.entity.id, stubId));
      for (const constraint of sketch.constraints) {
        const index = constraint.entityIds.indexOf(cut.entity.id);
        if (index < 0 || constraint.suppressed === true || (constraint.kind !== "coincident" && constraint.kind !== "midpoint") || constraint.points?.[index] !== cut.cutEnd) continue;
        constraints.push({ ...constraint, id: context.newId("constraint"), entityIds: constraint.entityIds.map((id) => (id === cut.entity.id ? stubId : id)) });
      }
      leftOver += 1;
    }
  };
  handle(cutA, firstEdge);
  handle(cutB, secondEdge);
  if (spec.kind === "corner") {
    const already = sketch.constraints.some((constraint) => constraint.kind === "coincident" && constraint.suppressed !== true && constraint.entityIds.includes(first.id) && constraint.entityIds.includes(second.id));
    if (!already) constraints.push(jointRelation(context, first.id, cutA.cutEnd, second.id, cutB.cutEnd));
    const unchanged = updates.every((entity, index) => JSON.stringify(entity) === JSON.stringify(index === 0 ? first : second));
    if (unchanged) return "The two curves already meet at that corner.";
  }
  const note = leftOver > 0 ? `; ${leftOver} crossing piece${leftOver === 1 ? "" : "s"} kept` : "";
  return { plan: { label: `${label}${note}`, removeEntityIds: removals, updateEntities: updates, addEntities: additions, addConstraints: constraints }, madeId };
}

/** One corner between two curves, settled against the sketch's relations. */
export function cornerBetween(context: SketchEditContext, firstId: string, secondId: string, spec: CornerSpec, options: CornerOptions = {}): SketchEditResult {
  const work = planCorner(context, firstId, secondId, spec, options);
  if (typeof work === "string") return reject(work, [firstId, secondId], spec.kind === "fillet" ? "Use a smaller radius or lengthen the curves." : "Adjust the distance or lengthen the curves.");
  return finishPlan(context, work.plan);
}

// ---------------------------------------------------------------------------------------------
// Rectangles
// ---------------------------------------------------------------------------------------------

/** Replaces a rectangle by four joined lines that keep its width and height dimensions and its squareness. */
export function explodeRectangle(context: SketchEditContext, rectangle: Rectangle): { readonly plan: SketchEditPlan; readonly lineIds: readonly string[] } {
  const corners = entityPoints(rectangle);
  const lineIds = corners.map(() => context.newId("entity"));
  const lines: SketchEntity[] = corners.map((corner, index): SketchEntity => ({
    id: lineIds[index]!,
    kind: "line",
    start: corner,
    end: corners[(index + 1) % corners.length]!,
    construction: rectangle.construction,
    ...(rectangle.visible === undefined ? {} : { visible: rectangle.visible })
  }));
  const constraints: WorkbenchSketchConstraint[] = lineIds.map((id, index) => jointRelation(context, id, "end", lineIds[(index + 1) % lineIds.length]!, "start"));
  const radians = (rectangle.rotationDeg * Math.PI) / 180;
  const horizontal = Math.abs(Math.sin(radians)) < 1e-9;
  const vertical = Math.abs(Math.cos(radians)) < 1e-9;
  if (horizontal || vertical) {
    lineIds.forEach((id, index) => constraints.push({ id: context.newId("constraint"), kind: (index % 2 === 0) === horizontal ? "horizontal" : "vertical", entityIds: [id] }));
  } else {
    for (let index = 0; index < 3; index += 1) constraints.push(pairRelation(context, "perpendicular", lineIds[index]!, lineIds[index + 1]!));
  }
  for (const constraint of context.sketch.constraints) {
    if (constraint.kind !== "distance" || constraint.driven === true || constraint.suppressed === true || constraint.valueMm === undefined || constraint.entityIds[0] !== rectangle.id) continue;
    const target = constraint.dimension === "height" ? lineIds[1]! : lineIds[0]!;
    constraints.push({ id: context.newId("constraint"), kind: "distance", entityIds: [target], valueMm: constraint.valueMm, dimension: "length" });
  }
  return { plan: { label: "Explode rectangle", removeEntityIds: [rectangle.id], updateEntities: [], addEntities: lines, addConstraints: constraints }, lineIds };
}

// ---------------------------------------------------------------------------------------------
// Chains and rectangles: every corner at once
// ---------------------------------------------------------------------------------------------

interface Vertex {
  readonly point: Vec2;
  readonly ends: readonly { readonly id: string; readonly end: "start" | "end" }[];
}

/** The points where selected lines and arcs meet end to end. */
export function chainVertices(sketch: WorkbenchSketch, ids: readonly string[], toleranceMm = JOIN_MM): readonly Vertex[] {
  const vertices: { point: Vec2; ends: { id: string; end: "start" | "end" }[] }[] = [];
  for (const id of ids) {
    const entity = find(sketch, id);
    if (!isCuttable(entity)) continue;
    for (const end of ["start", "end"] as const) {
      const point = endpointOf(entity, end);
      const existing = vertices.find((vertex) => dist(vertex.point, point) <= toleranceMm);
      if (existing === undefined) vertices.push({ point, ends: [{ id, end }] });
      else existing.ends.push({ id, end });
    }
  }
  return vertices;
}

function joinTolerance(sketch: WorkbenchSketch): number {
  return Math.max(JOIN_MM, Math.min(sketch.snapToleranceMm, 0.05));
}

function roundChain(context: SketchEditContext, ids: readonly string[], spec: CornerSpec, options: CornerOptions, what: string): SketchEditResult {
  const curves = ids.map((id) => find(context.sketch, id));
  if (curves.some((entity) => !isCuttable(entity))) return reject(`${what} applies to lines and arcs; select a chain of lines and arcs, two curves, or one rectangle.`);
  const joints = chainVertices(context.sketch, ids, joinTolerance(context.sketch)).filter((vertex) => vertex.ends.length === 2 && vertex.ends[0]!.id !== vertex.ends[1]!.id);
  const branches = chainVertices(context.sketch, ids, joinTolerance(context.sketch)).filter((vertex) => vertex.ends.length > 2).length;
  if (joints.length === 0) return reject("The selected curves do not meet end to end, so there is no corner to work on.", [...ids]);
  let work: WorkbenchSketch = context.sketch;
  let firstMade: string | undefined;
  let done = 0;
  let skipped = 0;
  for (const joint of joints) {
    const [one, two] = joint.ends;
    const stepContext: SketchEditContext = { sketch: work, newId: context.newId };
    const equalTo = firstMade;
    const stepSpec: CornerSpec = spec.kind === "fillet" ? { ...spec, ...(equalTo === undefined ? {} : { equalTo }) } : spec.kind === "chamfer" ? { ...spec, ...(equalTo === undefined ? {} : { equalTo }) } : spec;
    const step = planCorner(stepContext, one!.id, two!.id, stepSpec, { near: joint.point });
    if (typeof step === "string") {
      // A corner that is already smooth (or straight) is left alone; anything else stops the whole edit with its place named.
      if (/already tangent|side by side/u.test(step)) { skipped += 1; continue; }
      return reject(`Corner at (${fmt(joint.point[0])}, ${fmt(joint.point[1])}): ${step}`, [one!.id, two!.id], "Use a smaller value or lengthen the curves.");
    }
    const finished = finishPlan(stepContext, step.plan);
    if (!finished.ok) return finished;
    const next = sketchAfter(work, finished.value);
    if (typeof next === "string") return reject(next);
    work = next;
    firstMade ??= step.madeId;
    done += 1;
  }
  if (done === 0) return reject("Every corner of the selection is already smooth or straight.", [...ids]);
  const label = spec.kind === "fillet" ? `Fillet R${fmt(spec.radiusMm)} on ${done} corner${done === 1 ? "" : "s"}` : `${what} on ${done} corner${done === 1 ? "" : "s"}`;
  const plan = diffPlan(context.sketch, work, `${label}${skipped > 0 ? ` (${skipped} smooth skipped)` : ""}${branches > 0 ? `, ${branches} branch point${branches === 1 ? "" : "s"} left` : ""}`);
  return finishPlan(context, plan);
}

function roundRectangleCorners(context: SketchEditContext, rectangle: Rectangle, spec: CornerSpec, what: string): SketchEditResult {
  const size = spec.kind === "fillet" ? spec.radiusMm : spec.kind === "chamfer" ? Math.max(spec.firstMm, spec.secondMm) : 0;
  if (size >= Math.min(rectangle.widthMm, rectangle.heightMm) / 2 - 1e-6) return reject(`The ${spec.kind === "fillet" ? "fillet radius" : "chamfer distance"} is too large for this rectangle (at most half of its shorter side).`, [rectangle.id]);
  const exploded = explodeRectangle(context, rectangle);
  const working = sketchAfter(context.sketch, exploded.plan);
  if (typeof working === "string") return reject(working);
  const result = roundChain({ sketch: working, newId: context.newId }, exploded.lineIds, spec, {}, what);
  if (!result.ok) return result;
  // The result is relative to the exploded sketch; express it against the real one.
  const after = sketchAfter(working, result.value);
  if (typeof after === "string") return reject(after);
  const label = `${spec.kind === "fillet" ? "Fillet" : "Chamfer"} all corners of the rectangle (now ${after.entities.length - context.sketch.entities.length + 1} lines and arcs)`;
  return finishPlan(context, diffPlan(context.sketch, after, label));
}

// ---------------------------------------------------------------------------------------------
// The public tools
// ---------------------------------------------------------------------------------------------

function pickRectangle(context: SketchEditContext, ids: readonly string[]): Rectangle | undefined {
  if (ids.length !== 1) return undefined;
  const entity = find(context.sketch, ids[0]!);
  return entity?.kind === "rectangle" ? entity : undefined;
}

function pairOf(context: SketchEditContext, ids: readonly string[]): readonly [string, string] | string {
  const curves = ids.map((id) => find(context.sketch, id));
  if (curves.length !== 2 || curves.some((entity) => !isCuttable(entity))) return "Select two lines or arcs that meet at a corner, a chain of curves, or one rectangle.";
  return [ids[0]!, ids[1]!];
}

export interface CornerToolOptions extends CornerOptions {}

function run(context: SketchEditContext, ids: readonly string[], spec: CornerSpec, options: CornerToolOptions, what: string): SketchEditResult {
  const rectangle = pickRectangle(context, ids);
  if (rectangle !== undefined) {
    if (spec.kind === "corner") return reject("A rectangle's corners already meet. Use Fillet or Chamfer on it, or Split it first to trim part of a side.", [rectangle.id]);
    if (spec.kind === "chamfer-angle") return reject("A distance-and-angle chamfer applies to two lines; explode the rectangle with Split first.", [rectangle.id]);
    return roundRectangleCorners(context, rectangle, spec, what);
  }
  if (ids.length >= 3) {
    if (spec.kind === "corner") return reject("Corner works on two curves at a time.");
    return roundChain(context, ids, spec, options, what);
  }
  const pair = pairOf(context, ids);
  if (typeof pair === "string") return reject(pair);
  return cornerBetween(context, pair[0], pair[1], spec, options);
}

/** Extends or trims two curves so they meet exactly, keeping the picked side of curves that cross. */
export function cornerLines(context: SketchEditContext, ids: readonly string[], options: CornerToolOptions = {}): SketchEditResult {
  return run(context, ids, { kind: "corner" }, options, "Corner");
}

/** Rounds the corner between two curves, every corner of a chain, or all four corners of a rectangle, with a tangent arc. */
export function filletCorners(context: SketchEditContext, ids: readonly string[], radiusMm: number, options: CornerToolOptions = {}): SketchEditResult {
  if (!Number.isFinite(radiusMm) || radiusMm < 0.01 || radiusMm > 5000) return reject("Enter a fillet radius between 0.01 mm and 5000 mm.");
  return run(context, ids, { kind: "fillet", radiusMm, dimension: options.dimension !== false }, options, "Fillet");
}

/** Cuts the corner between two curves, every corner of a chain, or all four corners of a rectangle, with a straight chamfer. */
export function chamferCorners(context: SketchEditContext, ids: readonly string[], distanceMm: number, options: CornerToolOptions = {}): SketchEditResult {
  if (!Number.isFinite(distanceMm) || distanceMm < 0.01 || distanceMm > 5000) return reject("Enter a chamfer distance between 0.01 mm and 5000 mm.");
  return run(context, ids, { kind: "chamfer", firstMm: distanceMm, secondMm: distanceMm }, options, "Chamfer");
}

/** A different cut distance on each of the two selected curves, measured from the corner along each. */
export function chamferCornersAsymmetric(context: SketchEditContext, ids: readonly string[], firstDistanceMm: number, secondDistanceMm: number, options: CornerToolOptions = {}): SketchEditResult {
  if (!Number.isFinite(firstDistanceMm) || firstDistanceMm < 0.01 || firstDistanceMm > 5000) return reject("Enter a first chamfer distance between 0.01 mm and 5000 mm.");
  if (!Number.isFinite(secondDistanceMm) || secondDistanceMm < 0.01 || secondDistanceMm > 5000) return reject("Enter a second chamfer distance between 0.01 mm and 5000 mm.");
  return run(context, ids, { kind: "chamfer", firstMm: firstDistanceMm, secondMm: secondDistanceMm }, options, "Chamfer");
}

/**
 * Distance-and-angle chamfer: cut a distance along the first line, then run the cut off at `angleDeg` from the first line into the
 * corner. The angle must be smaller than 180 degrees minus the corner angle, or the cut never meets the second line.
 */
export function chamferCornersAngle(context: SketchEditContext, ids: readonly string[], distanceMm: number, angleDeg: number, options: CornerToolOptions = {}): SketchEditResult {
  if (!Number.isFinite(distanceMm) || distanceMm < 0.01 || distanceMm > 5000) return reject("Enter a chamfer distance between 0.01 mm and 5000 mm.");
  if (!Number.isFinite(angleDeg) || angleDeg <= 0.5 || angleDeg >= 179.5) return reject("Enter an angle between 0.5° and 179.5°.");
  return run(context, ids, { kind: "chamfer-angle", distanceMm, angleDeg }, options, "Chamfer");
}

/** What is at a clicked point: the curves that end there (or the corner of a rectangle). */
export function cornerAtPoint(sketch: WorkbenchSketch, point: Vec2, toleranceMm: number): { readonly vertex: Vec2; readonly ids: readonly string[]; readonly rectangleId?: string } | undefined {
  let best: { readonly vertex: Vec2; readonly gap: number } | undefined;
  const consider = (candidate: Vec2): void => {
    const gap = dist(candidate, point);
    if (gap <= toleranceMm && (best === undefined || gap < best.gap)) best = { vertex: candidate, gap };
  };
  for (const entity of sketch.entities) {
    if (entity.visible === false) continue;
    if (entity.kind === "line" || entity.kind === "arc") { consider(entity.start); consider(entity.end); }
    else if (entity.kind === "rectangle") entityPoints(entity).forEach(consider);
  }
  if (best === undefined) return undefined;
  const vertex = (best as { readonly vertex: Vec2 }).vertex;
  const tolerance = joinTolerance(sketch);
  const ids = sketch.entities.filter((entity) => entity.visible !== false && (entity.kind === "line" || entity.kind === "arc") && (dist(entity.start, vertex) <= tolerance || dist(entity.end, vertex) <= tolerance)).map((entity) => entity.id);
  const rectangle = sketch.entities.find((entity): entity is Rectangle => entity.kind === "rectangle" && entity.visible !== false && entityPoints(entity).some((corner) => dist(corner, vertex) <= tolerance));
  return rectangle === undefined ? { vertex, ids } : { vertex, ids, rectangleId: rectangle.id };
}

/**
 * Fillet or chamfer by clicking a vertex: the two curves that meet at the clicked point are rounded or cut. On a rectangle only the
 * clicked corner changes (the rectangle becomes four joined lines first).
 */
export function cornerByClick(context: SketchEditContext, point: Vec2, toleranceMm: number, spec: CornerSpec): SketchEditResult {
  const found = cornerAtPoint(context.sketch, point, toleranceMm);
  if (found === undefined) return reject("Click on a vertex where two curves meet.");
  let working = context.sketch;
  let ids = found.ids;
  if (found.rectangleId !== undefined) {
    const rectangle = find(context.sketch, found.rectangleId) as Rectangle;
    const exploded = explodeRectangle(context, rectangle);
    const next = sketchAfter(context.sketch, exploded.plan);
    if (typeof next === "string") return reject(next);
    working = next;
    const corners = entityPoints(rectangle);
    const index = corners.findIndex((corner) => dist(corner, found.vertex) <= joinTolerance(context.sketch));
    const incoming = exploded.lineIds[(index + exploded.lineIds.length - 1) % exploded.lineIds.length]!;
    ids = [...ids, incoming, exploded.lineIds[index]!].filter((id) => id !== found.rectangleId);
  }
  if (ids.length !== 2) return reject(ids.length < 2 ? "Only one curve ends at that vertex, so there is no corner to round." : "More than two curves meet at that vertex; select the two to round.");
  const stepContext: SketchEditContext = { sketch: working, newId: context.newId };
  const step = planCorner(stepContext, ids[0]!, ids[1]!, spec, { near: found.vertex });
  if (typeof step === "string") return reject(step, ids, "Use a smaller value or lengthen the curves.");
  const staged = finishPlan(stepContext, step.plan);
  if (!staged.ok) return staged;
  const after = sketchAfter(working, staged.value);
  if (typeof after === "string") return reject(after);
  return finishPlan(context, diffPlan(context.sketch, after, staged.value.label));
}
