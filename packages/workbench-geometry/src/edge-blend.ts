/**
 * Edge blends as replayable steps: finding the edges a fillet or chamfer was made on again after the body has been rebuilt, and
 * applying the blend to them. A picked edge is remembered as the segments it was drawn with plus, when the body has named faces,
 * the keys of the two faces beside it. After a rebuild the faces are found by key (so an edge that moved with a sketch edit is
 * still the same edge); without keys the nearest edge of the same kind within a tolerance is taken. When neither finds it, the
 * step says so instead of treating something else.
 */

import { meshChamfer, meshFillet, pickableEdges, type ModifyMeshInput, type PickableEdge } from "./mesh-modify.js";

type V3 = readonly [number, number, number];
export type BlendSegment = readonly [V3, V3];

/** What is remembered about a picked edge run. */
export interface EdgeBlendGroupRef {
  readonly segments: readonly BlendSegment[];
  readonly faceKeys?: readonly [string, string];
  readonly concave?: boolean;
}

/** The named faces of a body: the face index of every triangle and the key of every face. */
export interface BlendFaces {
  readonly faceTriangles: readonly number[];
  readonly keys: readonly string[];
}

export interface EdgeBlendSpec {
  readonly type: "fillet" | "chamfer";
  /** Radius, or the first chamfer distance. */
  readonly sizeMm: number;
  /** Fillet: radius at the end of each run. */
  readonly endSizeMm?: number;
  /** Chamfer: distance on the second face. */
  readonly secondSizeMm?: number;
  /** Chamfer: angle with the first face. */
  readonly angleDeg?: number;
  readonly flip?: boolean;
  /** Fillet tessellation. */
  readonly segments?: number;
}

export interface ResolvedEdgeGroup {
  /** The run on the body as it is now, in order along it where it can be ordered, starting at the end nearest where the picked run started. */
  readonly segments: readonly BlendSegment[];
  readonly concave: boolean;
  readonly via: "face-keys" | "position";
  /** How far the found run is from the remembered one, on average. */
  readonly deviationMm: number;
}

export type ResolveEdgeGroupsResult =
  | { readonly ok: true; readonly groups: readonly ResolvedEdgeGroup[] }
  | { readonly ok: false; readonly message: string };

export type EdgeBlendResult =
  | {
    readonly ok: true;
    readonly positionsMm: readonly number[];
    readonly indices: readonly number[];
    readonly faceTriangles?: readonly number[];
    /** The face index the blend's own surfaces were given, when the body had named faces. */
    readonly newFaceIndex?: number;
    readonly resolved: readonly ResolvedEdgeGroup[];
  }
  | { readonly ok: false; readonly message: string };

const QUANTUM_MM = 1e-4;

const keyOf = (p: V3): string => `${Math.round(p[0] / QUANTUM_MM)},${Math.round(p[1] / QUANTUM_MM)},${Math.round(p[2] / QUANTUM_MM)}`;

function distanceToSegment(point: V3, a: V3, b: V3): number {
  const abx = b[0] - a[0]; const aby = b[1] - a[1]; const abz = b[2] - a[2];
  const lengthSquared = abx * abx + aby * aby + abz * abz;
  const t = lengthSquared < 1e-18 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * abx + (point[1] - a[1]) * aby + (point[2] - a[2]) * abz) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + abx * t), point[1] - (a[1] + aby * t), point[2] - (a[2] + abz * t));
}

const midpointOf = ([a, b]: BlendSegment): V3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

/**
 * Puts loose segments in order along the run they make. An open run is returned from its lexicographically smaller end; a closed
 * loop from any point. Undefined when the segments do not make a single run (a branch, or separate pieces).
 */
export function orderEdgePath(segments: readonly BlendSegment[]): { readonly points: readonly V3[]; readonly closed: boolean } | undefined {
  if (segments.length === 0) return undefined;
  const at = new Map<string, { point: V3; links: number[] }>();
  const touch = (p: V3, segment: number): void => {
    const key = keyOf(p);
    const entry = at.get(key);
    if (entry === undefined) at.set(key, { point: p, links: [segment] }); else entry.links.push(segment);
  };
  segments.forEach(([a, b], index) => { touch(a, index); touch(b, index); });
  const ends = [...at.entries()].filter(([, entry]) => entry.links.length === 1);
  if ([...at.values()].some((entry) => entry.links.length > 2)) return undefined;
  if (ends.length !== 0 && ends.length !== 2) return undefined;
  const closed = ends.length === 0;
  ends.sort(([, p], [, q]) => p.point[0] - q.point[0] || p.point[1] - q.point[1] || p.point[2] - q.point[2]);
  let currentKey = closed ? keyOf(segments[0]![0]) : ends[0]![0];
  const points: V3[] = [at.get(currentKey)!.point];
  const used = new Set<number>();
  for (;;) {
    const entry = at.get(currentKey)!;
    const next = entry.links.find((segment) => !used.has(segment));
    if (next === undefined) break;
    used.add(next);
    const [a, b] = segments[next]!;
    const far = keyOf(a) === currentKey ? b : a;
    currentKey = keyOf(far);
    points.push(far);
  }
  if (used.size !== segments.length) return undefined;
  if (closed) points.pop();
  return { points, closed };
}

/** The consecutive segments of an ordered run. */
function segmentsOfPath(points: readonly V3[], closed: boolean): BlendSegment[] {
  const out: BlendSegment[] = [];
  for (let i = 0; i + 1 < points.length; i += 1) out.push([points[i]!, points[i + 1]!]);
  if (closed && points.length > 2) out.push([points[points.length - 1]!, points[0]!]);
  return out;
}

/** The run in order, oriented so it starts at the end nearest `start`; the pieces as given when they do not make one run. */
function orderedRun(segments: readonly BlendSegment[], start: V3 | undefined): BlendSegment[] {
  const path = orderEdgePath(segments);
  if (path === undefined) return [...segments];
  let points = path.points;
  if (!path.closed && start !== undefined) {
    const first = points[0]!;
    const last = points[points.length - 1]!;
    const near = (p: V3): number => Math.hypot(p[0] - start[0], p[1] - start[1], p[2] - start[2]);
    if (near(last) < near(first)) points = [...points].reverse();
  }
  return segmentsOfPath(points, path.closed);
}

function keyPairOf(edge: PickableEdge, faces: BlendFaces | undefined): string | undefined {
  if (faces === undefined || edge.triangles === undefined) return undefined;
  const keys = edge.triangles.map((triangle) => {
    const face = faces.faceTriangles[triangle];
    return face === undefined || face < 0 ? undefined : faces.keys[face];
  });
  return keys.some((key) => key === undefined) ? undefined : (keys as string[]).sort().join("|");
}

/** What to remember about a picked edge run (all the pickable edges of one chain). */
export function describePickedEdge(chain: readonly PickableEdge[], faces: BlendFaces | undefined, start?: V3): EdgeBlendGroupRef {
  const segments = orderedRun(chain.map((edge): BlendSegment => [edge.a, edge.b]), start);
  const concave = chain[0]?.concave === true;
  let faceKeys: readonly [string, string] | undefined;
  if (faces !== undefined) {
    for (const edge of chain) {
      const pair = keyPairOf(edge, faces);
      if (pair === undefined) continue;
      const [first, second] = pair.split("|");
      if (first !== undefined && second !== undefined) { faceKeys = [first, second]; break; }
    }
  }
  return { segments, ...(faceKeys === undefined ? {} : { faceKeys }), ...(concave ? { concave: true } : {}) };
}

/** The distance within which an edge is taken for the remembered one when there are no face keys to go by. */
export function defaultMatchToleranceMm(mesh: ModifyMeshInput): number {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i + 2 < mesh.positionsMm.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positionsMm[i + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  const diagonal = Number.isFinite(min[0]!) ? Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) : 0;
  return Math.max(0.5, diagonal * 0.02);
}

/** Finds the remembered edge runs on a body again. */
export function resolveEdgeGroups(mesh: ModifyMeshInput, faces: BlendFaces | undefined, groups: readonly EdgeBlendGroupRef[], toleranceMm: number = defaultMatchToleranceMm(mesh)): ResolveEdgeGroupsResult {
  const found = pickableEdges(mesh, 5, { includeConcave: true });
  if (typeof found === "string") return { ok: false, message: found };
  const edges = found;
  const resolved: ResolvedEdgeGroup[] = [];
  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const concave = group.concave === true;
    const label = groups.length === 1 ? "The edge" : `Edge ${index + 1} of ${groups.length}`;
    const pool = edges.filter((edge) => (edge.concave === true) === concave);
    const stored = group.segments;
    const meanDistanceTo = (chainEdges: readonly PickableEdge[]): number => {
      let total = 0;
      for (const segment of stored) {
        const mid = midpointOf(segment);
        total += Math.min(...chainEdges.map((edge) => distanceToSegment(mid, edge.a, edge.b)));
      }
      return total / stored.length;
    };
    const pick = (chainIds: readonly number[], via: ResolvedEdgeGroup["via"], deviationMm: number): void => {
      const chosen = pool.filter((edge) => chainIds.includes(edge.chain));
      resolved.push({ segments: orderedRun(chosen.map((edge): BlendSegment => [edge.a, edge.b]), stored[0]![0]), concave, via, deviationMm });
    };

    // 1. By the faces beside the edge: the same two faces still meet along it, wherever it has moved to.
    if (group.faceKeys !== undefined && faces !== undefined) {
      const wanted = [...group.faceKeys].sort().join("|");
      const byChain = new Map<number, PickableEdge[]>();
      for (const edge of pool) {
        if (keyPairOf(edge, faces) !== wanted) continue;
        const bucket = byChain.get(edge.chain);
        if (bucket === undefined) byChain.set(edge.chain, [edge]); else bucket.push(edge);
      }
      if (byChain.size > 0) {
        let bestChain = -1;
        let bestDistance = Infinity;
        for (const [chain, chainEdges] of byChain) {
          const distance = meanDistanceTo(chainEdges);
          if (distance < bestDistance) { bestChain = chain; bestDistance = distance; }
        }
        pick([bestChain], "face-keys", bestDistance);
        continue;
      }
    }

    // 2. By position: every remembered segment takes the nearest edge of the same kind, if it is close enough.
    const matched = new Set<number>();
    let closest = Infinity;
    let total = 0;
    for (const segment of stored) {
      let best: PickableEdge | undefined;
      let bestDistance = Infinity;
      for (const edge of pool) {
        const distance = Math.max(distanceToSegment(segment[0], edge.a, edge.b), distanceToSegment(segment[1], edge.a, edge.b));
        if (distance < bestDistance) { best = edge; bestDistance = distance; }
      }
      closest = Math.min(closest, bestDistance);
      if (best !== undefined && bestDistance <= toleranceMm) { matched.add(best.chain); total += bestDistance; }
    }
    if (matched.size === 0) {
      const kind = concave ? "inside " : "";
      return { ok: false, message: `${label} no longer exists on the rebuilt solid: ${Number.isFinite(closest) ? `the nearest ${kind}edge is ${closest.toFixed(2)} mm from where it was (more than the ${toleranceMm.toFixed(2)} mm allowed)` : `the solid has no ${kind}edges at all`}${group.faceKeys === undefined ? "" : ", and the faces that met there are gone"}. Pick the edge again.` };
    }
    pick([...matched], "position", total / stored.length);
  }
  return { ok: true, groups: resolved };
}

/** Applies a blend to the remembered edge runs of a body: finds them again, then fillets or chamfers each. */
export function applyEdgeBlend(mesh: ModifyMeshInput, faces: BlendFaces | undefined, groups: readonly EdgeBlendGroupRef[], spec: EdgeBlendSpec, toleranceMm?: number): EdgeBlendResult {
  if (groups.length === 0) return { ok: false, message: "No edge is picked for this blend." };
  const resolvedResult = resolveEdgeGroups(mesh, faces, groups, toleranceMm);
  if (!resolvedResult.ok) return resolvedResult;
  const variable = spec.type === "fillet" && spec.endSizeMm !== undefined && spec.endSizeMm !== spec.sizeMm;
  if (variable) {
    for (const group of resolvedResult.groups) {
      const path = orderEdgePath(group.segments);
      if (path === undefined) return { ok: false, message: "A variable radius needs each picked edge to be one run of edges with two ends." };
      if (path.closed) return { ok: false, message: "A variable radius needs an open run of edges: a closed loop, such as a round rim, has no start or end to spread the radius between." };
    }
  }
  let current: ModifyMeshInput = { positionsMm: mesh.positionsMm, indices: mesh.indices, ...(faces === undefined ? {} : { faceTriangles: faces.faceTriangles }) };
  // The blend's own surface is a face of its own, numbered after the faces the body already has.
  let newFaceIndex: number | undefined = faces?.keys.length;
  for (let index = 0; index < resolvedResult.groups.length; index += 1) {
    const group = resolvedResult.groups[index]!;
    const common = {
      onlyEdges: group.segments, concave: group.concave, strict: true, fitAgainst: mesh,
      ...(newFaceIndex === undefined ? {} : { newFaceIndex })
    };
    const result = spec.type === "fillet"
      ? meshFillet(current, { sizeMm: spec.sizeMm, ...(spec.endSizeMm === undefined ? {} : { endSizeMm: spec.endSizeMm }), ...(spec.segments === undefined ? {} : { segments: spec.segments }), ...common })
      : meshChamfer(current, { sizeMm: spec.sizeMm, ...(spec.secondSizeMm === undefined ? {} : { secondSizeMm: spec.secondSizeMm }), ...(spec.angleDeg === undefined ? {} : { angleDeg: spec.angleDeg }), ...(spec.flip === true ? { flip: true } : {}), ...common });
    if (!result.ok) return { ok: false, message: resolvedResult.groups.length === 1 ? result.message : `Edge ${index + 1} of ${resolvedResult.groups.length}: ${result.message}` };
    current = { positionsMm: result.positionsMm, indices: result.indices, ...(result.faceTriangles === undefined ? {} : { faceTriangles: result.faceTriangles }) };
    newFaceIndex = result.newFaceIndex ?? newFaceIndex;
  }
  return {
    ok: true, positionsMm: current.positionsMm, indices: current.indices,
    ...(current.faceTriangles === undefined ? {} : { faceTriangles: current.faceTriangles }),
    ...(newFaceIndex === undefined ? {} : { newFaceIndex }),
    resolved: resolvedResult.groups
  };
}
