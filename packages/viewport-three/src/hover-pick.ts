/**
 * Hover pre-highlight and face / edge picking in the 3D view (PT-08).
 *
 * The renderer raycasts the cursor against the body meshes and hands the hit to `classifyHover`, which decides what the
 * cursor is over according to the active selection intent: the nearest sharp edge chain (within a zoom-scaled tolerance),
 * the named face under the hit triangle, or the whole body. The same classification runs on hover (to tint the target
 * before the click) and on the click itself, so what lights up is always what a click would pick.
 *
 * Bodies without named faces (`faceTriangles`) are not face-pickable, and only the sharp edges the mesh kernel can treat
 * are edge-pickable; that is the honest subset of a tessellated kernel.
 */

type V3 = readonly [number, number, number];

/** One pickable edge segment of a body, in millimetres, with the smooth run (chain) it belongs to. */
export interface PickSegmentMm {
  readonly a: V3;
  readonly b: V3;
  readonly chain: number;
  /** An inside (concave) corner. */
  readonly concave?: boolean;
}

/** What can be picked on one body: its sharp edge segments (faces come from the mesh's own `faceTriangles`). */
export interface HoverCandidateBody {
  readonly edges: readonly PickSegmentMm[];
}

/** The selection intents the hover classifier distinguishes. Other filters (sketch ones) never reach the 3D hover path. */
export type HoverFilter = "auto" | "body" | "component" | "face" | "edge";

/** What the renderer's raycast found under the cursor. */
export interface HoverRayHit {
  readonly bodyId: string;
  readonly pointMm: V3;
  /** The named face under the hit triangle (an index into the body's faces), when the body carries face names. */
  readonly faceIndex: number | null;
}

export type HoverTarget =
  | { readonly kind: "body"; readonly bodyId: string }
  | { readonly kind: "face"; readonly bodyId: string; readonly faceIndex: number; readonly pointMm: V3 }
  | { readonly kind: "edge"; readonly bodyId: string; readonly chain: number; readonly segments: readonly PickSegmentMm[]; readonly distanceMm: number; readonly concave: boolean };

function distanceToSegmentMm(point: V3, a: V3, b: V3): number {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ap: V3 = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
  const lengthSquared = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const t = lengthSquared < 1e-12 ? 0 : Math.min(1, Math.max(0, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + ab[0] * t), point[1] - (a[1] + ab[1] * t), point[2] - (a[2] + ab[2] * t));
}

/** The nearest edge chain of `edges` to the hit point, or undefined when none comes within `toleranceMm`. */
export function nearestChainWithin(edges: readonly PickSegmentMm[], pointMm: V3, toleranceMm: number): { readonly chain: number; readonly distanceMm: number } | undefined {
  let bestChain: number | undefined;
  let bestDistance = Infinity;
  for (const edge of edges) {
    const distance = distanceToSegmentMm(pointMm, edge.a, edge.b);
    if (distance < bestDistance) { bestDistance = distance; bestChain = edge.chain; }
  }
  return bestChain === undefined || bestDistance > toleranceMm ? undefined : { chain: bestChain, distanceMm: bestDistance };
}

/**
 * What the cursor is over, by selection intent:
 * - `edge`: the nearest sharp edge chain within the tolerance, else nothing.
 * - `face`: the named face under the cursor, else nothing (a body without face names is not face-pickable).
 * - `auto`: the named face when the body has one there, else the body (clicks in auto keep selecting the body).
 * - `body` / `component`: the body.
 */
export function classifyHover(
  hit: HoverRayHit | undefined,
  candidates: HoverCandidateBody | undefined,
  filter: HoverFilter,
  toleranceMm: number
): HoverTarget | null {
  if (hit === undefined) return null;
  if (filter === "edge") {
    const edges = candidates?.edges ?? [];
    const nearest = nearestChainWithin(edges, hit.pointMm, toleranceMm);
    if (nearest === undefined) return null;
    const segments = edges.filter((edge) => edge.chain === nearest.chain);
    return { kind: "edge", bodyId: hit.bodyId, chain: nearest.chain, segments, distanceMm: nearest.distanceMm, concave: segments[0]?.concave === true };
  }
  if (filter === "face") {
    return hit.faceIndex === null || hit.faceIndex < 0 ? null : { kind: "face", bodyId: hit.bodyId, faceIndex: hit.faceIndex, pointMm: hit.pointMm };
  }
  if (filter === "auto" && hit.faceIndex !== null && hit.faceIndex >= 0) {
    return { kind: "face", bodyId: hit.bodyId, faceIndex: hit.faceIndex, pointMm: hit.pointMm };
  }
  return { kind: "body", bodyId: hit.bodyId };
}

/**
 * How close to an edge (in millimetres) the cursor must be to pick it: about eight screen pixels at the current zoom.
 * `radiusMeters` is the camera's orbit radius and `canvasHeightPx` the canvas height; the visible height of the scene is
 * roughly 0.69 × radius (38° field of view), so one pixel covers `690 × radius / height` millimetres.
 */
export function edgePickToleranceMm(radiusMeters: number, canvasHeightPx: number): number {
  const mmPerPx = 690 * Math.max(radiusMeters, 1e-6) / Math.max(canvasHeightPx, 1);
  return Math.min(50, Math.max(0.25, 8 * mmPerPx));
}

/** Whether two hover targets light up the same thing (so the overlay is only rebuilt when the target changes). */
export function sameHoverTarget(left: HoverTarget | null, right: HoverTarget | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind || left.bodyId !== right.bodyId) return false;
  if (left.kind === "face" && right.kind === "face") return left.faceIndex === right.faceIndex;
  if (left.kind === "edge" && right.kind === "edge") return left.chain === right.chain;
  return true;
}
