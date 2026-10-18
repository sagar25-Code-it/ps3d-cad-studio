import type { GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { tessellateExtrude, tessellateRevolve, type TessellatePlane } from "../../../packages/workbench-geometry/src/index.js";
import type { SketchProfile } from "../../../packages/workbench-sketch/src/index.js";

/** Sketch-plane identifier shared with the solid builder UI. */
export type SketchPlane = TessellatePlane;

type PolygonPoint = readonly [number, number];

/** Convert a detected sketch profile boundary into a closed polygon (millimetres). */
function profilePolygonMm(boundary: SketchProfile["boundary"]): readonly PolygonPoint[] {
  if (boundary.kind === "circle") {
    const segments = 72;
    const points: PolygonPoint[] = [];
    for (let index = 0; index < segments; index += 1) {
      const angle = (2 * Math.PI * index) / segments;
      points.push([boundary.center[0] + boundary.radiusMm * Math.cos(angle), boundary.center[1] + boundary.radiusMm * Math.sin(angle)]);
    }
    return points;
  }
  if (boundary.kind === "rectangle") {
    const halfWidth = boundary.widthMm / 2;
    const halfHeight = boundary.heightMm / 2;
    const radians = (boundary.rotationDeg * Math.PI) / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const corners: PolygonPoint[] = [[-halfWidth, -halfHeight], [halfWidth, -halfHeight], [halfWidth, halfHeight], [-halfWidth, halfHeight]];
    return corners.map(([x, y]) => [boundary.center[0] + x * cos - y * sin, boundary.center[1] + x * sin + y * cos]);
  }
  return boundary.points.map((point) => [point[0], point[1]] as PolygonPoint);
}

export interface CreateGeneralSolidRequest {
  readonly profile: SketchProfile;
  readonly plane: SketchPlane;
  readonly operation: "extrude" | "revolve";
  /** Extrusion height in millimetres, or revolve angle in degrees. */
  readonly valueMm: number;
  readonly bodyId: string;
  readonly name: string;
  readonly color: string;
}

export type CreateGeneralSolidResult =
  | { readonly ok: true; readonly body: GeneralSolidBody }
  | { readonly ok: false; readonly message: string };

/**
 * Build a general mesh-solid body from a sketch profile using the browser-safe
 * analytic tessellator. The Manifold kernel stays Node-only (forbidden in the
 * production browser graph), so the viewport tessellates extrude/revolve
 * directly; the kernel cross-checks these meshes by volume in the test suite.
 */
export function createGeneralSolidBody(request: CreateGeneralSolidRequest): CreateGeneralSolidResult {
  const polygonMm = profilePolygonMm(request.profile.boundary);
  if (polygonMm.length < 3) return { ok: false, message: "The selected profile does not form a closed polygon." };
  if (!Number.isFinite(request.valueMm) || request.valueMm === 0) {
    return { ok: false, message: request.operation === "extrude" ? "Enter a non-zero extrusion height." : "Enter a non-zero revolve angle." };
  }
  const mesh = request.operation === "extrude"
    ? tessellateExtrude(polygonMm, request.valueMm, request.plane)
    : tessellateRevolve(polygonMm, request.valueMm, request.plane);
  if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) {
    return { ok: false, message: "The profile could not be converted into a solid." };
  }
  return {
    ok: true,
    body: {
      id: request.bodyId,
      name: request.name,
      visible: true,
      color: request.color,
      positionsMm: Array.from(mesh.positionsMm),
      indices: Array.from(mesh.indices),
      feature: { operation: request.operation, plane: request.plane, valueMm: request.valueMm }
    }
  };
}
