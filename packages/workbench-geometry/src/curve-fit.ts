/**
 * Recognises sketch curves in a chain of points. A tessellated body hands over polylines (a circular rim is 72 short
 * segments); this turns each polyline back into the fewest honest sketch curves: straight lines, circular arcs, whole
 * circles and ellipses, and a spline for a smooth run that is none of those. Pure 2D geometry, no project state.
 */

export type Pt = readonly [number, number];

export type FitPrimitive =
  | { readonly kind: "line"; readonly a: Pt; readonly b: Pt }
  | { readonly kind: "arc"; readonly start: Pt; readonly mid: Pt; readonly end: Pt }
  | { readonly kind: "circle"; readonly center: Pt; readonly radiusMm: number }
  | { readonly kind: "ellipse"; readonly center: Pt; readonly majorRadiusMm: number; readonly minorRadiusMm: number; readonly rotationDeg: number }
  | { readonly kind: "spline"; readonly points: readonly Pt[] };

export interface FitOptions {
  /** The chain ends where it starts. Its points then do not repeat the first point at the end. */
  readonly closed: boolean;
  /** How far a point may sit from a fitted curve and still count as on it. Defaults to 0.002 mm. */
  readonly toleranceMm?: number;
}

const DEFAULT_TOLERANCE_MM = 0.002;
/** A closed chain needs at least this many corners before it is read as a circle or ellipse, so a hexagon stays a hexagon. */
const MIN_ROUND_POINTS = 20;
/** The largest turn between two segments that still reads as a smooth curve rather than a corner. */
const SMOOTH_TURN_RAD = (25 * Math.PI) / 180;
/** Neighbouring facets of one smooth curve are about the same length. */
const SMOOTH_LENGTH_RATIO = 3;
/** Where a run bends more than this at a vertex it is a polygon, so a square's corners never read as a quarter of a circle. */
const MAX_ARC_TURN_RAD = (30 * Math.PI) / 180;
/** The facets of one tessellated arc are about the same length; a much longer piece is a line that happens to touch it. */
const ARC_FACET_RATIO = 1.6;
const MAX_SPLINE_POINTS = 24;
const MIN_SPLINE_SEGMENTS = 6;
/** A run of at most this many facets is short enough to be one piece of a longer smooth curve. */
const SHORT_RUN_FACETS = 8;

const distance = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

function distanceToLine(point: Pt, a: Pt, b: Pt): number {
  const length = distance(a, b);
  if (length < 1e-12) return distance(point, a);
  return Math.abs((b[0] - a[0]) * (a[1] - point[1]) - (a[0] - point[0]) * (b[1] - a[1])) / length;
}

function dropRepeats(points: readonly Pt[], closed: boolean): Pt[] {
  const out: Pt[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last === undefined || distance(last, point) > 1e-7) out.push(point);
  }
  while (closed && out.length > 1 && distance(out[0]!, out[out.length - 1]!) <= 1e-7) out.pop();
  return out;
}

/**
 * Drops points that lie on the straight line between their neighbours. A cut through the quads of a round face leaves such points
 * in the middle of each facet, and they would pull a fitted circle off the true corners.
 */
function dropCollinear(points: readonly Pt[], closed: boolean): Pt[] {
  const n = points.length;
  return points.filter((point, index) => {
    if (!closed && (index === 0 || index === n - 1)) return true;
    const before = points[(index + n - 1) % n]!;
    const after = points[(index + 1) % n]!;
    const along = (point[0] - before[0]) * (after[0] - before[0]) + (point[1] - before[1]) * (after[1] - before[1]);
    const span = (after[0] - before[0]) ** 2 + (after[1] - before[1]) ** 2;
    return !(span > 1e-12 && along > 0 && along < span && distanceToLine(point, before, after) <= 2e-4);
  });
}

/** Fits a chain of points to curves. Open chains return their curves in order; a closed chain returns a ring of curves. */
export function fitPolyline(input: readonly Pt[], options: FitOptions): FitPrimitive[] {
  const tolerance = options.toleranceMm ?? DEFAULT_TOLERANCE_MM;
  const points = dropCollinear(dropRepeats(input, options.closed), options.closed);
  if (points.length < 2) return [];
  if (!options.closed) return primitivesOf(points, segmentOpen(points, tolerance));
  if (points.length < 3) return [{ kind: "line", a: points[0]!, b: points[1]! }];
  const flat = flatLoop(points, tolerance);
  if (flat !== undefined) return [flat];
  if (points.length >= MIN_ROUND_POINTS && windsOnce(points)) {
    const circle = fitCircleLoop(points, tolerance);
    if (circle !== undefined) return [circle];
    const ellipse = fitEllipseLoop(points, tolerance);
    if (ellipse !== undefined) return [ellipse];
  }
  return segmentClosed(points, tolerance);
}

/** A closed chain that has no width, such as a circle seen edge-on, is one line between its extremes. */
function flatLoop(points: readonly Pt[], tolerance: number): FitPrimitive | undefined {
  const far = (from: Pt): Pt => points.reduce((best, point) => (distance(point, from) > distance(best, from) ? point : best), from);
  const b = far(points[0]!);
  const c = far(b);
  if (distance(b, c) <= tolerance * 2) return undefined;
  return points.every((point) => distanceToLine(point, b, c) <= tolerance) ? { kind: "line", a: b, b: c } : undefined;
}

// ---------------------------------------------------------------------------------------------
// Circles and ellipses (closed chains)
// ---------------------------------------------------------------------------------------------

/** Least-squares circle through points (Kasa), or undefined when the points are in a line. */
function fitCircle(points: readonly Pt[]): { readonly center: Pt; readonly radius: number } | undefined {
  const n = points.length;
  if (n < 3) return undefined;
  let mx = 0;
  let my = 0;
  for (const p of points) { mx += p[0]; my += p[1]; }
  mx /= n;
  my /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of points) {
    const u = p[0] - mx;
    const v = p[1] - my;
    suu += u * u; suv += u * v; svv += v * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-12 * Math.max(1, suu * svv)) return undefined;
  const bu = 0.5 * (suuu + suvv);
  const bv = 0.5 * (svvv + svuu);
  const uc = (bu * svv - bv * suv) / det;
  const vc = (bv * suu - bu * suv) / det;
  const radius = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  return Number.isFinite(radius) ? { center: [mx + uc, my + vc], radius } : undefined;
}

const circleResidual = (points: readonly Pt[], circle: { readonly center: Pt; readonly radius: number }): number =>
  points.reduce((worst, point) => Math.max(worst, Math.abs(distance(point, circle.center) - circle.radius)), 0);

/** True when walking the points goes once round their centre in one direction, in modest steps. */
function windsOnce(points: readonly Pt[]): boolean {
  const n = points.length;
  let cx = 0;
  let cy = 0;
  for (const p of points) { cx += p[0]; cy += p[1]; }
  cx /= n;
  cy /= n;
  let total = 0;
  let sign = 0;
  for (let i = 0; i < n; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    const step = Math.atan2((a[0] - cx) * (b[1] - cy) - (a[1] - cy) * (b[0] - cx), (a[0] - cx) * (b[0] - cx) + (a[1] - cy) * (b[1] - cy));
    if (step === 0 || (sign !== 0 && Math.sign(step) !== sign)) return false;
    sign = Math.sign(step);
    total += step;
  }
  return Math.abs(Math.abs(total) - 2 * Math.PI) < 0.05;
}

function fitCircleLoop(points: readonly Pt[], tolerance: number): FitPrimitive | undefined {
  const circle = fitCircle(points);
  if (circle === undefined || circle.radius < tolerance * 4) return undefined;
  if (circleResidual(points, circle) > Math.max(tolerance, 2e-4 * circle.radius)) return undefined;
  return { kind: "circle", center: circle.center, radiusMm: circle.radius };
}

/** Solves the small dense system a·x = b by Gaussian elimination with pivoting; undefined when it is singular. */
function solveLinear(a: number[][], b: number[]): number[] | undefined {
  const n = b.length;
  for (let column = 0; column < n; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < n; row += 1) if (Math.abs(a[row]![column]!) > Math.abs(a[pivot]![column]!)) pivot = row;
    if (Math.abs(a[pivot]![column]!) < 1e-14) return undefined;
    [a[column], a[pivot]] = [a[pivot]!, a[column]!];
    [b[column], b[pivot]] = [b[pivot]!, b[column]!];
    for (let row = column + 1; row < n; row += 1) {
      const factor = a[row]![column]! / a[column]![column]!;
      for (let k = column; k < n; k += 1) a[row]![k] = a[row]![k]! - factor * a[column]![k]!;
      b[row] = b[row]! - factor * b[column]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let row = n - 1; row >= 0; row -= 1) {
    let sum = b[row]!;
    for (let k = row + 1; k < n; k += 1) sum -= a[row]![k]! * x[k]!;
    x[row] = sum / a[row]![row]!;
  }
  return x;
}

/** Least-squares ellipse through a closed chain (a conic A·x² + B·xy + C·y² + D·x + E·y = 1 about the centroid), checked point by point. */
function fitEllipseLoop(points: readonly Pt[], tolerance: number): FitPrimitive | undefined {
  const n = points.length;
  let mx = 0;
  let my = 0;
  for (const p of points) { mx += p[0]; my += p[1]; }
  mx /= n;
  my /= n;
  let scale = 0;
  for (const p of points) scale += (p[0] - mx) ** 2 + (p[1] - my) ** 2;
  scale = Math.sqrt(scale / n);
  if (scale < tolerance * 4) return undefined;
  const rows = points.map((p): number[] => {
    const x = (p[0] - mx) / scale;
    const y = (p[1] - my) / scale;
    return [x * x, x * y, y * y, x, y];
  });
  const normal = Array.from({ length: 5 }, () => new Array<number>(5).fill(0));
  const rhs = new Array<number>(5).fill(0);
  for (const row of rows) {
    for (let i = 0; i < 5; i += 1) {
      rhs[i] = rhs[i]! + row[i]!;
      for (let j = 0; j < 5; j += 1) normal[i]![j] = normal[i]![j]! + row[i]! * row[j]!;
    }
  }
  const solved = solveLinear(normal, rhs);
  if (solved === undefined) return undefined;
  const [A, B, C, D, E] = solved as [number, number, number, number, number];
  const determinant = 4 * A * C - B * B;
  if (!(determinant > 1e-12)) return undefined;
  // The centre is where the gradient vanishes.
  const cx = (B * E - 2 * C * D) / determinant;
  const cy = (B * D - 2 * A * E) / determinant;
  const k = 1 - (A * cx * cx + B * cx * cy + C * cy * cy + D * cx + E * cy);
  if (!(k > 1e-12)) return undefined;
  // Eigen-decompose the quadratic form [[A, B/2], [B/2, C]].
  const trace = A + C;
  const delta = Math.hypot(A - C, B);
  const small = (trace - delta) / 2;
  const large = (trace + delta) / 2;
  if (!(small > 0)) return undefined;
  const major = Math.sqrt(k / small) * scale;
  const minor = Math.sqrt(k / large) * scale;
  // The direction that maximises the form is the minor axis; the major axis is a quarter turn from it.
  const angle = 0.5 * Math.atan2(B, A - C) + Math.PI / 2;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const center: Pt = [mx + cx * scale, my + cy * scale];
  let worst = 0;
  for (const p of points) {
    const x = p[0] - center[0];
    const y = p[1] - center[1];
    const localX = x * cos + y * sin;
    const localY = -x * sin + y * cos;
    const q = Math.hypot(localX / major, localY / minor);
    const slope = Math.hypot(localX / (major * major), localY / (minor * minor)) / Math.max(q, 1e-12);
    worst = Math.max(worst, slope < 1e-12 ? Infinity : Math.abs(q - 1) / slope);
  }
  if (worst > Math.max(tolerance * 2, 2e-4 * major) || minor < 0.01) return undefined;
  let rotationDeg = (angle * 180) / Math.PI;
  while (rotationDeg > 180) rotationDeg -= 360;
  while (rotationDeg <= -180) rotationDeg += 360;
  return { kind: "ellipse", center, majorRadiusMm: major, minorRadiusMm: Math.min(minor, major), rotationDeg };
}

// ---------------------------------------------------------------------------------------------
// Lines and arcs (open chains, or closed chains cut open at a seam between two curves)
// ---------------------------------------------------------------------------------------------

interface Run {
  readonly kind: "line" | "arc" | "spline";
  readonly from: number;
  readonly to: number;
}

/** Last index of the straight run that starts at `from`: every point in between lies within tolerance of the chord. */
function extendLine(p: readonly Pt[], from: number, last: number, tolerance: number): number {
  let end = from + 1;
  while (end + 1 <= last) {
    const candidate = end + 1;
    const a = p[from]!;
    const b = p[candidate]!;
    const direction: Pt = [b[0] - a[0], b[1] - a[1]];
    let straight = true;
    for (let t = from + 1; t < candidate && straight; t += 1) {
      const step: Pt = [p[t]![0] - p[t - 1]![0], p[t]![1] - p[t - 1]![1]];
      straight = distanceToLine(p[t]!, a, b) <= tolerance && step[0] * direction[0] + step[1] * direction[1] > 0;
    }
    const lastStep: Pt = [b[0] - p[candidate - 1]![0], b[1] - p[candidate - 1]![1]];
    if (!straight || lastStep[0] * direction[0] + lastStep[1] * direction[1] <= 0) break;
    end = candidate;
  }
  return end;
}

const turnOf = (a: Pt, b: Pt, c: Pt): number => (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
/** The size of the bend at b, in radians. */
const bendAt = (a: Pt, b: Pt, c: Pt): number => Math.abs(Math.atan2(turnOf(a, b, c), (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1])));

/** Last index of the circular-arc run that starts at `from` (at least three segments), or 0 when no arc starts there. */
function extendArc(p: readonly Pt[], from: number, last: number, tolerance: number): number {
  if (last - from < 3) return 0;
  for (let seedEnd = Math.min(from + 5, last); seedEnd >= from + 3; seedEnd -= 1) {
    const seed = p.slice(from, seedEnd + 1);
    const circle = fitCircle(seed);
    if (circle === undefined || circle.radius > 1e6 || circle.radius < tolerance * 4) continue;
    if (circleResidual(seed, circle) > Math.max(tolerance, 2e-4 * circle.radius)) continue;
    const side = Math.sign(turnOf(p[from]!, p[from + 1]!, p[from + 2]!));
    if (side === 0) continue;
    let gentle = true;
    for (let t = from + 1; t < seedEnd; t += 1) if (Math.sign(turnOf(p[t - 1]!, p[t]!, p[t + 1]!)) !== side || bendAt(p[t - 1]!, p[t]!, p[t + 1]!) > MAX_ARC_TURN_RAD) gentle = false;
    if (!gentle) continue;
    const seedLengths = seed.slice(1).map((point, index) => distance(point, seed[index]!)).sort((a, b) => a - b);
    const typical = seedLengths[Math.floor(seedLengths.length / 2)]!;
    if (seedLengths[seedLengths.length - 1]! > typical * ARC_FACET_RATIO) continue;
    const onArc = (index: number, fit: { readonly center: Pt; readonly radius: number }): boolean => {
      const point = p[index]!;
      if (Math.abs(distance(point, fit.center) - fit.radius) > Math.max(tolerance, 2e-4 * fit.radius)) return false;
      if (distance(p[index - 1]!, point) > typical * ARC_FACET_RATIO) return false;
      if (index - 1 > from && (Math.sign(turnOf(p[index - 2]!, p[index - 1]!, point)) !== side || bendAt(p[index - 2]!, p[index - 1]!, point) > MAX_ARC_TURN_RAD)) return false;
      const before = p[index - 1]!;
      const step = Math.abs(Math.atan2((before[0] - fit.center[0]) * (point[1] - fit.center[1]) - (before[1] - fit.center[1]) * (point[0] - fit.center[0]), (before[0] - fit.center[0]) * (point[0] - fit.center[0]) + (before[1] - fit.center[1]) * (point[1] - fit.center[1])));
      return step <= Math.PI / 2;
    };
    let end = seedEnd;
    while (end + 1 <= last && onArc(end + 1, circle)) end += 1;
    // Refit on everything the run took in, and give back points from the end until it holds.
    while (end >= from + 3) {
      const refit = fitCircle(p.slice(from, end + 1));
      if (refit !== undefined && refit.radius < 1e6 && circleResidual(p.slice(from, end + 1), refit) <= Math.max(tolerance, 2e-4 * refit.radius) && sweepOf(p, from, end, refit.center) < 2 * Math.PI - 0.05) return end;
      end -= 1;
    }
  }
  return 0;
}

function sweepOf(p: readonly Pt[], from: number, to: number, center: Pt): number {
  let total = 0;
  for (let i = from + 1; i <= to; i += 1) {
    const a = p[i - 1]!;
    const b = p[i]!;
    total += Math.atan2((a[0] - center[0]) * (b[1] - center[1]) - (a[1] - center[1]) * (b[0] - center[0]), (a[0] - center[0]) * (b[0] - center[0]) + (a[1] - center[1]) * (b[1] - center[1]));
  }
  return Math.abs(total);
}

function segmentOpenRuns(p: readonly Pt[], tolerance: number): Run[] {
  const last = p.length - 1;
  const runs: Run[] = [];
  let at = 0;
  while (at < last) {
    const lineEnd = extendLine(p, at, last, tolerance);
    const arcEnd = extendArc(p, at, last, tolerance);
    if (arcEnd > lineEnd) { runs.push({ kind: "arc", from: at, to: arcEnd }); at = arcEnd; } else { runs.push({ kind: "line", from: at, to: lineEnd }); at = lineEnd; }
  }
  return runs;
}

/**
 * Turns a stretch of short, gently bending runs (lines and small arcs) into one spline. A smooth curve that is no circle, such as an
 * ellipse arc or a wave, is cut by the fitter into many short arcs that each fit within tolerance; the honest curve is one spline.
 * A long arc, a long line, or a corner ends the stretch, so rounded rectangles and slots keep their lines and arcs.
 */
function mergeSmoothRuns(p: readonly Pt[], runs: readonly Run[]): Run[] {
  const facets = (run: Run): number => run.to - run.from;
  const mean = (run: Run): number => {
    let total = 0;
    for (let i = run.from + 1; i <= run.to; i += 1) total += distance(p[i - 1]!, p[i]!);
    return total / facets(run);
  };
  const out: Run[] = [];
  let index = 0;
  while (index < runs.length) {
    const first = runs[index]!;
    let stop = index;
    if (facets(first) <= SHORT_RUN_FACETS) {
      while (stop + 1 < runs.length) {
        const here = runs[stop]!;
        const next = runs[stop + 1]!;
        if (facets(next) > SHORT_RUN_FACETS) break;
        if (bendAt(p[here.to - 1]!, p[here.to]!, p[next.from + 1]!) > SMOOTH_TURN_RAD) break;
        // A long straight piece next to short facets is a line that happens to be tangent, not part of the curve.
        const ratio = mean(next) / mean(here);
        if (ratio > SMOOTH_LENGTH_RATIO || ratio < 1 / SMOOTH_LENGTH_RATIO) break;
        stop += 1;
      }
    }
    const total = runs[stop]!.to - first.from;
    if (stop > index && total >= MIN_SPLINE_SEGMENTS) out.push({ kind: "spline", from: first.from, to: runs[stop]!.to });
    else { out.push(first); stop = index; }
    index = stop + 1;
  }
  return out;
}

function segmentOpen(p: readonly Pt[], tolerance: number): Run[] {
  return mergeSmoothRuns(p, segmentOpenRuns(p, tolerance));
}

function primitivesOf(p: readonly Pt[], runs: readonly Run[]): FitPrimitive[] {
  return runs.map((run): FitPrimitive => {
    if (run.kind === "line") return { kind: "line", a: p[run.from]!, b: p[run.to]! };
    if (run.kind === "arc") return { kind: "arc", start: p[run.from]!, mid: p[Math.round((run.from + run.to) / 2)]!, end: p[run.to]! };
    const count = run.to - run.from + 1;
    const picked = count <= MAX_SPLINE_POINTS ? Array.from({ length: count }, (_, k) => run.from + k) : Array.from({ length: MAX_SPLINE_POINTS }, (_, k) => run.from + Math.round((k * (count - 1)) / (MAX_SPLINE_POINTS - 1)));
    return { kind: "spline", points: picked.map((index) => p[index]!) };
  });
}

/** A closed chain is cut open where the first curve ends, so no curve is split by the seam, then fitted as an open chain. */
function segmentClosed(points: readonly Pt[], tolerance: number): FitPrimitive[] {
  const openFrom = (list: readonly Pt[]): Pt[] => [...list, list[0]!];
  const first = segmentOpen(openFrom(points), tolerance);
  let list = points;
  let runs = first;
  if (first.length > 1) {
    const seam = first[0]!.to;
    list = [...points.slice(seam), ...points.slice(0, seam)];
    runs = segmentOpen(openFrom(list), tolerance);
  }
  const p = openFrom(list);
  if (runs.length === 1 && runs[0]!.kind !== "line") {
    // One curve that closes on itself cannot bound a profile on its own; cut it in two.
    const run = runs[0]!;
    const half = Math.floor((run.from + run.to) / 2);
    if (half - run.from >= (run.kind === "arc" ? 2 : 1) && run.to - half >= (run.kind === "arc" ? 2 : 1)) runs = [{ kind: run.kind, from: run.from, to: half }, { kind: run.kind, from: half, to: run.to }];
  }
  return primitivesOf(p, runs);
}
