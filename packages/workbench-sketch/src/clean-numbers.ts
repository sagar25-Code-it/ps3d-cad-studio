import type { Vec2 } from "../../workbench-core/src/index.js";

/**
 * Floating-point dust: a quadrant of a circle at 180 degrees comes out as y = 2.449e-15, and the radius between two grid points
 * 0.1 apart as 0.39999999999999997. Such a number is a real value plus rounding noise; it reaches dimension fields and exports as
 * clutter. A value that lies within `DUST_MM` of a multiple of 1e-9 is replaced by that multiple; every other value is left exactly as
 * computed, so no real coordinate loses precision.
 */
const DUST_MM = 1e-11;
const QUANTUM = 1e-9;

export function tidy(value: number): number {
  if (!Number.isFinite(value)) return value;
  const rounded = Math.round(value / QUANTUM) * QUANTUM;
  if (Math.abs(value - rounded) >= DUST_MM * Math.max(1, Math.abs(value) / 1e3)) return value;
  // Express the multiple with the decimals it needs, so 0.3 stays 0.3 and not 0.30000000000000004.
  const cleaned = Number(rounded.toFixed(9));
  return cleaned === 0 ? 0 : cleaned;
}

export function tidyPoint(point: Vec2): Vec2 {
  return [tidy(point[0]), tidy(point[1])];
}
