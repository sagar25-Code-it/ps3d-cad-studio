import type { Vec2 } from "../../workbench-core/src/index.js";

/**
 * Sweep direction of a centerpoint arc. The tool takes the centre, the start and an end click, but the same three clicks
 * fit an arc going either way round the circle: a click at 270 degrees is a 270 degree counter-clockwise arc or a 90 degree
 * clockwise one. The canvas tells the two apart by following the pointer as it travels round the centre after the start
 * click, the way Fusion and SolidWorks do, so the arc keeps growing past a half turn in the direction the pointer went.
 */
export type SweepDirection = 1 | -1;

const TWO_PI = Math.PI * 2;

export interface ArcSweepTrack {
  /** Angle of the last pointer position about the centre (radians, as atan2 reports it). */
  readonly angle: number;
  /** The signed sweep travelled since the start click, continuous across the half turn: positive is counter-clockwise. */
  readonly sweepRad: number;
}

/** Begins following the pointer at the start click. */
export function startArcSweepTrack(center: Vec2, start: Vec2): ArcSweepTrack {
  return { angle: Math.atan2(start[1] - center[1], start[0] - center[0]), sweepRad: 0 };
}

/**
 * Moves the track to a new pointer position. Each step takes the shorter way round from the previous position, so the
 * accumulated sweep passes 180 degrees smoothly instead of flipping to the other side. The sweep stops growing at a
 * full turn (that would be a circle). A pointer on top of the centre has no direction and leaves the track unchanged.
 */
export function advanceArcSweepTrack(track: ArcSweepTrack, center: Vec2, pointer: Vec2): ArcSweepTrack {
  const dx = pointer[0] - center[0];
  const dy = pointer[1] - center[1];
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-9) return track;
  const angle = Math.atan2(dy, dx);
  let step = angle - track.angle;
  while (step > Math.PI) step -= TWO_PI;
  while (step <= -Math.PI) step += TWO_PI;
  const limit = TWO_PI - 1e-6;
  return { angle, sweepRad: Math.max(-limit, Math.min(limit, track.sweepRad + step)) };
}

/** The direction a track has settled on, or undefined while the pointer has not moved round the centre yet. */
export function arcSweepDirection(track: ArcSweepTrack | undefined): SweepDirection | undefined {
  if (track === undefined || Math.abs(track.sweepRad) < 1e-9) return undefined;
  return track.sweepRad > 0 ? 1 : -1;
}

/**
 * The signed sweep from `startAngle` to `endAngle` going the given way round: between 0 and 2 pi counter-clockwise,
 * between 0 and -2 pi clockwise. Equal angles give 0 (the caller refuses a zero sweep).
 */
export function directedSweep(startAngle: number, endAngle: number, direction: SweepDirection): number {
  const raw = direction > 0 ? endAngle - startAngle : startAngle - endAngle;
  const wrapped = ((raw % TWO_PI) + TWO_PI) % TWO_PI;
  return direction > 0 ? wrapped : -wrapped;
}
