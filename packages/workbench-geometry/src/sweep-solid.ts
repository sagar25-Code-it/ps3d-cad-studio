import { triangulateLoops } from "../../occt-kernel-adapter/src/polygon.js";
import { densifyForTwist, twistSegments } from "./twist-stations.js";

/**
 * Sweeps and lofts of profiles that may have holes, along a real 3D path or between profiles on different planes.
 *
 * Everything here works on rings of 3D points: a ring is the outline of the profile at one station, outer loop first and then each
 * hole. Two end caps are triangulated with the holes cut out of them, and each loop gets a wall of quads between consecutive rings
 * (a hole's wall faces into the hole). The result is a closed mesh facing outward when the outer loops run counter-clockwise about the
 * direction of travel, which every builder below makes sure of.
 */

export type V3 = readonly [number, number, number];
export type P2 = readonly [number, number];

export interface Loops2 {
  readonly outer: readonly P2[];
  readonly holes: readonly (readonly P2[])[];
}

export interface Loops3 {
  readonly outer: readonly V3[];
  readonly holes: readonly (readonly V3[])[];
}

export interface SolidMesh {
  readonly positionsMm: number[];
  readonly indices: number[];
}

export type SolidMeshResult = { readonly ok: true; readonly mesh: SolidMesh; readonly notes: readonly string[] } | { readonly ok: false; readonly message: string };

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const scale = (a: V3, factor: number): V3 => [a[0] * factor, a[1] * factor, a[2] * factor];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const length = (a: V3): number => Math.hypot(a[0], a[1], a[2]);
function unit(a: V3): V3 | undefined {
  const size = length(a);
  return size < 1e-12 ? undefined : [a[0] / size, a[1] / size, a[2] / size];
}

export function signedArea2(points: readonly P2[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index]!;
    const [x2, y2] = points[(index + 1) % points.length]!;
    twice += x1 * y2 - x2 * y1;
  }
  return twice / 2;
}

function counterClockwise(points: readonly P2[]): readonly P2[] {
  return signedArea2(points) < 0 ? [...points].reverse() : points;
}

function clockwise(points: readonly P2[]): readonly P2[] {
  return signedArea2(points) > 0 ? [...points].reverse() : points;
}

/** Outer loop counter-clockwise, holes clockwise. */
export function orientLoops(loops: Loops2): Loops2 {
  return { outer: counterClockwise(loops.outer), holes: loops.holes.map(clockwise) };
}

export function loopCentroid(points: readonly P2[]): P2 {
  let signed = 0;
  let cx = 0;
  let cy = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    const crossTerm = a[0] * b[1] - b[0] * a[1];
    signed += crossTerm;
    cx += (a[0] + b[0]) * crossTerm;
    cy += (a[1] + b[1]) * crossTerm;
  }
  if (Math.abs(signed) < 1e-12) return [points.reduce((sum, p) => sum + p[0], 0) / points.length, points.reduce((sum, p) => sum + p[1], 0) / points.length];
  return [cx / (3 * signed), cy / (3 * signed)];
}

/** Drops repeated points (and a repeated closing point) so a loop has no zero-length edge. */
export function cleanLoop<T extends readonly number[]>(points: readonly T[], toleranceMm = 1e-7): T[] {
  const kept: T[] = [];
  for (const point of points) {
    const previous = kept[kept.length - 1];
    if (previous !== undefined && Math.hypot(...point.map((value, axis) => value - previous[axis]!)) < toleranceMm) continue;
    kept.push(point);
  }
  const first = kept[0];
  const last = kept[kept.length - 1];
  if (kept.length > 1 && first !== undefined && last !== undefined && Math.hypot(...first.map((value, axis) => value - last[axis]!)) < toleranceMm) kept.pop();
  return kept;
}

/**
 * Assembles the closed solid from rings. `loopSizes` says how many points of each ring belong to each loop (outer first).
 * `startCap` and `endCap` are triangle index lists into one ring's points, counter-clockwise about the direction of travel.
 * With `closed` the last ring joins the first and there are no caps.
 */
export function assembleSolid(rings: readonly (readonly V3[])[], loopSizes: readonly number[], startCap: readonly number[], endCap: readonly number[], closed: boolean, alternateDiagonals = false): SolidMesh {
  const perRing = rings[0]!.length;
  const positionsMm: number[] = [];
  for (const ring of rings) for (const point of ring) positionsMm.push(point[0], point[1], point[2]);
  const indices: number[] = [];
  if (!closed) {
    for (let index = 0; index + 2 < startCap.length; index += 3) indices.push(startCap[index]!, startCap[index + 2]!, startCap[index + 1]!);
    const last = (rings.length - 1) * perRing;
    for (let index = 0; index + 2 < endCap.length; index += 3) indices.push(last + endCap[index]!, last + endCap[index + 1]!, last + endCap[index + 2]!);
  }
  const bands = closed ? rings.length : rings.length - 1;
  for (let ring = 0; ring < bands; ring += 1) {
    const base = ring * perRing;
    const nextBase = ((ring + 1) % rings.length) * perRing;
    let offset = 0;
    for (const size of loopSizes) {
      for (let i = 0; i < size; i += 1) {
        const next = (i + 1) % size;
        if (alternateDiagonals && ring % 2 === 1) indices.push(base + offset + i, base + offset + next, nextBase + offset + i, base + offset + next, nextBase + offset + next, nextBase + offset + i);
        else indices.push(base + offset + i, base + offset + next, nextBase + offset + next, base + offset + i, nextBase + offset + next, nextBase + offset + i);
      }
      offset += size;
    }
  }
  return { positionsMm, indices };
}

/** Triangulates a profile with holes into index triples over the flattened loops, or reports why it cannot. */
export function capTriangles(loops: Loops2): { readonly ok: true; readonly triangles: readonly number[] } | { readonly ok: false; readonly message: string } {
  try {
    return { ok: true, triangles: triangulateLoops(loops.outer, loops.holes) };
  } catch (error) {
    return { ok: false, message: `The profile could not be capped: ${error instanceof Error ? error.message : "its outline is invalid"}` };
  }
}

// ---------------------------------------------------------------------------------------------
// Sweep along a path
// ---------------------------------------------------------------------------------------------

/** Rotates `vector` by the shortest turn that takes unit `from` onto unit `to`. */
function turnBetween(vector: V3, from: V3, to: V3): V3 {
  const axis = cross(from, to);
  const sine = length(axis);
  const cosine = dot(from, to);
  if (sine < 1e-12) return vector;
  const k = scale(axis, 1 / sine);
  // Rodrigues: v cos + (k x v) sin + k (k.v)(1 - cos)
  return add(add(scale(vector, cosine), scale(cross(k, vector), sine)), scale(k, dot(k, vector) * (1 - cosine)));
}

/** The frame a sweep starts in: the first tangent and the two perpendicular axes the profile's x and y run along. */
export function pathStartFrame(path: readonly V3[], startU: V3): { readonly tangent: V3; readonly u: V3; readonly v: V3 } | undefined {
  const points = cleanLoop(path as readonly (readonly number[])[], 1e-6) as unknown as V3[];
  if (points.length < 2) return undefined;
  const tangent = unit(sub(points[1]!, points[0]!));
  if (tangent === undefined) return undefined;
  let u = unit(sub(startU, scale(tangent, dot(startU, tangent))));
  if (u === undefined) u = unit(cross(tangent, Math.abs(tangent[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]));
  return u === undefined ? undefined : { tangent, u, v: cross(tangent, u) };
}

export interface PathSweepInput {
  /** The profile in the local frame: x runs along `startU` and y along tangent x startU at the start of the path. */
  readonly loops: Loops2;
  /** World points of the path, in order. */
  readonly path: readonly V3[];
  /** Which way the profile's x axis points at the start; it is made perpendicular to the first tangent. */
  readonly startU: V3;
  readonly twistDeg?: number;
  /**
   * The true direction of the path at its first and last point when it starts or ends on a curve (the sampled path's first chord leans
   * into the bend by half a step). The end caps are cut square to these instead of to the chord, so a pipe along an arc ends flat.
   */
  readonly startTangent?: V3;
  readonly endTangent?: V3;
}

/**
 * Sweeps a profile along a polyline path with rotation-minimising frames, so the profile does not spin about the path. The section at a
 * joint between two straight pieces is mitred (the cut through the joint's bisector plane), which keeps the wall thickness of a bent tube.
 * Sections are perpendicular to the path.
 */
export function sweepAlongPath(input: PathSweepInput): SolidMeshResult {
  const cleaned: V3[] = cleanLoop(input.path as readonly (readonly number[])[], 1e-6) as unknown as V3[];
  const closed = cleaned.length > 2 && length(sub(input.path[0]!, input.path[input.path.length - 1]!)) < 1e-6;
  // A twist needs stations between the ends (a straight path has only two points): see twist-stations.ts.
  const ringPoints = input.loops.outer.length + input.loops.holes.reduce((total, hole) => total + hole.length, 0);
  const points: V3[] = densifyForTwist(cleaned, closed, input.twistDeg, ringPoints);
  if (points.length < 2) return { ok: false, message: "The sweep path has no length." };
  const segments = points.length - 1 + (closed ? 1 : 0);
  const tangents: V3[] = [];
  for (let index = 0; index < segments; index += 1) {
    const tangent = unit(sub(points[(index + 1) % points.length]!, points[index]!));
    if (tangent === undefined) return { ok: false, message: "The sweep path has a zero-length piece." };
    tangents.push(tangent);
  }
  const notes: string[] = [];
  const t0 = tangents[0]!;
  let u0 = unit(sub(input.startU, scale(t0, dot(input.startU, t0))));
  if (u0 === undefined) u0 = unit(cross(t0, Math.abs(t0[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]))!;
  const frames: { u: V3; v: V3 }[] = [{ u: u0, v: cross(t0, u0) }];
  for (let index = 1; index < segments; index += 1) {
    const from = tangents[index - 1]!;
    const to = tangents[index]!;
    if (dot(from, to) < -0.9999) return { ok: false, message: "The sweep path doubles back on itself at a point, so the profile would fold over. Round the corner with an arc or spline." };
    const previous = frames[index - 1]!;
    frames.push({ u: turnBetween(previous.u, from, to), v: turnBetween(previous.v, from, to) });
  }
  // Cumulative distance for the twist.
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) distances.push(distances[index - 1]! + length(sub(points[index]!, points[index - 1]!)));
  const total = distances[distances.length - 1]! + (closed ? length(sub(points[0]!, points[points.length - 1]!)) : 0);
  const oriented = orientLoops(input.loops);
  const flat: P2[] = [...oriented.outer, ...oriented.holes.flat()];
  const loopSizes = [oriented.outer.length, ...oriented.holes.map((hole) => hole.length)];
  const centre = loopCentroid(oriented.outer);
  const twistRad = ((Number.isFinite(input.twistDeg) ? input.twistDeg! : 0) * Math.PI) / 180;
  const stationCount = points.length;
  const capNormal = (tangent: V3 | undefined, chord: V3): V3 | undefined => {
    const wanted = tangent === undefined ? undefined : unit(tangent);
    // Only a small correction: the true direction must lie within 20 degrees of the chord, and point the same way.
    return wanted !== undefined && dot(wanted, chord) > 0.94 ? wanted : undefined;
  };
  const startNormal = closed ? undefined : capNormal(input.startTangent, tangents[0]!);
  const endNormal = closed ? undefined : capNormal(input.endTangent, tangents[segments - 1]!);
  const rings: V3[][] = [];
  for (let station = 0; station < stationCount; station += 1) {
    const angle = total > 0 ? twistRad * (distances[station]! / total) : 0;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    const origin = points[station]!;
    const isEnd = station === points.length - 1 && !closed;
    const isStart = station === 0 && !closed;
    const incoming = closed ? (station + segments - 1) % segments : station - 1;
    const outgoing = station % segments;
    const ring: V3[] = [];
    for (const [x, y] of flat) {
      const dx = x - centre[0];
      const dy = y - centre[1];
      const a = centre[0] + dx * cosA - dy * sinA;
      const b = centre[1] + dx * sinA + dy * cosA;
      if (isStart || isEnd) {
        const frame = frames[isStart ? 0 : segments - 1]!;
        const flat = add(scale(frame.u, a), scale(frame.v, b));
        const normal = isStart ? startNormal : endNormal;
        if (normal === undefined) {
          ring.push(add(origin, flat));
        } else {
          // Slide the point along the chord direction onto the plane square to the true path direction.
          const chord = isStart ? tangents[0]! : tangents[segments - 1]!;
          ring.push(add(origin, add(flat, scale(chord, -dot(flat, normal) / dot(chord, normal)))));
        }
        continue;
      }
      // Mitre: carry the offset along the incoming piece to the bisector plane of the joint.
      const frame = frames[incoming]!;
      const offset = add(scale(frame.u, a), scale(frame.v, b));
      const bisector = unit(add(tangents[incoming]!, tangents[outgoing]!));
      const cosHalf = bisector === undefined ? 0 : dot(tangents[incoming]!, bisector);
      if (bisector === undefined || cosHalf < 0.1) return { ok: false, message: "The sweep path turns back too sharply at one of its corners. Round the corner with an arc, or use a gentler angle." };
      const slide = -dot(offset, bisector) / cosHalf;
      ring.push(add(origin, add(offset, scale(tangents[incoming]!, slide))));
    }
    rings.push(ring);
  }
  const caps = capTriangles(oriented);
  if (!caps.ok) return caps;
  if (closed) notes.push("The path is closed, so the sweep is a ring with no end caps.");
  return { ok: true, mesh: assembleSolid(rings, loopSizes, caps.triangles, caps.triangles, closed, twistRad !== 0), notes };
}

// ---------------------------------------------------------------------------------------------
// Rigid sweep along a straight direction (an oblique extrusion)
// ---------------------------------------------------------------------------------------------

export interface RigidSweepInput {
  /** The profile in the plane of its sketch, as world points on that plane (outer first). */
  readonly loops: Loops3;
  /** The profile plane's unit normal, which the twist turns about. */
  readonly normal: V3;
  /** The whole displacement of the far ring (direction times distance). */
  readonly shift: V3;
  readonly twistDeg?: number;
}

/** Translates a profile along `shift` (which need not be along the plane's normal), optionally twisting it about its centroid on the way. */
export function sweepRigid(input: RigidSweepInput): SolidMeshResult {
  const basisU = unit(cross(Math.abs(input.normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], input.normal));
  if (basisU === undefined) return { ok: false, message: "The sweep needs a profile plane with a direction." };
  const basisV = cross(input.normal, basisU);
  const to2 = (point: V3): P2 => [dot(point, basisU), dot(point, basisV)];
  const raw: Loops2 = { outer: input.loops.outer.map(to2), holes: input.loops.holes.map((hole) => hole.map(to2)) };
  const reversedOuter = signedArea2(raw.outer) < 0;
  const outer3 = reversedOuter ? [...input.loops.outer].reverse() : input.loops.outer;
  const holes3 = input.loops.holes.map((hole) => (signedArea2(hole.map(to2)) > 0 ? [...hole].reverse() : hole));
  const oriented: Loops2 = { outer: outer3.map(to2), holes: holes3.map((hole) => hole.map(to2)) };
  const flat = [...outer3, ...holes3.flat()];
  const loopSizes = [outer3.length, ...holes3.map((hole) => hole.length)];
  const centroid2 = loopCentroid(oriented.outer);
  const centre = add(add(scale(basisU, centroid2[0]), scale(basisV, centroid2[1])), scale(input.normal, dot(flat[0]!, input.normal)));
  const twist = ((Number.isFinite(input.twistDeg) ? input.twistDeg! : 0) * Math.PI) / 180;
  // One ring per station: a twist turns the profile a little between neighbouring stations (see twist-stations.ts), so the sides do not fold.
  const segments = twistSegments(input.twistDeg, flat.length);
  const stationRings: V3[][] = [];
  for (let station = 0; station <= segments; station += 1) {
    const fraction = station / segments;
    const angle = twist * fraction;
    stationRings.push(flat.map((point) => {
      const offset = sub(point, centre);
      const turned = angle === 0 ? offset : add(add(scale(offset, Math.cos(angle)), scale(cross(input.normal, offset), Math.sin(angle))), scale(input.normal, dot(input.normal, offset) * (1 - Math.cos(angle))));
      return add(add(centre, turned), scale(input.shift, fraction));
    }));
  }
  const caps = capTriangles(oriented);
  if (!caps.ok) return caps;
  // The cap triangles are counter-clockwise about the plane's normal, so the rings must run along the normal for the caps to face out.
  const along = dot(input.shift, input.normal);
  if (Math.abs(along) < 1e-6 * Math.max(1, length(input.shift))) return { ok: false, message: "The sweep direction is parallel to the profile's plane, which would flatten the solid. Give it a component off the plane." };
  const rings = along >= 0 ? stationRings : [...stationRings].reverse();
  return { ok: true, mesh: assembleSolid(rings, loopSizes, caps.triangles, caps.triangles, false, twist !== 0), notes: [] };
}

/** Turns every triangle inside out. */
export function flipped(mesh: SolidMesh): SolidMesh {
  const indices = [...mesh.indices];
  for (let index = 0; index + 2 < indices.length; index += 3) { const swap = indices[index + 1]!; indices[index + 1] = indices[index + 2]!; indices[index + 2] = swap; }
  return { positionsMm: mesh.positionsMm, indices };
}

/** Signed volume of a closed mesh. */
export function solidMeshVolume(mesh: SolidMesh): number {
  const p = mesh.positionsMm;
  let total = 0;
  for (let index = 0; index + 2 < mesh.indices.length; index += 3) {
    const a = mesh.indices[index]! * 3; const b = mesh.indices[index + 1]! * 3; const c = mesh.indices[index + 2]! * 3;
    total += p[a]! * (p[b + 1]! * p[c + 2]! - p[b + 2]! * p[c + 1]!) - p[a + 1]! * (p[b]! * p[c + 2]! - p[b + 2]! * p[c]!) + p[a + 2]! * (p[b]! * p[c + 1]! - p[b + 1]! * p[c]!);
  }
  return total / 6;
}

// ---------------------------------------------------------------------------------------------
// Loft between profiles on different planes
// ---------------------------------------------------------------------------------------------

function loopCentroid3(points: readonly V3[]): V3 {
  let sum: V3 = [0, 0, 0];
  for (const point of points) sum = add(sum, point);
  return scale(sum, 1 / points.length);
}

/** The area-vector (Newell) normal of a 3D loop: points along the direction its points turn counter-clockwise about. */
function loopNormal(points: readonly V3[]): V3 {
  let nx = 0; let ny = 0; let nz = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return [nx, ny, nz];
}

/** Adds points to a closed loop (splitting its longest edges) until it has `count`; the points it already has stay. */
export function refineLoop3(points: readonly V3[], count: number): V3[] {
  const result = [...points];
  while (result.length < count) {
    let longest = 0;
    let longestLength = -1;
    for (let index = 0; index < result.length; index += 1) {
      const size = length(sub(result[(index + 1) % result.length]!, result[index]!));
      if (size > longestLength) { longestLength = size; longest = index; }
    }
    const a = result[longest]!;
    const b = result[(longest + 1) % result.length]!;
    result.splice(longest + 1, 0, scale(add(a, b), 0.5));
  }
  return result;
}

/** `count` points spaced evenly by arc length around a closed 3D loop, starting at its first point. */
export function resampleLoop3(points: readonly V3[], count: number): V3[] {
  const lengths: number[] = [];
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const size = length(sub(points[(index + 1) % points.length]!, points[index]!));
    lengths.push(size);
    total += size;
  }
  const result: V3[] = [];
  let segment = 0;
  let before = 0;
  for (let step = 0; step < count; step += 1) {
    const target = (total * step) / count;
    while (segment < lengths.length - 1 && before + lengths[segment]! < target - 1e-12) { before += lengths[segment]!; segment += 1; }
    const a = points[segment]!;
    const b = points[(segment + 1) % points.length]!;
    const t = lengths[segment]! < 1e-12 ? 0 : (target - before) / lengths[segment]!;
    result.push(add(a, scale(sub(b, a), t)));
  }
  return result;
}

function bestShift(from: readonly V3[], to: readonly V3[]): number {
  let best = 0;
  let bestCost = Infinity;
  for (let shift = 0; shift < to.length; shift += 1) {
    let cost = 0;
    for (let index = 0; index < from.length; index += 1) {
      const d = sub(from[index]!, to[(index + shift) % to.length]!);
      cost += dot(d, d);
    }
    if (cost < bestCost) { bestCost = cost; best = shift; }
  }
  return best;
}

export interface LoftInput {
  readonly from: Loops3;
  readonly to: Loops3;
  readonly continuity: "position" | "tangent" | "curvature";
  /** 0 is a straight loft whatever the continuity; 1 the plain ease; up to 2 over-applies it. */
  readonly tangencyWeight?: number;
  /** A guide curve: the ring centres follow it from the first ring to the last. */
  readonly rail?: readonly V3[];
  readonly rings?: number;
}

/** Eases a position along the loft: position is linear, tangent is smoothstep, curvature is smootherstep. */
function easeFor(continuity: LoftInput["continuity"], weight: number): (t: number) => number {
  if (continuity === "position") return (t) => t;
  const target = continuity === "curvature" ? (t: number): number => t * t * t * (t * (t * 6 - 15) + 10) : (t: number): number => t * t * (3 - 2 * t);
  return (t) => t + weight * (target(t) - t);
}

function planeBasis(normal: V3): { readonly e1: V3; readonly e2: V3 } {
  const e1 = unit(cross(Math.abs(normal[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0], normal))!;
  return { e1, e2: cross(normal, e1) };
}

/** Lofts between two profiles that may lie on different planes. Loops are matched by order (outer, then holes) and aligned to twist as little as possible. */
export function loftProfiles(input: LoftInput): SolidMeshResult {
  if (input.from.holes.length !== input.to.holes.length) {
    return { ok: false, message: `A loft needs the same number of holes in both profiles (${input.from.holes.length} and ${input.to.holes.length}).` };
  }
  const centreFrom = loopCentroid3(input.from.outer);
  const centreTo = loopCentroid3(input.to.outer);
  let travel = unit(sub(centreTo, centreFrom));
  if (travel === undefined) travel = unit(loopNormal(input.from.outer));
  if (travel === undefined) return { ok: false, message: "The first profile has no area." };
  const direction = travel;
  const ccw = (loop: readonly V3[], wantCounterClockwise: boolean): V3[] => {
    const facing = dot(loopNormal(loop), direction) >= 0;
    return facing === wantCounterClockwise ? [...loop] : [...loop].reverse();
  };
  const aligned: { readonly a: V3[]; readonly b: V3[] }[] = [];
  const pairs: readonly [readonly V3[], readonly V3[], boolean][] = [
    [input.from.outer, input.to.outer, true],
    ...input.from.holes.map((hole, index): [readonly V3[], readonly V3[], boolean] => [hole, input.to.holes[index]!, false])
  ];
  for (const [first, second, outer] of pairs) {
    const firstLoop = ccw(cleanLoop(first as readonly (readonly number[])[]) as unknown as V3[], outer);
    const secondLoop = ccw(cleanLoop(second as readonly (readonly number[])[]) as unknown as V3[], outer);
    // Both loops get the same number of points by adding points to the shorter one, so the corners of neither are lost.
    const count = Math.max(firstLoop.length, secondLoop.length, outer ? 24 : 12);
    const a = refineLoop3(firstLoop, count);
    const b = refineLoop3(secondLoop, count);
    const shift = bestShift(a, b);
    aligned.push({ a, b: b.map((_, index) => b[(index + shift) % b.length]!) });
  }
  const weight = input.continuity === "position" ? 0 : Math.max(0, Math.min(2, Number.isFinite(input.tangencyWeight) ? input.tangencyWeight! : 1));
  const ease = easeFor(input.continuity, weight);
  const stationCount = input.continuity === "position" && input.rail === undefined ? 2 : Math.max(2, input.rings ?? 12);
  const rail = input.rail === undefined ? undefined : resampleOpen(input.rail, stationCount);
  const rings: V3[][] = [];
  for (let station = 0; station < stationCount; station += 1) {
    const linear = station / (stationCount - 1);
    const s = ease(linear);
    let offset: V3 = [0, 0, 0];
    if (rail !== undefined) {
      const expected = add(centreFrom, scale(sub(centreTo, centreFrom), linear));
      offset = sub(rail[station]!, expected);
    }
    const ring: V3[] = [];
    for (const { a, b } of aligned) for (let index = 0; index < a.length; index += 1) ring.push(add(add(a[index]!, scale(sub(b[index]!, a[index]!), s)), offset));
    rings.push(ring);
  }
  const loopSizes = aligned.map((pair) => pair.a.length);
  // Cap each end in its own plane, wound counter-clockwise about the direction of travel.
  const capOf = (pick: (pair: { a: V3[]; b: V3[] }) => V3[]): { readonly ok: true; readonly triangles: readonly number[] } | { readonly ok: false; readonly message: string } => {
    const { e1, e2 } = planeBasis(direction);
    const project = (point: V3): P2 => [dot(point, e1), dot(point, e2)];
    const loops = aligned.map((pair) => pick(pair).map(project));
    return capTriangles({ outer: loops[0]!, holes: loops.slice(1) });
  };
  const startCap = capOf((pair) => pair.a);
  if (!startCap.ok) return startCap;
  const endCap = capOf((pair) => pair.b);
  if (!endCap.ok) return endCap;
  const mesh = assembleSolid(rings, loopSizes, startCap.triangles, endCap.triangles, false);
  return { ok: true, mesh, notes: [] };
}

/** Resamples an open 3D polyline into `count` points at equal arc-length steps, keeping both ends. */
export function resampleOpen(path: readonly V3[], count: number): V3[] {
  if (path.length === 0) return [];
  if (path.length === 1 || count < 2) return Array.from({ length: Math.max(1, count) }, () => path[0]!);
  const lengths: number[] = [];
  let total = 0;
  for (let index = 0; index + 1 < path.length; index += 1) { const size = length(sub(path[index + 1]!, path[index]!)); lengths.push(size); total += size; }
  if (total < 1e-9) return Array.from({ length: count }, () => path[0]!);
  const out: V3[] = [];
  for (let step = 0; step < count; step += 1) {
    if (step === count - 1) { out.push(path[path.length - 1]!); continue; }
    const target = (total * step) / (count - 1);
    let before = 0;
    for (let segment = 0; segment < lengths.length; segment += 1) {
      if (before + lengths[segment]! >= target - 1e-9) {
        const t = lengths[segment]! < 1e-12 ? 0 : (target - before) / lengths[segment]!;
        out.push(add(path[segment]!, scale(sub(path[segment + 1]!, path[segment]!), t)));
        break;
      }
      before += lengths[segment]!;
    }
  }
  return out;
}
