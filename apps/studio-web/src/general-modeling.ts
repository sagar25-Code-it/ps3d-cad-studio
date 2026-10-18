import type { GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { tessellateRevolve, type TessellatePlane } from "../../../packages/workbench-geometry/src/index.js";
import { evaluateProfilePrism, evaluateProfileRevolution } from "../../../packages/occt-kernel-adapter/src/reference-runtime.js";
import type { SketchProfile } from "../../../packages/workbench-sketch/src/index.js";

/** Sketch-plane identifier shared with the solid builder UI. */
export type SketchPlane = TessellatePlane;

type PolygonPoint = readonly [number, number];
type WorldPoint = readonly [number, number, number];

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

/** Place a 2D sketch point (millimetres) onto its datum plane in world metres, matching the analytic tessellator's orientation. */
function placeOnPlane(point: PolygonPoint, plane: SketchPlane): WorldPoint {
  const u = point[0] / 1000;
  const v = point[1] / 1000;
  if (plane === "xz") return [u, 0, v];
  if (plane === "yz") return [0, v, -u];
  return [u, v, 0];
}

/** The outward extrusion normal for each datum plane (matches placeOnPlane). */
function planeNormal(plane: SketchPlane): WorldPoint {
  if (plane === "xz") return [0, -1, 0];
  if (plane === "yz") return [1, 0, 0];
  return [0, 0, 1];
}

/** Rotate a kernel local-space revolve point (revolved about Y) onto its datum plane, matching the analytic tessellator. */
function rotateLocalToPlane(point: WorldPoint, plane: SketchPlane): WorldPoint {
  if (plane === "xz") return [point[0], -point[2], point[1]];
  if (plane === "yz") return [point[2], point[1], -point[0]];
  return point;
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
 * Build a general mesh-solid body from a sketch profile.
 *
 * Extrude runs through the reference B-rep kernel (browser-safe): the body
 * carries the kernel's watertight tessellation plus its exact topology summary
 * and stable, lineage-anchored face names. Revolve still uses the analytic
 * tessellator because the reference kernel does not yet evaluate revolves.
 */
export async function createGeneralSolidBody(request: CreateGeneralSolidRequest): Promise<CreateGeneralSolidResult> {
  const polygonMm = profilePolygonMm(request.profile.boundary);
  if (polygonMm.length < 3) return { ok: false, message: "The selected profile does not form a closed polygon." };
  if (!Number.isFinite(request.valueMm) || request.valueMm === 0) {
    return { ok: false, message: request.operation === "extrude" ? "Enter a non-zero extrusion height." : "Enter a non-zero revolve angle." };
  }

  const base = {
    id: request.bodyId,
    name: request.name,
    visible: true as const,
    color: request.color,
    feature: { operation: request.operation, plane: request.plane, valueMm: request.valueMm }
  };

  if (request.operation === "extrude") {
    try {
      const prism = await evaluateProfilePrism({
        operationId: request.bodyId,
        semanticId: request.bodyId,
        profilePointsMeters: polygonMm.map((point) => placeOnPlane(point, request.plane)),
        normal: planeNormal(request.plane),
        heightMeters: Math.abs(request.valueMm) / 1000
      });
      if (prism.indices.length < 3) return { ok: false, message: "The profile could not be converted into a solid." };
      return {
        ok: true,
        body: {
          ...base,
          positionsMm: prism.positionsMeters.map((value) => value * 1000),
          indices: prism.indices,
          brep: {
            topology: { vertices: prism.topology.vertices, edges: prism.topology.edges, faces: prism.topology.faces },
            faces: prism.faces.map((face) => ({ role: face.role, key: face.key, areaMm2: face.areaSquareMeters * 1e6 })),
            faceTriangles: prism.faceTriangles
          }
        }
      };
    } catch {
      return { ok: false, message: "The solid kernel could not extrude this profile." };
    }
  }

  // Revolve through the B-rep kernel when the profile stays on one side of the axis;
  // otherwise fall back to the analytic tessellator (which tolerates axis-crossing profiles).
  const profilePoints = polygonMm.map((point) => [point[0] / 1000, point[1] / 1000] as const);
  if (profilePoints.every((point) => point[0] > 1e-9)) {
    try {
      const revolution = await evaluateProfileRevolution({
        operationId: request.bodyId,
        semanticId: request.bodyId,
        profilePoints,
        degrees: request.valueMm
      });
      if (revolution.indices.length >= 3) {
        const positionsMm: number[] = [];
        for (let index = 0; index + 2 < revolution.positionsMeters.length; index += 3) {
          const world = rotateLocalToPlane([revolution.positionsMeters[index]!, revolution.positionsMeters[index + 1]!, revolution.positionsMeters[index + 2]!], request.plane);
          positionsMm.push(world[0] * 1000, world[1] * 1000, world[2] * 1000);
        }
        return {
          ok: true,
          body: {
            ...base,
            positionsMm,
            indices: revolution.indices,
            brep: {
              topology: { vertices: revolution.topology.vertices, edges: revolution.topology.edges, faces: revolution.topology.faces },
              faces: revolution.faces.map((face) => ({ role: face.role, key: face.key, areaMm2: face.areaSquareMeters * 1e6 })),
              faceTriangles: revolution.faceTriangles
            }
          }
        };
      }
    } catch {
      // fall through to the analytic tessellator
    }
  }

  const mesh = tessellateRevolve(polygonMm, request.valueMm, request.plane);
  if (mesh.positionsMm.length < 9 || mesh.indices.length < 3) {
    return { ok: false, message: "The profile could not be converted into a solid." };
  }
  return { ok: true, body: { ...base, positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) } };
}
