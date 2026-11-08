import { DEFAULT_K_FACTOR, type FlatPattern } from "./sheet-metal.js";
import { bendResolverOf, developBend, type BendKResolver, type BendRecord, type BendTable } from "./bend-table.js";
import { jogProfile } from "./sheet-jog.js";
import { mitreTangent } from "./sheet-miter.js";
import { flangeReliefs, type SheetFrame } from "./sheet-edge-flange.js";

type Point2 = readonly [number, number];
type Vec3 = readonly [number, number, number];

export type SheetPlane = "xy" | "xz" | "yz";

/**
 * The sketch coordinates (u, v) of a world point or direction for a sketch drawn on `plane`; this inverts the plane placement the
 * tessellators use, so a plate's 3D edges can be flattened back into its sketch plane.
 */
export function planeCoordinates(point: Vec3, plane: SheetPlane): Point2 {
  if (plane === "xz") return [point[0], point[2]];
  if (plane === "yz") return [-point[2], point[1]];
  return [point[0], point[1]];
}

/** What a flat pattern is drawn from: closed outlines (the blank first, then any holes) and the bend lines across it. */
export interface FlatLayout {
  readonly outlinesMm: readonly (readonly Point2[])[];
  readonly bendLinesMm: readonly (readonly [Point2, Point2])[];
}

export interface SheetFlatPattern extends FlatLayout {
  readonly boundsMm: { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number };
  readonly bendCount: number;
  readonly totalBendAllowanceMm: number;
  readonly totalBendDeductionMm: number;
  readonly thicknessMm: number;
  readonly notes: readonly string[];
  /** Every bend of the part with the K-factor it was developed with and where that K-factor came from. */
  readonly bends: readonly BendRecord[];
}

export interface PlateFlange {
  /** Index into the plate's top-face edge list (`sheetFrameOf`). */
  readonly edgeIndex: number;
  readonly innerRadiusMm: number;
  readonly flangeLengthMm: number;
  readonly angleDeg: number;
  /** Gap left between this flange and a neighbouring flange at a shared corner; each of the two gives up half. */
  readonly reliefMm?: number;
  /** This end of the flange is mitred to the next flange of a miter flange chain: its cut runs on the corner's bisector instead of square. */
  readonly mitreStart?: boolean;
  readonly mitreEnd?: boolean;
}

/** A jog across the plate: see `JogSpec`. Jogs of one plate run parallel to the same edge, in order away from it. */
export interface PlateJog {
  readonly edgeIndex: number;
  readonly positionMm: number;
  readonly offsetMm: number;
  readonly angleDeg: number;
  readonly innerRadiusMm: number;
}

const KEY_SCALE = 1e4;
const keyOf = (point: Point2): string => `${Math.round(point[0] * KEY_SCALE)},${Math.round(point[1] * KEY_SCALE)}`;

function loopArea(points: readonly Point2[]): number {
  let area = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i]!;
    const b = points[(i + 1) % points.length]!;
    area += a[0] * b[1] - b[0] * a[1];
  }
  return area / 2;
}

/** Outward distance of the neutral fibre of a bend, at developed distance `rho` from the bend's start (the plate edge). */
function neutralOffset(rho: number, allowance: number, neutralRadius: number, angleRad: number): number {
  if (rho <= allowance) return allowance < 1e-12 ? 0 : neutralRadius * Math.sin(angleRad * rho / allowance);
  return neutralRadius * Math.sin(angleRad) + (rho - allowance) * Math.cos(angleRad);
}

/**
 * Applies a jog to a flat layout. The layout is still the plate as designed; the jog's strip, `zoneMm` long from `startMm` away from
 * the reference edge, becomes `flatZoneMm` long (the bends developed with their K-factor) and everything beyond moves with it.
 * Straight outline edges that cross either end of the strip are cut there first so they stay straight afterwards.
 */
function applyJogToLayout(outlines: Point2[][], bendLines: (readonly [Point2, Point2])[], origin: Point2, inward: Point2, startMm: number, zoneMm: number, flatZoneMm: number): void {
  const across = (point: Point2): number => (point[0] - origin[0]) * inward[0] + (point[1] - origin[1]) * inward[1];
  const mapAcross = (w: number): number => (w <= startMm ? w : w <= startMm + zoneMm ? startMm + (w - startMm) * flatZoneMm / zoneMm : w + flatZoneMm - zoneMm);
  const move = (point: Point2): Point2 => { const w = across(point); const delta = mapAcross(w) - w; return [point[0] + inward[0] * delta, point[1] + inward[1] * delta]; };
  for (let index = 0; index < outlines.length; index += 1) {
    const loop = outlines[index]!;
    const cut: Point2[] = [];
    for (let i = 0; i < loop.length; i += 1) {
      const p = loop[i]!;
      const q = loop[(i + 1) % loop.length]!;
      cut.push(p);
      const wp = across(p);
      const wq = across(q);
      const crossings = [startMm, startMm + zoneMm].filter((w) => (wp < w - 1e-9 && wq > w + 1e-9) || (wp > w + 1e-9 && wq < w - 1e-9)).sort((a, b) => (wp < wq ? a - b : b - a));
      for (const w of crossings) {
        const t = (w - wp) / (wq - wp);
        cut.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
      }
    }
    outlines[index] = cut.map(move);
  }
  for (let index = 0; index < bendLines.length; index += 1) bendLines[index] = [move(bendLines[index]![0]), move(bendLines[index]![1])];
}

/** The pieces of the line `across = w` that lie inside the outlines (even-odd, so holes are left out), as pairs of points. */
function segmentsAcross(outlines: readonly (readonly Point2[])[], origin: Point2, inward: Point2, lateral: Point2, w: number): (readonly [Point2, Point2])[] {
  const across = (point: Point2): number => (point[0] - origin[0]) * inward[0] + (point[1] - origin[1]) * inward[1];
  const along = (point: Point2): number => (point[0] - origin[0]) * lateral[0] + (point[1] - origin[1]) * lateral[1];
  const hits: number[] = [];
  for (const loop of outlines) {
    for (let i = 0; i < loop.length; i += 1) {
      const p = loop[i]!;
      const q = loop[(i + 1) % loop.length]!;
      const wp = across(p);
      const wq = across(q);
      if ((wp <= w) === (wq <= w)) continue;
      const t = (w - wp) / (wq - wp);
      hits.push(along(p) + (along(q) - along(p)) * t);
    }
  }
  hits.sort((a, b) => a - b);
  const segments: (readonly [Point2, Point2])[] = [];
  const at = (l: number): Point2 => [origin[0] + inward[0] * w + lateral[0] * l, origin[1] + inward[1] * w + lateral[1] * l];
  for (let i = 0; i + 1 < hits.length; i += 2) segments.push([at(hits[i]!), at(hits[i + 1]!)]);
  return segments;
}

/**
 * Unfolds a plate with flanges into its flat blank. The plate's top-face boundary is chained into closed loops (the largest is the
 * blank, the rest are holes); each flange replaces its edge with a rectangle as wide as the edge and as long as the bend allowance
 * plus the flange, and a bend line marks the middle of each bend. Where two flanges meet at a corner and carry a relief, each
 * stops half the relief short of the corner; without one, `notes` says the corner needs a relief. Where they share a mitre
 * (a miter flange), each is cut along the neutral fibre's mitre line instead, so the two blanks meet along the cut.
 *
 * `kFactor` is a fixed K-factor or a resolver that reads one per bend from a bend table. `jogs` are then folded in: each
 * jog adds two bend lines and lengthens the blank by the difference between its developed length and the ground it covers.
 */
export function flatPatternOfPlate(frame: SheetFrame, plane: SheetPlane, flanges: readonly PlateFlange[], kFactor: number | BendKResolver | BendTable = DEFAULT_K_FACTOR, jogs: readonly PlateJog[] = []): SheetFlatPattern | { readonly error: string } {
  const resolver: BendKResolver = typeof kFactor === "function" ? kFactor : bendResolverOf(kFactor);
  const edges = frame.edges.map((edge) => ({ a: planeCoordinates(edge.startMm, plane), b: planeCoordinates(edge.endMm, plane), o: planeCoordinates(edge.outward, plane) }));
  const byStart = new Map<string, number>();
  edges.forEach((edge, index) => byStart.set(keyOf(edge.a), index));
  const visited = new Set<number>();
  const loops: number[][] = [];
  for (let first = 0; first < edges.length; first += 1) {
    if (visited.has(first)) continue;
    const loop: number[] = [];
    let current: number | undefined = first;
    while (current !== undefined && !visited.has(current)) {
      visited.add(current);
      loop.push(current);
      current = byStart.get(keyOf(edges[current]!.b));
    }
    if (current !== first || loop.length < 3) return { error: "The plate's outline is not a clean closed loop, so it cannot be unfolded." };
    loops.push(loop);
  }
  if (loops.length === 0) return { error: "The plate has no outline to unfold." };
  const areas = loops.map((loop) => loopArea(loop.map((index) => edges[index]!.a)));
  const outerIndex = areas.reduce((best, area, index) => (Math.abs(area) > Math.abs(areas[best]!) ? index : best), 0);
  const flangeByEdge = new Map<number, PlateFlange>();
  for (const flange of flanges) {
    if (edges[flange.edgeIndex] === undefined) return { error: `There is no edge ${flange.edgeIndex} on this plate.` };
    if (flangeByEdge.has(flange.edgeIndex)) return { error: `Edge ${flange.edgeIndex} has more than one flange.` };
    if (!loops[outerIndex]!.includes(flange.edgeIndex)) return { error: `Edge ${flange.edgeIndex} is on a hole, and flanges on hole edges cannot be unfolded.` };
    flangeByEdge.set(flange.edgeIndex, flange);
  }
  const bendLines: (readonly [Point2, Point2])[] = [];
  const bends: BendRecord[] = [];
  const reliefFlanges = [...flangeByEdge.values()].map((flange) => ({ edgeIndex: flange.edgeIndex, reliefMm: flange.reliefMm ?? 0 }));
  let reliefApplied = false;
  const notes: string[] = [];
  const outlines: Point2[][] = loops.map((loop) => {
    const points: Point2[] = [];
    loop.forEach((index, position) => {
      const edge = edges[index]!;
      points.push(edge.a);
      const flange = flangeByEdge.get(index);
      if (flange === undefined) return;
      const bend = developBend(resolver, frame.thicknessMm, flange.innerRadiusMm, flange.angleDeg);
      bends.push(bend);
      const allowance = bend.bendAllowanceMm;
      const reach = allowance + flange.flangeLengthMm;
      const neutralRadius = flange.innerRadiusMm + bend.kFactor * frame.thicknessMm;
      const angleRad = flange.angleDeg * Math.PI / 180;
      const previous = loop[(position + loop.length - 1) % loop.length]!;
      const following = loop[(position + 1) % loop.length]!;
      const mitreStart = flange.mitreStart === true ? mitreTangent(frame, previous, index) : undefined;
      const mitreEnd = flange.mitreEnd === true ? mitreTangent(frame, index, following) : undefined;
      if ((flange.mitreStart === true && mitreStart === undefined) || (flange.mitreEnd === true && mitreEnd === undefined)) notes.push(`Edge ${index}: a mitre corner could not be developed, so that end is cut square.`);
      const reliefs = flangeReliefs(frame, index, reliefFlanges);
      const length = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
      const dir: Point2 = length < 1e-9 ? [0, 0] : [(edge.b[0] - edge.a[0]) / length, (edge.b[1] - edge.a[1]) / length];
      const reliefStart = mitreStart === undefined ? reliefs.startMm : 0;
      const reliefEnd = mitreEnd === undefined ? reliefs.endMm : 0;
      const offset = (rho: number) => neutralOffset(rho, allowance, neutralRadius, angleRad);
      // Along the edge, an end runs to the relief gap, or on past the corner by (offset x tan(turn / 2)) where it is mitred.
      const startAlong = (rho: number): number => (mitreStart === undefined ? reliefStart : -mitreStart * offset(rho));
      const endAlong = (rho: number): number => (mitreEnd === undefined ? -reliefEnd : mitreEnd * offset(rho));
      const startPoint = (rho: number): Point2 => [edge.a[0] + dir[0] * startAlong(rho) + edge.o[0] * rho, edge.a[1] + dir[1] * startAlong(rho) + edge.o[1] * rho];
      const endPoint = (rho: number): Point2 => [edge.b[0] + dir[0] * endAlong(rho) + edge.o[0] * rho, edge.b[1] + dir[1] * endAlong(rho) + edge.o[1] * rho];
      // A mitre cut is curved across the bend, so it is followed in steps; a square end only needs its tip.
      const steps = Math.max(1, Math.ceil(flange.angleDeg / 15));
      const mitreRhos = allowance < 1e-9 ? [] : Array.from({ length: steps }, (_, k) => allowance * (k + 1) / steps);
      if (reliefStart > 0 || reliefEnd > 0) reliefApplied = true;
      if (reliefStart > 0) points.push([edge.a[0] + dir[0] * reliefStart, edge.a[1] + dir[1] * reliefStart]);
      if (mitreStart !== undefined) for (const rho of mitreRhos) points.push(startPoint(rho));
      points.push(startPoint(reach));
      points.push(endPoint(reach));
      if (mitreEnd !== undefined) for (const rho of [...mitreRhos].reverse()) points.push(endPoint(rho));
      if (reliefEnd > 0) points.push([edge.b[0] - dir[0] * reliefEnd, edge.b[1] - dir[1] * reliefEnd]);
      const mid = allowance / 2;
      bendLines.push([startPoint(mid), endPoint(mid)]);
    });
    return points;
  });
  const flangedEdges = [...flangeByEdge.keys()];
  const mitred = (first: number, second: number): boolean => flangeByEdge.get(first)?.mitreEnd === true && flangeByEdge.get(second)?.mitreStart === true;
  const touching = flangedEdges.some((first) => flangedEdges.some((second) => first < second && ((keyOf(edges[first]!.a) === keyOf(edges[second]!.b) && !mitred(second, first)) || (keyOf(edges[first]!.b) === keyOf(edges[second]!.a) && !mitred(first, second)))));
  if (touching && !reliefApplied) notes.push("Flanges on neighbouring edges meet at a corner with no corner relief; give the flanges a corner relief before cutting.");
  // Jogs: all run parallel to one edge and are applied in order away from it.
  let totalAllowance = bends.reduce((sum, bend) => sum + bend.bendAllowanceMm, 0);
  let totalDeduction = bends.reduce((sum, bend) => sum + bend.bendDeductionMm, 0);
  if (jogs.length > 0) {
    const reference = edges[jogs[0]!.edgeIndex];
    if (reference === undefined) return { error: `There is no edge ${jogs[0]!.edgeIndex} for the jog to run parallel to.` };
    if (jogs.some((jog) => jog.edgeIndex !== jogs[0]!.edgeIndex)) return { error: "Jogs on different edges of one plate cannot be unfolded together; keep them parallel to one edge." };
    const inward: Point2 = [-reference.o[0], -reference.o[1]];
    const length = Math.hypot(reference.b[0] - reference.a[0], reference.b[1] - reference.a[1]);
    const lateral: Point2 = [(reference.b[0] - reference.a[0]) / length, (reference.b[1] - reference.a[1]) / length];
    let shift = 0;
    for (const jog of jogs) {
      const made = jogProfile(jog, frame.thicknessMm);
      if (!made.ok) return { error: made.message };
      const profile = made.profile;
      const bend = developBend(resolver, frame.thicknessMm, jog.innerRadiusMm, jog.angleDeg);
      const flatZone = 2 * bend.bendAllowanceMm + profile.webMm;
      const start = jog.positionMm + shift;
      applyJogToLayout(outlines, bendLines as (readonly [Point2, Point2])[], reference.a, inward, start, profile.zoneMm, flatZone);
      for (const w of [start + bend.bendAllowanceMm / 2, start + bend.bendAllowanceMm * 1.5 + profile.webMm]) bendLines.push(...segmentsAcross(outlines, reference.a, inward, lateral, w));
      bends.push(bend, bend);
      totalAllowance += 2 * bend.bendAllowanceMm;
      totalDeduction += 2 * bend.bendDeductionMm;
      shift += flatZone - profile.runMm;
    }
  }
  const all = outlines.flat();
  return {
    outlinesMm: outlines,
    bendLinesMm: bendLines,
    boundsMm: { minX: Math.min(...all.map((p) => p[0])), minY: Math.min(...all.map((p) => p[1])), maxX: Math.max(...all.map((p) => p[0])), maxY: Math.max(...all.map((p) => p[1])) },
    bendCount: bends.length,
    totalBendAllowanceMm: totalAllowance,
    totalBendDeductionMm: totalDeduction,
    thicknessMm: frame.thicknessMm,
    notes,
    bends
  };
}

/** Lets the single-bend `flatPatternOf` result use the same SVG and DXF writers. */
export function layoutOfFlatPattern(pattern: FlatPattern): FlatLayout {
  return { outlinesMm: [pattern.outlineMm], bendLinesMm: pattern.bendLinesMm };
}

function layoutBounds(layout: FlatLayout): { readonly minX: number; readonly minY: number; readonly maxX: number; readonly maxY: number } {
  const points = [...layout.outlinesMm.flat(), ...layout.bendLinesMm.flat()];
  if (points.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX: Math.min(...points.map((p) => p[0])), minY: Math.min(...points.map((p) => p[1])), maxX: Math.max(...points.map((p) => p[0])), maxY: Math.max(...points.map((p) => p[1])) };
}

const fixed = (value: number): string => String(Number(value.toFixed(4)));

/** SVG of a flat layout in millimetres (1 unit = 1 mm), y pointing up as in the sketch: solid outlines and dashed bend lines. */
export function flatLayoutSvg(layout: FlatLayout): string {
  const pad = 5;
  const bounds = layoutBounds(layout);
  const width = bounds.maxX - bounds.minX + pad * 2;
  const height = bounds.maxY - bounds.minY + pad * 2;
  const x = (value: number): string => fixed(value - bounds.minX + pad);
  const y = (value: number): string => fixed(bounds.maxY - value + pad);
  const outlines = layout.outlinesMm.map((loop) => `<path class="flat-outline" d="${loop.map((p, i) => `${i === 0 ? "M" : "L"}${x(p[0])} ${y(p[1])}`).join("")}Z" fill="none" stroke="#173346" stroke-width="0.5"/>`).join("");
  const bends = layout.bendLinesMm.map(([a, b]) => `<path class="bend-line" d="M${x(a[0])} ${y(a[1])}L${x(b[0])} ${y(b[1])}" fill="none" stroke="#b24646" stroke-width="0.3" stroke-dasharray="3 1.5"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${fixed(width)}mm" height="${fixed(height)}mm" viewBox="0 0 ${fixed(width)} ${fixed(height)}"><title>Flat pattern ${fixed(bounds.maxX - bounds.minX)} x ${fixed(bounds.maxY - bounds.minY)} mm</title>${outlines}${bends}</svg>`;
}

/**
 * ASCII DXF (R12) of a flat layout in millimetres: outlines as LINE entities on layer OUTLINE and bend lines on layer BEND with a
 * dashed line type. Plain LINEs open in every CAD and laser-cutting package without needing polyline support.
 */
export function flatLayoutDxf(layout: FlatLayout): string {
  const lines: string[] = [];
  const pair = (code: number, value: string | number): void => { lines.push(String(code), String(value)); };
  pair(0, "SECTION"); pair(2, "HEADER"); pair(9, "$ACADVER"); pair(1, "AC1009"); pair(9, "$INSUNITS"); pair(70, 4); pair(0, "ENDSEC");
  pair(0, "SECTION"); pair(2, "TABLES");
  pair(0, "TABLE"); pair(2, "LTYPE"); pair(70, 2);
  pair(0, "LTYPE"); pair(2, "CONTINUOUS"); pair(70, 0); pair(3, "Solid line"); pair(72, 65); pair(73, 0); pair(40, 0);
  pair(0, "LTYPE"); pair(2, "DASHED"); pair(70, 0); pair(3, "Dashed"); pair(72, 65); pair(73, 2); pair(40, 6); pair(49, 4); pair(49, -2);
  pair(0, "ENDTAB");
  pair(0, "TABLE"); pair(2, "LAYER"); pair(70, 2);
  pair(0, "LAYER"); pair(2, "OUTLINE"); pair(70, 0); pair(62, 7); pair(6, "CONTINUOUS");
  pair(0, "LAYER"); pair(2, "BEND"); pair(70, 0); pair(62, 1); pair(6, "DASHED");
  pair(0, "ENDTAB");
  pair(0, "ENDSEC");
  pair(0, "SECTION"); pair(2, "ENTITIES");
  const segment = (layer: string, a: Point2, b: Point2): void => {
    pair(0, "LINE"); pair(8, layer);
    pair(10, fixed(a[0])); pair(20, fixed(a[1])); pair(30, 0);
    pair(11, fixed(b[0])); pair(21, fixed(b[1])); pair(31, 0);
  };
  for (const loop of layout.outlinesMm) for (let i = 0; i < loop.length; i += 1) segment("OUTLINE", loop[i]!, loop[(i + 1) % loop.length]!);
  for (const [a, b] of layout.bendLinesMm) segment("BEND", a, b);
  pair(0, "ENDSEC"); pair(0, "EOF");
  return `${lines.join("\n")}\n`;
}
