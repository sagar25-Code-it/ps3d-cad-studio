import type { Vec2 } from "../../workbench-core/src/index.js";

/**
 * Exact point queries on an ellipse, for the cursor inference (snap to the outline, intersections, perpendicular and
 * tangent hints). The ellipse has its centre, a major and a minor semi-axis, and a rotation of the major axis.
 */
export interface EllipseShape {
  readonly center: Vec2;
  readonly majorRadiusMm: number;
  readonly minorRadiusMm: number;
  readonly rotationDeg: number;
}

const TWO_PI = Math.PI * 2;

interface Frame {
  readonly a: number;
  readonly b: number;
  readonly cos: number;
  readonly sin: number;
  readonly center: Vec2;
}

function frameOf(ellipse: EllipseShape): Frame {
  const radians = (ellipse.rotationDeg * Math.PI) / 180;
  return { a: ellipse.majorRadiusMm, b: ellipse.minorRadiusMm, cos: Math.cos(radians), sin: Math.sin(radians), center: ellipse.center };
}

function toLocal(frame: Frame, point: Vec2): Vec2 {
  const dx = point[0] - frame.center[0];
  const dy = point[1] - frame.center[1];
  return [dx * frame.cos + dy * frame.sin, -dx * frame.sin + dy * frame.cos];
}

function toWorld(frame: Frame, local: Vec2): Vec2 {
  return [frame.center[0] + local[0] * frame.cos - local[1] * frame.sin, frame.center[1] + local[0] * frame.sin + local[1] * frame.cos];
}

/** The point of the ellipse at parameter t (radians; t = 0 is the end of the major axis). */
export function ellipsePointAt(ellipse: EllipseShape, t: number): Vec2 {
  const frame = frameOf(ellipse);
  return toWorld(frame, [frame.a * Math.cos(t), frame.b * Math.sin(t)]);
}

/** The ellipse outline as a closed polyline of `segments` straight pieces (the last point is not repeated). */
export function ellipsePolyline(ellipse: EllipseShape, segments = 128): readonly Vec2[] {
  const frame = frameOf(ellipse);
  return Array.from({ length: segments }, (_, index): Vec2 => {
    const t = (TWO_PI * index) / segments;
    return toWorld(frame, [frame.a * Math.cos(t), frame.b * Math.sin(t)]);
  });
}

/** The ellipse's distance function derivative along the outline: zero where the normal there passes through the local point. */
function normalResidual(frame: Frame, local: Vec2, t: number): number {
  const sin = Math.sin(t);
  const cos = Math.cos(t);
  return (frame.a * cos - local[0]) * (-frame.a * sin) + (frame.b * sin - local[1]) * (frame.b * cos);
}

/** The point of the ellipse nearest to `point`, with its distance. */
export function nearestOnEllipse(point: Vec2, ellipse: EllipseShape): { readonly point: Vec2; readonly distance: number } {
  const frame = frameOf(ellipse);
  const local = toLocal(frame, point);
  let bestT = 0;
  let bestDistance = Infinity;
  const steps = 72;
  for (let index = 0; index < steps; index += 1) {
    const t = (TWO_PI * index) / steps;
    const d = Math.hypot(frame.a * Math.cos(t) - local[0], frame.b * Math.sin(t) - local[1]);
    if (d < bestDistance) { bestDistance = d; bestT = t; }
  }
  // Newton iterations on the normal condition, started at the best sample.
  let t = bestT;
  for (let iteration = 0; iteration < 30; iteration += 1) {
    const sin = Math.sin(t);
    const cos = Math.cos(t);
    const value = normalResidual(frame, local, t);
    const slope = frame.a * frame.a * sin * sin - (frame.a * cos - local[0]) * frame.a * cos + frame.b * frame.b * cos * cos - (frame.b * sin - local[1]) * frame.b * sin;
    if (Math.abs(slope) < 1e-14) break;
    const step = value / slope;
    // Stay near the sampled minimum: a wild step means the curvature is flat there.
    t -= Math.max(-0.5, Math.min(0.5, step));
    if (Math.abs(step) < 1e-13) break;
  }
  const refined: Vec2 = [frame.a * Math.cos(t), frame.b * Math.sin(t)];
  const refinedDistance = Math.hypot(refined[0] - local[0], refined[1] - local[1]);
  // Never return a worse point than the sample the search started from.
  if (refinedDistance <= bestDistance + 1e-12) return { point: toWorld(frame, refined), distance: refinedDistance };
  return { point: toWorld(frame, [frame.a * Math.cos(bestT), frame.b * Math.sin(bestT)]), distance: bestDistance };
}

/** Where the segment a-b crosses the ellipse (zero, one or two points). */
export function ellipseSegmentIntersections(a: Vec2, b: Vec2, ellipse: EllipseShape): readonly Vec2[] {
  const frame = frameOf(ellipse);
  const la = toLocal(frame, a);
  const lb = toLocal(frame, b);
  const dx = lb[0] - la[0];
  const dy = lb[1] - la[1];
  const ia = 1 / (frame.a * frame.a);
  const ib = 1 / (frame.b * frame.b);
  const qa = dx * dx * ia + dy * dy * ib;
  if (qa < 1e-18) return [];
  const qb = 2 * (la[0] * dx * ia + la[1] * dy * ib);
  const qc = la[0] * la[0] * ia + la[1] * la[1] * ib - 1;
  const discriminant = qb * qb - 4 * qa * qc;
  if (discriminant < 0) return [];
  const root = Math.sqrt(discriminant);
  const hits: Vec2[] = [];
  for (const s of root === 0 ? [-qb / (2 * qa)] : [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]) {
    if (s < -1e-9 || s > 1 + 1e-9) continue;
    hits.push(toWorld(frame, [la[0] + dx * s, la[1] + dy * s]));
  }
  return hits;
}

/** The points of the ellipse where the line from `anchor` meets the outline at a right angle (up to four). */
export function ellipsePerpendicularFeet(anchor: Vec2, ellipse: EllipseShape): readonly Vec2[] {
  const frame = frameOf(ellipse);
  const local = toLocal(frame, anchor);
  const steps = 256;
  const feet: Vec2[] = [];
  let previousT = 0;
  let previousValue = normalResidual(frame, local, 0);
  for (let index = 1; index <= steps; index += 1) {
    const t = (TWO_PI * index) / steps;
    const value = normalResidual(frame, local, t);
    if (previousValue === 0 || previousValue * value < 0) {
      let low = previousT;
      let high = t;
      let lowValue = previousValue;
      for (let iteration = 0; iteration < 50; iteration += 1) {
        const middle = (low + high) / 2;
        const middleValue = normalResidual(frame, local, middle);
        if (lowValue * middleValue <= 0) high = middle; else { low = middle; lowValue = middleValue; }
      }
      const root = (low + high) / 2;
      const foot = toWorld(frame, [frame.a * Math.cos(root), frame.b * Math.sin(root)]);
      if (!feet.some((existing) => Math.hypot(existing[0] - foot[0], existing[1] - foot[1]) < 1e-7)) feet.push(foot);
    }
    previousT = t;
    previousValue = value;
  }
  return feet;
}

/** The points of the ellipse where a tangent line from `anchor` touches it (two, or none when the anchor is not outside). */
export function ellipseTangentPointsFrom(anchor: Vec2, ellipse: EllipseShape): readonly Vec2[] {
  const frame = frameOf(ellipse);
  const local = toLocal(frame, anchor);
  // In the frame scaled by 1/a and 1/b the ellipse is the unit circle, and tangent lines stay tangent.
  const qx = local[0] / frame.a;
  const qy = local[1] / frame.b;
  const distance = Math.hypot(qx, qy);
  if (distance <= 1 + 1e-9) return [];
  const angle = Math.atan2(qy, qx);
  const spread = Math.acos(1 / distance);
  return [angle + spread, angle - spread].map((phi) => toWorld(frame, [frame.a * Math.cos(phi), frame.b * Math.sin(phi)]));
}
