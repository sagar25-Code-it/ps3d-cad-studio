/**
 * Geometry checker for triangle-mesh bodies: the mesh counterpart of a B-rep validity check (BRepCheck).
 *
 * A body is read after welding coincident vertices, so a mesh whose faces merely carry duplicated seam vertices is
 * reported as such but is not called open. The checks are: invalid or non-finite input, duplicate and unreferenced
 * vertices, degenerate (zero-area or repeated-corner) triangles, open edges (used by one triangle), non-manifold
 * edges (used by more than two), inconsistent winding (two triangles that traverse a shared edge the same way),
 * an inverted solid (negative enclosed volume) and a self-intersection test between triangles that do not share a
 * vertex. The self-intersection test looks for an edge of one triangle piercing the interior of another, so it
 * finds crossing surfaces but is an approximation: coplanar overlaps and exact edge-on contact are not reported.
 *
 * Everything is pure and deterministic. The report also carries highlight geometry (line segments for edge
 * problems, triangle numbers for face problems) that a viewport can draw.
 */

export type MeshCheckSeverity = "error" | "warning" | "info";

export type MeshCheckIssueKind =
  | "empty-mesh"
  | "invalid-index"
  | "non-finite-vertex"
  | "open-edges"
  | "non-manifold-edges"
  | "inconsistent-winding"
  | "inverted-solid"
  | "degenerate-triangles"
  | "self-intersection"
  | "duplicate-vertices"
  | "unreferenced-vertices";

export interface MeshCheckIssue {
  readonly kind: MeshCheckIssueKind;
  readonly severity: MeshCheckSeverity;
  readonly count: number;
  readonly message: string;
}

export interface MeshCheckCounts {
  readonly invalidIndexTriangles: number;
  readonly nonFiniteVertices: number;
  readonly openEdges: number;
  readonly nonManifoldEdges: number;
  readonly inconsistentWindingEdges: number;
  readonly degenerateTriangles: number;
  readonly duplicateVertices: number;
  readonly unreferencedVertices: number;
  /** Number of triangle pairs found crossing each other. */
  readonly selfIntersectingPairs: number;
}

export interface MeshCheckOptions {
  /** Vertices closer than this (mm) are one vertex. Default 1e-5. */
  readonly weldToleranceMm?: number;
  /** Run the triangle-pair self-intersection test (default true). */
  readonly selfIntersection?: boolean;
  /** The self-intersection test is skipped above this many triangles (default 20000). */
  readonly maxSelfIntersectionTriangles?: number;
  /** At most this many highlight segments / triangles are returned per problem kind (default 4000). */
  readonly maxHighlights?: number;
}

export interface MeshCheckHighlight {
  /** Open edges, flat x1,y1,z1,x2,y2,z2 per segment, in mm. */
  readonly openEdgeSegmentsMm: readonly number[];
  readonly nonManifoldSegmentsMm: readonly number[];
  readonly windingSegmentsMm: readonly number[];
  /** Triangle numbers (index into `indices` / 3). */
  readonly degenerateTriangles: readonly number[];
  readonly selfIntersectingTriangles: readonly number[];
}

export interface MeshCheckReport {
  /** `pass`: nothing to report; `warning`: only warnings or notes; `fail`: at least one error. */
  readonly status: "pass" | "warning" | "fail";
  /** True when there is no error-level issue. */
  readonly ok: boolean;
  readonly vertexCount: number;
  readonly triangleCount: number;
  readonly weldedVertexCount: number;
  readonly edgeCount: number;
  /** Connected shells after welding. */
  readonly components: number;
  /** V - E + F of the welded mesh (2 for a sphere-like closed shell). */
  readonly eulerCharacteristic: number;
  /** Signed enclosed volume of the usable triangles (mm3). Negative means the faces point inward. */
  readonly volumeMm3: number;
  /** Every edge is shared by exactly two triangles. */
  readonly closed: boolean;
  /** No edge is shared by more than two triangles. */
  readonly manifold: boolean;
  readonly selfIntersectionChecked: boolean;
  readonly counts: MeshCheckCounts;
  readonly issues: readonly MeshCheckIssue[];
  readonly highlight: MeshCheckHighlight;
}

type V3 = readonly [number, number, number];

export function checkMesh(positionsMm: readonly number[], indices: readonly number[], options: MeshCheckOptions = {}): MeshCheckReport {
  const tolerance = options.weldToleranceMm !== undefined && options.weldToleranceMm > 0 ? options.weldToleranceMm : 1e-5;
  const maxHighlights = options.maxHighlights ?? 4000;
  const vertexCount = Math.floor(positionsMm.length / 3);
  const rawTriangleCount = Math.floor(indices.length / 3);

  // 1. Vertex validity and welding.
  let nonFiniteVertices = 0;
  const finite: boolean[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const ok = Number.isFinite(positionsMm[vertex * 3]) && Number.isFinite(positionsMm[vertex * 3 + 1]) && Number.isFinite(positionsMm[vertex * 3 + 2]);
    finite.push(ok);
    if (!ok) nonFiniteVertices += 1;
  }
  const weldId = new Int32Array(vertexCount).fill(-1);
  const weldedPosition: V3[] = [];
  const cells = new Map<string, number>();
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (!finite[vertex]) continue;
    const x = positionsMm[vertex * 3]!;
    const y = positionsMm[vertex * 3 + 1]!;
    const z = positionsMm[vertex * 3 + 2]!;
    const key = `${Math.round(x / tolerance)}|${Math.round(y / tolerance)}|${Math.round(z / tolerance)}`;
    let id = cells.get(key);
    if (id === undefined) { id = weldedPosition.length; weldedPosition.push([x, y, z]); cells.set(key, id); }
    weldId[vertex] = id;
  }

  // 2. Triangles: classify each as usable, invalid-index or degenerate.
  let invalidIndexTriangles = 0;
  const degenerate: number[] = [];
  const referenced = new Uint8Array(vertexCount);
  const usable: { readonly triangle: number; readonly a: number; readonly b: number; readonly c: number }[] = [];
  let bboxDiagonal = 0;
  if (weldedPosition.length > 0) {
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (const point of weldedPosition) for (let axis = 0; axis < 3; axis += 1) { if (point[axis]! < min[axis]!) min[axis] = point[axis]!; if (point[axis]! > max[axis]!) max[axis] = point[axis]!; }
    bboxDiagonal = Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!);
  }
  const areaTolerance = Math.max(1e-12, 1e-12 * bboxDiagonal * bboxDiagonal);
  for (let triangle = 0; triangle < rawTriangleCount; triangle += 1) {
    const ia = indices[triangle * 3]!;
    const ib = indices[triangle * 3 + 1]!;
    const ic = indices[triangle * 3 + 2]!;
    const valid = [ia, ib, ic].every((index) => Number.isInteger(index) && index >= 0 && index < vertexCount && finite[index] === true);
    if (!valid) { invalidIndexTriangles += 1; continue; }
    referenced[ia] = 1; referenced[ib] = 1; referenced[ic] = 1;
    const a = weldId[ia]!; const b = weldId[ib]!; const c = weldId[ic]!;
    if (a === b || b === c || c === a || triangleArea(weldedPosition[a]!, weldedPosition[b]!, weldedPosition[c]!) <= areaTolerance) { degenerate.push(triangle); continue; }
    usable.push({ triangle, a, b, c });
  }

  let unreferencedVertices = 0;
  const referencedWelded = new Set<number>();
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (!finite[vertex]) continue;
    if (referenced[vertex] === 0) unreferencedVertices += 1;
    else referencedWelded.add(weldId[vertex]!);
  }
  let referencedVertices = 0;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) if (referenced[vertex] === 1) referencedVertices += 1;
  const duplicateVertices = referencedVertices - referencedWelded.size;

  // 3. Edge use: count, direction.
  const stride = weldedPosition.length + 1;
  const edges = new Map<number, { count: number; forward: number; backward: number; a: number; b: number }>();
  for (const { a, b, c } of usable) {
    for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
      const low = Math.min(from, to);
      const high = Math.max(from, to);
      const key = low * stride + high;
      let edge = edges.get(key);
      if (edge === undefined) { edge = { count: 0, forward: 0, backward: 0, a: low, b: high }; edges.set(key, edge); }
      edge.count += 1;
      if (from === low) edge.forward += 1; else edge.backward += 1;
    }
  }
  const openSegments: number[] = [];
  const nonManifoldSegments: number[] = [];
  const windingSegments: number[] = [];
  let openEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentWindingEdges = 0;
  const pushSegment = (target: number[], edge: { a: number; b: number }): void => {
    if (target.length / 6 >= maxHighlights) return;
    const p = weldedPosition[edge.a]!;
    const q = weldedPosition[edge.b]!;
    target.push(p[0], p[1], p[2], q[0], q[1], q[2]);
  };
  for (const edge of edges.values()) {
    if (edge.count === 1) { openEdges += 1; pushSegment(openSegments, edge); }
    else if (edge.count > 2) { nonManifoldEdges += 1; pushSegment(nonManifoldSegments, edge); }
    else if (edge.forward !== 1 || edge.backward !== 1) { inconsistentWindingEdges += 1; pushSegment(windingSegments, edge); }
  }

  // 4. Shells, Euler characteristic and signed volume.
  const parent = new Map<number, number>();
  const find = (value: number): number => {
    let root = value;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let walk = value;
    while (parent.get(walk) !== root) { const next = parent.get(walk)!; parent.set(walk, root); walk = next; }
    return root;
  };
  for (const { a, b, c } of usable) for (const vertex of [a, b, c]) if (!parent.has(vertex)) parent.set(vertex, vertex);
  for (const { a, b, c } of usable) { parent.set(find(a), find(b)); parent.set(find(b), find(c)); }
  const components = new Set([...parent.keys()].map(find)).size;
  const usedWelded = parent.size;
  const eulerCharacteristic = usedWelded - edges.size + usable.length;
  let volumeSix = 0;
  for (const { a, b, c } of usable) {
    const p = weldedPosition[a]!; const q = weldedPosition[b]!; const r = weldedPosition[c]!;
    volumeSix += p[0] * (q[1] * r[2] - q[2] * r[1]) + p[1] * (q[2] * r[0] - q[0] * r[2]) + p[2] * (q[0] * r[1] - q[1] * r[0]);
  }
  const volumeMm3 = volumeSix / 6;
  const closed = usable.length > 0 && openEdges === 0;
  const manifold = nonManifoldEdges === 0;

  // 5. Self-intersection (triangle pairs that share no vertex).
  const selfIntersectionWanted = options.selfIntersection !== false;
  const selfIntersectionChecked = selfIntersectionWanted && usable.length <= (options.maxSelfIntersectionTriangles ?? 20000);
  const crossing = new Set<number>();
  let selfIntersectingPairs = 0;
  if (selfIntersectionChecked && usable.length > 1) {
    const found = findCrossingTriangles(usable, weldedPosition, bboxDiagonal);
    selfIntersectingPairs = found.pairs;
    for (const triangle of found.triangles) { if (crossing.size < maxHighlights) crossing.add(triangle); }
  }

  const counts: MeshCheckCounts = {
    invalidIndexTriangles, nonFiniteVertices, openEdges, nonManifoldEdges, inconsistentWindingEdges,
    degenerateTriangles: degenerate.length, duplicateVertices, unreferencedVertices, selfIntersectingPairs
  };
  const issues: MeshCheckIssue[] = [];
  const add = (kind: MeshCheckIssueKind, severity: MeshCheckSeverity, count: number, message: string): void => { if (count > 0) issues.push({ kind, severity, count, message }); };
  add("invalid-index", "error", invalidIndexTriangles, `${plural(invalidIndexTriangles, "triangle")} name a vertex that does not exist or is not finite.`);
  add("non-finite-vertex", "error", nonFiniteVertices, `${plural(nonFiniteVertices, "vertex", "vertices")} have a coordinate that is not a finite number.`);
  add("open-edges", "error", openEdges, `${plural(openEdges, "edge")} belong to only one triangle, so the surface has a hole or is not closed.`);
  add("non-manifold-edges", "error", nonManifoldEdges, `${plural(nonManifoldEdges, "edge")} are shared by more than two triangles, so the surface is not a clean manifold.`);
  add("inconsistent-winding", "error", inconsistentWindingEdges, `${plural(inconsistentWindingEdges, "shared edge")} are traversed the same way by both triangles, so some faces point the wrong way.`);
  if (closed && manifold && inconsistentWindingEdges === 0 && volumeMm3 < -1e-9) add("inverted-solid", "error", 1, "The faces point inward (negative enclosed volume); flip the body's normals.");
  add("self-intersection", "error", selfIntersectingPairs, `${plural(selfIntersectingPairs, "triangle pair")} cross each other, so the surface intersects itself.`);
  add("degenerate-triangles", "warning", degenerate.length, `${plural(degenerate.length, "triangle")} have zero area or repeat a corner.`);
  add("duplicate-vertices", "info", duplicateVertices, `${plural(duplicateVertices, "vertex", "vertices")} sit exactly on another vertex (seams that are not welded); harmless for display, merged for the checks.`);
  add("unreferenced-vertices", "info", unreferencedVertices, `${plural(unreferencedVertices, "vertex", "vertices")} are not used by any triangle.`);

  if (rawTriangleCount === 0) issues.unshift({ kind: "empty-mesh", severity: "error", count: 0, message: "The mesh has no triangles." });
  const hasError = issues.some((issue) => issue.severity === "error");
  const status = hasError ? "fail" : issues.some((issue) => issue.severity === "warning") ? "warning" : "pass";
  return {
    status,
    ok: !hasError,
    vertexCount,
    triangleCount: rawTriangleCount,
    weldedVertexCount: weldedPosition.length,
    edgeCount: edges.size,
    components,
    eulerCharacteristic,
    volumeMm3,
    closed,
    manifold,
    selfIntersectionChecked,
    counts,
    issues,
    highlight: {
      openEdgeSegmentsMm: openSegments,
      nonManifoldSegmentsMm: nonManifoldSegments,
      windingSegmentsMm: windingSegments,
      degenerateTriangles: degenerate.slice(0, maxHighlights),
      selfIntersectingTriangles: [...crossing].sort((a, b) => a - b)
    }
  };
}

function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

function triangleArea(a: V3, b: V3, c: V3): number {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  return Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
}

/** Sweep along X over triangle boxes; for each overlapping pair that shares no vertex, test edge-through-face crossings. */
function findCrossingTriangles(
  usable: readonly { readonly triangle: number; readonly a: number; readonly b: number; readonly c: number }[],
  position: readonly V3[],
  diagonal: number
): { readonly pairs: number; readonly triangles: readonly number[] } {
  const boxes = usable.map((entry) => {
    const p = position[entry.a]!; const q = position[entry.b]!; const r = position[entry.c]!;
    return {
      entry,
      min: [Math.min(p[0], q[0], r[0]), Math.min(p[1], q[1], r[1]), Math.min(p[2], q[2], r[2])] as const,
      max: [Math.max(p[0], q[0], r[0]), Math.max(p[1], q[1], r[1]), Math.max(p[2], q[2], r[2])] as const
    };
  });
  boxes.sort((left, right) => left.min[0] - right.min[0]);
  const slack = Math.max(1e-9, diagonal * 1e-9);
  let active: typeof boxes = [];
  let pairs = 0;
  const hit = new Set<number>();
  for (const box of boxes) {
    active = active.filter((other) => other.max[0] >= box.min[0] - slack);
    for (const other of active) {
      if (other.max[1] < box.min[1] - slack || other.min[1] > box.max[1] + slack || other.max[2] < box.min[2] - slack || other.min[2] > box.max[2] + slack) continue;
      const left = box.entry; const right = other.entry;
      if (left.a === right.a || left.a === right.b || left.a === right.c || left.b === right.a || left.b === right.b || left.b === right.c || left.c === right.a || left.c === right.b || left.c === right.c) continue;
      if (trianglesCross(position[left.a]!, position[left.b]!, position[left.c]!, position[right.a]!, position[right.b]!, position[right.c]!, diagonal)) {
        pairs += 1;
        hit.add(left.triangle);
        hit.add(right.triangle);
      }
    }
    active.push(box);
  }
  return { pairs, triangles: [...hit] };
}

function trianglesCross(a0: V3, a1: V3, a2: V3, b0: V3, b1: V3, b2: V3, diagonal: number): boolean {
  const scale = Math.max(diagonal, 1e-9);
  return segmentPiercesTriangle(a0, a1, b0, b1, b2, scale) || segmentPiercesTriangle(a1, a2, b0, b1, b2, scale) || segmentPiercesTriangle(a2, a0, b0, b1, b2, scale)
    || segmentPiercesTriangle(b0, b1, a0, a1, a2, scale) || segmentPiercesTriangle(b1, b2, a0, a1, a2, scale) || segmentPiercesTriangle(b2, b0, a0, a1, a2, scale);
}

/** True when the open segment p-q passes through the interior of triangle a-b-c (not merely touching its boundary or lying in its plane). */
function segmentPiercesTriangle(p: V3, q: V3, a: V3, b: V3, c: V3, scale: number): boolean {
  const dx = q[0] - p[0], dy = q[1] - p[1], dz = q[2] - p[2];
  const e1x = b[0] - a[0], e1y = b[1] - a[1], e1z = b[2] - a[2];
  const e2x = c[0] - a[0], e2y = c[1] - a[1], e2z = c[2] - a[2];
  const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
  const det = e1x * hx + e1y * hy + e1z * hz;
  if (Math.abs(det) < 1e-12 * scale * scale * scale) return false;
  const f = 1 / det;
  const sx = p[0] - a[0], sy = p[1] - a[1], sz = p[2] - a[2];
  const u = f * (sx * hx + sy * hy + sz * hz);
  const edgeEps = 1e-7;
  if (u <= edgeEps || u >= 1 - edgeEps) return false;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = f * (dx * qx + dy * qy + dz * qz);
  if (v <= edgeEps || u + v >= 1 - edgeEps) return false;
  const t = f * (e2x * qx + e2y * qy + e2z * qz);
  return t > edgeEps && t < 1 - edgeEps;
}
