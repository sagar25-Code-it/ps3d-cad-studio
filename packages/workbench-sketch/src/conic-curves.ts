import { MODEL_ENVELOPE, type SketchEntity, type Vec2, type WorkbenchResult } from "../../workbench-core/src/index.js";
import { add, badShape, dist, dot, lerp, normalize, resampleByLength, sampleCurveToFitPoints, scale, splineFromPoints, sub, turn, type ShapeIds, type SketchShape } from "./curve-math.js";

/**
 * Control-point splines and conic sections. Every curve here is stored as a fit-point spline (or, for a closed
 * conic, an ellipse entity), so profile detection, extrusion, export and the solver need no new entity kind.
 */

// ---------------------------------------------------------------- control-point (B-spline) curves

export const CONTROL_SPLINE_MIN_POINTS = 3;
export const CONTROL_SPLINE_MAX_POINTS = 64;

/** Evaluates a B-spline of the given degree at u (de Boor). Knots must be non-decreasing with degree + 1 repeated ends. */
function deBoor(controls: readonly Vec2[], degree: number, knots: readonly number[], u: number): Vec2 {
  const count = controls.length;
  let span = degree;
  while (span < count - 1 && u >= knots[span + 1]!) span += 1;
  const work: Vec2[] = [];
  for (let index = 0; index <= degree; index += 1) work.push(controls[span - degree + index]!);
  for (let r = 1; r <= degree; r += 1) {
    for (let j = degree; j >= r; j -= 1) {
      const i = j + span - degree;
      const denominator = knots[i + degree - r + 1]! - knots[i]!;
      const alpha = denominator === 0 ? 0 : (u - knots[i]!) / denominator;
      work[j] = lerp(work[j - 1]!, work[j]!, alpha);
    }
  }
  return work[degree]!;
}

/** The smooth curve a control polygon defines, as a dense polyline. Open curves are clamped: they start and end on the first and last control point. */
export function controlPointCurve(controls: readonly Vec2[], closed: boolean, samples = 400): readonly Vec2[] {
  const count = controls.length;
  if (closed) {
    // Uniform periodic cubic B-spline: every control point pulls on four spans and the curve never meets the polygon.
    const dense: Vec2[] = [];
    const perSpan = Math.max(8, Math.ceil(samples / count));
    for (let span = 0; span < count; span += 1) {
      const p0 = controls[span % count]!;
      const p1 = controls[(span + 1) % count]!;
      const p2 = controls[(span + 2) % count]!;
      const p3 = controls[(span + 3) % count]!;
      for (let step = 0; step < perSpan; step += 1) {
        const t = step / perSpan;
        const t2 = t * t;
        const t3 = t2 * t;
        const b0 = (1 - t) ** 3 / 6;
        const b1 = (3 * t3 - 6 * t2 + 4) / 6;
        const b2 = (-3 * t3 + 3 * t2 + 3 * t + 1) / 6;
        const b3 = t3 / 6;
        dense.push([b0 * p0[0] + b1 * p1[0] + b2 * p2[0] + b3 * p3[0], b0 * p0[1] + b1 * p1[1] + b2 * p2[1] + b3 * p3[1]]);
      }
    }
    dense.push(dense[0]!);
    return dense;
  }
  const degree = Math.min(3, count - 1);
  const interior = count - degree - 1;
  const knots = [...Array.from({ length: degree + 1 }, () => 0), ...Array.from({ length: interior }, (_, index) => (index + 1) / (interior + 1)), ...Array.from({ length: degree + 1 }, () => 1)];
  const dense: Vec2[] = [];
  for (let index = 0; index <= samples; index += 1) dense.push(deBoor(controls, degree, knots, index / samples));
  // The curve ends exactly on the end control points.
  dense[0] = controls[0]!;
  dense[dense.length - 1] = controls[count - 1]!;
  return dense;
}

/**
 * Control-point spline. An open one becomes one spline that starts and ends on the first and last control point. A closed
 * one is cut into two splines that meet at two points, because a loop needs at least two curves to be recognised as a
 * profile; together they enclose the same region. The control polygon can be kept as construction lines.
 */
export function buildControlPointSpline(controls: readonly Vec2[], closed: boolean, keepPolygon: boolean, ids: ShapeIds): WorkbenchResult<SketchShape> {
  if (controls.length < CONTROL_SPLINE_MIN_POINTS) return badShape(`A control-point spline needs at least ${CONTROL_SPLINE_MIN_POINTS} control points.`);
  if (controls.length > CONTROL_SPLINE_MAX_POINTS) return badShape(`A control-point spline takes at most ${CONTROL_SPLINE_MAX_POINTS} control points.`);
  if (controls.some((point, index) => index > 0 && dist(controls[index - 1]!, point) < 0.05)) return badShape("Consecutive control points must be at least 0.05 mm apart.");
  const dense = controlPointCurve(controls, closed);
  const entities: SketchEntity[] = [];
  const fitCount = Math.min(24, Math.max(10, 4 * controls.length));
  if (!closed) {
    const spline = splineFromPoints(resampleByLength(dense, fitCount, 0.25), ids.entity());
    if (!spline.ok) return spline;
    entities.push(spline.value);
  } else {
    // Split the loop at the start point and at the point half-way round by length.
    let total = 0;
    const lengths: number[] = [0];
    for (let index = 1; index < dense.length; index += 1) {
      total += dist(dense[index - 1]!, dense[index]!);
      lengths.push(total);
    }
    let half = lengths.findIndex((length) => length >= total / 2);
    if (half < 1) half = Math.floor(dense.length / 2);
    const firstHalf = dense.slice(0, half + 1);
    const secondHalf = [...dense.slice(half, dense.length - 1), dense[0]!];
    for (const run of [firstHalf, secondHalf]) {
      const spline = splineFromPoints(resampleByLength(run, Math.min(24, Math.max(12, 2 * controls.length)), 0.25), ids.entity());
      if (!spline.ok) return spline;
      entities.push(spline.value);
    }
  }
  if (keepPolygon) {
    const count = closed ? controls.length : controls.length - 1;
    for (let index = 0; index < count; index += 1) {
      entities.push({ id: ids.entity(), kind: "line", start: controls[index]!, end: controls[(index + 1) % controls.length]!, construction: true });
    }
  }
  return { ok: true, value: { entities, constraints: [] } };
}

// ---------------------------------------------------------------- conics from tangent geometry

/**
 * Conics are stored as fit-point splines. With 32 points crowded where the curve bends (see sampleCurveToFitPoints) the
 * spline stays within 0.01 mm of the exact conic over a 60 mm span for every rho from 0.02 to 0.98; 24 evenly spaced
 * points were off by up to 0.9 mm at rho 0.98.
 */
export const CONIC_FIT_POINTS = 32;
const CONIC_CURVATURE_BIAS = 2;
const CONIC_DENSE_SAMPLES = 960;

export const CONIC_RHO_MIN = 0.02;
export const CONIC_RHO_MAX = 0.98;

/** A point on the conic arc with end points p0 and p2, tangent-intersection point p1 and shoulder ratio rho, at parameter t in [0, 1]. */
export function conicArcPoint(p0: Vec2, p1: Vec2, p2: Vec2, rho: number, t: number): Vec2 {
  const w = rho / (1 - rho);
  const b0 = (1 - t) * (1 - t);
  const b1 = 2 * w * t * (1 - t);
  const b2 = t * t;
  const sum = b0 + b1 + b2;
  return [(b0 * p0[0] + b1 * p1[0] + b2 * p2[0]) / sum, (b0 * p0[1] + b1 * p1[1] + b2 * p2[1]) / sum];
}

/**
 * Conic arc by rho: start, end and the point where the two end tangents meet (the apex), with rho the ratio that places
 * the curve's shoulder between the chord's midpoint (0) and the apex (1). Rho below 0.5 is an ellipse arc, exactly 0.5 a
 * parabola and above 0.5 a hyperbola arc.
 */
export function buildConicByRho(start: Vec2, end: Vec2, apex: Vec2, rho: number, ids: ShapeIds): WorkbenchResult<SketchShape> {
  if (!Number.isFinite(rho) || rho < CONIC_RHO_MIN || rho > CONIC_RHO_MAX) return badShape(`Rho must be between ${CONIC_RHO_MIN} and ${CONIC_RHO_MAX}: below 0.5 is an ellipse, 0.5 a parabola, above 0.5 a hyperbola.`, "Type a rho between 0.02 and 0.98.");
  if (dist(start, end) < 0.1) return badShape("The conic's two ends must be at least 0.1 mm apart.");
  if (Math.abs(turn(start, apex, end)) < 0.05 * Math.max(1, dist(start, end))) return badShape("The tangent-intersection point is in line with the two ends: place it away from the chord so the curve has a bulge.");
  const fit = sampleCurveToFitPoints((t) => conicArcPoint(start, apex, end, rho, t), 0, 1, CONIC_FIT_POINTS, CONIC_DENSE_SAMPLES, 0, CONIC_CURVATURE_BIAS);
  const spline = splineFromPoints(fit, ids.entity());
  return spline.ok ? { ok: true, value: { entities: [spline.value], constraints: [] } } : spline;
}

/** Parabola arc: the rho = 1/2 conic. */
export function buildParabola(start: Vec2, end: Vec2, apex: Vec2, ids: ShapeIds): WorkbenchResult<SketchShape> {
  return buildConicByRho(start, end, apex, 0.5, ids);
}

/**
 * Hyperbola branch from its centre, a vertex (which sets the transverse axis and the semi-axis a) and one point on the
 * branch (which sets the semi-axis b). The curve runs from that point through the vertex to its mirror image.
 */
export function buildHyperbola(center: Vec2, vertex: Vec2, branchPoint: Vec2, ids: ShapeIds): WorkbenchResult<SketchShape> {
  const a = dist(center, vertex);
  if (a < 0.1) return badShape("A hyperbola's vertex must be at least 0.1 mm from its centre.");
  const axis = normalize(sub(vertex, center));
  const normal: Vec2 = [-axis[1], axis[0]];
  const rel = sub(branchPoint, center);
  const x = dot(rel, axis);
  const y = dot(rel, normal);
  if (x <= a * 1.0001) return badShape("The branch point must lie beyond the vertex on the same side of the centre, so the branch opens away from it.");
  if (Math.abs(y) < 0.05) return badShape("The branch point is on the axis: move it sideways so the branch has a width.");
  const b = Math.abs(y) / Math.sqrt((x * x) / (a * a) - 1);
  const tEnd = Math.asinh(Math.abs(y) / b);
  const curve = (t: number): Vec2 => add(center, add(scale(axis, a * Math.cosh(t)), scale(normal, b * Math.sinh(t))));
  const fit = sampleCurveToFitPoints(curve, -tEnd, tEnd, CONIC_FIT_POINTS, CONIC_DENSE_SAMPLES, 0, CONIC_CURVATURE_BIAS);
  const spline = splineFromPoints(fit, ids.entity());
  return spline.ok ? { ok: true, value: { entities: [spline.value], constraints: [] } } : spline;
}

// ---------------------------------------------------------------- general conic through five points

/** Null vector of a 5 x 6 matrix by Gauss-Jordan elimination, or undefined when its rank is below five. */
function nullVector(rows: readonly (readonly number[])[]): readonly number[] | undefined {
  const m = rows.map((row) => [...row]);
  const pivots: number[] = [];
  let row = 0;
  for (let col = 0; col < 6 && row < m.length; col += 1) {
    let best = row;
    for (let r = row + 1; r < m.length; r += 1) if (Math.abs(m[r]![col]!) > Math.abs(m[best]![col]!)) best = r;
    if (Math.abs(m[best]![col]!) < 1e-9) continue;
    [m[row], m[best]] = [m[best]!, m[row]!];
    const pivot = m[row]![col]!;
    for (let c = 0; c < 6; c += 1) m[row]![c] = m[row]![c]! / pivot;
    for (let r = 0; r < m.length; r += 1) {
      if (r === row) continue;
      const factor = m[r]![col]!;
      if (factor === 0) continue;
      for (let c = 0; c < 6; c += 1) m[r]![c] = m[r]![c]! - factor * m[row]![c]!;
    }
    pivots.push(col);
    row += 1;
  }
  if (pivots.length !== 5) return undefined;
  const free = [0, 1, 2, 3, 4, 5].find((col) => !pivots.includes(col))!;
  const solution = [0, 0, 0, 0, 0, 0];
  solution[free] = 1;
  pivots.forEach((col, index) => { solution[col] = -m[index]![free]!; });
  return solution;
}

export type ConicKind = "ellipse" | "parabola" | "hyperbola";

/** The conic section through five points, classified; `entity` is what the sketch stores for it. */
export interface FivePointConic {
  readonly kind: ConicKind;
  readonly entity: SketchEntity;
}

/**
 * Conic through five points. An ellipse (or circle) is stored as an ellipse entity; a parabola or a hyperbola branch is
 * stored as a spline that runs from the first to the last of the five points along the curve. Five points that lie on a
 * straight line, on two lines, or on both branches of a hyperbola are refused.
 */
export function fitConicThroughFivePoints(points: readonly Vec2[], id: string): WorkbenchResult<FivePointConic> {
  if (points.length !== 5) return badShape("A conic through points needs exactly five points.");
  for (let i = 0; i < 5; i += 1) for (let j = i + 1; j < 5; j += 1) if (dist(points[i]!, points[j]!) < 0.05) return badShape("The five conic points must be at least 0.05 mm apart.");
  const cx = points.reduce((sum, point) => sum + point[0], 0) / 5;
  const cy = points.reduce((sum, point) => sum + point[1], 0) / 5;
  const s = points.reduce((sum, point) => sum + Math.hypot(point[0] - cx, point[1] - cy), 0) / 5;
  if (s < 0.05) return badShape("The five conic points are too close together.");
  const norm = points.map((point): Vec2 => [(point[0] - cx) / s, (point[1] - cy) / s]);
  const solution = nullVector(norm.map(([u, v]) => [u * u, u * v, v * v, u, v, 1]));
  if (solution === undefined) return badShape("No single conic passes through these five points: three or more of them are probably in a straight line.");
  const [A, B, C, D, E, F] = solution as [number, number, number, number, number, number];
  const magnitude = Math.abs(A) + Math.abs(B) + Math.abs(C) + Math.abs(D) + Math.abs(E) + Math.abs(F);
  const det3 = A * (C * F - (E / 2) * (E / 2)) - (B / 2) * ((B / 2) * F - (E / 2) * (D / 2)) + (D / 2) * ((B / 2) * (E / 2) - C * (D / 2));
  if (Math.abs(det3) < 1e-9 * magnitude ** 3) return badShape("The five points lie on a pair of straight lines, not on a smooth conic.");
  const quad = A * A + B * B + C * C;
  const disc = B * B - 4 * A * C;
  // The normalised frame maps back to the sketch by p = (cx, cy) + s * (u, v).
  const back = (p: Vec2): Vec2 => [cx + s * p[0], cy + s * p[1]];
  const theta = 0.5 * Math.atan2(B, A - C);
  const axisA: Vec2 = [Math.cos(theta), Math.sin(theta)];
  const axisB: Vec2 = [-axisA[1], axisA[0]];
  const lambdaA = A * axisA[0] ** 2 + B * axisA[0] * axisA[1] + C * axisA[1] ** 2;
  const lambdaB = A + C - lambdaA;
  if (disc < -1e-9 * quad) {
    const det = 4 * A * C - B * B;
    const ux = (-2 * C * D + B * E) / det;
    const uy = (B * D - 2 * A * E) / det;
    const fc = F + (D * ux + E * uy) / 2;
    const ra = -fc / lambdaA;
    const rb = -fc / lambdaB;
    if (!(ra > 0) || !(rb > 0)) return badShape("These five points do not lie on a real ellipse.");
    const semiA = Math.sqrt(ra) * s;
    const semiB = Math.sqrt(rb) * s;
    const center = back([ux, uy]);
    const aIsMajor = semiA >= semiB;
    const major = aIsMajor ? semiA : semiB;
    const minor = aIsMajor ? semiB : semiA;
    let rotation = ((aIsMajor ? theta : theta + Math.PI / 2) * 180) / Math.PI;
    rotation = ((rotation + 180) % 180 + 180) % 180;
    if (rotation > 90) rotation -= 180;
    if (minor < MODEL_ENVELOPE.minGeometryMm || major > MODEL_ENVELOPE.maxSketchRadiusMm) return badShape(`The ellipse through these points is too small or too large for a sketch (radii between ${MODEL_ENVELOPE.minGeometryMm} mm and ${MODEL_ENVELOPE.maxSketchRadiusMm} mm).`);
    return { ok: true, value: { kind: "ellipse", entity: { id, kind: "ellipse", center, majorRadiusMm: major, minorRadiusMm: minor, rotationDeg: rotation, construction: false } } };
  }
  if (disc > 1e-9 * quad) {
    const det = 4 * A * C - B * B;
    const ux = (-2 * C * D + B * E) / det;
    const uy = (B * D - 2 * A * E) / det;
    const fc = F + (D * ux + E * uy) / 2;
    // The transverse axis is the principal direction whose canonical coefficient has -fc / lambda > 0.
    const transverseIsA = -fc / lambdaA > 0;
    const transverse = transverseIsA ? axisA : axisB;
    const conjugate = transverseIsA ? axisB : axisA;
    const lambdaT = transverseIsA ? lambdaA : lambdaB;
    const lambdaC = transverseIsA ? lambdaB : lambdaA;
    const a = Math.sqrt(-fc / lambdaT);
    const b = Math.sqrt(fc / lambdaC);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return badShape("These five points do not lie on a real hyperbola.");
    const local = norm.map((p) => ({ x: (p[0] - ux) * transverse[0] + (p[1] - uy) * transverse[1], y: (p[0] - ux) * conjugate[0] + (p[1] - uy) * conjugate[1] }));
    const sign = local[0]!.x >= 0 ? 1 : -1;
    if (local.some((p) => p.x * sign <= 0)) return badShape("The five points lie on both branches of a hyperbola: place them along one branch.");
    const ts = local.map((p) => Math.asinh(p.y / b));
    const t0 = Math.min(...ts);
    const t1 = Math.max(...ts);
    if (t1 - t0 < 1e-3) return badShape("The five points are too close together along the curve.");
    const curve = (t: number): Vec2 => back([ux + sign * a * Math.cosh(t) * transverse[0] + b * Math.sinh(t) * conjugate[0], uy + sign * a * Math.cosh(t) * transverse[1] + b * Math.sinh(t) * conjugate[1]]);
    const spline = splineFromPoints(sampleCurveToFitPoints(curve, t0, t1, CONIC_FIT_POINTS, CONIC_DENSE_SAMPLES, 0, CONIC_CURVATURE_BIAS), id);
    return spline.ok ? { ok: true, value: { kind: "hyperbola", entity: spline.value } } : spline;
  }
  // Parabola: only one of the two principal curvatures is non-zero.
  const nIsA = Math.abs(lambdaA) >= Math.abs(lambdaB);
  const n = nIsA ? axisA : axisB;
  const m = nIsA ? axisB : axisA;
  const lambda = nIsA ? lambdaA : lambdaB;
  const dn = D * n[0] + E * n[1];
  const dm = D * m[0] + E * m[1];
  if (Math.abs(dm) < 1e-9 * magnitude) return badShape("The five points lie on a pair of parallel lines, not on a parabola.");
  const along = (p: Vec2): number => p[0] * n[0] + p[1] * n[1];
  const ss = norm.map(along);
  const s0 = Math.min(...ss);
  const s1 = Math.max(...ss);
  if (s1 - s0 < 1e-3) return badShape("The five points are too close together along the curve.");
  const curve = (sv: number): Vec2 => {
    const tv = -(lambda * sv * sv + dn * sv + F) / dm;
    return back([sv * n[0] + tv * m[0], sv * n[1] + tv * m[1]]);
  };
  const spline = splineFromPoints(sampleCurveToFitPoints(curve, s0, s1, CONIC_FIT_POINTS, CONIC_DENSE_SAMPLES, 0, CONIC_CURVATURE_BIAS), id);
  return spline.ok ? { ok: true, value: { kind: "parabola", entity: spline.value } } : spline;
}

export function buildConicFromFivePoints(points: readonly Vec2[], ids: ShapeIds): WorkbenchResult<SketchShape> {
  const fitted = fitConicThroughFivePoints(points, ids.entity());
  return fitted.ok ? { ok: true, value: { entities: [fitted.value.entity], constraints: [] } } : fitted;
}

