/**
 * Colour ramps and legends for the surface analyses. Colours are linear-free sRGB triples in 0..1 so a viewport can
 * put them straight into a vertex colour attribute; each ramp has a matching legend the UI can draw unchanged.
 */

export type Rgb = readonly [number, number, number];

export interface LegendEntry {
  readonly label: string;
  readonly color: string;
}

export interface AnalysisLegend {
  readonly title: string;
  readonly unit: string;
  /** From the top of the scale to the bottom. */
  readonly entries: readonly LegendEntry[];
  readonly note?: string;
}

const UNMEASURED: Rgb = [0.55, 0.57, 0.6];

function hex(color: Rgb): string {
  return `#${color.map((channel) => Math.round(Math.max(0, Math.min(1, channel)) * 255).toString(16).padStart(2, "0")).join("")}`;
}

export function rgbToHex(color: Rgb): string {
  return hex(color);
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
  const u = Math.max(0, Math.min(1, t));
  return [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, a[2] + (b[2] - a[2]) * u];
}

const RED: Rgb = [0.84, 0.15, 0.24];
const DARK_RED: Rgb = [0.5, 0.06, 0.12];
const YELLOW: Rgb = [0.96, 0.78, 0.18];
const GREEN: Rgb = [0.18, 0.62, 0.36];
const TEAL: Rgb = [0.12, 0.5, 0.58];
const BLUE: Rgb = [0.17, 0.42, 0.69];
const NEUTRAL: Rgb = [0.91, 0.93, 0.94];

// -- draft ------------------------------------------------------------------------------------

/** Red for undercut (negative draft), yellow where more draft is needed, green for enough positive draft. */
export function draftColor(angleDeg: number, requiredDeg: number): Rgb {
  if (!Number.isFinite(angleDeg)) return UNMEASURED;
  const required = Math.max(0, requiredDeg);
  if (angleDeg <= -required) return mix(RED, DARK_RED, (-angleDeg - required) / Math.max(1, 90 - required));
  if (angleDeg >= required) return mix(GREEN, TEAL, (angleDeg - required) / Math.max(1, 90 - required));
  return YELLOW;
}

export function draftLegend(requiredDeg: number): AnalysisLegend {
  return {
    title: "Draft angle",
    unit: "deg",
    entries: [
      { label: "+90 (faces the pull)", color: hex(TEAL) },
      { label: `+${requiredDeg} or more: enough draft`, color: hex(GREEN) },
      { label: `-${requiredDeg} to +${requiredDeg}: needs draft`, color: hex(YELLOW) },
      { label: `-${requiredDeg} or less: undercut`, color: hex(RED) },
      { label: "-90 (faces away)", color: hex(DARK_RED) }
    ]
  };
}

// -- wall thickness ---------------------------------------------------------------------------

/** Red below the thin threshold, then yellow through green to blue at the thickest wall. */
export function thicknessColor(thicknessMm: number, thinMm: number, maxMm: number): Rgb {
  if (!Number.isFinite(thicknessMm)) return UNMEASURED;
  if (thicknessMm < thinMm) return RED;
  const top = Math.max(maxMm, thinMm * 3);
  const u = (thicknessMm - thinMm) / (top - thinMm);
  return u < 0.5 ? mix(YELLOW, GREEN, u * 2) : mix(GREEN, BLUE, (u - 0.5) * 2);
}

export function thicknessLegend(thinMm: number, maxMm: number): AnalysisLegend {
  const top = Math.max(maxMm, thinMm * 3);
  return {
    title: "Wall thickness",
    unit: "mm",
    entries: [
      { label: `${top.toFixed(2)} and thicker`, color: hex(BLUE) },
      { label: `${((thinMm + top) / 2).toFixed(2)}`, color: hex(GREEN) },
      { label: `${thinMm.toFixed(2)}`, color: hex(YELLOW) },
      { label: `under ${thinMm.toFixed(2)}: too thin`, color: hex(RED) },
      { label: "not measured", color: hex(UNMEASURED) }
    ]
  };
}

// -- curvature --------------------------------------------------------------------------------

/** Blue for negative, near-white at zero and red for positive values; `range` is the magnitude shown at full colour. */
export function divergingColor(value: number, range: number): Rgb {
  if (!Number.isFinite(value) || !(range > 0)) return UNMEASURED;
  const u = Math.max(-1, Math.min(1, value / range));
  return u >= 0 ? mix(NEUTRAL, RED, u) : mix(NEUTRAL, BLUE, -u);
}

export function curvatureLegend(kind: "gaussian" | "mean", range: number): AnalysisLegend {
  const unit = kind === "gaussian" ? "1/mm2" : "1/mm";
  const format = (value: number): string => (Math.abs(value) >= 0.01 || value === 0 ? value.toFixed(3) : value.toExponential(1));
  return {
    title: kind === "gaussian" ? "Gaussian curvature" : "Mean curvature",
    unit,
    entries: [
      { label: `+${format(range)} (convex / dome)`, color: hex(RED) },
      { label: "0 (flat or saddle-balanced)", color: hex(NEUTRAL) },
      { label: `${format(-range)} (concave / saddle)`, color: hex(BLUE) },
      { label: "not measured (boundary)", color: hex(UNMEASURED) }
    ],
    note: kind === "gaussian" ? "Positive: dome or bowl. Negative: saddle. Zero: flat or a cylinder / cone." : "Positive where the surface bulges outward."
  };
}
