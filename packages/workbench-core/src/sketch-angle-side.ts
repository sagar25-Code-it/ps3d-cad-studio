/**
 * An angle dimension is stored as a direction: degrees counter-clockwise from the first line to the second, 0 up to 360. The number a
 * person reads off a drawing is the angle between the lines, 0 up to 180, which is two directed values (30 and 330 are mirror images
 * about the first line). Typing the drawn value must not mirror the geometry, so a value up to 180 takes the side the lines are
 * already on; a value over 180 is the directed angle exactly as typed, and a negative value (-30) takes the other side.
 */
export const ANGLE_FLIP_MIN_DEG = -180;

export interface AngleChoice {
  /** The directed value to store, 0 up to 360. */
  readonly valueDeg: number;
  /** Whether it is the mirror of what was typed (so the status says which side was taken). */
  readonly mirrored: boolean;
}

const wrap = (value: number): number => ((value % 360) + 360) % 360;
const gap = (a: number, b: number): number => Math.min(wrap(a - b), wrap(b - a));

/** `typed` is what the person entered; `measuredDeg` the directed angle the lines make now (undefined when it cannot be measured). */
export function chooseAngleSide(typed: number, measuredDeg: number | undefined): AngleChoice {
  const flip = typed < 0;
  const drawn = flip ? -typed : typed;
  if (drawn > 180) return { valueDeg: wrap(typed), mirrored: false };
  const direct = wrap(drawn);
  const mirror = wrap(360 - drawn);
  if (direct === mirror || measuredDeg === undefined) return { valueDeg: flip ? mirror : direct, mirrored: flip };
  const nearer = gap(measuredDeg, direct) <= gap(measuredDeg, mirror) ? direct : mirror;
  const farther = nearer === direct ? mirror : direct;
  const valueDeg = flip ? farther : nearer;
  return { valueDeg, mirrored: valueDeg !== direct };
}
