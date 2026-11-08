/**
 * SubD form modelling: a Catmull-Clark subdivision surface driven by an editable control cage.
 *
 * This is subdivision modelling, not T-splines. A cage of polygons (usually quads) is subdivided into a smooth surface; moving the
 * cage's vertices, extruding its faces and adding edge loops reshape the surface the way pushing control points does in a T-spline
 * workspace, but there are no T-junction control points, no exact NURBS conversion and no creases. The surface the cage defines is
 * shown tessellated; "Finish Form" turns a closed cage's surface into a solid mesh body.
 */
export interface SubdCage {
  /** Flat x, y, z of the cage's vertices, in millimetres. */
  readonly verticesMm: readonly number[];
  /** Each face lists its vertex indices counter-clockwise seen from outside; quads subdivide best. */
  readonly faces: readonly (readonly number[])[];
}

type Vec3 = readonly [number, number, number];

export const MAX_CAGE_FACES = 4096;
/** The subdivided mesh is kept under this many triangles. */
export const MAX_SUBD_TRIANGLES = 120_000;

const vertexAt = (cage: SubdCage, index: number): Vec3 => [cage.verticesMm[index * 3]!, cage.verticesMm[index * 3 + 1]!, cage.verticesMm[index * 3 + 2]!];
const edgeKeyOf = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);

export function cageVertexCount(cage: SubdCage): number {
  return Math.floor(cage.verticesMm.length / 3);
}

/** A box cage of 8 vertices and 6 quads, centred on the origin. */
export function subdBox(widthMm: number, depthMm: number, heightMm: number): SubdCage {
  const x = widthMm / 2; const y = depthMm / 2; const z = heightMm / 2;
  return {
    verticesMm: [-x, -y, -z, x, -y, -z, x, y, -z, -x, y, -z, -x, -y, z, x, -y, z, x, y, z, -x, y, z],
    faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]]
  };
}

/** A flat open grid cage of `columns` x `rows` quads in the XY plane, centred on the origin, facing +Z. */
export function subdPlane(widthMm: number, depthMm: number, columns: number, rows: number): SubdCage {
  const vertices: number[] = [];
  for (let r = 0; r <= rows; r += 1) for (let c = 0; c <= columns; c += 1) vertices.push((c / columns - 0.5) * widthMm, (r / rows - 0.5) * depthMm, 0);
  const faces: number[][] = [];
  for (let r = 0; r < rows; r += 1) for (let c = 0; c < columns; c += 1) { const a = r * (columns + 1) + c; faces.push([a, a + 1, a + columns + 2, a + columns + 1]); }
  return { verticesMm: vertices, faces };
}

/** A closed cylinder cage: `sides` quads round, with a polygon cap at each end. */
export function subdCylinder(radiusMm: number, heightMm: number, sides: number): SubdCage {
  const vertices: number[] = [];
  for (const z of [-heightMm / 2, heightMm / 2]) for (let i = 0; i < sides; i += 1) vertices.push(radiusMm * Math.cos((i / sides) * Math.PI * 2), radiusMm * Math.sin((i / sides) * Math.PI * 2), z);
  const faces: number[][] = [];
  for (let i = 0; i < sides; i += 1) faces.push([i, (i + 1) % sides, sides + ((i + 1) % sides), sides + i]);
  faces.push(Array.from({ length: sides }, (_, i) => sides - 1 - i));
  faces.push(Array.from({ length: sides }, (_, i) => sides + i));
  return { verticesMm: vertices, faces };
}

/** What is wrong with a cage as a surface (index range, degenerate faces, edges used three times or twice the same way), or undefined. */
export function cageProblem(cage: SubdCage): string | undefined {
  const count = cageVertexCount(cage);
  if (count < 3 || cage.verticesMm.length % 3 !== 0 || !cage.verticesMm.every(Number.isFinite)) return "The cage needs at least three finite vertices.";
  if (cage.faces.length < 1 || cage.faces.length > MAX_CAGE_FACES) return `The cage needs 1 to ${MAX_CAGE_FACES} faces.`;
  const directed = new Set<string>();
  const uses = new Map<string, number>();
  let windingProblem: string | undefined;
  for (const [index, face] of cage.faces.entries()) {
    if (face.length < 3 || face.length > 16) return `Face ${index} needs 3 to 16 vertices.`;
    if (new Set(face).size !== face.length) return `Face ${index} uses a vertex twice.`;
    if (face.some((vertex) => !Number.isInteger(vertex) || vertex < 0 || vertex >= count)) return `Face ${index} names a vertex that does not exist.`;
    for (let k = 0; k < face.length; k += 1) {
      const a = face[k]!; const b = face[(k + 1) % face.length]!;
      if (directed.has(`${a}>${b}`)) windingProblem ??= `Two faces run the same way along the edge ${a}-${b}; their windings disagree.`;
      directed.add(`${a}>${b}`);
      const key = edgeKeyOf(a, b);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  for (const [key, used] of uses) if (used > 2) return `The edge ${key.replace(",", "-")} is shared by ${used} faces; a surface edge has at most two.`;
  return windingProblem;
}

/** Whether every edge of the cage is shared by two faces, i.e. the cage encloses a volume. */
export function cageIsClosed(cage: SubdCage): boolean {
  const uses = new Map<string, number>();
  for (const face of cage.faces) for (let k = 0; k < face.length; k += 1) { const key = edgeKeyOf(face[k]!, face[(k + 1) % face.length]!); uses.set(key, (uses.get(key) ?? 0) + 1); }
  return uses.size > 0 && [...uses.values()].every((used) => used === 2);
}

interface PolyMesh {
  vertices: Vec3[];
  faces: number[][];
}

/** One Catmull-Clark step: face points, edge points and moved original vertices; every face becomes quads. */
function subdivideOnce(mesh: PolyMesh): PolyMesh {
  const { vertices, faces } = mesh;
  const facePoints = faces.map((face) => {
    const sum: [number, number, number] = [0, 0, 0];
    for (const v of face) { sum[0] += vertices[v]![0]; sum[1] += vertices[v]![1]; sum[2] += vertices[v]![2]; }
    return [sum[0] / face.length, sum[1] / face.length, sum[2] / face.length] as Vec3;
  });
  const edgeFaces = new Map<string, number[]>();
  const vertexFaces = vertices.map(() => [] as number[]);
  const vertexEdges = vertices.map(() => [] as string[]);
  faces.forEach((face, f) => {
    face.forEach((v, k) => {
      const next = face[(k + 1) % face.length]!;
      const key = edgeKeyOf(v, next);
      if (!edgeFaces.has(key)) { edgeFaces.set(key, []); vertexEdges[v]!.push(key); vertexEdges[next]!.push(key); }
      edgeFaces.get(key)!.push(f);
      vertexFaces[v]!.push(f);
    });
  });
  const result: Vec3[] = [];
  const facePointIndex = faces.map((_, f) => { result.push(facePoints[f]!); return result.length - 1; });
  const edgePointIndex = new Map<string, number>();
  for (const [key, adjacent] of edgeFaces) {
    const [a, b] = key.split(",").map(Number) as [number, number];
    const mid: Vec3 = [(vertices[a]![0] + vertices[b]![0]) / 2, (vertices[a]![1] + vertices[b]![1]) / 2, (vertices[a]![2] + vertices[b]![2]) / 2];
    if (adjacent.length === 2) {
      const f0 = facePoints[adjacent[0]!]!; const f1 = facePoints[adjacent[1]!]!;
      result.push([(mid[0] * 2 + f0[0] + f1[0]) / 4, (mid[1] * 2 + f0[1] + f1[1]) / 4, (mid[2] * 2 + f0[2] + f1[2]) / 4]);
    } else result.push(mid);
    edgePointIndex.set(key, result.length - 1);
  }
  const moved: Vec3[] = vertices.map((p, v) => {
    const edges = vertexEdges[v]!;
    const boundary = edges.filter((key) => edgeFaces.get(key)!.length === 1);
    if (boundary.length >= 2) {
      if (boundary.length > 2) return p;
      const sum: [number, number, number] = [6 * p[0], 6 * p[1], 6 * p[2]];
      for (const key of boundary) {
        const [a, b] = key.split(",").map(Number) as [number, number];
        const other = vertices[a === v ? b : a]!;
        sum[0] += other[0]; sum[1] += other[1]; sum[2] += other[2];
      }
      return [sum[0] / 8, sum[1] / 8, sum[2] / 8] as Vec3;
    }
    const n = vertexFaces[v]!.length;
    if (n === 0) return p;
    const f: [number, number, number] = [0, 0, 0];
    for (const face of vertexFaces[v]!) { f[0] += facePoints[face]![0] / n; f[1] += facePoints[face]![1] / n; f[2] += facePoints[face]![2] / n; }
    const r: [number, number, number] = [0, 0, 0];
    for (const key of edges) {
      const [a, b] = key.split(",").map(Number) as [number, number];
      r[0] += (vertices[a]![0] + vertices[b]![0]) / 2 / edges.length; r[1] += (vertices[a]![1] + vertices[b]![1]) / 2 / edges.length; r[2] += (vertices[a]![2] + vertices[b]![2]) / 2 / edges.length;
    }
    return [(f[0] + 2 * r[0] + (n - 3) * p[0]) / n, (f[1] + 2 * r[1] + (n - 3) * p[1]) / n, (f[2] + 2 * r[2] + (n - 3) * p[2]) / n] as Vec3;
  });
  const vertexIndex = moved.map((p) => { result.push(p); return result.length - 1; });
  const quads: number[][] = [];
  faces.forEach((face, f) => {
    face.forEach((v, k) => {
      const next = face[(k + 1) % face.length]!;
      const previous = face[(k + face.length - 1) % face.length]!;
      quads.push([vertexIndex[v]!, edgePointIndex.get(edgeKeyOf(v, next))!, facePointIndex[f]!, edgePointIndex.get(edgeKeyOf(previous, v))!]);
    });
  });
  return { vertices: result, faces: quads };
}

export interface SubdMesh {
  readonly positionsMm: number[];
  readonly indices: number[];
  /** The subdivided quads (before they were split into triangles). */
  readonly quads: number[][];
}

export type SubdResult =
  | { readonly ok: true; readonly mesh: SubdMesh }
  | { readonly ok: false; readonly message: string };

/** The cage's Catmull-Clark surface after `levels` subdivisions (0 to 5), as triangles. */
export function subdivideCage(cage: SubdCage, levels: number): SubdResult {
  const problem = cageProblem(cage);
  if (problem !== undefined) return { ok: false, message: problem };
  if (!Number.isInteger(levels) || levels < 0 || levels > 5) return { ok: false, message: "Subdivision levels run from 0 to 5." };
  const estimate = cage.faces.reduce((sum, face) => sum + (levels === 0 ? Math.max(1, face.length - 2) : face.length * 4 ** (levels - 1) * 2), 0);
  if (estimate > MAX_SUBD_TRIANGLES) return { ok: false, message: `That would make about ${estimate} triangles; lower the subdivision level or simplify the cage.` };
  let mesh: PolyMesh = { vertices: Array.from({ length: cageVertexCount(cage) }, (_, i) => vertexAt(cage, i)), faces: cage.faces.map((face) => [...face]) };
  for (let level = 0; level < levels; level += 1) mesh = subdivideOnce(mesh);
  const positions = mesh.vertices.flatMap((p) => [p[0], p[1], p[2]]);
  const indices: number[] = [];
  for (const face of mesh.faces) for (let k = 1; k + 1 < face.length; k += 1) indices.push(face[0]!, face[k]!, face[k + 1]!);
  return { ok: true, mesh: { positionsMm: positions, indices, quads: mesh.faces } };
}

// ---------------------------------------------------------------------------------------------
// Editing the cage
// ---------------------------------------------------------------------------------------------

export type CageEdit =
  | { readonly ok: true; readonly cage: SubdCage; readonly note?: string }
  | { readonly ok: false; readonly message: string };

/** Moves cage vertices by a vector. */
export function moveCageVertices(cage: SubdCage, vertexIds: readonly number[], deltaMm: Vec3): CageEdit {
  const count = cageVertexCount(cage);
  if (vertexIds.length === 0) return { ok: false, message: "Pick at least one vertex to move." };
  if (vertexIds.some((id) => !Number.isInteger(id) || id < 0 || id >= count)) return { ok: false, message: "A vertex to move does not exist." };
  if (!deltaMm.every(Number.isFinite)) return { ok: false, message: "The move is not a finite vector." };
  const verticesMm = [...cage.verticesMm];
  for (const id of new Set(vertexIds)) { verticesMm[id * 3] = verticesMm[id * 3]! + deltaMm[0]; verticesMm[id * 3 + 1] = verticesMm[id * 3 + 1]! + deltaMm[1]; verticesMm[id * 3 + 2] = verticesMm[id * 3 + 2]! + deltaMm[2]; }
  return { ok: true, cage: { verticesMm, faces: cage.faces } };
}

/** The outward unit normal of a face (Newell). */
export function cageFaceNormal(cage: SubdCage, faceId: number): Vec3 {
  const face = cage.faces[faceId]!;
  let x = 0; let y = 0; let z = 0;
  for (let k = 0; k < face.length; k += 1) {
    const a = vertexAt(cage, face[k]!); const b = vertexAt(cage, face[(k + 1) % face.length]!);
    x += (a[1] - b[1]) * (a[2] + b[2]); y += (a[2] - b[2]) * (a[0] + b[0]); z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  const length = Math.hypot(x, y, z);
  return length < 1e-12 ? [0, 0, 1] : [x / length, y / length, z / length];
}

/**
 * Extrudes faces of the cage: the chosen faces move out along their normals (a shared vertex along the average normal of the chosen
 * faces around it) and side faces join them to the rest of the cage. `insetMm` also draws the new cap in towards the centre of the
 * chosen faces (a tapered boss, or the walls of a pocket); pushing a face in (negative distance) needs an inset, or the pocket would
 * have walls of no thickness lying on top of the cage's own.
 */
export function extrudeCageFaces(cage: SubdCage, faceIds: readonly number[], distanceMm: number, insetMm = 0): CageEdit {
  const problem = cageProblem(cage);
  if (problem !== undefined) return { ok: false, message: problem };
  if (faceIds.length === 0) return { ok: false, message: "Pick at least one face to extrude." };
  if (faceIds.some((id) => !Number.isInteger(id) || id < 0 || id >= cage.faces.length)) return { ok: false, message: "A face to extrude does not exist." };
  if (!Number.isFinite(distanceMm) || distanceMm === 0) return { ok: false, message: "Extrude needs a distance other than zero." };
  if (!Number.isFinite(insetMm) || insetMm < 0) return { ok: false, message: "The inset cannot be negative." };
  if (distanceMm < 0 && !(insetMm > 0)) return { ok: false, message: "Pushing a face in needs an inset above zero, so the pocket has walls of its own." };
  const chosen = new Set(faceIds);
  if (cage.faces.length - chosen.size + chosen.size + [...chosen].reduce((sum, id) => sum + cage.faces[id]!.length, 0) > MAX_CAGE_FACES) return { ok: false, message: "The extrusion would pass the cage's face limit." };
  // New vertices: a copy of each vertex of the chosen faces, pushed along the average normal of the chosen faces around it.
  const normalSum = new Map<number, [number, number, number]>();
  for (const id of chosen) {
    const normal = cageFaceNormal(cage, id);
    for (const v of cage.faces[id]!) {
      const sum = normalSum.get(v) ?? [0, 0, 0];
      sum[0] += normal[0]; sum[1] += normal[1]; sum[2] += normal[2];
      normalSum.set(v, sum);
    }
  }
  // The centre each new vertex is drawn towards by the inset: the mean of the centres of the chosen faces around it.
  const centreSum = new Map<number, [number, number, number, number]>();
  for (const id of chosen) {
    const face = cage.faces[id]!;
    const centre: [number, number, number] = [0, 0, 0];
    for (const v of face) for (let axis = 0; axis < 3; axis += 1) centre[axis] = centre[axis]! + cage.verticesMm[v * 3 + axis]! / face.length;
    for (const v of face) { const entry = centreSum.get(v) ?? [0, 0, 0, 0]; entry[0] += centre[0]; entry[1] += centre[1]; entry[2] += centre[2]; entry[3] += 1; centreSum.set(v, entry); }
  }
  const verticesMm = [...cage.verticesMm];
  const copy = new Map<number, number>();
  for (const [v, sum] of normalSum) {
    const length = Math.hypot(sum[0], sum[1], sum[2]);
    const direction: Vec3 = length < 1e-12 ? [0, 0, 0] : [sum[0] / length, sum[1] / length, sum[2] / length];
    const moved: [number, number, number] = [cage.verticesMm[v * 3]! + direction[0] * distanceMm, cage.verticesMm[v * 3 + 1]! + direction[1] * distanceMm, cage.verticesMm[v * 3 + 2]! + direction[2] * distanceMm];
    if (insetMm > 0) {
      const entry = centreSum.get(v)!;
      const toCentre: Vec3 = [entry[0] / entry[3] - cage.verticesMm[v * 3]!, entry[1] / entry[3] - cage.verticesMm[v * 3 + 1]!, entry[2] / entry[3] - cage.verticesMm[v * 3 + 2]!];
      const reach = Math.hypot(toCentre[0], toCentre[1], toCentre[2]);
      if (reach > 1e-12) { const step = Math.min(insetMm, reach * 0.9) / reach; moved[0] += toCentre[0] * step; moved[1] += toCentre[1] * step; moved[2] += toCentre[2] * step; }
    }
    copy.set(v, verticesMm.length / 3);
    verticesMm.push(moved[0], moved[1], moved[2]);
  }
  const faces: number[][] = [];
  // Edges of chosen faces whose other side is not a chosen face get a side quad.
  const chosenEdgeUses = new Map<string, number>();
  for (const id of chosen) { const face = cage.faces[id]!; for (let k = 0; k < face.length; k += 1) { const key = edgeKeyOf(face[k]!, face[(k + 1) % face.length]!); chosenEdgeUses.set(key, (chosenEdgeUses.get(key) ?? 0) + 1); } }
  cage.faces.forEach((face, id) => {
    if (!chosen.has(id)) { faces.push([...face]); return; }
    faces.push(face.map((v) => copy.get(v)!));
    for (let k = 0; k < face.length; k += 1) {
      const a = face[k]!; const b = face[(k + 1) % face.length]!;
      if ((chosenEdgeUses.get(edgeKeyOf(a, b)) ?? 0) === 1) faces.push([a, b, copy.get(b)!, copy.get(a)!]);
    }
  });
  return compactCage({ verticesMm, faces });
}

/** Removes vertices no face uses any more, renumbering the faces. */
function compactCage(cage: SubdCage): CageEdit {
  const used = new Set<number>(cage.faces.flat());
  const remap = new Map<number, number>();
  const verticesMm: number[] = [];
  for (let v = 0; v < cageVertexCount(cage); v += 1) if (used.has(v)) { remap.set(v, verticesMm.length / 3); verticesMm.push(cage.verticesMm[v * 3]!, cage.verticesMm[v * 3 + 1]!, cage.verticesMm[v * 3 + 2]!); }
  const result: SubdCage = { verticesMm, faces: cage.faces.map((face) => face.map((v) => remap.get(v)!)) };
  const problem = cageProblem(result);
  return problem === undefined ? { ok: true, cage: result } : { ok: false, message: problem };
}

/** Deletes faces from the cage (leaving an opening where they were). */
export function deleteCageFaces(cage: SubdCage, faceIds: readonly number[]): CageEdit {
  if (faceIds.length === 0) return { ok: false, message: "Pick at least one face to delete." };
  if (faceIds.some((id) => !Number.isInteger(id) || id < 0 || id >= cage.faces.length)) return { ok: false, message: "A face to delete does not exist." };
  const gone = new Set(faceIds);
  if (gone.size >= cage.faces.length) return { ok: false, message: "That would delete every face of the cage." };
  return compactCage({ verticesMm: cage.verticesMm, faces: cage.faces.filter((_, id) => !gone.has(id)) });
}

/**
 * Adds an edge loop: the loop of quads that the edge `a-b` runs across is split in two along a new ring of vertices, placed at
 * `ratio` of the way from the edge's first vertex to its second (0 to 1, exclusive). The loop must pass through quads only.
 */
export function insertEdgeLoop(cage: SubdCage, a: number, b: number, ratio = 0.5): CageEdit {
  const problem = cageProblem(cage);
  if (problem !== undefined) return { ok: false, message: problem };
  if (!(ratio > 0 && ratio < 1)) return { ok: false, message: "An edge loop goes between 0 and 1 of the way along the edge." };
  const edgeFaces = new Map<string, number[]>();
  cage.faces.forEach((face, id) => face.forEach((v, k) => { const key = edgeKeyOf(v, face[(k + 1) % face.length]!); if (!edgeFaces.has(key)) edgeFaces.set(key, []); edgeFaces.get(key)!.push(id); }));
  if (!edgeFaces.has(edgeKeyOf(a, b))) return { ok: false, message: `There is no cage edge ${a}-${b}.` };
  // Walk across quads: each crossed quad has two loop edges, which are opposite sides; `from` -> `to` keeps the ratio's direction consistent.
  const loopEdges = new Map<string, { from: number; to: number }>();
  const crossed = new Set<number>();
  const queue: { from: number; to: number }[] = [{ from: a, to: b }];
  loopEdges.set(edgeKeyOf(a, b), { from: a, to: b });
  while (queue.length > 0) {
    const { from, to } = queue.shift()!;
    for (const faceId of edgeFaces.get(edgeKeyOf(from, to)) ?? []) {
      if (crossed.has(faceId)) continue;
      const face = cage.faces[faceId]!;
      if (face.length !== 4) return { ok: false, message: `The loop runs into a face with ${face.length} sides (face ${faceId}); an edge loop can only cross quads. Add the loop where the cage is made of quads.` };
      crossed.add(faceId);
      // The quad's vertices in order; the edge from-to is one side, and the opposite side joins the vertices next to them.
      const at = face.indexOf(from);
      const forward = face[(at + 1) % 4] === to;
      const fromNeighbour = forward ? face[(at + 3) % 4]! : face[(at + 1) % 4]!;
      const toNeighbour = forward ? face[(at + 2) % 4]! : face[(at + 2) % 4]!;
      const opposite = { from: fromNeighbour, to: toNeighbour };
      const key = edgeKeyOf(opposite.from, opposite.to);
      const existing = loopEdges.get(key);
      if (existing !== undefined) {
        if (existing.from !== opposite.from) return { ok: false, message: "The loop folds back on itself, so its ratio cannot be kept consistent." };
        continue;
      }
      loopEdges.set(key, opposite);
      queue.push(opposite);
    }
  }
  const verticesMm = [...cage.verticesMm];
  const midpoint = new Map<string, number>();
  for (const [key, { from, to }] of loopEdges) {
    midpoint.set(key, verticesMm.length / 3);
    for (let axis = 0; axis < 3; axis += 1) verticesMm.push(cage.verticesMm[from * 3 + axis]! + (cage.verticesMm[to * 3 + axis]! - cage.verticesMm[from * 3 + axis]!) * ratio);
  }
  const faces: number[][] = [];
  cage.faces.forEach((face, id) => {
    if (!crossed.has(id)) { faces.push([...face]); return; }
    // Find which pair of opposite sides carries the loop.
    for (let k = 0; k < 2; k += 1) {
      const m0 = midpoint.get(edgeKeyOf(face[k]!, face[k + 1]!));
      const m2 = midpoint.get(edgeKeyOf(face[k + 2]!, face[(k + 3) % 4]!));
      if (m0 === undefined || m2 === undefined) continue;
      // Sides k and k+2 are cut: [v_k, m0, m2, v_{k+3}] and [m0, v_{k+1}, v_{k+2}, m2].
      faces.push([face[k]!, m0, m2, face[(k + 3) % 4]!], [m0, face[k + 1]!, face[k + 2]!, m2]);
      return;
    }
    faces.push([...face]);
  });
  if (faces.length > MAX_CAGE_FACES) return { ok: false, message: "The loop would pass the cage's face limit." };
  const result: SubdCage = { verticesMm, faces };
  const check = cageProblem(result);
  return check === undefined ? { ok: true, cage: result, note: `Added an edge loop across ${crossed.size} quad${crossed.size === 1 ? "" : "s"}.` } : { ok: false, message: check };
}

export type FinishResult =
  | { readonly ok: true; readonly positionsMm: number[]; readonly indices: number[]; readonly volumeMm3: number }
  | { readonly ok: false; readonly message: string };

/** Finish Form: the closed cage's subdivision surface as an outward-facing solid mesh. */
export function finishForm(cage: SubdCage, levels: number): FinishResult {
  const surface = subdivideCage(cage, levels);
  if (!surface.ok) return surface;
  if (!cageIsClosed(cage)) return { ok: false, message: "The form is open: every cage edge must be shared by two faces before it can be finished into a solid. Close the cage or keep it as a surface." };
  const { positionsMm, indices } = surface.mesh;
  let volume = 0;
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const [a, b, c] = [indices[i]! * 3, indices[i + 1]! * 3, indices[i + 2]! * 3];
    volume += (positionsMm[a]! * (positionsMm[b + 1]! * positionsMm[c + 2]! - positionsMm[b + 2]! * positionsMm[c + 1]!) - positionsMm[a + 1]! * (positionsMm[b]! * positionsMm[c + 2]! - positionsMm[b + 2]! * positionsMm[c]!) + positionsMm[a + 2]! * (positionsMm[b]! * positionsMm[c + 1]! - positionsMm[b + 1]! * positionsMm[c]!)) / 6;
  }
  const flipped = volume < 0;
  const fixed = flipped ? indices.map((_, i, all) => all[i - (i % 3) + [0, 2, 1][i % 3]!]!) : indices;
  if (!(Math.abs(volume) > 1e-6)) return { ok: false, message: "The form encloses no volume." };
  return { ok: true, positionsMm, indices: fixed, volumeMm3: Math.abs(volume) };
}
