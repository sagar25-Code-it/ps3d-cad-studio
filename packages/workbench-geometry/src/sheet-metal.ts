import { tessellateExtrude, type TessellatedMesh, type TessellatePlane } from "./tessellate.js";

type Point2 = readonly [number, number];

/** Default K-factor (neutral-axis position as a fraction of thickness) for air bending in mild steel / aluminium. */
export const DEFAULT_K_FACTOR = 0.44;

/** Arc length of the neutral axis through a bend: angle × (inner radius + K × thickness). */
export function sheetBendAllowanceMm(angleDeg: number, innerRadiusMm: number, thicknessMm: number, kFactor = DEFAULT_K_FACTOR): number {
  return (angleDeg * Math.PI / 180) * (innerRadiusMm + kFactor * thicknessMm);
}

/** Outside setback for a bend of `angleDeg`: tan(angle/2) × (inner radius + thickness). */
export function sheetOutsideSetbackMm(angleDeg: number, innerRadiusMm: number, thicknessMm: number): number {
  return Math.tan((angleDeg * Math.PI / 180) / 2) * (innerRadiusMm + thicknessMm);
}

/** Bend deduction: 2 × outside setback − bend allowance (what is subtracted from the sum of outside leg lengths). */
export function sheetBendDeductionMm(angleDeg: number, innerRadiusMm: number, thicknessMm: number, kFactor = DEFAULT_K_FACTOR): number {
  return 2 * sheetOutsideSetbackMm(angleDeg, innerRadiusMm, thicknessMm) - sheetBendAllowanceMm(angleDeg, innerRadiusMm, thicknessMm, kFactor);
}

export interface BentStripSpec {
  /** Length of the straight leg that stays flat, up to where the bend starts (mm). */
  readonly legMm: number;
  /** Length of the straight flange after the bend (mm). */
  readonly flangeLengthMm: number;
  readonly angleDeg: number;
  readonly innerRadiusMm: number;
  readonly thicknessMm: number;
  /** Strip width, the extrusion depth (mm). */
  readonly widthMm: number;
}

/** Cross-section (u along the leg, v up) of a flat leg that bends upward through `angleDeg` into a straight flange. CCW. */
export function bentStripSection(spec: BentStripSpec): readonly Point2[] {
  const { legMm, flangeLengthMm, angleDeg, innerRadiusMm: r, thicknessMm: t } = spec;
  const steps = Math.max(2, Math.ceil(angleDeg / 15));
  const center: Point2 = [legMm, t + r];
  const outer: Point2[] = [[0, 0]];
  const inner: Point2[] = [[0, t]];
  const sweep = angleDeg * Math.PI / 180;
  for (let i = 0; i <= steps; i += 1) {
    const phi = -Math.PI / 2 + (sweep * i) / steps;
    outer.push([center[0] + (r + t) * Math.cos(phi), center[1] + (r + t) * Math.sin(phi)]);
    inner.push([center[0] + r * Math.cos(phi), center[1] + r * Math.sin(phi)]);
  }
  const endPhi = -Math.PI / 2 + sweep;
  const tangent: Point2 = [-Math.sin(endPhi), Math.cos(endPhi)];
  const lastOuter = outer[outer.length - 1]!;
  const lastInner = inner[inner.length - 1]!;
  outer.push([lastOuter[0] + tangent[0] * flangeLengthMm, lastOuter[1] + tangent[1] * flangeLengthMm]);
  inner.push([lastInner[0] + tangent[0] * flangeLengthMm, lastInner[1] + tangent[1] * flangeLengthMm]);
  return [...outer, ...inner.reverse()];
}

/** A bent sheet-metal strip: the cross-section from `bentStripSection` extruded `widthMm` along the plane normal. */
export function tessellateBentStrip(spec: BentStripSpec, plane: TessellatePlane): TessellatedMesh {
  const { legMm, flangeLengthMm, angleDeg, innerRadiusMm, thicknessMm, widthMm } = spec;
  if (![legMm, flangeLengthMm, angleDeg, innerRadiusMm, thicknessMm, widthMm].every(Number.isFinite)) return { positionsMm: [], indices: [] };
  if (legMm <= 0 || flangeLengthMm <= 0 || thicknessMm <= 0 || widthMm <= 0 || innerRadiusMm < 0 || angleDeg <= 0 || angleDeg > 180) return { positionsMm: [], indices: [] };
  return tessellateExtrude(bentStripSection(spec), widthMm, plane);
}

export interface FlatPattern {
  readonly flatLengthMm: number;
  readonly widthMm: number;
  readonly bendAllowanceMm: number;
  readonly bendDeductionMm: number;
  /** Closed rectangle outline of the unfolded blank. */
  readonly outlineMm: readonly Point2[];
  /** Bend lines as [start, end] segments across the blank, at the middle of each bend. */
  readonly bendLinesMm: readonly (readonly [Point2, Point2])[];
}

/** Unfold a leg + bend + flange into its flat blank: leg + bend allowance + flange along the strip. */
export function flatPatternOf(spec: BentStripSpec, kFactor = DEFAULT_K_FACTOR): FlatPattern {
  const allowance = sheetBendAllowanceMm(spec.angleDeg, spec.innerRadiusMm, spec.thicknessMm, kFactor);
  const flat = spec.legMm + allowance + spec.flangeLengthMm;
  const bendMid = spec.legMm + allowance / 2;
  return {
    flatLengthMm: flat,
    widthMm: spec.widthMm,
    bendAllowanceMm: allowance,
    bendDeductionMm: sheetBendDeductionMm(spec.angleDeg, spec.innerRadiusMm, spec.thicknessMm, kFactor),
    outlineMm: [[0, 0], [flat, 0], [flat, spec.widthMm], [0, spec.widthMm]],
    bendLinesMm: [[[bendMid, 0], [bendMid, spec.widthMm]]]
  };
}

/** SVG of a flat pattern: outline plus dashed bend lines, in millimetres (1 user unit = 1 mm). */
export function flatPatternSvg(pattern: FlatPattern): string {
  const pad = 5;
  const w = pattern.flatLengthMm + pad * 2;
  const h = pattern.widthMm + pad * 2;
  const outline = pattern.outlineMm.map(([x, y], i) => `${i === 0 ? "M" : "L"}${(x + pad).toFixed(3)} ${(y + pad).toFixed(3)}`).join("") + "Z";
  const bends = pattern.bendLinesMm.map(([a, b]) => `<path class="bend-line" d="M${(a[0] + pad).toFixed(3)} ${(a[1] + pad).toFixed(3)}L${(b[0] + pad).toFixed(3)} ${(b[1] + pad).toFixed(3)}" fill="none" stroke="#b24646" stroke-width="0.3" stroke-dasharray="3 1.5"/>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w.toFixed(3)}mm" height="${h.toFixed(3)}mm" viewBox="0 0 ${w.toFixed(3)} ${h.toFixed(3)}"><path class="flat-outline" d="${outline}" fill="none" stroke="#173346" stroke-width="0.5"/>${bends}</svg>`;
}
