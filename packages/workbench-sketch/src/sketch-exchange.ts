import { ENVELOPE_LIMITS, failure, SPLINE_MAX_FIT_POINTS, type SketchEntity, type Vec2, type WorkbenchResult, type WorkbenchSketch } from "../../workbench-core/src/index.js";
import type { SketchEditPlan } from "./edit-tools.js";

/**
 * What the DXF and SVG readers hand to the sketch: plain curves in the drawing's own units, plus the units the file claims.
 * `planDrawingImport` turns them into sketch entities (scaled to millimetres, welded so loops close, bounded by the sketch
 * limits) and cuts them into `apply-sketch-edit` plans small enough for the operation layer. The writers (dxf.ts, svg.ts) read the
 * sketch the other way round.
 */

export type RawCurveShape =
  | { readonly kind: "line"; readonly a: Vec2; readonly b: Vec2 }
  | { readonly kind: "arc"; readonly start: Vec2; readonly mid: Vec2; readonly end: Vec2 }
  | { readonly kind: "circle"; readonly center: Vec2; readonly radius: number }
  | { readonly kind: "ellipse"; readonly center: Vec2; readonly major: number; readonly minor: number; readonly rotationDeg: number }
  /** Fit points of a spline (3 to 24); longer runs are cut into several by the readers. */
  | { readonly kind: "spline"; readonly fit: readonly Vec2[] }
  | { readonly kind: "point"; readonly at: Vec2 };

export type RawCurve = RawCurveShape & { readonly layer: string; readonly construction?: boolean };

export interface DetectedUnits {
  /** The unit the file says its numbers are in. */
  readonly name: string;
  /** Millimetres in one drawing unit. */
  readonly mmPerUnit: number;
  /** Where that came from: the file ($INSUNITS, width/height), a guess from $MEASUREMENT, or a default. A guess needs the user's confirmation. */
  readonly source: "file" | "measurement" | "assumed";
}

export interface ParsedDrawing {
  readonly format: "dxf" | "svg";
  readonly curves: readonly RawCurve[];
  readonly units: DetectedUnits;
  /** Things the reader could not use (entity types skipped, approximations made). */
  readonly warnings: readonly string[];
  /** Skipped entity or element types with how many were skipped. */
  readonly skipped: Readonly<Record<string, number>>;
  readonly layers: readonly { readonly name: string; readonly count: number }[];
}

export type ParseResult = WorkbenchResult<ParsedDrawing>;

export const IMPORT_CHUNK_SIZE = 200;
export const SKETCH_ENTITY_LIMIT = 500;
/** A drawing may reach as far as a sketch can (the model envelope: +/-100 m), not a smaller private limit. */
export const SKETCH_COORDINATE_LIMIT_MM: number = ENVELOPE_LIMITS.maxSketchCoordinateMm;
const MIN_GEOMETRY_MM: number = ENVELOPE_LIMITS.minGeometryMm;

/** The millimetres in one unit of a DXF $INSUNITS code, or undefined for 0 (unitless) and unknown codes. */
export function mmPerInsUnit(code: number): { readonly name: string; readonly mmPerUnit: number } | undefined {
  const table: Readonly<Record<number, readonly [string, number]>> = {
    1: ["inches", 25.4], 2: ["feet", 304.8], 3: ["miles", 1_609_344], 4: ["millimetres", 1], 5: ["centimetres", 10], 6: ["metres", 1000], 7: ["kilometres", 1_000_000],
    8: ["microinches", 0.0000254], 9: ["mils", 0.0254], 10: ["yards", 914.4], 11: ["angstroms", 1e-7], 12: ["nanometres", 1e-6], 13: ["microns", 0.001],
    14: ["decimetres", 100], 15: ["decametres", 10_000]
  };
  const entry = table[code];
  return entry === undefined ? undefined : { name: entry[0], mmPerUnit: entry[1] };
}

export const COMMON_IMPORT_SCALES: readonly { readonly label: string; readonly mmPerUnit: number }[] = [
  { label: "Millimetres", mmPerUnit: 1 },
  { label: "Centimetres", mmPerUnit: 10 },
  { label: "Metres", mmPerUnit: 1000 },
  { label: "Inches", mmPerUnit: 25.4 },
  { label: "Feet", mmPerUnit: 304.8 },
  { label: "SVG pixels (96 per inch)", mmPerUnit: 25.4 / 96 },
  { label: "Points (72 per inch)", mmPerUnit: 25.4 / 72 }
];

const dist = (a: Vec2, b: Vec2): number => Math.hypot(b[0] - a[0], b[1] - a[1]);
const cross = (a: Vec2, b: Vec2, c: Vec2): number => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);

// ---------------------------------------------------------------------------------------------------------------------
// Fitting splines through dense curve samples (used for NURBS, Beziers and elliptical arcs)
// ---------------------------------------------------------------------------------------------------------------------

/** Catmull-Rom samples through fit points, the same curve the sketch draws (uniform, clamped ends). */
export function catmullRomSamples(fit: readonly Vec2[], samplesPerSpan: number): readonly Vec2[] {
  const points: Vec2[] = [fit[0]!];
  for (let span = 0; span < fit.length - 1; span += 1) {
    const p0 = fit[Math.max(0, span - 1)]!;
    const p1 = fit[span]!;
    const p2 = fit[span + 1]!;
    const p3 = fit[Math.min(fit.length - 1, span + 2)]!;
    for (let step = 1; step <= samplesPerSpan; step += 1) {
      if (span === fit.length - 2 && step === samplesPerSpan) { points.push(p2); break; }
      const t = step / samplesPerSpan;
      const t2 = t * t;
      const t3 = t2 * t;
      const blend = (a: number, b: number, c: number, d: number): number => 0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      points.push([blend(p0[0], p1[0], p2[0], p3[0]), blend(p0[1], p1[1], p2[1], p3[1])]);
    }
  }
  return points;
}

function polylineLength(points: readonly Vec2[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) total += dist(points[index - 1]!, points[index]!);
  return total;
}

/** `count` points spaced equally by length along a polyline, the first and last being its own ends. */
export function resamplePolyline(points: readonly Vec2[], count: number): readonly Vec2[] {
  const total = polylineLength(points);
  const result: Vec2[] = [points[0]!];
  let walked = 0;
  let segment = 0;
  for (let index = 1; index < count - 1; index += 1) {
    const target = (total * index) / (count - 1);
    while (segment < points.length - 2 && walked + dist(points[segment]!, points[segment + 1]!) < target) {
      walked += dist(points[segment]!, points[segment + 1]!);
      segment += 1;
    }
    const a = points[segment]!;
    const b = points[segment + 1]!;
    const length = dist(a, b);
    const t = length < 1e-12 ? 0 : (target - walked) / length;
    result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  result.push(points[points.length - 1]!);
  return result;
}

/**
 * Like `resamplePolyline`, but spends more of the `count` points where the polyline bends: the spacing follows length times
 * (1 + half the square root of curvature times total length), so tight corners of an ellipse or a spiral get the points a
 * smooth Catmull-Rom curve needs there.
 */
export function resamplePolylineByCurvature(points: readonly Vec2[], count: number): readonly Vec2[] {
  const total = polylineLength(points);
  if (points.length < 3 || total < 1e-12) return resamplePolyline(points, count);
  const weights: number[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1]!;
    const b = points[index]!;
    const length = dist(a, b);
    let curvature = 0;
    const before = index >= 2 ? points[index - 2]! : undefined;
    const after = index + 1 < points.length ? points[index + 1]! : undefined;
    const turnAt = (p: Vec2, q: Vec2, r: Vec2): number => { const h1 = Math.atan2(q[1] - p[1], q[0] - p[0]); const h2 = Math.atan2(r[1] - q[1], r[0] - q[0]); let t = Math.abs(h2 - h1); if (t > Math.PI) t = 2 * Math.PI - t; return t / Math.max(1e-12, (dist(p, q) + dist(q, r)) / 2); };
    if (before !== undefined) curvature = Math.max(curvature, turnAt(before, a, b));
    if (after !== undefined) curvature = Math.max(curvature, turnAt(a, b, after));
    weights.push(length * (1 + Math.sqrt(curvature * total) / 2));
  }
  const cumulative: number[] = [0];
  for (const weight of weights) cumulative.push(cumulative[cumulative.length - 1]! + weight);
  const sum = cumulative[cumulative.length - 1]!;
  const result: Vec2[] = [points[0]!];
  let segment = 0;
  for (let index = 1; index < count - 1; index += 1) {
    const target = (sum * index) / (count - 1);
    while (segment < points.length - 2 && cumulative[segment + 1]! < target) segment += 1;
    const span = cumulative[segment + 1]! - cumulative[segment]!;
    const t = span < 1e-12 ? 0 : (target - cumulative[segment]!) / span;
    const a = points[segment]!;
    const b = points[segment + 1]!;
    result.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  result.push(points[points.length - 1]!);
  return result;
}

/**
 * The largest distance from a dense sample to the curve drawn through the fit points, stopping early once it passes `limit`.
 * Both run along the same path, so each sample is only compared with the part of the curve at about the same length fraction.
 */
function deviation(dense: readonly Vec2[], fit: readonly Vec2[], limit: number): number {
  const curve = catmullRomSamples(fit, 12);
  const curveLength: number[] = [0];
  for (let index = 1; index < curve.length; index += 1) curveLength.push(curveLength[index - 1]! + dist(curve[index - 1]!, curve[index]!));
  const curveTotal = curveLength[curveLength.length - 1]!;
  const denseLength: number[] = [0];
  for (let index = 1; index < dense.length; index += 1) denseLength.push(denseLength[index - 1]! + dist(dense[index - 1]!, dense[index]!));
  const denseTotal = denseLength[denseLength.length - 1]!;
  const window = Math.max(24, Math.ceil(curve.length / 8));
  let worst = 0;
  let center = 0;
  for (let at = 0; at < dense.length; at += 1) {
    const point = dense[at]!;
    const wanted = denseTotal < 1e-12 ? 0 : (denseLength[at]! / denseTotal) * curveTotal;
    while (center < curve.length - 2 && curveLength[center + 1]! < wanted) center += 1;
    let best = Infinity;
    for (let index = Math.max(0, center - window); index < Math.min(curve.length - 1, center + window); index += 1) {
      const from = curve[index]!;
      const to = curve[index + 1]!;
      const dx = to[0] - from[0];
      const dy = to[1] - from[1];
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared < 1e-18 ? 0 : Math.max(0, Math.min(1, ((point[0] - from[0]) * dx + (point[1] - from[1]) * dy) / lengthSquared));
      best = Math.min(best, Math.hypot(point[0] - (from[0] + dx * t), point[1] - (from[1] + dy * t)));
    }
    worst = Math.max(worst, best);
    if (worst > limit) return worst;
  }
  return worst;
}

/**
 * Fits fit-point splines (3 to 24 points each) through a dense polyline so each stays within `toleranceMm` of it. A curve that needs
 * more than 24 points is cut in two where it is long enough, so the pieces meet end to end. Returns the pieces as fit-point lists;
 * a piece that is straight comes back as two points (the caller makes a line).
 */
export function fitSplinePieces(dense: readonly Vec2[], toleranceMm: number, depth = 0): readonly (readonly Vec2[])[] {
  const cleaned = dense.filter((point, index) => index === 0 || dist(point, dense[index - 1]!) > 1e-9);
  if (cleaned.length < 2) return [];
  const length = polylineLength(cleaned);
  const chord = dist(cleaned[0]!, cleaned[cleaned.length - 1]!);
  if (length < MIN_GEOMETRY_MM) return [];
  const straight = cleaned.every((point) => Math.abs(cross(cleaned[0]!, cleaned[cleaned.length - 1]!, point)) <= toleranceMm * Math.max(chord, 1e-9));
  if (straight && chord > 1e-9) return [[cleaned[0]!, cleaned[cleaned.length - 1]!]];
  for (let count = 4; count <= 24; count += count < 8 ? 1 : 2) {
    const fit = resamplePolylineByCurvature(cleaned, count);
    if (fit.some((point, index) => index > 0 && dist(point, fit[index - 1]!) < MIN_GEOMETRY_MM)) continue;
    if (deviation(cleaned, fit, toleranceMm) <= toleranceMm) return [fit];
  }
  if (depth >= 4 || cleaned.length < 8) {
    const fit = resamplePolylineByCurvature(cleaned, 24);
    return [fit.filter((point, index) => index === 0 || dist(point, fit[index - 1]!) >= MIN_GEOMETRY_MM)];
  }
  // Cut at the point halfway along the curve.
  const half = polylineLength(cleaned) / 2;
  let walked = 0;
  let cut = 1;
  while (cut < cleaned.length - 1 && walked + dist(cleaned[cut - 1]!, cleaned[cut]!) < half) { walked += dist(cleaned[cut - 1]!, cleaned[cut]!); cut += 1; }
  return [...fitSplinePieces(cleaned.slice(0, cut + 1), toleranceMm, depth + 1), ...fitSplinePieces(cleaned.slice(cut), toleranceMm, depth + 1)];
}

/** Turns a dense polyline into curves: a line when it is straight, otherwise one or more fit-point splines. */
export function curvesFromDensePolyline(dense: readonly Vec2[], layer: string, toleranceMm: number, construction?: boolean): readonly RawCurve[] {
  const extra = construction === undefined ? {} : { construction };
  return fitSplinePieces(dense, toleranceMm).map((fit): RawCurve => fit.length === 2 ? { kind: "line", a: fit[0]!, b: fit[1]!, layer, ...extra } : { kind: "spline", fit, layer, ...extra });
}

// ---------------------------------------------------------------------------------------------------------------------
// Import planning
// ---------------------------------------------------------------------------------------------------------------------

export type ImportPlacement = "as-is" | "center" | "corner";

export interface DrawingImportOptions {
  /** Millimetres in one drawing unit: the scale the user confirmed. */
  readonly mmPerUnit: number;
  readonly placement?: ImportPlacement;
  /** Layers (DXF) or groups to leave out. */
  readonly skipLayers?: readonly string[];
  /** Layers whose curves become construction geometry. */
  readonly constructionLayers?: readonly string[];
  /** Every curve becomes construction geometry. */
  readonly allConstruction?: boolean;
  /** Ends closer than this are moved onto each other so loops close (default 0.005 mm). */
  readonly weldMm?: number;
  /** Fresh stable IDs. */
  readonly newId: (prefix: "entity") => string;
}

export interface DrawingImportSummary {
  readonly entityCount: number;
  readonly byKind: Readonly<Record<string, number>>;
  readonly droppedTiny: number;
  readonly droppedDuplicates: number;
  readonly welded: number;
  readonly widthMm: number;
  readonly heightMm: number;
  readonly shiftMm: Vec2;
  readonly warnings: readonly string[];
}

export interface DrawingImportPlan {
  readonly plans: readonly SketchEditPlan[];
  readonly summary: DrawingImportSummary;
}

const refuse = (message: string, recovery: string): WorkbenchResult<never> => failure("INVALID_OPERATION", message, [], recovery);

function scalePoint(point: Vec2, factor: number): Vec2 {
  return [point[0] * factor, point[1] * factor];
}

function extentOfCurve(curve: RawCurveShape): readonly Vec2[] {
  switch (curve.kind) {
    case "line": return [curve.a, curve.b];
    case "arc": return arcExtremePoints(curve.start, curve.mid, curve.end);
    case "circle": return [[curve.center[0] - curve.radius, curve.center[1] - curve.radius], [curve.center[0] + curve.radius, curve.center[1] + curve.radius]];
    case "ellipse": {
      const radians = (curve.rotationDeg * Math.PI) / 180;
      const hx = Math.hypot(curve.major * Math.cos(radians), curve.minor * Math.sin(radians));
      const hy = Math.hypot(curve.major * Math.sin(radians), curve.minor * Math.cos(radians));
      return [[curve.center[0] - hx, curve.center[1] - hy], [curve.center[0] + hx, curve.center[1] + hy]];
    }
    case "spline": return catmullRomSamples(curve.fit, 8);
    case "point": return [curve.at];
  }
}

/** The ends of an arc and the points where it crosses the axis directions (so its bounding box is right). */
export function arcExtremePoints(start: Vec2, mid: Vec2, end: Vec2): readonly Vec2[] {
  const d = 2 * (start[0] * (mid[1] - end[1]) + mid[0] * (end[1] - start[1]) + end[0] * (start[1] - mid[1]));
  if (Math.abs(d) < 1e-12) return [start, end];
  const s2 = start[0] ** 2 + start[1] ** 2;
  const m2 = mid[0] ** 2 + mid[1] ** 2;
  const e2 = end[0] ** 2 + end[1] ** 2;
  const cx = (s2 * (mid[1] - end[1]) + m2 * (end[1] - start[1]) + e2 * (start[1] - mid[1])) / d;
  const cy = (s2 * (end[0] - mid[0]) + m2 * (start[0] - end[0]) + e2 * (mid[0] - start[0])) / d;
  const radius = Math.hypot(start[0] - cx, start[1] - cy);
  const ccw = cross(start, mid, end) > 0;
  const a0 = Math.atan2(start[1] - cy, start[0] - cx);
  const raw = Math.atan2(end[1] - cy, end[0] - cx) - a0;
  const sweep = ccw ? ((raw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI) : -(((-raw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI));
  const points: Vec2[] = [start, end];
  for (let quarter = 0; quarter < 4; quarter += 1) {
    const angle = (quarter * Math.PI) / 2;
    const offset = ccw ? ((angle - a0) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) : -(((a0 - angle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI));
    if (Math.abs(offset) <= Math.abs(sweep)) points.push([cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)]);
  }
  return points;
}

interface Boundable { minX: number; minY: number; maxX: number; maxY: number }

function boundsOfCurves(curves: readonly RawCurveShape[]): Boundable | undefined {
  let box: Boundable | undefined;
  for (const curve of curves) {
    for (const point of extentOfCurve(curve)) {
      box = box === undefined ? { minX: point[0], minY: point[1], maxX: point[0], maxY: point[1] } : { minX: Math.min(box.minX, point[0]), minY: Math.min(box.minY, point[1]), maxX: Math.max(box.maxX, point[0]), maxY: Math.max(box.maxY, point[1]) };
    }
  }
  return box;
}

function moveCurve<T extends RawCurve>(curve: T, shift: (point: Vec2) => Vec2): T {
  switch (curve.kind) {
    case "line": return { ...curve, a: shift(curve.a), b: shift(curve.b) };
    case "arc": return { ...curve, start: shift(curve.start), mid: shift(curve.mid), end: shift(curve.end) };
    case "circle": return { ...curve, center: shift(curve.center) };
    case "ellipse": return { ...curve, center: shift(curve.center) };
    case "spline": return { ...curve, fit: curve.fit.map(shift) };
    case "point": return { ...curve, at: shift(curve.at) };
  }
}

/** Union of nearby ends: every end within `tolerance` of an earlier end is moved onto that earlier end. */
function weldEnds(curves: readonly RawCurve[], tolerance: number): { readonly curves: readonly RawCurve[]; readonly welded: number } {
  if (tolerance <= 0) return { curves, welded: 0 };
  const cell = Math.max(tolerance, 1e-6);
  const buckets = new Map<string, Vec2[]>();
  const key = (x: number, y: number): string => `${x},${y}`;
  let welded = 0;
  const snap = (point: Vec2): Vec2 => {
    const cx = Math.floor(point[0] / cell);
    const cy = Math.floor(point[1] / cell);
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (const candidate of buckets.get(key(cx + dx, cy + dy)) ?? []) {
          if (dist(candidate, point) <= tolerance) {
            if (candidate[0] !== point[0] || candidate[1] !== point[1]) welded += 1;
            return candidate;
          }
        }
      }
    }
    const list = buckets.get(key(cx, cy)) ?? [];
    list.push(point);
    buckets.set(key(cx, cy), list);
    return point;
  };
  const result = curves.map((curve): RawCurve => {
    switch (curve.kind) {
      case "line": return { ...curve, a: snap(curve.a), b: snap(curve.b) };
      case "arc": return { ...curve, start: snap(curve.start), end: snap(curve.end) };
      case "spline": return { ...curve, fit: [snap(curve.fit[0]!), ...curve.fit.slice(1, -1), snap(curve.fit[curve.fit.length - 1]!)] };
      default: return curve;
    }
  });
  return { curves: result, welded };
}

function nearSame(a: Vec2, b: Vec2, tolerance: number): boolean {
  return dist(a, b) <= tolerance;
}

/** Converts a curve (already in millimetres) to a valid sketch entity, or says why it cannot be one. */
function curveToEntity(curve: RawCurve, id: string, construction: boolean): SketchEntity | string {
  switch (curve.kind) {
    case "line":
      return dist(curve.a, curve.b) < MIN_GEOMETRY_MM ? "tiny" : { id, kind: "line", start: curve.a, end: curve.b, construction };
    case "arc": {
      if (Math.abs(cross(curve.start, curve.mid, curve.end)) >= 1e-4) return { id, kind: "arc", start: curve.start, mid: curve.mid, end: curve.end, construction };
      return dist(curve.start, curve.end) < MIN_GEOMETRY_MM ? "tiny" : { id, kind: "line", start: curve.start, end: curve.end, construction };
    }
    case "circle":
      return curve.radius < MIN_GEOMETRY_MM ? "tiny" : { id, kind: "circle", center: curve.center, radiusMm: curve.radius, construction };
    case "ellipse": {
      let { major, minor, rotationDeg } = curve;
      if (minor > major) { [major, minor] = [minor, major]; rotationDeg += 90; }
      if (minor < MIN_GEOMETRY_MM) return "tiny";
      if (Math.abs(major - minor) < 1e-9) return { id, kind: "circle", center: curve.center, radiusMm: major, construction };
      const wrapped = ((rotationDeg % 360) + 360) % 360;
      return { id, kind: "ellipse", center: curve.center, majorRadiusMm: major, minorRadiusMm: minor, rotationDeg: wrapped > 180 ? wrapped - 360 : wrapped, construction };
    }
    case "spline": {
      const fit = curve.fit.filter((point, index) => index === 0 || dist(point, curve.fit[index - 1]!) >= MIN_GEOMETRY_MM);
      if (fit.length >= 3) return { id, kind: "spline", fitPoints: fit.slice(0, SPLINE_MAX_FIT_POINTS), construction };
      return fit.length === 2 ? { id, kind: "line", start: fit[0]!, end: fit[1]!, construction } : "tiny";
    }
    case "point":
      return { id, kind: "point", point: curve.at, construction };
  }
}

function entityKey(entity: SketchEntity, tolerance: number): string {
  const q = (value: number): number => Math.round(value / Math.max(tolerance, 1e-6));
  const p = (point: Vec2): string => `${q(point[0])}:${q(point[1])}`;
  switch (entity.kind) {
    case "line": { const a = p(entity.start); const b = p(entity.end); return `line|${a < b ? a : b}|${a < b ? b : a}`; }
    case "arc": { const a = p(entity.start); const b = p(entity.end); return `arc|${a < b ? a : b}|${a < b ? b : a}|${p(entity.mid)}`; }
    case "circle": return `circle|${p(entity.center)}|${q(entity.radiusMm)}`;
    case "ellipse": return `ellipse|${p(entity.center)}|${q(entity.majorRadiusMm)}|${q(entity.minorRadiusMm)}|${q(entity.rotationDeg)}`;
    case "point": return `point|${p(entity.point)}`;
    case "spline": return `spline|${entity.fitPoints.map(p).join(">")}`;
    case "rectangle": return `rect|${p(entity.center)}`;
  }
}

/**
 * Turns parsed curves into sketch edit plans: scales to millimetres, places the drawing, welds ends, drops curves under the
 * 0.01 mm minimum and exact duplicates, and refuses with the real reason when the result cannot be a sketch (more curves than
 * the sketch can hold, coordinates beyond +-10 000 mm). Plans carry at most `IMPORT_CHUNK_SIZE` curves each.
 */
export function planDrawingImport(drawing: ParsedDrawing, sketch: WorkbenchSketch, options: DrawingImportOptions): WorkbenchResult<DrawingImportPlan> {
  const factor = options.mmPerUnit;
  if (!Number.isFinite(factor) || factor <= 0 || factor > 1e7) return refuse("The scale must be a positive number of millimetres per drawing unit.", "Choose the file's unit, or type the millimetres per unit.");
  const skip = new Set(options.skipLayers ?? []);
  const asConstruction = new Set(options.constructionLayers ?? []);
  const kept = drawing.curves.filter((curve) => !skip.has(curve.layer));
  if (kept.length === 0) return refuse(drawing.curves.length === 0 ? `The ${drawing.format.toUpperCase()} file has no lines, arcs, circles, ellipses, splines or points that can become sketch curves.` : "Every layer of the file is switched off.", "Choose a different file or switch a layer on.");
  let scaled = kept.map((curve): RawCurve => {
    switch (curve.kind) {
      case "line": return { ...curve, a: scalePoint(curve.a, factor), b: scalePoint(curve.b, factor) };
      case "arc": return { ...curve, start: scalePoint(curve.start, factor), mid: scalePoint(curve.mid, factor), end: scalePoint(curve.end, factor) };
      case "circle": return { ...curve, center: scalePoint(curve.center, factor), radius: curve.radius * factor };
      case "ellipse": return { ...curve, center: scalePoint(curve.center, factor), major: curve.major * factor, minor: curve.minor * factor };
      case "spline": return { ...curve, fit: curve.fit.map((point) => scalePoint(point, factor)) };
      case "point": return { ...curve, at: scalePoint(curve.at, factor) };
    }
  });
  const box = boundsOfCurves(scaled);
  if (box === undefined) return refuse("The file has no geometry.", "Choose a different file.");
  const widthMm = box.maxX - box.minX;
  const heightMm = box.maxY - box.minY;
  const placement = options.placement ?? "as-is";
  const shift: Vec2 = placement === "center" ? [-(box.minX + box.maxX) / 2, -(box.minY + box.maxY) / 2] : placement === "corner" ? [-box.minX, -box.minY] : [0, 0];
  if (shift[0] !== 0 || shift[1] !== 0) scaled = scaled.map((curve) => moveCurve(curve, (point) => [point[0] + shift[0], point[1] + shift[1]]));
  const placed = boundsOfCurves(scaled)!;
  const reach = Math.max(Math.abs(placed.minX), Math.abs(placed.maxX), Math.abs(placed.minY), Math.abs(placed.maxY));
  if (reach > SKETCH_COORDINATE_LIMIT_MM) {
    return refuse(
      `At ${factor} mm per unit the drawing is ${Math.round(widthMm * 100) / 100} x ${Math.round(heightMm * 100) / 100} mm and reaches ${Math.round(reach)} mm from the sketch origin; a sketch holds coordinates up to ${SKETCH_COORDINATE_LIMIT_MM} mm.`,
      placement === "as-is" && Math.max(widthMm, heightMm) <= 2 * SKETCH_COORDINATE_LIMIT_MM ? "Place the drawing at the origin (centre or corner), or check the scale." : "Check the scale: the drawing looks too large for the unit chosen."
    );
  }
  const tolerance = options.weldMm ?? 0.005;
  const welded = weldEnds(scaled, tolerance);
  const entities: SketchEntity[] = [];
  const seen = new Set<string>();
  let droppedTiny = 0;
  let droppedDuplicates = 0;
  for (const curve of welded.curves) {
    const construction = options.allConstruction === true || curve.construction === true || asConstruction.has(curve.layer);
    const entity = curveToEntity(curve, options.newId("entity"), construction);
    if (typeof entity === "string") { droppedTiny += 1; continue; }
    const key = entityKey(entity, tolerance);
    if (seen.has(key)) { droppedDuplicates += 1; continue; }
    seen.add(key);
    entities.push(entity);
  }
  if (entities.length === 0) return refuse("Every curve in the file is shorter than the 0.01 mm sketch minimum at this scale.", "Check the scale: the drawing looks too small for the unit chosen.");
  const free = SKETCH_ENTITY_LIMIT - sketch.entities.length;
  if (entities.length > free) {
    return refuse(
      `The file makes ${entities.length} sketch curves${droppedDuplicates > 0 ? ` (after removing ${droppedDuplicates} duplicates)` : ""}, but this sketch can hold ${SKETCH_ENTITY_LIMIT} curves in total and ${free} are free.`,
      sketch.entities.length > 0 ? "Import into an empty sketch, or simplify the drawing (fewer curves) before importing." : "Simplify the drawing (fewer curves, or fewer layers) before importing; the sketch limit is 500 curves."
    );
  }
  const byKind: Record<string, number> = {};
  for (const entity of entities) byKind[entity.kind] = (byKind[entity.kind] ?? 0) + 1;
  const parts = Math.ceil(entities.length / IMPORT_CHUNK_SIZE);
  const plans: SketchEditPlan[] = [];
  for (let part = 0; part < parts; part += 1) {
    plans.push({
      label: `Imported ${drawing.format.toUpperCase()}${parts > 1 ? ` (part ${part + 1} of ${parts})` : ""}: ${entities.slice(part * IMPORT_CHUNK_SIZE, (part + 1) * IMPORT_CHUNK_SIZE).length} curves`.slice(0, 80),
      removeEntityIds: [],
      updateEntities: [],
      addEntities: entities.slice(part * IMPORT_CHUNK_SIZE, (part + 1) * IMPORT_CHUNK_SIZE),
      addConstraints: []
    });
  }
  return {
    ok: true,
    value: {
      plans,
      summary: { entityCount: entities.length, byKind, droppedTiny, droppedDuplicates, welded: welded.welded, widthMm, heightMm, shiftMm: shift, warnings: drawing.warnings }
    }
  };
}

/** Helper for the readers: whether two points are the same within a tolerance. */
export function samePoint(a: Vec2, b: Vec2, tolerance = 1e-9): boolean {
  return nearSame(a, b, tolerance);
}

/** The arc through three points as centre, radius, and the angles of its ends (CCW from `startAngle` by `sweep`, which is negative for a clockwise arc). */
export function arcGeometry(start: Vec2, mid: Vec2, end: Vec2): { readonly center: Vec2; readonly radius: number; readonly startAngle: number; readonly sweep: number } | undefined {
  const d = 2 * (start[0] * (mid[1] - end[1]) + mid[0] * (end[1] - start[1]) + end[0] * (start[1] - mid[1]));
  if (Math.abs(d) < 1e-12) return undefined;
  const s2 = start[0] ** 2 + start[1] ** 2;
  const m2 = mid[0] ** 2 + mid[1] ** 2;
  const e2 = end[0] ** 2 + end[1] ** 2;
  const cx = (s2 * (mid[1] - end[1]) + m2 * (end[1] - start[1]) + e2 * (start[1] - mid[1])) / d;
  const cy = (s2 * (end[0] - mid[0]) + m2 * (start[0] - end[0]) + e2 * (mid[0] - start[0])) / d;
  const ccw = cross(start, mid, end) > 0;
  const a0 = Math.atan2(start[1] - cy, start[0] - cx);
  const raw = Math.atan2(end[1] - cy, end[0] - cx) - a0;
  const full = 2 * Math.PI;
  const sweep = ccw ? ((raw % full) + full) % full : -(((-raw % full) + full) % full);
  return { center: [cx, cy], radius: Math.hypot(start[0] - cx, start[1] - cy), startAngle: a0, sweep };
}

/** Three points of an arc from its centre, radius, start angle and signed sweep (radians). */
export function arcFromAngles(center: Vec2, radius: number, startAngle: number, sweep: number): { readonly start: Vec2; readonly mid: Vec2; readonly end: Vec2 } {
  const at = (angle: number): Vec2 => [center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)];
  return { start: at(startAngle), mid: at(startAngle + sweep / 2), end: at(startAngle + sweep) };
}
