/**
 * Splits a triangle mesh into its connected pieces. A cut or a hole that severs a solid leaves one closed mesh per piece; this
 * hands them back largest first so the biggest piece can keep the original body and the others become bodies of their own.
 */
export interface MeshPiece {
  /** Positions of just this piece's vertices, in millimetres. */
  readonly positionsMm: number[];
  /** Indices into `positionsMm`. */
  readonly indices: number[];
  /** For each triangle of this piece, its triangle number in the mesh that was split (to carry per-triangle data across). */
  readonly sourceTriangles: number[];
  /** Signed volume of the piece; positive when its faces point outward. */
  readonly volumeMm3: number;
}

function signedVolumeOf(positionsMm: readonly number[], indices: readonly number[]): number {
  let total = 0;
  for (let corner = 0; corner + 2 < indices.length; corner += 3) {
    const a = indices[corner]! * 3;
    const b = indices[corner + 1]! * 3;
    const c = indices[corner + 2]! * 3;
    total += positionsMm[a]! * (positionsMm[b + 1]! * positionsMm[c + 2]! - positionsMm[b + 2]! * positionsMm[c + 1]!)
      - positionsMm[a + 1]! * (positionsMm[b]! * positionsMm[c + 2]! - positionsMm[b + 2]! * positionsMm[c]!)
      + positionsMm[a + 2]! * (positionsMm[b]! * positionsMm[c + 1]! - positionsMm[b + 1]! * positionsMm[c]!);
  }
  return total / 6;
}

/** The connected pieces of a mesh (triangles that share a vertex belong together), largest volume first. */
export function splitMeshPieces(positionsMm: readonly number[], indices: readonly number[]): MeshPiece[] {
  const vertexCount = Math.floor(positionsMm.length / 3);
  const parent = Array.from({ length: vertexCount }, (_, index) => index);
  const find = (value: number): number => {
    let root = value;
    while (parent[root] !== root) root = parent[root]!;
    let walk = value;
    while (parent[walk] !== root) { const next = parent[walk]!; parent[walk] = root; walk = next; }
    return root;
  };
  const triangleCount = Math.floor(indices.length / 3);
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const a = find(indices[triangle * 3]!);
    parent[find(indices[triangle * 3 + 1]!)] = a;
    parent[find(indices[triangle * 3 + 2]!)] = find(a);
  }
  const groups = new Map<number, number[]>();
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const root = find(indices[triangle * 3]!);
    const list = groups.get(root);
    if (list === undefined) groups.set(root, [triangle]);
    else list.push(triangle);
  }
  const pieces: MeshPiece[] = [];
  for (const triangles of groups.values()) {
    const remap = new Map<number, number>();
    const positions: number[] = [];
    const pieceIndices: number[] = [];
    for (const triangle of triangles) {
      for (let corner = 0; corner < 3; corner += 1) {
        const original = indices[triangle * 3 + corner]!;
        let mapped = remap.get(original);
        if (mapped === undefined) {
          mapped = positions.length / 3;
          remap.set(original, mapped);
          positions.push(positionsMm[original * 3]!, positionsMm[original * 3 + 1]!, positionsMm[original * 3 + 2]!);
        }
        pieceIndices.push(mapped);
      }
    }
    pieces.push({ positionsMm: positions, indices: pieceIndices, sourceTriangles: triangles, volumeMm3: signedVolumeOf(positions, pieceIndices) });
  }
  // Largest first; equal volumes fall back to position so the order is the same on every rebuild.
  pieces.sort((left, right) => {
    const byVolume = Math.abs(right.volumeMm3) - Math.abs(left.volumeMm3);
    if (Math.abs(byVolume) > 1e-9) return byVolume;
    return left.positionsMm[0]! - right.positionsMm[0]! || left.positionsMm[1]! - right.positionsMm[1]! || left.positionsMm[2]! - right.positionsMm[2]!;
  });
  return pieces;
}
