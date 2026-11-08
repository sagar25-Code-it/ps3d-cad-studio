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

export interface EdgeFlangeSpec {
  readonly edgeIndex: number;
  readonly innerRadiusMm: number;
  readonly flangeLengthMm: number;
  readonly angleDeg: number;
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
  const section = bentStripSection({ legMm: 0, flangeLengthMm: spec.flangeLengthMm, angleDeg: spec.angleDeg, innerRadiusMm: spec.innerRadiusMm, thicknessMm: thickness, widthMm: edge.lengthMm });
  const strip = tessellateExtrude(section, edge.lengthMm, "xy");
  if (strip.positionsMm.length < 9) return { ok: false, message: "The flange could not be built." };
  const direction = unit3([edge.endMm[0] - edge.startMm[0], edge.endMm[1] - edge.startMm[1], edge.endMm[2] - edge.startMm[2]]);
  // The strip's frame is (u, v, s) = (outward, normal, along the edge); a left-handed mapping needs its winding flipped.
  const flip = dot3(edge.outward, cross3(frame.normal, direction)) < 0;
  const stripVertices = strip.positionsMm.length / 3;
  const world: number[] = [];
  for (let i = 0; i < stripVertices; i += 1) {
    const u = strip.positionsMm[i * 3]!;
    const v = strip.positionsMm[i * 3 + 1]!;
    const s = strip.positionsMm[i * 3 + 2]!;
    for (let axis = 0; axis < 3; axis += 1) world.push(edge.startMm[axis]! + edge.outward[axis]! * u + frame.normal[axis]! * (v - thickness) + direction[axis]! * s);
  }
  const stripTriangles: number[] = [];
  for (let corner = 0; corner + 2 < strip.indices.length; corner += 3) {
    const a = strip.indices[corner]!;
    const b = strip.indices[corner + 1]!;
    const c = strip.indices[corner + 2]!;
    // The flange's end wall at u = 0 is what the plate's side wall replaces.
    if ([a, b, c].every((index) => Math.abs(strip.positionsMm[index * 3]!) < 1e-6)) continue;
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
    keptBody.push(...triangle);
  }
  if (removed < 2) return { ok: false, message: `Edge ${spec.edgeIndex} has no flat side wall left to bend from; it may already carry a flange.` };
  const merged = [...body.positionsMm, ...world];
  const combined = [...keptBody, ...stripTriangles.map((index) => index + bodyVertices)];
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
