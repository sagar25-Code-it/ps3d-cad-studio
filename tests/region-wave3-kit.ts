/** Shared helpers of the wave-3 region tests: a strict closed-manifold check on a triangle mesh and a few sketch builders. */
export interface MeshReport {
  readonly triangles: number;
  /** Undirected edges (vertices merged by position) used by a number of triangles other than two. */
  readonly badEdges: number;
  /** Edges whose two triangles run the same direction (inconsistent winding). */
  readonly sameDirectionEdges: number;
  /** Signed volume: positive when the triangles wind outward. */
  readonly signedVolume: number;
  /** Triangles with (nearly) no area; they keep edges paired but a layout should not need many of them. */
  readonly slivers: number;
}

export function meshReport(positions: readonly number[], indices: readonly number[]): MeshReport {
  const keys = new Map<string, number>();
  const idOf = (vertex: number): number => {
    const key = `${Math.round(positions[vertex * 3]! * 1e4)},${Math.round(positions[vertex * 3 + 1]! * 1e4)},${Math.round(positions[vertex * 3 + 2]! * 1e4)}`;
    let id = keys.get(key);
    if (id === undefined) { id = keys.size; keys.set(key, id); }
    return id;
  };
  const directed = new Map<string, number>();
  let volume = 0;
  let slivers = 0;
  for (let index = 0; index < indices.length; index += 3) {
    const ids = [idOf(indices[index]!), idOf(indices[index + 1]!), idOf(indices[index + 2]!)] as const;
    const a = indices[index]! * 3;
    const b = indices[index + 1]! * 3;
    const c = indices[index + 2]! * 3;
    volume += (positions[a]! * (positions[b + 1]! * positions[c + 2]! - positions[b + 2]! * positions[c + 1]!)
      - positions[a + 1]! * (positions[b]! * positions[c + 2]! - positions[b + 2]! * positions[c]!)
      + positions[a + 2]! * (positions[b]! * positions[c + 1]! - positions[b + 1]! * positions[c]!)) / 6;
    const ux = positions[b]! - positions[a]!;
    const uy = positions[b + 1]! - positions[a + 1]!;
    const uz = positions[b + 2]! - positions[a + 2]!;
    const vx = positions[c]! - positions[a]!;
    const vy = positions[c + 1]! - positions[a + 1]!;
    const vz = positions[c + 2]! - positions[a + 2]!;
    if (Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) < 1e-9) slivers += 1;
    for (let edge = 0; edge < 3; edge += 1) {
      const from = ids[edge]!;
      const to = ids[(edge + 1) % 3]!;
      if (from === to) continue;
      const key = `${from}>${to}`;
      directed.set(key, (directed.get(key) ?? 0) + 1);
    }
  }
  let bad = 0;
  let same = 0;
  const seen = new Set<string>();
  for (const [key, count] of directed) {
    const [from, to] = key.split(">") as [string, string];
    const undirectedKey = Number(from) < Number(to) ? key : `${to}>${from}`;
    if (seen.has(undirectedKey)) continue;
    seen.add(undirectedKey);
    const forward = directed.get(`${from}>${to}`) ?? 0;
    const backward = directed.get(`${to}>${from}`) ?? 0;
    if (forward !== 1 || backward !== 1) {
      if (forward + backward !== 2) bad += 1;
      else same += 1;
    }
    void count;
  }
  return { triangles: indices.length / 3, badEdges: bad, sameDirectionEdges: same, signedVolume: volume, slivers };
}
