/**
 * Picking edges and vertices by where they are on the SCREEN.
 *
 * The first picker measured the distance in millimetres between the point where the cursor's ray hit the mesh and each edge.
 * That fails exactly where picking matters: an edge on the silhouette has no surface behind the cursor to hit, a small part has
 * edges closer together than the millimetre tolerance, and a click in the middle of a big face still "picked" whichever edge was
 * least far away. Here the edges are projected to pixels and the pointer must be within a pixel tolerance of the drawn line, so
 * what is picked is what is under the cursor at any zoom and any size of part.
 *
 * Everything in this file is pure: the camera is a plain matrix, visibility is a callback, so it is tested without a renderer.
 */

type V3 = readonly [number, number, number];

/** What the picker needs to know about the camera. */
export interface PickCamera {
  /** Column-major 4 x 4 (the layout of a three.js Matrix4's `elements`) taking MILLIMETRE world points to clip space. */
  readonly viewProjection: readonly number[];
  /** Size of the canvas in CSS pixels. */
  readonly widthPx: number;
  readonly heightPx: number;
}

/** A point on the canvas, in CSS pixels from its top-left corner. */
export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export interface PickEdgeSegment {
  readonly bodyId: string;
  readonly chain: number;
  readonly a: V3;
  readonly b: V3;
  readonly concave?: boolean;
}

export interface EdgeCandidate {
  readonly bodyId: string;
  readonly chain: number;
  /** Index of the closest segment of the chain in the list that was searched. */
  readonly segmentIndex: number;
  /** Distance on screen from the pointer to the drawn edge. */
  readonly distancePx: number;
  /** Normalised device depth at the closest point (smaller is nearer the camera). */
  readonly depth: number;
  /** The point on the edge, in millimetres, that the pointer is closest to. */
  readonly pointMm: V3;
}

export interface VertexCandidate {
  readonly bodyId: string;
  readonly pointMm: V3;
  readonly distancePx: number;
  readonly depth: number;
}

export interface PickVertex {
  readonly bodyId: string;
  readonly pointMm: V3;
}

export interface PickOptions {
  /**
   * Whether a point on a body is seen from the camera (not hidden behind a surface). Called best candidate first and only for
   * candidates already inside the tolerance. Omitted: everything counts as visible (wireframe or X-ray).
   */
  readonly isVisible?: (pointMm: V3, bodyId: string) => boolean;
}

/** Two candidates this close on screen are treated as stacked, and the nearer one to the camera goes first. */
const TIE_PX = 1.5;
/** A repeated click within this many pixels of the last one cycles through the stack. */
export const CYCLE_RADIUS_PX = 4;
/** Anything nearer than this in clip-space w is behind the camera and is cut off. */
const NEAR_W = 1e-9;

export const DEFAULT_EDGE_TOLERANCE_PX = 8;
export const MIN_EDGE_TOLERANCE_PX = 3;
export const MAX_EDGE_TOLERANCE_PX = 24;

/** The pixel tolerance to use: the user's setting kept within sane bounds, widened for a finger. */
export function edgePickTolerancePx(settingPx: number | undefined, pointerType: string = "mouse"): number {
  const base = settingPx === undefined || !Number.isFinite(settingPx) ? DEFAULT_EDGE_TOLERANCE_PX : Math.min(MAX_EDGE_TOLERANCE_PX, Math.max(MIN_EDGE_TOLERANCE_PX, settingPx));
  return pointerType === "touch" || pointerType === "pen" ? Math.min(MAX_EDGE_TOLERANCE_PX * 1.5, base * 1.5) : base;
}

interface Clip { readonly x: number; readonly y: number; readonly z: number; readonly w: number }

function toClip(camera: PickCamera, p: V3): Clip {
  const m = camera.viewProjection;
  return {
    x: m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    y: m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    z: m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
    w: m[3]! * p[0] + m[7]! * p[1] + m[11]! * p[2] + m[15]!
  };
}

/** A point in millimetres on the canvas, in CSS pixels, with its depth; undefined when it is behind the camera. */
export function projectToScreen(camera: PickCamera, point: V3): { readonly x: number; readonly y: number; readonly depth: number } | undefined {
  const c = toClip(camera, point);
  if (!(c.w > NEAR_W)) return undefined;
  return { x: (c.x / c.w + 1) / 2 * camera.widthPx, y: (1 - c.y / c.w) / 2 * camera.heightPx, depth: c.z / c.w };
}

interface SegmentHit { readonly distancePx: number; readonly depth: number; readonly pointMm: V3 }

/** The closest point of a segment to the pointer on screen, with the near-plane clip and a perspective-correct point back in 3D. */
function closestOnSegment(camera: PickCamera, pointer: ScreenPoint, a: V3, b: V3): SegmentHit | undefined {
  let c0 = toClip(camera, a);
  let c1 = toClip(camera, b);
  let p0: V3 = a;
  let p1: V3 = b;
  if (!(c0.w > NEAR_W) && !(c1.w > NEAR_W)) return undefined;
  // Cut the part behind the camera off, in clip space where the cut is a straight line.
  if (!(c0.w > NEAR_W) || !(c1.w > NEAR_W)) {
    const t = (NEAR_W * 10 - c0.w) / (c1.w - c0.w);
    const lerp = (p: V3, q: V3): V3 => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t];
    const cut = lerp(a, b);
    if (!(c0.w > NEAR_W)) { p0 = cut; c0 = toClip(camera, cut); } else { p1 = cut; c1 = toClip(camera, cut); }
  }
  const sx0 = (c0.x / c0.w + 1) / 2 * camera.widthPx; const sy0 = (1 - c0.y / c0.w) / 2 * camera.heightPx;
  const sx1 = (c1.x / c1.w + 1) / 2 * camera.widthPx; const sy1 = (1 - c1.y / c1.w) / 2 * camera.heightPx;
  const dx = sx1 - sx0; const dy = sy1 - sy0;
  const lengthSquared = dx * dx + dy * dy;
  const s = lengthSquared < 1e-12 ? 0 : Math.max(0, Math.min(1, ((pointer.x - sx0) * dx + (pointer.y - sy0) * dy) / lengthSquared));
  const distancePx = Math.hypot(pointer.x - (sx0 + dx * s), pointer.y - (sy0 + dy * s));
  // Screen-linear s to the parameter along the 3D segment: perspective-correct interpolation.
  const denominator = (1 - s) / c0.w + s / c1.w;
  const t = denominator === 0 ? s : (s / c1.w) / denominator;
  const depth = (c0.z + (c1.z - c0.z) * t) / (c0.w + (c1.w - c0.w) * t);
  const pointMm: V3 = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t];
  return { distancePx, depth, pointMm };
}

const byNearness = (p: { readonly distancePx: number; readonly depth: number }, q: { readonly distancePx: number; readonly depth: number }): number =>
  Math.abs(p.distancePx - q.distancePx) <= TIE_PX ? p.depth - q.depth : p.distancePx - q.distancePx;

/**
 * Every edge chain within `tolerancePx` of the pointer that is visible, nearest first (one entry per chain of a body: the closest
 * of its segments). When several lie within a pixel or two of each other, the one nearer the camera goes first.
 */
export function pickEdgeCandidates(pointer: ScreenPoint, camera: PickCamera, edges: readonly PickEdgeSegment[], tolerancePx: number, options: PickOptions = {}): readonly EdgeCandidate[] {
  const best = new Map<string, EdgeCandidate>();
  edges.forEach((edge, segmentIndex) => {
    const hit = closestOnSegment(camera, pointer, edge.a, edge.b);
    if (hit === undefined || hit.distancePx > tolerancePx) return;
    const key = `${edge.bodyId}\u0000${edge.chain}`;
    const known = best.get(key);
    if (known === undefined || hit.distancePx < known.distancePx) best.set(key, { bodyId: edge.bodyId, chain: edge.chain, segmentIndex, ...hit });
  });
  const ordered = [...best.values()].sort(byNearness);
  const isVisible = options.isVisible;
  return isVisible === undefined ? ordered : ordered.filter((candidate) => isVisible(candidate.pointMm, candidate.bodyId));
}

/**
 * The edge a click at `pointer` picks: the nearest visible one within the tolerance, or the `cycle`-th of the stack when the
 * same spot is clicked again (0 = nearest, 1 = the next one behind it, wrapping).
 */
export function pickEdgeAt(pointer: ScreenPoint, camera: PickCamera, edges: readonly PickEdgeSegment[], tolerancePx: number, options: PickOptions & { readonly cycle?: number } = {}): EdgeCandidate | undefined {
  const candidates = pickEdgeCandidates(pointer, camera, edges, tolerancePx, options);
  if (candidates.length === 0) return undefined;
  const cycle = options.cycle ?? 0;
  return candidates[((Math.floor(cycle) % candidates.length) + candidates.length) % candidates.length];
}

/** Every vertex within the tolerance of the pointer that is visible, nearest first. */
export function pickVertexCandidates(pointer: ScreenPoint, camera: PickCamera, vertices: readonly PickVertex[], tolerancePx: number, options: PickOptions = {}): readonly VertexCandidate[] {
  const found: VertexCandidate[] = [];
  const seen = new Set<string>();
  for (const vertex of vertices) {
    const key = `${vertex.bodyId}\u0000${vertex.pointMm.map((value) => Math.round(value * 1e4)).join(",")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const screen = projectToScreen(camera, vertex.pointMm);
    if (screen === undefined) continue;
    const distancePx = Math.hypot(screen.x - pointer.x, screen.y - pointer.y);
    if (distancePx <= tolerancePx) found.push({ bodyId: vertex.bodyId, pointMm: vertex.pointMm, distancePx, depth: screen.depth });
  }
  const ordered = found.sort(byNearness);
  const isVisible = options.isVisible;
  return isVisible === undefined ? ordered : ordered.filter((candidate) => isVisible(candidate.pointMm, candidate.bodyId));
}

export function pickVertexAt(pointer: ScreenPoint, camera: PickCamera, vertices: readonly PickVertex[], tolerancePx: number, options: PickOptions & { readonly cycle?: number } = {}): VertexCandidate | undefined {
  const candidates = pickVertexCandidates(pointer, camera, vertices, tolerancePx, options);
  if (candidates.length === 0) return undefined;
  const cycle = options.cycle ?? 0;
  return candidates[((Math.floor(cycle) % candidates.length) + candidates.length) % candidates.length];
}

/**
 * Repeated clicks on the same spot walk through the stack of candidates under it. The state remembers where the last click was
 * and what was stacked there; a click elsewhere, or onto a different stack, starts again at the nearest.
 */
export interface CycleState {
  readonly x: number;
  readonly y: number;
  readonly keys: string;
  readonly index: number;
}

export function nextCycle(previous: CycleState | undefined, pointer: ScreenPoint, candidateKeys: readonly string[]): CycleState {
  const keys = candidateKeys.join("|");
  const same = previous !== undefined && previous.keys === keys && Math.hypot(previous.x - pointer.x, previous.y - pointer.y) <= CYCLE_RADIUS_PX;
  const index = same && candidateKeys.length > 0 ? (previous.index + 1) % candidateKeys.length : 0;
  return { x: pointer.x, y: pointer.y, keys, index };
}

/** A stable name for an edge candidate, for the cycle state. */
export const edgeKey = (candidate: { readonly bodyId: string; readonly chain: number }): string => `${candidate.bodyId}#${candidate.chain}`;

// ---------------------------------------------------------------------------------------------
// Tangent chains, corners and click tracking
// ---------------------------------------------------------------------------------------------

/** Two runs carry on into each other when they meet within this many degrees of a straight continuation. */
const TANGENT_LIMIT_DEG = 12;
const POINT_QUANTUM_MM = 1e-3;
const pointKey = (p: V3): string => `${Math.round(p[0] / POINT_QUANTUM_MM)},${Math.round(p[1] / POINT_QUANTUM_MM)},${Math.round(p[2] / POINT_QUANTUM_MM)}`;

interface SegmentLike { readonly a: V3; readonly b: V3; readonly chain: number }

/**
 * The chains that carry on tangentially from `chain`, through junctions where other edges meet it: Fusion's "tangent chain".
 * A chain continues into another where their end segments meet at one point and run on in nearly the same direction.
 */
export function tangentChainsFrom<T extends SegmentLike>(segments: readonly T[], chain: number): { readonly chains: readonly number[]; readonly segments: readonly T[] } {
  const at = new Map<string, { readonly chain: number; readonly away: V3 }[]>();
  const add = (p: V3, q: V3, owner: number): void => {
    const length = Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2]);
    if (length < 1e-9) return;
    const key = pointKey(p);
    const entry = { chain: owner, away: [(q[0] - p[0]) / length, (q[1] - p[1]) / length, (q[2] - p[2]) / length] as V3 };
    const bucket = at.get(key);
    if (bucket === undefined) at.set(key, [entry]); else bucket.push(entry);
  };
  for (const segment of segments) { add(segment.a, segment.b, segment.chain); add(segment.b, segment.a, segment.chain); }
  const links = new Map<number, Set<number>>();
  const link = (p: number, q: number): void => { (links.get(p) ?? links.set(p, new Set()).get(p)!).add(q); (links.get(q) ?? links.set(q, new Set()).get(q)!).add(p); };
  const limit = Math.cos((180 - TANGENT_LIMIT_DEG) * Math.PI / 180);
  for (const bucket of at.values()) {
    for (let i = 0; i < bucket.length; i += 1) {
      for (let j = i + 1; j < bucket.length; j += 1) {
        const p = bucket[i]!; const q = bucket[j]!;
        if (p.chain === q.chain) continue;
        // Both point away from the shared point; a straight continuation has them nearly opposite.
        if (p.away[0] * q.away[0] + p.away[1] * q.away[1] + p.away[2] * q.away[2] <= limit) link(p.chain, q.chain);
      }
    }
  }
  const reached = new Set<number>([chain]);
  const queue = [chain];
  while (queue.length > 0) {
    for (const next of links.get(queue.pop()!) ?? []) if (!reached.has(next)) { reached.add(next); queue.push(next); }
  }
  return { chains: [...reached].sort((p, q) => p - q), segments: segments.filter((segment) => reached.has(segment.chain)) };
}

/** The points of a body's edges that a designer calls vertices: where a run of edges ends or where edges of different runs meet. */
export function cornerVertices(segments: readonly SegmentLike[]): readonly V3[] {
  const at = new Map<string, { point: V3; chains: Set<number>; count: number }>();
  for (const segment of segments) {
    for (const point of [segment.a, segment.b]) {
      const key = pointKey(point);
      const entry = at.get(key);
      if (entry === undefined) at.set(key, { point, chains: new Set([segment.chain]), count: 1 });
      else { entry.chains.add(segment.chain); entry.count += 1; }
    }
  }
  return [...at.values()].filter((entry) => entry.count !== 2 || entry.chains.size > 1).map((entry) => entry.point);
}

/** A second click on the same spot within this many milliseconds is a double-click (tangent chain); a slower one cycles. */
export const DOUBLE_CLICK_MS = 350;

/**
 * Remembers the last click so that clicking the same spot again walks through the stack of edges under it, and clicking it twice
 * quickly asks for the tangent chain of the edge the first click picked.
 */
export class ClickTracker {
  #last: { readonly x: number; readonly y: number; readonly t: number; readonly keys: string; readonly index: number } | undefined;

  register(pointer: ScreenPoint, candidateKeys: readonly string[], nowMs: number): { readonly index: number; readonly doubleClick: boolean } {
    const keys = candidateKeys.join("|");
    const previous = this.#last;
    const sameSpot = previous !== undefined && previous.keys === keys && Math.hypot(previous.x - pointer.x, previous.y - pointer.y) <= CYCLE_RADIUS_PX;
    const doubleClick = sameSpot && nowMs - previous.t <= DOUBLE_CLICK_MS;
    const index = candidateKeys.length === 0 ? 0 : sameSpot ? (doubleClick ? previous.index : (previous.index + 1) % candidateKeys.length) : 0;
    this.#last = { x: pointer.x, y: pointer.y, t: nowMs, keys, index };
    return { index, doubleClick };
  }

  reset(): void { this.#last = undefined; }
}

/** The two settings a person can change for picking edges. */
export interface EdgePickSettings {
  /** Surfaces that bend by at least this many degrees across an edge offer it for picking (meshes without named edges). */
  readonly creaseAngleDeg: number;
  /** How close in screen pixels the pointer must be to an edge to pick it. */
  readonly tolerancePx: number;
}

export const DEFAULT_EDGE_PICK_SETTINGS: EdgePickSettings = { creaseAngleDeg: 30, tolerancePx: DEFAULT_EDGE_TOLERANCE_PX };
