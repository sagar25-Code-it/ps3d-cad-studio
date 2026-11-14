import type { GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import type { ConstructionEdgeRef } from "../../../packages/workbench-core/src/index.js";
import type { HoverTarget, ViewportGuideSegment } from "../../../packages/viewport-three/src/index.js";
import type { PanelEdgeSet } from "./command-panel.js";

/**
 * Small pure helpers between the 3D view's picks and the app's state: what an edge click adds to the selection (including the
 * tangent chain of a double-click), which chains a command panel should toggle, and the words for a picked vertex.
 */

export interface SelectedEdgePick {
  readonly bodyId: string;
  readonly chain: number;
  /** Every chain the pick covers: just `chain`, or all of a tangent chain. Absent means `[chain]`. */
  readonly chains?: readonly number[];
  readonly segments: readonly ViewportGuideSegment[];
}

type EdgeTarget = Extract<HoverTarget, { readonly kind: "edge" }>;
type Modifiers = { readonly ctrl: boolean; readonly shift: boolean };

export function edgePickOf(target: EdgeTarget): SelectedEdgePick {
  return { bodyId: target.bodyId, chain: target.chain, chains: target.chains ?? [target.chain], segments: target.segments.map((segment) => [segment.a, segment.b] as ViewportGuideSegment) };
}

/**
 * The selection after a click on an edge. A plain click replaces the selection (a second plain click on the same single edge
 * clears it); Ctrl or Shift adds or removes. A double-click (tangent chain) always puts the whole chain in, replacing the single
 * edge the first click of the double-click had picked, and never toggles it off.
 */
export function nextEdgeSelection(current: readonly SelectedEdgePick[], target: EdgeTarget, modifiers: Modifiers): readonly SelectedEdgePick[] {
  const pick = edgePickOf(target);
  const existing = current.findIndex((entry) => entry.bodyId === pick.bodyId && (entry.chain === pick.chain || (entry.chains ?? []).includes(pick.chain)));
  const adding = modifiers.ctrl || modifiers.shift;
  if (target.tangent === true) {
    const rest = current.filter((entry, index) => index !== existing && entry.bodyId === pick.bodyId);
    return adding ? [...rest, pick] : [pick];
  }
  if (!adding) return existing >= 0 && current.length === 1 ? [] : [pick];
  if (existing >= 0) return current.filter((_, index) => index !== existing);
  // One fillet or chamfer works on one solid, so chains collect within one body; a pick on another body restarts the set.
  return current.every((entry) => entry.bodyId === pick.bodyId) ? [...current, pick] : [pick];
}

/** The chain numbers of a selection that belong to one body (a tangent pick contributes all its chains). */
export function chainsOfSelection(selection: readonly SelectedEdgePick[], bodyId: string | undefined): readonly number[] {
  const seen = new Set<number>();
  for (const entry of selection) if (entry.bodyId === bodyId) for (const chain of entry.chains ?? [entry.chain]) seen.add(chain);
  return [...seen];
}

/** What a click on an edge does to the picked edge sets of a command panel: add the chains (all of a tangent chain), or remove them when every one is already there. */
export function chainsToToggle(existing: readonly Pick<PanelEdgeSet, "bodyId" | "chain">[], target: EdgeTarget): readonly number[] {
  const chains = target.chains ?? [target.chain];
  const present = (chain: number): boolean => existing.some((entry) => entry.bodyId === target.bodyId && entry.chain === chain);
  return chains.every(present) ? chains : chains.filter((chain) => !present(chain));
}

/** A straight edge reference for a construction plane or binder from a picked edge's segments; a message when it is curved. */
export function straightEdgeFromTarget(body: GeneralSolidBody, target: EdgeTarget): { readonly ok: true; readonly value: Extract<ConstructionEdgeRef, { readonly kind: "body-edge" }>; readonly message: string } | { readonly ok: false; readonly message: string } {
  const pieces = target.segments;
  const first = pieces[0];
  if (first === undefined) return { ok: false, message: `${body.name}: that edge has no segments to follow.` };
  const along = (p: readonly [number, number, number]): number => {
    const d = [first.b[0] - first.a[0], first.b[1] - first.a[1], first.b[2] - first.a[2]] as const;
    const l = Math.hypot(d[0], d[1], d[2]);
    return ((p[0] - first.a[0]) * d[0] + (p[1] - first.a[1]) * d[1] + (p[2] - first.a[2]) * d[2]) / l;
  };
  const dir = [first.b[0] - first.a[0], first.b[1] - first.a[1], first.b[2] - first.a[2]] as const;
  const dirLength = Math.hypot(dir[0], dir[1], dir[2]);
  if (dirLength < 1e-9) return { ok: false, message: "That edge is too short to follow." };
  let lo = Infinity; let hi = -Infinity;
  let low = first.a; let high = first.a;
  for (const piece of pieces) {
    for (const point of [piece.a, piece.b]) {
      const t = along(point);
      const off = Math.hypot(point[0] - first.a[0] - dir[0] / dirLength * t, point[1] - first.a[1] - dir[1] / dirLength * t, point[2] - first.a[2] - dir[2] / dirLength * t);
      if (off > 1e-3) return { ok: false, message: "That edge is curved (a round rim or an outline with corners), and a plane needs a straight edge. Pick a straight one." };
      if (t < lo) { lo = t; low = point; }
      if (t > hi) { hi = t; high = point; }
    }
  }
  const length = Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]);
  return { ok: true, value: { kind: "body-edge", bodyId: body.id, a: low, b: high }, message: `a ${length.toFixed(1)} mm straight edge of ${body.name}` };
}

/** The sentence for a vertex click. */
export function vertexPickText(target: Extract<HoverTarget, { readonly kind: "vertex" }>, bodyName: string | undefined): string {
  const [x, y, z] = target.pointMm;
  return `Vertex of ${bodyName ?? "the body"} at (${x.toFixed(2)}, ${y.toFixed(2)}, ${z.toFixed(2)}) mm.`;
}

/** Small crosses to draw at a picked vertex, sized for the view (`armMm`). */
export function vertexCrossSegments(pointMm: readonly [number, number, number], armMm: number): readonly ViewportGuideSegment[] {
  const [x, y, z] = pointMm;
  return [[[x - armMm, y, z], [x + armMm, y, z]], [[x, y - armMm, z], [x, y + armMm, z]], [[x, y, z - armMm], [x, y, z + armMm]]];
}
