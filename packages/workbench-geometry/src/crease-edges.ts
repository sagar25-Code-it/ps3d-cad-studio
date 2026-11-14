/**
 * Edges that can be picked on ANY triangle mesh: imported meshes, primitives, bodies with no named faces, open shells.
 *
 * `pickableEdges` (mesh-modify.ts) serves the solids the kernel can treat: closed, outward, consistently wound. A picker must also
 * work on a mesh that is none of those, so this detector asks less of the mesh: it welds the vertices by position, measures the
 * bend between the two triangles at every edge with a crease-angle tolerance the user can change, offers open boundary edges, and
 * copes with triangles wound the wrong way round (the angle is measured between the surfaces, not between the stored normals).
 *
 * Edges are grouped two ways. A `chain` is a run of edges that meet end to end where nothing else joins them and that turn by at
 * most CHAIN_TURN_LIMIT_DEG (the segments of a round rim are one chain). A `tangentChain` also carries on through a junction where
 * other edges meet, as long as one of them continues the run without a visible kink (a slot outline that runs into a boss).
 */

type V3 = readonly [number, number, number];

export interface CreaseMesh {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
}

export interface CreaseOptions {
  /** Edges where the surface bends by at least this many degrees are offered. Default 30. */
  readonly creaseAngleDeg?: number;
  /** Offer the open boundary of an open shell (and edges shared by three or more triangles). Default true. */
  readonly includeBoundary?: boolean;
  /** Most edges returned; the sharpest are kept when there are more. Default 20 000. */
  readonly maxEdges?: number;
}

export interface CreaseEdge {
  readonly a: V3;
  readonly b: V3;
  /** Run of edges that meet end to end (see the file comment). */
  readonly chain: number;
  /** Run that also continues tangentially through junctions. A superset of `chain`. */
  readonly tangentChain: number;
  /** How far the surface bends across the edge, in degrees (0 for an open boundary). */
  readonly bendDeg: number;
  /** An inside corner. Unknown (false) on a boundary or on a mesh whose winding disagrees. */
  readonly concave: boolean;
  /** The edge borders only one triangle (or more than two). */
  readonly boundary: boolean;
}

export interface CreaseResult {
  readonly edges: readonly CreaseEdge[];
  /** More edges qualified than `maxEdges`, so the weakest were left out. */
  readonly truncated: boolean;
  /** The crease angle that was used, after clamping. */
  readonly creaseAngleDeg: number;
}

export const DEFAULT_CREASE_ANGLE_DEG = 30;
export const MIN_CREASE_ANGLE_DEG = 2;
export const MAX_CREASE_ANGLE_DEG = 89;
const CHAIN_TURN_LIMIT_DEG = 35;
const TANGENT_TURN_LIMIT_DEG = 8;
const WELD_MM = 1e-4;
const MAX_TRIANGLES = 400_000;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 | undefined => {
  const length = Math.hypot(a[0], a[1], a[2]);
  return length < 1e-12 ? undefined : [a[0] / length, a[1] / length, a[2] / length];
};

export function clampCreaseAngle(angleDeg: number | undefined): number {
  if (angleDeg === undefined || !Number.isFinite(angleDeg)) return DEFAULT_CREASE_ANGLE_DEG;
  return Math.min(MAX_CREASE_ANGLE_DEG, Math.max(MIN_CREASE_ANGLE_DEG, angleDeg));
}

/** The creased and boundary edges of a triangle mesh, grouped into chains. */
export function creaseEdges(mesh: CreaseMesh, options: CreaseOptions = {}): CreaseResult {
  const creaseAngleDeg = clampCreaseAngle(options.creaseAngleDeg);
  const maxEdges = options.maxEdges ?? 20_000;
  const includeBoundary = options.includeBoundary !== false;
  const triangleCount = Math.floor(mesh.indices.length / 3);
  const empty: CreaseResult = { edges: [], truncated: false, creaseAngleDeg };
  if (triangleCount === 0 || triangleCount > MAX_TRIANGLES) return triangleCount > MAX_TRIANGLES ? { ...empty, truncated: true } : empty;

  const vertexCount = Math.floor(mesh.positionsMm.length / 3);
  const weldOf = new Array<number>(vertexCount);
  const weldPoint: V3[] = [];
  const byKey = new Map<string, number>();
  for (let i = 0; i < vertexCount; i += 1) {
    const x = mesh.positionsMm[i * 3]!; const y = mesh.positionsMm[i * 3 + 1]!; const z = mesh.positionsMm[i * 3 + 2]!;
    const key = `${Math.round(x / WELD_MM)},${Math.round(y / WELD_MM)},${Math.round(z / WELD_MM)}`;
    let id = byKey.get(key);
    if (id === undefined) { id = weldPoint.length; byKey.set(key, id); weldPoint.push([x, y, z]); }
    weldOf[i] = id;
  }

  const normals: (V3 | undefined)[] = [];
  const corners: [number, number, number][] = [];
  for (let t = 0; t < triangleCount; t += 1) {
    const a = weldOf[mesh.indices[t * 3]!]; const b = weldOf[mesh.indices[t * 3 + 1]!]; const c = weldOf[mesh.indices[t * 3 + 2]!];
    if (a === undefined || b === undefined || c === undefined || a === b || b === c || a === c) { corners.push([-1, -1, -1]); normals.push(undefined); continue; }
    corners.push([a, b, c]);
    normals.push(unit(cross(sub(weldPoint[b]!, weldPoint[a]!), sub(weldPoint[c]!, weldPoint[a]!))));
  }

  interface Use { readonly triangle: number; readonly forward: boolean }
  const uses = new Map<string, Use[]>();
  for (let t = 0; t < triangleCount; t += 1) {
    const corner = corners[t]!;
    if (corner[0] < 0 || normals[t] === undefined) continue;
    for (let s = 0; s < 3; s += 1) {
      const from = corner[s]!; const to = corner[(s + 1) % 3]!;
      const forward = from < to;
      const key = forward ? `${from},${to}` : `${to},${from}`;
      const bucket = uses.get(key);
      const use = { triangle: t, forward };
      if (bucket === undefined) uses.set(key, [use]); else bucket.push(use);
    }
  }

  interface Raw { readonly lo: number; readonly hi: number; readonly bendDeg: number; readonly concave: boolean; readonly boundary: boolean }
  const raw: Raw[] = [];
  const cosLimit = Math.cos(creaseAngleDeg * Math.PI / 180);
  for (const [key, bucket] of uses) {
    const [loText, hiText] = key.split(",");
    const lo = Number.parseInt(loText!, 10); const hi = Number.parseInt(hiText!, 10);
    if (bucket.length === 1) {
      if (includeBoundary) raw.push({ lo, hi, bendDeg: 0, concave: false, boundary: true });
      continue;
    }
    if (bucket.length > 2) {
      if (includeBoundary) raw.push({ lo, hi, bendDeg: 90, concave: false, boundary: true });
      continue;
    }
    const first = bucket[0]!; const second = bucket[1]!;
    const n1 = normals[first.triangle]!;
    let n2 = normals[second.triangle]!;
    // Two triangles that run along their shared edge the same way are wound against each other: read the second one flipped.
    const consistent = first.forward !== second.forward;
    if (!consistent) n2 = [-n2[0], -n2[1], -n2[2]];
    const d = dot(n1, n2);
    if (d >= cosLimit) continue;
    const bendDeg = Math.acos(Math.max(-1, Math.min(1, d))) * 180 / Math.PI;
    let concave = false;
    if (consistent) {
      const edge = sub(weldPoint[hi]!, weldPoint[lo]!);
      const turn = (first.forward ? 1 : -1) * dot(cross(n1, n2), edge);
      concave = turn < -1e-12;
    }
    raw.push({ lo, hi, bendDeg, concave, boundary: false });
  }

  let truncated = false;
  let kept = raw;
  if (raw.length > maxEdges) {
    truncated = true;
    kept = [...raw].sort((p, q) => q.bendDeg - p.bendDeg).slice(0, maxEdges);
  }

  // Chains: union edges at valence-2 vertices that hardly turn.
  const direction = (edge: Raw): V3 => unit(sub(weldPoint[edge.hi]!, weldPoint[edge.lo]!)) ?? [0, 0, 0];
  const atVertex = new Map<number, number[]>();
  kept.forEach((edge, index) => {
    for (const vertex of [edge.lo, edge.hi]) {
      const bucket = atVertex.get(vertex);
      if (bucket === undefined) atVertex.set(vertex, [index]); else bucket.push(index);
    }
  });
  const makeUnion = (): { readonly find: (i: number) => number; readonly join: (i: number, j: number) => void } => {
    const parent = kept.map((_, index) => index);
    const find = (index: number): number => { let root = index; while (parent[root] !== root) root = parent[root]!; return root; };
    return { find, join: (i, j) => { parent[find(i)] = find(j); } };
  };
  const chainUnion = makeUnion();
  const tangentUnion = makeUnion();
  const chainCos = Math.cos(CHAIN_TURN_LIMIT_DEG * Math.PI / 180);
  const tangentCos = Math.cos(TANGENT_TURN_LIMIT_DEG * Math.PI / 180);
  const sameKind = (p: Raw, q: Raw): boolean => p.concave === q.concave && p.boundary === q.boundary;
  for (const bucket of atVertex.values()) {
    if (bucket.length === 2) {
      const [i, j] = bucket as [number, number];
      if (sameKind(kept[i]!, kept[j]!) && Math.abs(dot(direction(kept[i]!), direction(kept[j]!))) >= chainCos) { chainUnion.join(i, j); tangentUnion.join(i, j); }
      continue;
    }
    // A junction: only a continuation without a visible kink carries a tangent chain through it.
    for (let x = 0; x < bucket.length; x += 1) {
      let best = -1; let bestAlign = tangentCos;
      for (let y = 0; y < bucket.length; y += 1) {
        if (x === y || !sameKind(kept[bucket[x]!]!, kept[bucket[y]!]!)) continue;
        const align = Math.abs(dot(direction(kept[bucket[x]!]!), direction(kept[bucket[y]!]!)));
        if (align >= bestAlign) { bestAlign = align; best = y; }
      }
      if (best >= 0) tangentUnion.join(bucket[x]!, bucket[best]!);
    }
  }
  const renumber = (find: (i: number) => number): number[] => {
    const ids = new Map<number, number>();
    return kept.map((_, index) => {
      const root = find(index);
      let id = ids.get(root);
      if (id === undefined) { id = ids.size; ids.set(root, id); }
      return id;
    });
  };
  const chains = renumber(chainUnion.find);
  const tangents = renumber(tangentUnion.find);
  const edges = kept.map((edge, index): CreaseEdge => ({
    a: weldPoint[edge.lo]!, b: weldPoint[edge.hi]!, chain: chains[index]!, tangentChain: tangents[index]!,
    bendDeg: Math.round(edge.bendDeg * 100) / 100, concave: edge.concave, boundary: edge.boundary
  }));
  return { edges, truncated, creaseAngleDeg };
}

/** Every edge of the run that carries on tangentially from the given chain (including the chain itself). */
export function tangentChainOf(edges: readonly CreaseEdge[], chain: number): readonly CreaseEdge[] {
  const seed = edges.find((edge) => edge.chain === chain);
  if (seed === undefined) return [];
  return edges.filter((edge) => edge.tangentChain === seed.tangentChain);
}
