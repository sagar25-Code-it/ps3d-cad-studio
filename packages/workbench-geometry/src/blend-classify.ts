/**
 * What kind of faces an edge to be filleted or chamfered lies between, found from the mesh alone.
 *
 * The kernel rounds an edge with a cutter swept along it, drawn from the two faces at every segment. That is exact between two
 * flat faces and between a flat face and a cylinder (the straight line where a flat meets a cylinder wall, the circular rim of a
 * boss or a hole, the oval where a slanted flat cuts a cylinder; the curved side is read facet by facet, so its radius is the
 * mesh's, not an ideal circle's). It is not a rolling ball between a cone, a sphere or a free-form surface and anything else,
 * nor between two curved faces, so those cases are refused here with a message that says which case it is and why, before the
 * kernel is asked.
 */

import { analyzeFaces } from "./face-analysis.js";

type V3 = readonly [number, number, number];
type Segment = readonly [V3, V3];

export interface BlendMesh {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
}

export type BlendSurfaceKind = "plane" | "cylinder" | "curved";

export type BlendClassification =
  | { readonly ok: true; readonly description: string; readonly sides: readonly [BlendSurfaceKind, BlendSurfaceKind]; readonly rim: boolean }
  | { readonly ok: false; readonly message: string };

/** The facets of one smooth surface count as one face only while neighbouring facets bend by less than this. */
const SMOOTH_COS = Math.cos(30 * Math.PI / 180);
/** Normals of a cylinder are all within this of being perpendicular to its axis (sine of the angle). */
const CYLINDER_SINE = 0.035;
const MAX_PATCH_REGIONS = 512;
/** Neighbouring regions bending by less than this are not told apart from one flat face (the analysis already merged those). */
const FACET_MIN_COS = Math.cos(1 * Math.PI / 180);
/** A facet is not more than this many times the area of its neighbour. */
const FACET_AREA_RATIO = 6;
const QUANTUM_MM = 1e-4;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const keyOf = (p: V3): string => `${Math.round(p[0] / QUANTUM_MM)},${Math.round(p[1] / QUANTUM_MM)},${Math.round(p[2] / QUANTUM_MM)}`;

interface Patch { readonly kind: BlendSurfaceKind; readonly axis?: V3 }

/** Classifies the surface on each side of every segment of a picked run; refuses the cases the kernel cannot build. */
export function classifyBlendRun(mesh: BlendMesh, segments: readonly Segment[], what: "fillet" | "chamfer" = "fillet"): BlendClassification {
  const unknown: BlendClassification = { ok: true, description: "an edge", sides: ["plane", "plane"], rim: false };
  if (segments.length === 0) return unknown;
  const analysis = analyzeFaces(mesh);
  if (typeof analysis === "string") return unknown; // not a clean solid: the kernel's own checks speak for it
  const triangleCount = mesh.indices.length / 3;
  const weld = analysis.weld;
  const triangleWeld = (t: number): [number, number, number] => [weld[mesh.indices[t * 3]!]!, weld[mesh.indices[t * 3 + 1]!]!, weld[mesh.indices[t * 3 + 2]!]!];

  // Triangles by shared edge, and the welded vertex of every segment end.
  const trianglesOnEdge = new Map<string, number[]>();
  const neighbours: number[][] = Array.from({ length: triangleCount }, () => []);
  for (let t = 0; t < triangleCount; t += 1) {
    const [a, b, c] = triangleWeld(t);
    for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
      const key = from < to ? `${from},${to}` : `${to},${from}`;
      const bucket = trianglesOnEdge.get(key);
      if (bucket === undefined) trianglesOnEdge.set(key, [t]); else bucket.push(t);
    }
  }
  for (const bucket of trianglesOnEdge.values()) {
    if (bucket.length !== 2) continue;
    neighbours[bucket[0]!]!.push(bucket[1]!);
    neighbours[bucket[1]!]!.push(bucket[0]!);
  }
  const weldedByKey = new Map<string, number>();
  analysis.weldedPositions.forEach((point, id) => weldedByKey.set(keyOf(point), id));

  const normalOf = (t: number): V3 => analysis.regions[analysis.triangleRegion[t]!]?.normal ?? [0, 0, 1];
  // The regions each region continues into without a crease: a bend of at least 1 degree (coplanar triangles are one region
  // already) and under 30 (a facet of a round surface), with the size of the bend.
  const smoothCache = new Map<number, ReadonlyMap<number, number>>();
  const smoothOf = (region: number): ReadonlyMap<number, number> => {
    const cached = smoothCache.get(region);
    if (cached !== undefined) return cached;
    const found = new Map<number, number>();
    const own = analysis.regions[region];
    if (own !== undefined) {
      for (const t of own.triangles) {
        for (const other of neighbours[t]!) {
          const otherRegion = analysis.triangleRegion[other]!;
          if (otherRegion === region || found.has(otherRegion)) continue;
          const d = dot(own.normal, normalOf(other));
          if (d < SMOOTH_COS || d > FACET_MIN_COS) continue;
          found.set(otherRegion, Math.acos(Math.max(-1, Math.min(1, d))));
        }
      }
    }
    smoothCache.set(region, found);
    return found;
  };
  const areaOf = (region: number): number => analysis.regions[region]?.areaMm2 ?? 0;
  /**
   * A region is a facet of a round surface when it continues into a neighbour that bends by about the same step again, and is
   * not much bigger than that neighbour: a long flat face beside a small fillet bends by a similar step but is no facet.
   */
  const isFacet = (region: number): boolean => {
    for (const [middle, first] of smoothOf(region)) {
      if (areaOf(region) > FACET_AREA_RATIO * areaOf(middle)) continue;
      for (const [next, second] of smoothOf(middle)) {
        if (next === region) continue;
        const ratio = first / second;
        if (ratio < 0.65 || ratio > 1.55) continue;
        const sizeRatio = areaOf(middle) / Math.max(areaOf(next), 1e-12);
        if (sizeRatio > FACET_AREA_RATIO || sizeRatio < 1 / FACET_AREA_RATIO) continue;
        return true;
      }
    }
    return false;
  };
  const facetCache = new Map<number, boolean>();
  const facet = (region: number): boolean => { let known = facetCache.get(region); if (known === undefined) { known = isFacet(region); facetCache.set(region, known); } return known; };
  const patchCache = new Map<number, Patch>();
  const patchOf = (triangle: number): Patch => {
    const region = analysis.triangleRegion[triangle]!;
    const cached = patchCache.get(region);
    if (cached !== undefined) return cached;
    if (!facet(region)) { const flat: Patch = { kind: "plane" }; patchCache.set(region, flat); return flat; }
    // Grow across neighbouring facets that continue the surface without a crease.
    const seen = new Set<number>([region]);
    const queue = [region];
    while (queue.length > 0 && seen.size < MAX_PATCH_REGIONS) {
      const current = queue.pop()!;
      for (const next of smoothOf(current).keys()) {
        if (seen.has(next) || !facet(next)) continue;
        seen.add(next); queue.push(next);
      }
    }
    const normals = [...seen].map((id) => analysis.regions[id]!.normal);
    let axis: V3 | undefined;
    let strongest = 0;
    for (let i = 0; i < normals.length; i += 1) {
      for (let j = i + 1; j < normals.length; j += 1) {
        const c = cross(normals[i]!, normals[j]!);
        const size = Math.hypot(c[0], c[1], c[2]);
        if (size > strongest) { strongest = size; axis = [c[0] / size, c[1] / size, c[2] / size]; }
      }
    }
    let patch: Patch = { kind: "curved" };
    if (axis !== undefined && strongest > 0.05 && normals.every((n) => Math.abs(dot(n, axis!)) <= CYLINDER_SINE)) patch = { kind: "cylinder", axis };
    for (const id of seen) patchCache.set(id, patch);
    return patch;
  };

  const noun = what === "fillet" ? "fillet" : "chamfer";
  let rim = false;
  let flatCylinder = false;
  let flatFlat = false;
  for (const [from, to] of segments) {
    const a = weldedByKey.get(keyOf(from)); const b = weldedByKey.get(keyOf(to));
    if (a === undefined || b === undefined) continue;
    const bucket = trianglesOnEdge.get(a < b ? `${a},${b}` : `${b},${a}`);
    if (bucket === undefined || bucket.length !== 2) continue;
    const first = patchOf(bucket[0]!); const second = patchOf(bucket[1]!);
    const kinds = [first.kind, second.kind] as const;
    if (kinds[0] === "plane" && kinds[1] === "plane") { flatFlat = true; continue; }
    if (kinds[0] !== "plane" && kinds[1] !== "plane") {
      const names = kinds[0] === "cylinder" && kinds[1] === "cylinder" ? "two cylindrical faces" : kinds[0] === "cylinder" || kinds[1] === "cylinder" ? "a cylindrical face and a cone, sphere or free-form face" : "two curved faces (cone, sphere or free-form)";
      return { ok: false, message: `This edge lies between ${names}. A ${noun} is built here only where at least one side is a flat face, because the cutter is swept from the two faces along the edge and a curved-to-curved corner needs a rolling ball the mesh kernel does not have. Pick an edge with a flat face on one side.` };
    }
    const curvedAxis = kinds[0] === "plane" ? second : first;
    if (curvedAxis.kind === "curved") {
      return { ok: false, message: `This edge lies between a flat face and a curved face that is not a cylinder (a cone, a sphere or a free-form surface). A ${noun} is built only between flat faces and between a flat face and a cylinder, because on other surfaces the cutter would follow the mesh facets, not the surface, and the result would not be tangent. Pick an edge between flat faces or between a flat face and a cylinder.` };
    }
    flatCylinder = true;
    if (curvedAxis.axis !== undefined) {
      const edge = sub(to, from);
      const length = Math.hypot(edge[0], edge[1], edge[2]);
      if (length > 1e-9 && Math.abs(dot(edge, curvedAxis.axis)) / length < 0.2) rim = true;
    }
  }
  if (flatCylinder) return { ok: true, description: rim ? "the rim where a flat face meets a cylinder (a boss or hole edge)" : "an edge between a flat face and a cylinder", sides: ["plane", "cylinder"], rim };
  return { ok: true, description: flatFlat ? "an edge between flat faces" : "an edge", sides: ["plane", "plane"], rim: false };
}
