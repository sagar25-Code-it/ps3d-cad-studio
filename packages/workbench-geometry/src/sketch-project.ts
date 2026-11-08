/**
 * Brings solid geometry into a sketch: Project (the edges of a body, seen along the sketch normal), Intersect (where the sketch
 * plane cuts the body), Silhouette (the outline of the body seen along the sketch normal) and Convert (the outline of one face).
 *
 * The solids are meshes, so every result starts as short straight segments. Those are welded, chained into curves and then
 * recognised again as lines, circular arcs, whole circles, ellipses and, for a smooth run that is none of those, splines
 * (see curve-fit.ts). The sketch entities that come out are SNAPSHOTS: they do not follow later edits of the source body.
 */
import type { SketchDatumPlane, SketchEntity } from "../../workbench-core/src/index.js";
import { fitPolyline, type FitPrimitive, type Pt } from "./curve-fit.js";
import { placeDirection, placePoint, type SketchPlacement } from "./sketch-placement.js";

type Vec3 = readonly [number, number, number];

export interface ProjectionMesh {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
}

/** The sketch plane in the world: where its (0, 0) is, its X and Y directions and the normal solids rise along. */
export interface SketchFrame {
  readonly originMm: Vec3;
  readonly uAxis: Vec3;
  readonly vAxis: Vec3;
  readonly normal: Vec3;
}

/** What a sketch needs to say where its plane is: the datum plane, its offset along the normal, and a tilt or a three-point frame. */
export interface SketchFrameSource extends SketchPlacement {
  readonly plane: SketchDatumPlane;
  readonly planeOffsetMm?: number | undefined;
}

/** The datum planes' own axes, matching how the solid builder places a profile (xz sketches face -Y, yz sketches run along -Z). */
const DATUM_AXES: Readonly<Record<SketchDatumPlane, { readonly u: Vec3; readonly v: Vec3; readonly n: Vec3 }>> = {
  "datum:xy": { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  "datum:xz": { u: [1, 0, 0], v: [0, 0, 1], n: [0, -1, 0] },
  "datum:yz": { u: [0, 0, -1], v: [0, 1, 0], n: [1, 0, 0] }
};

/** The world frame of a sketch: its datum plane, moved along the normal by the offset, then tilted or placed on its three-point frame. */
export function sketchFrameOf(sketch: SketchFrameSource): SketchFrame {
  const axes = DATUM_AXES[sketch.plane];
  const offset = sketch.planeOffsetMm ?? 0;
  const placement: SketchPlacement = { planeTilt: sketch.planeTilt, planeFrame: sketch.planeFrame };
  return {
    originMm: placePoint([axes.n[0] * offset, axes.n[1] * offset, axes.n[2] * offset], placement),
    uAxis: placeDirection(axes.u, placement),
    vAxis: placeDirection(axes.v, placement),
    normal: placeDirection(axes.n, placement)
  };
}

/** A world point in the sketch's own terms: its position on the sketch (x, y) and its height above the plane along the normal. */
export function worldToSketch(point: Vec3, frame: SketchFrame): { readonly xy: Pt; readonly heightMm: number } {
  const d: Vec3 = [point[0] - frame.originMm[0], point[1] - frame.originMm[1], point[2] - frame.originMm[2]];
  return {
    xy: [dot(d, frame.uAxis), dot(d, frame.vAxis)],
    heightMm: dot(d, frame.normal)
  };
}

/** The world position of a sketch point, `heightMm` above the plane. */
export function sketchToWorld(xy: Pt, frame: SketchFrame, heightMm = 0): Vec3 {
  return [
    frame.originMm[0] + frame.uAxis[0] * xy[0] + frame.vAxis[0] * xy[1] + frame.normal[0] * heightMm,
    frame.originMm[1] + frame.uAxis[1] * xy[0] + frame.vAxis[1] * xy[1] + frame.normal[1] * heightMm,
    frame.originMm[2] + frame.uAxis[2] * xy[0] + frame.vAxis[2] * xy[1] + frame.normal[2] * heightMm
  ];
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

// ---------------------------------------------------------------------------------------------
// Limits and tolerances
// ---------------------------------------------------------------------------------------------

const MAX_TRIANGLES = 200_000;
const MAX_SILHOUETTE_SEGMENTS = 6000;
/** Mesh vertices closer than this are the same vertex. */
const WELD_MM = 2e-4;
/** Projected points closer than this are the same sketch point (mesh Boolean results carry noise of this size); coordinates are rounded to a micron. */
const SNAP_MM = 1e-4;
const MIN_GEOMETRY_MM = 0.01;
/** An edge whose two faces meet at more than this bends the surface enough to count as an edge to project. */
const DEFAULT_CREASE_DEG = 30;
/** A triangle whose unit normal is within this of perpendicular to the view direction (0.06°) is edge-on; mesh noise tilts walls by about that much. */
const EDGE_ON = 1e-3;

// ---------------------------------------------------------------------------------------------
// Welding points
// ---------------------------------------------------------------------------------------------

/** Merges points that lie within `eps` of each other and hands out stable ids. Coordinates are kept rounded to `round`. */
class Welder {
  readonly points: number[][] = [];
  private readonly cells = new Map<string, number[]>();

  constructor(private readonly dims: 2 | 3, private readonly eps: number, private readonly round: number) {}

  add(coords: readonly number[]): number {
    const cell = coords.slice(0, this.dims).map((value) => Math.floor(value / this.eps));
    const dx = [-1, 0, 1];
    const search = (offsets: readonly number[]): number | undefined => {
      const key = cell.map((value, axis) => value + offsets[axis]!).join(",");
      for (const id of this.cells.get(key) ?? []) {
        const point = this.points[id]!;
        let near = true;
        for (let axis = 0; axis < this.dims; axis += 1) if (Math.abs(point[axis]! - coords[axis]!) > this.eps) near = false;
        if (near) return id;
      }
      return undefined;
    };
    for (const a of dx) for (const b of dx) {
      if (this.dims === 2) { const found = search([a, b]); if (found !== undefined) return found; } else {
        for (const c of dx) { const found = search([a, b, c]); if (found !== undefined) return found; }
      }
    }
    const id = this.points.length;
    this.points.push(coords.slice(0, this.dims).map((value) => Math.round(value / this.round) * this.round));
    const key = cell.join(",");
    const bucket = this.cells.get(key);
    if (bucket === undefined) this.cells.set(key, [id]); else bucket.push(id);
    return id;
  }
}

interface Welded {
  readonly points: readonly Vec3[];
  /** One entry per input triangle; a triangle with a repeated corner or a bad index is marked `valid: false`. */
  readonly tris: readonly { readonly v: readonly [number, number, number]; readonly valid: boolean }[];
}

function weldMesh(mesh: ProjectionMesh): Welded {
  const welder = new Welder(3, WELD_MM, 1e-6);
  const ids: number[] = [];
  for (let i = 0; i + 2 < mesh.positionsMm.length; i += 3) ids.push(welder.add([mesh.positionsMm[i]!, mesh.positionsMm[i + 1]!, mesh.positionsMm[i + 2]!]));
  const tris: { v: readonly [number, number, number]; valid: boolean }[] = [];
  for (let i = 0; i + 2 < mesh.indices.length; i += 3) {
    const a = ids[mesh.indices[i]!];
    const b = ids[mesh.indices[i + 1]!];
    const c = ids[mesh.indices[i + 2]!];
    if (a === undefined || b === undefined || c === undefined) { tris.push({ v: [0, 0, 0], valid: false }); continue; }
    tris.push({ v: [a, b, c], valid: a !== b && b !== c && a !== c });
  }
  return { points: welder.points.map((point) => [point[0]!, point[1]!, point[2]!] as const), tris };
}

function triangleNormal(w: Welded, t: number): Vec3 | undefined {
  const tri = w.tris[t]!;
  if (!tri.valid) return undefined;
  const a = w.points[tri.v[0]]!;
  const n = cross(sub(w.points[tri.v[1]]!, a), sub(w.points[tri.v[2]]!, a));
  const size = length(n);
  return size < 1e-12 ? undefined : [n[0] / size, n[1] / size, n[2] / size];
}

interface EdgeEntry {
  readonly a: number;
  readonly b: number;
  readonly tris: number[];
}

function edgeMapOf(w: Welded): Map<number, EdgeEntry> {
  const n = w.points.length;
  const edges = new Map<number, EdgeEntry>();
  w.tris.forEach((tri, t) => {
    if (!tri.valid || triangleNormal(w, t) === undefined) return;
    for (let k = 0; k < 3; k += 1) {
      const p = tri.v[k]!;
      const q = tri.v[(k + 1) % 3]!;
      const a = Math.min(p, q);
      const b = Math.max(p, q);
      const key = a * n + b;
      const entry = edges.get(key);
      if (entry === undefined) edges.set(key, { a, b, tris: [t] }); else entry.tris.push(t);
    }
  });
  return edges;
}

// ---------------------------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------------------------

interface Chain {
  readonly vertices: readonly number[];
  readonly closed: boolean;
}

/** Joins edges end to end into chains. A chain stops at any vertex where other than two edges meet. Duplicate edges count once. */
function chainEdges(edgeList: readonly (readonly [number, number])[]): Chain[] {
  const seen = new Set<string>();
  const edges: (readonly [number, number])[] = [];
  for (const [a, b] of edgeList) {
    if (a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push([a, b]);
  }
  const at = new Map<number, number[]>();
  edges.forEach(([a, b], index) => {
    for (const vertex of [a, b]) {
      const list = at.get(vertex);
      if (list === undefined) at.set(vertex, [index]); else list.push(index);
    }
  });
  const used = new Set<number>();
  const chains: Chain[] = [];
  const walk = (start: number, first: number): void => {
    const vertices = [start];
    let current = start;
    let edge = first;
    for (;;) {
      used.add(edge);
      const [a, b] = edges[edge]!;
      current = a === current ? b : a;
      vertices.push(current);
      if (current === start || at.get(current)!.length !== 2) break;
      const next = at.get(current)!.find((candidate) => candidate !== edge)!;
      if (used.has(next)) break;
      edge = next;
    }
    const closed = vertices.length > 2 && vertices[0] === vertices[vertices.length - 1];
    chains.push({ vertices: closed ? vertices.slice(0, -1) : vertices, closed });
  };
  for (const [vertex, list] of at) {
    if (list.length === 2) continue;
    for (const edge of list) if (!used.has(edge)) walk(vertex, edge);
  }
  edges.forEach(([a], index) => { if (!used.has(index)) walk(a, index); });
  return chains;
}

// ---------------------------------------------------------------------------------------------
// From 2D segments to curves
// ---------------------------------------------------------------------------------------------

export interface CurveSet {
  readonly curves: readonly FitPrimitive[];
  /** Segments of the mesh that went into the result. */
  readonly sourceSegments: number;
}

const r6 = (value: number): number => Math.round(value * 1e6) / 1e6;
const ptKey = (p: Pt): string => `${Math.round(p[0] * 1e5)}:${Math.round(p[1] * 1e5)}`;

function curvesFromSegments(segments: readonly (readonly [Pt, Pt])[], touching = true): CurveSet {
  if (touching && segments.length <= MAX_SPLIT_SEGMENTS) segments = splitSegments(segments, false);
  const welder = new Welder(2, SNAP_MM, 1e-6);
  const edges: (readonly [number, number])[] = [];
  for (const [p, q] of segments) edges.push([welder.add(p), welder.add(q)]);
  const pointOf = (id: number): Pt => [welder.points[id]![0]!, welder.points[id]![1]!];
  const curves: FitPrimitive[] = [];
  for (const chain of chainEdges(edges)) curves.push(...fitPolyline(chain.vertices.map(pointOf), { closed: chain.closed }));
  return { curves: tidy(curves), sourceSegments: segments.length };
}

function circumcircle(a: Pt, b: Pt, c: Pt): { readonly center: Pt; readonly radius: number } | undefined {
  const d = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(d) < 1e-12) return undefined;
  const ux = ((a[0] ** 2 + a[1] ** 2) * (b[1] - c[1]) + (b[0] ** 2 + b[1] ** 2) * (c[1] - a[1]) + (c[0] ** 2 + c[1] ** 2) * (a[1] - b[1])) / d;
  const uy = ((a[0] ** 2 + a[1] ** 2) * (c[0] - b[0]) + (b[0] ** 2 + b[1] ** 2) * (a[0] - c[0]) + (c[0] ** 2 + c[1] ** 2) * (b[0] - a[0])) / d;
  return { center: [ux, uy], radius: Math.hypot(a[0] - ux, a[1] - uy) };
}

/** Rounds the curves, drops those too small to be sketch entities and removes duplicates (the top and bottom rim of a boss project onto each other). */
function tidy(curves: readonly FitPrimitive[]): FitPrimitive[] {
  const out: FitPrimitive[] = [];
  const keys = new Set<string>();
  const add = (curve: FitPrimitive, key: string): void => {
    if (keys.has(key)) return;
    keys.add(key);
    out.push(curve);
  };
  for (const curve of curves) {
    if (curve.kind === "line") {
      if (Math.hypot(curve.a[0] - curve.b[0], curve.a[1] - curve.b[1]) < MIN_GEOMETRY_MM) continue;
      const [first, second] = ptKey(curve.a) < ptKey(curve.b) ? [curve.a, curve.b] : [curve.b, curve.a];
      add(curve, `L${ptKey(first)}|${ptKey(second)}`);
    } else if (curve.kind === "arc") {
      const circle = circumcircle(curve.start, curve.mid, curve.end);
      const turn = (curve.mid[0] - curve.start[0]) * (curve.end[1] - curve.mid[1]) - (curve.mid[1] - curve.start[1]) * (curve.end[0] - curve.mid[0]);
      if (circle === undefined || Math.abs(turn) < 1e-4) continue;
      // The same arc read from either end is the same arc: order the ends and the side the arc bows to.
      const forward = ptKey(curve.start) < ptKey(curve.end);
      const side = (forward ? 1 : -1) * Math.sign(turn);
      add(curve, `A${forward ? ptKey(curve.start) : ptKey(curve.end)}|${forward ? ptKey(curve.end) : ptKey(curve.start)}|${side}|${Math.round(circle.radius * 100)}`);
    } else if (curve.kind === "circle") {
      if (curve.radiusMm < MIN_GEOMETRY_MM) continue;
      add({ kind: "circle", center: [r6(curve.center[0]), r6(curve.center[1])], radiusMm: r6(curve.radiusMm) }, `C${ptKey(curve.center)}|${Math.round(curve.radiusMm * 1e4)}`);
    } else if (curve.kind === "ellipse") {
      if (curve.minorRadiusMm < MIN_GEOMETRY_MM) continue;
      const axis = ((curve.rotationDeg % 180) + 180) % 180;
      add({ ...curve, center: [r6(curve.center[0]), r6(curve.center[1])], majorRadiusMm: r6(curve.majorRadiusMm), minorRadiusMm: r6(curve.minorRadiusMm), rotationDeg: r6(curve.rotationDeg) }, `E${ptKey(curve.center)}|${Math.round(curve.majorRadiusMm * 1e3)}|${Math.round(curve.minorRadiusMm * 1e3)}|${Math.round(axis * 100)}`);
    } else {
      const keysOfPoints = curve.points.map(ptKey);
      const forward = keysOfPoints.join(">");
      const backward = [...keysOfPoints].reverse().join(">");
      add(curve, `S${forward < backward ? forward : backward}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Project: the edges of a body seen along the sketch normal
// ---------------------------------------------------------------------------------------------

export type Segment3 = readonly [Vec3, Vec3];

export type CurveResult = { readonly ok: true; readonly value: CurveSet } | { readonly ok: false; readonly message: string };

function tooBig(mesh: ProjectionMesh): string | undefined {
  return mesh.indices.length / 3 > MAX_TRIANGLES ? `The body has more than ${MAX_TRIANGLES.toLocaleString("en-US")} triangles, which is too many to bring into a sketch.` : undefined;
}

/** The sharp edges of a body (any edge where the surface bends by at least `creaseDeg`) and its open boundary edges. */
export function sharpEdgesOf(mesh: ProjectionMesh, creaseDeg: number = DEFAULT_CREASE_DEG): readonly Segment3[] {
  const w = weldMesh(mesh);
  const cosLimit = Math.cos((creaseDeg * Math.PI) / 180);
  const out: Segment3[] = [];
  for (const edge of edgeMapOf(w).values()) {
    let sharp = edge.tris.length !== 2;
    if (!sharp) {
      const n1 = triangleNormal(w, edge.tris[0]!)!;
      const n2 = triangleNormal(w, edge.tris[1]!)!;
      sharp = dot(n1, n2) <= cosLimit;
    }
    if (sharp) out.push([w.points[edge.a]!, w.points[edge.b]!]);
  }
  return out;
}

function flatten(segments: readonly Segment3[], frame: SketchFrame): (readonly [Pt, Pt])[] {
  const out: (readonly [Pt, Pt])[] = [];
  for (const [a, b] of segments) {
    const p = worldToSketch(a, frame).xy;
    const q = worldToSketch(b, frame).xy;
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > SNAP_MM) out.push([p, q]);
  }
  return out;
}

/**
 * Projects the sharp edges of a body onto the sketch plane along its normal. A circle seen at an angle becomes an ellipse, an edge
 * parallel to the normal becomes a point and is dropped, and edges that land on top of each other are kept once. Pass `segments`
 * to project only those (for example the edges a user picked).
 */
export function projectBodyEdges(mesh: ProjectionMesh, frame: SketchFrame, options: { readonly creaseDeg?: number; readonly segments?: readonly Segment3[] } = {}): CurveResult {
  const problem = tooBig(mesh);
  if (problem !== undefined) return { ok: false, message: problem };
  const segments = options.segments ?? sharpEdgesOf(mesh, options.creaseDeg);
  if (segments.length === 0) return { ok: false, message: "The body has no sharp edge to project." };
  const flat = flatten(segments, frame);
  if (flat.length === 0) return { ok: false, message: "Every edge runs along the sketch normal, so they all project to points. Choose a plane that looks at the body from another side." };
  return { ok: true, value: curvesFromSegments(flat) };
}

// ---------------------------------------------------------------------------------------------
// Intersect: where the sketch plane cuts the body
// ---------------------------------------------------------------------------------------------

/** The curves where the sketch plane cuts a body: loops where it passes through the solid, in sketch coordinates. */
export function intersectBodyWithPlane(mesh: ProjectionMesh, frame: SketchFrame): CurveResult {
  const problem = tooBig(mesh);
  if (problem !== undefined) return { ok: false, message: problem };
  const w = weldMesh(mesh);
  const height = w.points.map((point) => {
    const h = worldToSketch(point, frame).heightMm;
    return Math.abs(h) < 1e-6 ? 0 : h;
  });
  const flat = w.points.map((point) => worldToSketch(point, frame).xy);
  const segments: (readonly [Pt, Pt])[] = [];
  w.tris.forEach((tri, t) => {
    if (!tri.valid || triangleNormal(w, t) === undefined) return;
    const heights = tri.v.map((id) => height[id]!);
    if (heights.every((h) => h === 0)) return;
    const hits: Pt[] = [];
    const push = (p: Pt): void => { if (!hits.some((q) => Math.hypot(p[0] - q[0], p[1] - q[1]) < 1e-9)) hits.push(p); };
    for (let k = 0; k < 3; k += 1) {
      const i = tri.v[k]!;
      const j = tri.v[(k + 1) % 3]!;
      if (height[i] === 0) push(flat[i]!);
      if (height[i]! * height[j]! < 0) {
        const s = height[i]! / (height[i]! - height[j]!);
        push([flat[i]![0] + (flat[j]![0] - flat[i]![0]) * s, flat[i]![1] + (flat[j]![1] - flat[i]![1]) * s]);
      }
    }
    if (hits.length === 2) segments.push([hits[0]!, hits[1]!]);
  });
  if (segments.length === 0) return { ok: false, message: "The sketch plane does not cut this body. Move the sketch plane through it, or choose another body." };
  return { ok: true, value: curvesFromSegments(segments) };
}

// ---------------------------------------------------------------------------------------------
// Silhouette: the outline of the body seen along the sketch normal
// ---------------------------------------------------------------------------------------------

type Seg2 = readonly [Pt, Pt];

/**
 * Splits segments until they only meet at their ends. A cut makes new end points that may touch other pieces, so it repeats a few
 * times, dropping pieces that have become the same.
 */
function splitSegments(segments: readonly Seg2[], crossings: boolean): Seg2[] {
  const unique = (list: readonly Seg2[]): Seg2[] => {
    const seen = new Set<string>();
    const out: Seg2[] = [];
    for (const segment of list) {
      const a = ptKey4(segment[0]);
      const b = ptKey4(segment[1]);
      if (a === b) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(segment);
    }
    return out;
  };
  let current = unique(splitOnce(segments, crossings));
  for (let pass = 0; pass < 4; pass += 1) {
    const next = unique(splitOnce(current, false));
    if (next.length === current.length) break;
    current = next;
  }
  return current;
}

const ptKey4 = (p: Pt): string => `${Math.round(p[0] * 1e4)}:${Math.round(p[1] * 1e4)}`;

/** An end of one segment this close to the middle of another counts as touching it. */
const TOUCH_MM = 2e-4;
const MAX_SPLIT_SEGMENTS = 30_000;

/**
 * Cuts every segment where another one ends on it (and, with `crossings`, where two cross), so the pieces meet only at their ends.
 * A cut lands exactly on the other segment's end point, so two pieces that overlap along a line end up as identical pieces and can
 * be told apart from different edges. Mesh edges that are long on one face and split into pieces on the next are the usual cause.
 */
function splitOnce(segments: readonly Seg2[], crossings: boolean): Seg2[] {
  const n = segments.length;
  const box = segments.map(([p, q]) => [Math.min(p[0], q[0]), Math.min(p[1], q[1]), Math.max(p[0], q[0]), Math.max(p[1], q[1])] as const);
  const order = [...segments.keys()].sort((a, b) => box[a]![0] - box[b]![0]);
  const cuts: { readonly t: number; readonly point: Pt }[][] = Array.from({ length: n }, () => []);
  const tOf = (p: Pt, a: Pt, b: Pt): { readonly t: number; readonly off: number } => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / lengthSquared;
    return { t, off: Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.sqrt(lengthSquared) };
  };
  for (let x = 0; x < n; x += 1) {
    const i = order[x]!;
    for (let y = x + 1; y < n; y += 1) {
      const j = order[y]!;
      if (box[j]![0] > box[i]![2] + TOUCH_MM) break;
      if (box[j]![1] > box[i]![3] + TOUCH_MM || box[j]![3] < box[i]![1] - TOUCH_MM) continue;
      const [a, b] = segments[i]!;
      const [c, d] = segments[j]!;
      const ends: readonly (readonly [number, Pt])[] = [[i, c], [i, d], [j, a], [j, b]];
      for (const [seg, end] of ends) {
        const [from, to] = segments[seg]!;
        const { t, off } = tOf(end, from, to);
        const along = t * Math.hypot(to[0] - from[0], to[1] - from[1]);
        const total = Math.hypot(to[0] - from[0], to[1] - from[1]);
        if (off <= TOUCH_MM && along > TOUCH_MM && along < total - TOUCH_MM) cuts[seg]!.push({ t, point: end });
      }
      if (!crossings) continue;
      const rx = b[0] - a[0];
      const ry = b[1] - a[1];
      const sx = d[0] - c[0];
      const sy = d[1] - c[1];
      const denominator = rx * sy - ry * sx;
      if (Math.abs(denominator) < 1e-12) continue;
      const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denominator;
      const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denominator;
      if (t > 1e-9 && t < 1 - 1e-9 && u > -1e-9 && u < 1 + 1e-9) {
        const point: Pt = [a[0] + rx * t, a[1] + ry * t];
        cuts[i]!.push({ t, point });
        if (u > 1e-9 && u < 1 - 1e-9) cuts[j]!.push({ t: u, point });
      }
    }
  }
  const out: Seg2[] = [];
  segments.forEach(([p, q], index) => {
    const stops = [{ t: 0, point: p }, ...cuts[index]!.sort((m, k) => m.t - k.t), { t: 1, point: q }];
    for (let k = 0; k + 1 < stops.length; k += 1) out.push([stops[k]!.point, stops[k + 1]!.point]);
  });
  return out;
}

/** Tells whether a sketch point lies inside the flattened body, by testing it against the flattened triangles on a grid. */
function coverageOf(triangles: readonly (readonly [Pt, Pt, Pt])[]): (x: number, y: number) => boolean {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const tri of triangles) for (const p of tri) { minX = Math.min(minX, p[0]); minY = Math.min(minY, p[1]); maxX = Math.max(maxX, p[0]); maxY = Math.max(maxY, p[1]); }
  const cells = Math.max(1, Math.min(256, Math.ceil(Math.sqrt(triangles.length))));
  const width = Math.max(maxX - minX, 1e-9) / cells;
  const height = Math.max(maxY - minY, 1e-9) / cells;
  const grid: number[][] = Array.from({ length: cells * cells }, () => []);
  const cell = (value: number, origin: number, size: number): number => Math.max(0, Math.min(cells - 1, Math.floor((value - origin) / size)));
  triangles.forEach((tri, index) => {
    const xs = tri.map((p) => p[0]);
    const ys = tri.map((p) => p[1]);
    for (let gx = cell(Math.min(...xs), minX, width); gx <= cell(Math.max(...xs), minX, width); gx += 1) {
      for (let gy = cell(Math.min(...ys), minY, height); gy <= cell(Math.max(...ys), minY, height); gy += 1) grid[gy * cells + gx]!.push(index);
    }
  });
  return (x, y) => {
    if (x < minX || x > maxX || y < minY || y > maxY) return false;
    for (const index of grid[cell(y, minY, height) * cells + cell(x, minX, width)]!) {
      const [a, b, c] = triangles[index]!;
      const d1 = (x - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (y - b[1]);
      const d2 = (x - c[0]) * (b[1] - c[1]) - (b[0] - c[0]) * (y - c[1]);
      const d3 = (x - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (y - a[1]);
      if (!((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))) return true;
    }
    return false;
  };
}

/**
 * The outline of a body seen along the sketch normal, as chained curves: the outer outline and the outline of any through-opening.
 * Edges where a front-facing face meets a back-facing one (and open edges) are candidates; each is cut where others cross it, and a
 * piece is on the outline exactly when one side of it is covered by the flattened body and the other is not.
 */
export function silhouetteOfBody(mesh: ProjectionMesh, frame: SketchFrame): CurveResult {
  const problem = tooBig(mesh);
  if (problem !== undefined) return { ok: false, message: problem };
  const w = weldMesh(mesh);
  const flat = w.points.map((point) => worldToSketch(point, frame).xy);
  const facing = w.tris.map((_, t) => {
    const n = triangleNormal(w, t);
    if (n === undefined) return undefined;
    const d = dot(n, frame.normal);
    return Math.abs(d) <= EDGE_ON ? 0 : Math.sign(d);
  });
  const candidates: Seg2[] = [];
  for (const edge of edgeMapOf(w).values()) {
    const sides = edge.tris.map((t) => facing[t]!);
    const candidate = sides.length !== 2 || sides[0] !== sides[1] || sides[0] === 0;
    if (!candidate) continue;
    const p = flat[edge.a]!;
    const q = flat[edge.b]!;
    if (Math.hypot(p[0] - q[0], p[1] - q[1]) > SNAP_MM) candidates.push([p, q]);
  }
  if (candidates.length === 0) return { ok: false, message: "The body has no outline to find." };
  if (candidates.length > MAX_SILHOUETTE_SEGMENTS) return { ok: false, message: `The outline has ${candidates.length} candidate edges, more than the ${MAX_SILHOUETTE_SEGMENTS} this can handle. Use a simpler body.` };
  const triangles: (readonly [Pt, Pt, Pt])[] = [];
  w.tris.forEach((tri, t) => {
    if (facing[t] === undefined || facing[t] === 0) return;
    const [a, b, c] = [flat[tri.v[0]]!, flat[tri.v[1]]!, flat[tri.v[2]]!];
    if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) > 1e-12) triangles.push([a, b, c]);
  });
  const covered = coverageOf(triangles);
  const welder = new Welder(2, SNAP_MM, 1e-6);
  const seen = new Set<string>();
  const outline: Seg2[] = [];
  for (const [p, q] of splitSegments(candidates, true)) {
    const a = welder.add(p);
    const b = welder.add(q);
    if (a === b) continue;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const start = welder.points[a]!;
    const end = welder.points[b]!;
    const dx = end[0]! - start[0]!;
    const dy = end[1]! - start[1]!;
    const size = Math.hypot(dx, dy);
    const offset = Math.min(1e-3, size / 4);
    const mx = (start[0]! + end[0]!) / 2;
    const my = (start[1]! + end[1]!) / 2;
    const nx = (-dy / size) * offset;
    const ny = (dx / size) * offset;
    if (covered(mx + nx, my + ny) !== covered(mx - nx, my - ny)) outline.push([[start[0]!, start[1]!], [end[0]!, end[1]!]]);
  }
  if (outline.length === 0) return { ok: false, message: "The body has no outline when seen along the sketch normal." };
  return { ok: true, value: curvesFromSegments(outline, false) };
}

// ---------------------------------------------------------------------------------------------
// Convert: the outline of one face
// ---------------------------------------------------------------------------------------------

export interface FaceChoice {
  /** Triangle numbers of the face. */
  readonly triangles: readonly number[];
  /** Every triangle of the face lies within a degree of the same plane. */
  readonly planar: boolean;
  /** The face came from the body's named kernel faces; otherwise it is the connected run of coplanar triangles under the click. */
  readonly named: boolean;
  readonly areaMm2: number;
}

function closestPointDistance(p: Vec3, a: Vec3, b: Vec3, c: Vec3): number {
  // Ericson, Real-Time Collision Detection: the distance from a point to a triangle.
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  const at = (q: Vec3): number => length(sub(p, q));
  if (d1 <= 0 && d2 <= 0) return at(a);
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return at(b);
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return at([a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v]); }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return at(c);
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const wv = d2 / (d2 - d6); return at([a[0] + ac[0] * wv, a[1] + ac[1] * wv, a[2] + ac[2] * wv]); }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const wv = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return at([b[0] + (c[0] - b[0]) * wv, b[1] + (c[1] - b[1]) * wv, b[2] + (c[2] - b[2]) * wv]); }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const wv = vc * denominator;
  return at([a[0] + ab[0] * v + ac[0] * wv, a[1] + ab[1] * v + ac[1] * wv, a[2] + ab[2] * v + ac[2] * wv]);
}

/**
 * Finds the face a pick landed on. With the body's named kernel faces (`faceTriangles` and a face index, or the face of the triangle
 * nearest the picked point) the face is exactly that face; without them it is the connected run of coplanar triangles under the point.
 */
export function chooseFace(mesh: ProjectionMesh, pick: { readonly pointMm?: Vec3 | undefined; readonly faceIndex?: number | null | undefined; readonly faceTriangles?: readonly number[] | undefined }): FaceChoice | string {
  const problem = tooBig(mesh);
  if (problem !== undefined) return problem;
  const w = weldMesh(mesh);
  const named = pick.faceTriangles !== undefined && pick.faceTriangles.length === w.tris.length;
  let seed: number | undefined;
  if (named && typeof pick.faceIndex === "number") seed = pick.faceTriangles!.findIndex((face) => face === pick.faceIndex);
  if (seed === undefined || seed < 0) {
    if (pick.pointMm === undefined) return "Pick a face of the body.";
    let best = Infinity;
    w.tris.forEach((tri, t) => {
      if (!tri.valid || triangleNormal(w, t) === undefined) return;
      const distance = closestPointDistance(pick.pointMm!, w.points[tri.v[0]]!, w.points[tri.v[1]]!, w.points[tri.v[2]]!);
      if (distance < best) { best = distance; seed = t; }
    });
    if (seed === undefined) return "The body has no faces to pick.";
  }
  const seedNormal = triangleNormal(w, seed)!;
  const seedPoint = w.points[w.tris[seed]!.v[0]]!;
  let members: number[];
  if (named) {
    const face = pick.faceTriangles![seed]!;
    members = w.tris.flatMap((_, t) => pick.faceTriangles![t] === face && triangleNormal(w, t) !== undefined ? [t] : []);
  } else {
    const edges = edgeMapOf(w);
    const n = w.points.length;
    const cosLimit = Math.cos((0.5 * Math.PI) / 180);
    const inRegion = new Set<number>([seed]);
    const queue = [seed];
    while (queue.length > 0) {
      const t = queue.pop()!;
      const tri = w.tris[t]!;
      for (let k = 0; k < 3; k += 1) {
        const p = tri.v[k]!;
        const q = tri.v[(k + 1) % 3]!;
        const entry = edges.get(Math.min(p, q) * n + Math.max(p, q));
        if (entry === undefined) continue;
        for (const other of entry.tris) {
          if (inRegion.has(other)) continue;
          const normal = triangleNormal(w, other)!;
          const onPlane = Math.abs(dot(sub(w.points[w.tris[other]!.v[0]]!, seedPoint), seedNormal)) <= 0.005;
          if (dot(normal, seedNormal) >= cosLimit && onPlane) { inRegion.add(other); queue.push(other); }
        }
      }
    }
    members = [...inRegion];
  }
  let area = 0;
  let sum: Vec3 = [0, 0, 0];
  for (const t of members) {
    const tri = w.tris[t]!;
    const a = w.points[tri.v[0]]!;
    const c = cross(sub(w.points[tri.v[1]]!, a), sub(w.points[tri.v[2]]!, a));
    area += length(c) / 2;
    sum = [sum[0] + c[0], sum[1] + c[1], sum[2] + c[2]];
  }
  const mean = length(sum) < 1e-12 ? seedNormal : ([sum[0] / length(sum), sum[1] / length(sum), sum[2] / length(sum)] as const);
  const planar = members.every((t) => dot(triangleNormal(w, t)!, mean) >= Math.cos(Math.PI / 180));
  return { triangles: members, planar, named, areaMm2: area };
}

/** The outline of a face (its outer loop and any hole loops) projected onto the sketch plane. */
export function convertFace(mesh: ProjectionMesh, face: FaceChoice, frame: SketchFrame): CurveResult {
  const w = weldMesh(mesh);
  const members = new Set(face.triangles);
  const boundary: Segment3[] = [];
  for (const edge of edgeMapOf(w).values()) {
    const inside = edge.tris.filter((t) => members.has(t)).length;
    if (inside === 1) boundary.push([w.points[edge.a]!, w.points[edge.b]!]);
  }
  if (boundary.length === 0) return { ok: false, message: "That face has no boundary edges." };
  const flat = flatten(boundary, frame);
  if (flat.length === 0) return { ok: false, message: "The face is edge-on to the sketch plane, so its outline projects to a point. Choose a plane that looks at the face." };
  return { ok: true, value: curvesFromSegments(flat) };
}

// ---------------------------------------------------------------------------------------------
// Sketch entities
// ---------------------------------------------------------------------------------------------

export type ProjectionMode = "project" | "intersect" | "silhouette" | "convert";

export interface CurveCounts {
  readonly lines: number;
  readonly arcs: number;
  readonly circles: number;
  readonly ellipses: number;
  readonly splines: number;
}

/** Turns recognised curves into sketch entities, with ids from `newId`. Shared ends are exactly equal, so closed loops become profiles. */
export function entitiesFromCurves(curves: readonly FitPrimitive[], options: { readonly construction: boolean; readonly newId: () => string }): { readonly entities: readonly SketchEntity[]; readonly counts: CurveCounts } {
  const entities: SketchEntity[] = [];
  const counts = { lines: 0, arcs: 0, circles: 0, ellipses: 0, splines: 0 };
  const construction = options.construction;
  const line = (start: Pt, end: Pt): void => {
    if (Math.hypot(start[0] - end[0], start[1] - end[1]) < MIN_GEOMETRY_MM) return;
    entities.push({ id: options.newId(), kind: "line", start: [start[0], start[1]], end: [end[0], end[1]], construction });
    counts.lines += 1;
  };
  for (const curve of curves) {
    if (curve.kind === "line") line(curve.a, curve.b);
    else if (curve.kind === "arc") {
      entities.push({ id: options.newId(), kind: "arc", start: [curve.start[0], curve.start[1]], mid: [curve.mid[0], curve.mid[1]], end: [curve.end[0], curve.end[1]], construction });
      counts.arcs += 1;
    } else if (curve.kind === "circle") {
      entities.push({ id: options.newId(), kind: "circle", center: [curve.center[0], curve.center[1]], radiusMm: curve.radiusMm, construction });
      counts.circles += 1;
    } else if (curve.kind === "ellipse") {
      entities.push({ id: options.newId(), kind: "ellipse", center: [curve.center[0], curve.center[1]], majorRadiusMm: curve.majorRadiusMm, minorRadiusMm: curve.minorRadiusMm, rotationDeg: curve.rotationDeg, construction });
      counts.ellipses += 1;
    } else {
      // A spline needs fit points at least 0.01 mm apart; a curve that cannot keep that falls back to straight pieces.
      const spaced = curve.points.filter((point, index, all) => index === 0 || Math.hypot(point[0] - all[index - 1]![0], point[1] - all[index - 1]![1]) >= MIN_GEOMETRY_MM);
      if (spaced.length >= 3) {
        entities.push({ id: options.newId(), kind: "spline", fitPoints: spaced.map((point): readonly [number, number] => [point[0], point[1]]), construction });
        counts.splines += 1;
      } else for (let i = 0; i + 1 < curve.points.length; i += 1) line(curve.points[i]!, curve.points[i + 1]!);
    }
  }
  return { entities, counts };
}

export interface ProjectionRequest {
  readonly mode: ProjectionMode;
  /** The body to bring in, in world millimetres. `faceTriangles` is its named-face map when it has one. */
  readonly body: ProjectionMesh & { readonly name?: string; readonly brep?: { readonly faceTriangles: readonly number[] } | undefined };
  /** The sketch it goes into. */
  readonly sketch: SketchFrameSource;
  /** Make the new curves construction (reference) geometry, which never bounds a profile. */
  readonly construction?: boolean;
  readonly newId: () => string;
  /** How many more entities the sketch can take. */
  readonly room?: number;
  /** Project only: use just these edges, for example the chain a user picked. */
  readonly edges?: readonly Segment3[];
  /** Convert only: the picked point and face. */
  readonly pointMm?: Vec3;
  readonly faceIndex?: number | null;
}

export interface ProjectionPlan {
  readonly entities: readonly SketchEntity[];
  readonly counts: CurveCounts;
  readonly label: string;
  /** What was done and what the user must know about it, for the status line. */
  readonly summary: string;
}

const MODE_VERB: Readonly<Record<ProjectionMode, string>> = { project: "Projected", intersect: "Intersected", silhouette: "Silhouette of", convert: "Converted a face of" };

function describeCounts(counts: CurveCounts): string {
  const parts: string[] = [];
  const add = (count: number, one: string, many: string): void => { if (count > 0) parts.push(`${count} ${count === 1 ? one : many}`); };
  add(counts.lines, "line", "lines");
  add(counts.arcs, "arc", "arcs");
  add(counts.circles, "circle", "circles");
  add(counts.ellipses, "ellipse", "ellipses");
  add(counts.splines, "spline", "splines");
  return parts.join(", ");
}

/** Works out the sketch entities for one Project, Intersect, Silhouette or Convert, or says why it cannot. */
export function planProjection(request: ProjectionRequest): { readonly ok: true; readonly plan: ProjectionPlan } | { readonly ok: false; readonly message: string } {
  const frame = sketchFrameOf(request.sketch);
  const mesh = { positionsMm: request.body.positionsMm, indices: request.body.indices };
  if (mesh.indices.length < 9) return { ok: false, message: "The body has no solid geometry to bring into a sketch." };
  let result: CurveResult;
  let note = "";
  if (request.mode === "project") result = projectBodyEdges(mesh, frame, request.edges === undefined ? {} : { segments: request.edges });
  else if (request.mode === "intersect") result = intersectBodyWithPlane(mesh, frame);
  else if (request.mode === "silhouette") result = silhouetteOfBody(mesh, frame);
  else {
    const face = chooseFace(mesh, { pointMm: request.pointMm, faceIndex: request.faceIndex, faceTriangles: request.body.brep?.faceTriangles });
    if (typeof face === "string") return { ok: false, message: face };
    result = convertFace(mesh, face, frame);
    if (!face.planar) note = " The face is curved, so its boundary edges were projected.";
    else if (!face.named) note = " The face was found as the flat run of triangles under the click; if it continues into a curved surface, only the flat part was taken.";
  }
  if (!result.ok) return { ok: false, message: result.message };
  if (result.value.curves.length === 0) return { ok: false, message: "Nothing could be brought into the sketch: every curve was too small or edge-on." };
  const built = entitiesFromCurves(result.value.curves, { construction: request.construction === true, newId: request.newId });
  if (built.entities.length === 0) return { ok: false, message: "Nothing could be brought into the sketch: every curve was too small or edge-on." };
  const room = request.room ?? Infinity;
  if (built.entities.length > room) return { ok: false, message: `This would add ${built.entities.length} curves, but the sketch has room for ${Math.max(0, room)} more. Delete curves or choose a simpler body.` };
  const name = request.body.name ?? "the body";
  const kind = request.construction === true ? "construction curves" : "curves";
  const label = `${MODE_VERB[request.mode]} ${name}`;
  return {
    ok: true,
    plan: {
      entities: built.entities,
      counts: built.counts,
      label,
      summary: `${label}: ${describeCounts(built.counts)} as ${kind}. These are a snapshot of the body as it is now; they do not follow later edits of it.${note}`
    }
  };
}
