import { datumPointOf } from "../../../packages/workbench-core/src/index.js";
import type { DesignExtentTarget, DesignSketchFeature, DesignSolidFeature, GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { distanceToBody, distanceToFace, distanceToPoint, facePlaneOf, footprintSamples, halfSpaceBox, nearestMeshVertex, pickableVertices, placeDirection, placePoint, revolveAngleToFace, type ExtentDistance, type ExtentMesh } from "../../../packages/workbench-geometry/src/index.js";
import { detectSketchProfiles, profileOutlineMm, resolveProfileRegion } from "../../../packages/workbench-sketch/src/index.js";
import { combineGeneralBodies } from "./general-modeling.js";
import type { SolidRebuild } from "./design-regeneration.js";

type V3 = readonly [number, number, number];

/** The datum planes' extrusion normals and the way a sketch point lands on each plane (millimetres). */
const PLANE_NORMAL: Readonly<Record<"xy" | "xz" | "yz", V3>> = { xy: [0, 0, 1], xz: [0, -1, 0], yz: [1, 0, 0] };

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const scaled = (a: V3, factor: number): V3 => [a[0] * factor, a[1] * factor, a[2] * factor];

function planeKey(feature: DesignSketchFeature): "xy" | "xz" | "yz" {
  return feature.sketch.plane === "datum:xz" ? "xz" : feature.sketch.plane === "datum:yz" ? "yz" : "xy";
}

/** A point of the sketch (u, v in millimetres) in world space, with the sketch's plane offset and tilt applied. */
export function sketchPointToWorld(sketchFeature: DesignSketchFeature, u: number, v: number): V3 {
  const key = planeKey(sketchFeature);
  const base: V3 = datumPointOf(sketchFeature.sketch, u, v);
  const normal = PLANE_NORMAL[key];
  const offset = sketchFeature.sketch.planeOffsetMm ?? 0;
  return placePoint([base[0] + normal[0] * offset, base[1] + normal[1] * offset, base[2] + normal[2] * offset], sketchFeature.sketch);
}

/** Which "to" extents a step uses. */
export function isToExtent(extent: DesignSolidFeature["extent"]): boolean {
  return extent === "to-face" || extent === "to-body" || extent === "to-vertex" || extent === "to-first" || extent === "to-last";
}

export interface ExtentContext {
  /** The current geometry of a body: another body's latest shape, or, for the body being rebuilt, its shape at this point of the replay. */
  readonly bodyOf: (bodyId: string) => GeneralSolidBody | undefined;
}

export type ExtentResolution =
  | {
    readonly ok: true;
    /** The step with the measured distance (or angle) in `valueMm` and a plain distance extent, ready to build. */
    readonly step: DesignSolidFeature;
    /** For a face that is not parallel to the sketch: remove what lies past this plane after building. */
    readonly trim?: { readonly pointMm: V3; readonly beyondNormal: V3 };
    /** Set when the stored fallback was used because the target could not be found again. */
    readonly warning?: string;
  }
  | { readonly ok: false; readonly message: string };

function plain(step: DesignSolidFeature, valueMm: number): DesignSolidFeature {
  const { extent: _extent, extentTarget: _target, ...rest } = step;
  void _extent; void _target;
  return { ...rest, valueMm };
}

function meshOf(body: GeneralSolidBody): ExtentMesh {
  return { positionsMm: body.positionsMm, indices: body.indices, ...(body.brep === undefined ? {} : { faceTriangles: body.brep.faceTriangles }) };
}

function diagonalOf(positionsMm: readonly number[]): number {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index + 2 < positionsMm.length; index += 3) for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Math.min(min[axis]!, positionsMm[index + axis]!);
    max[axis] = Math.max(max[axis]!, positionsMm[index + axis]!);
  }
  return Number.isFinite(min[0]!) ? Math.hypot(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!) : 0;
}

/** A stand-in face for a target that is gone: a huge flat quad in the plane recorded when the target was picked. */
function storedPlane(point: V3, normal: V3): { readonly mesh: ExtentMesh; readonly faceIndex: number } {
  const length = Math.hypot(normal[0], normal[1], normal[2]);
  const n: V3 = [normal[0] / length, normal[1] / length, normal[2] / length];
  const helper: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u0: V3 = [n[1] * helper[2] - n[2] * helper[1], n[2] * helper[0] - n[0] * helper[2], n[0] * helper[1] - n[1] * helper[0]];
  const ul = Math.hypot(u0[0], u0[1], u0[2]);
  const u: V3 = [u0[0] / ul, u0[1] / ul, u0[2] / ul];
  const v: V3 = [n[1] * u[2] - n[2] * u[1], n[2] * u[0] - n[0] * u[2], n[0] * u[1] - n[1] * u[0]];
  const big = 1e6;
  const corner = (a: number, b: number): number[] => [point[0] + u[0] * a * big + v[0] * b * big, point[1] + u[1] * a * big + v[1] * b * big, point[2] + u[2] * a * big + v[2] * b * big];
  // u x v = n, so this order winds counter-clockwise seen from +n.
  return { mesh: { positionsMm: [...corner(-1, -1), ...corner(1, -1), ...corner(1, 1), ...corner(-1, 1)], indices: [0, 1, 2, 0, 2, 3], faceTriangles: [0, 0] }, faceIndex: 0 };
}

interface LocatedFace { readonly mesh: ExtentMesh; readonly faceIndex: number; readonly how: "name" | "position" | "stored-plane" }

/** Finds the target face again: by its name, else the flat face most like the one picked, else the plane recorded at the pick. */
function locateFace(body: GeneralSolidBody | undefined, target: DesignExtentTarget): LocatedFace | undefined {
  if (body?.brep !== undefined) {
    const mesh = meshOf(body);
    const byName = target.faceRole === undefined ? -1 : body.brep.faces.findIndex((face) => face.role === target.faceRole);
    if (byName >= 0) return { mesh, faceIndex: byName, how: "name" };
    if (target.pointMm !== undefined) {
      const diagonal = diagonalOf(body.positionsMm);
      let best = -1;
      let bestScore = Infinity;
      for (let index = 0; index < body.brep.faces.length; index += 1) {
        const plane = facePlaneOf(mesh, index);
        if (plane === undefined || !plane.planar) continue;
        if (target.normal !== undefined && dot(plane.normal, target.normal) < 0.98 * Math.hypot(...target.normal)) continue;
        // How far the picked point is from this face's box: zero when the point is on the face.
        let gap = 0;
        for (let axis = 0; axis < 3; axis += 1) gap += Math.max(0, plane.boundsMm.min[axis]! - target.pointMm[axis]!, target.pointMm[axis]! - plane.boundsMm.max[axis]!) ** 2;
        const score = Math.sqrt(gap);
        if (score < bestScore) { best = index; bestScore = score; }
      }
      if (best >= 0 && bestScore <= 0.25 * diagonal + 1e-6) return { mesh, faceIndex: best, how: "position" };
    }
  }
  if (target.pointMm !== undefined && target.normal !== undefined) {
    const stored = storedPlane(target.pointMm, target.normal);
    return { ...stored, how: "stored-plane" };
  }
  return undefined;
}

async function trimmedTo(tool: GeneralSolidBody, trim: { readonly pointMm: V3; readonly beyondNormal: V3 }): Promise<SolidRebuild> {
  const diagonal = diagonalOf(tool.positionsMm);
  const n = trim.beyondNormal;
  const length = Math.hypot(n[0], n[1], n[2]);
  const unitNormal: V3 = [n[0] / length, n[1] / length, n[2] / length];
  // Centre the box over the tool: slide the plane point across the plane to the tool's own position.
  let cx = 0; let cy = 0; let cz = 0;
  const count = tool.positionsMm.length / 3;
  for (let index = 0; index < tool.positionsMm.length; index += 3) { cx += tool.positionsMm[index]! / count; cy += tool.positionsMm[index + 1]! / count; cz += tool.positionsMm[index + 2]! / count; }
  const along = dot(sub([cx, cy, cz], trim.pointMm), unitNormal);
  const anchor: V3 = [cx - unitNormal[0] * along, cy - unitNormal[1] * along, cz - unitNormal[2] * along];
  // Just big enough to cover everything of the tool past the plane: a huge slab would make the Boolean's volume tolerance swallow the cut.
  const box = halfSpaceBox(anchor, unitNormal, 0.75 * diagonal + 1, diagonal + Math.abs(along) + 1);
  const slab: GeneralSolidBody = { id: `${tool.id}:beyond`, name: "beyond the face", visible: true, color: tool.color, positionsMm: [...box.positionsMm], indices: [...box.indices] };
  const cut = await combineGeneralBodies({ target: tool, tool: slab, mode: "cut", bodyId: tool.id, name: tool.name });
  if (!cut.ok) return { ok: false, message: `The extrusion could not be trimmed to that face: ${cut.message}` };
  return { ok: true, body: { ...cut.body, color: tool.color, ...(tool.feature === undefined ? {} : { feature: tool.feature }) } };
}

/** Removes what lies past a tilted target face from a freshly built tool solid. */
export const trimToFace = trimmedTo;

function failure(result: Extract<ExtentDistance, { ok: false }>): ExtentResolution {
  return { ok: false, message: result.message };
}

/**
 * Measures a "to" extent from the current shape of its target and returns the step as a plain distance (or angle) to build. `build` makes
 * a solid from a step; it is used once with a 1 mm probe to find where the sketch's profile lies in the world. When the target cannot be
 * found again, the picked point is used when there is one, and the step's stored distance otherwise, with a warning that says so.
 */
export async function resolveExtent(step: DesignSolidFeature, sketchFeature: DesignSketchFeature, context: ExtentContext, build: (feature: DesignSolidFeature) => Promise<SolidRebuild>): Promise<ExtentResolution> {
  const toExtrude = step.kind === "extrude" && (step.extent === "to-face" || step.extent === "to-body" || step.extent === "to-vertex");
  const toRevolve = step.kind === "revolve" && (step.extent === "to-first" || step.extent === "to-last");
  if (!toExtrude && !toRevolve) return { ok: true, step };
  const target = step.extentTarget;
  if (target === undefined) return { ok: true, step: plain(step, step.valueMm), warning: "This step reaches a target, but none is recorded. It keeps its last distance." };
  const body = context.bodyOf(target.bodyId);
  const lostWarning = (what: string): string => `${what} could not be found again, so ${step.kind === "revolve" ? "the revolve" : "the extrusion"} keeps ${target.pointMm !== undefined ? "the position it was picked at" : "its last distance"}.`;

  if (toRevolve) {
    const profiles = detectSketchProfiles(sketchFeature.sketch);
    const region = resolveProfileRegion(profiles, step.profileIds, { includeIslands: false });
    if (!region.ok) return { ok: false, message: region.diagnostics[0]?.message ?? "The sketch has no closed profile for this revolve." };
    const corners = profileOutlineMm(region.value.outer.boundary).map(([u, v]) => sketchPointToWorld(sketchFeature, u, v));
    const axisStart = sketchPointToWorld(sketchFeature, 0, 0);
    const axisEnd = sketchPointToWorld(sketchFeature, 0, 1);
    const axis = sub(axisEnd, axisStart);
    // A revolve sweeps right-handed about the opposite of the sketch's Y axis; a flipped one sweeps the other way.
    const sweepAxis = scaled(axis, step.direction === "flipped" ? 1 : -1);
    const located = locateFace(body, target);
    if (located === undefined) return { ok: true, step: plain(step, step.valueMm), warning: lostWarning("The face to revolve to") };
    const reach = revolveAngleToFace(located.mesh, located.faceIndex, corners, axisStart, sweepAxis, step.extent === "to-last" ? "last" : "first");
    if (!reach.ok) return { ok: false, message: reach.message };
    return { ok: true, step: plain(step, reach.angleDeg), ...(located.how === "name" ? {} : { warning: located.how === "position" ? "The face name changed, so the face nearest the picked spot was used." : lostWarning("The face to revolve to") }) };
  }

  // Extrusion: find where the profile lies by building a 1 mm probe, then measure along the sketch's normal.
  const { direction: _direction, secondValueMm: _second, ...unswept } = plain(step, 1);
  void _direction; void _second;
  const probe = await build({ ...unswept, bodyId: `${step.id}:probe` });
  if (!probe.ok) return { ok: false, message: probe.message };
  const normal = placeDirection(PLANE_NORMAL[planeKey(sketchFeature)], sketchFeature.sketch);
  const heading = scaled(normal, step.direction === "flipped" ? -1 : 1);
  const projections: number[] = [];
  for (let index = 0; index + 2 < probe.body.positionsMm.length; index += 3) projections.push(dot([probe.body.positionsMm[index]!, probe.body.positionsMm[index + 1]!, probe.body.positionsMm[index + 2]!], normal));
  const lowest = Math.min(...projections);
  const seen = new Set<string>();
  const footprint: V3[] = [];
  projections.forEach((projection, vertex) => {
    if (projection > lowest + 1e-6) return;
    const point: V3 = [probe.body.positionsMm[vertex * 3]!, probe.body.positionsMm[vertex * 3 + 1]!, probe.body.positionsMm[vertex * 3 + 2]!];
    const key = point.map((value) => Math.round(value * 1e4)).join(",");
    if (!seen.has(key)) { seen.add(key); footprint.push(point); }
  });
  if (footprint.length === 0) return { ok: false, message: "The profile could not be located to measure from." };
  const samples = footprintSamples(footprint);

  let measured: ExtentDistance | undefined;
  let warning: string | undefined;
  if (step.extent === "to-vertex") {
    let point = target.pointMm;
    if (body !== undefined) {
      const corners = pickableVertices({ positionsMm: body.positionsMm, indices: body.indices });
      const nearest = typeof corners === "string" || target.pointMm === undefined ? undefined : nearestMeshVertex(corners, target.pointMm);
      if (nearest !== undefined && nearest.distanceMm <= Math.max(1, 0.25 * diagonalOf(body.positionsMm))) point = nearest.vertex.pointMm;
      else warning = "The vertex could not be found again on that solid, so its picked position was used.";
    } else warning = lostWarning("The vertex");
    if (point === undefined) return { ok: true, step: plain(step, step.valueMm), warning: lostWarning("The vertex") };
    measured = distanceToPoint(point, footprint[0]!, heading);
  } else if (step.extent === "to-body") {
    if (body === undefined) return { ok: true, step: plain(step, step.valueMm), warning: lostWarning("The solid") };
    measured = distanceToBody(meshOf(body), samples, heading);
  } else {
    const located = locateFace(body, target);
    if (located === undefined) return { ok: true, step: plain(step, step.valueMm), warning: lostWarning("The face") };
    if (located.how === "position") warning = "The face name changed, so the face nearest the picked spot was used.";
    if (located.how === "stored-plane") warning = lostWarning("The face");
    measured = distanceToFace(located.mesh, located.faceIndex, samples, heading);
  }
  if (!measured.ok) return failure(measured);
  const distance = measured.trim === undefined ? measured.nearMm : measured.farMm;
  return { ok: true, step: plain(step, distance), ...(measured.trim === undefined ? {} : { trim: measured.trim }), ...(warning === undefined ? {} : { warning }) };
}
