import type { Vec2 } from "../../workbench-core/src/index.js";
import { arcStepCount, CHORD_TOLERANCE_MM } from "./curve-sampling.js";
import type { SketchProfileBoundary } from "./index.js";

/**
 * Closed polygon (millimetres) that outlines a profile boundary, counter-clockwise for every kind. Curves are sampled by a
 * chord-error bound (see CHORD_TOLERANCE_MM), so a large circle gets more points than a small one.
 */
export function profileOutlineMm(boundary: SketchProfileBoundary): readonly Vec2[] {
  if (boundary.kind === "circle") {
    const steps = arcStepCount(boundary.radiusMm, Math.PI * 2);
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
    const steps = Math.min(1440, Math.max(72, Math.ceil((Math.PI * 2) / Math.sqrt((8 * CHORD_TOLERANCE_MM * minor * minor) / major ** 3))));
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
