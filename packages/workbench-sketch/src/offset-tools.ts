import { failure, type SketchEntity, type SketchPointRef, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../workbench-core/src/index.js";
import { sampleSpline } from "./index.js";
import type { SketchEditContext, SketchEditResult } from "./edit-tools.js";
import { arcTravel, circleCircle, lineCircle, lineLine } from "./corner-tools.js";
import { finishPlan, jointRelation, pairRelation } from "./edit-relations.js";

/**
 * Offset: a chain of lines and arcs (a slot, a rounded rectangle, a gasket outline) is offset as one piece with its corners joined, on the
 * side the caller chose; circles, rectangles, ellipses and splines offset on their own. The result keeps parallel, concentric, tangent and
 * joint relations to its source, and an offset that would fold back on itself (a neck narrower than twice the distance) is refused.
 */

type Line = Extract<SketchEntity, { kind: "line" }>;
type Arc = Extract<SketchEntity, { kind: "arc" }>;
type Round = Line | Arc;

const TWO_PI = Math.PI * 2;
const MIN_MM = 0.01;

export type OffsetCorner = "mitre" | "round" | "chamfer";
export type OffsetChainMode = "none" | "tangent" | "connected";

export interface OffsetOptions {
  /** How the outside corners of a chain are closed: a sharp mitre (default, falling back to round on a very sharp corner), a round or a chamfer. */
  readonly corner?: OffsetCorner;
  /** Flip the side: the distance's sign is reversed. */
  readonly flip?: boolean;
  /** Offset to both sides at once (outward and inward for a loop). */
  readonly both?: boolean;
  /** A point on the side to offset toward; it replaces the sign of the distance. */
  readonly sidePoint?: Vec2;
  /** Which neighbours to add to the selection first: none, the tangent chain, or everything connected end to end (default tangent). */
  readonly chain?: OffsetChainMode;
  /** Create parallel, concentric, tangent and joint relations to the source (default true). */
  readonly relations?: boolean;
}

function reject(message: string, ids: readonly string[] = [], recovery = "Adjust the selection or the distance and try again."): SketchEditResult {
  return failure("INVALID_OPERATION", message, ids, recovery);
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1]);
}

function wrap(angle: number): number {
  return ((angle % TWO_PI) + TWO_PI) % TWO_PI;
}

function wrapPi(angle: number): number {
  const wrapped = wrap(angle);
  return wrapped > Math.PI ? wrapped - TWO_PI : wrapped;
}

function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

function unit(v: Vec2): Vec2 {
  const length = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / length, v[1] / length];
}

function isRound(entity: SketchEntity | undefined): entity is Round {
  return entity?.kind === "line" || entity?.kind === "arc";
}

function joinTolerance(sketch: WorkbenchSketch): number {
  return Math.max(1e-6, Math.min(sketch.snapToleranceMm, 0.05));
}

// ---------------------------------------------------------------------------------------------
// Selecting the chain
// ---------------------------------------------------------------------------------------------

function endTangent(entity: Round, end: "start" | "end"): Vec2 {
  if (entity.kind === "line") return unit([entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]]);
  const travel = arcTravel(entity);
  if (travel === undefined) return [1, 0];
  const angle = end === "start" ? travel.startAngle : travel.endAngle;
  return [-Math.sin(angle) * travel.dir, Math.cos(angle) * travel.dir];
}

/**
 * The curves to offset: the selection plus, when asked, the curves that continue it smoothly (tangent) or merely meet it end to end.
 * Construction and hidden curves are never pulled in.
 */
export function expandOffsetSelection(sketch: WorkbenchSketch, ids: readonly string[], mode: OffsetChainMode): readonly string[] {
  if (mode === "none") return [...ids];
  const tolerance = joinTolerance(sketch);
  const reached = new Set(ids);
  const queue = ids.map((id) => sketch.entities.find((entity) => entity.id === id)).filter(isRound);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const end of ["start", "end"] as const) {
      const point = end === "start" ? current.start : current.end;
      for (const other of sketch.entities) {
        if (!isRound(other) || reached.has(other.id) || other.construction || other.visible === false) continue;
        for (const otherEnd of ["start", "end"] as const) {
          const otherPoint = otherEnd === "start" ? other.start : other.end;
          if (dist(point, otherPoint) > tolerance) continue;
          if (mode === "tangent") {
            const a = endTangent(current, end);
            const b = endTangent(other, otherEnd);
            if (Math.abs(a[0] * b[1] - a[1] * b[0]) > 1e-4) continue;
          }
          reached.add(other.id);
          queue.push(other);
        }
      }
    }
  }
  return [...reached];
}

// ---------------------------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------------------------

interface Piece {
  readonly entity: Round;
  /** True when travelling the chain runs from the entity's start to its end. */
  readonly forward: boolean;
  readonly from: Vec2;
  readonly to: Vec2;
  /** Arcs: centre, radius and the angular direction of travel (+1 counter-clockwise). */
  readonly center?: Vec2;
  readonly radius?: number;
  readonly sigma?: 1 | -1;
}

interface Chain {
  readonly pieces: readonly Piece[];
  readonly closed: boolean;
}

function pieceOf(entity: Round, forward: boolean): Piece | undefined {
  const from = forward ? entity.start : entity.end;
  const to = forward ? entity.end : entity.start;
  if (entity.kind === "line") return { entity, forward, from, to };
  const travel = arcTravel(entity);
  if (travel === undefined) return undefined;
  const sigma: 1 | -1 = forward ? travel.dir : (travel.dir === 1 ? -1 : 1);
  return { entity, forward, from, to, center: travel.center, radius: travel.radius, sigma };
}

/** Orders the selected lines and arcs into chains (open, or closed loops); undefined when a vertex has three or more curves. */
function buildChains(entities: readonly Round[], tolerance: number): { readonly chains: readonly Chain[] } | { readonly error: string; readonly ids: readonly string[] } {
  const vertices: Vec2[] = [];
  const vertexOf = (point: Vec2): number => {
    const found = vertices.findIndex((candidate) => dist(candidate, point) <= tolerance);
    if (found >= 0) return found;
    vertices.push(point);
    return vertices.length - 1;
  };
  const edges = entities.map((entity) => ({ entity, a: vertexOf(entity.start), b: vertexOf(entity.end) }));
  const degree = new Map<number, number>();
  for (const edge of edges) {
    degree.set(edge.a, (degree.get(edge.a) ?? 0) + 1);
    degree.set(edge.b, (degree.get(edge.b) ?? 0) + 1);
  }
  for (const [vertex, count] of degree) {
    if (count > 2) {
      const at = vertices[vertex]!;
      return { error: `The selection branches at (${fmt(at[0])}, ${fmt(at[1])}): ${count} curves meet there, so it has no single side to offset.`, ids: edges.filter((edge) => edge.a === vertex || edge.b === vertex).map((edge) => edge.entity.id) };
    }
  }
  const used = new Set<number>();
  const chains: Chain[] = [];
  const incident = (vertex: number): number[] => edges.flatMap((edge, index) => (edge.a === vertex || edge.b === vertex ? [index] : []));
  const lowest = (candidates: readonly number[]): number => candidates.reduce((best, vertex) => {
    const p = vertices[vertex]!;
    const q = vertices[best]!;
    return p[0] < q[0] - 1e-9 || (Math.abs(p[0] - q[0]) <= 1e-9 && p[1] < q[1]) ? vertex : best;
  });
  const walk = (startVertex: number, firstEdge: number): Chain | undefined => {
    const pieces: Piece[] = [];
    let vertex = startVertex;
    let edgeIndex: number | undefined = firstEdge;
    let closed = false;
    while (edgeIndex !== undefined && !used.has(edgeIndex)) {
      used.add(edgeIndex);
      const edge = edges[edgeIndex]!;
      const forward = edge.a === vertex && !(edge.a === edge.b);
      const piece = pieceOf(edge.entity, forward);
      if (piece === undefined) return undefined;
      pieces.push(piece);
      vertex = forward ? edge.b : edge.a;
      if (vertex === startVertex) { closed = true; break; }
      edgeIndex = incident(vertex).find((candidate) => !used.has(candidate));
    }
    return { pieces, closed };
  };
  // Open chains first, starting at the open end that is lowest (x, then y), so the direction of travel does not depend on how the lines were drawn.
  const openEnds = [...degree.entries()].filter(([, count]) => count === 1).map(([vertex]) => vertex);
  while (true) {
    const available = openEnds.filter((vertex) => incident(vertex).some((candidate) => !used.has(candidate)));
    if (available.length === 0) break;
    const start = lowest(available);
    const chain = walk(start, incident(start).find((candidate) => !used.has(candidate))!);
    if (chain === undefined) return { error: "An arc in the selection is degenerate.", ids: [] };
    chains.push(chain);
  }
  for (let index = 0; index < edges.length; index += 1) {
    if (used.has(index)) continue;
    const chain = walk(edges[index]!.a, index);
    if (chain === undefined) return { error: "An arc in the selection is degenerate.", ids: [] };
    chains.push(chain);
  }
  return { chains };
}

function samplePiece(piece: Piece, steps = 24): readonly Vec2[] {
  if (piece.center === undefined || piece.radius === undefined || piece.sigma === undefined) return [piece.from, piece.to];
  const start = Math.atan2(piece.from[1] - piece.center[1], piece.from[0] - piece.center[0]);
  const end = Math.atan2(piece.to[1] - piece.center[1], piece.to[0] - piece.center[0]);
  const sweep = wrap(piece.sigma * (end - start));
  return Array.from({ length: steps + 1 }, (_, index): Vec2 => {
    const angle = start + (piece.sigma! * sweep * index) / steps;
    return [piece.center![0] + piece.radius! * Math.cos(angle), piece.center![1] + piece.radius! * Math.sin(angle)];
  });
}

function polygonArea(points: readonly Vec2[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    twice += a[0] * b[1] - b[0] * a[1];
  }
  return twice / 2;
}

/** Where the chain's travel lies relative to a point: +1 when the point is to its left. */
function sideOfPoint(chain: Chain, point: Vec2): 1 | -1 {
  let best = Infinity;
  let side: 1 | -1 = 1;
  for (const piece of chain.pieces) {
    const samples = samplePiece(piece, 32);
    for (let index = 0; index < samples.length - 1; index += 1) {
      const a = samples[index]!;
      const b = samples[index + 1]!;
      const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
      const lengthSquared = d[0] * d[0] + d[1] * d[1];
      const t = lengthSquared < 1e-18 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * d[0] + (point[1] - a[1]) * d[1]) / lengthSquared));
      const foot: Vec2 = [a[0] + d[0] * t, a[1] + d[1] * t];
      const gap = dist(point, foot);
      if (gap < best) {
        best = gap;
        side = d[0] * (point[1] - a[1]) - d[1] * (point[0] - a[0]) >= 0 ? 1 : -1;
      }
    }
  }
  return side;
}

// ---------------------------------------------------------------------------------------------
// Offsetting one chain
// ---------------------------------------------------------------------------------------------

interface OffsetCarrier {
  readonly piece: Piece;
  /** Offset of the piece's travel start and end, before any corner join. */
  readonly from: Vec2;
  readonly to: Vec2;
  /** Line: the unit direction of travel. Arc: centre and radius of the offset circle. */
  readonly direction?: Vec2;
  readonly center?: Vec2;
  readonly radius?: number;
}

function leftNormal(piece: Piece, at: Vec2): Vec2 {
  if (piece.center === undefined || piece.sigma === undefined) {
    const u = unit([piece.to[0] - piece.from[0], piece.to[1] - piece.from[1]]);
    return [-u[1], u[0]];
  }
  const radial = unit([at[0] - piece.center[0], at[1] - piece.center[1]]);
  return [-piece.sigma * radial[0], -piece.sigma * radial[1]];
}

function carrierOf(piece: Piece, signed: number): OffsetCarrier | string {
  if (piece.center === undefined || piece.radius === undefined || piece.sigma === undefined) {
    const normal = leftNormal(piece, piece.from);
    return { piece, from: [piece.from[0] + normal[0] * signed, piece.from[1] + normal[1] * signed], to: [piece.to[0] + normal[0] * signed, piece.to[1] + normal[1] * signed], direction: unit([piece.to[0] - piece.from[0], piece.to[1] - piece.from[1]]) };
  }
  const radius = piece.radius - piece.sigma * signed;
  if (radius < MIN_MM) return `The inward offset is larger than the arc's radius (${fmt(piece.radius)} mm).`;
  const onto = (point: Vec2): Vec2 => {
    const radial = unit([point[0] - piece.center![0], point[1] - piece.center![1]]);
    return [piece.center![0] + radial[0] * radius, piece.center![1] + radial[1] * radius];
  };
  return { piece, from: onto(piece.from), to: onto(piece.to), center: piece.center, radius };
}

function carrierIntersections(a: OffsetCarrier, b: OffsetCarrier): readonly Vec2[] {
  if (a.direction !== undefined && b.direction !== undefined) {
    const hit = lineLine(a.from, a.direction, b.from, b.direction);
    return hit === undefined ? [] : [hit];
  }
  if (a.direction !== undefined && b.center !== undefined) return lineCircle(a.from, a.direction, b.center, b.radius!);
  if (a.center !== undefined && b.direction !== undefined) return lineCircle(b.from, b.direction, a.center, a.radius!);
  return a.center !== undefined && b.center !== undefined ? circleCircle(a.center, a.radius!, b.center, b.radius!) : [];
}

/** How far past `at` (along the carrier's travel) the point lies: positive means the carrier would have to be extended. */
function travelShift(carrier: OffsetCarrier, at: Vec2, point: Vec2): number {
  if (carrier.direction !== undefined) return (point[0] - at[0]) * carrier.direction[0] + (point[1] - at[1]) * carrier.direction[1];
  const center = carrier.center!;
  return carrier.radius! * carrier.piece.sigma! * wrapPi(Math.atan2(point[1] - center[1], point[0] - center[0]) - Math.atan2(at[1] - center[1], at[0] - center[0]));
}

interface Corner {
  /** Where the earlier piece now ends and the later one starts. */
  readonly end: Vec2;
  readonly start: Vec2;
  /** A piece that closes an outside corner: a round arc or a chamfer line. */
  readonly filler?: { readonly kind: "arc" | "line"; readonly from: Vec2; readonly to: Vec2; readonly mid?: Vec2; readonly center?: Vec2 };
  /** Signed lengthening of the earlier piece's end and the later piece's start (positive extends). */
  readonly extendEnd: number;
  readonly extendStart: number;
}

function joinCorner(a: OffsetCarrier, b: OffsetCarrier, vertex: Vec2, distanceMm: number, corner: OffsetCorner): Corner | string {
  const gap = dist(a.to, b.from);
  if (gap <= 1e-7) return { end: a.to, start: a.to, extendEnd: 0, extendStart: 0 };
  const middle: Vec2 = [(a.to[0] + b.from[0]) / 2, (a.to[1] + b.from[1]) / 2];
  const candidates = carrierIntersections(a, b);
  let joint: Vec2 | undefined;
  for (const candidate of candidates) if (joint === undefined || dist(candidate, middle) < dist(joint, middle)) joint = candidate;
  const outside = joint === undefined ? true : travelShift(a, a.to, joint) > 1e-7;
  if (joint !== undefined && (!outside || corner === "mitre") && dist(joint, vertex) <= 10 * Math.abs(distanceMm) + 1e-6) {
    return { end: joint, start: joint, extendEnd: travelShift(a, a.to, joint), extendStart: -travelShift(b, b.from, joint) };
  }
  if (!outside) return "Two neighbouring curves cannot be offset by this distance without folding over each other.";
  if (corner === "chamfer") return { end: a.to, start: b.from, filler: { kind: "line", from: a.to, to: b.from }, extendEnd: 0, extendStart: 0 };
  // Round: an arc about the original vertex, the short way from one offset end to the other.
  const va: Vec2 = [a.to[0] - vertex[0], a.to[1] - vertex[1]];
  const vb: Vec2 = [b.from[0] - vertex[0], b.from[1] - vertex[1]];
  const sum: Vec2 = [va[0] + vb[0], va[1] + vb[1]];
  if (Math.hypot(sum[0], sum[1]) < 1e-9) return { end: a.to, start: b.from, filler: { kind: "line", from: a.to, to: b.from }, extendEnd: 0, extendStart: 0 };
  const direction = unit(sum);
  const radius = Math.hypot(va[0], va[1]);
  return { end: a.to, start: b.from, filler: { kind: "arc", from: a.to, to: b.from, mid: [vertex[0] + direction[0] * radius, vertex[1] + direction[1] * radius], center: vertex }, extendEnd: 0, extendStart: 0 };
}

interface Built {
  readonly entities: readonly SketchEntity[];
  /** Per source piece, the new entity and which of its points sit at the piece's travel start and end. */
  readonly parts: readonly { readonly source: Round; readonly made: SketchEntity; readonly atFrom: SketchPointRef; readonly atTo: SketchPointRef }[];
  readonly fillers: readonly { readonly made: SketchEntity; readonly afterPiece: number }[];
  readonly samples: readonly (readonly Vec2[])[];
  /** The runs that must stay at least the offset distance from the source (a chamfer cuts inside that distance on purpose). */
  readonly checked: readonly (readonly Vec2[])[];
}

function buildOffsetChain(context: SketchEditContext, chain: Chain, signed: number, corner: OffsetCorner, flags: (entity: SketchEntity) => { readonly construction: boolean; readonly visible?: boolean }): Built | string {
  const carriers: OffsetCarrier[] = [];
  for (const piece of chain.pieces) {
    const made = carrierOf(piece, signed);
    if (typeof made === "string") return made;
    carriers.push(made);
  }
  const count = carriers.length;
  const joints: (Corner | undefined)[] = [];
  const vertexCount = chain.closed ? count : count - 1;
  for (let index = 0; index < vertexCount; index += 1) {
    const a = carriers[index]!;
    const b = carriers[(index + 1) % count]!;
    const joined = joinCorner(a, b, chain.pieces[index]!.to, signed, corner);
    if (typeof joined === "string") return joined;
    joints.push(joined);
  }
  const entities: SketchEntity[] = [];
  const parts: { source: Round; made: SketchEntity; atFrom: SketchPointRef; atTo: SketchPointRef }[] = [];
  const fillers: { made: SketchEntity; afterPiece: number }[] = [];
  const samples: (readonly Vec2[])[] = [];
  const checked: (readonly Vec2[])[] = [];
  for (let index = 0; index < count; index += 1) {
    const carrier = carriers[index]!;
    const piece = carrier.piece;
    const before = chain.closed ? joints[(index + count - 1) % count] : (index > 0 ? joints[index - 1] : undefined);
    const after = chain.closed ? joints[index] : (index < vertexCount ? joints[index] : undefined);
    const from = before?.start ?? carrier.from;
    const to = after?.end ?? carrier.to;
    const startShift = before?.extendStart ?? 0;
    const endShift = after?.extendEnd ?? 0;
    const shared = flags(piece.entity);
    const id = context.newId("entity");
    if (carrier.direction !== undefined) {
      const length = (to[0] - from[0]) * carrier.direction[0] + (to[1] - from[1]) * carrier.direction[1];
      if (length < MIN_MM) return "The offset distance collapses part of the shape; use a smaller distance.";
      const line: Line = piece.forward ? { id, kind: "line", start: from, end: to, ...shared } : { id, kind: "line", start: to, end: from, ...shared };
      entities.push(line);
      parts.push({ source: piece.entity, made: line, atFrom: piece.forward ? "start" : "end", atTo: piece.forward ? "end" : "start" });
      samples.push([from, to]);
      checked.push([from, to]);
    } else {
      const center = carrier.center!;
      const radius = carrier.radius!;
      const sigma = piece.sigma!;
      const startAngle = Math.atan2(from[1] - center[1], from[0] - center[0]);
      const endAngle = Math.atan2(to[1] - center[1], to[0] - center[0]);
      const sweep = wrap(sigma * (endAngle - startAngle));
      const original = wrap(sigma * (Math.atan2(piece.to[1] - center[1], piece.to[0] - center[0]) - Math.atan2(piece.from[1] - center[1], piece.from[0] - center[0])));
      const expected = original + (startShift + endShift) / radius;
      if (expected < MIN_MM / radius || Math.abs(sweep - expected) > 1e-6 + 1e-4 * Math.abs(expected) + 1e-9 || sweep * radius < MIN_MM) return "The offset distance collapses part of the shape; use a smaller distance.";
      const midAngle = startAngle + (sigma * sweep) / 2;
      const middle: Vec2 = [center[0] + radius * Math.cos(midAngle), center[1] + radius * Math.sin(midAngle)];
      const arc: Arc = piece.forward ? { id, kind: "arc", start: from, mid: middle, end: to, ...shared } : { id, kind: "arc", start: to, mid: middle, end: from, ...shared };
      entities.push(arc);
      parts.push({ source: piece.entity, made: arc, atFrom: piece.forward ? "start" : "end", atTo: piece.forward ? "end" : "start" });
      const run = Array.from({ length: 25 }, (_, step): Vec2 => [center[0] + radius * Math.cos(startAngle + (sigma * sweep * step) / 24), center[1] + radius * Math.sin(startAngle + (sigma * sweep * step) / 24)]);
      samples.push(run);
      checked.push(run);
    }
    const joint = after;
    if (joint?.filler !== undefined) {
      const fillerId = context.newId("entity");
      const flagsOf = flags(piece.entity);
      const made: SketchEntity = joint.filler.kind === "line"
        ? { id: fillerId, kind: "line", start: joint.filler.from, end: joint.filler.to, ...flagsOf }
        : { id: fillerId, kind: "arc", start: joint.filler.from, mid: joint.filler.mid!, end: joint.filler.to, ...flagsOf };
      entities.push(made);
      fillers.push({ made, afterPiece: index });
      const fillerRun = joint.filler.kind === "line" ? [joint.filler.from, joint.filler.to] : arcSamples(made as Arc);
      samples.push(fillerRun);
      if (joint.filler.kind === "arc") checked.push(fillerRun);
    }
  }
  return { entities, parts, fillers, samples, checked };
}

function arcSamples(arc: Arc): readonly Vec2[] {
  const travel = arcTravel(arc);
  if (travel === undefined) return [arc.start, arc.end];
  return Array.from({ length: 13 }, (_, step): Vec2 => {
    const angle = travel.startAngle + (travel.dir * travel.sweep * step) / 12;
    return [travel.center[0] + travel.radius * Math.cos(angle), travel.center[1] + travel.radius * Math.sin(angle)];
  });
}

// ---------------------------------------------------------------------------------------------
// Overlap checks
// ---------------------------------------------------------------------------------------------

function segmentsCross(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o = (p: Vec2, q: Vec2, r: Vec2): number => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  const eps = 1e-9;
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

/** True when the polyline (the runs joined in order) crosses itself away from where consecutive segments meet. */
function selfCrosses(runs: readonly (readonly Vec2[])[], closed: boolean): boolean {
  const segments: { a: Vec2; b: Vec2 }[] = [];
  for (const run of runs) for (let index = 0; index < run.length - 1; index += 1) segments.push({ a: run[index]!, b: run[index + 1]! });
  const order = segments.map((segment, index) => ({ index, min: Math.min(segment.a[0], segment.b[0]), max: Math.max(segment.a[0], segment.b[0]) })).sort((x, y) => x.min - y.min);
  const last = segments.length - 1;
  for (let i = 0; i < order.length; i += 1) {
    const first = segments[order[i]!.index]!;
    for (let j = i + 1; j < order.length && order[j]!.min <= order[i]!.max + 1e-9; j += 1) {
      const gap = Math.abs(order[i]!.index - order[j]!.index);
      if (gap <= 1 || (closed && gap === last)) continue;
      const second = segments[order[j]!.index]!;
      if (segmentsCross(first.a, first.b, second.a, second.b)) return true;
    }
  }
  return false;
}

/** Extra points along a run so no stretch longer than `step` goes unchecked (capped, so a huge sketch stays fast). */
function densify(run: readonly Vec2[], step: number): readonly Vec2[] {
  const points: Vec2[] = [run[0]!];
  for (let index = 1; index < run.length; index += 1) {
    const a = run[index - 1]!;
    const b = run[index]!;
    const pieces = Math.min(40, Math.max(1, Math.ceil(dist(a, b) / Math.max(step, 1e-6))));
    for (let k = 1; k <= pieces; k += 1) points.push([a[0] + ((b[0] - a[0]) * k) / pieces, a[1] + ((b[1] - a[1]) * k) / pieces]);
  }
  return points;
}

/** The smallest distance from a point to the source polyline. */
function distanceToRuns(point: Vec2, runs: readonly (readonly Vec2[])[]): number {
  let best = Infinity;
  for (const run of runs) {
    for (let index = 0; index < run.length - 1; index += 1) {
      const a = run[index]!;
      const b = run[index + 1]!;
      const d: Vec2 = [b[0] - a[0], b[1] - a[1]];
      const lengthSquared = d[0] * d[0] + d[1] * d[1];
      const t = lengthSquared < 1e-18 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * d[0] + (point[1] - a[1]) * d[1]) / lengthSquared));
      best = Math.min(best, dist(point, [a[0] + d[0] * t, a[1] + d[1] * t]));
    }
  }
  return best;
}

function sourceRuns(chain: Chain): readonly (readonly Vec2[])[] {
  return chain.pieces.map((piece) => samplePiece(piece, 48));
}

// ---------------------------------------------------------------------------------------------
// Standalone entities
// ---------------------------------------------------------------------------------------------

function flagsOf(entity: SketchEntity): { readonly construction: boolean; readonly visible?: boolean } {
  return { construction: entity.construction, ...(entity.visible === undefined ? {} : { visible: entity.visible }) };
}

function ellipseOffset(context: SketchEditContext, entity: Extract<SketchEntity, { kind: "ellipse" }>, outward: number): SketchEntity | string {
  const { majorRadiusMm: a, minorRadiusMm: b } = entity;
  if (outward < 0 && -outward >= (b * b) / a - 1e-9) return `The inward offset is larger than the ellipse's smallest radius of curvature (${fmt((b * b) / a)} mm), so the offset would fold over itself.`;
  if (b + outward < MIN_MM) return "The inward offset is larger than the ellipse's minor radius.";
  const radians = (entity.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const count = 23;
  const points: Vec2[] = Array.from({ length: count }, (_, index): Vec2 => {
    const t = (index / count) * TWO_PI;
    const x = a * Math.cos(t);
    const y = b * Math.sin(t);
    const normal = unit([b * Math.cos(t), a * Math.sin(t)]);
    const px = x + normal[0] * outward;
    const py = y + normal[1] * outward;
    return [entity.center[0] + px * cos - py * sin, entity.center[1] + px * sin + py * cos];
  });
  return { id: context.newId("entity"), kind: "spline", fitPoints: [...points, points[0]!], ...flagsOf(entity) };
}

function splineOffset(context: SketchEditContext, entity: Extract<SketchEntity, { kind: "spline" }>, signedLeft: number): SketchEntity | string {
  const samples = sampleSpline(entity.fitPoints, 24);
  const left: Vec2[] = [];
  for (let index = 0; index < samples.length; index += 1) {
    const previous = samples[Math.max(0, index - 1)]!;
    const next = samples[Math.min(samples.length - 1, index + 1)]!;
    const tangent = unit([next[0] - previous[0], next[1] - previous[1]]);
    left.push([samples[index]![0] - tangent[1] * signedLeft, samples[index]![1] + tangent[0] * signedLeft]);
  }
  if (selfCrosses([left], false)) return "The offset distance is larger than the spline's tightest curve, so the offset would fold over itself.";
  const total = left.reduce((sum, point, index) => (index === 0 ? 0 : sum + dist(left[index - 1]!, point)), 0);
  const count = Math.min(24, Math.max(entity.fitPoints.length + 4, Math.ceil(total / Math.max(1, Math.abs(signedLeft))) + 3));
  const cumulative = [0];
  for (let index = 1; index < left.length; index += 1) cumulative.push(cumulative[index - 1]! + dist(left[index - 1]!, left[index]!));
  const fit: Vec2[] = [];
  for (let step = 0; step < count; step += 1) {
    const s = (cumulative[cumulative.length - 1]! * step) / (count - 1);
    let index = 1;
    while (index < cumulative.length - 1 && cumulative[index]! < s) index += 1;
    const span = cumulative[index]! - cumulative[index - 1]!;
    const t = span < 1e-12 ? 0 : (s - cumulative[index - 1]!) / span;
    const a = left[index - 1]!;
    const b = left[index]!;
    fit.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return { id: context.newId("entity"), kind: "spline", fitPoints: fit, ...flagsOf(entity) };
}

// ---------------------------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------------------------

/**
 * Offsets the selected curves by `distanceMm`. Positive is outward for circles, arcs, rectangles, ellipses and closed loops; for an open
 * chain it is the left of the chain read from its lower-left end, so it does not depend on how the lines were drawn. `flip`, `both` and
 * `sidePoint` choose the side. Connected lines and arcs are offset as one chain with their corners mitred, rounded or chamfered.
 */
export function offsetEntities(context: SketchEditContext, ids: readonly string[], distanceMm: number, options: OffsetOptions = {}): SketchEditResult {
  if (!Number.isFinite(distanceMm) || Math.abs(distanceMm) < 0.01 || Math.abs(distanceMm) > 5000) return reject("Enter an offset distance between 0.01 mm and 5000 mm (negative offsets to the other side).");
  const sketch = context.sketch;
  const requested = ids.map((id) => sketch.entities.find((entity) => entity.id === id));
  if (requested.length === 0 || requested.some((entity) => entity === undefined)) return reject("Select the curves to offset.");
  const chainIds = expandOffsetSelection(sketch, ids, options.chain ?? "tangent");
  const selected = chainIds.map((id) => sketch.entities.find((entity) => entity.id === id)!);
  const corner = options.corner ?? "mitre";
  const withRelations = options.relations !== false;
  const magnitude = Math.abs(distanceMm);
  // The sides to offset to, as signed "outward" distances: a sidePoint picks one, `both` takes two.
  const outwardList = options.both === true ? [magnitude, -magnitude] : [(options.flip === true ? -1 : 1) * distanceMm];
  const added: SketchEntity[] = [];
  const constraints: WorkbenchSketchConstraint[] = [];
  const lines = selected.filter(isRound);

  for (const entity of selected) {
    if (isRound(entity)) continue;
    for (const outwardRaw of outwardList) {
      let outward = outwardRaw;
      if (options.sidePoint !== undefined && options.both !== true) {
        const inside = entity.kind === "circle" ? dist(options.sidePoint, entity.center) < entity.radiusMm
          : entity.kind === "rectangle" ? insideRectangle(entity, options.sidePoint)
          : entity.kind === "ellipse" ? insideEllipse(entity, options.sidePoint) : undefined;
        if (inside !== undefined) outward = inside ? -magnitude : magnitude;
      }
      if (entity.kind === "circle") {
        const radiusMm = entity.radiusMm + outward;
        if (radiusMm < MIN_MM) return reject("The inward offset is larger than the circle's radius.", [entity.id]);
        const made: SketchEntity = { ...entity, id: context.newId("entity"), radiusMm };
        added.push(made);
        if (withRelations) constraints.push(pairRelation(context, "concentric", entity.id, made.id));
      } else if (entity.kind === "rectangle") {
        const widthMm = entity.widthMm + 2 * outward;
        const heightMm = entity.heightMm + 2 * outward;
        if (widthMm < MIN_MM || heightMm < MIN_MM) return reject("The inward offset is larger than the rectangle.", [entity.id]);
        added.push({ ...entity, id: context.newId("entity"), widthMm, heightMm });
      } else if (entity.kind === "ellipse") {
        const made = ellipseOffset(context, entity, outward);
        if (typeof made === "string") return reject(made, [entity.id]);
        added.push(made);
      } else if (entity.kind === "spline") {
        const first = entity.fitPoints[0]!;
        const last = entity.fitPoints[entity.fitPoints.length - 1]!;
        const flipTravel = first[0] > last[0] + 1e-9 || (Math.abs(first[0] - last[0]) <= 1e-9 && first[1] > last[1]);
        // Canonical travel runs from the lower-left end and positive is its left; the spline's own points may run the other way.
        let leftOfEntity = flipTravel ? -outward : outward;
        if (options.sidePoint !== undefined && options.both !== true) {
          const samples = sampleSpline(entity.fitPoints, 12);
          let best = Infinity;
          let sign = 1;
          for (let index = 0; index < samples.length - 1; index += 1) {
            const a = samples[index]!;
            const b = samples[index + 1]!;
            const gap = dist(options.sidePoint, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
            if (gap < best) { best = gap; sign = (b[0] - a[0]) * (options.sidePoint[1] - a[1]) - (b[1] - a[1]) * (options.sidePoint[0] - a[0]) >= 0 ? 1 : -1; }
          }
          leftOfEntity = sign * magnitude;
        }
        const made = splineOffset(context, entity, leftOfEntity);
        if (typeof made === "string") return reject(made, [entity.id]);
        added.push(made);
      } else {
        return reject(`Offset applies to lines, arcs, circles, rectangles, ellipses and splines; a ${entity.kind} cannot be offset.`, [entity.id]);
      }
    }
  }

  if (lines.length > 0) {
    let built = buildChains(lines, joinTolerance(sketch));
    // Pulling in tangent neighbours must never be what makes a selection branch: fall back to exactly what was selected.
    if ("error" in built && chainIds.length > ids.length) built = buildChains(ids.map((id) => sketch.entities.find((entity) => entity.id === id)).filter(isRound), joinTolerance(sketch));
    if ("error" in built) return reject(built.error, built.ids, "Select one chain or loop at a time, or choose the chain option 'none' and pick the curves yourself.");
    for (const chain of built.chains) {
      const ids = chain.pieces.map((piece) => piece.entity.id);
      const outline = chain.pieces.flatMap((piece) => samplePiece(piece, 24).slice(0, -1));
      const loneArc = !chain.closed && chain.pieces.length === 1 && chain.pieces[0]!.center !== undefined;
      for (const outwardRaw of outwardList) {
        let outward = outwardRaw;
        // Signed offset to the left of travel.
        let signed: number;
        if (options.sidePoint !== undefined && options.both !== true) signed = sideOfPoint(chain, options.sidePoint) * magnitude;
        else if (chain.closed) signed = polygonArea(outline) > 0 ? -outward : outward;
        else if (loneArc) signed = -chain.pieces[0]!.sigma! * outward;
        else signed = outward;
        outward = signed;
        const result = buildOffsetChain(context, chain, signed, corner, flagsOf);
        if (typeof result === "string") return reject(result, ids);
        const runs = result.samples;
        if (selfCrosses(runs, chain.closed)) return reject("The offset overlaps itself: some feature of the shape is narrower than twice the distance.", ids, "Use a smaller distance, or offset to the other side.");
        const originals = sourceRuns(chain);
        if (chain.pieces.length <= 200) {
          // The source is a polyline of 48 chords per arc, which sits inside its arcs by at most the chord sag.
          const sag = Math.max(0, ...chain.pieces.map((piece) => (piece.radius === undefined ? 0 : piece.radius * (1 - Math.cos(Math.PI / 48)))));
          const floor = Math.abs(signed) * (1 - 1e-3) - 1e-6 - sag;
          const tooClose = result.checked.some((run) => (run.length === 2 ? densify(run, Math.abs(signed) / 2) : run).some((point) => distanceToRuns(point, originals) < floor));
          if (tooClose) return reject("The offset overlaps itself: some feature of the shape is narrower than twice the distance.", ids, "Use a smaller distance, or offset to the other side.");
        }
        added.push(...result.entities);
        if (withRelations) constraints.push(...offsetRelations(context, chain, result));
      }
    }
  }
  const total = selected.length;
  const sides = options.both === true ? " (both sides)" : "";
  return finishPlan(context, { label: `Offset ${total} curve${total === 1 ? "" : "s"} by ${fmt(distanceMm)} mm${sides}`, removeEntityIds: [], updateEntities: [], addEntities: added, addConstraints: constraints });
}

function offsetRelations(context: SketchEditContext, chain: Chain, built: Built): readonly WorkbenchSketchConstraint[] {
  const relations: WorkbenchSketchConstraint[] = [];
  for (const part of built.parts) {
    if (part.source.kind === "line") relations.push(pairRelation(context, "parallel", part.source.id, part.made.id));
    else relations.push(pairRelation(context, "concentric", part.source.id, part.made.id));
  }
  const count = built.parts.length;
  const joints = chain.closed ? count : count - 1;
  for (let index = 0; index < joints; index += 1) {
    const a = built.parts[index]!;
    const b = built.parts[(index + 1) % count]!;
    const filler = built.fillers.find((entry) => entry.afterPiece === index);
    if (filler === undefined) {
      relations.push(jointRelation(context, a.made.id, a.atTo, b.made.id, b.atFrom));
      // A smooth junction in the source stays smooth in the offset.
      if (a.made.kind !== b.made.kind || a.made.kind === "arc") {
        const ta = pieceTangentAt(chain.pieces[index]!, "to");
        const tb = pieceTangentAt(chain.pieces[(index + 1) % count]!, "from");
        if (Math.abs(ta[0] * tb[1] - ta[1] * tb[0]) < 1e-9 && ta[0] * tb[0] + ta[1] * tb[1] > 0) relations.push(pairRelation(context, "tangent", a.made.id, b.made.id));
      }
    } else {
      relations.push(jointRelation(context, a.made.id, a.atTo, filler.made.id, "start"), jointRelation(context, filler.made.id, "end", b.made.id, b.atFrom));
    }
  }
  return relations;
}

function pieceTangentAt(piece: Piece, end: "from" | "to"): Vec2 {
  if (piece.center === undefined || piece.sigma === undefined) return unit([piece.to[0] - piece.from[0], piece.to[1] - piece.from[1]]);
  const point = end === "from" ? piece.from : piece.to;
  const radial = unit([point[0] - piece.center[0], point[1] - piece.center[1]]);
  return [-radial[1] * piece.sigma, radial[0] * piece.sigma];
}

function insideRectangle(entity: Extract<SketchEntity, { kind: "rectangle" }>, point: Vec2): boolean {
  const radians = (entity.rotationDeg * Math.PI) / 180;
  const dx = point[0] - entity.center[0];
  const dy = point[1] - entity.center[1];
  const x = dx * Math.cos(radians) + dy * Math.sin(radians);
  const y = -dx * Math.sin(radians) + dy * Math.cos(radians);
  return Math.abs(x) < entity.widthMm / 2 && Math.abs(y) < entity.heightMm / 2;
}

function insideEllipse(entity: Extract<SketchEntity, { kind: "ellipse" }>, point: Vec2): boolean {
  const radians = (entity.rotationDeg * Math.PI) / 180;
  const dx = point[0] - entity.center[0];
  const dy = point[1] - entity.center[1];
  const x = dx * Math.cos(radians) + dy * Math.sin(radians);
  const y = -dx * Math.sin(radians) + dy * Math.cos(radians);
  return (x / entity.majorRadiusMm) ** 2 + (y / entity.minorRadiusMm) ** 2 < 1;
}
