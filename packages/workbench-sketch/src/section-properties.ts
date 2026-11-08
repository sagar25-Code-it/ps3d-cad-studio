import type { SketchProfile, SketchProfileBoundary } from "./index.js";
import { profileOutlineMm } from "./index.js";

type Point = readonly [number, number];

/**
 * Section properties of a sketch region: area, perimeter, centroid and the second moments of area, as a section-properties tool in a CAD
 * sketch gives them. The region is an outer outline with holes cut out of it; lengths are millimetres and moments millimetres to the fourth.
 */
export interface SectionProperties {
  readonly areaMm2: number;
  readonly perimeterMm: number;
  readonly centroidMm: Point;
  /** Second moments about the centroid, with the axes parallel to the sketch X and Y: Ixx = integral of y squared, Iyy = integral of x squared. */
  readonly ixxMm4: number;
  readonly iyyMm4: number;
  /** The product of inertia about the centroid (the integral of x times y). */
  readonly ixyMm4: number;
  /** Polar moment about the centroid (Ixx + Iyy). */
  readonly polarMm4: number;
  /** The principal moments (the larger first) and the angle of the first principal axis from the sketch X axis, counter-clockwise, in degrees (-90 to 90). */
  readonly principalMm4: readonly [number, number];
  readonly principalAngleDeg: number;
  /** Radii of gyration about the centroid, sqrt(I / A). */
  readonly gyrationMm: { readonly x: number; readonly y: number };
  readonly boundsMm: { readonly min: Point; readonly max: Point };
}

function area2(points: readonly Point[]): number {
  let twice = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index]!;
    const [x2, y2] = points[(index + 1) % points.length]!;
    twice += x1 * y2 - x2 * y1;
  }
  return twice;
}

/** A circle or ellipse as a fine polygon, so the moments are exact to a few parts per million. Everything else keeps its own outline. */
function denseOutline(boundary: SketchProfileBoundary): readonly Point[] {
  if (boundary.kind === "circle") {
    return Array.from({ length: 1440 }, (_, index): Point => {
      const angle = (2 * Math.PI * index) / 1440;
      return [boundary.center[0] + boundary.radiusMm * Math.cos(angle), boundary.center[1] + boundary.radiusMm * Math.sin(angle)];
    });
  }
  if (boundary.kind === "ellipse") {
    const radians = (boundary.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    return Array.from({ length: 1440 }, (_, index): Point => {
      const theta = (2 * Math.PI * index) / 1440;
      const x = boundary.majorRadiusMm * Math.cos(theta);
      const y = boundary.minorRadiusMm * Math.sin(theta);
      return [boundary.center[0] + x * cos - y * sin, boundary.center[1] + x * sin + y * cos];
    });
  }
  return profileOutlineMm(boundary);
}

/** Section properties of an outline with holes, or undefined when the region has no area. */
export function sectionPropertiesOfLoops(outer: readonly Point[], holes: readonly (readonly Point[])[] = []): SectionProperties | undefined {
  const loops: Point[][] = [
    area2(outer) < 0 ? [...outer].reverse() : [...outer],
    ...holes.map((hole) => (area2(hole) > 0 ? [...hole].reverse() : [...hole]))
  ];
  let area = 0; let sx = 0; let sy = 0; let ixx = 0; let iyy = 0; let ixy = 0; let perimeter = 0;
  const min: [number, number] = [Infinity, Infinity];
  const max: [number, number] = [-Infinity, -Infinity];
  for (const [loopIndex, loop] of loops.entries()) {
    for (let index = 0; index < loop.length; index += 1) {
      const [x1, y1] = loop[index]!;
      const [x2, y2] = loop[(index + 1) % loop.length]!;
      const cross = x1 * y2 - x2 * y1;
      area += cross / 2;
      sx += (x1 + x2) * cross / 6;
      sy += (y1 + y2) * cross / 6;
      iyy += (x1 * x1 + x1 * x2 + x2 * x2) * cross / 12;
      ixx += (y1 * y1 + y1 * y2 + y2 * y2) * cross / 12;
      ixy += (x1 * y2 + 2 * x1 * y1 + 2 * x2 * y2 + x2 * y1) * cross / 24;
      perimeter += Math.hypot(x2 - x1, y2 - y1);
      if (loopIndex === 0) { min[0] = Math.min(min[0], x1); min[1] = Math.min(min[1], y1); max[0] = Math.max(max[0], x1); max[1] = Math.max(max[1], y1); }
    }
  }
  if (!(area > 1e-12)) return undefined;
  const cx = sx / area;
  const cy = sy / area;
  const ixxc = ixx - area * cy * cy;
  const iyyc = iyy - area * cx * cx;
  const ixyc = ixy - area * cx * cy;
  const mean = (ixxc + iyyc) / 2;
  const radius = Math.hypot((ixxc - iyyc) / 2, ixyc);
  // Principal axes: the angle that makes the product of inertia vanish.
  let angle = 0.5 * Math.atan2(-2 * ixyc, ixxc - iyyc);
  const larger = mean + radius;
  // Report the angle of the axis that carries the larger moment.
  const along = (ixxc + iyyc) / 2 + ((ixxc - iyyc) / 2) * Math.cos(2 * angle) - ixyc * Math.sin(2 * angle);
  if (Math.abs(along - larger) > Math.abs(along - (mean - radius))) angle += Math.PI / 2;
  if (angle > Math.PI / 2) angle -= Math.PI;
  if (angle <= -Math.PI / 2) angle += Math.PI;
  return {
    areaMm2: area, perimeterMm: perimeter, centroidMm: [cx, cy],
    ixxMm4: ixxc, iyyMm4: iyyc, ixyMm4: ixyc, polarMm4: ixxc + iyyc,
    principalMm4: [larger, mean - radius], principalAngleDeg: Math.abs(radius) < 1e-9 * Math.max(1, Math.abs(mean)) ? 0 : (angle * 180) / Math.PI,
    gyrationMm: { x: Math.sqrt(Math.max(0, ixxc) / area), y: Math.sqrt(Math.max(0, iyyc) / area) },
    boundsMm: { min, max }
  };
}

/** Section properties of a detected region: the outer profile with the profiles that are holes in it. */
export function sectionPropertiesOfRegion(outer: SketchProfile, holes: readonly SketchProfile[] = []): SectionProperties | undefined {
  return sectionPropertiesOfLoops(denseOutline(outer.boundary), holes.map((hole) => denseOutline(hole.boundary)));
}
