import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, RevolveAxisRef } from "../../../packages/workbench-core/src/index.js";
import type { SketchProfile } from "../../../packages/workbench-sketch/src/index.js";
import { profileOutlineMm } from "../../../packages/workbench-sketch/src/index.js";
import { createGeneralSolidBody, type SketchPlane } from "./general-modeling.js";
import { createThinRevolveBody, startRevolveAt } from "./revolve-thin.js";
import { datumKey, describeSketchAxes, worldToSketch } from "./sketch-world.js";

type Point2 = readonly [number, number];

/**
 * Revolve about a chosen axis.
 *
 * A revolve used to turn about the sketch Y axis only, and a profile on the negative-X side came out inside out. The profile is now moved
 * into a canonical frame in which the axis is the Y axis and the profile lies on the +X side (mirrored across the axis when it was on the
 * other side), built there with the existing revolve builders, and carried back. The turn always starts at the sketch plane and goes
 * toward the plane's normal side, so a profile on either side of the axis gives the mirror image of the other.
 */

export interface RevolveAxis {
  readonly pointMm: Point2;
  /** Unit vector along the axis in sketch coordinates. */
  readonly directionMm: Point2;
  readonly label: string;
}

export const SKETCH_Y_AXIS: RevolveAxis = { pointMm: [0, 0], directionMm: [0, 1], label: "the sketch Y axis" };

export type RevolveAxisResolution = { readonly ok: true; readonly axis: RevolveAxis; readonly isDefault: boolean; readonly note?: string } | { readonly ok: false; readonly message: string };

/** Finds the axis a revolve feature turns about, in sketch coordinates, or says why it cannot. */
export function resolveRevolveAxis(ref: RevolveAxisRef | undefined, sketchFeature: DesignSketchFeature, bodies?: readonly GeneralSolidBody[]): RevolveAxisResolution {
  if (ref === undefined || (ref.kind === "sketch-axis" && ref.axis === "y")) return { ok: true, axis: SKETCH_Y_AXIS, isDefault: true };
  if (ref.kind === "sketch-axis") return { ok: true, axis: { pointMm: [0, 0], directionMm: [1, 0], label: "the sketch X axis" }, isDefault: false };
  const sketch = sketchFeature.sketch;
  if (ref.kind === "sketch-line") {
    const line = sketch.entities.find((entity) => entity.id === ref.entityId);
    if (line === undefined) return { ok: false, message: `The line this revolve turns about (${ref.entityId.replace(/^entity:/u, "")}) is no longer in its sketch. Pick the axis again, or restore the line.` };
    if (line.kind !== "line") return { ok: false, message: "A revolve axis must be a straight line; the entity picked as its axis is not one." };
    const dx = line.end[0] - line.start[0];
    const dy = line.end[1] - line.start[1];
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) return { ok: false, message: "The line picked as the revolve axis has no length." };
    return { ok: true, axis: { pointMm: line.start, directionMm: [dx / length, dy / length], label: `the ${line.construction ? "construction " : ""}line ${line.id.replace(/^entity:/u, "")}` }, isDefault: false };
  }
  const start = worldToSketch(sketch, ref.startMm);
  const end = worldToSketch(sketch, ref.endMm);
  if (Math.abs(start.w) > 0.01 || Math.abs(end.w) > 0.01) {
    return { ok: false, message: `The model edge picked as the revolve axis does not lie in the sketch plane (it is ${Math.max(Math.abs(start.w), Math.abs(end.w)).toFixed(2)} mm off it). Pick an edge in the plane, or draw a line of the sketch along it.` };
  }
  const dx = end.u - start.u;
  const dy = end.v - start.v;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) return { ok: false, message: "The model edge picked as the revolve axis is perpendicular to the sketch plane, so it is a point there. Pick an edge that runs along the plane." };
  const note = bodies !== undefined && !bodies.some((candidate) => candidate.id === ref.bodyId) ? `The body of the edge this revolve turns about (${ref.bodyId}) is gone; the axis keeps the position it was picked at.` : undefined;
  return { ok: true, axis: { pointMm: [start.u, start.v], directionMm: [dx / length, dy / length], label: "a model edge" }, isDefault: false, ...(note === undefined ? {} : { note }) };
}

/** A sketch point seen in the axis's frame: x is the distance from the axis (to the axis's right), y the position along it. */
export function toAxisFrame(axis: RevolveAxis, point: Point2): Point2 {
  const px = point[0] - axis.pointMm[0];
  const py = point[1] - axis.pointMm[1];
  return [px * axis.directionMm[1] - py * axis.directionMm[0], px * axis.directionMm[0] + py * axis.directionMm[1]];
}

export function fromAxisFrame(axis: RevolveAxis, local: Point2): Point2 {
  return [
    axis.pointMm[0] + local[0] * axis.directionMm[1] + local[1] * axis.directionMm[0],
    axis.pointMm[1] - local[0] * axis.directionMm[0] + local[1] * axis.directionMm[1]
  ];
}

export type AxisSide = "positive" | "negative" | "crosses" | "on-axis";

/** Which side of the axis a closed outline lies on. Points within `toleranceMm` of the axis count as touching it. */
export function sideOfAxis(axis: RevolveAxis, outline: readonly Point2[], toleranceMm = 1e-6): AxisSide {
  let positive = false;
  let negative = false;
  for (const point of outline) {
    const x = toAxisFrame(axis, point)[0];
    if (x > toleranceMm) positive = true;
    else if (x < -toleranceMm) negative = true;
  }
  if (positive && negative) return "crosses";
  return positive ? "positive" : negative ? "negative" : "on-axis";
}

export interface PreparedRevolve {
  readonly axis: RevolveAxis;
  readonly mirrored: boolean;
  /** The profile in the canonical frame: on the +X side of a Y axis through the origin. */
  readonly profile: SketchProfile;
  readonly outline: readonly Point2[];
}

export type RevolvePreparation = { readonly ok: true; readonly prepared: PreparedRevolve } | { readonly ok: false; readonly message: string };

function signedArea(points: readonly Point2[]): number {
  let area = 0;
  for (let index = 0; index < points.length; index += 1) {
    const [x1, y1] = points[index]!;
    const [x2, y2] = points[(index + 1) % points.length]!;
    area += x1 * y2 - x2 * y1;
  }
  return area / 2;
}

/** Moves a profile into the canonical revolve frame (see above), mirroring it across the axis when it lies on the negative side. */
export function prepareRevolve(axis: RevolveAxis, profile: SketchProfile): RevolvePreparation {
  const outline = profileOutlineMm(profile.boundary);
  const side = sideOfAxis(axis, outline);
  if (side === "crosses") {
    return { ok: false, message: `The profile crosses the revolve axis (${axis.label}), so it would overlap itself. Draw the profile entirely on one side of the axis, or move the axis to its edge.` };
  }
  if (side === "on-axis") return { ok: false, message: `The profile lies on the revolve axis (${axis.label}), so it would revolve into nothing. Move the profile off the axis.` };
  const mirrored = side === "negative";
  const mapPoint = (point: Point2): Point2 => {
    const local = toAxisFrame(axis, point);
    return mirrored ? [-local[0], local[1]] : local;
  };
  const angleDeg = (Math.atan2(axis.directionMm[0], axis.directionMm[1]) * 180) / Math.PI;
  const boundary = profile.boundary;
  let moved: SketchProfile["boundary"];
  if (boundary.kind === "circle") moved = { kind: "circle", center: mapPoint(boundary.center), radiusMm: boundary.radiusMm };
  else if (boundary.kind === "rectangle") moved = { kind: "rectangle", center: mapPoint(boundary.center), widthMm: boundary.widthMm, heightMm: boundary.heightMm, rotationDeg: mirrored ? -(boundary.rotationDeg + angleDeg) : boundary.rotationDeg + angleDeg };
  else if (boundary.kind === "ellipse") moved = { kind: "ellipse", center: mapPoint(boundary.center), majorRadiusMm: boundary.majorRadiusMm, minorRadiusMm: boundary.minorRadiusMm, rotationDeg: mirrored ? -(boundary.rotationDeg + angleDeg) : boundary.rotationDeg + angleDeg };
  else if (!mirrored && boundary.kind === "curve-loop") moved = { kind: "curve-loop", points: boundary.points.map(mapPoint), segments: boundary.segments };
  else {
    const points = outline.map(mapPoint);
    // Mirroring turns the outline the other way round; turn it back so the profile keeps its winding.
    moved = { kind: "line-loop", points: mirrored && signedArea(points) * signedArea(outline) < 0 ? [...points].reverse() : points };
  }
  const centroid = mapPoint(profile.centroid);
  const prepared: SketchProfile = { ...profile, boundary: moved, centroid };
  return { ok: true, prepared: { axis, mirrored, profile: prepared, outline: profileOutlineMm(moved) } };
}

/** Carries canonical-frame positions (xyz as built on the XY plane) back onto the sketch's own plane. */
export function carryBack(positionsMm: readonly number[], prepared: PreparedRevolve, plane: SketchPlane): number[] {
  const out: number[] = new Array(positionsMm.length);
  for (let index = 0; index + 2 < positionsMm.length; index += 3) {
    const local: Point2 = [prepared.mirrored ? -positionsMm[index]! : positionsMm[index]!, positionsMm[index + 1]!];
    const [x, y] = fromAxisFrame(prepared.axis, local);
    const z = positionsMm[index + 2]!;
    // The same plane mapping the extrusion uses for a point built on the XY plane.
    if (plane === "xz") { out[index] = x; out[index + 1] = -z; out[index + 2] = y; }
    else if (plane === "yz") { out[index] = z; out[index + 1] = y; out[index + 2] = -x; }
    else { out[index] = x; out[index + 1] = y; out[index + 2] = z; }
  }
  return out;
}

function flipWinding(indices: readonly number[]): number[] {
  const out = [...indices];
  for (let index = 0; index + 2 < out.length; index += 3) { const swap = out[index + 1]!; out[index + 1] = out[index + 2]!; out[index + 2] = swap; }
  return out;
}

export interface AxisRevolveRequest {
  readonly feature: DesignSolidFeature;
  readonly prepared: PreparedRevolve;
  readonly plane: SketchPlane;
  /** How far the turn goes in all, and where on the turn it starts (see revolveSpan). */
  readonly totalDeg: number;
  readonly startDeg: number;
  readonly color: string;
}

export type AxisRevolveResult = { readonly ok: true; readonly body: GeneralSolidBody } | { readonly ok: false; readonly message: string };

/** Builds the revolve in the canonical frame and returns it on the sketch's plane, started and wound correctly. Offset and placement are the caller's. */
export async function buildAxisRevolve(request: AxisRevolveRequest): Promise<AxisRevolveResult> {
  const { feature, prepared } = request;
  const built = feature.thinWallMm !== undefined
    ? await createThinRevolveBody({ outlineMm: prepared.outline, plane: "xy", angleDeg: request.totalDeg, wallMm: feature.thinWallMm, side: feature.thinSide ?? "inside", bodyId: feature.bodyId, name: feature.name, color: request.color })
    : await createGeneralSolidBody({ profile: prepared.profile, plane: "xy", operation: "revolve", valueMm: request.totalDeg, bodyId: feature.bodyId, name: feature.name, color: request.color });
  if (!built.ok) return built;
  const started = request.startDeg === 0 ? built.body.positionsMm : startRevolveAt(built.body.positionsMm, "xy", request.startDeg);
  const positionsMm = carryBack(started, prepared, request.plane);
  const indices = prepared.mirrored ? flipWinding(built.body.indices) : [...built.body.indices];
  return { ok: true, body: { ...built.body, positionsMm, indices, feature: { operation: "revolve", plane: request.plane, valueMm: request.totalDeg } } };
}

/** A one-line description of what a revolve turns about, for the timeline and messages. */
export function describeRevolveAxis(axis: RevolveAxis, sketchFeature: DesignSketchFeature): string {
  const key = datumKey(sketchFeature.sketch);
  return axis.label === SKETCH_Y_AXIS.label && key === "yz" ? `${axis.label} (world +Y on the YZ plane; ${describeSketchAxes(sketchFeature.sketch)})` : axis.label;
}
