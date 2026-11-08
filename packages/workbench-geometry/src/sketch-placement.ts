import { tiltPoint, type PlaneTilt } from "./plane-tilt.js";

type Vec3 = readonly [number, number, number];

/** A sketch plane's own frame: the sketch origin, its X axis and its normal (unit and perpendicular). Y is `normal × uAxis`. */
export interface PlaneFrame {
  readonly originMm: Vec3;
  readonly uAxis: Vec3;
  readonly normal: Vec3;
}

/** The part of a sketch that says where its datum plane has been moved to. A sketch has at most one of the two. */
export interface SketchPlacement {
  readonly planeTilt?: PlaneTilt | undefined;
  readonly planeFrame?: PlaneFrame | undefined;
}

/**
 * The sketch frame of the plane through three points: the sketch origin is the first point, its X runs to the second point and
 * it rises along (second − first) × (third − first). Points that coincide or are nearly in a line have no usable plane.
 */
export function frameThroughPoints(points: readonly [Vec3, Vec3, Vec3]): PlaneFrame | { readonly error: string } {
  const [p0, p1, p2] = points;
  const u: Vec3 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
  const v: Vec3 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
  const lengthU = Math.hypot(u[0], u[1], u[2]);
  const lengthV = Math.hypot(v[0], v[1], v[2]);
  if (lengthU < 1e-6 || lengthV < 1e-6) return { error: "Two of the three points are the same, so they do not define a plane." };
  const cross: Vec3 = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const lengthN = Math.hypot(cross[0], cross[1], cross[2]);
  if (lengthN / (lengthU * lengthV) < 1e-6) return { error: "The three points lie on one line, so they do not define a plane." };
  return {
    originMm: p0,
    uAxis: [u[0] / lengthU, u[1] / lengthU, u[2] / lengthU],
    normal: [cross[0] / lengthN, cross[1] / lengthN, cross[2] / lengthN]
  };
}

/** True when the sketch is not simply on its datum plane (and offset), so solids built on the datum need moving. */
export function isPlaced(placement: SketchPlacement): boolean {
  return placement.planeTilt !== undefined || placement.planeFrame !== undefined;
}

function frameColumns(frame: PlaneFrame): readonly [Vec3, Vec3, Vec3] {
  const [u, n] = [frame.uAxis, frame.normal];
  const v: Vec3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  return [u, v, n];
}

const clean = (value: number): number => (Math.abs(value) < 1e-12 ? 0 : value);

/** Turns a direction from the datum plane's frame into the placed frame, or back with `inverse`. A direction is not moved by the origin. */
export function placeDirection(direction: Vec3, placement: SketchPlacement, inverse = false): Vec3 {
  if (placement.planeTilt !== undefined) return tiltPoint(direction, placement.planeTilt, inverse);
  if (placement.planeFrame === undefined) return direction;
  const [u, v, n] = frameColumns(placement.planeFrame);
  if (!inverse) {
    return [
      clean(u[0] * direction[0] + v[0] * direction[1] + n[0] * direction[2]),
      clean(u[1] * direction[0] + v[1] * direction[1] + n[1] * direction[2]),
      clean(u[2] * direction[0] + v[2] * direction[1] + n[2] * direction[2])
    ];
  }
  return [
    clean(u[0] * direction[0] + u[1] * direction[1] + u[2] * direction[2]),
    clean(v[0] * direction[0] + v[1] * direction[1] + v[2] * direction[2]),
    clean(n[0] * direction[0] + n[1] * direction[1] + n[2] * direction[2])
  ];
}

/** Moves a point from the datum plane's frame onto the placed plane, or back with `inverse`. */
export function placePoint(point: Vec3, placement: SketchPlacement, inverse = false): Vec3 {
  if (placement.planeFrame === undefined) return placeDirection(point, placement, inverse);
  const origin = placement.planeFrame.originMm;
  if (!inverse) {
    const turned = placeDirection(point, placement);
    return [clean(turned[0] + origin[0]), clean(turned[1] + origin[1]), clean(turned[2] + origin[2])];
  }
  return placeDirection([point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]], placement, true);
}

/** Moves a flat xyz position list onto the placed plane (or back, with `inverse`). */
export function placePositions(positionsMm: readonly number[], placement: SketchPlacement, inverse = false): number[] {
  const out: number[] = new Array(positionsMm.length);
  for (let i = 0; i + 2 < positionsMm.length; i += 3) {
    const moved = placePoint([positionsMm[i]!, positionsMm[i + 1]!, positionsMm[i + 2]!], placement, inverse);
    out[i] = moved[0];
    out[i + 1] = moved[1];
    out[i + 2] = moved[2];
  }
  return out;
}
