import { booleanMeshes } from "./mesh-boolean.js";
import { add, cross, dot, length, scale, sub, unit, type MeshLike, type V3 } from "./face-analysis.js";

/**
 * Rib / Web: a thin wall grown from an open profile curve down to the body it belongs to.
 *
 * The profile lies in a plane (the sketch plane) with normal `normal`. The wall stands in that plane: its top edge is the
 * profile, its sides are the profile's two ends carried on (along the end tangents) until they meet the body, and its bottom
 * follows the body, found by casting a ray from every point of the profile in one direction square to the profile. The wall
 * is `thicknessMm` thick, sunk a little into the body so the union leaves no seam, and then joined to the body.
 */
export interface WebSpec {
  readonly thicknessMm: number;
  readonly direction: "symmetric" | "one-side";
  /** Which side of the profile the wall grows towards; absent picks the side that meets the body. */
  readonly flip?: boolean | undefined;
  /** Whether the ends of the profile are carried on until they meet the body. */
  readonly extendToBody: boolean;
  /** The normal of the plane the profile lies in. */
  readonly normal: V3;
}

export type WebResult =
  | { readonly ok: true; readonly positionsMm: readonly number[]; readonly indices: readonly number[]; readonly notes: readonly string[]; readonly flip: boolean }
  | { readonly ok: false; readonly message: string };

/** The nearest hit of a ray on the mesh beyond `minT`, as the distance along the (unit) direction. */
export function firstHit(mesh: MeshLike, origin: V3, direction: V3, minT = 1e-6): number | undefined {
  let best: number | undefined;
  const p = mesh.positionsMm;
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = mesh.indices[t]! * 3; const b = mesh.indices[t + 1]! * 3; const c = mesh.indices[t + 2]! * 3;
    const e1: V3 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
    const e2: V3 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
    const pv = cross(direction, e2);
    const det = dot(e1, pv);
    if (Math.abs(det) < 1e-12) continue;
    const inv = 1 / det;
    const tv: V3 = [origin[0] - p[a]!, origin[1] - p[a + 1]!, origin[2] - p[a + 2]!];
    const u = dot(tv, pv) * inv;
    if (u < -1e-9 || u > 1 + 1e-9) continue;
    const qv = cross(tv, e1);
    const v = dot(direction, qv) * inv;
    if (v < -1e-9 || u + v > 1 + 1e-9) continue;
    const distance = dot(e2, qv) * inv;
    if (distance > minT && (best === undefined || distance < best)) best = distance;
  }
  return best;
}

/** Points along the chain no further apart than a few millimetres, so the bottom can follow a body that is not flat. */
function densify(chain: readonly V3[]): V3[] {
  let total = 0;
  for (let i = 1; i < chain.length; i += 1) total += length(sub(chain[i]!, chain[i - 1]!));
  const step = Math.max(3, total / 150);
  const out: V3[] = [chain[0]!];
  for (let i = 1; i < chain.length; i += 1) {
    const from = chain[i - 1]!; const to = chain[i]!;
    const pieces = Math.max(1, Math.ceil(length(sub(to, from)) / step));
    for (let k = 1; k <= pieces; k += 1) out.push(add(from, scale(sub(to, from), k / pieces)));
  }
  return out;
}

/** Ear-clipping triangulation of a simple polygon in 2D; returns corner index triples, counter-clockwise. */
export function triangulatePolygon2D(points: readonly (readonly [number, number])[]): number[] | undefined {
  const n = points.length;
  if (n < 3) return undefined;
  let area = 0;
  for (let i = 0; i < n; i += 1) { const a = points[i]!; const b = points[(i + 1) % n]!; area += a[0] * b[1] - b[0] * a[1]; }
  const order = Array.from({ length: n }, (_, i) => i);
  if (area < 0) order.reverse();
  const cross2 = (o: number, a: number, b: number): number => (points[a]![0] - points[o]![0]) * (points[b]![1] - points[o]![1]) - (points[a]![1] - points[o]![1]) * (points[b]![0] - points[o]![0]);
  const inside = (p: number, a: number, b: number, c: number): boolean => cross2(a, b, p) >= -1e-12 && cross2(b, c, p) >= -1e-12 && cross2(c, a, p) >= -1e-12;
  const triangles: number[] = [];
  let guard = 0;
  while (order.length > 3 && guard < n * n) {
    guard += 1;
    let clipped = false;
    for (let k = 0; k < order.length; k += 1) {
      const a = order[(k + order.length - 1) % order.length]!; const b = order[k]!; const c = order[(k + 1) % order.length]!;
      const turn = cross2(a, b, c);
      if (turn <= 1e-12) continue;
      if (order.some((other) => other !== a && other !== b && other !== c && inside(other, a, b, c))) continue;
      triangles.push(a, b, c);
      order.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) {
      // Collinear or touching corners: drop a corner that adds no area and carry on.
      const flat = order.findIndex((_, k) => Math.abs(cross2(order[(k + order.length - 1) % order.length]!, order[k]!, order[(k + 1) % order.length]!)) <= 1e-12);
      if (flat < 0) return undefined;
      order.splice(flat, 1);
    }
  }
  if (order.length === 3 && cross2(order[0]!, order[1]!, order[2]!) > 1e-12) triangles.push(order[0]!, order[1]!, order[2]!);
  return triangles;
}

/** A closed prism: the planar polygon `ring` (in order) pushed from `low` to `high` along the unit `normal`. */
function prism(ring: readonly V3[], normal: V3, low: number, high: number): { positions: number[]; indices: number[] } | undefined {
  const u = unit(sub(ring[Math.floor(ring.length / 2)]!, ring[0]!)) ?? ((): V3 => { const h: V3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0]; return unit(cross(normal, h))!; })();
  const uAxis = unit(sub(u, scale(normal, dot(u, normal))))!;
  const vAxis = cross(normal, uAxis);
  const flat = ring.map((p): [number, number] => [dot(p, uAxis), dot(p, vAxis)]);
  const cap = triangulatePolygon2D(flat);
  if (cap === undefined || cap.length < 3) return undefined;
  const n = ring.length;
  let area = 0;
  for (let i = 0; i < n; i += 1) { const a = flat[i]!; const b = flat[(i + 1) % n]!; area += a[0] * b[1] - b[0] * a[1]; }
  const ccw = area > 0;
  const positions: number[] = [];
  for (const level of [low, high]) for (const p of ring) { const q = add(p, scale(normal, level)); positions.push(q[0], q[1], q[2]); }
  const indices: number[] = [];
  for (let i = 0; i < cap.length; i += 3) {
    indices.push(n + cap[i]!, n + cap[i + 1]!, n + cap[i + 2]!);
    indices.push(cap[i]!, cap[i + 2]!, cap[i + 1]!);
  }
  for (let i = 0; i < n; i += 1) {
    const j = (i + 1) % n;
    const a = ccw ? i : j; const b = ccw ? j : i;
    indices.push(a, b, n + b, a, n + b, n + a);
  }
  return { positions, indices };
}

/** The solid wall for one profile chain. */
export function webSlab(body: MeshLike, chain: readonly V3[], spec: WebSpec): WebResult {
  const normal = unit(spec.normal);
  if (normal === undefined) return { ok: false, message: "The rib's sketch plane has no direction." };
  if (chain.length < 2) return { ok: false, message: "A rib needs an open profile with at least two points." };
  const first = chain[0]!; const last = chain[chain.length - 1]!;
  if (length(sub(first, last)) < 1e-6) return { ok: false, message: "A rib needs an open profile; this one is closed." };
  const chord = unit(sub(last, first));
  if (chord === undefined) return { ok: false, message: "The profile's ends are in the same place." };
  const down = unit(cross(normal, chord));
  if (down === undefined) return { ok: false, message: "The profile does not lie in the sketch plane." };
  const t = Math.max(spec.thicknessMm, 1e-6);
  const sink = Math.min(0.3, 0.25 * t);
  const samples = densify(chain);
  const toward = (sign: number): { distances: (number | undefined)[]; misses: number; total: number } => {
    const distances = samples.map((p) => firstHit(body, p, scale(down, sign)));
    return { distances, misses: distances.filter((d) => d === undefined).length, total: distances.reduce<number>((sum, d) => sum + (d ?? 0), 0) };
  };
  const a = toward(1); const b = toward(-1);
  let sign: 1 | -1;
  if (spec.flip !== undefined) sign = spec.flip ? -1 : 1;
  else if (a.misses === 0 && b.misses === 0) sign = a.total <= b.total ? 1 : -1;
  else if (a.misses === 0) sign = 1;
  else if (b.misses === 0) sign = -1;
  else sign = a.misses <= b.misses ? 1 : -1;
  const chosen = sign === 1 ? a : b;
  if (chosen.misses > 0) return { ok: false, message: `The rib profile does not reach the body: ${chosen.misses} of ${samples.length} points of it have nothing underneath in that direction.` };
  const direction = scale(down, sign);
  // Carry the ends on along their tangents until they meet the body.
  const top: V3[] = [...samples];
  const depth: number[] = [...chosen.distances.map((d) => d!)];
  const notes: string[] = [];
  if (spec.extendToBody) {
    const extend = (end: V3, outward: V3, atStart: boolean): void => {
      const hit = firstHit(body, end, outward);
      if (hit === undefined) { notes.push(`The ${atStart ? "start" : "end"} of the profile meets nothing; it is left as drawn.`); return; }
      const surface = add(end, scale(outward, hit));
      const inner = firstHit(body, add(surface, scale(outward, -0.01)), direction);
      if (inner === undefined) { notes.push(`The ${atStart ? "start" : "end"} of the profile reaches the body where nothing is underneath; it is left as drawn.`); return; }
      const sunk = add(surface, scale(outward, sink));
      if (atStart) { top.unshift(sunk); depth.unshift(inner + 0.01); } else { top.push(sunk); depth.push(inner + 0.01); }
    };
    const startOut = unit(sub(samples[0]!, samples[1]!))!;
    const endOut = unit(sub(samples[samples.length - 1]!, samples[samples.length - 2]!))!;
    extend(samples[0]!, startOut, true);
    extend(samples[samples.length - 1]!, endOut, false);
  }
  const bottom = top.map((p, i) => add(p, scale(direction, depth[i]! + sink)));
  const ring: V3[] = [...top, ...bottom.slice().reverse()];
  const low = spec.direction === "symmetric" ? -t / 2 : 0;
  const high = spec.direction === "symmetric" ? t / 2 : t;
  const solid = prism(ring, normal, low, high);
  if (solid === undefined) return { ok: false, message: "The rib's outline crosses itself, so no wall can be built from it. Use a profile that does not fold back." };
  return { ok: true, positionsMm: solid.positions, indices: solid.indices, notes, flip: sign === -1 };
}

/** Joins a wall for every profile chain to the body. */
export function addWebs(body: MeshLike, chains: readonly (readonly V3[])[], spec: WebSpec): WebResult {
  let current: MeshLike = body;
  const notes: string[] = [];
  let flip = false;
  for (const chain of chains) {
    const slab = webSlab(body, chain, spec);
    if (!slab.ok) return slab;
    flip = slab.flip;
    notes.push(...slab.notes);
    const joined = booleanMeshes({ positionsMm: current.positionsMm, indices: current.indices }, { positionsMm: slab.positionsMm, indices: slab.indices }, "join");
    if (!joined.ok) return { ok: false, message: `The rib could not be joined to the body: ${joined.message}` };
    current = { positionsMm: joined.value.positionsMm, indices: joined.value.indices };
  }
  notes.unshift(`Joined ${chains.length} ${chains.length === 1 ? "rib" : "ribs"}, ${spec.thicknessMm} mm thick.`);
  return { ok: true, positionsMm: current.positionsMm, indices: current.indices, notes, flip };
}
