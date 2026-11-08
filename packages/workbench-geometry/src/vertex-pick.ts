/**
 * Vertex picking. A pickable vertex is a real corner of a solid: a place where three or more differently facing surfaces meet.
 * Vertices inside a flat face, along an edge, or between the facets of a round face are not offered, so a click lands on something
 * a designer would call a vertex. Coincident mesh vertices are welded first, because a tessellation repeats every corner once per face.
 */

type V3 = readonly [number, number, number];

export interface VertexMesh {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
}

export interface PickableVertex {
  readonly pointMm: V3;
  /** How many differently facing surfaces meet here (3 for a box corner). */
  readonly surfaces: number;
}

/** Normals of the triangles at a vertex that differ by more than this belong to different surfaces. */
const SURFACE_SEPARATION_DEG = 30;
/** Three surfaces whose normals span less volume than this do not make a corner (they all lean the same way). */
const MIN_SPAN = 0.2;
const WELD_MM = 1e-4;
const MAX_VERTICES = 4000;

/** The corner vertices of a mesh solid, or a message when the mesh is too large to offer. */
export function pickableVertices(mesh: VertexMesh): readonly PickableVertex[] | string {
  const welded = new Map<string, { point: V3; normals: V3[] }>();
  const key = (x: number, y: number, z: number): string => `${Math.round(x / WELD_MM)},${Math.round(y / WELD_MM)},${Math.round(z / WELD_MM)}`;
  for (let triangle = 0; triangle < mesh.indices.length; triangle += 3) {
    const ids = [mesh.indices[triangle]!, mesh.indices[triangle + 1]!, mesh.indices[triangle + 2]!];
    const points = ids.map((id): V3 => [mesh.positionsMm[id * 3]!, mesh.positionsMm[id * 3 + 1]!, mesh.positionsMm[id * 3 + 2]!]);
    const [a, b, c] = points as [V3, V3, V3];
    const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const e2: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const nx = e1[1] * e2[2] - e1[2] * e2[1];
    const ny = e1[2] * e2[0] - e1[0] * e2[2];
    const nz = e1[0] * e2[1] - e1[1] * e2[0];
    const size = Math.hypot(nx, ny, nz);
    for (const point of points) {
      const id = key(point[0], point[1], point[2]);
      let entry = welded.get(id);
      if (entry === undefined) { entry = { point, normals: [] }; welded.set(id, entry); }
      if (size > 1e-12) entry.normals.push([nx / size, ny / size, nz / size]);
    }
  }
  const separation = Math.cos((SURFACE_SEPARATION_DEG * Math.PI) / 180);
  const corners: PickableVertex[] = [];
  for (const { point, normals } of welded.values()) {
    const surfaces: V3[] = [];
    for (const normal of normals) {
      if (!surfaces.some((surface) => surface[0] * normal[0] + surface[1] * normal[1] + surface[2] * normal[2] >= separation)) surfaces.push(normal);
    }
    if (surfaces.length < 3) continue;
    let spans = false;
    for (let i = 0; i < surfaces.length && !spans; i += 1) for (let j = i + 1; j < surfaces.length && !spans; j += 1) for (let k = j + 1; k < surfaces.length && !spans; k += 1) {
      const p = surfaces[i]!; const q = surfaces[j]!; const r = surfaces[k]!;
      const triple = p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0]);
      if (Math.abs(triple) >= MIN_SPAN) spans = true;
    }
    if (!spans) continue;
    corners.push({ pointMm: point, surfaces: surfaces.length });
    if (corners.length > MAX_VERTICES) return `Too many corner vertices (${MAX_VERTICES}+); simplify the body before picking its vertices.`;
  }
  return corners;
}

/** The pickable vertex closest to a clicked point. */
export function nearestMeshVertex(vertices: readonly PickableVertex[], point: V3): { readonly vertex: PickableVertex; readonly distanceMm: number } | undefined {
  let best: PickableVertex | undefined;
  let bestDistance = Infinity;
  for (const vertex of vertices) {
    const distance = Math.hypot(vertex.pointMm[0] - point[0], vertex.pointMm[1] - point[1], vertex.pointMm[2] - point[2]);
    if (distance < bestDistance) { best = vertex; bestDistance = distance; }
  }
  return best === undefined ? undefined : { vertex: best, distanceMm: bestDistance };
}

/** Small crosses at each vertex, as line segments the viewport can draw to show what can be picked. */
export function vertexMarkerSegments(vertices: readonly PickableVertex[], sizeMm: number): readonly (readonly [V3, V3])[] {
  const h = sizeMm / 2;
  return vertices.flatMap(({ pointMm: [x, y, z] }) => [
    [[x - h, y, z], [x + h, y, z]] as const,
    [[x, y - h, z], [x, y + h, z]] as const,
    [[x, y, z - h], [x, y, z + h]] as const
  ]);
}
