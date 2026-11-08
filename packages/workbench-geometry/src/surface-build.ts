import { triangulateLoops } from "../../occt-kernel-adapter/src/polygon.js";

/**
 * The surface layer: open triangle-mesh surfaces built from curves, and the operations on them (extend, trim, stitch into a solid).
 * Everything here is a tessellation, not a NURBS or B-rep surface: a surface is a triangle mesh that samples the shape, boundaries
 * are polylines, and "smooth" means the sampled shape is smooth to the tessellation's resolution. Curves are polylines of 3D points
 * in millimetres.
 */
export type Curve3 = readonly (readonly [number, number, number])[];
type Vec3 = readonly [number, number, number];

export interface SurfaceMesh {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
}

export type SurfaceResult =
  | { readonly ok: true; readonly mesh: SurfaceMesh }
  | { readonly ok: false; readonly message: string };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const finite = (point: Vec3): boolean => point.every(Number.isFinite);

export const MAX_SURFACE_SAMPLES = 400;

/** Evenly spaced points along a polyline by arc length, including both ends. */
export function resampleCurve(curve: Curve3, count: number): Vec3[] {
  const points: Vec3[] = [];
  const cumulative = [0];
  for (let i = 1; i < curve.length; i += 1) cumulative.push(cumulative[i - 1]! + length(sub(curve[i]!, curve[i - 1]!)));
  const total = cumulative[cumulative.length - 1]!;
  if (curve.length < 2 || !(total > 1e-9)) return curve.length === 0 ? [] : Array.from({ length: count }, () => curve[0]!);
  let segment = 0;
  for (let i = 0; i < count; i += 1) {
    const target = (total * i) / (count - 1);
    while (segment < curve.length - 2 && cumulative[segment + 1]! < target) segment += 1;
    const span = cumulative[segment + 1]! - cumulative[segment]!;
    points.push(span < 1e-12 ? curve[segment]! : lerp(curve[segment]!, curve[segment + 1]!, (target - cumulative[segment]!) / span));
  }
  points[0] = curve[0]!;
  points[count - 1] = curve[curve.length - 1]!;
  return points;
}

function checkCurve(curve: Curve3, label: string): string | undefined {
  if (curve.length < 2) return `${label} needs at least two points.`;
  if (!curve.every(finite)) return `${label} has a point that is not finite.`;
  let total = 0;
  for (let i = 1; i < curve.length; i += 1) total += length(sub(curve[i]!, curve[i - 1]!));
  return total > 1e-6 ? undefined : `${label} has no length.`;
}

function gridMesh(grid: readonly (readonly Vec3[])[]): SurfaceMesh {
  const rows = grid.length;
  const columns = grid[0]!.length;
  const positions: number[] = [];
  for (const row of grid) for (const point of row) positions.push(point[0], point[1], point[2]);
  const indices: number[] = [];
  for (let r = 0; r + 1 < rows; r += 1) {
    for (let c = 0; c + 1 < columns; c += 1) {
      const a = r * columns + c;
      const b = a + 1;
      const d = a + columns;
      const e = d + 1;
      indices.push(a, b, e, a, e, d);
    }
  }
  return { positionsMm: positions, indices };
}

/** A ruled surface: straight lines joining the matching points of two curves. */
export function ruledSurface(first: Curve3, second: Curve3, options: { readonly samples?: number; readonly rows?: number } = {}): SurfaceResult {
  const problem = checkCurve(first, "The first curve") ?? checkCurve(second, "The second curve");
  if (problem !== undefined) return { ok: false, message: problem };
  const samples = options.samples ?? 24;
  const rows = options.rows ?? 8;
  if (!Number.isInteger(samples) || samples < 2 || samples > MAX_SURFACE_SAMPLES || !Number.isInteger(rows) || rows < 1 || rows > MAX_SURFACE_SAMPLES) return { ok: false, message: `A ruled surface needs 2 to ${MAX_SURFACE_SAMPLES} samples and rows.` };
  const a = resampleCurve(first, samples);
  const b = resampleCurve(second, samples);
  const grid = Array.from({ length: rows + 1 }, (_, row) => a.map((point, i) => lerp(point, b[i]!, row / rows)));
  return { ok: true, mesh: gridMesh(grid) };
}

export interface LoftOptions {
  readonly samples?: number;
  /** Rows between each pair of neighbouring sections. */
  readonly rows?: number;
  /** Direction the surface leaves the first / arrives at the last section, as a vector scaled by the section spacing; absent means no tangent condition. */
  readonly startTangent?: Vec3;
  readonly endTangent?: Vec3;
}

/**
 * A loft surface through two or more section curves. Two sections give a cubic (Hermite) blend whose ends can be given a direction,
 * so the surface can leave a neighbour tangentially; with no direction it is the ruled surface. Three or more are passed through by a
 * Catmull-Rom spline along each sample line, which is smooth (C1) through every section.
 */
export function loftSurface(sections: readonly Curve3[], options: LoftOptions = {}): SurfaceResult {
  if (sections.length < 2) return { ok: false, message: "A loft needs at least two curves." };
  for (const [index, section] of sections.entries()) {
    const problem = checkCurve(section, `Curve ${index + 1}`);
    if (problem !== undefined) return { ok: false, message: problem };
  }
  const samples = options.samples ?? 24;
  const rows = options.rows ?? 8;
  if (!Number.isInteger(samples) || samples < 2 || samples > MAX_SURFACE_SAMPLES || !Number.isInteger(rows) || rows < 1 || rows > 100) return { ok: false, message: "A loft needs 2 to 400 samples and 1 to 100 rows per span." };
  const lines = sections.map((section) => resampleCurve(section, samples));
  const grid: Vec3[][] = [];
  const spans = sections.length - 1;
  for (let span = 0; span < spans; span += 1) {
    for (let step = span === 0 ? 0 : 1; step <= rows; step += 1) {
      const t = step / rows;
      grid.push(lines[0]!.map((_, i) => {
        const p1 = lines[span]![i]!;
        const p2 = lines[span + 1]![i]!;
        // Tangents at each end of the span: Catmull-Rom from the neighbours, or the given end direction, or the chord.
        const chord = sub(p2, p1);
        const before = span > 0 ? scale(sub(p2, lines[span - 1]![i]!), 0.5) : options.startTangent !== undefined ? options.startTangent : chord;
        const after = span + 2 < sections.length ? scale(sub(lines[span + 2]![i]!, p1), 0.5) : options.endTangent !== undefined ? options.endTangent : chord;
        const h00 = 2 * t ** 3 - 3 * t ** 2 + 1;
        const h10 = t ** 3 - 2 * t ** 2 + t;
        const h01 = -2 * t ** 3 + 3 * t ** 2;
        const h11 = t ** 3 - t ** 2;
        return add(add(scale(p1, h00), scale(before, h10)), add(scale(p2, h01), scale(after, h11)));
      }));
    }
  }
  return { ok: true, mesh: gridMesh(grid) };
}

// ---------------------------------------------------------------------------------------------
// Boundary patch
// ---------------------------------------------------------------------------------------------

/** Orders edge curves end to end and reverses them as needed so each starts where the last ended; a message if they do not close up. */
export function orderEdges(edges: readonly Curve3[], toleranceMm = 1e-3): Vec3[][] | string {
  if (edges.length === 0) return "A patch needs at least one edge.";
  for (const [index, edge] of edges.entries()) {
    const problem = checkCurve(edge, `Edge ${index + 1}`);
    if (problem !== undefined) return problem;
  }
  const remaining = edges.map((edge) => [...edge] as Vec3[]);
  const ordered: Vec3[][] = [remaining.shift()!];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1]!;
    const tail = last[last.length - 1]!;
    let found = -1;
    let reversed = false;
    let best = Infinity;
    for (const [index, edge] of remaining.entries()) {
      const toStart = length(sub(edge[0]!, tail));
      const toEnd = length(sub(edge[edge.length - 1]!, tail));
      if (toStart < best) { best = toStart; found = index; reversed = false; }
      if (toEnd < best) { best = toEnd; found = index; reversed = true; }
    }
    if (found < 0 || best > toleranceMm) return `The edges do not join up: the gap after edge ${edges.length - remaining.length} is ${best.toFixed(3)} mm.`;
    const next = remaining.splice(found, 1)[0]!;
    if (reversed) next.reverse();
    ordered.push(next);
  }
  const closure = length(sub(ordered[0]![0]!, ordered[ordered.length - 1]![ordered[ordered.length - 1]!.length - 1]!));
  if (closure > toleranceMm) return `The edges do not form a closed loop: the ends are ${closure.toFixed(3)} mm apart.`;
  return ordered;
}

/** Newell's best-fit normal of a closed loop of points (its length is twice the loop's area). */
export function loopNormal(loop: readonly Vec3[]): Vec3 {
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i]!;
    const b = loop[(i + 1) % loop.length]!;
    x += (a[1] - b[1]) * (a[2] + b[2]);
    y += (a[2] - b[2]) * (a[0] + b[0]);
    z += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [x, y, z];
}

export interface PatchOptions {
  /** Points each edge is sampled at (corners included); default 16. */
  readonly samplesPerEdge?: number;
  /** Interior triangle edge length to refine to, in mm; default 1.3 times the average boundary segment. */
  readonly targetEdgeMm?: number;
}

/**
 * Fills a closed loop of edges with a patch. The loop is sampled and triangulated over its best-fit plane, the triangulation is
 * refined and flipped towards Delaunay, and the interior vertices are then moved off the plane so the height above it is the
 * harmonic (membrane) interpolation of the loop's heights: a soap film stretched across the edges, exact for any shape that is itself
 * harmonic over the plane (a plane, a saddle z = x y, a quadric u^2 - v^2). The patch meets its edges exactly (G0); it is not
 * tangent to the surfaces next to them.
 */
export function boundaryPatch(edges: readonly Curve3[], options: PatchOptions = {}): SurfaceResult {
  const samplesPerEdge = options.samplesPerEdge ?? 16;
  if (!Number.isInteger(samplesPerEdge) || samplesPerEdge < 2 || samplesPerEdge > 200) return { ok: false, message: "A patch needs 2 to 200 samples per edge." };
  const ordered = orderEdges(edges);
  if (typeof ordered === "string") return { ok: false, message: ordered };
  // Sample each edge separately so the corners stay exact, then join them into one loop.
  const loop: Vec3[] = [];
  let tailPoint: Vec3 | undefined;
  for (const edge of ordered) {
    const sampled = resampleCurve(edge, samplesPerEdge);
    loop.push(...(tailPoint === undefined ? sampled : sampled.slice(1)));
    tailPoint = sampled[sampled.length - 1];
  }
  if (length(sub(loop[0]!, loop[loop.length - 1]!)) < 1e-3) loop.pop();
  if (loop.length < 3) return { ok: false, message: "The loop has too few points to fill." };
  const normalRaw = loopNormal(loop);
  const normalLength = length(normalRaw);
  if (!(normalLength > 1e-9)) return { ok: false, message: "The loop encloses no area, so there is nothing to fill." };
  const normal = scale(normalRaw, 1 / normalLength);
  const helper: Vec3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1raw = cross(helper, normal);
  const e1 = scale(e1raw, 1 / length(e1raw));
  const e2 = cross(normal, e1);
  const origin = loop.reduce<Vec3>((sum, point) => add(sum, scale(point, 1 / loop.length)), [0, 0, 0]);
  const uv = (point: Vec3): [number, number] => { const d = sub(point, origin); return [dot(d, e1), dot(d, e2)]; };
  const boundaryUV = loop.map(uv);
  const boundaryHeight = loop.map((point) => dot(sub(point, origin), normal));

  let triangles: readonly number[];
  try { triangles = triangulateLoops(boundaryUV); } catch (error) { return { ok: false, message: `The loop cannot be filled: ${error instanceof Error ? error.message : "it crosses itself."}` }; }
  const vertices: [number, number][] = boundaryUV.map((p) => [p[0], p[1]]);
  const heights: number[] = [...boundaryHeight];
  const boundaryCount = loop.length;
  let perimeter = 0;
  for (let i = 0; i < boundaryCount; i += 1) perimeter += Math.hypot(boundaryUV[i]![0] - boundaryUV[(i + 1) % boundaryCount]![0], boundaryUV[i]![1] - boundaryUV[(i + 1) % boundaryCount]![1]);
  const target = options.targetEdgeMm ?? (perimeter / boundaryCount) * 1.3;
  if (!(target > 0)) return { ok: false, message: "The target edge length must be positive." };
  const tris: [number, number, number][] = [];
  for (let i = 0; i + 2 < triangles.length; i += 3) tris.push([triangles[i]!, triangles[i + 1]!, triangles[i + 2]!]);
  const onBoundary = refine(vertices, heights, tris, target);

  // Harmonic heights: interior vertices relax to the cotangent-weighted mean of their neighbours (conjugate gradients).
  const interior = vertices.map((_, i) => i).filter((i) => i >= boundaryCount && !onBoundary.has(i));
  const weights = new Map<string, number>();
  const edgeKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
  const cot = (p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]): number => {
    const ux = q[0] - p[0]; const uy = q[1] - p[1]; const vx = r[0] - p[0]; const vy = r[1] - p[1];
    const crossValue = Math.abs(ux * vy - uy * vx);
    return crossValue < 1e-14 ? 0 : (ux * vx + uy * vy) / crossValue;
  };
  for (const [a, b, c] of tris) {
    for (const [p, q, r] of [[a, b, c], [b, c, a], [c, a, b]] as const) {
      // The angle at r is opposite edge p-q.
      weights.set(edgeKey(p, q), (weights.get(edgeKey(p, q)) ?? 0) + 0.5 * cot(vertices[r]!, vertices[p]!, vertices[q]!));
    }
  }
  const neighbours = new Map<number, number[]>();
  for (const key of weights.keys()) {
    const [a, b] = key.split(",").map(Number) as [number, number];
    if (!neighbours.has(a)) neighbours.set(a, []);
    if (!neighbours.has(b)) neighbours.set(b, []);
    neighbours.get(a)!.push(b);
    neighbours.get(b)!.push(a);
  }
  const weightOf = (a: number, b: number): number => Math.max(weights.get(edgeKey(a, b)) ?? 0, 1e-9);
  const slot = new Map<number, number>(interior.map((vertex, index) => [vertex, index]));
  const apply = (x: readonly number[]): number[] => interior.map((vertex, row) => {
    let value = 0;
    for (const other of neighbours.get(vertex) ?? []) {
      const w = weightOf(vertex, other);
      value += w * (x[row]! - (slot.has(other) ? x[slot.get(other)!]! : 0));
    }
    return value;
  });
  const rhs = interior.map((vertex) => {
    let value = 0;
    for (const other of neighbours.get(vertex) ?? []) if (!slot.has(other)) value += weightOf(vertex, other) * heights[other]!;
    return value;
  });
  let x = interior.map((vertex) => heights[vertex]!);
  if (interior.length > 0) {
    const start = apply(x);
    let residual = rhs.map((value, i) => value - start[i]!);
    let direction = residual.slice();
    let rs = residual.reduce((sum, value) => sum + value * value, 0);
    const stop = 1e-20 * Math.max(1, rhs.reduce((sum, value) => sum + value * value, 0));
    for (let iteration = 0; iteration < 4 * interior.length + 50 && rs > stop; iteration += 1) {
      const Ap = apply(direction);
      const alpha = rs / Math.max(1e-300, direction.reduce((sum, value, i) => sum + value * Ap[i]!, 0));
      x = x.map((value, i) => value + alpha * direction[i]!);
      residual = residual.map((value, i) => value - alpha * Ap[i]!);
      const next = residual.reduce((sum, value) => sum + value * value, 0);
      direction = residual.map((value, i) => value + (next / rs) * direction[i]!);
      rs = next;
    }
  }
  interior.forEach((vertex, i) => { heights[vertex] = x[i]!; });
  const positions: number[] = [];
  vertices.forEach(([u, v], i) => {
    const point = add(add(add(origin, scale(e1, u)), scale(e2, v)), scale(normal, heights[i]!));
    positions.push(point[0], point[1], point[2]);
  });
  // The boundary vertices that came from the loop keep their exact 3D position.
  loop.forEach((point, i) => { positions[i * 3] = point[0]; positions[i * 3 + 1] = point[1]; positions[i * 3 + 2] = point[2]; });
  const indices = tris.flat();
  return { ok: true, mesh: { positionsMm: positions, indices } };
}

/** Splits every interior and boundary edge longer than `target` and flips edges towards Delaunay, in the plane. */
function refine(vertices: [number, number][], heights: number[], tris: [number, number, number][], target: number): Set<number> {
  const onBoundary = new Set<number>();
  const edgeKey = (a: number, b: number): string => (a < b ? `${a},${b}` : `${b},${a}`);
  const edgeLength = (a: number, b: number): number => Math.hypot(vertices[a]![0] - vertices[b]![0], vertices[a]![1] - vertices[b]![1]);
  for (let pass = 0; pass < 400; pass += 1) {
    let longest = -1;
    let longestEdge: [number, number] | undefined;
    for (const [a, b, c] of tris) {
      for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
        const l = edgeLength(p, q);
        if (l > target && l > longest) { longest = l; longestEdge = [p, q]; }
      }
    }
    if (longestEdge === undefined) break;
    const [p, q] = longestEdge;
    const mid = vertices.length;
    vertices.push([(vertices[p]![0] + vertices[q]![0]) / 2, (vertices[p]![1] + vertices[q]![1]) / 2]);
    heights.push((heights[p]! + heights[q]!) / 2);
    const key = edgeKey(p, q);
    let sharing = 0;
    for (const [a, b, c] of tris) if (edgeKey(a, b) === key || edgeKey(b, c) === key || edgeKey(c, a) === key) sharing += 1;
    // A vertex added on an edge with only one triangle lies on the loop itself and stays fixed.
    if (sharing === 1) onBoundary.add(mid);
    const next: [number, number, number][] = [];
    for (const triangle of tris) {
      const [a, b, c] = triangle;
      let split = false;
      for (const [x, y, z] of [[a, b, c], [b, c, a], [c, a, b]] as const) {
        if (edgeKey(x, y) === key) { next.push([x, mid, z], [mid, y, z]); split = true; break; }
      }
      if (!split) next.push(triangle);
    }
    tris.length = 0;
    tris.push(...next);
    // Flip edges that fail the Delaunay test around the new vertex (a few sweeps are enough to keep the mesh well shaped).
    for (let sweep = 0; sweep < 3; sweep += 1) {
      if (!flipPass(vertices, tris)) break;
    }
  }
  return onBoundary;
}

function flipPass(vertices: readonly (readonly [number, number])[], tris: [number, number, number][]): boolean {
  const owner = new Map<string, number>();
  tris.forEach(([a, b, c], t) => { owner.set(`${a}>${b}`, t); owner.set(`${b}>${c}`, t); owner.set(`${c}>${a}`, t); });
  const angleAt = (p: number, q: number, r: number): number => {
    const ux = vertices[q]![0] - vertices[p]![0]; const uy = vertices[q]![1] - vertices[p]![1];
    const vx = vertices[r]![0] - vertices[p]![0]; const vy = vertices[r]![1] - vertices[p]![1];
    return Math.atan2(Math.abs(ux * vy - uy * vx), ux * vx + uy * vy);
  };
  const orient = (a: number, b: number, c: number): number => (vertices[b]![0] - vertices[a]![0]) * (vertices[c]![1] - vertices[a]![1]) - (vertices[b]![1] - vertices[a]![1]) * (vertices[c]![0] - vertices[a]![0]);
  let flipped = false;
  const done = new Set<number>();
  for (let t = 0; t < tris.length; t += 1) {
    if (done.has(t)) continue;
    const [a, b, c] = tris[t]!;
    for (const [p, q, r] of [[a, b, c], [b, c, a], [c, a, b]] as const) {
      const other = owner.get(`${q}>${p}`);
      if (other === undefined || other === t || done.has(other)) continue;
      const s = tris[other]!.find((vertex) => vertex !== p && vertex !== q)!;
      if (angleAt(r, p, q) + angleAt(s, q, p) <= Math.PI + 1e-9) continue;
      // The quad p, s, q, r (counter-clockwise) swaps its diagonal p-q for r-s when it stays convex.
      if (orient(r, p, s) <= 1e-12 || orient(r, s, q) <= 1e-12) continue;
      tris[t] = [r, p, s];
      tris[other] = [r, s, q];
      done.add(t); done.add(other);
      flipped = true;
      break;
    }
  }
  return flipped;
}

// ---------------------------------------------------------------------------------------------
// Mesh queries
// ---------------------------------------------------------------------------------------------

/** The area of a triangle mesh. */
export function surfaceArea(mesh: SurfaceMesh): number {
  let total = 0;
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const a = at(mesh, mesh.indices[i]!);
    total += 0.5 * length(cross(sub(at(mesh, mesh.indices[i + 1]!), a), sub(at(mesh, mesh.indices[i + 2]!), a)));
  }
  return total;
}

function at(mesh: SurfaceMesh, index: number): Vec3 {
  return [mesh.positionsMm[index * 3]!, mesh.positionsMm[index * 3 + 1]!, mesh.positionsMm[index * 3 + 2]!];
}

/** The open boundary of a mesh as closed loops of vertex indices, longest first; a closed mesh has none. */
export function boundaryLoops(mesh: SurfaceMesh): number[][] {
  const directed = new Map<string, number>();
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    for (let side = 0; side < 3; side += 1) directed.set(`${mesh.indices[i + side]}>${mesh.indices[i + (side + 1) % 3]}`, 1);
  }
  const next = new Map<number, number[]>();
  for (const key of directed.keys()) {
    const [from, to] = key.split(">").map(Number) as [number, number];
    if (directed.has(`${to}>${from}`)) continue;
    if (!next.has(from)) next.set(from, []);
    next.get(from)!.push(to);
  }
  const loops: number[][] = [];
  for (const start of [...next.keys()]) {
    while ((next.get(start)?.length ?? 0) > 0) {
      const loop = [start];
      let current = next.get(start)!.pop()!;
      let guard = 0;
      while (current !== start && guard++ < 1_000_000) {
        loop.push(current);
        const options = next.get(current);
        if (options === undefined || options.length === 0) break;
        current = options.pop()!;
      }
      loops.push(loop);
    }
  }
  return loops.sort((a, b) => b.length - a.length);
}

// ---------------------------------------------------------------------------------------------
// Extend
// ---------------------------------------------------------------------------------------------

export interface ExtendOptions {
  readonly distanceMm: number;
  /** Which open boundary loop to extend, as listed by `boundaryLoops` (longest first); or the loop nearest this point. */
  readonly loopIndex?: number;
  readonly nearPointMm?: Vec3;
  /** With `nearPointMm`: extend only the part of the edge within this distance of the point (otherwise the whole edge is extended). */
  readonly windowMm?: number;
  /** How many rings the extension is built in; default 4. */
  readonly rings?: number;
}

/**
 * Extends a surface past one of its open edges, continuing the surface the way it was heading: every edge vertex moves out along the
 * direction from the surface just inside it, so the extension leaves the edge tangentially (G1) and straight on. The extension is
 * added to the mesh as new rings of triangles welded to the edge.
 */
export function extendSurface(mesh: SurfaceMesh, options: ExtendOptions): SurfaceResult {
  if (!(options.distanceMm > 0) || !Number.isFinite(options.distanceMm)) return { ok: false, message: "Extend needs a distance above zero." };
  const loops = boundaryLoops(mesh);
  if (loops.length === 0) return { ok: false, message: "This surface is closed: it has no open edge to extend." };
  let loopIndex = options.loopIndex ?? 0;
  if (options.nearPointMm !== undefined) {
    let best = Infinity;
    loops.forEach((loop, index) => {
      for (const vertex of loop) {
        const distance = length(sub(at(mesh, vertex), options.nearPointMm!));
        if (distance < best) { best = distance; loopIndex = index; }
      }
    });
  }
  const loop = loops[loopIndex];
  if (loop === undefined) return { ok: false, message: `The surface has ${loops.length} open edge${loops.length === 1 ? "" : "s"}; there is no edge ${loopIndex}.` };
  const rings = options.rings ?? 4;
  if (!Number.isInteger(rings) || rings < 1 || rings > 50) return { ok: false, message: "Extend needs 1 to 50 rings." };
  const onLoop = new Set(loop);
  // Direction out of the surface at each edge vertex: from the average of its inside neighbours to the vertex itself.
  const inside = new Map<number, Vec3[]>();
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const corner = [mesh.indices[i]!, mesh.indices[i + 1]!, mesh.indices[i + 2]!];
    for (const vertex of corner) if (onLoop.has(vertex)) for (const other of corner) if (other !== vertex && !onLoop.has(other)) { if (!inside.has(vertex)) inside.set(vertex, []); inside.get(vertex)!.push(at(mesh, other)); }
  }
  // The edge's own direction at each vertex, so the extension can leave perpendicular to it, within the surface.
  const alongEdge = loop.map((_, i): Vec3 => {
    const chord = sub(at(mesh, loop[(i + 1) % loop.length]!), at(mesh, loop[(i + loop.length - 1) % loop.length]!));
    return length(chord) > 1e-9 ? scale(chord, 1 / length(chord)) : [1, 0, 0];
  });
  const direction = loop.map((vertex, i): Vec3 => {
    const neighbours = inside.get(vertex);
    if (neighbours !== undefined && neighbours.length > 0) {
      const mean = neighbours.reduce<Vec3>((sum, point) => add(sum, scale(point, 1 / neighbours.length)), [0, 0, 0]);
      const out = sub(at(mesh, vertex), mean);
      // Take out the part along the edge: the extension leaves square to the edge, whatever way the mesh is cut.
      const square = sub(out, scale(alongEdge[i]!, dot(out, alongEdge[i]!)));
      if (length(square) > 1e-9) return scale(square, 1 / length(square));
      if (length(out) > 1e-9) return scale(out, 1 / length(out));
    }
    return cross(alongEdge[i]!, [0, 0, 1]);
  });
  const positions = [...mesh.positionsMm];
  const indices = [...mesh.indices];
  const windowed = options.windowMm !== undefined && options.nearPointMm !== undefined;
  const included = loop.map((vertex) => !windowed || length(sub(at(mesh, vertex), options.nearPointMm!)) <= options.windowMm!);
  if (!included.some(Boolean)) return { ok: false, message: "No part of the edge lies inside the chosen window." };
  let previousRing: (number | undefined)[] = loop.map((vertex, i) => (included[i] ? vertex : undefined));
  for (let ring = 1; ring <= rings; ring += 1) {
    const current: (number | undefined)[] = [];
    for (const [i, vertex] of loop.entries()) {
      if (!included[i]) { current.push(undefined); continue; }
      const point = add(at(mesh, vertex), scale(direction[i]!, (options.distanceMm * ring) / rings));
      current.push(positions.length / 3);
      positions.push(point[0], point[1], point[2]);
    }
    for (let i = 0; i < loop.length; i += 1) {
      const j = (i + 1) % loop.length;
      if (previousRing[i] === undefined || previousRing[j] === undefined) continue;
      // The boundary edge runs previous[i] -> previous[j] with the surface on its left; the new strip lies on its right.
      indices.push(previousRing[j]!, previousRing[i]!, current[i]!, previousRing[j]!, current[i]!, current[j]!);
    }
    previousRing = current;
  }
  return { ok: true, mesh: { positionsMm: positions, indices } };
}

// ---------------------------------------------------------------------------------------------
// Trim
// ---------------------------------------------------------------------------------------------

/** Keeps the part of a surface on one side of a plane, cutting triangles exactly along it. */
export function trimSurfaceByPlane(mesh: SurfaceMesh, pointMm: Vec3, normalMm: Vec3, keep: "positive" | "negative"): SurfaceResult {
  const normalLength = length(normalMm);
  if (!(normalLength > 1e-9)) return { ok: false, message: "The trimming plane has no direction." };
  const n = scale(normalMm, (keep === "positive" ? 1 : -1) / normalLength);
  const positions: number[] = [];
  const indices: number[] = [];
  const lookup = new Map<string, number>();
  const idOf = (point: Vec3): number => {
    const key = `${Math.round(point[0] * 1e6)},${Math.round(point[1] * 1e6)},${Math.round(point[2] * 1e6)}`;
    let id = lookup.get(key);
    if (id === undefined) { id = positions.length / 3; lookup.set(key, id); positions.push(point[0], point[1], point[2]); }
    return id;
  };
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const corners = [at(mesh, mesh.indices[i]!), at(mesh, mesh.indices[i + 1]!), at(mesh, mesh.indices[i + 2]!)];
    const side = corners.map((corner) => dot(sub(corner, pointMm), n));
    const polygon: Vec3[] = [];
    for (let k = 0; k < 3; k += 1) {
      const l = (k + 1) % 3;
      if (side[k]! >= 0) polygon.push(corners[k]!);
      if ((side[k]! >= 0) !== (side[l]! >= 0)) polygon.push(lerp(corners[k]!, corners[l]!, side[k]! / (side[k]! - side[l]!)));
    }
    for (let k = 1; k + 1 < polygon.length; k += 1) {
      const a = idOf(polygon[0]!); const b = idOf(polygon[k]!); const c = idOf(polygon[k + 1]!);
      if (a !== b && b !== c && a !== c) indices.push(a, b, c);
    }
  }
  if (indices.length === 0) return { ok: false, message: "The plane leaves none of the surface on that side." };
  if (positions.length === mesh.positionsMm.length && indices.length === mesh.indices.length) return { ok: false, message: "The plane does not cut the surface." };
  return { ok: true, mesh: { positionsMm: positions, indices } };
}

/**
 * Trims a surface by a closed curve projected along `directionMm` onto it: the part of the surface that falls inside the curve (or
 * outside it) is kept. Each triangle is clipped exactly against the triangles the curve's outline is made of, in the plane seen along
 * the direction, so the new edge follows the curve instead of stepping along the mesh.
 */
export function trimSurfaceByLoop(mesh: SurfaceMesh, loop: Curve3, directionMm: Vec3, keep: "inside" | "outside"): SurfaceResult {
  const problem = checkCurve(loop, "The trimming curve");
  if (problem !== undefined) return { ok: false, message: problem };
  const dl = length(directionMm);
  if (!(dl > 1e-9)) return { ok: false, message: "The projection direction has no length." };
  const w = scale(directionMm, 1 / dl);
  const helper: Vec3 = Math.abs(w[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const e1raw = cross(helper, w);
  const e1 = scale(e1raw, 1 / length(e1raw));
  const e2 = cross(w, e1);
  const plane = (point: Vec3): [number, number] => [dot(point, e1), dot(point, e2)];
  let curve = [...loop];
  if (length(sub(curve[0]!, curve[curve.length - 1]!)) < 1e-6) curve.pop();
  if (curve.length < 3) return { ok: false, message: "The trimming curve needs at least three points." };
  const flat = curve.map(plane);
  let clipTriangles: readonly number[];
  try { clipTriangles = triangulateLoops(flat); } catch (error) { return { ok: false, message: `The trimming curve is not a simple closed curve: ${error instanceof Error ? error.message : "it crosses itself."}` }; }
  // Pieces of one surface triangle against the curve's triangles (inside), or against everything else (outside = triangle minus inside).
  const positions: number[] = [];
  const indices: number[] = [];
  const lookup = new Map<string, number>();
  const idOf = (point: Vec3): number => {
    const key = `${Math.round(point[0] * 1e5)},${Math.round(point[1] * 1e5)},${Math.round(point[2] * 1e5)}`;
    let id = lookup.get(key);
    if (id === undefined) { id = positions.length / 3; lookup.set(key, id); positions.push(point[0], point[1], point[2]); }
    return id;
  };
  const area2 = (p: readonly [number, number], q: readonly [number, number], r: readonly [number, number]): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const clipConvex = (subject: readonly (readonly [number, number])[], clip: readonly [readonly [number, number], readonly [number, number], readonly [number, number]]): [number, number][] => {
    const orientation = Math.sign(area2(clip[0], clip[1], clip[2])) || 1;
    let output = subject.map((p): [number, number] => [p[0], p[1]]);
    for (let k = 0; k < 3 && output.length > 0; k += 1) {
      const a = clip[k]!; const b = clip[(k + 1) % 3]!;
      const input = output;
      output = [];
      for (let i = 0; i < input.length; i += 1) {
        const current = input[i]!; const prev = input[(i + input.length - 1) % input.length]!;
        const inCurrent = orientation * area2(a, b, current) >= -1e-12;
        const inPrev = orientation * area2(a, b, prev) >= -1e-12;
        if (inCurrent !== inPrev) {
          const t = area2(a, b, prev) / (area2(a, b, prev) - area2(a, b, current));
          output.push([prev[0] + (current[0] - prev[0]) * t, prev[1] + (current[1] - prev[1]) * t]);
        }
        if (inCurrent) output.push(current);
      }
    }
    return output;
  };
  const lift = (corners: readonly Vec3[], flatCorners: readonly (readonly [number, number])[], point: readonly [number, number]): Vec3 => {
    const d = area2(flatCorners[0]!, flatCorners[1]!, flatCorners[2]!);
    const b0 = area2(point, flatCorners[1]!, flatCorners[2]!) / d;
    const b1 = area2(flatCorners[0]!, point, flatCorners[2]!) / d;
    const b2 = 1 - b0 - b1;
    return add(add(scale(corners[0]!, b0), scale(corners[1]!, b1)), scale(corners[2]!, b2));
  };
  const insideTriangles: ReadonlyArray<readonly [readonly [number, number], readonly [number, number], readonly [number, number]]> = Array.from({ length: clipTriangles.length / 3 }, (_, t) => [flat[clipTriangles[t * 3]!]!, flat[clipTriangles[t * 3 + 1]!]!, flat[clipTriangles[t * 3 + 2]!]!] as const);
  const emit = (corners: readonly Vec3[], flatCorners: readonly (readonly [number, number])[], polygon: readonly (readonly [number, number])[], flipped: boolean): void => {
    if (polygon.length < 3) return;
    const ids = polygon.map((p) => idOf(lift(corners, flatCorners, p)));
    for (let k = 1; k + 1 < ids.length; k += 1) {
      if (ids[0] === ids[k] || ids[k] === ids[k + 1] || ids[0] === ids[k + 1]) continue;
      indices.push(ids[0]!, flipped ? ids[k + 1]! : ids[k]!, flipped ? ids[k]! : ids[k + 1]!);
    }
  };
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const corners = [at(mesh, mesh.indices[i]!), at(mesh, mesh.indices[i + 1]!), at(mesh, mesh.indices[i + 2]!)];
    const flatCorners = corners.map(plane);
    const triangleArea = area2(flatCorners[0]!, flatCorners[1]!, flatCorners[2]!);
    if (Math.abs(triangleArea) < 1e-12) continue;
    // Counter-clockwise in the plane keeps the clip arithmetic simple; remember to flip back.
    const flipped = triangleArea < 0;
    const ccw = flipped ? [flatCorners[0]!, flatCorners[2]!, flatCorners[1]!] : flatCorners;
    const ccw3 = flipped ? [corners[0]!, corners[2]!, corners[1]!] : corners;
    if (keep === "inside") {
      for (const clip of insideTriangles) emit(ccw3, ccw, clipConvex(ccw, clip), flipped);
    } else {
      // Outside = the triangle with the curve's region cut away: clip against the half planes of each curve triangle's complement.
      let pieces: (readonly (readonly [number, number])[])[] = [ccw];
      for (const clip of insideTriangles) {
        const orientation = Math.sign(area2(clip[0], clip[1], clip[2])) || 1;
        const next: (readonly (readonly [number, number])[])[] = [];
        for (const piece of pieces) {
          // Split `piece` into the part outside `clip`: successive slices on the outer side of each clip edge.
          let rest: readonly (readonly [number, number])[] = piece;
          for (let k = 0; k < 3 && rest.length >= 3; k += 1) {
            const a = clip[k]!; const b = clip[(k + 1) % 3]!;
            const outerSide: (readonly [number, number])[] = [];
            const innerSide: (readonly [number, number])[] = [];
            for (let m = 0; m < rest.length; m += 1) {
              const current = rest[m]!; const prev = rest[(m + rest.length - 1) % rest.length]!;
              const sCurrent = orientation * area2(a, b, current);
              const sPrev = orientation * area2(a, b, prev);
              if ((sCurrent >= 0) !== (sPrev >= 0)) {
                const t = sPrev / (sPrev - sCurrent);
                const cutPoint: [number, number] = [prev[0] + (current[0] - prev[0]) * t, prev[1] + (current[1] - prev[1]) * t];
                outerSide.push(cutPoint); innerSide.push(cutPoint);
              }
              (sCurrent >= 0 ? innerSide : outerSide).push(current);
            }
            if (outerSide.length >= 3) next.push(outerSide);
            rest = innerSide;
          }
        }
        pieces = next;
      }
      for (const piece of pieces) emit(ccw3, ccw, piece, flipped);
    }
  }
  if (indices.length === 0) return { ok: false, message: keep === "inside" ? "None of the surface lies inside the curve." : "The curve covers all of the surface." };
  return { ok: true, mesh: { positionsMm: positions, indices } };
}

// ---------------------------------------------------------------------------------------------
// Stitch
// ---------------------------------------------------------------------------------------------

export type StitchResult =
  | { readonly ok: true; readonly mesh: SurfaceMesh; readonly volumeMm3: number }
  | { readonly ok: false; readonly message: string; readonly openEdges: number };

/**
 * Sews surfaces together into one: vertices closer than the tolerance are merged, boundary vertices that lie on another surface's
 * edge are inserted into it, and triangle winding is made consistent. If the surfaces then enclose a volume (every edge shared by
 * exactly two triangles) the result is a closed solid pointing outward; otherwise the number of open edges is reported and nothing
 * is made.
 */
export function stitchSurfaces(surfaces: readonly SurfaceMesh[], toleranceMm = 0.01): StitchResult {
  if (surfaces.length === 0) return { ok: false, message: "Stitch needs at least one surface.", openEdges: 0 };
  const positions: number[] = [];
  const cell = Math.max(toleranceMm, 1e-6);
  const grid = new Map<string, number[]>();
  const weld = (point: Vec3): number => {
    const cx = Math.floor(point[0] / cell); const cy = Math.floor(point[1] / cell); const cz = Math.floor(point[2] / cell);
    for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) for (let dz = -1; dz <= 1; dz += 1) {
      for (const candidate of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        if (length(sub([positions[candidate * 3]!, positions[candidate * 3 + 1]!, positions[candidate * 3 + 2]!], point)) <= toleranceMm) return candidate;
      }
    }
    const id = positions.length / 3;
    positions.push(point[0], point[1], point[2]);
    const key = `${cx},${cy},${cz}`;
    if (!grid.has(key)) grid.set(key, []);
    grid.get(key)!.push(id);
    return id;
  };
  let triangles: [number, number, number][] = [];
  for (const surface of surfaces) {
    for (let i = 0; i + 2 < surface.indices.length; i += 3) {
      const a = weld(at(surface, surface.indices[i]!)); const b = weld(at(surface, surface.indices[i + 1]!)); const c = weld(at(surface, surface.indices[i + 2]!));
      if (a !== b && b !== c && a !== c) triangles.push([a, b, c]);
    }
  }
  const pointOf = (id: number): Vec3 => [positions[id * 3]!, positions[id * 3 + 1]!, positions[id * 3 + 2]!];
  // Boundary vertices that sit on another triangle's boundary edge split that edge (a T-junction between surfaces sampled differently).
  for (let pass = 0; pass < 8; pass += 1) {
    const undirected = new Map<string, number>();
    for (const [a, b, c] of triangles) for (const [p, q] of [[a, b], [b, c], [c, a]] as const) undirected.set(p < q ? `${p},${q}` : `${q},${p}`, (undirected.get(p < q ? `${p},${q}` : `${q},${p}`) ?? 0) + 1);
    const boundaryVertices = new Set<number>();
    for (const [key, count] of undirected) if (count === 1) { const [p, q] = key.split(",").map(Number) as [number, number]; boundaryVertices.add(p); boundaryVertices.add(q); }
    if (boundaryVertices.size === 0) break;
    let changed = false;
    const next: [number, number, number][] = [];
    for (const triangle of triangles) {
      const pending: [number, number, number][] = [triangle];
      while (pending.length > 0) {
        const piece = pending.pop()!;
        let split = false;
        for (let side = 0; side < 3 && !split; side += 1) {
          const p = piece[side]!; const q = piece[(side + 1) % 3]!; const apex = piece[(side + 2) % 3]!;
          if ((undirected.get(p < q ? `${p},${q}` : `${q},${p}`) ?? 0) !== 1) continue;
          const a = pointOf(p); const b = pointOf(q);
          const ab = sub(b, a); const abLength2 = dot(ab, ab);
          const onEdge: { id: number; t: number }[] = [];
          for (const candidate of boundaryVertices) {
            if (candidate === p || candidate === q) continue;
            const t = dot(sub(pointOf(candidate), a), ab) / abLength2;
            if (t <= 1e-6 || t >= 1 - 1e-6) continue;
            if (length(sub(pointOf(candidate), lerp(a, b, t))) <= toleranceMm) onEdge.push({ id: candidate, t });
          }
          if (onEdge.length === 0) continue;
          onEdge.sort((left, right) => left.t - right.t);
          const chain = [p, ...onEdge.map((entry) => entry.id), q];
          for (let k = 0; k + 1 < chain.length; k += 1) pending.push([chain[k]!, chain[k + 1]!, apex]);
          split = true;
          changed = true;
        }
        if (!split) next.push(piece);
      }
    }
    triangles = next;
    if (!changed) break;
  }
  // Every edge must be shared by exactly two triangles.
  const undirected = new Map<string, number>();
  for (const [a, b, c] of triangles) for (const [p, q] of [[a, b], [b, c], [c, a]] as const) undirected.set(p < q ? `${p},${q}` : `${q},${p}`, (undirected.get(p < q ? `${p},${q}` : `${q},${p}`) ?? 0) + 1);
  const openEdges = [...undirected.values()].filter((count) => count !== 2).length;
  if (openEdges > 0) return { ok: false, message: `The surfaces do not close up: ${openEdges} edge${openEdges === 1 ? " is" : "s are"} not shared by exactly two faces, so they do not enclose a volume.`, openEdges };
  // Make the winding consistent by walking across shared edges, then point it outward.
  const owner = new Map<string, number[]>();
  triangles.forEach(([a, b, c], t) => { for (const [p, q] of [[a, b], [b, c], [c, a]] as const) { const key = p < q ? `${p},${q}` : `${q},${p}`; if (!owner.has(key)) owner.set(key, []); owner.get(key)!.push(t); } });
  const visited = new Array<boolean>(triangles.length).fill(false);
  for (let seed = 0; seed < triangles.length; seed += 1) {
    if (visited[seed]) continue;
    visited[seed] = true;
    const stack = [seed];
    while (stack.length > 0) {
      const t = stack.pop()!;
      const [a, b, c] = triangles[t]!;
      for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
        for (const other of owner.get(p < q ? `${p},${q}` : `${q},${p}`) ?? []) {
          if (other === t || visited[other]) continue;
          const [x, y, z] = triangles[other]!;
          // A consistently wound neighbour traverses the shared edge in the opposite direction (q -> p).
          const sameDirection = [[x, y], [y, z], [z, x]].some(([from, to]) => from === p && to === q);
          if (sameDirection) triangles[other] = [x, z, y];
          visited[other] = true;
          stack.push(other);
        }
      }
    }
  }
  let volume = 0;
  for (const [a, b, c] of triangles) volume += dot(pointOf(a), cross(pointOf(b), pointOf(c))) / 6;
  if (volume < 0) { triangles = triangles.map(([a, b, c]) => [a, c, b] as [number, number, number]); volume = -volume; }
  if (!(volume > 1e-9)) return { ok: false, message: "The stitched surfaces enclose no volume.", openEdges: 0 };
  return { ok: true, mesh: { positionsMm: positions, indices: triangles.flat() }, volumeMm3: volume };
}
