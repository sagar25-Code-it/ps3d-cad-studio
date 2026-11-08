import { analyzeFaces, cross, dot, scale, sub, add, unit, type MeshLike, type V3 } from "./face-analysis.js";

/**
 * Flex: bend or twist a closed body with a vertex transform.
 *
 * A mesh with a few big triangles cannot bend, so the body is first cut along planes square to the bend (or twist) direction;
 * every triangle that crosses a plane is split, and the two triangles that share an edge split it at the same point, so the mesh
 * stays closed. Each vertex is then carried to its place on the arc (bend) or turned about the axis (twist).
 */
export interface FlexParams {
  readonly mode: "bend" | "twist";
  /** Degrees, right-handed about the axis. A bend is limited to 180. */
  readonly angleDeg: number;
  readonly axisPointMm: V3;
  readonly axisDirectionMm: V3;
  /** Bend: the direction the bend runs along (square to the axis). Absent takes the direction the body reaches furthest. */
  readonly lengthDirectionMm?: V3 | undefined;
  /** Bend: the length of the curved zone from the axis point. Absent bends over the rest of the body. */
  readonly zoneLengthMm?: number | undefined;
}

export type FlexResult =
  | { readonly ok: true; readonly positionsMm: readonly number[]; readonly indices: readonly number[]; readonly notes: readonly string[] }
  | { readonly ok: false; readonly message: string };

const MAX_TRIANGLES = 120_000;

/** Welds the mesh and cuts it along the given planes (unit normal, offset). Returns the welded, split mesh. */
export function sliceMesh(mesh: MeshLike, planes: readonly { readonly normal: V3; readonly offset: number }[]): { readonly positions: V3[]; readonly triangles: [number, number, number][] } | string {
  const positions: V3[] = [];
  const byKey = new Map<string, number>();
  const weld = new Array<number>(mesh.positionsMm.length / 3);
  for (let i = 0; i < weld.length; i += 1) {
    const x = mesh.positionsMm[i * 3]!; const y = mesh.positionsMm[i * 3 + 1]!; const z = mesh.positionsMm[i * 3 + 2]!;
    const key = `${Math.round(x / 1e-5)},${Math.round(y / 1e-5)},${Math.round(z / 1e-5)}`;
    let id = byKey.get(key);
    if (id === undefined) { id = positions.length; byKey.set(key, id); positions.push([x, y, z]); }
    weld[i] = id;
  }
  let triangles: [number, number, number][] = [];
  for (let t = 0; t + 2 < mesh.indices.length; t += 3) {
    const a = weld[mesh.indices[t]!]!; const b = weld[mesh.indices[t + 1]!]!; const c = weld[mesh.indices[t + 2]!]!;
    if (a !== b && b !== c && a !== c) triangles.push([a, b, c]);
  }
  const eps = 1e-9;
  for (const plane of planes) {
    const side: number[] = positions.map((p) => { const d = dot(plane.normal, p) - plane.offset; return Math.abs(d) < eps ? 0 : d; });
    const splits = new Map<string, number>();
    const split = (a: number, b: number): number => {
      const lo = Math.min(a, b); const hi = Math.max(a, b);
      const key = `${lo}|${hi}`;
      let id = splits.get(key);
      if (id === undefined) {
        const t = side[lo]! / (side[lo]! - side[hi]!);
        const p0 = positions[lo]!; const p1 = positions[hi]!;
        id = positions.length;
        positions.push([p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t]);
        side.push(0);
        splits.set(key, id);
      }
      return id;
    };
    const next: [number, number, number][] = [];
    for (const triangle of triangles) {
      const s = triangle.map((v) => Math.sign(side[v]!));
      const hasPositive = s.some((value) => value > 0);
      const hasNegative = s.some((value) => value < 0);
      if (!hasPositive || !hasNegative) { next.push(triangle); continue; }
      // Rotate so the corner that is alone on its side (or the one on the plane) comes first.
      let rotation = 0;
      const zeroAt = s.indexOf(0);
      if (zeroAt >= 0) rotation = zeroAt;
      else rotation = s.findIndex((value, index) => s.filter((other, otherIndex) => otherIndex !== index && other === value).length === 0);
      const [a, b, c] = [triangle[rotation]!, triangle[(rotation + 1) % 3]!, triangle[(rotation + 2) % 3]!];
      if (zeroAt >= 0) {
        const m = split(b, c);
        next.push([a, b, m], [a, m, c]);
      } else {
        const p = split(a, b); const q = split(a, c);
        next.push([a, p, q], [p, b, c], [p, c, q]);
      }
    }
    triangles = next;
    if (triangles.length > MAX_TRIANGLES) return "The body has too many triangles to bend; simplify it first.";
  }
  return { positions, triangles };
}

/** Two unit vectors that, with `axis`, make a right-handed frame. */
function frameAround(axis: V3): readonly [V3, V3] {
  const helper: V3 = Math.abs(axis[0]) <= Math.abs(axis[1]) && Math.abs(axis[0]) <= Math.abs(axis[2]) ? [1, 0, 0] : Math.abs(axis[1]) <= Math.abs(axis[2]) ? [0, 1, 0] : [0, 0, 1];
  const e1 = unit(cross(axis, helper))!;
  return [e1, cross(axis, e1)];
}

export function flexBody(mesh: MeshLike, params: FlexParams): FlexResult {
  const axis = unit(params.axisDirectionMm);
  if (axis === undefined) return { ok: false, message: "The flex axis has no direction." };
  if (!Number.isFinite(params.angleDeg) || params.angleDeg === 0) return { ok: false, message: "The flex angle must not be zero." };
  if (params.mode === "bend" && Math.abs(params.angleDeg) > 180) return { ok: false, message: "A bend is limited to 180°." };
  const base = analyzeFaces(mesh);
  if (typeof base === "string") return { ok: false, message: base };
  const phi = (params.angleDeg * Math.PI) / 180;
  const p0 = params.axisPointMm;
  let planes: { normal: V3; offset: number }[] = [];
  let transform: (point: V3) => V3;
  const notes: string[] = [];
  if (params.mode === "bend") {
    let along: V3;
    if (params.lengthDirectionMm !== undefined) {
      const given = unit(params.lengthDirectionMm);
      if (given === undefined) return { ok: false, message: "The bend direction has no length." };
      const perpendicular = sub(given, scale(axis, dot(given, axis)));
      const l = unit(perpendicular);
      if (l === undefined) return { ok: false, message: "The bend direction is along the axis; it must be square to it." };
      along = l;
    } else {
      const [e1, e2] = frameAround(axis);
      let best: V3 = e1; let reach = -Infinity;
      for (const candidate of [e1, scale(e1, -1), e2, scale(e2, -1)] as V3[]) {
        let r = -Infinity;
        for (const p of base.weldedPositions) r = Math.max(r, dot(sub(p, p0), candidate));
        if (r > reach + 1e-9) { reach = r; best = candidate; }
      }
      along = best;
    }
    const normal = cross(axis, along);
    let farthest = 0; let thickest = 0; let thinnest = 0;
    for (const p of base.weldedPositions) {
      const q = sub(p, p0);
      farthest = Math.max(farthest, dot(q, along));
      if (dot(q, along) > 0) { thickest = Math.max(thickest, dot(q, normal)); thinnest = Math.min(thinnest, dot(q, normal)); }
    }
    const zone = params.zoneLengthMm ?? farthest;
    if (!(zone > 1e-6)) return { ok: false, message: "The body does not reach past the axis point along the bend direction, so there is nothing to bend." };
    const rho = zone / phi;
    // Every point must stay on the near side of the bend's centre, or the part would fold through it.
    const inner = rho > 0 ? thickest : -thinnest;
    if (!(Math.abs(rho) > inner * 1.02 + 1e-9)) return { ok: false, message: `The bend radius (${Math.abs(rho).toFixed(1)} mm) is smaller than the part is thick on the inside of the bend (${inner.toFixed(1)} mm), so it would fold through itself. Use a smaller angle or a longer zone.` };
    const steps = Math.min(90, Math.max(8, Math.ceil(Math.abs(params.angleDeg) / 2)));
    const originAlong = dot(p0, along);
    planes = Array.from({ length: steps + 1 }, (_, k) => ({ normal: along, offset: originAlong + (zone * k) / steps }));
    transform = (point) => {
      const q = sub(point, p0);
      const s = dot(q, along); const h = dot(q, normal); const w = dot(q, axis);
      if (s <= 0) return point;
      const r = rho - h;
      let s2: number; let h2: number;
      if (s <= zone) {
        const theta = s / rho;
        s2 = r * Math.sin(theta); h2 = rho - r * Math.cos(theta);
      } else {
        s2 = r * Math.sin(phi) + (s - zone) * Math.cos(phi);
        h2 = rho - r * Math.cos(phi) + (s - zone) * Math.sin(phi);
      }
      return add(p0, add(scale(along, s2), add(scale(normal, h2), scale(axis, w))));
    };
    notes.push(`Bent ${params.angleDeg}° over ${zone.toFixed(1)} mm (neutral radius ${Math.abs(rho).toFixed(1)} mm), ${steps} cuts.`);
  } else {
    let low = Infinity; let high = -Infinity;
    for (const p of base.weldedPositions) { const w = dot(sub(p, p0), axis); low = Math.min(low, w); high = Math.max(high, w); }
    const span = high - low;
    if (!(span > 1e-6)) return { ok: false, message: "The body has no length along the axis to twist over." };
    const steps = Math.min(120, Math.max(8, Math.ceil(Math.abs(params.angleDeg) / 3)));
    planes = Array.from({ length: steps + 1 }, (_, k) => ({ normal: axis, offset: dot(p0, axis) + low + (span * k) / steps }));
    transform = (point) => {
      const q = sub(point, p0);
      const w = dot(q, axis);
      const turn = (phi * (w - low)) / span;
      const radial = sub(q, scale(axis, w));
      const rotated = add(scale(radial, Math.cos(turn)), scale(cross(axis, radial), Math.sin(turn)));
      return add(p0, add(scale(axis, w), rotated));
    };
    notes.push(`Twisted ${params.angleDeg}° over ${span.toFixed(1)} mm, ${steps} cuts.`);
  }
  const sliced = sliceMesh(mesh, planes);
  if (typeof sliced === "string") return { ok: false, message: sliced };
  const flat: number[] = sliced.positions.flatMap((p) => [p[0], p[1], p[2]]);
  const indices: number[] = sliced.triangles.flat();
  const prepared = analyzeFaces({ positionsMm: flat, indices });
  if (typeof prepared === "string") return { ok: false, message: `The body could not be cut for bending: ${prepared}` };
  const moved = prepared.weldedPositions.map((p) => transform(p));
  // A bend turns faces by up to the whole angle, so the normal-flip test used for plane edits does not apply; the mapping itself
  // cannot fold (it was checked against the bend radius above), so it is enough that the body still encloses a positive volume.
  let volume = 0;
  for (let t = 0; t < indices.length; t += 3) volume += dot(moved[prepared.weld[indices[t]!]!]!, cross(moved[prepared.weld[indices[t + 1]!]!]!, moved[prepared.weld[indices[t + 2]!]!]!)) / 6;
  if (!(volume > 0)) return { ok: false, message: "The flex leaves no solid volume." };
  const out = prepared.weld.flatMap((w) => [moved[w]![0], moved[w]![1], moved[w]![2]]);
  return { ok: true, positionsMm: out, indices, notes };
}
