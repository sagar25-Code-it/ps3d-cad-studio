import { differenceStep, type Equation, type SolverModel } from "./equation-model.js";
import { eliminateRows, independentCount, type SparseRow } from "./linear-algebra.js";
import type { SketchDofState, SketchRelationSet } from "./types.js";

/**
 * Degrees of freedom from the rank of the relations' Jacobian at the current geometry: DOF = free variables - rank. A row that
 * the earlier rows already imply is a redundant relation (its residual is zero) or a conflicting one (its residual is not),
 * and the exact set of relations it is a combination of is reported by name.
 */

export interface RankAnalysis {
  readonly dof: SketchDofState;
  /** Relation sets by constraint/dimension/fix ID, before human labels are applied. */
  readonly sets: readonly { readonly kind: "redundant" | "conflicting"; readonly ids: readonly string[]; /** For a redundant set: the relation, made last, that the others already imply. */ readonly implied: string }[];
}

interface JacobianRow {
  readonly equation: Equation;
  readonly index: number;
  readonly residual: number;
  readonly freeCols: number[];
  readonly freeVals: number[];
  readonly frozenCols: number[];
  readonly frozenVals: number[];
}

const REDUNDANT_RESIDUAL = 1e-6;

export function jacobianRows(model: SolverModel, equations: readonly Equation[], x: Float64Array): JacobianRow[] {
  const rows: JacobianRow[] = [];
  const base = new Float64Array(8);
  const plus = new Float64Array(8);
  const minus = new Float64Array(8);
  const plusTwo = new Float64Array(8);
  const minusTwo = new Float64Array(8);
  for (const equation of equations) {
    equation.eval(x, base, 0);
    const baseStep = differenceStep(model.role, x, equation.vars);
    const cols: number[][] = Array.from({ length: equation.size }, () => []);
    const vals: number[][] = Array.from({ length: equation.size }, () => []);
    for (const variable of equation.vars) {
      const original = x[variable]!;
      const step = model.role[variable] === 0 ? baseStep : 1e-4 * Math.max(1, Math.abs(original));
      x[variable] = original + step;
      equation.eval(x, plus, 0);
      x[variable] = original - step;
      equation.eval(x, minus, 0);
      x[variable] = original + 2 * step;
      equation.eval(x, plusTwo, 0);
      x[variable] = original - 2 * step;
      equation.eval(x, minusTwo, 0);
      x[variable] = original;
      for (let row = 0; row < equation.size; row += 1) {
        const derivative = (8 * (plus[row]! - minus[row]!) - (plusTwo[row]! - minusTwo[row]!)) / (12 * step);
        if (Number.isFinite(derivative) && Math.abs(derivative) > 1e-10) {
          cols[row]!.push(variable);
          vals[row]!.push(derivative);
        }
      }
    }
    for (let row = 0; row < equation.size; row += 1) {
      const freeCols: number[] = [];
      const freeVals: number[] = [];
      const frozenCols: number[] = [];
      const frozenVals: number[] = [];
      cols[row]!.forEach((variable, index) => {
        if (model.frozen[variable] === 0) {
          freeCols.push(variable);
          freeVals.push(vals[row]![index]!);
        } else {
          frozenCols.push(variable);
          frozenVals.push(vals[row]![index]!);
        }
      });
      rows.push({ equation, index: row, residual: base[row]!, freeCols, freeVals, frozenCols, frozenVals });
    }
  }
  return rows;
}

/** Union-find over column indices. */
class Groups {
  private readonly parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }
  find(index: number): number {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root]!;
    let current = index;
    while (this.parent[current] !== root) {
      const next = this.parent[current]!;
      this.parent[current] = root;
      current = next;
    }
    return root;
  }
  union(a: number, b: number): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }
}

export function analyzeRank(model: SolverModel, options: { readonly invalid?: boolean } = {}): RankAnalysis {
  const x = model.x;
  const free: number[] = [];
  const column = new Int32Array(model.variableCount).fill(-1);
  for (let variable = 0; variable < model.variableCount; variable += 1) {
    if (model.frozen[variable] === 0) {
      column[variable] = free.length;
      free.push(variable);
    }
  }
  const rows = jacobianRows(model, model.equations, x);
  const groups = new Groups(free.length);
  const touched = new Uint8Array(free.length);
  for (const row of rows) {
    const columns = row.freeCols.map((variable) => column[variable]!);
    for (const c of columns) touched[c] = 1;
    for (let index = 1; index < columns.length; index += 1) groups.union(columns[0]!, columns[index]!);
  }

  // Rows per group (rows without a free column are checked on their own).
  const byGroup = new Map<number, JacobianRow[]>();
  const constantRows: JacobianRow[] = [];
  for (const row of rows) {
    if (row.freeCols.length === 0) constantRows.push(row);
    else {
      const root = groups.find(column[row.freeCols[0]!]!);
      const list = byGroup.get(root) ?? [];
      list.push(row);
      byGroup.set(root, list);
    }
  }

  const setMap = new Map<string, { kind: "redundant" | "conflicting"; ids: string[]; implied: string }>();
  const addSet = (kind: "redundant" | "conflicting", dependent: JacobianRow, support: readonly JacobianRow[]): void => {
    const ids = new Set<string>([dependent.equation.id]);
    // A relation whose gradient vanished (perpendicular on lines that are already parallel) is stuck because of the others on the same curves.
    if (kind === "conflicting" && support.length === 0 && dependent.frozenCols.length === 0) {
      const sameCurves = (entities: readonly string[]): boolean => dependent.equation.entities.length > 0 && entities.length === dependent.equation.entities.length && entities.every((entity) => dependent.equation.entities.includes(entity));
      for (const equation of model.equations) if (equation !== dependent.equation && sameCurves(equation.entities)) ids.add(equation.id);
    }
    for (const row of support) {
      ids.add(row.equation.id);
      for (let index = 0; index < row.frozenCols.length; index += 1) {
        if (Math.abs(row.frozenVals[index]!) <= 1e-9) continue;
        for (const fix of model.frozenBy.get(row.frozenCols[index]!) ?? []) ids.add(fix);
      }
    }
    for (let index = 0; index < dependent.frozenCols.length; index += 1) {
      if (Math.abs(dependent.frozenVals[index]!) <= 1e-9) continue;
      for (const fix of model.frozenBy.get(dependent.frozenCols[index]!) ?? []) ids.add(fix);
    }
    const sorted = [...ids].sort();
    const key = `${kind}|${sorted.join("|")}`;
    if (!setMap.has(key)) setMap.set(key, { kind, ids: sorted, implied: dependent.equation.id });
  };

  const entityRank = new Map<string, number>();
  const bump = (entity: string, amount: number): void => { entityRank.set(entity, (entityRank.get(entity) ?? 0) + amount); };
  let dofTotal = 0;
  let rankTotal = 0;

  for (const row of constantRows) {
    addSet(Math.abs(row.residual) > REDUNDANT_RESIDUAL ? "conflicting" : "redundant", row, []);
  }

  const columnsByGroup = new Map<number, number[]>();
  for (let c = 0; c < free.length; c += 1) {
    if (touched[c] === 0) continue;
    const root = groups.find(c);
    const list = columnsByGroup.get(root) ?? [];
    list.push(c);
    columnsByGroup.set(root, list);
  }
  for (const [root, list] of [...columnsByGroup.entries()].sort((a, b) => a[0] - b[0])) {
    const groupRows = byGroup.get(root) ?? [];
    const localIndex = new Map<number, number>();
    list.forEach((c, index) => localIndex.set(c, index));
    const sparse: SparseRow[] = groupRows.map((row) => ({ cols: row.freeCols.map((variable) => localIndex.get(column[variable]!)!), vals: row.freeVals }));
    // Rows that carry the largest residuals go last, so a conflicting row is the one reported as dependent; among consistent rows the latest one made is.
    const quantised = (row: JacobianRow): number => (Math.abs(row.residual) > REDUNDANT_RESIDUAL ? Math.abs(row.residual) : 0);
    const order = groupRows.map((_, index) => index).sort((a, b) => quantised(groupRows[a]!) - quantised(groupRows[b]!) || a - b);
    const ordered = order.map((index) => sparse[index]!);
    const elimination = eliminateRows(ordered, list.length, 1e-7, groupRows.length <= 4000);
    rankTotal += elimination.rank;
    dofTotal += list.length - elimination.rank;
    for (const dependent of elimination.dependent) {
      const row = groupRows[order[dependent.row]!]!;
      const support = dependent.support.filter((entry) => entry !== dependent.row).map((entry) => groupRows[order[entry]!]!);
      addSet(Math.abs(row.residual) > REDUNDANT_RESIDUAL ? "conflicting" : "redundant", row, support);
    }
    // Per-entity freedom: independent directions of the null space that move that entity's variables.
    const basis = elimination.nullSpace();
    const entityColumns = new Map<string, number[]>();
    list.forEach((c, index) => {
      const entity = model.entityOfVariable[free[c]!]!;
      const entry = entityColumns.get(entity) ?? [];
      entry.push(index);
      entityColumns.set(entity, entry);
    });
    for (const [entity, indices] of entityColumns) {
      const vectors = indices.map((index) => Float64Array.from(basis, (vector) => vector[index]!));
      bump(entity, independentCount(vectors));
    }
  }
  // Variables no relation mentions are free on their own.
  for (let c = 0; c < free.length; c += 1) {
    if (touched[c] === 1) continue;
    dofTotal += 1;
    bump(model.entityOfVariable[free[c]!]!, 1);
  }

  const byEntity: Record<string, number> = {};
  for (const entry of [...model.layout.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const geometry = entry.geometry;
    if (geometry.kind === "spline") {
      byEntity[entry.id] = geometry.suppressed || geometry.source?.associative === true ? 0 : Math.max(0, geometry.controlPoints.length * 2);
      continue;
    }
    byEntity[entry.id] = entityRank.get(entry.id) ?? 0;
  }
  const splineFreedom = [...model.layout.values()].reduce((sum, entry) => sum + (entry.geometry.kind === "spline" ? byEntity[entry.id]! : 0), 0);
  const total = dofTotal + splineFreedom;
  const sets = [...setMap.values()].sort((a, b) => (a.kind === b.kind ? (a.ids.join() < b.ids.join() ? -1 : 1) : a.kind === "conflicting" ? -1 : 1));
  const conflicting = sets.filter((set) => set.kind === "conflicting");
  const hasGeometry = [...model.layout.values()].some((entry) => !entry.geometry.suppressed);
  const dof: SketchDofState = {
    classification: options.invalid === true ? "invalid" : conflicting.length > 0 ? "over-constrained" : total === 0 && hasGeometry ? "fully-constrained" : "under-constrained",
    total,
    byEntity,
    unconstrainedEntityIds: Object.entries(byEntity).filter(([, value]) => value > 0).map(([id]) => id),
    method: "jacobian-rank-v2",
    rank: rankTotal,
    variables: free.length,
    redundantIds: [...new Set(sets.filter((set) => set.kind === "redundant").flatMap((set) => set.ids))].sort(),
    conflictingIds: [...new Set(conflicting.flatMap((set) => set.ids))].sort()
  };
  return { dof, sets };
}

/** Attaches labels and messages to the raw sets. */
export function describeSets(raw: RankAnalysis["sets"], labelOf: (id: string) => string): readonly SketchRelationSet[] {
  return raw.map((set) => {
    const labels = set.ids.map(labelOf);
    const list = joinNames(labels);
    return {
      kind: set.kind,
      ids: set.ids,
      labels,
      ...(set.kind === "redundant" ? { implied: set.implied } : {}),
      message: set.kind === "conflicting"
        ? `These relations contradict each other: ${list}. Remove or relax one of them.`
        : set.ids.length === 1
          ? `${labels[0]} has no effect on this geometry; it can be removed.`
          : `${labelOf(set.implied)} adds nothing: the others already imply it (${joinNames(set.ids.filter((id) => id !== set.implied).map(labelOf).slice(0, 5))}${set.ids.length > 6 ? ` and ${set.ids.length - 6} more` : ""}).`
    };
  });
}

export function joinNames(labels: readonly string[]): string {
  if (labels.length <= 1) return labels[0] ?? "";
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`;
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}
