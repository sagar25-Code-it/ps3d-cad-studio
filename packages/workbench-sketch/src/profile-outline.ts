import { chordErrorBoundMm, fullCircleFacets, type Vec2 } from "../../workbench-core/src/index.js";
import type { SketchProfileBoundary } from "./index.js";

/**
 * Closed polygon (millimetres) that outlines a profile boundary, counter-clockwise for every kind. Curves are sampled by the one
 * chord-error rule (workbench-core/tessellation.ts: within 1/2,000 of the radius and at most 0.01 mm), so every round part
 * is within about 0.07 percent of its true volume. A full circle gets a multiple of four edges, so its quadrant points are vertices.
 */
export function profileOutlineMm(boundary: SketchProfileBoundary, options: { readonly maxFacets?: number } = {}): readonly Vec2[] {
  // A caller that multiplies the outline by another count (a revolve turns it through many positions) can cap the facets of a round outline.
  const capped = (steps: number): number => (options.maxFacets === undefined ? steps : Math.min(steps, Math.max(16, Math.floor(options.maxFacets / 4) * 4)));
  if (boundary.kind === "circle") {
    const steps = capped(fullCircleFacets(boundary.radiusMm));
    return Array.from({ length: steps }, (_, index): Vec2 => {
      const angle = (2 * Math.PI * index) / steps;
      return [boundary.center[0] + boundary.radiusMm * Math.cos(angle), boundary.center[1] + boundary.radiusMm * Math.sin(angle)];
    });
  }
  if (boundary.kind === "ellipse") {
    const radians = (boundary.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const major = Math.max(boundary.majorRadiusMm, boundary.minorRadiusMm);
    const minor = Math.min(boundary.majorRadiusMm, boundary.minorRadiusMm);
    // The bound follows the mean radius; the step count below is set by the sharpest bend, at the end of the major axis.
    const tolerance = chordErrorBoundMm(Math.sqrt(major * minor));
    const steps = capped(Math.min(4096, Math.max(72, Math.ceil(Math.ceil((Math.PI * 2) / Math.sqrt((8 * tolerance * minor * minor) / major ** 3)) / 4) * 4)));
    return Array.from({ length: steps }, (_, index): Vec2 => {
      const theta = (2 * Math.PI * index) / steps;
      const localX = boundary.majorRadiusMm * Math.cos(theta);
      const localY = boundary.minorRadiusMm * Math.sin(theta);
      return [boundary.center[0] + localX * cos - localY * sin, boundary.center[1] + localX * sin + localY * cos];
    });
  }
  if (boundary.kind === "rectangle") {
    const halfWidth = boundary.widthMm / 2;
    const halfHeight = boundary.heightMm / 2;
    const radians = (boundary.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const corners: readonly Vec2[] = [[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]];
    return corners.map(([x, y]): Vec2 => [boundary.center[0] + x * cos - y * sin, boundary.center[1] + x * sin + y * cos]);
  }
  return boundary.points;
}
