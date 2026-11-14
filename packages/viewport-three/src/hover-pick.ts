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

import { pickEdgeCandidates, pickVertexCandidates, edgeKey, type EdgeCandidate, type PickCamera, type PickEdgeSegment, type PickOptions, type PickVertex, type ScreenPoint, type VertexCandidate } from "./edge-pick.js";

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
export type HoverFilter = "auto" | "body" | "component" | "face" | "edge" | "vertex";

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
  | {
    readonly kind: "edge"; readonly bodyId: string; readonly chain: number; readonly segments: readonly PickSegmentMm[]; readonly distanceMm: number; readonly concave: boolean;
    /** Distance on screen from the pointer to the drawn edge, when the pick was made by screen position. */
    readonly distancePx?: number;
    /** Every chain the target covers: just `chain`, or all the chains of a tangent chain (double-click). */
    readonly chains?: readonly number[];
    /** The target is the tangent chain of the edge under the pointer. */
    readonly tangent?: boolean;
  }
  | { readonly kind: "vertex"; readonly bodyId: string; readonly pointMm: V3; readonly distancePx: number };

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
 * - `auto`: the body: a click in Auto selects the body, so that is what lights up (it used to tint a face the click then did not pick).
 * - `body` / `component`: the body.
 */
export function classifyHover(
  hit: HoverRayHit | undefined,
  candidates: HoverCandidateBody | undefined,
  filter: HoverFilter,
  toleranceMm: number
): HoverTarget | null {
  if (hit === undefined) return null;
  if (filter === "vertex") return null; // vertices are picked by screen position (classifyPointer), never by a surface hit
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

/** One pickable edge segment projected to screen pixels, for window and crossing selection (PT-09). */
export interface ProjectedSegment {
  readonly bodyId: string;
  readonly chain: number;
  readonly ax: number;
  readonly ay: number;
  readonly bx: number;
  readonly by: number;
}

export interface SelectionBox {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

const inBox = (x: number, y: number, box: SelectionBox): boolean => x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;

/** Whether the segment touches the box: an endpoint inside, or the segment crossing one of the box's sides. */
function segmentTouchesBox(segment: ProjectedSegment, box: SelectionBox): boolean {
  if (inBox(segment.ax, segment.ay, box) || inBox(segment.bx, segment.by, box)) return true;
  const sides: readonly (readonly [number, number, number, number])[] = [
    [box.left, box.top, box.right, box.top],
    [box.right, box.top, box.right, box.bottom],
    [box.right, box.bottom, box.left, box.bottom],
    [box.left, box.bottom, box.left, box.top]
  ];
  const cross = (ox: number, oy: number, px: number, py: number, qx: number, qy: number): number => (px - ox) * (qy - oy) - (py - oy) * (qx - ox);
  for (const [x1, y1, x2, y2] of sides) {
    const d1 = cross(segment.ax, segment.ay, segment.bx, segment.by, x1, y1);
    const d2 = cross(segment.ax, segment.ay, segment.bx, segment.by, x2, y2);
    const d3 = cross(x1, y1, x2, y2, segment.ax, segment.ay);
    const d4 = cross(x1, y1, x2, y2, segment.bx, segment.by);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  }
  return false;
}

/**
 * The edge chains a selection box takes, Fusion style: a left-to-right (window) box takes only the chains whose every
 * segment lies fully inside it; a right-to-left (crossing) box takes any chain it touches.
 */
export function chainsInBox(segments: readonly ProjectedSegment[], box: SelectionBox, crossing: boolean): readonly { readonly bodyId: string; readonly chain: number }[] {
  const byChain = new Map<string, { readonly bodyId: string; readonly chain: number; inside: boolean; touched: boolean }>();
  for (const segment of segments) {
    const key = `${segment.bodyId}\u0000${segment.chain}`;
    const entry = byChain.get(key) ?? { bodyId: segment.bodyId, chain: segment.chain, inside: true, touched: false };
    const fullyInside = inBox(segment.ax, segment.ay, box) && inBox(segment.bx, segment.by, box);
    entry.inside = entry.inside && fullyInside;
    entry.touched = entry.touched || fullyInside || segmentTouchesBox(segment, box);
    byChain.set(key, entry);
  }
  return [...byChain.values()].filter((entry) => (crossing ? entry.touched : entry.inside)).map((entry) => ({ bodyId: entry.bodyId, chain: entry.chain }));
}

/** Whether two hover targets light up the same thing (so the overlay is only rebuilt when the target changes). */
export function sameHoverTarget(left: HoverTarget | null, right: HoverTarget | null): boolean {
  if (left === null || right === null) return left === right;
  if (left.kind !== right.kind || left.bodyId !== right.bodyId) return false;
  if (left.kind === "vertex" && right.kind === "vertex") return left.pointMm[0] === right.pointMm[0] && left.pointMm[1] === right.pointMm[1] && left.pointMm[2] === right.pointMm[2];
  if (left.kind === "face" && right.kind === "face") return left.faceIndex === right.faceIndex;
  if (left.kind === "edge" && right.kind === "edge") return left.chain === right.chain && left.tangent === right.tangent;
  return true;
}

/** Everything the screen-space classifier needs about one pointer position. */
export interface PointerPickInput {
  readonly pointer: ScreenPoint;
  readonly camera: PickCamera;
  readonly filter: HoverFilter;
  /** The surface under the pointer, from a raycast (faces and bodies come from it). */
  readonly hit: HoverRayHit | undefined;
  /** All pickable edge segments of every body, flattened (see `flattenPickEdges`). */
  readonly edges: readonly PickEdgeSegment[];
  /** All corner vertices of every body. */
  readonly vertices: readonly PickVertex[];
  readonly tolerancePx: number;
  readonly options?: PickOptions;
}

/** Flattens per-body candidates into the list the screen picker searches. */
export function flattenPickEdges(candidates: ReadonlyMap<string, HoverCandidateBody>): readonly PickEdgeSegment[] {
  const list: PickEdgeSegment[] = [];
  for (const [bodyId, body] of candidates) for (const edge of body.edges) list.push({ bodyId, chain: edge.chain, a: edge.a, b: edge.b, ...(edge.concave === undefined ? {} : { concave: edge.concave }) });
  return list;
}

/** The edge target for a screen candidate: the whole chain of that body's segments. */
export function edgeTargetOf(candidate: EdgeCandidate, edges: readonly PickEdgeSegment[]): HoverTarget {
  const segments = edges.filter((edge) => edge.bodyId === candidate.bodyId && edge.chain === candidate.chain).map((edge): PickSegmentMm => ({ a: edge.a, b: edge.b, chain: edge.chain, ...(edge.concave === undefined ? {} : { concave: edge.concave }) }));
  return { kind: "edge", bodyId: candidate.bodyId, chain: candidate.chain, segments, distanceMm: 0, distancePx: candidate.distancePx, concave: segments[0]?.concave === true, chains: [candidate.chain] };
}

export function vertexTargetOf(candidate: VertexCandidate): HoverTarget {
  return { kind: "vertex", bodyId: candidate.bodyId, pointMm: candidate.pointMm, distancePx: candidate.distancePx };
}

/** The stack of things a click at this position could pick with the Edge or Vertex intent, nearest first (empty for other intents). */
export function stackAtPointer(input: PointerPickInput): { readonly keys: readonly string[]; readonly targets: readonly HoverTarget[] } {
  if (input.filter === "edge") {
    const found = pickEdgeCandidates(input.pointer, input.camera, input.edges, input.tolerancePx, input.options);
    return { keys: found.map(edgeKey), targets: found.map((candidate) => edgeTargetOf(candidate, input.edges)) };
  }
  if (input.filter === "vertex") {
    const found = pickVertexCandidates(input.pointer, input.camera, input.vertices, input.tolerancePx, input.options);
    return { keys: found.map((candidate) => `${candidate.bodyId}@${candidate.pointMm.join(",")}`), targets: found.map(vertexTargetOf) };
  }
  return { keys: [], targets: [] };
}

/**
 * What the pointer is over, by selection intent, measured on screen: the nearest visible edge or vertex within the pixel
 * tolerance (whether or not a surface lies behind the cursor), else the face or body under the cursor from the raycast. Hover and
 * click both call this (the click with the stack index chosen by repeated clicks), so what lights up is what a click picks.
 */
export function classifyPointer(input: PointerPickInput, stackIndex = 0): HoverTarget | null {
  if (input.filter === "edge" || input.filter === "vertex") {
    const { targets } = stackAtPointer(input);
    if (targets.length === 0) return null;
    return targets[((Math.floor(stackIndex) % targets.length) + targets.length) % targets.length] ?? null;
  }
  return classifyHover(input.hit, undefined, input.filter, 0);
}
