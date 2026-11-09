/**
 * Sparse symmetric factorisation with a minimum-degree ordering, for the solver systems whose shape defeats a banded solve.
 *
 * A band (skyline) factorisation is the right tool for chains, rings and grids, but one unknown shared by many relations (every
 * circle "equal" to the first one, a master dimension that drives a hundred curves) makes either form of the step equations dense:
 * the damped normal equations get one full row (an arrowhead, which is cheap when that unknown is eliminated last) and the
 * least-norm form J (J'J)^-1 gets a full block (which is not cheap in any order). This file solves the same step through the
 * augmented (KKT) system
 *
 *     [ I   J' ] [ dx ]   [ 0 ]
 *     [ J  -D  ] [ -u ] = [ b ]        so that  dx = J' (J J' + D)^-1 b,
 *
 * which keeps one node per unknown and one per residual row and so stays as sparse as the sketch itself. The matrix is
 * quasi-definite (positive block on the unknowns, negative block on the rows), so an LDL' factorisation exists for every ordering and
 * the ordering is free to be chosen for sparsity alone. Everything is deterministic: ties break by index.
 */

/** A residual row of the Jacobian, already scaled: the unknowns it touches and its entries. */
export interface ScaledRow {
  readonly columns: Int32Array;
  readonly scaled: Float64Array;
}

/** More rows than this on one unknown makes the least-norm (row) form dense; the augmented form is used instead. */
export const HUB_ROWS = 20;

/** The largest number of rows that touch one unknown. */
export function maxRowsPerColumn(rows: readonly ScaledRow[], columnCount: number): number {
  const counts = new Int32Array(columnCount);
  let largest = 0;
  for (const row of rows) {
    for (let k = 0; k < row.columns.length; k += 1) {
      const column = row.columns[k]!;
      counts[column] = counts[column]! + 1;
      if (counts[column]! > largest) largest = counts[column]!;
    }
  }
  return largest;
}

/**
 * Solves the damped least-norm system: returns dx = J' (J J' + D)^-1 target, with D = diag(damping), or undefined when the
 * augmented matrix breaks down numerically (the caller then raises the damping and tries again).
 */
export function solveLeastNormSparse(columnCount: number, rows: readonly ScaledRow[], damping: Float64Array, target: Float64Array): Float64Array | undefined {
  const rowCount = rows.length;
  const n = columnCount + rowCount;
  const diag = new Float64Array(n);
  const sign = new Int8Array(n);
  const lower: Map<number, number>[] = Array.from({ length: n }, () => new Map<number, number>());
  for (let column = 0; column < columnCount; column += 1) {
    diag[column] = 1;
    sign[column] = 1;
  }
  const rhs = new Float64Array(n);
  rows.forEach((row, index) => {
    const node = columnCount + index;
    diag[node] = -damping[index]!;
    sign[node] = -1;
    rhs[node] = target[index]!;
    const map = lower[node]!;
    for (let k = 0; k < row.columns.length; k += 1) {
      const column = row.columns[k]!;
      map.set(column, (map.get(column) ?? 0) + row.scaled[k]!);
    }
  });
  const solved = factorAndSolve(n, diag, lower, rhs, sign);
  return solved === undefined ? undefined : solved.subarray(0, columnCount);
}

/** Solves A x = b for a symmetric positive-definite A (diagonal and strictly lower triangle), ordered by minimum degree. */
export function solveSymmetricSparse(n: number, diag: Float64Array, lower: readonly Map<number, number>[], rhs: Float64Array): Float64Array | undefined {
  const sign = new Int8Array(n).fill(1);
  return factorAndSolve(n, diag, lower, rhs, sign);
}

interface Elimination {
  readonly pivot: number;
  readonly value: number;
  readonly neighbours: Int32Array;
  readonly multipliers: Float64Array;
}

/** A binary min-heap on (degree, index) with lazy deletion: stale entries are skipped when popped. */
class DegreeHeap {
  private readonly degree: number[] = [];
  private readonly node: number[] = [];

  get size(): number {
    return this.node.length;
  }

  push(degree: number, node: number): void {
    let at = this.node.length;
    this.degree.push(degree);
    this.node.push(node);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (!this.before(at, parent)) break;
      this.swap(at, parent);
      at = parent;
    }
  }

  pop(): { readonly degree: number; readonly node: number } {
    const top = { degree: this.degree[0]!, node: this.node[0]! };
    const lastDegree = this.degree.pop()!;
    const lastNode = this.node.pop()!;
    if (this.node.length > 0) {
      this.degree[0] = lastDegree;
      this.node[0] = lastNode;
      let at = 0;
      for (;;) {
        const left = 2 * at + 1;
        const right = left + 1;
        let best = at;
        if (left < this.node.length && this.before(left, best)) best = left;
        if (right < this.node.length && this.before(right, best)) best = right;
        if (best === at) break;
        this.swap(at, best);
        at = best;
      }
    }
    return top;
  }

  private before(a: number, b: number): boolean {
    return this.degree[a]! < this.degree[b]! || (this.degree[a] === this.degree[b] && this.node[a]! < this.node[b]!);
  }

  private swap(a: number, b: number): void {
    const degree = this.degree[a]!;
    const node = this.node[a]!;
    this.degree[a] = this.degree[b]!;
    this.node[a] = this.node[b]!;
    this.degree[b] = degree;
    this.node[b] = node;
  }
}

/**
 * LDL' without pivoting; each node is eliminated when its current degree is the smallest, and the fill that creates is tracked as it
 * happens. `sign` is the sign each pivot must have (+1 for the positive block, -1 for the negative one); a pivot of the wrong sign,
 * or one that lost thirteen digits to cancellation, is a breakdown.
 */
function factorAndSolve(n: number, diag: Float64Array, lower: readonly Map<number, number>[], rhs: Float64Array, sign: Int8Array): Float64Array | undefined {
  if (n === 0) return new Float64Array(0);
  const adjacency: Map<number, number>[] = Array.from({ length: n }, () => new Map<number, number>());
  for (let i = 0; i < n; i += 1) {
    for (const [j, value] of lower[i]!) {
      adjacency[i]!.set(j, (adjacency[i]!.get(j) ?? 0) + value);
      adjacency[j]!.set(i, (adjacency[j]!.get(i) ?? 0) + value);
    }
  }
  const d = Float64Array.from(diag);
  const scale = Float64Array.from(diag, (value) => Math.abs(value));
  const done = new Uint8Array(n);
  const heap = new DegreeHeap();
  for (let i = 0; i < n; i += 1) heap.push(adjacency[i]!.size, i);
  const eliminations: Elimination[] = [];
  while (eliminations.length < n) {
    const { degree, node: pivot } = heap.pop();
    if (done[pivot] === 1 || degree !== adjacency[pivot]!.size) continue;
    done[pivot] = 1;
    const value = d[pivot]!;
    if (!Number.isFinite(value) || !(sign[pivot]! * value > 1e-13 * Math.max(scale[pivot]!, 1e-300))) return undefined;
    const map = adjacency[pivot]!;
    const count = map.size;
    const neighbours = new Int32Array(count);
    const entries = new Float64Array(count);
    let at = 0;
    for (const [j, a] of map) {
      neighbours[at] = j;
      entries[at] = a;
      at += 1;
    }
    const multipliers = new Float64Array(count);
    for (let a = 0; a < count; a += 1) multipliers[a] = entries[a]! / value;
    for (let a = 0; a < count; a += 1) {
      const ja = neighbours[a]!;
      const rowA = adjacency[ja]!;
      rowA.delete(pivot);
      d[ja] = d[ja]! - multipliers[a]! * entries[a]!;
      for (let b = 0; b < a; b += 1) {
        const jb = neighbours[b]!;
        const update = multipliers[a]! * entries[b]!;
        rowA.set(jb, (rowA.get(jb) ?? 0) - update);
        const rowB = adjacency[jb]!;
        rowB.set(ja, (rowB.get(ja) ?? 0) - update);
      }
    }
    for (let a = 0; a < count; a += 1) heap.push(adjacency[neighbours[a]!]!.size, neighbours[a]!);
    eliminations.push({ pivot, value, neighbours, multipliers });
  }
  const y = Float64Array.from(rhs);
  for (const step of eliminations) {
    const carried = y[step.pivot]!;
    for (let a = 0; a < step.neighbours.length; a += 1) y[step.neighbours[a]!] = y[step.neighbours[a]!]! - step.multipliers[a]! * carried;
  }
  for (const step of eliminations) y[step.pivot] = y[step.pivot]! / step.value;
  for (let index = eliminations.length - 1; index >= 0; index -= 1) {
    const step = eliminations[index]!;
    let sum = y[step.pivot]!;
    for (let a = 0; a < step.neighbours.length; a += 1) sum -= step.multipliers[a]! * y[step.neighbours[a]!]!;
    y[step.pivot] = sum;
  }
  return y;
}
