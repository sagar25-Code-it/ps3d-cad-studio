import { MODEL_ENVELOPE, WORKBENCH_LIMITS, circleThroughThreePoints, type SketchEntity, type Vec2, type WorkbenchResult, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { badShape, type ShapeIds, type SketchShape } from "./curve-math.js";

/**
 * Circles tangent to existing curves: the 3-tangent circle (touching three lines, circles or arcs, the Apollonius problem)
 * and the 2-tangent circle with a given radius. Each curve is picked by clicking near it; when several circles fit, the one
 * whose touch points lie closest to the clicks is chosen, which is what a user pointing at "this side" means. The circle is
 * added with a Tangent relation to each curve it touches (and a radius dimension for the 2-tangent circle), so it stays
 * tangent when the curves move.
 */
type Line = Extract<SketchEntity, { kind: "line" }>;
type Circle = Extract<SketchEntity, { kind: "circle" }>;
type Arc = Extract<SketchEntity, { kind: "arc" }>;
export type TangentTarget = Line | Circle | Arc;

const MAX_RADIUS_MM: number = MODEL_ENVELOPE.maxSketchRadiusMm;
const MIN_RADIUS_MM: number = MODEL_ENVELOPE.minGeometryMm;

/** An unknown circle (x, y, r) meets: A (x^2 + y^2 - r^2) + B x + C y + D r + E = 0. */
interface Equation { readonly A: number; readonly B: number; readonly C: number; readonly D: number; readonly E: number }

interface RoundShape { readonly center: Vec2; readonly radius: number; readonly startAngle: number; readonly sweep: number; readonly full: boolean }

const TWO_PI = Math.PI * 2;
const wrap = (angle: number): number => ((angle % TWO_PI) + TWO_PI) % TWO_PI;
const distance = (a: Vec2, b: Vec2): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

function roundShape(target: Circle | Arc): RoundShape | undefined {
  if (target.kind === "circle") return { center: target.center, radius: target.radiusMm, startAngle: 0, sweep: TWO_PI, full: true };
  const circle = circleThroughThreePoints(target.start, target.mid, target.end);
  if (circle === undefined) return undefined;
  const counterClockwise = (target.mid[0] - target.start[0]) * (target.end[1] - target.start[1]) - (target.mid[1] - target.start[1]) * (target.end[0] - target.start[0]) > 0;
  const from = counterClockwise ? target.start : target.end;
  const to = counterClockwise ? target.end : target.start;
  const startAngle = Math.atan2(from[1] - circle.center[1], from[0] - circle.center[0]);
  return { center: circle.center, radius: circle.radiusMm, startAngle, sweep: wrap(Math.atan2(to[1] - circle.center[1], to[0] - circle.center[0]) - startAngle), full: false };
}

function onSweep(shape: RoundShape, point: Vec2): boolean {
  if (shape.full) return true;
  const angle = Math.atan2(point[1] - shape.center[1], point[0] - shape.center[0]);
  return wrap(angle - shape.startAngle) <= shape.sweep + 1e-6;
}

function lineUnitNormal(line: Line): { readonly normal: Vec2; readonly offset: number } | undefined {
  const dx = line.end[0] - line.start[0];
  const dy = line.end[1] - line.start[1];
  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return undefined;
  const normal: Vec2 = [-dy / length, dx / length];
  return { normal, offset: normal[0] * line.start[0] + normal[1] * line.start[1] };
}

/** Gaussian elimination with partial pivoting on three rows [a, b, c | rhs]; undefined when the rows are dependent. */
function solveLinear3(rows: readonly (readonly [number, number, number, number])[]): readonly [number, number, number] | undefined {
  const m = rows.map((row) => [...row]);
  for (let column = 0; column < 3; column += 1) {
    let pivot = column;
    for (let row = column + 1; row < 3; row += 1) if (Math.abs(m[row]![column]!) > Math.abs(m[pivot]![column]!)) pivot = row;
    if (Math.abs(m[pivot]![column]!) < 1e-12) return undefined;
    [m[column], m[pivot]] = [m[pivot]!, m[column]!];
    for (let row = column + 1; row < 3; row += 1) {
      const factor = m[row]![column]! / m[column]![column]!;
      for (let k = column; k < 4; k += 1) m[row]![k] = m[row]![k]! - factor * m[column]![k]!;
    }
  }
  const r = m[2]![3]! / m[2]![2]!;
  const y = (m[1]![3]! - m[1]![2]! * r) / m[1]![1]!;
  const x = (m[0]![3]! - m[0]![2]! * r - m[0]![1]! * y) / m[0]![0]!;
  return [x, y, r];
}

/** Solves the three equations for (x, y, r): up to two solutions. */
function solveSystem(equations: readonly [Equation, Equation, Equation]): readonly (readonly [number, number, number])[] {
  const quadratic = equations.find((equation) => Math.abs(equation.A) > 1e-12);
  const others = equations.filter((equation) => equation !== quadratic);
  if (quadratic === undefined) {
    // Three linear equations: one solution.
    const solution = solveLinear3(equations.map((equation) => [equation.B, equation.C, equation.D, -equation.E] as const));
    return solution === undefined ? [] : [solution];
  }
  // Subtracting the quadratic one from any other that has the same quadratic term leaves two linear equations.
  const linear = others.map((equation): Equation => {
    const factor = equation.A / quadratic.A;
    return { A: 0, B: equation.B - factor * quadratic.B, C: equation.C - factor * quadratic.C, D: equation.D - factor * quadratic.D, E: equation.E - factor * quadratic.E };
  }) as [Equation, Equation];
  const [l1, l2] = linear;
  const direction: readonly [number, number, number] = [l1.C * l2.D - l1.D * l2.C, l1.D * l2.B - l1.B * l2.D, l1.B * l2.C - l1.C * l2.B];
  const directionLength = Math.hypot(...direction);
  if (directionLength < 1e-12) return [];
  const unit: readonly [number, number, number] = [direction[0] / directionLength, direction[1] / directionLength, direction[2] / directionLength];
  // The least-norm point of the two planes: p0 = M^T (M M^T)^-1 b with b = -E.
  const m11 = l1.B * l1.B + l1.C * l1.C + l1.D * l1.D;
  const m12 = l1.B * l2.B + l1.C * l2.C + l1.D * l2.D;
  const m22 = l2.B * l2.B + l2.C * l2.C + l2.D * l2.D;
  const determinant = m11 * m22 - m12 * m12;
  if (Math.abs(determinant) < 1e-18) return [];
  const b1 = -l1.E;
  const b2 = -l2.E;
  const w1 = (m22 * b1 - m12 * b2) / determinant;
  const w2 = (-m12 * b1 + m11 * b2) / determinant;
  const p0: readonly [number, number, number] = [l1.B * w1 + l2.B * w2, l1.C * w1 + l2.C * w2, l1.D * w1 + l2.D * w2];
  const { A, B, C, D, E } = quadratic;
  const a = A * (unit[0] ** 2 + unit[1] ** 2 - unit[2] ** 2);
  const b = A * 2 * (p0[0] * unit[0] + p0[1] * unit[1] - p0[2] * unit[2]) + B * unit[0] + C * unit[1] + D * unit[2];
  const c = A * (p0[0] ** 2 + p0[1] ** 2 - p0[2] ** 2) + B * p0[0] + C * p0[1] + D * p0[2] + E;
  const at = (t: number): readonly [number, number, number] => [p0[0] + t * unit[0], p0[1] + t * unit[1], p0[2] + t * unit[2]];
  const scale = Math.max(Math.abs(b), Math.abs(c), 1e-12);
  if (Math.abs(a) < 1e-12 * scale) return Math.abs(b) < 1e-12 ? [] : [at(-c / b)];
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -1e-9 * scale * scale) return [];
  const root = Math.sqrt(Math.max(discriminant, 0));
  return root === 0 ? [at(-b / (2 * a))] : [at((-b - root) / (2 * a)), at((-b + root) / (2 * a))];
}

interface Candidate { readonly center: Vec2; readonly radius: number; readonly touches: readonly Vec2[]; readonly cost: number }

/** Every circle tangent to the targets (and to the radius, when given), with its touch points and how far they are from the clicks. */
function tangentCandidates(targets: readonly TangentTarget[], clicks: readonly Vec2[], radius: number | undefined): readonly Candidate[] {
  const shapes = targets.map((target) => (target.kind === "line" ? undefined : roundShape(target)));
  if (targets.some((target, index) => target.kind !== "line" && shapes[index] === undefined)) return [];
  const found: Candidate[] = [];
  const combinations = 1 << targets.length;
  for (let mask = 0; mask < combinations; mask += 1) {
    const equations: Equation[] = [];
    let valid = true;
    targets.forEach((target, index) => {
      const sign = (mask >> index) & 1 ? -1 : 1;
      if (target.kind === "line") {
        const frame = lineUnitNormal(target);
        if (frame === undefined) { valid = false; return; }
        equations.push({ A: 0, B: frame.normal[0], C: frame.normal[1], D: -sign, E: -frame.offset });
      } else {
        const shape = shapes[index]!;
        const rho = sign * shape.radius;
        equations.push({ A: 1, B: -2 * shape.center[0], C: -2 * shape.center[1], D: -2 * rho, E: shape.center[0] ** 2 + shape.center[1] ** 2 - rho * rho });
      }
    });
    if (!valid) continue;
    if (radius !== undefined) equations.push({ A: 0, B: 0, C: 0, D: 1, E: -radius });
    if (equations.length !== 3) continue;
    for (const [x, y, r] of solveSystem(equations as [Equation, Equation, Equation])) {
      if (!(r >= MIN_RADIUS_MM && r <= MAX_RADIUS_MM) || Math.abs(x) > WORKBENCH_LIMITS.maxCoordinateMm || Math.abs(y) > WORKBENCH_LIMITS.maxCoordinateMm) continue;
      const center: Vec2 = [x, y];
      const touches: Vec2[] = [];
      let tangent = true;
      targets.forEach((target, index) => {
        if (!tangent) return;
        if (target.kind === "line") {
          const frame = lineUnitNormal(target)!;
          const signed = frame.normal[0] * x + frame.normal[1] * y - frame.offset;
          if (Math.abs(Math.abs(signed) - r) > 1e-6 * Math.max(1, r)) { tangent = false; return; }
          touches.push([x - frame.normal[0] * signed, y - frame.normal[1] * signed]);
          return;
        }
        const shape = shapes[index]!;
        const gap = distance(center, shape.center);
        if (gap < 1e-9 || (Math.abs(gap - (r + shape.radius)) > 1e-6 * Math.max(1, r + shape.radius) && Math.abs(gap - Math.abs(r - shape.radius)) > 1e-6 * Math.max(1, r + shape.radius))) { tangent = false; return; }
        // The touch point lies on the picked curve along the line of centres: toward the new centre for an outside touch,
        // away from it when the new circle is inside the picked one and touches from within.
        const outside = Math.abs(gap - (r + shape.radius)) <= Math.abs(gap - Math.abs(r - shape.radius));
        const direction: Vec2 = [(x - shape.center[0]) / gap, (y - shape.center[1]) / gap];
        const along = outside || r < shape.radius ? 1 : -1;
        const touch: Vec2 = [shape.center[0] + direction[0] * shape.radius * along, shape.center[1] + direction[1] * shape.radius * along];
        if (!onSweep(shape, touch)) { tangent = false; return; }
        touches.push(touch);
      });
      if (!tangent) continue;
      if (found.some((candidate) => distance(candidate.center, center) < 1e-7 && Math.abs(candidate.radius - r) < 1e-7)) continue;
      found.push({ center, radius: r, touches, cost: touches.reduce((sum, touch, index) => sum + distance(touch, clicks[index]!), 0) });
    }
  }
  return found;
}

/** The nearest line, circle or arc to each click, or a message when a click is too far from any or two clicks pick the same curve. */
function pickTargets(entities: readonly SketchEntity[], clicks: readonly Vec2[], reachMm: number): WorkbenchResult<readonly TangentTarget[]> {
  const picks: TangentTarget[] = [];
  for (const click of clicks) {
    let best: { readonly target: TangentTarget; readonly gap: number } | undefined;
    for (const entity of entities) {
      if (entity.visible === false) continue;
      let gap: number | undefined;
      if (entity.kind === "line") {
        const dx = entity.end[0] - entity.start[0];
        const dy = entity.end[1] - entity.start[1];
        const lengthSquared = dx * dx + dy * dy;
        if (lengthSquared < 1e-12) continue;
        const t = Math.max(0, Math.min(1, ((click[0] - entity.start[0]) * dx + (click[1] - entity.start[1]) * dy) / lengthSquared));
        gap = distance(click, [entity.start[0] + dx * t, entity.start[1] + dy * t]);
      } else if (entity.kind === "circle") {
        gap = Math.abs(distance(click, entity.center) - entity.radiusMm);
      } else if (entity.kind === "arc") {
        const shape = roundShape(entity);
        if (shape === undefined) continue;
        gap = onSweep(shape, click) ? Math.abs(distance(click, shape.center) - shape.radius) : Math.min(distance(click, entity.start), distance(click, entity.end));
      }
      if (gap !== undefined && gap <= reachMm && (best === undefined || gap < best.gap)) best = { target: entity as TangentTarget, gap };
    }
    if (best === undefined) return badShape(`Click closer to a line, circle or arc (within ${reachMm.toFixed(1)} mm) for each of the curves the circle should touch.`, "Click on the curves themselves.");
    picks.push(best.target);
  }
  if (new Set(picks.map((pick) => pick.id)).size !== picks.length) return badShape("Pick a different curve for each click: two of the clicks chose the same curve.", "Click on separate curves.");
  return { ok: true, value: picks };
}

function circleShape(id: string, candidate: Candidate): SketchEntity {
  return { id, kind: "circle", center: candidate.center, radiusMm: candidate.radius, construction: false };
}

function tangentConstraints(circleId: string, targets: readonly TangentTarget[], ids: ShapeIds): WorkbenchSketchConstraint[] {
  return targets.map((target): WorkbenchSketchConstraint => ({ id: ids.constraint(), kind: "tangent", entityIds: [circleId, target.id] }));
}

/** The circle tangent to the three curves nearest the three clicks, on the side the clicks point to. */
export function buildTangentCircleThree(entities: readonly SketchEntity[], clicks: readonly Vec2[], pickReachMm: number, ids: ShapeIds): WorkbenchResult<SketchShape> {
  if (clicks.length !== 3) return badShape("A 3-tangent circle takes three clicks, one on each curve.");
  const picked = pickTargets(entities, clicks, pickReachMm);
  if (!picked.ok) return picked;
  const candidates = tangentCandidates(picked.value, clicks, undefined);
  const best = [...candidates].sort((left, right) => left.cost - right.cost || left.radius - right.radius)[0];
  if (best === undefined) return badShape("No circle touches all three of those curves (for example three parallel lines, or curves that cannot be reached from one circle).", "Pick three other curves, or move the clicks.");
  const id = ids.entity();
  return { ok: true, value: { entities: [circleShape(id, best)], constraints: tangentConstraints(id, picked.value, ids) } };
}

/** The circle of the given radius tangent to the two curves nearest the two clicks. */
export function buildTangentCircleTwo(entities: readonly SketchEntity[], clicks: readonly Vec2[], radiusMm: number, pickReachMm: number, ids: ShapeIds): WorkbenchResult<SketchShape> {
  if (clicks.length !== 2) return badShape("A 2-tangent circle takes two clicks, one on each curve.");
  if (!Number.isFinite(radiusMm) || radiusMm < MIN_RADIUS_MM || radiusMm > MAX_RADIUS_MM) return badShape(`The circle radius must be between ${MIN_RADIUS_MM} and ${MAX_RADIUS_MM.toLocaleString("en-US")} mm.`, "Type a radius in the Sketch palette.");
  const picked = pickTargets(entities, clicks, pickReachMm);
  if (!picked.ok) return picked;
  const candidates = tangentCandidates(picked.value, clicks, radiusMm);
  const best = [...candidates].sort((left, right) => left.cost - right.cost)[0];
  if (best === undefined) return badShape(`No circle of radius ${radiusMm} mm touches both curves: they may be too far apart, too close together or parallel at a different spacing.`, "Change the radius or pick other curves.");
  const id = ids.entity();
  const radius: WorkbenchSketchConstraint = { id: ids.constraint(), kind: "radius", entityIds: [id], valueMm: radiusMm, dimension: "radius" };
  return { ok: true, value: { entities: [circleShape(id, best)], constraints: [...tangentConstraints(id, picked.value, ids), radius] } };
}
