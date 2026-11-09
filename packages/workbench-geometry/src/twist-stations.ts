/**
 * How many stations a twisted sweep is built from.
 *
 * A twisted sweep turns its profile a little between stations and joins the corners with straight edges. With only the two end rings the
 * sides fold through the axis (a 90 degree twist of a 20 x 40 bar came out at a quarter of its volume), and between close stations the
 * straight edges stand in for the helix the corners really follow. A step of `TWIST_STEP_DEG` degrees keeps the straight edges within about
 * 0.02 percent of the true volume (the area of the section at the middle of a step is short by (step in radians) squared over 6 on average).
 * A very long twist of a finely faceted profile is thinned so the mesh stays within a triangle budget, never coarser than 30 degrees a step.
 */
export const TWIST_STEP_DEG = 2;
/** Triangles a twisted sweep may use before its steps are made wider. */
export const TWIST_TRIANGLE_BUDGET = 120_000;
const WIDEST_STEP_DEG = 30;

/** The number of segments (one more station than this) to build a sweep of this twist from; 1 for no twist. */
export function twistSegments(twistDeg: number | undefined, ringPoints: number): number {
  const turn = Math.abs(twistDeg !== undefined && Number.isFinite(twistDeg) ? twistDeg : 0);
  if (turn < 1e-9) return 1;
  const wanted = Math.ceil(turn / TWIST_STEP_DEG - 1e-9);
  const affordable = Math.floor(TWIST_TRIANGLE_BUDGET / (2 * Math.max(3, ringPoints)));
  const count = Math.max(1, Math.min(wanted, Math.max(affordable, Math.ceil(turn / WIDEST_STEP_DEG - 1e-9))));
  // An even count: the walls alternate their diagonal band by band, which only cancels the volume error when the bands pair up.
  return count > 1 && count % 2 === 1 ? count + 1 : count;
}

/** The step in degrees between stations that `twistSegments` gives. */
export function twistStepDeg(twistDeg: number | undefined, ringPoints: number): number {
  const turn = Math.abs(twistDeg !== undefined && Number.isFinite(twistDeg) ? twistDeg : 0);
  return turn / twistSegments(twistDeg, ringPoints);
}

/**
 * Adds stations to a polyline so a twist spread over its length turns at most one step between neighbours. Each piece gets as many equal
 * parts as its share of the twist needs; a closed path also divides the piece from its last point back to its first. With no twist the
 * points come back unchanged.
 */
export function densifyForTwist<T extends readonly [number, number, number]>(points: readonly T[], closed: boolean, twistDeg: number | undefined, ringPoints: number): T[] {
  const total = twistSegments(twistDeg, ringPoints);
  if (total <= 1) return [...points];
  const pieces = points.length - 1 + (closed ? 1 : 0);
  let lengthSum = 0;
  const lengths: number[] = [];
  for (let index = 0; index < pieces; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    const size = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    lengths.push(size);
    lengthSum += size;
  }
  if (!(lengthSum > 0)) return [...points];
  const result: T[] = [];
  for (let index = 0; index < pieces; index += 1) {
    const a = points[index]!;
    const b = points[(index + 1) % points.length]!;
    const parts = Math.max(1, Math.ceil((total * lengths[index]!) / lengthSum - 1e-9));
    for (let part = 0; part < parts; part += 1) {
      const t = part / parts;
      result.push(part === 0 ? a : ([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t] as unknown as T));
    }
  }
  if (!closed) result.push(points[points.length - 1]!);
  return result;
}
