/**
 * Small sparse linear algebra for the sketch solver: a symmetric positive-definite solve (reverse Cuthill-McKee ordering and a
 * skyline Cholesky factorisation, so chains, rings and grids of sketch geometry cost almost nothing) and an incremental sparse
 * row elimination that gives the rank of a Jacobian, the exact set of rows each dependent row is a combination of, and a
 * null-space basis. Both are deterministic: no randomness, ties break by index.
 */

/** Solves A x = b for a symmetric positive-definite A given as its diagonal and strictly lower triangle. Undefined when A is not positive definite. */
export function solveSymmetric(n: number, diag: Float64Array, lower: readonly Map<number, number>[], rhs: Float64Array): Float64Array | undefined {
  if (n === 0) return new Float64Array(0);
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i += 1) {
    for (const j of lower[i]!.keys()) {
      adjacency[i]!.push(j);
      adjacency[j]!.push(i);
    }
  }
  const order = reverseCuthillMcKee(n, adjacency);
  const position = new Int32Array(n);
  for (let index = 0; index < n; index += 1) position[order[index]!] = index;

  const first = new Int32Array(n);
  for (let i = 0; i < n; i += 1) first[i] = i;
  for (let i = 0; i < n; i += 1) {
    for (const j of lower[i]!.keys()) {
      const a = position[i]!;
      const b = position[j]!;
      const high = Math.max(a, b);
      const low = Math.min(a, b);
      if (low < first[high]!) first[high] = low;
    }
  }
  const rows: Float64Array[] = new Array<Float64Array>(n);
  for (let i = 0; i < n; i += 1) rows[i] = new Float64Array(i - first[i]! + 1);
  const scale = new Float64Array(n);
  for (let old = 0; old < n; old += 1) {
    const i = position[old]!;
    rows[i]![i - first[i]!] = diag[old]!;
    scale[i] = diag[old]!;
    for (const [oldColumn, value] of lower[old]!) {
      const a = i;
      const b = position[oldColumn]!;
      const high = Math.max(a, b);
      const low = Math.min(a, b);
      rows[high]![low - first[high]!] = value;
    }
  }
  for (let i = 0; i < n; i += 1) {
    const firstI = first[i]!;
    const rowI = rows[i]!;
    for (let j = firstI; j < i; j += 1) {
      const firstJ = first[j]!;
      const rowJ = rows[j]!;
      let sum = rowI[j - firstI]!;
      for (let k = Math.max(firstI, firstJ); k < j; k += 1) sum -= rowI[k - firstI]! * rowJ[k - firstJ]!;
      rowI[j - firstI] = sum / rowJ[j - firstJ]!;
    }
    let pivot = rowI[i - firstI]!;
    for (let k = firstI; k < i; k += 1) pivot -= rowI[k - firstI]! ** 2;
    if (!(pivot > 1e-13 * Math.max(scale[i]!, 1e-300))) return undefined;
    rowI[i - firstI] = Math.sqrt(pivot);
  }
  const y = new Float64Array(n);
  for (let old = 0; old < n; old += 1) y[position[old]!] = rhs[old]!;
  for (let i = 0; i < n; i += 1) {
    const firstI = first[i]!;
    const rowI = rows[i]!;
    let sum = y[i]!;
    for (let k = firstI; k < i; k += 1) sum -= rowI[k - firstI]! * y[k]!;
    y[i] = sum / rowI[i - firstI]!;
  }
  for (let i = n - 1; i >= 0; i -= 1) {
    const firstI = first[i]!;
    const rowI = rows[i]!;
    y[i] = y[i]! / rowI[i - firstI]!;
    const value = y[i]!;
    for (let k = firstI; k < i; k += 1) y[k] = y[k]! - rowI[k - firstI]! * value;
  }
  const result = new Float64Array(n);
  for (let old = 0; old < n; old += 1) result[old] = y[position[old]!]!;
  return result;
}

/** order[newIndex] = oldIndex. Components are started from their lowest-degree (then lowest-index) node. */
function reverseCuthillMcKee(n: number, adjacency: readonly number[][]): Int32Array {
  const degree = adjacency.map((neighbours) => neighbours.length);
  const visited = new Uint8Array(n);
  const order: number[] = [];
  const starts = Array.from({ length: n }, (_, index) => index).sort((a, b) => degree[a]! - degree[b]! || a - b);
  for (const start of starts) {
    if (visited[start] === 1) continue;
    visited[start] = 1;
    const queue = [start];
    for (let head = 0; head < queue.length; head += 1) {
      const node = queue[head]!;
      order.push(node);
      const next = adjacency[node]!.filter((neighbour) => visited[neighbour] === 0).sort((a, b) => degree[a]! - degree[b]! || a - b);
      for (const neighbour of next) {
        if (visited[neighbour] === 1) continue;
        visited[neighbour] = 1;
        queue.push(neighbour);
      }
    }
  }
  order.reverse();
  return Int32Array.from(order);
}

export interface SparseRow {
  readonly cols: readonly number[];
  readonly vals: readonly number[];
}

export interface DependentRow {
  /** Index of the row that turned out to be a combination of earlier ones. */
  readonly row: number;
  /** Rows (by index, including `row` itself) whose combination reproduces it; coefficients are relative to the largest. */
  readonly support: readonly number[];
  /** How much of the row survives after the elimination, relative to its own size (0 for an exact combination). */
  readonly leftover: number;
}

export interface EliminationResult {
  readonly rank: number;
  readonly dependent: readonly DependentRow[];
  /** Pivot columns in creation order. */
  readonly pivotColumns: readonly number[];
  /** Null-space basis, one vector (length = column count) per free column, in ascending free-column order. */
  nullSpace(): Float64Array[];
  readonly freeColumns: readonly number[];
}

/**
 * Processes rows in order, keeping each row that adds rank as a pivot row and reporting each row that does not. A row is
 * dependent when what is left of it, after subtracting its components along the earlier pivot rows, is at most `tolerance`
 * times its own norm. With `trackSupport` a dependent row reports exactly which earlier rows it is a combination of (the
 * smallest circuit, because every earlier row is independent), which is how a redundant or conflicting set is named.
 */
export function eliminateRows(rows: readonly SparseRow[], columnCount: number, tolerance = 1e-7, trackSupport = true): EliminationResult {
  interface Pivot {
    readonly column: number;
    readonly cols: number[];
    readonly vals: number[];
    readonly combo: Map<number, number> | undefined;
  }
  const pivots: Pivot[] = [];
  const dependent: DependentRow[] = [];
  const work = new Float64Array(columnCount);
  const isPivotColumn = new Uint8Array(columnCount);

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]!;
    let norm = 0;
    for (const value of row.vals) norm += value * value;
    norm = Math.sqrt(norm);
    if (!(norm > 1e-12)) {
      dependent.push({ row: rowIndex, support: [rowIndex], leftover: 0 });
      continue;
    }
    const touched = new Set<number>();
    for (let index = 0; index < row.cols.length; index += 1) {
      const column = row.cols[index]!;
      work[column] = work[column]! + row.vals[index]! / norm;
      touched.add(column);
    }
    const combo = trackSupport ? new Map<number, number>([[rowIndex, 1]]) : undefined;
    for (const pivot of pivots) {
      const factor = work[pivot.column]!;
      if (Math.abs(factor) <= 1e-15) continue;
      for (let index = 0; index < pivot.cols.length; index += 1) {
        const column = pivot.cols[index]!;
        work[column] = work[column]! - factor * pivot.vals[index]!;
        touched.add(column);
      }
      work[pivot.column] = 0;
      if (combo !== undefined && pivot.combo !== undefined) {
        for (const [source, coefficient] of pivot.combo) combo.set(source, (combo.get(source) ?? 0) - factor * coefficient);
      }
    }
    let leftover = 0;
    let bestColumn = -1;
    let bestValue = 0;
    for (const column of [...touched].sort((a, b) => a - b)) {
      const value = work[column]!;
      leftover += value * value;
      if (Math.abs(value) > Math.abs(bestValue) + 1e-15) {
        bestValue = value;
        bestColumn = column;
      }
    }
    leftover = Math.sqrt(leftover);
    if (leftover > tolerance && bestColumn >= 0) {
      const cols: number[] = [];
      const vals: number[] = [];
      for (const column of [...touched].sort((a, b) => a - b)) {
        const value = work[column]!;
        if (Math.abs(value) > 1e-14) {
          cols.push(column);
          vals.push(value / bestValue);
        }
      }
      let pivotCombo: Map<number, number> | undefined;
      if (combo !== undefined) {
        pivotCombo = new Map();
        for (const [source, coefficient] of combo) pivotCombo.set(source, coefficient / bestValue);
      }
      pivots.push({ column: bestColumn, cols, vals, combo: pivotCombo });
      isPivotColumn[bestColumn] = 1;
    } else {
      // row = (its normalised self) minus its leftover, and the leftover is the combination of pivots just subtracted.
      const support: number[] = [rowIndex];
      if (combo !== undefined) {
        let largest = 0;
        for (const [source, coefficient] of combo) if (source !== rowIndex) largest = Math.max(largest, Math.abs(coefficient));
        for (const [source, coefficient] of combo) {
          if (source !== rowIndex && Math.abs(coefficient) > 1e-7 * Math.max(largest, 1e-300) && Math.abs(coefficient) > 1e-10) support.push(source);
        }
      }
      dependent.push({ row: rowIndex, support: support.sort((a, b) => a - b), leftover: leftover });
    }
    for (const column of touched) work[column] = 0;
  }

  const freeColumns: number[] = [];
  for (let column = 0; column < columnCount; column += 1) if (isPivotColumn[column] === 0) freeColumns.push(column);
  return {
    rank: pivots.length,
    dependent,
    pivotColumns: pivots.map((pivot) => pivot.column),
    freeColumns,
    nullSpace: () => {
      const basis: Float64Array[] = [];
      for (const free of freeColumns) {
        const vector = new Float64Array(columnCount);
        vector[free] = 1;
        for (let k = pivots.length - 1; k >= 0; k -= 1) {
          const pivot = pivots[k]!;
          let sum = 0;
          for (let index = 0; index < pivot.cols.length; index += 1) {
            const column = pivot.cols[index]!;
            if (column !== pivot.column) sum += pivot.vals[index]! * vector[column]!;
          }
          vector[pivot.column] = -sum;
        }
        basis.push(vector);
      }
      return basis;
    }
  };
}

/** Number of linearly independent vectors among `vectors` (Gram-Schmidt, absolute tolerance on unit-scale null-space vectors). */
export function independentCount(vectors: readonly Float64Array[], tolerance = 1e-6): number {
  const basis: Float64Array[] = [];
  for (const source of vectors) {
    const vector = Float64Array.from(source);
    for (const existing of basis) {
      let dot = 0;
      for (let index = 0; index < vector.length; index += 1) dot += vector[index]! * existing[index]!;
      for (let index = 0; index < vector.length; index += 1) vector[index] = vector[index]! - dot * existing[index]!;
    }
    let norm = 0;
    for (let index = 0; index < vector.length; index += 1) norm += vector[index]! * vector[index]!;
    norm = Math.sqrt(norm);
    if (norm > tolerance) {
      for (let index = 0; index < vector.length; index += 1) vector[index] = vector[index]! / norm;
      basis.push(vector);
    }
  }
  return basis.length;
}
