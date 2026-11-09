/**
 * Mesh-level Boolean (join, cut, intersect) on closed triangle meshes, in pure TypeScript.
 *
 * This is a BSP-tree CSG with a strict clean-up: vertices are welded, degenerate triangles
 * dropped, T-junctions repaired, and the result must be a closed, consistently oriented
 * manifold whose volume agrees with the operation. Anything else is rejected rather than
 * returned, so a Boolean either yields a valid solid or leaves the inputs untouched.
 *
 * It operates on tessellations, not on exact B-rep faces, so curved faces are the facets of
 * the input meshes. Each result triangle remembers which operand and which face it came from.
 */

export type BooleanMode = "join" | "cut" | "intersect";

export interface BooleanMeshInput {
  /** Flat x, y, z coordinates in millimetres. */
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
  /** Optional face index per triangle, carried through to the result. */
  readonly faceTriangles?: readonly number[];
}

export interface BooleanTriangleOrigin {
  readonly source: "target" | "tool";
  /** The face index in the source mesh, or -1 when the source carried none. */
  readonly face: number;
}

export interface BooleanMeshOutput {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
  /** One entry per result triangle. */
  readonly origins: readonly BooleanTriangleOrigin[];
  readonly volumeMm3: number;
  /** How many separate closed pieces the result has (1 unless `allowSplit` let a cut sever the target). */
  readonly pieceCount: number;
}

export interface BooleanOptions {
  /** Let a cut or intersection leave several separate pieces instead of refusing; the caller splits the mesh into bodies. */
  readonly allowSplit?: boolean;
}

export type BooleanMeshResult =
  | { readonly ok: true; readonly value: BooleanMeshOutput }
  | { readonly ok: false; readonly message: string };

type V3 = [number, number, number];

interface Plane {
  readonly n: V3;
  readonly w: number;
}

interface Poly {
  readonly v: V3[];
  readonly plane: Plane;
  readonly source: 0 | 1;
  readonly face: number;
}

const PLANE_EPSILON = 1e-6;
const WELD_QUANTUM = 1e-5;
/**
 * Vertices are welded by rounding to a grid of WELD_QUANTUM. A coordinate that sits exactly on a rounding boundary (a half quantum,
 * which happens for round dimensions such as a 4.9175 mm hole at 60 degrees) would round either way depending on one part in 1e16 of
 * floating-point noise, leaving two copies of one corner unwelded. Shifting the grid by an irrational-looking offset keeps every
 * coordinate a "nice" number would produce far from a boundary.
 */
const WELD_OFFSET: readonly [number, number, number] = [0.003141592653589793, 0.002718281828459045, 0.001414213562373095];
/** Points closer than this on every axis are one vertex: a few times the plane tolerance, far below the 0.01 mm smallest feature. */
const WELD_RADIUS = 4 * WELD_QUANTUM;
const cellOf = (value: number, axis: number): number => Math.floor((value + WELD_OFFSET[axis]!) / WELD_RADIUS);

/**
 * A vertex index that merges every point within WELD_RADIUS of one already stored. Rounding to a grid alone splits two points that
 * lie a hair apart on opposite sides of a grid line, and a cut through a plate with a finely faceted bore produced many such pairs
 * (the plane tolerance snaps two crossing points to within a millionth of a millimetre of each other), which left the result open.
 * Here the 27 cells around the point are searched, so near points always merge.
 */
function vertexWelder(positions: V3[]): (x: number, y: number, z: number) => number {
  const cells = new Map<string, number[]>();
  return (x, y, z) => {
    const cx = cellOf(x, 0); const cy = cellOf(y, 1); const cz = cellOf(z, 2);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
      const nearby = cells.get(`${cx + dx},${cy + dy},${cz + dz}`);
      if (nearby === undefined) continue;
      for (const id of nearby) {
        const point = positions[id]!;
        if (Math.abs(point[0] - x) <= WELD_RADIUS && Math.abs(point[1] - y) <= WELD_RADIUS && Math.abs(point[2] - z) <= WELD_RADIUS) return id;
      }
    }
    positions.push([x, y, z]);
    const own = `${cx},${cy},${cz}`;
    const list = cells.get(own);
    if (list === undefined) cells.set(own, [positions.length - 1]); else list.push(positions.length - 1);
    return positions.length - 1;
  };
}
const MIN_TRIANGLE_AREA = 1e-10;
const MAX_TRIANGLES_PER_INPUT = 60_000;
const MAX_TREE_DEPTH = 3_000;
const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

export function booleanMeshes(target: BooleanMeshInput, tool: BooleanMeshInput, mode: BooleanMode, options: BooleanOptions = {}): BooleanMeshResult {
  const first = readSolid(target, "target");
  if (typeof first === "string") return { ok: false, message: first };
  const second = readSolid(tool, "tool");
  if (typeof second === "string") return { ok: false, message: second };
  if (!boxesOverlap(first.bounds, second.bounds)) {
    return { ok: false, message: mode === "join" ? "The bodies do not touch or overlap, so they cannot be joined into one solid." : mode === "cut" ? "The tool does not overlap the target, so there is nothing to cut." : "The bodies do not overlap, so their intersection is empty." };
  }

  let polygons: Poly[];
  try {
    const a = new BspNode();
    const b = new BspNode();
    a.build(first.polygons.map(clonePoly), 0);
    b.build(second.polygons.map(clonePoly), 0);
    if (mode === "join") {
      a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert();
      a.build(b.allPolygons(), 0);
    } else if (mode === "cut") {
      a.invert(); a.clipTo(b); b.clipTo(a); b.invert(); b.clipTo(a); b.invert();
      a.build(b.allPolygons(), 0);
      a.invert();
    } else {
      a.invert(); b.clipTo(a); b.invert(); a.clipTo(b); b.clipTo(a);
      a.build(b.allPolygons(), 0);
      a.invert();
    }
    polygons = a.allPolygons();
  } catch (error) {
    return { ok: false, message: error instanceof Error && error.message === "TOO_DEEP" ? "The bodies are too detailed for a Boolean; simplify one of them." : "The Boolean could not be evaluated." };
  }

  const cleaned = cleanUp(polygons);
  if (typeof cleaned === "string") return { ok: false, message: cleaned };
  const volume = signedVolume(cleaned.positions, cleaned.triangles);
  const tolerance = 1e-6 * (first.volume + second.volume) + 1e-6;
  const pieceCount = componentCount(cleaned.triangles);
  const verdict = judgeResult(mode, volume, first.volume, second.volume, tolerance, pieceCount, options.allowSplit === true);
  if (verdict !== undefined) return { ok: false, message: verdict };

  return {
    ok: true,
    value: {
      positionsMm: cleaned.positions.flat(),
      indices: cleaned.triangles.flatMap((triangle) => [triangle.a, triangle.b, triangle.c]),
      origins: cleaned.triangles.map((triangle): BooleanTriangleOrigin => ({ source: triangle.source === 0 ? "target" : "tool", face: triangle.face })),
      volumeMm3: volume,
      pieceCount
    }
  };
}

function judgeResult(mode: BooleanMode, volume: number, targetVolume: number, toolVolume: number, tolerance: number, components: number, allowSplit: boolean): string | undefined {
  if (!(volume > tolerance)) return mode === "intersect" ? "The bodies do not overlap, so their intersection is empty." : "The result is empty.";
  if (components > 1 && !(allowSplit && mode !== "join")) {
    return mode === "join"
      ? "The bodies do not touch, so joining them would give two separate solids."
      : `The ${mode === "cut" ? "cut divides the target into" : "intersection is"} ${components} separate pieces, which is not supported yet.`;
  }
  if (mode === "join" && (volume < Math.max(targetVolume, toolVolume) - tolerance || volume > targetVolume + toolVolume + tolerance)) return "The join produced an inconsistent volume, so it was rejected.";
  if (mode === "cut") {
    if (Math.abs(volume - targetVolume) <= tolerance) return "The tool does not overlap the target, so there is nothing to cut.";
    if (volume > targetVolume + tolerance || volume < targetVolume - toolVolume - tolerance) return "The cut produced an inconsistent volume, so it was rejected.";
  }
  if (mode === "intersect" && volume > Math.min(targetVolume, toolVolume) + tolerance) return "The intersection produced an inconsistent volume, so it was rejected.";
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------------------------

interface Solid {
  readonly polygons: Poly[];
  readonly bounds: { readonly min: V3; readonly max: V3 };
  readonly volume: number;
}

function readSolid(mesh: BooleanMeshInput, label: "target" | "tool"): Solid | string {
  const triangleCount = Math.floor(mesh.indices.length / 3);
  if (triangleCount < 4 || mesh.positionsMm.length < 12) return `The ${label} is not a solid mesh.`;
  if (triangleCount > MAX_TRIANGLES_PER_INPUT) return `The ${label} has ${triangleCount} triangles; a Boolean is limited to ${MAX_TRIANGLES_PER_INPUT} per body.`;
  const vertexCount = Math.floor(mesh.positionsMm.length / 3);
  if (mesh.indices.some((index) => !Number.isInteger(index) || index < 0 || index >= vertexCount) || mesh.positionsMm.some((value) => !Number.isFinite(value))) return `The ${label} mesh is invalid.`;

  const welded = weld(mesh.positionsMm, mesh.indices.map((index) => index));
  const closed = checkClosed(welded.triangles);
  if (!closed) return `The ${label} is not a closed solid (it has open or non-manifold edges), so a Boolean cannot use it.`;
  const volume = signedVolume(welded.positions, welded.triangles.map((triangle) => ({ ...triangle, source: 0 as const, face: -1 })));
  if (!(volume > 1e-9)) return `The ${label} has no positive volume (its faces may point inward).`;

  const polygons: Poly[] = [];
  const source = label === "target" ? 0 : 1;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const corners = [0, 1, 2].map((corner): V3 => {
      const index = mesh.indices[triangle * 3 + corner]!;
      return [mesh.positionsMm[index * 3]!, mesh.positionsMm[index * 3 + 1]!, mesh.positionsMm[index * 3 + 2]!];
    });
    const plane = planeOf(corners[0]!, corners[1]!, corners[2]!);
    if (plane === undefined) continue;
    polygons.push({ v: corners, plane, source, face: mesh.faceTriangles?.[triangle] ?? -1 });
  }
  const min: V3 = [Infinity, Infinity, Infinity];
  const max: V3 = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < vertexCount; index += 1) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = mesh.positionsMm[index * 3 + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return { polygons, bounds: { min, max }, volume };
}

function boxesOverlap(a: Solid["bounds"], b: Solid["bounds"]): boolean {
  return [0, 1, 2].every((axis) => a.min[axis]! <= b.max[axis]! + PLANE_EPSILON && b.min[axis]! <= a.max[axis]! + PLANE_EPSILON);
}

// ---------------------------------------------------------------------------------------------
// BSP tree
// ---------------------------------------------------------------------------------------------

class BspNode {
  plane: Plane | undefined;
  front: BspNode | undefined;
  back: BspNode | undefined;
  polygons: Poly[] = [];

  build(polygons: Poly[], depth: number): void {
    if (polygons.length === 0) return;
    if (depth > MAX_TREE_DEPTH) throw new Error("TOO_DEEP");
    if (this.plane === undefined) this.plane = choosePlane(polygons);
    const front: Poly[] = [];
    const back: Poly[] = [];
    for (const polygon of polygons) splitPolygon(this.plane, polygon, this.polygons, this.polygons, front, back);
    if (front.length > 0) {
      this.front ??= new BspNode();
      this.front.build(front, depth + 1);
    }
    if (back.length > 0) {
      this.back ??= new BspNode();
      this.back.build(back, depth + 1);
    }
  }

  invert(): void {
    for (let index = 0; index < this.polygons.length; index += 1) this.polygons[index] = flipPoly(this.polygons[index]!);
    if (this.plane !== undefined) this.plane = { n: [-this.plane.n[0], -this.plane.n[1], -this.plane.n[2]], w: -this.plane.w };
    this.front?.invert();
    this.back?.invert();
    const swap = this.front;
    this.front = this.back;
    this.back = swap;
  }

  clipPolygons(polygons: Poly[]): Poly[] {
    if (this.plane === undefined) return polygons.slice();
    const front: Poly[] = [];
    const back: Poly[] = [];
    for (const polygon of polygons) splitPolygon(this.plane, polygon, front, back, front, back);
    const keptFront = this.front === undefined ? front : this.front.clipPolygons(front);
    const keptBack = this.back === undefined ? [] : this.back.clipPolygons(back);
    return keptFront.concat(keptBack);
  }

  clipTo(other: BspNode): void {
    this.polygons = other.clipPolygons(this.polygons);
    this.front?.clipTo(other);
    this.back?.clipTo(other);
  }

  allPolygons(): Poly[] {
    let all = this.polygons.slice();
    if (this.front !== undefined) all = all.concat(this.front.allPolygons());
    if (this.back !== undefined) all = all.concat(this.back.allPolygons());
    return all;
  }
}

/** Picks a splitting plane that cuts few polygons and balances the two sides, from a handful of candidates. */
function choosePlane(polygons: Poly[]): Plane {
  if (polygons.length <= 6) return polygons[0]!.plane;
  const candidates = 6;
  let best = polygons[0]!.plane;
  let bestScore = Infinity;
  for (let index = 0; index < candidates; index += 1) {
    const candidate = polygons[Math.floor((index * polygons.length) / candidates)]!.plane;
    let front = 0;
    let back = 0;
    let spanning = 0;
    for (const polygon of polygons) {
      const kind = classify(candidate, polygon);
      if (kind === FRONT) front += 1;
      else if (kind === BACK) back += 1;
      else if (kind === SPANNING) spanning += 1;
    }
    const score = spanning * 4 + Math.abs(front - back);
    if (score < bestScore) { bestScore = score; best = candidate; }
  }
  return best;
}

function classify(plane: Plane, polygon: Poly): number {
  let kind = COPLANAR;
  for (const vertex of polygon.v) {
    const distance = plane.n[0] * vertex[0] + plane.n[1] * vertex[1] + plane.n[2] * vertex[2] - plane.w;
    kind |= distance < -PLANE_EPSILON ? BACK : distance > PLANE_EPSILON ? FRONT : COPLANAR;
  }
  return kind;
}

function splitPolygon(plane: Plane, polygon: Poly, coplanarFront: Poly[], coplanarBack: Poly[], front: Poly[], back: Poly[]): void {
  const types: number[] = [];
  let kind = COPLANAR;
  for (const vertex of polygon.v) {
    const distance = plane.n[0] * vertex[0] + plane.n[1] * vertex[1] + plane.n[2] * vertex[2] - plane.w;
    const type = distance < -PLANE_EPSILON ? BACK : distance > PLANE_EPSILON ? FRONT : COPLANAR;
    kind |= type;
    types.push(type);
  }
  if (kind === COPLANAR) {
    (plane.n[0] * polygon.plane.n[0] + plane.n[1] * polygon.plane.n[1] + plane.n[2] * polygon.plane.n[2] > 0 ? coplanarFront : coplanarBack).push(polygon);
  } else if (kind === FRONT) {
    front.push(polygon);
  } else if (kind === BACK) {
    back.push(polygon);
  } else {
    const frontVertices: V3[] = [];
    const backVertices: V3[] = [];
    for (let i = 0; i < polygon.v.length; i += 1) {
      const j = (i + 1) % polygon.v.length;
      const ti = types[i]!;
      const tj = types[j]!;
      const vi = polygon.v[i]!;
      const vj = polygon.v[j]!;
      if (ti !== BACK) frontVertices.push(vi);
      if (ti !== FRONT) backVertices.push(ti !== BACK ? [vi[0], vi[1], vi[2]] : vi);
      if ((ti | tj) === SPANNING) {
        const along = (plane.w - (plane.n[0] * vi[0] + plane.n[1] * vi[1] + plane.n[2] * vi[2])) / (plane.n[0] * (vj[0] - vi[0]) + plane.n[1] * (vj[1] - vi[1]) + plane.n[2] * (vj[2] - vi[2]));
        const cut: V3 = [vi[0] + (vj[0] - vi[0]) * along, vi[1] + (vj[1] - vi[1]) * along, vi[2] + (vj[2] - vi[2]) * along];
        frontVertices.push(cut);
        backVertices.push([cut[0], cut[1], cut[2]]);
      }
    }
    if (frontVertices.length >= 3) front.push({ v: frontVertices, plane: polygon.plane, source: polygon.source, face: polygon.face });
    if (backVertices.length >= 3) back.push({ v: backVertices, plane: polygon.plane, source: polygon.source, face: polygon.face });
  }
}

function flipPoly(polygon: Poly): Poly {
  return { v: [...polygon.v].reverse(), plane: { n: [-polygon.plane.n[0], -polygon.plane.n[1], -polygon.plane.n[2]], w: -polygon.plane.w }, source: polygon.source, face: polygon.face };
}

function clonePoly(polygon: Poly): Poly {
  return { v: polygon.v.map((vertex): V3 => [vertex[0], vertex[1], vertex[2]]), plane: polygon.plane, source: polygon.source, face: polygon.face };
}

function planeOf(a: V3, b: V3, c: V3): Plane | undefined {
  const ux = b[0] - a[0]; const uy = b[1] - a[1]; const uz = b[2] - a[2];
  const vx = c[0] - a[0]; const vy = c[1] - a[1]; const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz);
  if (length < 1e-12) return undefined;
  const n: V3 = [nx / length, ny / length, nz / length];
  return { n, w: n[0] * a[0] + n[1] * a[1] + n[2] * a[2] };
}

// ---------------------------------------------------------------------------------------------
// Clean-up: weld, drop slivers, repair T-junctions, verify a closed manifold
// ---------------------------------------------------------------------------------------------

interface Triangle {
  a: number;
  b: number;
  c: number;
  source: 0 | 1;
  face: number;
}

interface WeldedMesh {
  readonly positions: V3[];
  readonly triangles: { a: number; b: number; c: number }[];
}

function weld(flat: readonly number[], indices: readonly number[]): WeldedMesh {
  const positions: V3[] = [];
  const idOf = vertexWelder(positions);
  const remap = new Map<number, number>();
  const triangles: { a: number; b: number; c: number }[] = [];
  const mapped = (index: number): number => {
    let id = remap.get(index);
    if (id === undefined) { id = idOf(flat[index * 3]!, flat[index * 3 + 1]!, flat[index * 3 + 2]!); remap.set(index, id); }
    return id;
  };
  for (let i = 0; i + 2 < indices.length; i += 3) {
    const a = mapped(indices[i]!); const b = mapped(indices[i + 1]!); const c = mapped(indices[i + 2]!);
    if (a !== b && b !== c && a !== c) triangles.push({ a, b, c });
  }
  return { positions, triangles };
}

function checkClosed(triangles: readonly { a: number; b: number; c: number }[]): boolean {
  const directed = new Map<string, number>();
  for (const { a, b, c } of triangles) {
    for (const [from, to] of [[a, b], [b, c], [c, a]] as const) directed.set(`${from},${to}`, (directed.get(`${from},${to}`) ?? 0) + 1);
  }
  for (const [key, count] of directed) {
    const [from, to] = key.split(",");
    if (count !== 1 || directed.get(`${to},${from}`) !== 1) return false;
  }
  return directed.size > 0;
}

function signedVolume(positions: readonly V3[], triangles: readonly { a: number; b: number; c: number }[]): number {
  let total = 0;
  for (const { a, b, c } of triangles) {
    const p = positions[a]!; const q = positions[b]!; const r = positions[c]!;
    total += p[0] * (q[1] * r[2] - q[2] * r[1]) - p[1] * (q[0] * r[2] - q[2] * r[0]) + p[2] * (q[0] * r[1] - q[1] * r[0]);
  }
  return total / 6;
}

function componentCount(triangles: readonly { a: number; b: number; c: number }[]): number {
  const parent = new Map<number, number>();
  const find = (value: number): number => {
    let root = value;
    while ((parent.get(root) ?? root) !== root) root = parent.get(root)!;
    let walk = value;
    while ((parent.get(walk) ?? walk) !== root) { const next = parent.get(walk)!; parent.set(walk, root); walk = next; }
    return root;
  };
  for (const { a, b, c } of triangles) {
    for (const vertex of [a, b, c]) if (!parent.has(vertex)) parent.set(vertex, vertex);
    parent.set(find(a), find(b));
    parent.set(find(b), find(c));
  }
  return new Set([...parent.keys()].map(find)).size;
}

function cleanUp(polygons: readonly Poly[]): { positions: V3[]; triangles: Triangle[] } | string {
  if (polygons.length === 0) return "The result is empty.";
  const positions: V3[] = [];
  const weldVertex = vertexWelder(positions);
  const idOf = (vertex: V3): number => weldVertex(vertex[0], vertex[1], vertex[2]);
  let triangles: Triangle[] = [];
  for (const polygon of polygons) {
    const ids = polygon.v.map(idOf);
    for (let corner = 1; corner + 1 < ids.length; corner += 1) {
      triangles.push({ a: ids[0]!, b: ids[corner]!, c: ids[corner + 1]!, source: polygon.source, face: polygon.face });
    }
  }
  for (let pass = 0; pass < 6; pass += 1) {
    triangles = cancelCoincidentTriangles(triangles.filter((triangle) => triangle.a !== triangle.b && triangle.b !== triangle.c && triangle.a !== triangle.c && triangleArea(positions, triangle) >= MIN_TRIANGLE_AREA));
    const repaired = splitTJunctions(positions, triangles);
    triangles = repaired.triangles;
    if (!repaired.changed) break;
  }
  if (!checkClosed(triangles)) triangles = fillTinyGaps(positions, triangles);
  if (!checkClosed(triangles)) return "The Boolean did not produce a clean closed solid (the faces do not meet exactly), so it was rejected and nothing changed.";
  return { positions, triangles };
}

/** A leftover gap is closed only when it is a sliver: its area stays under this (a strip a few microns wide and a millimetre long) and its outline is short. */
const MAX_GAP_AREA_MM2 = 0.005;
const MAX_GAP_PERIMETER_MM = 20;

/**
 * The splitting can drop a sliver of a face that lies within a hair of a cutting wall, leaving a tiny hole in an otherwise closed
 * result (the edges around it are used once and never backwards). A hole that is only a sliver (a loop with a tiny area) is closed
 * with a fan of triangles facing the way the neighbours expect; a bigger one is left open, and the result is then refused as before.
 * The volume check that follows keeps a wrongly closed gap from being accepted.
 */
function fillTinyGaps(positions: readonly V3[], triangles: Triangle[]): Triangle[] {
  const present = new Set<string>();
  for (const { a, b, c } of triangles) for (const [from, to] of [[a, b], [b, c], [c, a]] as const) present.add(`${from},${to}`);
  // The edges a filling triangle would use: each unmatched edge, turned round.
  const next = new Map<number, number[]>();
  let unmatched = 0;
  for (const key of present) {
    const [from, to] = key.split(",").map(Number) as [number, number];
    if (present.has(`${to},${from}`)) continue;
    unmatched += 1;
    const list = next.get(to);
    if (list === undefined) next.set(to, [from]); else list.push(from);
  }
  if (unmatched === 0 || unmatched > 60) return triangles;
  const used = new Set<string>();
  const filled: Triangle[] = [...triangles];
  for (const [startFrom, targets] of next) {
    for (const startTo of targets) {
      if (used.has(`${startFrom},${startTo}`)) continue;
      const loop: number[] = [startFrom];
      let from = startFrom;
      let to = startTo;
      let closedLoop = false;
      for (let step = 0; step < 8; step += 1) {
        used.add(`${from},${to}`);
        if (to === startFrom) { closedLoop = true; break; }
        loop.push(to);
        const options = (next.get(to) ?? []).filter((candidate) => !used.has(`${to},${candidate}`));
        if (options.length !== 1) break;
        from = to;
        to = options[0]!;
      }
      if (!closedLoop || loop.length < 3) continue;
      let perimeter = 0;
      let nx = 0; let ny = 0; let nz = 0;
      for (let index = 0; index < loop.length; index += 1) {
        const a = positions[loop[index]!]!;
        const b = positions[loop[(index + 1) % loop.length]!]!;
        perimeter += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        nx += a[1] * b[2] - a[2] * b[1]; ny += a[2] * b[0] - a[0] * b[2]; nz += a[0] * b[1] - a[1] * b[0];
      }
      if (perimeter > MAX_GAP_PERIMETER_MM || Math.hypot(nx, ny, nz) / 2 > MAX_GAP_AREA_MM2) continue;
      const template = triangles[0]!;
      for (let corner = 1; corner + 1 < loop.length; corner += 1) filled.push({ a: loop[0]!, b: loop[corner]!, c: loop[corner + 1]!, source: template.source, face: -1 });
    }
  }
  return filled;
}

/**
 * Two triangles on the same three vertices cancel when they face opposite ways (a zero-thickness fold the splitting leaves where a
 * cutting wall grazes a long thin face), and a repeated copy facing the same way is kept once. Either one leaves every edge it
 * touches matched twice and the solid looking open.
 */
function cancelCoincidentTriangles(triangles: Triangle[]): Triangle[] {
  const groups = new Map<string, Triangle[]>();
  for (const triangle of triangles) {
    const key = [triangle.a, triangle.b, triangle.c].sort((x, y) => x - y).join(",");
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [triangle]); else group.push(triangle);
  }
  if (groups.size === triangles.length) return triangles;
  const kept: Triangle[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) { kept.push(group[0]!); continue; }
    // The winding of each copy relative to the first: an even permutation of the vertices faces the same way.
    const first = group[0]!;
    const same = (other: Triangle): boolean => {
      const corners = [first.a, first.b, first.c];
      const at = corners.indexOf(other.a);
      return corners[(at + 1) % 3] === other.b;
    };
    const facing = group.filter(same);
    const against = group.length - facing.length;
    const net = facing.length - against;
    if (net > 0) kept.push(first);
    else if (net < 0) kept.push(group.find((triangle) => !same(triangle))!);
  }
  return kept;
}

function triangleArea(positions: readonly V3[], triangle: Triangle): number {
  const p = positions[triangle.a]!; const q = positions[triangle.b]!; const r = positions[triangle.c]!;
  const ux = q[0] - p[0]; const uy = q[1] - p[1]; const uz = q[2] - p[2];
  const vx = r[0] - p[0]; const vy = r[1] - p[1]; const vz = r[2] - p[2];
  return 0.5 * Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx);
}

/**
 * A vertex that lies on the interior of another triangle's edge leaves that edge unmatched. Such a triangle
 * is rebuilt as a star around its centroid that includes every boundary point, which keeps all triangles
 * non-degenerate and makes the shared edges match.
 */
function splitTJunctions(positions: readonly V3[], triangles: readonly Triangle[]): { triangles: Triangle[]; changed: boolean } {
  const directed = new Map<string, number>();
  for (const { a, b, c } of triangles) for (const [from, to] of [[a, b], [b, c], [c, a]] as const) directed.set(`${from},${to}`, (directed.get(`${from},${to}`) ?? 0) + 1);
  const unmatched = (from: number, to: number): boolean => directed.get(`${to},${from}`) !== 1 || directed.get(`${from},${to}`) !== 1;
  const boundaryVertices = new Set<number>();
  for (const { a, b, c } of triangles) {
    for (const [from, to] of [[a, b], [b, c], [c, a]] as const) if (unmatched(from, to)) { boundaryVertices.add(from); boundaryVertices.add(to); }
  }
  if (boundaryVertices.size === 0) return { triangles: [...triangles], changed: false };
  const sorted = [...boundaryVertices].sort((left, right) => positions[left]![0] - positions[right]![0]);
  const lowerBound = (x: number): number => {
    let low = 0;
    let high = sorted.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (positions[sorted[mid]!]![0] < x) low = mid + 1;
      else high = mid;
    }
    return low;
  };

  let changed = false;
  const output: Triangle[] = [];
  for (const triangle of triangles) {
    const corners = [triangle.a, triangle.b, triangle.c];
    const ring: number[] = [];
    let inserted = false;
    for (let corner = 0; corner < 3; corner += 1) {
      const from = corners[corner]!;
      const to = corners[(corner + 1) % 3]!;
      ring.push(from);
      if (!unmatched(from, to)) continue;
      const p = positions[from]!; const q = positions[to]!;
      const extras: { id: number; t: number }[] = [];
      const length2 = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2 + (q[2] - p[2]) ** 2;
      for (let at = lowerBound(Math.min(p[0], q[0]) - 2 * WELD_QUANTUM); at < sorted.length; at += 1) {
        const candidate = sorted[at]!;
        const point = positions[candidate]!;
        if (point[0] > Math.max(p[0], q[0]) + 2 * WELD_QUANTUM) break;
        if (candidate === from || candidate === to) continue;
        const t = ((point[0] - p[0]) * (q[0] - p[0]) + (point[1] - p[1]) * (q[1] - p[1]) + (point[2] - p[2]) * (q[2] - p[2])) / length2;
        if (t <= 1e-9 || t >= 1 - 1e-9) continue;
        const dx = p[0] + (q[0] - p[0]) * t - point[0];
        const dy = p[1] + (q[1] - p[1]) * t - point[1];
        const dz = p[2] + (q[2] - p[2]) * t - point[2];
        if (Math.hypot(dx, dy, dz) <= 4 * WELD_QUANTUM) extras.push({ id: candidate, t });
      }
      extras.sort((left, right) => left.t - right.t);
      for (const extra of extras) { ring.push(extra.id); inserted = true; }
    }
    if (!inserted) { output.push(triangle); continue; }
    changed = true;
    const center: V3 = [0, 1, 2].map((axis) => (positions[triangle.a]![axis]! + positions[triangle.b]![axis]! + positions[triangle.c]![axis]!) / 3) as V3;
    (positions as V3[]).push(center);
    const centerId = positions.length - 1;
    for (let index = 0; index < ring.length; index += 1) {
      output.push({ a: centerId, b: ring[index]!, c: ring[(index + 1) % ring.length]!, source: triangle.source, face: triangle.face });
    }
  }
  return { triangles: output, changed };
}
