import { DEFAULT_K_FACTOR, sheetBendAllowanceMm, sheetBendDeductionMm, type FlatPattern } from "./sheet-metal.js";
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
}

export interface PlateFlange {
  /** Index into the plate's top-face edge list (`sheetFrameOf`). */
  readonly edgeIndex: number;
  readonly innerRadiusMm: number;
  readonly flangeLengthMm: number;
  readonly angleDeg: number;
  /** Gap left between this flange and a neighbouring flange at a shared corner; each of the two gives up half. */
  readonly reliefMm?: number;
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

/**
 * Unfolds a plate with flanges into its flat blank. The plate's top-face boundary is chained into closed loops (the largest is the
 * blank, the rest are holes); each flange replaces its edge with a rectangle as wide as the edge and as long as the bend allowance
 * plus the flange, and a bend line marks the middle of each bend. Where two flanges meet at a corner and carry a relief, each
 * stops half the relief short of the corner; without one, `notes` says the corner needs a relief.
 */
export function flatPatternOfPlate(frame: SheetFrame, plane: SheetPlane, flanges: readonly PlateFlange[], kFactor = DEFAULT_K_FACTOR): SheetFlatPattern | { readonly error: string } {
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
  let totalAllowance = 0;
  let totalDeduction = 0;
  const reliefFlanges = [...flangeByEdge.values()].map((flange) => ({ edgeIndex: flange.edgeIndex, reliefMm: flange.reliefMm ?? 0 }));
  let reliefApplied = false;
  const outlines = loops.map((loop) => {
    const points: Point2[] = [];
    for (const index of loop) {
      const edge = edges[index]!;
      points.push(edge.a);
      const flange = flangeByEdge.get(index);
      if (flange === undefined) continue;
      const allowance = sheetBendAllowanceMm(flange.angleDeg, flange.innerRadiusMm, frame.thicknessMm, kFactor);
      const reach = allowance + flange.flangeLengthMm;
      totalAllowance += allowance;
      totalDeduction += sheetBendDeductionMm(flange.angleDeg, flange.innerRadiusMm, frame.thicknessMm, kFactor);
      const reliefs = flangeReliefs(frame, index, reliefFlanges);
      const length = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1]);
      const dir: Point2 = length < 1e-9 ? [0, 0] : [(edge.b[0] - edge.a[0]) / length, (edge.b[1] - edge.a[1]) / length];
      const from: Point2 = [edge.a[0] + dir[0] * reliefs.startMm, edge.a[1] + dir[1] * reliefs.startMm];
      const to: Point2 = [edge.b[0] - dir[0] * reliefs.endMm, edge.b[1] - dir[1] * reliefs.endMm];
      if (reliefs.startMm > 0 || reliefs.endMm > 0) reliefApplied = true;
      if (reliefs.startMm > 0) points.push(from);
      points.push([from[0] + edge.o[0] * reach, from[1] + edge.o[1] * reach], [to[0] + edge.o[0] * reach, to[1] + edge.o[1] * reach]);
      if (reliefs.endMm > 0) points.push(to);
      const mid = allowance / 2;
      bendLines.push([[from[0] + edge.o[0] * mid, from[1] + edge.o[1] * mid], [to[0] + edge.o[0] * mid, to[1] + edge.o[1] * mid]]);
    }
    return points;
  });
  const flangedEdges = [...flangeByEdge.keys()];
  const notes: string[] = [];
  const touching = flangedEdges.some((first) => flangedEdges.some((second) => first < second && (keyOf(edges[first]!.a) === keyOf(edges[second]!.b) || keyOf(edges[first]!.b) === keyOf(edges[second]!.a))));
  if (touching && !reliefApplied) notes.push("Flanges on neighbouring edges meet at a corner with no corner relief; give the flanges a corner relief before cutting.");
  const all = outlines.flat();
  return {
    outlinesMm: outlines,
    bendLinesMm: bendLines,
    boundsMm: { minX: Math.min(...all.map((p) => p[0])), minY: Math.min(...all.map((p) => p[1])), maxX: Math.max(...all.map((p) => p[0])), maxY: Math.max(...all.map((p) => p[1])) },
    bendCount: bendLines.length,
    totalBendAllowanceMm: totalAllowance,
    totalBendDeductionMm: totalDeduction,
    thicknessMm: frame.thicknessMm,
    notes
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
