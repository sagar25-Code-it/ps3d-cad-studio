import { attachEdgeFlange, sheetFrameOf, type EdgeFlangeResult, type SheetFrame, type SheetMesh } from "./sheet-edge-flange.js";

type Vec3 = readonly [number, number, number];

const KEY_SCALE = 1e5;
const pointKey = (point: Vec3): string => `${Math.round(point[0] * KEY_SCALE)},${Math.round(point[1] * KEY_SCALE)},${Math.round(point[2] * KEY_SCALE)}`;
const dot3 = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function directionOf(frame: SheetFrame, edgeIndex: number): Vec3 {
  const edge = frame.edges[edgeIndex]!;
  const length = edge.lengthMm;
  return [(edge.endMm[0] - edge.startMm[0]) / length, (edge.endMm[1] - edge.startMm[1]) / length, (edge.endMm[2] - edge.startMm[2]) / length];
}

/** The largest corner turn a mitre can join; a sharper reversal would need an infinitely long cut. */
export const MAX_MITRE_TURN_DEG = 170;

/**
 * tan(turn / 2) for the corner where `first` runs into `second`. The turn is signed seen from the sheet normal: a left turn (a
 * convex corner of the plate, since the material is on the left of every edge) is positive and makes both flanges run on past the
 * corner; a right turn (a concave corner) is negative and shortens them. Undefined when the two edges do not meet end to start
 * or turn by more than `MAX_MITRE_TURN_DEG`.
 */
export function mitreTangent(frame: SheetFrame, first: number, second: number): number | undefined {
  const a = frame.edges[first];
  const b = frame.edges[second];
  if (a === undefined || b === undefined || first === second) return undefined;
  if (pointKey(a.endMm) !== pointKey(b.startMm)) return undefined;
  const dirA = directionOf(frame, first);
  const dirB = directionOf(frame, second);
  const sine = dot3(cross3(dirA, dirB), frame.normal);
  const cosine = dot3(dirA, dirB);
  const turn = Math.atan2(sine, cosine);
  if (Math.abs(turn) * 180 / Math.PI > MAX_MITRE_TURN_DEG) return undefined;
  return Math.tan(turn / 2);
}

export type MiterChain =
  | { readonly ok: true; readonly edges: readonly number[]; readonly closed: boolean; readonly tangents: readonly number[] }
  | { readonly ok: false; readonly message: string };

/**
 * Checks that `edges` run from one end to the next around the plate (each edge ends where the following one starts) and gives the
 * mitre of every corner between them. The chain is closed when the last edge runs back into the first, which mitres that corner too.
 * `tangents[i]` belongs to the corner after `edges[i]`; a closed chain has one more entry than an open one.
 */
export function miterChainOf(frame: SheetFrame, edges: readonly number[]): MiterChain {
  if (edges.length === 0) return { ok: false, message: "A miter flange needs at least one edge." };
  if (new Set(edges).size !== edges.length) return { ok: false, message: "A miter flange cannot list the same edge twice." };
  for (const index of edges) {
    if (frame.edges[index] === undefined) return { ok: false, message: `There is no edge ${index}; this plate has ${frame.edges.length} (0 to ${frame.edges.length - 1}).` };
  }
  const tangents: number[] = [];
  for (let i = 0; i + 1 < edges.length; i += 1) {
    const tangent = mitreTangent(frame, edges[i]!, edges[i + 1]!);
    if (tangent === undefined) return { ok: false, message: `Edge ${edges[i]} does not run into edge ${edges[i + 1]} at a corner a mitre can join, so they cannot be one miter flange.` };
    tangents.push(tangent);
  }
  const closing = edges.length >= 3 ? mitreTangent(frame, edges[edges.length - 1]!, edges[0]!) : undefined;
  if (closing !== undefined) tangents.push(closing);
  return { ok: true, edges, closed: closing !== undefined, tangents };
}

/**
 * The edges of the plate from `firstEdge` forward (in the order the edges run, material on the left) to `lastEdge`, for a miter flange
 * picked by its first and last edge. Picking the same edge twice gives that single edge.
 */
export function miterChainBetween(frame: SheetFrame, firstEdge: number, lastEdge: number): readonly number[] | undefined {
  if (frame.edges[firstEdge] === undefined || frame.edges[lastEdge] === undefined) return undefined;
  const chain = [firstEdge];
  let current = firstEdge;
  while (current !== lastEdge) {
    const end = pointKey(frame.edges[current]!.endMm);
    const next = frame.edges.find((candidate) => pointKey(candidate.startMm) === end && candidate.index !== current);
    if (next === undefined || chain.includes(next.index)) return undefined;
    chain.push(next.index);
    current = next.index;
    if (chain.length > frame.edges.length) return undefined;
  }
  return chain;
}

export interface MiterFlangeSpec {
  /** The edges of the flange in running order; see `miterChainOf`. */
  readonly edgeIndices: readonly number[];
  readonly innerRadiusMm: number;
  readonly flangeLengthMm: number;
  readonly angleDeg: number;
  /** Corner relief wanted at each free end of the chain (an end that meets no other edge of the chain), one entry per chain edge. */
  readonly freeEndReliefs?: readonly { readonly startMm: number; readonly endMm: number }[];
}

/**
 * Bends one flange along a whole chain of connected plate edges with a mitre joint at every corner between them. Every edge carries
 * the same section (radius, length, angle), so the two flanges at a corner meet exactly on the corner's vertical bisector plane and
 * the joint closes without a gap or overlap. The first and last edge of an open chain end square (or with a corner relief when
 * another flange meets them there). The result is one closed solid like `attachEdgeFlange`, which this builds on edge by edge.
 */
export function attachMiterFlange(body: SheetMesh, base: SheetMesh, normal: Vec3, spec: MiterFlangeSpec): EdgeFlangeResult {
  const frame = sheetFrameOf(base, normal);
  if (frame === undefined) return { ok: false, message: "This body has no flat top face with a thickness to bend a flange from." };
  const chain = miterChainOf(frame, spec.edgeIndices);
  if (!chain.ok) return chain;
  const count = chain.edges.length;
  let current: SheetMesh = body;
  for (let i = 0; i < count; i += 1) {
    const hasPrevious = i > 0 || chain.closed;
    const hasNext = i + 1 < count || chain.closed;
    const startTangent = i > 0 ? chain.tangents[i - 1] : chain.closed ? chain.tangents[count - 1] : undefined;
    const endTangent = i + 1 < count ? chain.tangents[i] : chain.closed ? chain.tangents[count - 1] : undefined;
    const relief = spec.freeEndReliefs?.[i];
    const result = attachEdgeFlange(current, base, normal, {
      edgeIndex: chain.edges[i]!,
      innerRadiusMm: spec.innerRadiusMm,
      flangeLengthMm: spec.flangeLengthMm,
      angleDeg: spec.angleDeg,
      ...(!hasPrevious && relief !== undefined && relief.startMm > 0 ? { reliefStartMm: relief.startMm } : {}),
      ...(!hasNext && relief !== undefined && relief.endMm > 0 ? { reliefEndMm: relief.endMm } : {}),
      ...(hasPrevious && startTangent !== undefined ? { mitreStartTan: startTangent, mitreStartJoin: i > 0 } : {}),
      ...(hasNext && endTangent !== undefined ? { mitreEndTan: endTangent, mitreEndJoin: chain.closed && i === count - 1 } : {})
    });
    if (!result.ok) return { ok: false, message: `Miter flange, edge ${chain.edges[i]}: ${result.message}` };
    current = { positionsMm: result.positionsMm, indices: result.indices };
  }
  return { ok: true, positionsMm: current.positionsMm, indices: current.indices };
}
