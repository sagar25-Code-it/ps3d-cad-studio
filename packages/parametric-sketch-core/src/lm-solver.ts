import type { Equation, SolverModel } from "./equation-model.js";
import { solveSymmetric } from "./linear-algebra.js";

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
const SOFT_FACTOR = 1e-3;
/** Weight of the "stay where you were" term in the soft phase, so that anchored geometry resists the soft pull and free geometry does not. */
const STAY_FACTOR = SOFT_FACTOR * SOFT_FACTOR * 1e-4;
const MAX_ITERATIONS = 120;
/** One step may turn an angle by at most this many radians and change a size by at most this fraction of it. */
const MAX_ANGLE_STEP = 0.35;
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
  for (const part of parts) part.equation.eval(x, residual, part.rowStart);
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

/** Central-difference Jacobian of the parts' residuals with respect to the component's active variables. */
function jacobian(parts: readonly Part[], x: Float64Array, rowCount: number, scratchPlus: Float64Array, scratchMinus: Float64Array): Row[] {
  const rows: Row[] = Array.from({ length: rowCount }, () => ({ cols: [], vals: [] }));
  for (const part of parts) {
    const size = part.equation.size;
    for (const variable of part.active) {
      const original = x[variable]!;
      const step = 1e-6 * Math.max(1, Math.abs(original));
      x[variable] = original + step;
      part.equation.eval(x, scratchPlus, 0);
      x[variable] = original - step;
      part.equation.eval(x, scratchMinus, 0);
      x[variable] = original;
      for (let row = 0; row < size; row += 1) {
        const derivative = (scratchPlus[row]! - scratchMinus[row]!) / (2 * step);
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
  const everything: Equation[] = [...model.equations, ...softEquations, ...(goals ?? []).map((goal) => goal.equation)];
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
      component = { hard: [], soft: [], goals: [], variables: [] };
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
    for (const equation of component.soft) push(equation, SOFT_FACTOR);
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
  const plus = new Float64Array(8);
  const minus = new Float64Array(8);
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
  for (; iteration < maxIterations; iteration += 1) {
    const hardNow = maxHard(parts, residual);
    if (!includeSoft && hardNow <= CONVERGED) break;
    if (!Number.isFinite(cost)) break;
    const rows = jacobian(parts, x, rowCount, plus, minus);
    const diag = new Float64Array(n);
    const lower: Map<number, number>[] = Array.from({ length: n }, () => new Map<number, number>());
    const rhs = new Float64Array(n);
    for (const part of parts) {
      const factor = part.factor;
      for (let row = 0; row < part.equation.size; row += 1) {
        const entry = rows[part.rowStart + row]!;
        const value = residual[part.rowStart + row]!;
        const count = entry.cols.length;
        const columns = new Int32Array(count);
        const scaled = new Float64Array(count);
        for (let k = 0; k < count; k += 1) {
          const column = local.get(entry.cols[k]!)!;
          columns[k] = column;
          scaled[k] = entry.vals[k]! * invSqrtWeight[column]! * factor;
        }
        for (let a = 0; a < count; a += 1) {
          const ca = columns[a]!;
          const va = scaled[a]!;
          diag[ca] = diag[ca]! + va * va;
          rhs[ca] = rhs[ca]! - va * value * factor;
          for (let b = 0; b < a; b += 1) {
            const cb = columns[b]!;
            const high = Math.max(ca, cb);
            const low = Math.min(ca, cb);
            const map = lower[high]!;
            map.set(low, (map.get(low) ?? 0) + va * scaled[b]!);
          }
        }
      }
    }
    if (includeSoft) {
      for (let index = 0; index < n; index += 1) {
        const scaledGap = (x[variables[index]!]! - stay[index]!) / invSqrtWeight[index]!;
        diag[index] = diag[index]! + STAY_FACTOR;
        rhs[index] = rhs[index]! - STAY_FACTOR * scaledGap;
      }
    }
    let accepted = false;
    const backup = variables.map((variable) => x[variable]!);
    for (let attempt = 0; attempt < 14 && !accepted; attempt += 1) {
      const damped = Float64Array.from(diag);
      for (let index = 0; index < n; index += 1) damped[index] = damped[index]! + lambda;
      const step = solveSymmetric(n, damped, lower, rhs);
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
          cost = next;
          lambda = Math.max(lambda * 0.2, includeSoft ? 1e-9 : 1e-12);
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
    if (includeSoft && moved <= 1e-12) break;
  }
  return { iterations: iteration, hard: maxHard(parts, residual), moved };
}

function failingReport(model: SolverModel, equations: readonly Equation[], x: Float64Array, threshold: number): ResidualReport[] {
  const reports: ResidualReport[] = [];
  const out = new Float64Array(8);
  for (const equation of equations) {
    equation.eval(x, out, 0);
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
    equation.eval(model.x, out, 0);
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
    const first = levenbergMarquardt(model, { ...component, soft: [], goals: [] }, frozen, false, MAX_ITERATIONS);
    iterations += first.iterations;
    if (first.hard > options.tolerance) {
      failing.push(...failingReport(model, component.hard, model.x, options.tolerance));
      continue;
    }
    // Keep the shape: pull toward unchanged lengths and radii inside the freedom the hard relations leave.
    if (component.soft.length > 0 || component.goals.length > 0) {
      for (let cycle = 0; cycle < 4; cycle += 1) {
        const before = component.variables.map((variable) => model.x[variable]!);
        const soft = levenbergMarquardt(model, component, frozen, true, 40);
        const polish = levenbergMarquardt(model, { ...component, soft: [], goals: [] }, frozen, false, MAX_ITERATIONS);
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
    snapAnchored(model, component, frozen);
    // Numbers that did not move are exactly what they were; the rest are cleaned of round-off.
    component.variables.forEach((variable, index) => {
      const value = model.x[variable]!;
      if (Math.abs(value - snapshot[index]!) <= 1e-13) model.x[variable] = snapshot[index]!;
      else if (Math.abs(value) < 9e4) model.x[variable] = Math.round(value * 1e11) / 1e11;
    });
    const verify = maxHard(makeParts({ ...component, soft: [], goals: [] }, frozen, false).parts, evaluateRows(component, model.x, frozen));
    if (verify > options.tolerance) failing.push(...failingReport(model, component.hard, model.x, options.tolerance));
  }
  failing.sort((a, b) => b.residual - a.residual || (a.equation.id < b.equation.id ? -1 : 1));
  const maxResidual = failing.length === 0 ? 0 : failing[0]!.residual;
  return { ok: failing.length === 0, iterations, maxResidual, failing };
}

function evaluateRows(component: Component, x: Float64Array, frozen: Uint8Array): Float64Array {
  const { parts, rowCount } = makeParts({ ...component, soft: [], goals: [] }, frozen, false);
  const residual = new Float64Array(rowCount);
  evaluateAll(parts, x, residual);
  return residual;
}

/** Anchored variables that barely moved go back to exactly where they were, if the relations still hold with them held there. */
function snapAnchored(model: SolverModel, component: Component, frozen: Uint8Array): void {
  const candidates = component.variables.filter((variable) => model.anchored[variable] === 1 && frozen[variable] === 0 && model.x[variable] !== model.x0[variable] && Math.abs(model.x[variable]! - model.x0[variable]!) < 5e-3);
  if (candidates.length === 0) return;
  const backup = component.variables.map((variable) => model.x[variable]!);
  const held = Uint8Array.from(frozen);
  for (const variable of candidates) {
    model.x[variable] = model.x0[variable]!;
    held[variable] = 1;
  }
  const result = levenbergMarquardt(model, { ...component, soft: [], goals: [] }, held, false, MAX_ITERATIONS);
  if (result.hard > 1e-9) component.variables.forEach((variable, index) => { model.x[variable] = backup[index]!; });
}
