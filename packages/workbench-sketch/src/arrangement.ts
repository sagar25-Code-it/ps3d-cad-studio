import type { SketchEntity, Vec2 } from "../../workbench-core/src/index.js";
import { chordErrorBoundMm, ENVELOPE_LIMITS } from "../../workbench-core/src/index.js";
import { arcCircle, arcStepCount, CHORD_TOLERANCE_MM, flattenSpline, isClosedFitSpline } from "./curve-sampling.js";

/**
 * A planar arrangement of sketch curves.
 *
 * Every visible, non-construction curve (lines, arcs, circles, ellipses, splines and rectangle sides) is split at every
 * mutual intersection, T-junction and overlap; end points that lie within the gap tolerance of each other are merged into one
 * vertex; dangling curves and bridges are set aside; and the faces of the resulting planar graph are walked. Every enclosed
 * region is a face: an outer cycle plus the cycles of any islands that sit inside it as holes.
 */

/** Gaps between curve ends up to this size close by themselves. The sketch snap reach (0.75 mm) is for the pointer, not for joining geometry. */
export const PROFILE_GAP_TOLERANCE_MM = 0.01;

const TWO_PI = Math.PI * 2;
const MAX_POLY_STEPS = 1440;

type Box = readonly [number, number, number, number];

interface CurveBase {
  readonly index: number;
  readonly entityId: string;
  /** Rectangle side 0..3, or -1 for a curve that is a whole entity. */
  readonly side: number;
  readonly closed: boolean;
  readonly bbox: Box;
  readonly length: number;
}
interface LineCurve extends CurveBase { readonly kind: "line"; readonly a: Vec2; readonly b: Vec2 }
interface RoundCurve extends CurveBase {
  readonly kind: "arc" | "circle";
  readonly c: Vec2;
  readonly r: number;
  readonly a0: number;
  readonly sweep: number;
  readonly startPt: Vec2;
  readonly endPt: Vec2;
}
interface EllipseCurve extends CurveBase {
  readonly kind: "ellipse";
  readonly c: Vec2;
  readonly a: number;
  readonly b: number;
  readonly cos: number;
  readonly sin: number;
  readonly poly: Poly;
}
interface SplineCurve extends CurveBase { readonly kind: "spline"; readonly fit: readonly Vec2[]; readonly poly: Poly }
type Curve = LineCurve | RoundCurve | EllipseCurve | SplineCurve;

interface Poly {
  readonly pts: readonly Vec2[];
  readonly ts: readonly number[];
}

export interface ArrangementOwner {
  readonly entityId: string;
  /** Piece key: the entity id alone for an unsplit curve, `id#k/n` for the k-th of n pieces, `id/sN` for rectangle side N. */
  readonly key: string;
  readonly side: number;
  readonly whole: boolean;
}

export interface ArrangementEdge {
  readonly index: number;
  readonly u: number;
  readonly v: number;
  /** Points from vertex u to vertex v, end points exactly the vertex positions. */
  readonly points: readonly Vec2[];
  /** Twice the signed area integral of this edge (about the arrangement origin), exact for arcs and ellipses. */
  readonly area2: number;
  readonly lengthMm: number;
  readonly curveKind: "line" | "arc" | "circle" | "ellipse" | "spline";
  readonly owners: readonly ArrangementOwner[];
  readonly whole: boolean;
  /**
   * The exact direction (radians) the edge leaves vertex u and vertex v in, for a line and a circular arc. The order of the edges around a
   * vertex is decided by these when they differ: two curves that cross at a few degrees run alongside each other for a millimetre, and a
   * direction measured that far along can come out the wrong way round.
   */
  readonly departU?: number;
  readonly departV?: number;
  status: "face" | "dangling" | "bridge";
}

export interface CycleStep {
  readonly edge: ArrangementEdge;
  readonly forward: boolean;
}

export interface ArrangementCycle {
  readonly steps: readonly CycleStep[];
  /** Twice the signed area: positive for a counter-clockwise (outer) cycle. */
  readonly area2: number;
  /** The closed polygon (the last point is not repeated). */
  readonly points: readonly Vec2[];
  readonly component: number;
}

export interface ArrangementFace {
  readonly outer: ArrangementCycle;
  /** Island boundaries, clockwise as traced. */
  readonly holes: readonly ArrangementCycle[];
  /** The exact net area. */
  readonly areaMm2: number;
  readonly component: number;
}

export interface ArrangementVertex {
  readonly point: Vec2;
  /** Edges meeting here before any pruning. */
  readonly degree: number;
  readonly entityIds: readonly string[];
}

export interface Arrangement {
  readonly faces: readonly ArrangementFace[];
  readonly edges: readonly ArrangementEdge[];
  readonly vertices: readonly ArrangementVertex[];
  readonly toleranceMm: number;
  /** Interior intersection points (vertices where curves cross or touch without sharing an end). */
  readonly crossings: readonly { readonly point: Vec2; readonly entityIds: readonly string[] }[];
  /** Pairs of entities that run over each other (the shared stretch became one edge). */
  readonly overlaps: readonly { readonly entityIds: readonly [string, string]; readonly at: Vec2 }[];
  /** Curves skipped because they are not finite, have no size, or sit within the gap tolerance of nothing. */
  readonly skipped: readonly { readonly entityId: string; readonly reason: string }[];
  /** Entities whose own curve crosses itself. */
  readonly selfCrossings: readonly { readonly entityId: string; readonly at: Vec2 }[];
  /**
   * Places where several different intersections lay within the gap tolerance of one another (a line a few microns off the point where
   * two circles cross) and were merged into one vertex; `spreadMm` is how far apart they really were.
   */
  readonly snapped?: readonly { readonly point: Vec2; readonly entityIds: readonly string[]; readonly spreadMm: number }[];
}

// ---------------------------------------------------------------------------------------------
// Small geometry helpers
// ---------------------------------------------------------------------------------------------

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
const crossRel = (a: Vec2, b: Vec2, origin: Vec2): number => (a[0] - origin[0]) * (b[1] - origin[1]) - (b[0] - origin[0]) * (a[1] - origin[1]);

function boxOf(points: readonly Vec2[]): Box {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point[0] < minX) minX = point[0];
    if (point[0] > maxX) maxX = point[0];
    if (point[1] < minY) minY = point[1];
    if (point[1] > maxY) maxY = point[1];
  }
  return [minX, minY, maxX, maxY];
}

function boxesTouch(a: Box, b: Box, margin: number): boolean {
  return a[0] <= b[2] + margin && b[0] <= a[2] + margin && a[1] <= b[3] + margin && b[1] <= a[3] + margin;
}

function polylineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += dist(points[index - 1]!, points[index]!);
  return total;
}

function finiteVec(value: Vec2): boolean {
  return Number.isFinite(value[0]) && Number.isFinite(value[1]);
}

// ---------------------------------------------------------------------------------------------
// Curves
// ---------------------------------------------------------------------------------------------

function buildCurves(entities: readonly SketchEntity[], tol: number, chordTol: number | undefined, skipped: { entityId: string; reason: string }[]): Curve[] {
  const curves: Curve[] = [];
  const sorted = [...entities].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const push = (make: (index: number) => Curve | undefined): void => {
    const curve = make(curves.length);
    if (curve !== undefined) curves.push(curve);
  };
  const addLine = (entityId: string, a: Vec2, b: Vec2, side: number): void => {
    if (!finiteVec(a) || !finiteVec(b)) return;
    const length = dist(a, b);
    if (length <= tol) return;
    push((index) => ({ kind: "line", index, entityId, side, closed: false, a, b, bbox: boxOf([a, b]), length }));
  };
  for (const entity of sorted) {
    if (entity.kind === "point") continue;
    if (entity.kind === "line") {
      if (!finiteVec(entity.start) || !finiteVec(entity.end)) { skipped.push({ entityId: entity.id, reason: "has a coordinate that is not a number" }); continue; }
      if (dist(entity.start, entity.end) <= tol) { skipped.push({ entityId: entity.id, reason: "is shorter than the gap tolerance" }); continue; }
      addLine(entity.id, entity.start, entity.end, -1);
      continue;
    }
    if (entity.kind === "rectangle") {
      const { widthMm, heightMm, center, rotationDeg } = entity;
      if (![widthMm, heightMm, rotationDeg].every(Number.isFinite) || !finiteVec(center)) { skipped.push({ entityId: entity.id, reason: "has a size that is not a number" }); continue; }
      if (widthMm <= tol || heightMm <= tol) { skipped.push({ entityId: entity.id, reason: "has a side no longer than the gap tolerance" }); continue; }
      const radians = (rotationDeg * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const hw = widthMm / 2;
      const hh = heightMm / 2;
      const corner = (dx: number, dy: number): Vec2 => [center[0] + dx * cos - dy * sin, center[1] + dx * sin + dy * cos];
      const corners = [corner(-hw, -hh), corner(hw, -hh), corner(hw, hh), corner(-hw, hh)];
      for (let side = 0; side < 4; side += 1) addLine(entity.id, corners[side]!, corners[(side + 1) % 4]!, side);
      continue;
    }
    if (entity.kind === "circle") {
      if (!Number.isFinite(entity.radiusMm) || !finiteVec(entity.center)) { skipped.push({ entityId: entity.id, reason: "has a radius that is not a number" }); continue; }
      if (entity.radiusMm <= tol) { skipped.push({ entityId: entity.id, reason: entity.radiusMm <= 0 ? "has no positive radius" : "has a radius no larger than the gap tolerance" }); continue; }
      const start: Vec2 = [entity.center[0] + entity.radiusMm, entity.center[1]];
      push((index) => ({
        kind: "circle", index, entityId: entity.id, side: -1, closed: true, c: entity.center, r: entity.radiusMm, a0: 0, sweep: TWO_PI, startPt: start, endPt: start,
        bbox: [entity.center[0] - entity.radiusMm, entity.center[1] - entity.radiusMm, entity.center[0] + entity.radiusMm, entity.center[1] + entity.radiusMm], length: TWO_PI * entity.radiusMm
      }));
      continue;
    }
    if (entity.kind === "arc") {
      if (!finiteVec(entity.start) || !finiteVec(entity.mid) || !finiteVec(entity.end)) { skipped.push({ entityId: entity.id, reason: "has a coordinate that is not a number" }); continue; }
      const circle = arcCircle(entity.start, entity.mid, entity.end);
      if (circle === undefined || Math.abs(circle.sweep) < 1e-9 || !Number.isFinite(circle.radiusMm) || circle.radiusMm > 1e9) {
        // Collinear points: a straight chord.
        addLine(entity.id, entity.start, entity.end, -1);
        continue;
      }
      if (circle.radiusMm * Math.abs(circle.sweep) <= tol) { skipped.push({ entityId: entity.id, reason: "is shorter than the gap tolerance" }); continue; }
      const box = roundBox(circle.center, circle.radiusMm, circle.startAngle, circle.sweep, entity.start, entity.end);
      push((index) => ({
        kind: "arc", index, entityId: entity.id, side: -1, closed: false, c: circle.center, r: circle.radiusMm, a0: circle.startAngle, sweep: circle.sweep,
        startPt: entity.start, endPt: entity.end, bbox: box, length: circle.radiusMm * Math.abs(circle.sweep)
      }));
      continue;
    }
    if (entity.kind === "ellipse") {
      if (![entity.majorRadiusMm, entity.minorRadiusMm, entity.rotationDeg].every(Number.isFinite) || !finiteVec(entity.center)) { skipped.push({ entityId: entity.id, reason: "has a radius that is not a number" }); continue; }
      let major = entity.majorRadiusMm;
      let minor = entity.minorRadiusMm;
      let rotation = entity.rotationDeg;
      if (minor > major) { [major, minor] = [minor, major]; rotation += 90; }
      if (minor <= tol) { skipped.push({ entityId: entity.id, reason: "has a radius no larger than the gap tolerance" }); continue; }
      const radians = (rotation * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const steps = Math.min(MAX_POLY_STEPS, Math.max(36, Math.ceil(TWO_PI / Math.sqrt((8 * (chordTol ?? chordErrorBoundMm(Math.sqrt(major * minor), CHORD_TOLERANCE_MM)) * minor * minor) / (major ** 3)))));
      const pts: Vec2[] = [];
      const ts: number[] = [];
      for (let step = 0; step <= steps; step += 1) {
        const phi = step === steps ? 0 : (TWO_PI * step) / steps;
        const lx = major * Math.cos(phi);
        const ly = minor * Math.sin(phi);
        pts.push([entity.center[0] + lx * cos - ly * sin, entity.center[1] + lx * sin + ly * cos]);
        ts.push(step / steps);
      }
      const h = ((major - minor) / (major + minor)) ** 2;
      const length = Math.PI * (major + minor) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)));
      push((index) => ({ kind: "ellipse", index, entityId: entity.id, side: -1, closed: true, c: entity.center, a: major, b: minor, cos, sin, poly: { pts, ts }, bbox: boxOf(pts), length }));
      continue;
    }
    if (entity.kind === "spline") {
      const fit = entity.fitPoints;
      if (fit.length < 2 || !fit.every(finiteVec)) { skipped.push({ entityId: entity.id, reason: "has a fit point that is not a number" }); continue; }
      if (fit.length === 2) { addLine(entity.id, fit[0]!, fit[1]!, -1); continue; }
      const closed = isClosedFitSpline(fit, tol);
      const effective = closed ? [...fit.slice(0, -1), fit[0]!] : fit;
      const flat = flattenSpline(effective, chordTol);
      const length = polylineLength(flat.points);
      if (length <= tol) { skipped.push({ entityId: entity.id, reason: "is shorter than the gap tolerance" }); continue; }
      push((index) => ({ kind: "spline", index, entityId: entity.id, side: -1, closed, fit: effective, poly: { pts: flat.points, ts: flat.params }, bbox: boxOf(flat.points), length }));
    }
  }
  return curves;
}

function roundBox(center: Vec2, radius: number, a0: number, sweep: number, start: Vec2, end: Vec2): Box {
  const points: Vec2[] = [start, end];
  for (let k = 0; k < 4; k += 1) {
    const angle = (k * Math.PI) / 2;
    let d = (angle - a0) * Math.sign(sweep);
    d = ((d % TWO_PI) + TWO_PI) % TWO_PI;
    if (d <= Math.abs(sweep)) points.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
  }
  return boxOf(points);
}

/** The point at parameter `t` (0 to 1) along the curve. Parameter 0 and 1 give the exact end points. */
function curvePoint(curve: Curve, t: number): Vec2 {
  if (curve.kind === "line") return t <= 0 ? curve.a : t >= 1 ? curve.b : [curve.a[0] + (curve.b[0] - curve.a[0]) * t, curve.a[1] + (curve.b[1] - curve.a[1]) * t];
  if (isRound(curve)) {
    if (t <= 0) return curve.startPt;
    if (t >= 1) return curve.endPt;
    const angle = curve.a0 + curve.sweep * t;
    return [curve.c[0] + curve.r * Math.cos(angle), curve.c[1] + curve.r * Math.sin(angle)];
  }
  if (curve.kind === "ellipse") {
    const phi = t <= 0 || t >= 1 ? 0 : TWO_PI * t;
    const lx = curve.a * Math.cos(phi);
    const ly = curve.b * Math.sin(phi);
    return [curve.c[0] + lx * curve.cos - ly * curve.sin, curve.c[1] + lx * curve.sin + ly * curve.cos];
  }
  return polyPointAt(curve.poly, t);
}

function polyPointAt(poly: Poly, t: number): Vec2 {
  const { pts, ts } = poly;
  if (t <= 0) return pts[0]!;
  if (t >= 1) return pts[pts.length - 1]!;
  let low = 0;
  let high = ts.length - 1;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (ts[mid]! <= t) low = mid; else high = mid;
  }
  const t0 = ts[low]!;
  const t1 = ts[high]!;
  const w = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const a = pts[low]!;
  const b = pts[high]!;
  return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
}

/** Sampled points of the curve between two parameters, both ends exact. */
function flattenRange(curve: Curve, t0: number, t1: number, chordTol: number | undefined): Vec2[] {
  if (curve.kind === "line") return [curvePoint(curve, t0), curvePoint(curve, t1)];
  if (isRound(curve)) {
    const portion = Math.abs(curve.sweep) * (t1 - t0);
    const steps = arcStepCount(curve.r, portion, chordTol);
    const points: Vec2[] = [curvePoint(curve, t0)];
    for (let step = 1; step < steps; step += 1) points.push(curvePoint(curve, t0 + ((t1 - t0) * step) / steps));
    points.push(curvePoint(curve, t1));
    return points;
  }
  const { pts, ts } = curve.poly;
  const points: Vec2[] = [curvePoint(curve, t0)];
  for (let index = 0; index < ts.length; index += 1) {
    const t = ts[index]!;
    if (t > t0 + 1e-12 && t < t1 - 1e-12) points.push(pts[index]!);
  }
  points.push(curvePoint(curve, t1));
  return points;
}

/** Twice the exact area integral of a round or elliptical curve between two parameters, about `origin`. */
function exactArea2(curve: RoundCurve | EllipseCurve, t0: number, t1: number, origin: Vec2): number {
  if (isRound(curve)) {
    const th0 = curve.a0 + curve.sweep * t0;
    const th1 = curve.a0 + curve.sweep * t1;
    const cx = curve.c[0] - origin[0];
    const cy = curve.c[1] - origin[1];
    return curve.r * curve.r * (th1 - th0) + cx * curve.r * (Math.sin(th1) - Math.sin(th0)) - cy * curve.r * (Math.cos(th1) - Math.cos(th0));
  }
  const p0 = curvePoint(curve, t0);
  const p1 = curvePoint(curve, t1);
  return curve.a * curve.b * TWO_PI * (t1 - t0) + (curve.c[0] - origin[0]) * (p1[1] - p0[1]) - (curve.c[1] - origin[1]) * (p1[0] - p0[0]);
}

/** Twice the exact area integral of the curve between two parameters minus that of the sampled polygon, about `origin`. */
function curveCorrection2(curve: Curve, t0: number, t1: number, sampled: readonly Vec2[], origin: Vec2): number {
  if (curve.kind === "line" || curve.kind === "spline") return 0;
  let polygon = 0;
  for (let index = 0; index + 1 < sampled.length; index += 1) polygon += crossRel(sampled[index]!, sampled[index + 1]!, origin);
  return exactArea2(curve, t0, t1, origin) - polygon;
}

// ---------------------------------------------------------------------------------------------
// Intersections
// ---------------------------------------------------------------------------------------------

interface SplitEntry {
  t: number;
  p: Vec2;
  /** An end point of the curve (kept in preference to a computed intersection). */
  end: boolean;
  /** The other curve that produced this split, or -1 for an end point. */
  other: number;
}

interface Context {
  readonly tol: number;
  readonly chordTol: number | undefined;
  readonly splits: SplitEntry[][];
  readonly curves: readonly Curve[];
  readonly overlaps: { readonly entityIds: readonly [string, string]; readonly at: Vec2 }[];
  readonly selfCrossings: { readonly entityId: string; readonly at: Vec2 }[];
}

function addSplit(context: Context, curveIndex: number, t: number, p: Vec2, other: number): void {
  context.splits[curveIndex]!.push({ t: Math.min(1, Math.max(0, t)), p, end: false, other });
}

function addPair(context: Context, a: Curve, ta: number, b: Curve, tb: number, p: Vec2): void {
  addSplit(context, a.index, ta, p, b.index);
  addSplit(context, b.index, tb, p, a.index);
}

function isRound(curve: Curve): curve is RoundCurve {
  return curve.kind === "arc" || curve.kind === "circle";
}

/** Where on the arc (0 to 1) an angle falls; undefined when it is off the arc. */
function roundParam(curve: RoundCurve, point: Vec2, angleTol: number): number | undefined {
  const theta = Math.atan2(point[1] - curve.c[1], point[0] - curve.c[0]);
  let d = (theta - curve.a0) * Math.sign(curve.sweep);
  d = ((d % TWO_PI) + TWO_PI) % TWO_PI;
  const span = Math.abs(curve.sweep);
  if (curve.kind === "circle") return d / span;
  if (d <= span + angleTol) return Math.min(1, d / span);
  if (TWO_PI - d <= angleTol) return 0;
  return undefined;
}

function lineLine(context: Context, a: LineCurve, b: LineCurve): void {
  const rx = a.b[0] - a.a[0];
  const ry = a.b[1] - a.a[1];
  const sx = b.b[0] - b.a[0];
  const sy = b.b[1] - b.a[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) <= 1e-12 * Math.hypot(rx, ry) * Math.hypot(sx, sy)) return;
  const qx = b.a[0] - a.a[0];
  const qy = b.a[1] - a.a[1];
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  const et = context.tol / a.length;
  const eu = context.tol / b.length;
  if (t < -et || t > 1 + et || u < -eu || u > 1 + eu) return;
  const tc = Math.min(1, Math.max(0, t));
  const uc = Math.min(1, Math.max(0, u));
  const p: Vec2 = [a.a[0] + rx * t, a.a[1] + ry * t];
  addPair(context, a, tc, b, uc, p);
}

function lineRound(context: Context, line: LineCurve, round: RoundCurve): void {
  const dx = line.b[0] - line.a[0];
  const dy = line.b[1] - line.a[1];
  const fx = line.a[0] - round.c[0];
  const fy = line.a[1] - round.c[1];
  const A = dx * dx + dy * dy;
  const B = 2 * (fx * dx + fy * dy);
  const C = fx * fx + fy * fy - round.r * round.r;
  const perpendicular = Math.abs(fx * dy - fy * dx) / line.length;
  if (perpendicular > round.r + context.tol) return;
  const ts: number[] = [];
  if (Math.abs(perpendicular - round.r) <= context.tol) ts.push(-B / (2 * A));
  else {
    const discriminant = B * B - 4 * A * C;
    if (discriminant < 0) return;
    const root = Math.sqrt(discriminant);
    ts.push((-B - root) / (2 * A), (-B + root) / (2 * A));
  }
  const et = context.tol / line.length;
  const angleTol = context.tol / round.r;
  for (const t of ts) {
    if (t < -et || t > 1 + et) continue;
    const p: Vec2 = [line.a[0] + dx * t, line.a[1] + dy * t];
    const u = roundParam(round, p, angleTol);
    if (u === undefined) continue;
    addPair(context, line, Math.min(1, Math.max(0, t)), round, u, p);
  }
}

/** A line against an ellipse, exactly: the ellipse is stretched into a circle, the line follows, and the circle formula applies. */
function lineEllipse(context: Context, line: LineCurve, ellipse: EllipseCurve): void {
  const local = (p: Vec2): Vec2 => {
    const dx = p[0] - ellipse.c[0];
    const dy = p[1] - ellipse.c[1];
    return [dx * ellipse.cos + dy * ellipse.sin, ((-dx * ellipse.sin + dy * ellipse.cos) * ellipse.a) / ellipse.b];
  };
  const q0 = local(line.a);
  const q1 = local(line.b);
  const dx = q1[0] - q0[0];
  const dy = q1[1] - q0[1];
  const A = dx * dx + dy * dy;
  const B = 2 * (q0[0] * dx + q0[1] * dy);
  const C = q0[0] * q0[0] + q0[1] * q0[1] - ellipse.a * ellipse.a;
  const lineLength = Math.sqrt(A);
  const perpendicular = Math.abs(q0[0] * dy - q0[1] * dx) / lineLength;
  const tol = context.tol * (ellipse.a / ellipse.b);
  if (perpendicular > ellipse.a + tol) return;
  const ts: number[] = [];
  if (Math.abs(perpendicular - ellipse.a) <= context.tol) ts.push(-B / (2 * A));
  else {
    const discriminant = B * B - 4 * A * C;
    if (discriminant < 0) return;
    const root = Math.sqrt(discriminant);
    ts.push((-B - root) / (2 * A), (-B + root) / (2 * A));
  }
  const et = context.tol / line.length;
  for (const t of ts) {
    if (t < -et || t > 1 + et) continue;
    const phi = Math.atan2(q0[1] + dy * t, q0[0] + dx * t);
    const u = ((phi % TWO_PI) + TWO_PI) % TWO_PI / TWO_PI;
    addPair(context, line, Math.min(1, Math.max(0, t)), ellipse, u, curvePoint(ellipse, u));
  }
}

function roundRound(context: Context, a: RoundCurve, b: RoundCurve): void {
  const dx = b.c[0] - a.c[0];
  const dy = b.c[1] - a.c[1];
  const d = Math.hypot(dx, dy);
  const tol = context.tol;
  if (d <= tol && Math.abs(a.r - b.r) <= tol) return; // the same circle: overlaps are found by the end point rule
  if (d > a.r + b.r + tol || d < Math.abs(a.r - b.r) - tol) return;
  const points: Vec2[] = [];
  const ex = dx / d;
  const ey = dy / d;
  if (Math.abs(d - (a.r + b.r)) <= tol) points.push([a.c[0] + ex * a.r, a.c[1] + ey * a.r]);
  else if (Math.abs(d - Math.abs(a.r - b.r)) <= tol) {
    const sign = a.r >= b.r ? 1 : -1;
    points.push([a.c[0] + ex * a.r * sign, a.c[1] + ey * a.r * sign]);
  } else {
    const along = (d * d + a.r * a.r - b.r * b.r) / (2 * d);
    const h = Math.sqrt(Math.max(0, a.r * a.r - along * along));
    const mx = a.c[0] + ex * along;
    const my = a.c[1] + ey * along;
    points.push([mx - ey * h, my + ex * h], [mx + ey * h, my - ex * h]);
  }
  for (const p of points) {
    const ua = roundParam(a, p, tol / a.r);
    const ub = roundParam(b, p, tol / b.r);
    if (ua === undefined || ub === undefined) continue;
    addPair(context, a, ua, b, ub, p);
  }
}

function polyOf(curve: Curve, chordTol: number | undefined): Poly {
  if (curve.kind === "ellipse" || curve.kind === "spline") return curve.poly;
  const points = flattenRange(curve, 0, 1, chordTol);
  return { pts: points, ts: points.map((_, index) => index / (points.length - 1)) };
}

function polyPoly(context: Context, a: Curve, b: Curve, polys: Map<number, Poly>): void {
  const pa = polys.get(a.index) ?? polyOf(a, context.chordTol);
  const pb = polys.get(b.index) ?? polyOf(b, context.chordTol);
  polys.set(a.index, pa);
  polys.set(b.index, pb);
  const tol = context.tol;
  for (let i = 0; i + 1 < pa.pts.length; i += 1) {
    const a0 = pa.pts[i]!;
    const a1 = pa.pts[i + 1]!;
    const minAx = Math.min(a0[0], a1[0]) - tol;
    const maxAx = Math.max(a0[0], a1[0]) + tol;
    const minAy = Math.min(a0[1], a1[1]) - tol;
    const maxAy = Math.max(a0[1], a1[1]) + tol;
    for (let j = 0; j + 1 < pb.pts.length; j += 1) {
      const b0 = pb.pts[j]!;
      const b1 = pb.pts[j + 1]!;
      if (Math.max(b0[0], b1[0]) < minAx || Math.min(b0[0], b1[0]) > maxAx || Math.max(b0[1], b1[1]) < minAy || Math.min(b0[1], b1[1]) > maxAy) continue;
      const hit = segmentHit(a0, a1, b0, b1);
      if (hit === undefined) continue;
      const ta = pa.ts[i]! + (pa.ts[i + 1]! - pa.ts[i]!) * hit.t;
      const tb = pb.ts[j]! + (pb.ts[j + 1]! - pb.ts[j]!) * hit.u;
      addPair(context, a, ta, b, tb, hit.p);
    }
  }
}

function segmentHit(a0: Vec2, a1: Vec2, b0: Vec2, b1: Vec2): { readonly t: number; readonly u: number; readonly p: Vec2 } | undefined {
  const rx = a1[0] - a0[0];
  const ry = a1[1] - a0[1];
  const sx = b1[0] - b0[0];
  const sy = b1[1] - b0[1];
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) <= 1e-14 * Math.hypot(rx, ry) * Math.hypot(sx, sy) || denominator === 0) return undefined;
  const qx = b0[0] - a0[0];
  const qy = b0[1] - a0[1];
  const t = (qx * sy - qy * sx) / denominator;
  const u = (qx * ry - qy * rx) / denominator;
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return undefined;
  const tc = Math.min(1, Math.max(0, t));
  const uc = Math.min(1, Math.max(0, u));
  return { t: tc, u: uc, p: [a0[0] + rx * t, a0[1] + ry * t] };
}

function selfIntersect(context: Context, curve: SplineCurve): void {
  const { pts, ts } = curve.poly;
  const last = pts.length - 2;
  for (let i = 0; i <= last; i += 1) {
    for (let j = i + 2; j <= last; j += 1) {
      if (curve.closed && i === 0 && j === last) continue;
      const hit = segmentHit(pts[i]!, pts[i + 1]!, pts[j]!, pts[j + 1]!);
      if (hit === undefined) continue;
      const ta = ts[i]! + (ts[i + 1]! - ts[i]!) * hit.t;
      const tb = ts[j]! + (ts[j + 1]! - ts[j]!) * hit.u;
      if ((tb - ta) * curve.length <= context.tol) continue;
      addSplit(context, curve.index, ta, hit.p, curve.index);
      addSplit(context, curve.index, tb, hit.p, curve.index);
      context.selfCrossings.push({ entityId: curve.entityId, at: hit.p });
    }
  }
}

/** The closest point of a curve to `p`: its parameter, the point and the distance. */
function nearestOn(curve: Curve, p: Vec2): { readonly t: number; readonly point: Vec2; readonly distance: number } {
  if (curve.kind === "line") {
    const dx = curve.b[0] - curve.a[0];
    const dy = curve.b[1] - curve.a[1];
    const t = Math.min(1, Math.max(0, ((p[0] - curve.a[0]) * dx + (p[1] - curve.a[1]) * dy) / (dx * dx + dy * dy)));
    const point = curvePoint(curve, t);
    return { t, point, distance: dist(p, point) };
  }
  if (isRound(curve)) {
    const u = roundParam(curve, p, 1e-12);
    const radial = dist(p, curve.c);
    if (u !== undefined && radial > 1e-12) {
      const k = curve.r / radial;
      const point: Vec2 = [curve.c[0] + (p[0] - curve.c[0]) * k, curve.c[1] + (p[1] - curve.c[1]) * k];
      return { t: u, point, distance: Math.abs(radial - curve.r) };
    }
    const toStart = dist(p, curve.startPt);
    const toEnd = dist(p, curve.endPt);
    return toStart <= toEnd ? { t: 0, point: curve.startPt, distance: toStart } : { t: 1, point: curve.endPt, distance: toEnd };
  }
  const { pts, ts } = curve.poly;
  let best = { t: 0, point: pts[0]!, distance: Infinity };
  for (let index = 0; index + 1 < pts.length; index += 1) {
    const a = pts[index]!;
    const b = pts[index + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const w = lengthSquared === 0 ? 0 : Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared));
    const point: Vec2 = [a[0] + dx * w, a[1] + dy * w];
    const distance = dist(p, point);
    if (distance < best.distance) best = { t: ts[index]! + (ts[index + 1]! - ts[index]!) * w, point, distance };
  }
  return best;
}

/** An end point of one curve that lies on the interior of another splits the other there (T-junctions, overlaps). */
function endpointOnCurve(context: Context, source: Curve, target: Curve): void {
  const probes: Vec2[] = source.closed ? [curvePoint(source, 0)] : [curvePoint(source, 0), curvePoint(source, 1)];
  for (const probe of probes) {
    const near = nearestOn(target, probe);
    if (near.distance > context.tol) continue;
    const alongStart = near.t * target.length;
    const alongEnd = (1 - near.t) * target.length;
    if (alongStart <= context.tol || alongEnd <= context.tol) continue;
    addSplit(context, target.index, near.t, near.point, source.index);
  }
}

function findIntersections(context: Context): void {
  const curves = context.curves;
  const polys = new Map<number, Poly>();
  for (const curve of curves) if (curve.kind === "spline") selfIntersect(context, curve);
  const order = curves.map((_, index) => index).sort((left, right) => curves[left]!.bbox[0] - curves[right]!.bbox[0]);
  const margin = context.tol;
  for (let i = 0; i < order.length; i += 1) {
    const a = curves[order[i]!]!;
    for (let j = i + 1; j < order.length; j += 1) {
      const b = curves[order[j]!]!;
      if (b.bbox[0] > a.bbox[2] + margin) break;
      if (!boxesTouch(a.bbox, b.bbox, margin)) continue;
      const [first, second] = a.index < b.index ? [a, b] : [b, a];
      if (first.kind === "line" && second.kind === "line") lineLine(context, first, second);
      else if (first.kind === "line" && isRound(second)) lineRound(context, first, second);
      else if (isRound(first) && second.kind === "line") lineRound(context, second, first);
      else if (isRound(first) && isRound(second)) roundRound(context, first, second);
      else if (first.kind === "line" && second.kind === "ellipse") lineEllipse(context, first, second);
      else if (first.kind === "ellipse" && second.kind === "line") lineEllipse(context, second, first);
      else polyPoly(context, first, second, polys);
      endpointOnCurve(context, first, second);
      endpointOnCurve(context, second, first);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Vertices
// ---------------------------------------------------------------------------------------------

export function clusterPoints(points: readonly Vec2[], tol: number): number[] {
  const parent = points.map((_, index) => index);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root]!;
    let current = x;
    while (parent[current] !== root) { const next = parent[current]!; parent[current] = root; current = next; }
    return root;
  };
  const cell = Math.max(tol, 1e-9);
  const grid = new Map<string, number[]>();
  const key = (cx: number, cy: number): string => `${cx},${cy}`;
  points.forEach((point, index) => {
    const cx = Math.floor(point[0] / cell);
    const cy = Math.floor(point[1] / cell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const bucket = grid.get(key(cx + dx, cy + dy));
        if (bucket === undefined) continue;
        for (const other of bucket) {
          if (dist(points[other]!, point) <= tol) {
            const a = find(index);
            const b = find(other);
            if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
          }
        }
      }
    }
    const own = grid.get(key(cx, cy));
    if (own === undefined) grid.set(key(cx, cy), [index]); else own.push(index);
  });
  return points.map((_, index) => find(index));
}

// ---------------------------------------------------------------------------------------------
// The arrangement
// ---------------------------------------------------------------------------------------------

interface RawEdge {
  curve: Curve;
  t0: number;
  t1: number;
  u: number;
  v: number;
  points: Vec2[];
  area2: number;
  length: number;
  whole: boolean;
  pieceIndex: number;
  pieceCount: number;
  departU: number | undefined;
  departV: number | undefined;
}

/** The direction of the curve at parameter `t` as an angle, walking toward larger t (`sign` 1) or back toward smaller t (-1). Lines and circular arcs only. */
function exactDirection(curve: Curve, t: number, sign: 1 | -1): number | undefined {
  if (curve.kind === "line") return Math.atan2((curve.b[1] - curve.a[1]) * sign, (curve.b[0] - curve.a[0]) * sign);
  if (isRound(curve)) {
    const angle = curve.a0 + curve.sweep * t;
    const turn = curve.sweep >= 0 ? 1 : -1;
    return Math.atan2(Math.cos(angle) * turn * sign, -Math.sin(angle) * turn * sign);
  }
  return undefined;
}

/**
 * The size of the smallest feature (a line, a rectangle side, a radius, a curve) that the model accepts but that is within four gap
 * tolerances of the gap itself, or Infinity when there is none. The gap tolerance (0.01 mm) equals the smallest geometry a sketch may
 * hold (ENVELOPE_LIMITS.minGeometryMm), so a 0.01 mm rectangle was accepted by the validators and then closed up and dropped here.
 * The arrangement narrows its tolerance to a quarter of such a feature, so everything the model accepts yields a profile.
 */
function smallestSmallFeatureMm(entities: readonly SketchEntity[]): number {
  const floor = ENVELOPE_LIMITS.minGeometryMm * (1 - 1e-9);
  let smallest = Infinity;
  const consider = (size: number): void => { if (Number.isFinite(size) && size >= floor && size < smallest) smallest = size; };
  for (const entity of entities) {
    if (entity.kind === "line") consider(dist(entity.start, entity.end));
    else if (entity.kind === "rectangle") { consider(entity.widthMm); consider(entity.heightMm); }
    else if (entity.kind === "circle") consider(entity.radiusMm);
    else if (entity.kind === "ellipse") consider(Math.min(entity.majorRadiusMm, entity.minorRadiusMm));
    else if (entity.kind === "arc") consider(dist(entity.start, entity.end));
  }
  return smallest;
}

export function buildArrangement(entities: readonly SketchEntity[], options: { readonly gapToleranceMm?: number; readonly chordToleranceMm?: number } = {}): Arrangement {
  const requested = Math.max(options.gapToleranceMm ?? PROFILE_GAP_TOLERANCE_MM, 1e-9);
  const tol = Math.max(Math.min(requested, smallestSmallFeatureMm(entities) / 4), 1e-9);
  const chordTol = options.chordToleranceMm;
  const skipped: { entityId: string; reason: string }[] = [];
  const curves = buildCurves(entities, tol, chordTol, skipped);
  const context: Context = {
    tol, chordTol, curves, splits: curves.map(() => []), overlaps: [], selfCrossings: []
  };
  if (curves.length === 0) return { faces: [], edges: [], vertices: [], toleranceMm: tol, crossings: [], overlaps: [], skipped, selfCrossings: [], snapped: [] };
  findIntersections(context);

  // Per-curve split lists: end points, then computed intersections, merged where they are closer than the tolerance.
  const entries: { curve: Curve; list: SplitEntry[]; dropped: SplitEntry[] }[] = curves.map((curve) => {
    const list = context.splits[curve.index]!;
    list.push({ t: 0, p: curvePoint(curve, 0), end: true, other: -1 });
    if (!curve.closed) list.push({ t: 1, p: curvePoint(curve, 1), end: true, other: -1 });
    list.sort((left, right) => left.t - right.t || Number(right.end) - Number(left.end));
  const merged: SplitEntry[] = [];
    // A split merged into its neighbour on this curve still marks a place where another curve meets it: it stays in the vertex clustering below
    // (without cutting the curve), so every curve that meets the cluster ends up on the one vertex. Dropping it let two curves that cross
    // at a point a few microns from a third curve's crossings miss each other altogether, and whole faces vanished.
    const dropped: SplitEntry[] = [];
    for (const entry of list) {
      const previous = merged[merged.length - 1];
      if (previous !== undefined && (entry.t - previous.t) * curve.length <= tol) {
        if (entry.end && !previous.end) { dropped.push(previous); merged[merged.length - 1] = entry; } else dropped.push(entry);
        continue;
      }
      merged.push(entry);
    }
    if (curve.closed) {
      while (merged.length > 1 && (1 - merged[merged.length - 1]!.t) * curve.length <= tol) dropped.push(merged.pop()!);
    } else if (merged.length > 1) {
      // The last entry must be the curve end.
      const last = merged[merged.length - 1]!;
      if (!last.end || last.t < 1) {
        const closing = { t: 1, p: curvePoint(curve, 1), end: true, other: -1 };
        if ((1 - last.t) * curve.length <= tol) { dropped.push(last); merged[merged.length - 1] = closing; } else merged.push(closing);
      }
    }
    return { curve, list: merged, dropped };
  });

  // Vertices: cluster every split point.
  const flat: { curveIndex: number; entry: SplitEntry; dropped?: true }[] = [];
  for (const item of entries) for (const entry of item.list) flat.push({ curveIndex: item.curve.index, entry });
  for (const item of entries) for (const entry of item.dropped) flat.push({ curveIndex: item.curve.index, entry, dropped: true });
  const clusterOf = clusterPoints(flat.map((item) => item.entry.p), tol);
  const repOfCluster = new Map<number, number>();
  flat.forEach((item, index) => {
    if (item.dropped === true) return;
    const cluster = clusterOf[index]!;
    const current = repOfCluster.get(cluster);
    if (current === undefined) { repOfCluster.set(cluster, index); return; }
    const best = flat[current]!;
    // Prefer an end point the user placed over a computed intersection.
    if (item.entry.end && !best.entry.end) repOfCluster.set(cluster, index);
  });
  const clusterIds = [...repOfCluster.keys()].sort((left, right) => left - right);
  const vertexOfCluster = new Map<number, number>(clusterIds.map((cluster, index) => [cluster, index]));
  const vertexPoints: Vec2[] = clusterIds.map((cluster) => flat[repOfCluster.get(cluster)!]!.entry.p);
  const vertexEntities: Set<string>[] = clusterIds.map(() => new Set<string>());
  const vertexBy = new Map<SplitEntry, number>();
  flat.forEach((item, index) => {
    const vertex = vertexOfCluster.get(clusterOf[index]!)!;
    vertexBy.set(item.entry, vertex);
    vertexEntities[vertex]!.add(curves[item.curveIndex]!.entityId);
  });
  let originPoint: Vec2 = vertexPoints[0]!;
  {
    const box = boxOf(vertexPoints);
    originPoint = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
  }

  // Snapped intersections: a vertex that several different intersections were merged into.
  const snapped: { point: Vec2; entityIds: string[]; spreadMm: number }[] = [];
  {
    const byVertex = new Map<number, { pairs: Set<string>; points: Vec2[] }>();
    flat.forEach((item, index) => {
      if (item.entry.other < 0) return;
      const vertex = vertexOfCluster.get(clusterOf[index]!)!;
      const pair = item.curveIndex < item.entry.other ? `${item.curveIndex}|${item.entry.other}` : `${item.entry.other}|${item.curveIndex}`;
      const found = byVertex.get(vertex) ?? { pairs: new Set<string>(), points: [] };
      found.pairs.add(pair);
      found.points.push(item.entry.p);
      byVertex.set(vertex, found);
    });
    for (const [vertex, found] of byVertex) {
      if (found.pairs.size < 2) continue;
      let spread = 0;
      for (const a of found.points) for (const b of found.points) spread = Math.max(spread, dist(a, b));
      if (spread > 1e-7) snapped.push({ point: vertexPoints[vertex]!, entityIds: [...vertexEntities[vertex]!].sort(), spreadMm: spread });
    }
  }

  // Crossings: vertices where a computed intersection (not an end point) was merged.
  const crossingSeen = new Set<number>();
  const crossings: { point: Vec2; entityIds: string[] }[] = [];
  flat.forEach((item, index) => {
    if (item.entry.other < 0 || item.dropped === true) return;
    const vertex = vertexOfCluster.get(clusterOf[index]!)!;
    if (crossingSeen.has(vertex)) return;
    crossingSeen.add(vertex);
    crossings.push({ point: vertexPoints[vertex]!, entityIds: [...vertexEntities[vertex]!].sort() });
  });

  // Edges: the pieces between consecutive splits of each curve.
  const rawEdges: RawEdge[] = [];
  for (const item of entries) {
    const { curve, list } = item;
    const count = list.length;
    const pieceTotal = curve.closed ? count : count - 1;
    for (let i = 0; i < pieceTotal; i += 1) {
      const from = list[i]!;
      const toIndex = (i + 1) % count;
      const to = list[toIndex]!;
      const t0 = from.t;
      const t1 = curve.closed && toIndex === 0 ? 1 : to.t;
      const u = vertexBy.get(from)!;
      const v = vertexBy.get(to)!;
      const sampled = flattenRange(curve, t0, t1, chordTol);
      const length = polylineLength(sampled);
      if (u === v && length <= 8 * tol) continue;
      const points = sampled.slice();
      points[0] = vertexPoints[u]!;
      points[points.length - 1] = vertexPoints[v]!;
      let area2 = curveCorrection2(curve, t0, t1, sampled, originPoint);
      for (let index = 0; index + 1 < points.length; index += 1) area2 += crossRel(points[index]!, points[index + 1]!, originPoint);
      rawEdges.push({ curve, t0, t1, u, v, points, area2, length, whole: pieceTotal === 1 && (!curve.closed || count === 1), pieceIndex: i, pieceCount: pieceTotal, departU: exactDirection(curve, t0, 1), departV: exactDirection(curve, t1, -1) });
    }
  }

  // Duplicate pieces (the same stretch drawn twice, or two overlapping entities) become one edge with several owners.
  const edges: ArrangementEdge[] = [];
  const overlaps = [...context.overlaps];
  {
    const byPair = new Map<string, number[]>();
    rawEdges.forEach((edge, index) => {
      const key = edge.u < edge.v ? `${edge.u}|${edge.v}` : `${edge.v}|${edge.u}`;
      const bucket = byPair.get(key);
      if (bucket === undefined) byPair.set(key, [index]); else bucket.push(index);
    });
    const absorbed = new Set<number>();
    const extraOwners = new Map<number, RawEdge[]>();
    for (const bucket of byPair.values()) {
      if (bucket.length < 2) continue;
      for (let i = 0; i < bucket.length; i += 1) {
        const keepIndex = bucket[i]!;
        if (absorbed.has(keepIndex)) continue;
        const keep = rawEdges[keepIndex]!;
        const keepMid = midpointOf(keep);
        for (let j = i + 1; j < bucket.length; j += 1) {
          const otherIndex = bucket[j]!;
          if (absorbed.has(otherIndex)) continue;
          const other = rawEdges[otherIndex]!;
          if (Math.abs(other.length - keep.length) > 4 * tol + 0.01 * keep.length) continue;
          if (dist(midpointOf(other), keepMid) > 2 * tol) continue;
          absorbed.add(otherIndex);
          const list = extraOwners.get(keepIndex) ?? [];
          list.push(other);
          extraOwners.set(keepIndex, list);
          overlaps.push({ entityIds: [keep.curve.entityId, other.curve.entityId], at: keepMid });
        }
      }
    }
    rawEdges.forEach((edge, index) => {
      if (absorbed.has(index)) return;
      const owners: ArrangementOwner[] = [ownerOf(edge)];
      for (const extra of extraOwners.get(index) ?? []) owners.push(ownerOf(extra));
      edges.push({
        index: edges.length, u: edge.u, v: edge.v, points: edge.points, area2: edge.area2, lengthMm: edge.length, curveKind: edge.curve.kind,
        owners, whole: edge.whole && owners.every((owner) => owner.whole), status: "face",
        ...(edge.departU === undefined ? {} : { departU: edge.departU }), ...(edge.departV === undefined ? {} : { departV: edge.departV })
      });
    });
  }

  const degree = vertexPoints.map(() => 0);
  for (const edge of edges) { degree[edge.u]! += 1; degree[edge.v]! += 1; }
  const vertices: ArrangementVertex[] = vertexPoints.map((point, index) => ({ point, degree: degree[index]!, entityIds: [...vertexEntities[index]!].sort() }));

  const faces = extractFaces(edges, vertexPoints);
  return {
    faces, edges, vertices, toleranceMm: tol,
    crossings, overlaps: dedupeOverlaps(overlaps), skipped, selfCrossings: context.selfCrossings, snapped
  };
}

function dedupeOverlaps(overlaps: readonly { readonly entityIds: readonly [string, string]; readonly at: Vec2 }[]): { readonly entityIds: readonly [string, string]; readonly at: Vec2 }[] {
  const seen = new Set<string>();
  const result: { readonly entityIds: readonly [string, string]; readonly at: Vec2 }[] = [];
  for (const overlap of overlaps) {
    if (overlap.entityIds[0] === overlap.entityIds[1]) continue;
    const key = [...overlap.entityIds].sort().join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(overlap);
  }
  return result;
}

function ownerOf(edge: RawEdge): ArrangementOwner {
  const curve = edge.curve;
  const base = curve.side >= 0 ? `${curve.entityId}/s${curve.side}` : curve.entityId;
  const whole = edge.whole;
  return { entityId: curve.entityId, key: whole ? base : `${base}#${edge.pieceIndex}/${edge.pieceCount}`, side: curve.side, whole };
}

function midpointOf(edge: RawEdge): Vec2 {
  const half = edge.length / 2;
  let walked = 0;
  for (let index = 0; index + 1 < edge.points.length; index += 1) {
    const a = edge.points[index]!;
    const b = edge.points[index + 1]!;
    const step = dist(a, b);
    if (walked + step >= half) {
      const w = step === 0 ? 0 : (half - walked) / step;
      return [a[0] + (b[0] - a[0]) * w, a[1] + (b[1] - a[1]) * w];
    }
    walked += step;
  }
  return edge.points[edge.points.length - 1]!;
}

// ---------------------------------------------------------------------------------------------
// Faces
// ---------------------------------------------------------------------------------------------

function departureAngle(points: readonly Vec2[], reversed: boolean, totalLength: number): number {
  const count = points.length;
  const origin = reversed ? points[count - 1]! : points[0]!;
  const target = Math.min(totalLength / 3, 1);
  let walked = 0;
  for (let step = 0; step + 1 < count; step += 1) {
    const from = reversed ? points[count - 1 - step]! : points[step]!;
    const to = reversed ? points[count - 2 - step]! : points[step + 1]!;
    const segment = dist(from, to);
    if (segment > 0 && walked + segment >= target) {
      const w = (target - walked) / segment;
      return Math.atan2(from[1] + (to[1] - from[1]) * w - origin[1], from[0] + (to[0] - from[0]) * w - origin[0]);
    }
    walked += segment;
  }
  const last = reversed ? points[0]! : points[count - 1]!;
  return Math.atan2(last[1] - origin[1], last[0] - origin[0]);
}

function extractFaces(edges: readonly ArrangementEdge[], vertexPoints: readonly Vec2[]): ArrangementFace[] {
  const active = edges.map(() => true);
  let faces: ArrangementFace[] = [];
  for (let round = 0; round < 64; round += 1) {
    let changed = false;
    // Dangling edges: an end with no other edge cannot bound a region.
    for (let again = true; again;) {
      again = false;
      const degree = vertexPoints.map(() => 0);
      edges.forEach((edge, index) => { if (active[index]) { degree[edge.u]! += 1; degree[edge.v]! += 1; } });
      edges.forEach((edge, index) => {
        if (!active[index]) return;
        if (degree[edge.u] === 1 || degree[edge.v] === 1) { active[index] = false; edge.status = "dangling"; again = true; changed = true; }
      });
    }
    const traced = traceCycles(edges, active, vertexPoints);
    // Bridges: an edge whose two sides are the same cycle bounds nothing.
    const sideOf = new Map<number, number>();
    traced.rawCycles.forEach((cycle, cycleIndex) => { for (const step of cycle) sideOf.set(step.edge.index * 2 + (step.forward ? 0 : 1), cycleIndex); });
    let bridge = false;
    edges.forEach((edge, index) => {
      if (!active[index]) return;
      if (sideOf.get(index * 2) === sideOf.get(index * 2 + 1)) { active[index] = false; edge.status = "bridge"; bridge = true; changed = true; }
    });
    if (!bridge) { faces = assembleFaces(traced, edges, active, vertexPoints); break; }
    if (!changed) break;
  }
  return faces;
}

interface Traced {
  readonly rawCycles: readonly (readonly CycleStep[])[];
  readonly componentOf: (vertex: number) => number;
}

function traceCycles(edges: readonly ArrangementEdge[], active: readonly boolean[], vertexPoints: readonly Vec2[]): Traced {
  // Half-edge h = 2 * edge + (forward ? 0 : 1).
  const outgoing: number[][] = vertexPoints.map(() => []);
  const angle = new Map<number, number>();
  const exact = new Map<number, number>();
  edges.forEach((edge, index) => {
    if (!active[index]) return;
    outgoing[edge.u]!.push(index * 2);
    outgoing[edge.v]!.push(index * 2 + 1);
    angle.set(index * 2, departureAngle(edge.points, false, edge.lengthMm));
    angle.set(index * 2 + 1, departureAngle(edge.points, true, edge.lengthMm));
    if (edge.departU !== undefined) exact.set(index * 2, edge.departU);
    if (edge.departV !== undefined) exact.set(index * 2 + 1, edge.departV);
  });
  const position = new Map<number, number>();
  for (const list of outgoing) {
    // The exact direction orders two edges that leave at different angles; only when they leave together (tangent curves, or a curve with no
    // closed form) does the direction measured further along the edge decide.
    list.sort((left, right) => {
      const keyLeft = exact.get(left) ?? angle.get(left)!;
      const keyRight = exact.get(right) ?? angle.get(right)!;
      if (Math.abs(keyLeft - keyRight) > 1e-6) return keyLeft - keyRight;
      return angle.get(left)! - angle.get(right)! || left - right;
    });
    list.forEach((half, index) => position.set(half, index));
  }
  const originOf = (half: number): number => (half % 2 === 0 ? edges[half >> 1]!.u : edges[half >> 1]!.v);
  const destOf = (half: number): number => (half % 2 === 0 ? edges[half >> 1]!.v : edges[half >> 1]!.u);
  const nextOf = (half: number): number => {
    const vertex = destOf(half);
    const list = outgoing[vertex]!;
    const twin = half ^ 1;
    const at = position.get(twin)!;
    return list[(at - 1 + list.length) % list.length]!;
  };
  const visited = new Set<number>();
  const rawCycles: CycleStep[][] = [];
  for (let vertex = 0; vertex < outgoing.length; vertex += 1) {
    for (const start of outgoing[vertex]!) {
      if (visited.has(start)) continue;
      const cycle: CycleStep[] = [];
      let half = start;
      do {
        visited.add(half);
        cycle.push({ edge: edges[half >> 1]!, forward: half % 2 === 0 });
        half = nextOf(half);
      } while (half !== start && cycle.length <= edges.length * 2 + 2);
      rawCycles.push(cycle);
    }
  }
  const parent = vertexPoints.map((_, index) => index);
  const find = (x: number): number => { let r = x; while (parent[r] !== r) r = parent[r]!; return r; };
  edges.forEach((edge, index) => { if (active[index]) { const a = find(edge.u); const b = find(edge.v); if (a !== b) parent[Math.max(a, b)] = Math.min(a, b); } });
  void originOf;
  return { rawCycles, componentOf: find };
}

function stepOrigin(step: CycleStep): number {
  return step.forward ? step.edge.u : step.edge.v;
}

function stepDest(step: CycleStep): number {
  return step.forward ? step.edge.v : step.edge.u;
}

function stepPoints(step: CycleStep): readonly Vec2[] {
  return step.forward ? step.edge.points : [...step.edge.points].reverse();
}

function cycleOf(steps: readonly CycleStep[], component: number): ArrangementCycle {
  let area2 = 0;
  const points: Vec2[] = [];
  for (const step of steps) {
    area2 += step.forward ? step.edge.area2 : -step.edge.area2;
    const sampled = stepPoints(step);
    for (let index = 0; index + 1 < sampled.length; index += 1) points.push(sampled[index]!);
  }
  return { steps, area2, points, component };
}

/** Splits a cycle that visits a vertex more than once into simple loops. */
function splitAtPinches(steps: readonly CycleStep[]): CycleStep[][] {
  const result: CycleStep[][] = [];
  const stack: CycleStep[] = [];
  const positionOf = new Map<number, number>();
  for (const step of steps) {
    const origin = stepOrigin(step);
    if (!positionOf.has(origin)) positionOf.set(origin, stack.length);
    stack.push(step);
    const dest = stepDest(step);
    const at = positionOf.get(dest);
    if (at !== undefined) {
      const loop = stack.splice(at);
      for (const item of loop) { const o = stepOrigin(item); if (positionOf.get(o) !== undefined && positionOf.get(o)! >= at) positionOf.delete(o); }
      result.push(loop);
    }
  }
  if (stack.length > 0) result.push(stack);
  return result;
}

function assembleFaces(traced: Traced, edges: readonly ArrangementEdge[], active: readonly boolean[], vertexPoints: readonly Vec2[]): ArrangementFace[] {
  void edges; void active;
  const areaEpsilon = 1e-9;
  interface Draft { outer: ArrangementCycle; holes: ArrangementCycle[]; box: Box }
  const drafts: Draft[] = [];
  const looseHoles: ArrangementCycle[] = [];
  for (const raw of traced.rawCycles) {
    if (raw.length === 0) continue;
    const component = traced.componentOf(stepOrigin(raw[0]!));
    const loops = splitAtPinches(raw).map((steps) => cycleOf(steps, component));
    let rawArea = 0;
    for (const step of raw) rawArea += step.forward ? step.edge.area2 : -step.edge.area2;
    if (rawArea > areaEpsilon) {
      const positives = loops.filter((loop) => loop.area2 > areaEpsilon);
      const negatives = loops.filter((loop) => loop.area2 < -areaEpsilon);
      if (positives.length === 0) continue;
      positives.sort((left, right) => right.area2 - left.area2);
      const head: Draft = { outer: positives[0]!, holes: negatives, box: boxOf(positives[0]!.points) };
      drafts.push(head);
      for (const extra of positives.slice(1)) drafts.push({ outer: extra, holes: [], box: boxOf(extra.points) });
    } else {
      for (const loop of loops) {
        if (loop.area2 < -areaEpsilon) looseHoles.push(loop);
        else if (loop.area2 > areaEpsilon) drafts.push({ outer: loop, holes: [], box: boxOf(loop.points) });
      }
    }
  }
  // Each component's outside boundary is a hole of the smallest face (of another component) that contains it.
  const bySize = drafts.map((draft, index) => ({ draft, index })).sort((left, right) => left.draft.outer.area2 - right.draft.outer.area2);
  for (const hole of looseHoles) {
    const probe = hole.points[0]!;
    for (const { draft } of bySize) {
      if (draft.outer.component === hole.component) continue;
      if (probe[0] < draft.box[0] || probe[0] > draft.box[2] || probe[1] < draft.box[1] || probe[1] > draft.box[3]) continue;
      if (pointInRing(probe, draft.outer.points)) { draft.holes.push(hole); break; }
    }
  }
  void vertexPoints;
  return drafts.map((draft) => {
    let net = draft.outer.area2;
    for (const hole of draft.holes) net += hole.area2;
    return { outer: draft.outer, holes: draft.holes, areaMm2: Math.abs(net) / 2, component: draft.outer.component };
  });
}

/** Even-odd point in polygon. */
export function pointInRing(point: Vec2, ring: readonly Vec2[]): boolean {
  let inside = false;
  for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
    const a = ring[index]!;
    const b = ring[previous]!;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && point[0] < ((b[0] - a[0]) * (point[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

/** A point strictly inside a polygon-with-holes region (the middle of the widest horizontal span at a few heights). */
export function interiorPointOf(outer: readonly Vec2[], holes: readonly (readonly Vec2[])[]): Vec2 {
  const box = boxOf(outer);
  let best: { readonly width: number; readonly point: Vec2 } | undefined;
  for (const fraction of [0.5, 0.37, 0.63, 0.25, 0.75, 0.123, 0.877]) {
    const y = box[1] + (box[3] - box[1]) * fraction;
    const crossings: number[] = [];
    for (const ring of [outer, ...holes]) {
      for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index += 1) {
        const a = ring[index]!;
        const b = ring[previous]!;
        if ((a[1] > y) !== (b[1] > y)) crossings.push(((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]);
      }
    }
    crossings.sort((left, right) => left - right);
    for (let index = 0; index + 1 < crossings.length; index += 2) {
      const width = crossings[index + 1]! - crossings[index]!;
      if (best === undefined || width > best.width) best = { width, point: [(crossings[index]! + crossings[index + 1]!) / 2, y] };
    }
    if (best !== undefined && best.width > (box[2] - box[0]) * 0.2) break;
  }
  return best?.point ?? [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
}
