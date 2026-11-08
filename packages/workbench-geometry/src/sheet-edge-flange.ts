import { bentStripSection } from "./sheet-metal.js";
import { tessellateExtrude } from "./tessellate.js";

type Vec3 = readonly [number, number, number];

/** One straight boundary edge of a sheet's top face, with the in-plane direction pointing away from the sheet. */
export interface SheetEdge {
  readonly index: number;
  readonly startMm: Vec3;
  readonly endMm: Vec3;
  /** Unit vector in the sheet plane, perpendicular to the edge, pointing out of the sheet. */
  readonly outward: Vec3;
  readonly lengthMm: number;
}

export interface SheetFrame {
  readonly normal: Vec3;
  readonly topMm: number;
  readonly bottomMm: number;
  readonly thicknessMm: number;
  readonly edges: readonly SheetEdge[];
}

export interface SheetMesh {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
}

const KEY_SCALE = 1e5;

function pointKey(x: number, y: number, z: number): string {
  return `${Math.round(x * KEY_SCALE)},${Math.round(y * KEY_SCALE)},${Math.round(z * KEY_SCALE)}`;
}

function unit3(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  return length < 1e-12 ? [0, 0, 0] : [vector[0] / length, vector[1] / length, vector[2] / length];
}

const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/**
 * Finds the top face of a plate (the planar cap furthest along `normal`), its thickness, and the straight boundary edges of
 * that face in a stable order. These edges are what an edge flange attaches to; the index in this list is the edge's name.
 */
export function sheetFrameOf(mesh: SheetMesh, normalIn: Vec3): SheetFrame | undefined {
  const normal = unit3(normalIn);
  const vertexCount = Math.floor(mesh.positionsMm.length / 3);
  if (vertexCount < 3 || (normal[0] === 0 && normal[1] === 0 && normal[2] === 0)) return undefined;
  const position = (index: number): Vec3 => [mesh.positionsMm[index * 3]!, mesh.positionsMm[index * 3 + 1]!, mesh.positionsMm[index * 3 + 2]!];
  const heights: number[] = [];
  let top = -Infinity;
  let bottom = Infinity;
  for (let i = 0; i < vertexCount; i += 1) {
    const height = dot3(position(i), normal);
    heights.push(height);
    if (height > top) top = height;
    if (height < bottom) bottom = height;
  }
  const thickness = top - bottom;
  if (!(thickness > 1e-6)) return undefined;
  const tolerance = Math.max(1e-6, thickness * 1e-4);
  const edgeUses = new Map<string, { a: number; b: number; third: number; count: number }>();
  for (let corner = 0; corner + 2 < mesh.indices.length; corner += 3) {
    const triangle = [mesh.indices[corner]!, mesh.indices[corner + 1]!, mesh.indices[corner + 2]!];
    if (!triangle.every((index) => index >= 0 && index < vertexCount && heights[index]! >= top - tolerance)) continue;
    for (let side = 0; side < 3; side += 1) {
      const a = triangle[side]!;
      const b = triangle[(side + 1) % 3]!;
      const third = triangle[(side + 2) % 3]!;
      const pa = position(a);
      const pb = position(b);
      const ka = pointKey(pa[0], pa[1], pa[2]);
      const kb = pointKey(pb[0], pb[1], pb[2]);
      const key = ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
      const existing = edgeUses.get(key);
      if (existing === undefined) edgeUses.set(key, { a, b, third, count: 1 });
      else existing.count += 1;
    }
  }
  const edges: SheetEdge[] = [];
  for (const use of edgeUses.values()) {
    if (use.count !== 1) continue;
    const start = position(use.a);
    const end = position(use.b);
    const length = Math.hypot(end[0] - start[0], end[1] - start[1], end[2] - start[2]);
    if (length < 1e-6) continue;
    const direction = unit3([end[0] - start[0], end[1] - start[1], end[2] - start[2]]);
    const third = position(use.third);
    const toThird: Vec3 = [third[0] - start[0], third[1] - start[1], third[2] - start[2]];
    const along = dot3(toThird, direction);
    const inward = unit3([toThird[0] - direction[0] * along, toThird[1] - direction[1] * along, toThird[2] - direction[2] * along]);
    edges.push({ index: edges.length, startMm: start, endMm: end, outward: [-inward[0], -inward[1], -inward[2]], lengthMm: length });
  }
  return { normal, topMm: top, bottomMm: bottom, thicknessMm: thickness, edges };
}

/** The straight edge of the frame closest to a point (for example where the user clicked), with how far away it is. */
export function nearestFrameEdge(frame: SheetFrame, pointMm: Vec3): { readonly index: number; readonly distanceMm: number } | undefined {
  let best: { index: number; distanceMm: number } | undefined;
  for (const edge of frame.edges) {
    const along: Vec3 = [edge.endMm[0] - edge.startMm[0], edge.endMm[1] - edge.startMm[1], edge.endMm[2] - edge.startMm[2]];
    const lengthSquared = dot3(along, along);
    const toPoint: Vec3 = [pointMm[0] - edge.startMm[0], pointMm[1] - edge.startMm[1], pointMm[2] - edge.startMm[2]];
    const t = lengthSquared < 1e-12 ? 0 : Math.max(0, Math.min(1, dot3(toPoint, along) / lengthSquared));
    const distance = Math.hypot(toPoint[0] - along[0] * t, toPoint[1] - along[1] * t, toPoint[2] - along[2] * t);
    if (best === undefined || distance < best.distanceMm - 1e-9) best = { index: edge.index, distanceMm: distance };
  }
  return best;
}

export interface EdgeFlangeSpec {
  readonly edgeIndex: number;
  readonly innerRadiusMm: number;
  readonly flangeLengthMm: number;
  readonly angleDeg: number;
  /** How far the flange stops short of the edge's start and end, leaving a corner relief gap where a neighbouring flange meets it. */
  readonly reliefStartMm?: number;
  readonly reliefEndMm?: number;
  /**
   * Miter joint at the start or end of the flange: tan(turn / 2) where `turn` is the signed angle (left turn positive, seen from
   * the sheet normal) from this edge to its neighbour in the chain. The flange's end is then cut on the vertical bisector plane of
   * the corner instead of square: a point at outward offset u runs on by u × tan(turn / 2), so the next flange meets it exactly.
   * A mitred end ignores the corner relief.
   */
  readonly mitreStartTan?: number;
  readonly mitreEndTan?: number;
  /**
   * True when the neighbour across the mitre is already in `body`: this flange then adds no end face there and removes the
   * neighbour's, so the two flanges are joined instead of closed off against each other.
   */
  readonly mitreStartJoin?: boolean;
  readonly mitreEndJoin?: boolean;
}

/**
 * Which ends of a flanged edge meet another flanged edge at a corner. `flangedEdges` are the edge indices carrying flanges
 * (the edge itself may be listed; it is ignored).
 */
export function sharedFlangeEnds(frame: SheetFrame, edgeIndex: number, flangedEdges: readonly number[]): { readonly start: boolean; readonly end: boolean } {
  const edge = frame.edges[edgeIndex];
  if (edge === undefined) return { start: false, end: false };
  const startKey = pointKey(edge.startMm[0], edge.startMm[1], edge.startMm[2]);
  const endKey = pointKey(edge.endMm[0], edge.endMm[1], edge.endMm[2]);
  let start = false;
  let end = false;
  for (const other of flangedEdges) {
    if (other === edgeIndex) continue;
    const neighbour = frame.edges[other];
    if (neighbour === undefined) continue;
    const keys = [pointKey(neighbour.startMm[0], neighbour.startMm[1], neighbour.startMm[2]), pointKey(neighbour.endMm[0], neighbour.endMm[1], neighbour.endMm[2])];
    if (keys.includes(startKey)) start = true;
    if (keys.includes(endKey)) end = true;
  }
  return { start, end };
}

/** A flange as far as corner relief goes: its edge and the gap it asks for at a corner it shares with another flange. */
export interface ReliefFlange {
  readonly edgeIndex: number;
  readonly reliefMm: number;
}

/**
 * The relief to leave at each end of a flange. A corner needs one gap between its two flanges: the larger of the two flanges'
 * relief values, shared half and half, and only at an end where another flange meets this one. So asking for a relief on either
 * flange of a corner is enough, and a later flange cannot leave an earlier one without its gap.
 */
export function flangeReliefs(frame: SheetFrame, edgeIndex: number, flanges: readonly ReliefFlange[]): { readonly startMm: number; readonly endMm: number } {
  const edge = frame.edges[edgeIndex];
  const own = flanges.find((flange) => flange.edgeIndex === edgeIndex);
  if (edge === undefined || own === undefined) return { startMm: 0, endMm: 0 };
  const startKey = pointKey(edge.startMm[0], edge.startMm[1], edge.startMm[2]);
  const endKey = pointKey(edge.endMm[0], edge.endMm[1], edge.endMm[2]);
  let start = 0;
  let end = 0;
  for (const other of flanges) {
    if (other.edgeIndex === edgeIndex) continue;
    const neighbour = frame.edges[other.edgeIndex];
    if (neighbour === undefined) continue;
    const keys = [pointKey(neighbour.startMm[0], neighbour.startMm[1], neighbour.startMm[2]), pointKey(neighbour.endMm[0], neighbour.endMm[1], neighbour.endMm[2])];
    const gap = Math.max(own.reliefMm, other.reliefMm);
    if (keys.includes(startKey)) start = Math.max(start, gap / 2);
    if (keys.includes(endKey)) end = Math.max(end, gap / 2);
  }
  return { startMm: start, endMm: end };
}

export type EdgeFlangeResult =
  | { readonly ok: true; readonly positionsMm: readonly number[]; readonly indices: readonly number[] }
  | { readonly ok: false; readonly message: string };

/**
 * Bends a flange up from one top-face edge of a plate. `base` is the plate as it was first made (it names the edges and the
 * thickness) and `body` is the plate as it is now, possibly already carrying other flanges. The plate's side wall on that
 * edge and the flange's matching end wall are removed and the two meshes are welded, so the result stays one closed solid
 * with the flange's inner and outer surfaces running on from the plate's top and bottom faces.
 */
export function attachEdgeFlange(body: SheetMesh, base: SheetMesh, normal: Vec3, spec: EdgeFlangeSpec): EdgeFlangeResult {
  const frame = sheetFrameOf(base, normal);
  if (frame === undefined) return { ok: false, message: "This body has no flat top face with a thickness to bend a flange from." };
  const edge = frame.edges[spec.edgeIndex];
  if (edge === undefined) return { ok: false, message: `There is no edge ${spec.edgeIndex}; this plate has ${frame.edges.length} (0 to ${frame.edges.length - 1}).` };
  if (!(spec.flangeLengthMm > 0) || !(spec.innerRadiusMm >= 0) || !(spec.angleDeg > 0 && spec.angleDeg <= 180)) return { ok: false, message: "A flange needs a positive length, a non-negative bend radius and an angle from 0° to 180°." };
  const thickness = frame.thicknessMm;
  const mitreStart = spec.mitreStartTan;
  const mitreEnd = spec.mitreEndTan;
  if ((mitreStart !== undefined && !Number.isFinite(mitreStart)) || (mitreEnd !== undefined && !Number.isFinite(mitreEnd))) return { ok: false, message: "A mitre joint needs a finite corner angle." };
  // A mitred end is cut on the corner's bisector plane, so it has no relief gap.
  const reliefStart = mitreStart === undefined ? spec.reliefStartMm ?? 0 : 0;
  const reliefEnd = mitreEnd === undefined ? spec.reliefEndMm ?? 0 : 0;
  if (!(reliefStart >= 0) || !(reliefEnd >= 0)) return { ok: false, message: "A corner relief cannot be negative." };
  const span = edge.lengthMm - reliefStart - reliefEnd;
  if (!(span > 1e-3)) return { ok: false, message: `The corner relief (${(reliefStart + reliefEnd).toFixed(2)} mm) leaves no flange on edge ${spec.edgeIndex}, which is ${edge.lengthMm.toFixed(2)} mm long.` };
  const section = bentStripSection({ legMm: 0, flangeLengthMm: spec.flangeLengthMm, angleDeg: spec.angleDeg, innerRadiusMm: spec.innerRadiusMm, thicknessMm: thickness, widthMm: span });
  const strip = tessellateExtrude(section, span, "xy");
  if (strip.positionsMm.length < 9) return { ok: false, message: "The flange could not be built." };
  const direction = unit3([edge.endMm[0] - edge.startMm[0], edge.endMm[1] - edge.startMm[1], edge.endMm[2] - edge.startMm[2]]);
  // How far along the edge (from its start) the flange runs at outward offset u: square ends, relief gaps or mitre cuts.
  const alongStart = (u: number): number => (mitreStart === undefined ? reliefStart : -u * mitreStart);
  const alongEnd = (u: number): number => (mitreEnd === undefined ? edge.lengthMm - reliefEnd : edge.lengthMm + u * mitreEnd);
  if (mitreStart !== undefined || mitreEnd !== undefined) {
    for (const [u] of section) {
      if (!(alongEnd(u) - alongStart(u) > 1e-3)) return { ok: false, message: `The mitre cuts the flange away: edge ${spec.edgeIndex} is too short for a flange this deep at that corner.` };
    }
  }
  // The strip's frame is (u, v, s) = (outward, normal, along the edge); a left-handed mapping needs its winding flipped.
  const flip = dot3(edge.outward, cross3(frame.normal, direction)) < 0;
  const stripVertices = strip.positionsMm.length / 3;
  const world: number[] = [];
  for (let i = 0; i < stripVertices; i += 1) {
    const u = strip.positionsMm[i * 3]!;
    const v = strip.positionsMm[i * 3 + 1]!;
    const s = strip.positionsMm[i * 3 + 2]!;
    const along = s < span / 2 ? alongStart(u) : alongEnd(u);
    for (let axis = 0; axis < 3; axis += 1) world.push(edge.startMm[axis]! + edge.outward[axis]! * u + frame.normal[axis]! * (v - thickness) + direction[axis]! * along);
  }
  // A joined mitre has no end face of its own; the face is shared with the neighbour and both are left out.
  const isStartFace = (a: number, b: number, c: number): boolean => [a, b, c].every((index) => strip.positionsMm[index * 3 + 2]! < 1e-9);
  const isEndFace = (a: number, b: number, c: number): boolean => [a, b, c].every((index) => strip.positionsMm[index * 3 + 2]! > span - 1e-9);
  const capVertexKeys = new Set<string>();
  const stripTriangles: number[] = [];
  for (let corner = 0; corner + 2 < strip.indices.length; corner += 3) {
    const a = strip.indices[corner]!;
    const b = strip.indices[corner + 1]!;
    const c = strip.indices[corner + 2]!;
    // The flange's end wall at u = 0 is what the plate's side wall replaces.
    if ([a, b, c].every((index) => Math.abs(strip.positionsMm[index * 3]!) < 1e-6)) continue;
    const joinedFace = (spec.mitreStartJoin === true && mitreStart !== undefined && isStartFace(a, b, c)) || (spec.mitreEndJoin === true && mitreEnd !== undefined && isEndFace(a, b, c));
    if (joinedFace) {
      for (const index of [a, b, c]) capVertexKeys.add(pointKey(world[index * 3]!, world[index * 3 + 1]!, world[index * 3 + 2]!));
      continue;
    }
    stripTriangles.push(a, flip ? c : b, flip ? b : c);
  }
  const down = (point: Vec3): Vec3 => [point[0] - frame.normal[0] * thickness, point[1] - frame.normal[1] * thickness, point[2] - frame.normal[2] * thickness];
  const bottomStart = down(edge.startMm);
  const bottomEnd = down(edge.endMm);
  const corners = [
    pointKey(edge.startMm[0], edge.startMm[1], edge.startMm[2]),
    pointKey(edge.endMm[0], edge.endMm[1], edge.endMm[2]),
    pointKey(bottomStart[0], bottomStart[1], bottomStart[2]),
    pointKey(bottomEnd[0], bottomEnd[1], bottomEnd[2])
  ];
  const bodyVertices = body.positionsMm.length / 3;
  const keptBody: number[] = [];
  let removed = 0;
  for (let corner = 0; corner + 2 < body.indices.length; corner += 3) {
    const triangle = [body.indices[corner]!, body.indices[corner + 1]!, body.indices[corner + 2]!];
    const onWall = triangle.every((index) => corners.includes(pointKey(body.positionsMm[index * 3]!, body.positionsMm[index * 3 + 1]!, body.positionsMm[index * 3 + 2]!)));
    if (onWall) { removed += 1; continue; }
    // The neighbour's mitre face is the one this flange joins to, so it goes.
    if (capVertexKeys.size > 0 && triangle.every((index) => capVertexKeys.has(pointKey(body.positionsMm[index * 3]!, body.positionsMm[index * 3 + 1]!, body.positionsMm[index * 3 + 2]!)))) continue;
    keptBody.push(...triangle);
  }
  if (removed < 2) return { ok: false, message: `Edge ${spec.edgeIndex} has no flat side wall left to bend from; it may already carry a flange.` };
  const extraPositions: number[] = [];
  const extraTriangles: number[] = [];
  const addVertex = (point: Vec3): number => { extraPositions.push(point[0], point[1], point[2]); return bodyVertices + world.length / 3 + extraPositions.length / 3 - 1; };
  const along = (point: Vec3, distance: number): Vec3 => [point[0] + direction[0] * distance, point[1] + direction[1] * distance, point[2] + direction[2] * distance];
  if (reliefStart > 0 || reliefEnd > 0) {
    // The flange stops short of the edge's ends, so the plate's side wall stays at the relief and the plate's top and bottom
    // faces get matching vertices on that edge (their triangles on this edge are split there).
    const splitsTop: Vec3[] = [];
    const splitsBottom: Vec3[] = [];
    if (reliefStart > 0) { splitsTop.push(along(edge.startMm, reliefStart)); splitsBottom.push(along(bottomStart, reliefStart)); }
    if (reliefEnd > 0) { splitsTop.push(along(edge.endMm, -reliefEnd)); splitsBottom.push(along(bottomEnd, -reliefEnd)); }
    const topKeys = [corners[0]!, corners[1]!];
    const bottomKeys = [corners[2]!, corners[3]!];
    const splitIndex = new Map<string, number>();
    const splitVertex = (point: Vec3): number => {
      const key = pointKey(point[0], point[1], point[2]);
      let found = splitIndex.get(key);
      if (found === undefined) { found = addVertex(point); splitIndex.set(key, found); }
      return found;
    };
    const splitEdgeOf = (triangle: readonly number[], pair: readonly string[], splits: readonly Vec3[]): number[] | undefined => {
      const keys = triangle.map((index) => pointKey(body.positionsMm[index * 3]!, body.positionsMm[index * 3 + 1]!, body.positionsMm[index * 3 + 2]!));
      for (let side = 0; side < 3; side += 1) {
        const k0 = keys[side]!;
        const k1 = keys[(side + 1) % 3]!;
        if (!((k0 === pair[0] && k1 === pair[1]) || (k0 === pair[1] && k1 === pair[0]))) continue;
        const v0 = triangle[side]!;
        const v1 = triangle[(side + 1) % 3]!;
        const third = triangle[(side + 2) % 3]!;
        const middle = splits.map((point) => splitVertex(point));
        const chain = k0 === pair[0] ? [v0, ...middle, v1] : [v0, ...middle.slice().reverse(), v1];
        const out: number[] = [];
        for (let i = 0; i + 1 < chain.length; i += 1) out.push(chain[i]!, chain[i + 1]!, third);
        return out;
      }
      return undefined;
    };
    const rebuilt: number[] = [];
    for (let corner = 0; corner + 2 < keptBody.length; corner += 3) {
      const triangle = [keptBody[corner]!, keptBody[corner + 1]!, keptBody[corner + 2]!];
      const replaced = splitEdgeOf(triangle, topKeys, splitsTop) ?? splitEdgeOf(triangle, bottomKeys, splitsBottom);
      rebuilt.push(...(replaced ?? triangle));
    }
    keptBody.length = 0;
    keptBody.push(...rebuilt);
    const wallPiece = (from: Vec3, to: Vec3): void => {
      const t0 = addVertex(from);
      const t1 = addVertex(to);
      const b0 = addVertex(down(from));
      const b1 = addVertex(down(to));
      if (dot3(cross3(frame.normal, direction), edge.outward) > 0) extraTriangles.push(t0, t1, b1, t0, b1, b0);
      else extraTriangles.push(t0, b1, t1, t0, b0, b1);
    };
    if (reliefStart > 0) wallPiece(edge.startMm, along(edge.startMm, reliefStart));
    if (reliefEnd > 0) wallPiece(along(edge.endMm, -reliefEnd), edge.endMm);
  }
  const merged = [...body.positionsMm, ...world, ...extraPositions];
  const combined = [...keptBody, ...stripTriangles.map((index) => index + bodyVertices), ...extraTriangles];
  // Weld coincident vertices so the flange shares the plate's edge vertices.
  const remap = new Map<string, number>();
  const positions: number[] = [];
  const mapIndex = new Array<number>(merged.length / 3);
  for (let i = 0; i < merged.length / 3; i += 1) {
    const key = pointKey(merged[i * 3]!, merged[i * 3 + 1]!, merged[i * 3 + 2]!);
    let target = remap.get(key);
    if (target === undefined) {
      target = positions.length / 3;
      remap.set(key, target);
      positions.push(merged[i * 3]!, merged[i * 3 + 1]!, merged[i * 3 + 2]!);
    }
    mapIndex[i] = target;
  }
  const indices: number[] = [];
  for (let corner = 0; corner + 2 < combined.length; corner += 3) {
    const a = mapIndex[combined[corner]!]!;
    const b = mapIndex[combined[corner + 1]!]!;
    const c = mapIndex[combined[corner + 2]!]!;
    if (a !== b && b !== c && a !== c) indices.push(a, b, c);
  }
  return { ok: true, positionsMm: positions, indices };
}
