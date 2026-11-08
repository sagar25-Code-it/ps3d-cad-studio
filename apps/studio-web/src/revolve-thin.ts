import type { GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { offsetPolygon, rotateAboutAxis } from "../../../packages/workbench-geometry/src/index.js";
import type { SketchProfile } from "../../../packages/workbench-sketch/src/index.js";
import { stableFaceKey } from "../../../packages/occt-kernel-adapter/src/reference-runtime.js";
import { combineGeneralBodies, createGeneralSolidBody, type CreateGeneralSolidResult, type SketchPlane } from "./general-modeling.js";

type Point2 = readonly [number, number];

/** The world axis a revolve turns about in the datum frame (the sketch Y axis, carried onto its plane). Native sweep is right-handed about its opposite. */
export const REVOLVE_AXIS: Readonly<Record<SketchPlane, readonly [number, number, number]>> = { xy: [0, 1, 0], xz: [0, 0, 1], yz: [0, 1, 0] };

/**
 * Moves a revolved body so that it starts `startDeg` degrees along its sweep instead of at 0 (negative starts before the sketch plane).
 * The builders always sweep from 0 to the angle; this is how symmetric, flipped and two-sided revolves are placed.
 */
export function startRevolveAt(positionsMm: readonly number[], plane: SketchPlane, startDeg: number): number[] {
  if (startDeg === 0) return [...positionsMm];
  // The sweep is right-handed about the opposite of the axis, so starting earlier by s turns the body right-handed by +s.
  return rotateAboutAxis(positionsMm, [0, 0, 0], REVOLVE_AXIS[plane], (-startDeg * Math.PI) / 180);
}

function profileOf(id: string, points: readonly Point2[]): SketchProfile {
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) { cx += x / points.length; cy += y / points.length; }
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index]!;
    const [x2, y2] = points[(index + 1) % points.length]!;
    area += x1 * y2 - x2 * y1;
  }
  return { id, entityIds: [], boundary: { kind: "line-loop", points }, areaMm2: Math.abs(area) / 2, centroid: [cx, cy] };
}

export interface ThinRevolveRequest {
  /** The closed outline the wall follows, in sketch millimetres. */
  readonly outlineMm: readonly Point2[];
  readonly plane: SketchPlane;
  /** The angle swept, 1 to 360 degrees, starting at the sketch plane. */
  readonly angleDeg: number;
  readonly wallMm: number;
  readonly side: "inside" | "outside" | "center";
  readonly bodyId: string;
  readonly name: string;
  readonly color: string;
}

/**
 * A full turn of wall is a hollow shell: an outer surface and, inside it, an inner surface facing the other way. The Boolean cannot cut a
 * cavity that is completely enclosed, so the two revolved surfaces are put in one body directly, the inner one turned inside out.
 */
async function hollowShell(outer: GeneralSolidBody, inner: GeneralSolidBody, bodyId: string, name: string): Promise<GeneralSolidBody> {
  const outerVertices = outer.positionsMm.length / 3;
  const turned: number[] = [];
  for (let index = 0; index + 2 < inner.indices.length; index += 3) turned.push(inner.indices[index]! + outerVertices, inner.indices[index + 2]! + outerVertices, inner.indices[index + 1]! + outerVertices);
  const positionsMm = [...outer.positionsMm, ...inner.positionsMm];
  const indices = [...outer.indices, ...turned];
  const edges = new Set<string>();
  for (let corner = 0; corner < indices.length; corner += 3) {
    for (const [from, to] of [[indices[corner]!, indices[corner + 1]!], [indices[corner + 1]!, indices[corner + 2]!], [indices[corner + 2]!, indices[corner]!]] as const) edges.add(from < to ? `${from},${to}` : `${to},${from}`);
  }
  const base = { id: bodyId, name, visible: true, color: outer.color, positionsMm, indices } as const;
  if (outer.brep === undefined || inner.brep === undefined) return base;
  const roles = [...outer.brep.faces.map((face) => ({ role: `wall-outer.${face.role}`, area: face.areaMm2 })), ...inner.brep.faces.map((face) => ({ role: `wall-inner.${face.role}`, area: face.areaMm2 }))];
  const faces = await Promise.all(roles.map(async ({ role, area }) => ({ role, key: await stableFaceKey(bodyId, role), areaMm2: area })));
  const faceTriangles = [...outer.brep.faceTriangles, ...inner.brep.faceTriangles.map((face) => face + outer.brep!.faces.length)];
  return { ...base, brep: { topology: { vertices: positionsMm.length / 3, edges: edges.size, faces: faces.length }, faces, faceTriangles, origin: "mesh-boolean" } };
}

/**
 * A revolve with a wall: the outline offset by the wall is revolved twice, an outer and an inner solid, and the inner one is cut out of the
 * outer. The inner solid is revolved a little past both ends of a partial sweep, so the cut opens the ends and leaves the wall's own cross
 * section there. A full turn leaves a closed hollow shell.
 */
export async function createThinRevolveBody(request: ThinRevolveRequest): Promise<CreateGeneralSolidResult> {
  if (!Number.isFinite(request.wallMm) || request.wallMm <= 0) return { ok: false, message: "Enter a positive wall thickness for the thin revolve." };
  const wall = request.wallMm;
  const outerOffset = request.side === "inside" ? 0 : request.side === "outside" ? -wall : -wall / 2;
  const innerOffset = request.side === "inside" ? wall : request.side === "outside" ? 0 : wall / 2;
  const outer = offsetPolygon(request.outlineMm, outerOffset);
  if (!outer.ok) return { ok: false, message: `Thin revolve: ${outer.message}` };
  const inner = offsetPolygon(request.outlineMm, innerOffset);
  if (!inner.ok) return { ok: false, message: `Thin revolve: ${inner.message}` };
  const full = request.angleDeg >= 360 - 1e-6;
  const overshoot = full ? 0 : Math.min(1, (360 - request.angleDeg) / 2);
  const outerSolid = await createGeneralSolidBody({
    profile: profileOf("profile:thin-outer", outer.points), plane: request.plane, operation: "revolve", valueMm: request.angleDeg,
    bodyId: `${request.bodyId}:outer`, name: request.name, color: request.color
  });
  if (!outerSolid.ok) return outerSolid;
  const innerSolid = await createGeneralSolidBody({
    profile: profileOf("profile:thin-inner", inner.points), plane: request.plane, operation: "revolve", valueMm: full ? 360 : request.angleDeg + 2 * overshoot,
    bodyId: `${request.bodyId}:inner`, name: request.name, color: request.color
  });
  if (!innerSolid.ok) return innerSolid;
  if (full) {
    const shell = await hollowShell(outerSolid.body, innerSolid.body, request.bodyId, request.name);
    return { ok: true, body: { ...shell, color: request.color, feature: { operation: "revolve", plane: request.plane, valueMm: request.angleDeg } } };
  }
  const innerPlaced: GeneralSolidBody = { ...innerSolid.body, positionsMm: startRevolveAt(innerSolid.body.positionsMm, request.plane, -overshoot) };
  const walled = await combineGeneralBodies({ target: outerSolid.body, tool: innerPlaced, mode: "cut", bodyId: request.bodyId, name: request.name });
  if (!walled.ok) return { ok: false, message: `Thin revolve could not hollow the solid: ${walled.message}` };
  return { ok: true, body: { ...walled.body, color: request.color, feature: { operation: "revolve", plane: request.plane, valueMm: request.angleDeg } } };
}
