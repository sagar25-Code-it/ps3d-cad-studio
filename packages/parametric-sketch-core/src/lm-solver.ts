import { differenceStep, type Equation, type SolverModel } from "./equation-model.js";
import { solveSymmetric } from "./linear-algebra.js";
import { HUB_ROWS, maxRowsPerColumn, solveLeastNormSparse } from "./sparse-ldl.js";

/**
 * Damped Gauss-Newton (Levenberg-Marquardt) over every relation at once. Each step is the weighted least-norm correction that
 * brings the residuals to zero, so geometry the relations do not force to move stays where it is. Soft "keep the shape"
 * equations ride along at a much smaller weight and are followed by a hard-only polish, so they never fight a real relation.
 */

export interface ResidualReport {
  readonly equation: Equation;
  readonly residual: number;
}

export interface SolveOutcome {
  readonly ok: boolean;
  readonly iterations: number;
  readonly maxResidual: number;
  /** Equations that stay unsatisfied (largest first); empty when ok. */
  readonly failing: readonly ResidualReport[];
}

export interface SolveOptions {
  /** A residual at or below this counts as satisfied for the final answer. */
  readonly tolerance: number;
  /** Extra soft equations with a weight factor each (a drag's pointer goal). */
  readonly goals?: readonly { readonly equation: Equation; readonly factor: number }[];
}

const CONVERGED = 1e-13;
/** A hard-relation solve stops when the residual is below the floor and two iterations in a row improved it by less than half. */
const STALL_FLOOR = 1e-11;
const STALL_RATIO = 0.5;
const STALL_ITERATIONS = 2;
const SOFT_FACTOR = 1e-3;
/** Weight of the "stay where you were" term in the soft phase, so that anchored geometry resists the soft pull and free geometry does not. */
const STAY_FACTOR = SOFT_FACTOR * SOFT_FACTOR * 1e-4;
const MAX_ITERATIONS = 120;
/** The nearest-point refinement stops once a step would move anything by less than this (finite-difference round-off is about 1e-9). */
const REFINE_TOLERANCE = 1e-8;
/** A number that ended within this of where it began did not move: it is restored exactly, so round-off never shows as dust on untouched geometry. */
const UNMOVED_MM = 2e-9;
/** One step may turn an angle by at most this many radians and change a size by at most this fraction of it. */
const MAX_ANGLE_STEP = 0.35;
/** A least-norm step with this many rows or fewer is always solved through J J' (a dense factorisation of that size is cheap). */
const AUGMENTED_MIN_ROWS = 24;
const MAX_SIZE_STEP = 0.5;

interface Row {
  readonly cols: number[];
  readonly vals: number[];
}

interface Part {
  readonly equation: Equation;
  readonly factor: number;
  readonly active: number[];
  rowStart: number;
}

function activeVariables(equation: Equation, frozen: Uint8Array): number[] {
  return equation.vars.filter((variable) => frozen[variable] === 0);
}

function evaluateAll(parts: readonly Part[], x: Float64Array, residual: Float64Array): void {
  for (const part of parts) part.equation.residual(x, residual, part.rowStart);
}

function sumOfSquares(parts: readonly Part[], residual: Float64Array): number {
  let total = 0;
  for (const part of parts) {
    for (let row = 0; row < part.equation.size; row += 1) {
      const value = residual[part.rowStart + row]!;
      total += part.factor * part.factor * value * value;
    }
  }
  return Number.isFinite(total) ? total : Infinity;
}

function maxHard(parts: readonly Part[], residual: Float64Array): number {
  let worst = 0;
  for (const part of parts) {
    if (part.factor !== 1) continue;
    for (let row = 0; row < part.equation.size; row += 1) {
      const value = Math.abs(residual[part.rowStart + row]!);
      if (!(value <= worst)) worst = Number.isNaN(value) ? Infinity : value;
    }
  }
  return worst;
}

/** Angles and sizes are differentiated with a step of their own scale; coordinates with the equation's. */
function model_role_step(role: Uint8Array, variable: number, baseStep: number, original: number): number {
  return role[variable] === 0 ? baseStep : 1e-4 * Math.max(1, Math.abs(original));
}

/**
 * Five-point (fourth-order) central-difference Jacobian of the parts' residuals with respect to the component's active variables.
 * The step is wide enough that round-off stays near 1e-12 and the formula is exact for anything polynomial up to degree four, so a
 * relation that is linear in the coordinates (a joint, a midpoint) has a Jacobian that is exact to round-off.
 */
function jacobian(parts: readonly Part[], x: Float64Array, rowCount: number, scratch: readonly Float64Array[], role: Uint8Array): Row[] {
  const rows: Row[] = Array.from({ length: rowCount }, () => ({ cols: [], vals: [] }));
  const [plus, minus, plusTwo, minusTwo] = scratch as readonly [Float64Array, Float64Array, Float64Array, Float64Array];
  for (const part of parts) {
    const size = part.equation.size;
    const baseStep = differenceStep(role, x, part.equation.vars);
    for (const variable of part.active) {
      const original = x[variable]!;
      const step = model_role_step(role, variable, baseStep, original);
      x[variable] = original + step;
      part.equation.residual(x, plus, 0);
      x[variable] = original - step;
      part.equation.residual(x, minus, 0);
      x[variable] = original + 2 * step;
      part.equation.residual(x, plusTwo, 0);
      x[variable] = original - 2 * step;
      part.equation.residual(x, minusTwo, 0);
      x[variable] = original;
      for (let row = 0; row < size; row += 1) {
        const derivative = (8 * (plus[row]! - minus[row]!) - (plusTwo[row]! - minusTwo[row]!)) / (12 * step);
        if (Number.isFinite(derivative) && Math.abs(derivative) > 1e-13) {
          const target = rows[part.rowStart + row]!;
          target.cols.push(variable);
          target.vals.push(derivative);
        }
      }
    }
  }
  return rows;
}

interface Component {
  readonly hard: Equation[];
  readonly soft: Equation[];
  /** Shape-keeping terms of the two-level solve; only used by the second level. */
  readonly keep: Equation[];
  readonly goals: { readonly equation: Equation; readonly factor: number }[];
  readonly variables: number[];
}

/** Groups equations that share an unknown, so each group is solved on its own. Equations with no unknown are returned for a direct check. */
export function partition(model: SolverModel, frozen: Uint8Array, goals: SolveOptions["goals"], softEquations: readonly Equation[]): { readonly components: Component[]; readonly constants: Equation[] } {
  const parent = new Map<number, number>();
  const find = (variable: number): number => {
    let root = variable;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let current = variable;
    while (parent.get(current) !== root) {
      const next = parent.get(current)!;
      parent.set(current, root);
      current = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  };
  const everything: Equation[] = [...model.equations, ...softEquations, ...model.keep, ...(goals ?? []).map((goal) => goal.equation)];
  const constants: Equation[] = [];
  for (const equation of model.equations) {
    const active = activeVariables(equation, frozen);
    if (active.length === 0) constants.push(equation);
  }
  for (const equation of everything) {
    const active = activeVariables(equation, frozen);
    for (const variable of active) if (!parent.has(variable)) parent.set(variable, variable);
    for (let index = 1; index < active.length; index += 1) union(active[0]!, active[index]!);
  }
  const groups = new Map<number, Component>();
  const group = (variable: number): Component => {
    const root = find(variable);
    let component = groups.get(root);
    if (component === undefined) {
      component = { hard: [], soft: [], keep: [], goals: [], variables: [] };
      groups.set(root, component);
    }
    return component;
  };
  for (const variable of [...parent.keys()].sort((a, b) => a - b)) group(variable).variables.push(variable);
  for (const equation of model.equations) {
    const active = activeVariables(equation, frozen);
    if (active.length > 0) group(active[0]!).hard.push(equation);
  }
  for (const equation of softEquations) {
    const active = activeVariables(equation, frozen);
    if (active.length > 0) group(active[0]!).soft.push(equation);
  }
  for (const equation of model.keep) {
    const active = activeVariables(equation, frozen);
    if (active.length > 0) group(active[0]!).keep.push(equation);
  }
  for (const goal of goals ?? []) {
    const active = activeVariables(goal.equation, frozen);
    if (active.length > 0) group(active[0]!).goals.push(goal);
  }
  return { components: [...groups.values()].sort((a, b) => a.variables[0]! - b.variables[0]!), constants };
}

function makeParts(component: Component, frozen: Uint8Array, includeSoft: boolean): { parts: Part[]; rowCount: number } {
  const parts: Part[] = [];
  let rowCount = 0;
  const push = (equation: Equation, factor: number): void => {
    const part: Part = { equation, factor, active: activeVariables(equation, frozen), rowStart: rowCount };
    rowCount += equation.size;
    parts.push(part);
  };
  for (const equation of component.hard) push(equation, 1);
  if (includeSoft) {
    for (const equation of component.soft) push(equation, equation.softFactor ?? SOFT_FACTOR);
    for (const goal of component.goals) push(goal.equation, goal.factor);
  }
  return { parts, rowCount };
}

interface LmResult {
  readonly iterations: number;
  readonly hard: number;
  readonly moved: number;
}

/** One Levenberg-Marquardt run on a component; `x` is updated in place. */
function levenbergMarquardt(model: SolverModel, component: Component, frozen: Uint8Array, includeSoft: boolean, maxIterations: number): LmResult {
  const x = model.x;
  const { parts, rowCount } = makeParts(component, frozen, includeSoft);
  const local = new Map<number, number>();
  const variables = component.variables.filter((variable) => frozen[variable] === 0);
  variables.forEach((variable, index) => local.set(variable, index));
  const n = variables.length;
  const invSqrtWeight = new Float64Array(n);
  variables.forEach((variable, index) => { invSqrtWeight[index] = 1 / Math.sqrt(model.weight[variable]!); });
  const residual = new Float64Array(rowCount);
  const scratch = [new Float64Array(8), new Float64Array(8), new Float64Array(8), new Float64Array(8)];
  // In the soft phase the cost also charges (weighted) displacement from where the phase began.
  const stay = includeSoft ? variables.map((variable) => x[variable]!) : [];
  const stayCost = (): number => {
    let total = 0;
    for (let index = 0; index < n; index += 1) {
      const gap = (x[variables[index]!]! - stay[index]!) / invSqrtWeight[index]!;
      total += STAY_FACTOR * gap * gap;
    }
    return total;
  };
  evaluateAll(parts, x, residual);
  let cost = sumOfSquares(parts, residual) + (includeSoft ? stayCost() : 0);
  let lambda = includeSoft ? 1e-6 : 1e-8;
  let iteration = 0;
  let moved = 0;
  let stalled = false;
  let previousHard = Infinity;
  let slowIterations = 0;
  for (; iteration < maxIterations; iteration += 1) {
    const hardNow = maxHard(parts, residual);
    if (!includeSoft && hardNow <= CONVERGED) break;
    if (!includeSoft) {
      // Finite-difference round-off puts a floor under the residual (a few 1e-13); once there, more iterations only repeat the same number.
      slowIterations = hardNow <= STALL_FLOOR && hardNow > STALL_RATIO * previousHard ? slowIterations + 1 : 0;
      if (slowIterations >= STALL_ITERATIONS) break;
      previousHard = hardNow;
    }
    if (!Number.isFinite(cost)) break;
    const rows = jacobian(parts, x, rowCount, scratch, model.role);
    // Each residual row, with its columns mapped to the component's unknowns and scaled by the weights.
    const prepared: { readonly columns: Int32Array; readonly scaled: Float64Array; readonly value: number }[] = [];
    for (const part of parts) {
      const factor = part.factor;
      for (let row = 0; row < part.equation.size; row += 1) {
        const entry = rows[part.rowStart + row]!;
        const count = entry.cols.length;
        const columns = new Int32Array(count);
        const scaled = new Float64Array(count);
        for (let k = 0; k < count; k += 1) {
          const column = local.get(entry.cols[k]!)!;
          columns[k] = column;
          scaled[k] = entry.vals[k]! * invSqrtWeight[column]! * factor;
        }
        prepared.push({ columns, scaled, value: residual[part.rowStart + row]! * factor });
      }
    }
    // Hard-only: the least-norm step J'(JJ' + lambda I)^-1 r lies exactly in the row space, so geometry the relations do not touch cannot drift.
    // With soft terms the unknowns carry their own cost, and the ordinary damped normal equations are used.
    const dual = !includeSoft;
    // One unknown shared by many rows (a master dimension, an Equal to a reference curve) makes J J' dense: those systems go through the augmented form.
    const augmented = dual && prepared.length > AUGMENTED_MIN_ROWS && maxRowsPerColumn(prepared, n) > HUB_ROWS;
    const diag = new Float64Array(dual ? prepared.length : n);
    const lower: Map<number, number>[] = Array.from({ length: dual && !augmented ? prepared.length : dual ? 0 : n }, () => new Map<number, number>());
    const rhs = new Float64Array(dual ? prepared.length : n);
    if (augmented) {
      prepared.forEach((entry, rowIndex) => {
        rhs[rowIndex] = -entry.value;
        let sum = 0;
        for (let k = 0; k < entry.scaled.length; k += 1) sum += entry.scaled[k]! * entry.scaled[k]!;
        diag[rowIndex] = sum;
      });
    } else if (dual) {
      const byColumn: { readonly row: number; readonly value: number }[][] = Array.from({ length: n }, () => []);
      prepared.forEach((entry, rowIndex) => {
        rhs[rowIndex] = -entry.value;
        for (let k = 0; k < entry.columns.length; k += 1) byColumn[entry.columns[k]!]!.push({ row: rowIndex, value: entry.scaled[k]! });
      });
      for (const list of byColumn) {
        for (let a = 0; a < list.length; a += 1) {
          const left = list[a]!;
          diag[left.row] = diag[left.row]! + left.value * left.value;
          for (let b = 0; b < a; b += 1) {
            const right = list[b]!;
            const high = Math.max(left.row, right.row);
            const low = Math.min(left.row, right.row);
            const map = lower[high]!;
            map.set(low, (map.get(low) ?? 0) + left.value * right.value);
          }
        }
      }
    } else {
      for (const entry of prepared) {
        const count = entry.columns.length;
        for (let a = 0; a < count; a += 1) {
          const ca = entry.columns[a]!;
          const va = entry.scaled[a]!;
          diag[ca] = diag[ca]! + va * va;
          rhs[ca] = rhs[ca]! - va * entry.value;
          for (let b = 0; b < a; b += 1) {
            const cb = entry.columns[b]!;
            const high = Math.max(ca, cb);
            const low = Math.min(ca, cb);
            const map = lower[high]!;
            map.set(low, (map.get(low) ?? 0) + va * entry.scaled[b]!);
          }
        }
      }
      for (let index = 0; index < n; index += 1) {
        const scaledGap = (x[variables[index]!]! - stay[index]!) / invSqrtWeight[index]!;
        diag[index] = diag[index]! + STAY_FACTOR;
        rhs[index] = rhs[index]! - STAY_FACTOR * scaledGap;
      }
    }
    let dampScale = 1;
    if (dual) {
      let largest = 1e-300;
      for (let index = 0; index < diag.length; index += 1) largest = Math.max(largest, diag[index]!);
      dampScale = Math.min(1, largest);
    }
    let accepted = false;
    const backup = variables.map((variable) => x[variable]!);
    for (let attempt = 0; attempt < 14 && !accepted; attempt += 1) {
      const damped = Float64Array.from(diag);
      // A system made only of rows on very stiff unknowns is tiny in the scaled coordinates; the damping follows its size so it does not stall.
      const dampLambda = dual ? lambda * dampScale : lambda;
      for (let index = 0; index < damped.length; index += 1) damped[index] = damped[index]! + dampLambda;
      let step: Float64Array | undefined;
      if (augmented) {
        step = solveLeastNormSparse(n, prepared, Float64Array.from(diag, (own) => dampLambda * Math.max(own, dampScale * 1e-6)), rhs);
      } else {
        const solved = solveSymmetric(damped.length, damped, lower, rhs);
        step = solved;
        if (dual && solved !== undefined) {
          step = new Float64Array(n);
          prepared.forEach((entry, rowIndex) => {
            for (let k = 0; k < entry.columns.length; k += 1) step![entry.columns[k]!] = step![entry.columns[k]!]! + entry.scaled[k]! * solved[rowIndex]!;
          });
        }
      }
      if (step !== undefined && step.every((value) => Number.isFinite(value))) {
        // A long way off, the angles and sizes are far from linear: take the same direction in shorter steps.
        let shrink = 1;
        for (let index = 0; index < n; index += 1) {
          const role = model.role[variables[index]!]!;
          if (role === 0) continue;
          const delta = Math.abs(step[index]! * invSqrtWeight[index]!);
          const allowed = role === 1 ? MAX_ANGLE_STEP : MAX_SIZE_STEP * Math.max(Math.abs(backup[index]!), 1e-3);
          if (delta > allowed) shrink = Math.min(shrink, allowed / delta);
        }
        let largest = 0;
        for (let index = 0; index < n; index += 1) {
          const delta = step[index]! * invSqrtWeight[index]! * shrink;
          x[variables[index]!] = backup[index]! + delta;
          largest = Math.max(largest, Math.abs(delta));
        }
        evaluateAll(parts, x, residual);
        const next = sumOfSquares(parts, residual) + (includeSoft ? stayCost() : 0);
        if (next < cost || (next <= cost && largest <= 1e-14)) {
          // In the soft phase a step that no longer lowers the cost in a meaningful way means the minimum is reached; going on would only amplify round-off along flat directions.
          if (includeSoft && cost - next <= 1e-9 * cost) stalled = true;
          cost = next;
          lambda = Math.max(lambda * 0.2, includeSoft ? 1e-7 : 1e-12);
          accepted = true;
          moved = largest;
          break;
        }
      }
      lambda = Math.min(lambda * 6, 1e12);
    }
    if (!accepted) {
      for (let index = 0; index < n; index += 1) x[variables[index]!] = backup[index]!;
      evaluateAll(parts, x, residual);
      break;
    }
    if (includeSoft && (moved <= 1e-12 || stalled)) break;
  }
  return { iterations: iteration, hard: maxHard(parts, residual), moved };
}

/**
 * Moves a point that already satisfies the hard relations to the satisfying point nearest the geometry the solve began from (in the
 * weighted metric). The Gauss-Newton steps that found the first answer are least-norm from wherever they were, so on a curved
 * constraint set they stop at a feasible point that is not the nearest (a rectangle dragged by a corner picks up a hundredth of a
 * degree of turn; a line's far end swings round). Here each step solves the linearised relations for the displacement from the
 * ORIGINAL geometry, which converges to the nearest feasible point; a step is kept only if the point is still feasible and nearer.
 */
function refineNearest(model: SolverModel, component: Component, frozen: Uint8Array): void {
  const x = model.x;
  const reference = model.x0;
  const hardComponent = { ...component, soft: [], keep: [], goals: [] };
  const { parts, rowCount } = makeParts(hardComponent, frozen, false);
  if (rowCount === 0) return;
  const variables = component.variables.filter((variable) => frozen[variable] === 0);
  const n = variables.length;
  if (n === 0) return;
  const local = new Map<number, number>();
  variables.forEach((variable, index) => local.set(variable, index));
  const invSqrtWeight = new Float64Array(n);
  variables.forEach((variable, index) => { invSqrtWeight[index] = 1 / Math.sqrt(model.weight[variable]!); });
  const scratch = [new Float64Array(8), new Float64Array(8), new Float64Array(8), new Float64Array(8)];
  const residual = new Float64Array(rowCount);
  const distance = (): number => {
    let total = 0;
    for (let index = 0; index < n; index += 1) {
      const gap = (x[variables[index]!]! - reference[variables[index]!]!) / invSqrtWeight[index]!;
      total += gap * gap;
    }
    return total;
  };
  let best = variables.map((variable) => x[variable]!);
  let bestDistance = distance();
  if (!(bestDistance > 0)) return;
  // A large component is refined with fewer passes: the cost of a pass grows with its size and the first pass does most of the work.
  const passes = n <= 200 ? 12 : n <= 600 ? 4 : 2;
  for (let pass = 0; pass < passes; pass += 1) {
    evaluateAll(parts, x, residual);
    const rows = jacobian(parts, x, rowCount, scratch, model.role);
    const columnsOf: Int32Array[] = [];
    const scaledOf: Float64Array[] = [];
    const target: number[] = [];
    for (const part of parts) {
      for (let row = 0; row < part.equation.size; row += 1) {
        const entry = rows[part.rowStart + row]!;
        const count = entry.cols.length;
        const columns = new Int32Array(count);
        const scaled = new Float64Array(count);
        // The relation, linearised here, evaluated at the original geometry: residual + J (reference - x).
        let value = residual[part.rowStart + row]!;
        for (let k = 0; k < count; k += 1) {
          const column = local.get(entry.cols[k]!)!;
          columns[k] = column;
          scaled[k] = entry.vals[k]! * invSqrtWeight[column]!;
          value += entry.vals[k]! * (reference[entry.cols[k]!]! - x[entry.cols[k]!]!);
        }
        columnsOf.push(columns);
        scaledOf.push(scaled);
        target.push(-value);
      }
    }
    const size = target.length;
    const diag = new Float64Array(size);
    for (let rowIndex = 0; rowIndex < size; rowIndex += 1) {
      for (let k = 0; k < scaledOf[rowIndex]!.length; k += 1) diag[rowIndex] = diag[rowIndex]! + scaledOf[rowIndex]![k]! ** 2;
    }
    const sparseRows = columnsOf.map((columns, index) => ({ columns, scaled: scaledOf[index]! }));
    let proposal: Float64Array | undefined;
    if (size > AUGMENTED_MIN_ROWS && maxRowsPerColumn(sparseRows, n) > HUB_ROWS) {
      // One unknown shared by many rows: the augmented form keeps the factorisation as sparse as the sketch.
      for (let damping = 1e-10; damping <= 1e-2 && proposal === undefined; damping *= 100) {
        proposal = solveLeastNormSparse(n, sparseRows, Float64Array.from(diag, (own) => damping * Math.max(own, 1e-12)), Float64Array.from(target));
      }
    } else {
      const byColumn: { readonly row: number; readonly value: number }[][] = Array.from({ length: n }, () => []);
      for (let rowIndex = 0; rowIndex < size; rowIndex += 1) {
        for (let k = 0; k < columnsOf[rowIndex]!.length; k += 1) byColumn[columnsOf[rowIndex]![k]!]!.push({ row: rowIndex, value: scaledOf[rowIndex]![k]! });
      }
      const lower: Map<number, number>[] = Array.from({ length: size }, () => new Map<number, number>());
      for (const list of byColumn) {
        for (let a = 0; a < list.length; a += 1) {
          const left = list[a]!;
          for (let b = 0; b < a; b += 1) {
            const right = list[b]!;
            const high = Math.max(left.row, right.row);
            const low = Math.min(left.row, right.row);
            const map = lower[high]!;
            map.set(low, (map.get(low) ?? 0) + left.value * right.value);
          }
        }
      }
      let solved: Float64Array | undefined;
      for (let damping = 1e-10; damping <= 1e-2 && solved === undefined; damping *= 100) {
        const damped = Float64Array.from(diag);
        for (let index = 0; index < size; index += 1) damped[index] = damped[index]! + damping * Math.max(diag[index]!, 1e-12);
        solved = solveSymmetric(size, damped, lower, Float64Array.from(target));
      }
      if (solved !== undefined) {
        proposal = new Float64Array(n);
        for (let rowIndex = 0; rowIndex < size; rowIndex += 1) {
          for (let k = 0; k < columnsOf[rowIndex]!.length; k += 1) proposal[columnsOf[rowIndex]![k]!] = proposal[columnsOf[rowIndex]![k]!]! + scaledOf[rowIndex]![k]! * solved[rowIndex]!;
        }
      }
    }
    if (proposal === undefined) break;
    const from = variables.map((variable) => x[variable]!);
    // Already the nearest feasible point (to round-off): nothing to do.
    let move = 0;
    for (let index = 0; index < n; index += 1) move = Math.max(move, Math.abs(reference[variables[index]!]! + proposal[index]! * invSqrtWeight[index]! - from[index]!));
    if (move <= REFINE_TOLERANCE) break;
    // A long way off, angles and sizes are far from linear: approach the proposal in shorter steps.
    let shrink = 1;
    for (let index = 0; index < n; index += 1) {
      const variable = variables[index]!;
      const role = model.role[variable]!;
      if (role === 0) continue;
      const delta = Math.abs(reference[variable]! + proposal[index]! * invSqrtWeight[index]! - from[index]!);
      const allowed = role === 1 ? MAX_ANGLE_STEP : MAX_SIZE_STEP * Math.max(Math.abs(from[index]!), 1e-3);
      if (delta > allowed) shrink = Math.min(shrink, allowed / delta);
    }
    let change = 0;
    for (let index = 0; index < n; index += 1) {
      const variable = variables[index]!;
      const next = reference[variable]! + proposal[index]! * invSqrtWeight[index]!;
      const value = from[index]! + (next - from[index]!) * shrink;
      change = Math.max(change, Math.abs(value - from[index]!));
      x[variable] = value;
    }
    evaluateAll(parts, x, residual);
    if (maxHard(parts, residual) > 1e-12) levenbergMarquardt(model, hardComponent, frozen, false, 30);
    evaluateAll(parts, x, residual);
    const feasible = maxHard(parts, residual) <= 1e-9;
    const nowDistance = distance();
    if (feasible && nowDistance <= bestDistance * (1 + 1e-12)) {
      best = variables.map((variable) => x[variable]!);
      bestDistance = nowDistance;
    } else {
      break;
    }
    if (change <= REFINE_TOLERANCE) break;
  }
  variables.forEach((variable, index) => { x[variable] = best[index]!; });
}

/** A variable that moved more than this to meet the relations counts as one the relations forced to move. */
const FORCED_MOVE = 1e-7;
/** The second level tries at most this many keepers one by one when asking for all of them at once is not possible. */
const MAX_KEEP_ATTEMPTS = 12;
const KEEP_ITERATIONS = 14;
const MAX_KEEP_FORCED = 240;

/**
 * A line the first level ran backwards (its end now lies behind its start, the other way round from where it began) is a fold, not a
 * move: a cell of a grid pushed back over its neighbour. Folding is not what an edit means, so the relations are solved again from the
 * original geometry with the length of every line kept as well: the lines beyond the fold then travel along instead of being
 * overrun. If the relations leave no room for that (a triangle whose side no longer fits), the first answer stays. Returns whether
 * the geometry was replaced; every unheld number is then free to have moved.
 */
function undoFolds(model: SolverModel, component: Component, held: Uint8Array, free: Uint8Array): boolean {
  if (model.lineVectors.length === 0) return false;
  const x = model.x;
  const members = new Set(component.variables);
  const lines = model.lineVectors.filter((line) => members.has(line.base));
  const folded = (): boolean => lines.some((line) => {
    const ux = x[line.base + 2]! - x[line.base]!;
    const uy = x[line.base + 3]! - x[line.base + 1]!;
    return ux * line.vx + uy * line.vy < -1e-9 * Math.hypot(line.vx, line.vy);
  });
  if (!folded()) return false;
  // Keep the length of every line that the first level left alone or folded; a line the relations had to stretch (another cell of the
  // same column) stays free to follow.
  const foldedBases = new Set(lines.filter((line) => (x[line.base + 2]! - x[line.base]!) * line.vx + (x[line.base + 3]! - x[line.base + 1]!) * line.vy < -1e-9 * Math.hypot(line.vx, line.vy)).map((line) => line.base));
  const out = new Float64Array(8);
  const lengths = component.keep.filter((equation) => {
    if (equation.level !== 1 || equation.vars.length !== 4) return false;
    if (foldedBases.has(equation.vars[0]!)) return true;
    equation.residual(x, out, 0);
    return Math.abs(out[0]!) <= 1e-9;
  });
  if (lengths.length === 0) return false;
  const saved = component.variables.map((variable) => x[variable]!);
  for (const variable of component.variables) if (held[variable] === 0) x[variable] = model.x0[variable]!;
  const trial: Component = { hard: [...component.hard, ...lengths], soft: [], keep: [], goals: [], variables: component.variables };
  const result = levenbergMarquardt(model, trial, held, false, MAX_ITERATIONS);
  if (result.hard <= 1e-11 && !folded()) {
    for (const variable of component.variables) if (held[variable] === 0) free[variable] = 0;
    return true;
  }
  component.variables.forEach((variable, index) => { x[variable] = saved[index]!; });
  return false;
}

/**
 * Second level of the two-level solve. The geometry already meets every relation and has moved as little as it can. What the
 * relations forced to move is now brought back toward its original shape inside the freedom they leave, level by level: first the
 * direction of each line, then the length of each line and the radius of each circle, then the sweep of each arc. A shape term is
 * adopted as an exact extra relation if the relations leave room for it and skipped if they do not, so the answer is either exact or
 * the first level's, never a blur of both. Geometry the relations did not force to move is held exactly where it was, so an untouched
 * vertex never drifts to buy a better shape.
 */
function keepShape(model: SolverModel, component: Component, held: Uint8Array): void {
  if (component.keep.length === 0) return;
  const x = model.x;
  const free = Uint8Array.from(held);
  let forced = 0;
  for (const variable of component.variables) {
    if (held[variable] === 1) continue;
    if (Math.abs(x[variable]! - model.x0[variable]!) > FORCED_MOVE) forced += 1;
    else free[variable] = 1;
  }
  // A very large edit (a whole stale chain or grid moving at once) keeps the first level's answer: the shape pass would cost more than it can improve.
  if (forced === 0 || forced > MAX_KEEP_FORCED) return;
  undoFolds(model, component, held, free);
  const touching = component.keep.filter((equation) => equation.vars.some((variable) => free[variable] === 0));
  if (touching.length === 0) return;
  const out = new Float64Array(8);
  const unsatisfied = (equation: Equation): boolean => {
    equation.residual(x, out, 0);
    for (let row = 0; row < equation.size; row += 1) if (Math.abs(out[row]!) > 1e-9) return true;
    return false;
  };
  const adopted: Equation[] = [];
  let attempts = 0;
  const attempt = (extra: readonly Equation[]): boolean => {
    attempts += 1;
    const saved = component.variables.map((variable) => x[variable]!);
    const trial: Component = { hard: [...component.hard, ...adopted, ...extra], soft: [], keep: [], goals: [], variables: component.variables };
    const result = levenbergMarquardt(model, trial, free, false, KEEP_ITERATIONS);
    if (result.hard <= 1e-11) return true;
    component.variables.forEach((variable, index) => { x[variable] = saved[index]!; });
    return false;
  };
  for (const level of [0, 1, 2]) {
    const wanted = touching.filter((equation) => (equation.level ?? 1) === level);
    if (wanted.length === 0 || !wanted.some(unsatisfied)) { adopted.push(...wanted); continue; }
    if (attempt(wanted)) { adopted.push(...wanted); continue; }
    for (const equation of wanted) {
      if (!unsatisfied(equation)) { adopted.push(equation); continue; }
      if (attempts >= MAX_KEEP_ATTEMPTS) break;
      if (attempt([equation])) adopted.push(equation);
    }
  }
}


function failingReport(model: SolverModel, equations: readonly Equation[], x: Float64Array, threshold: number): ResidualReport[] {
  const reports: ResidualReport[] = [];
  const out = new Float64Array(8);
  for (const equation of equations) {
    equation.residual(x, out, 0);
    let worst = 0;
    for (let row = 0; row < equation.size; row += 1) {
      const value = Math.abs(out[row]!);
      if (!(value <= worst)) worst = Number.isNaN(value) ? Infinity : value;
    }
    if (worst > threshold) reports.push({ equation, residual: worst });
  }
  return reports.sort((a, b) => b.residual - a.residual || (a.equation.id < b.equation.id ? -1 : 1));
}

/** Solves every connected group of relations in `model`, writing the answer into `model.x`. On failure the unsatisfiable equations are reported. */
export function solveModel(model: SolverModel, options: SolveOptions, frozenOverride?: Uint8Array): SolveOutcome {
  const frozen = frozenOverride ?? model.frozen;
  const { components, constants } = partition(model, frozen, options.goals, model.soft);
  let iterations = 0;
  const failing: ResidualReport[] = [];
  const out = new Float64Array(8);
  for (const equation of constants) {
    equation.residual(model.x, out, 0);
    for (let row = 0; row < equation.size; row += 1) {
      if (!(Math.abs(out[row]!) <= options.tolerance)) {
        failing.push({ equation, residual: Math.abs(out[row]!) });
        break;
      }
    }
  }
  for (const component of components) {
    if (component.hard.length === 0 && component.goals.length === 0) continue;
    const snapshot = component.variables.map((variable) => model.x[variable]!);
    const first = levenbergMarquardt(model, { ...component, soft: [], keep: [], goals: [] }, frozen, false, MAX_ITERATIONS);
    iterations += first.iterations;
    if (first.hard > options.tolerance) {
      failing.push(...failingReport(model, component.hard, model.x, options.tolerance));
      continue;
    }
    // Anchored geometry that barely moved goes back to exactly where it was, if the relations still hold with it held there.
    const held = snapAnchored(model, component, frozen);
    // The first answer is feasible but may not be the nearest one: settle on the feasible geometry that moved least from the original.
    if (component.goals.length === 0) refineNearest(model, component, held);
    if (component.goals.length === 0 && component.soft.length === 0) keepShape(model, component, held);
    // Keep the shape: pull toward unchanged lengths and radii inside the freedom the hard relations leave.
    if (component.soft.length > 0 || component.goals.length > 0) {
      for (let cycle = 0; cycle < 8; cycle += 1) {
        const before = component.variables.map((variable) => model.x[variable]!);
        const soft = levenbergMarquardt(model, component, held, true, 40);
        const polish = levenbergMarquardt(model, { ...component, soft: [], keep: [], goals: [] }, held, false, MAX_ITERATIONS);
        iterations += soft.iterations + polish.iterations;
        if (polish.hard > options.tolerance) {
          // The soft pull wandered off the manifold: go back to the plain answer.
          component.variables.forEach((variable, index) => { model.x[variable] = before[index]!; });
          break;
        }
        const change = component.variables.reduce((largest, variable, index) => Math.max(largest, Math.abs(model.x[variable]! - before[index]!)), 0);
        if (change <= 1e-12) break;
      }
    }
    // Numbers that did not move are exactly what they were; the rest are cleaned of round-off, and a value within 5e-11 of a
    // round number (to a millionth of a millimetre) becomes that number, so 7.99999999999 reads 8.
    component.variables.forEach((variable, index) => {
      const value = model.x[variable]!;
      if (Math.abs(value - snapshot[index]!) <= UNMOVED_MM) model.x[variable] = snapshot[index]!;
      else if (Math.abs(value) < 9e4) {
        const clean = Math.round(value * 1e6) / 1e6;
        model.x[variable] = (Math.abs(value - clean) <= 5e-11 ? clean : Math.round(value * 1e11) / 1e11) + 0;
      }
    });
    const verify = maxHard(makeParts({ ...component, soft: [], keep: [], goals: [] }, frozen, false).parts, evaluateRows(component, model.x, frozen));
    if (verify > options.tolerance) failing.push(...failingReport(model, component.hard, model.x, options.tolerance));
  }
  failing.sort((a, b) => b.residual - a.residual || (a.equation.id < b.equation.id ? -1 : 1));
  const maxResidual = failing.length === 0 ? 0 : failing[0]!.residual;
  return { ok: failing.length === 0, iterations, maxResidual, failing };
}

function evaluateRows(component: Component, x: Float64Array, frozen: Uint8Array): Float64Array {
  const { parts, rowCount } = makeParts({ ...component, soft: [], keep: [], goals: [] }, frozen, false);
  const residual = new Float64Array(rowCount);
  evaluateAll(parts, x, residual);
  return residual;
}

/**
 * Anchored variables that barely moved go back to exactly where they were, if the relations still hold with them held there.
 * Returns the mask of unknowns that are now constants (the input mask when nothing was snapped).
 */
function snapAnchored(model: SolverModel, component: Component, frozen: Uint8Array): Uint8Array {
  const candidates = component.variables.filter((variable) => model.anchored[variable] === 1 && frozen[variable] === 0 && model.x[variable] !== model.x0[variable] && Math.abs(model.x[variable]! - model.x0[variable]!) < 5e-3);
  if (candidates.length === 0) return frozen;
  const backup = component.variables.map((variable) => model.x[variable]!);
  const held = Uint8Array.from(frozen);
  for (const variable of candidates) {
    model.x[variable] = model.x0[variable]!;
    held[variable] = 1;
  }
  const result = levenbergMarquardt(model, { ...component, soft: [], keep: [], goals: [] }, held, false, MAX_ITERATIONS);
  if (result.hard > 1e-9) {
    component.variables.forEach((variable, index) => { model.x[variable] = backup[index]!; });
    return frozen;
  }
  return held;
}
