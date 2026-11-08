/**
 * A small bounding-volume hierarchy over the triangles of an indexed mesh, for nearest-hit ray queries.
 * Used by the wall-thickness analysis; pure and deterministic (median split on the longest axis).
 */

export interface RayHit {
  /** Distance along the (unit) ray direction. */
  readonly distance: number;
  readonly triangle: number;
}

interface BvhNode {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  /** Child node indices, or -1 for a leaf. */
  readonly left: number;
  readonly right: number;
  /** For a leaf: the range [start, start + count) in `order`. */
  readonly start: number;
  readonly count: number;
}

const LEAF_SIZE = 6;

export class TriangleBvh {
  readonly #positions: readonly number[];
  readonly #indices: readonly number[];
  readonly #order: number[];
  readonly #nodes: BvhNode[] = [];

  constructor(positionsMm: readonly number[], indices: readonly number[]) {
    this.#positions = positionsMm;
    this.#indices = indices;
    const count = Math.floor(indices.length / 3);
    this.#order = Array.from({ length: count }, (_, index) => index);
    if (count > 0) this.#build(0, count);
  }

  get triangleCount(): number {
    return this.#order.length;
  }

  #triangleBounds(triangle: number): { min: [number, number, number]; max: [number, number, number] } {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let corner = 0; corner < 3; corner += 1) {
      const vertex = this.#indices[triangle * 3 + corner]!;
      for (let axis = 0; axis < 3; axis += 1) {
        const value = this.#positions[vertex * 3 + axis]!;
        if (value < min[axis]!) min[axis] = value;
        if (value > max[axis]!) max[axis] = value;
      }
    }
    return { min, max };
  }

  #build(start: number, end: number): number {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    const centroidMin: [number, number, number] = [Infinity, Infinity, Infinity];
    const centroidMax: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let slot = start; slot < end; slot += 1) {
      const bounds = this.#triangleBounds(this.#order[slot]!);
      for (let axis = 0; axis < 3; axis += 1) {
        if (bounds.min[axis]! < min[axis]!) min[axis] = bounds.min[axis]!;
        if (bounds.max[axis]! > max[axis]!) max[axis] = bounds.max[axis]!;
        const centre = (bounds.min[axis]! + bounds.max[axis]!) / 2;
        if (centre < centroidMin[axis]!) centroidMin[axis] = centre;
        if (centre > centroidMax[axis]!) centroidMax[axis] = centre;
      }
    }
    const index = this.#nodes.length;
    if (end - start <= LEAF_SIZE) {
      this.#nodes.push({ min, max, left: -1, right: -1, start, count: end - start });
      return index;
    }
    let axis = 0;
    for (let candidate = 1; candidate < 3; candidate += 1) if (centroidMax[candidate]! - centroidMin[candidate]! > centroidMax[axis]! - centroidMin[axis]!) axis = candidate;
    const keyed = this.#order.slice(start, end).map((triangle) => {
      const bounds = this.#triangleBounds(triangle);
      return { triangle, key: bounds.min[axis]! + bounds.max[axis]! };
    });
    keyed.sort((left, right) => left.key - right.key || left.triangle - right.triangle);
    keyed.forEach((entry, offset) => { this.#order[start + offset] = entry.triangle; });
    const middle = start + Math.floor((end - start) / 2);
    this.#nodes.push({ min, max, left: -2, right: -2, start, count: 0 });
    const left = this.#build(start, middle);
    const right = this.#build(middle, end);
    this.#nodes[index] = { min, max, left, right, start, count: 0 };
    return index;
  }

  /**
   * Nearest intersection of the ray origin + t * direction (direction must be a unit vector) with t > minDistance,
   * skipping `ignoreTriangle`. Triangles are two-sided.
   */
  nearestHit(origin: readonly [number, number, number], direction: readonly [number, number, number], minDistance = 0, ignoreTriangle = -1, maxDistance = Infinity): RayHit | undefined {
    if (this.#nodes.length === 0) return undefined;
    let best: RayHit | undefined;
    let bestDistance = maxDistance;
    const stack: number[] = [0];
    const inverse: readonly [number, number, number] = [1 / (direction[0] === 0 ? 1e-30 : direction[0]), 1 / (direction[1] === 0 ? 1e-30 : direction[1]), 1 / (direction[2] === 0 ? 1e-30 : direction[2])];
    while (stack.length > 0) {
      const node = this.#nodes[stack.pop()!]!;
      if (!rayHitsBox(origin, inverse, node.min, node.max, bestDistance)) continue;
      if (node.left === -1) {
        for (let slot = node.start; slot < node.start + node.count; slot += 1) {
          const triangle = this.#order[slot]!;
          if (triangle === ignoreTriangle) continue;
          const distance = this.#intersect(triangle, origin, direction);
          if (distance !== undefined && distance > minDistance && distance < bestDistance) { bestDistance = distance; best = { distance, triangle }; }
        }
      } else {
        stack.push(node.left, node.right);
      }
    }
    return best;
  }

  #intersect(triangle: number, origin: readonly [number, number, number], direction: readonly [number, number, number]): number | undefined {
    const ia = this.#indices[triangle * 3]! * 3;
    const ib = this.#indices[triangle * 3 + 1]! * 3;
    const ic = this.#indices[triangle * 3 + 2]! * 3;
    const p = this.#positions;
    const e1x = p[ib]! - p[ia]!, e1y = p[ib + 1]! - p[ia + 1]!, e1z = p[ib + 2]! - p[ia + 2]!;
    const e2x = p[ic]! - p[ia]!, e2y = p[ic + 1]! - p[ia + 1]!, e2z = p[ic + 2]! - p[ia + 2]!;
    const hx = direction[1] * e2z - direction[2] * e2y;
    const hy = direction[2] * e2x - direction[0] * e2z;
    const hz = direction[0] * e2y - direction[1] * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-14) return undefined;
    const f = 1 / det;
    const sx = origin[0] - p[ia]!, sy = origin[1] - p[ia + 1]!, sz = origin[2] - p[ia + 2]!;
    const u = f * (sx * hx + sy * hy + sz * hz);
    if (u < -1e-9 || u > 1 + 1e-9) return undefined;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = f * (direction[0] * qx + direction[1] * qy + direction[2] * qz);
    if (v < -1e-9 || u + v > 1 + 1e-9) return undefined;
    return f * (e2x * qx + e2y * qy + e2z * qz);
  }
}

function rayHitsBox(origin: readonly [number, number, number], inverse: readonly [number, number, number], min: readonly [number, number, number], max: readonly [number, number, number], limit: number): boolean {
  let near = 0;
  let far = limit;
  for (let axis = 0; axis < 3; axis += 1) {
    let t0 = (min[axis]! - origin[axis]!) * inverse[axis]!;
    let t1 = (max[axis]! - origin[axis]!) * inverse[axis]!;
    if (t0 > t1) { const swap = t0; t0 = t1; t1 = swap; }
    if (t0 > near) near = t0;
    if (t1 < far) far = t1;
    if (near > far + 1e-9) return false;
  }
  return true;
}
