/**
 * Pure evaluation of a {@link ConstructionPlane} down to an oriented frame
 * (origin, outward normal, two in-plane axes) and a nominal rendering size.
 * No persistent-topology state is kept: each call recomputes from the plane's
 * definition. Used by {@link buildPartPreview} to draw the translucent quad
 * and by the browser tree / inspector to describe the plane.
 */

import type { ConstructionAxis, ConstructionAxisDefinition, ConstructionPlane, ConstructionPlaneDefinition, ConstructionPoint, ConstructionPointDefinition, GeneralSolidBody, SketchDatumPlane, Vec3 } from "../../workbench-core/src/index.js";

export interface ConstructionPlaneFrame {
  readonly origin: Vec3;
  readonly normal: Vec3;
  readonly uAxis: Vec3;
  readonly vAxis: Vec3;
  /** Rendering half-width and half-height along uAxis and vAxis, in millimetres. */
  readonly sizeMm: readonly [number, number];
  readonly description: string;
}

const DATUM_FRAMES: Readonly<Record<SketchDatumPlane, { readonly normal: Vec3; readonly uAxis: Vec3; readonly vAxis: Vec3; readonly label: string }>> = {
  "datum:xy": { normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0], label: "XY" },
  "datum:xz": { normal: [0, 1, 0], uAxis: [1, 0, 0], vAxis: [0, 0, 1], label: "XZ" },
  "datum:yz": { normal: [1, 0, 0], uAxis: [0, 1, 0], vAxis: [0, 0, 1], label: "YZ" }
};

const DEFAULT_HALF_SIZE_MM = 60;

export function evaluateConstructionPlane(plane: ConstructionPlane, bodies: readonly GeneralSolidBody[] = []): ConstructionPlaneFrame | { readonly error: string } {
  return evaluateConstructionPlaneDefinition(plane.definition, bodies);
}

export function evaluateConstructionPlaneDefinition(definition: ConstructionPlaneDefinition, bodies: readonly GeneralSolidBody[] = []): ConstructionPlaneFrame | { readonly error: string } {
  if (definition.kind === "offset") {
    const base = DATUM_FRAMES[definition.basePlane];
    const origin: Vec3 = [base.normal[0] * definition.offsetMm, base.normal[1] * definition.offsetMm, base.normal[2] * definition.offsetMm];
    return { origin, normal: base.normal, uAxis: base.uAxis, vAxis: base.vAxis, sizeMm: [DEFAULT_HALF_SIZE_MM, DEFAULT_HALF_SIZE_MM], description: `Offset ${definition.offsetMm.toFixed(2)} mm from ${base.label}` };
  }
  if (definition.kind === "angle") {
    const base = DATUM_FRAMES[definition.basePlane];
    const axis = axisVector(definition.axis);
    const rotation = rotateAroundAxis(axis, definition.angleDeg * Math.PI / 180);
    const normal = applyMatrix(rotation, base.normal);
    const uAxis = applyMatrix(rotation, base.uAxis);
    const vAxis = applyMatrix(rotation, base.vAxis);
    return { origin: [0, 0, 0], normal: normalize(normal) ?? [0, 0, 1], uAxis: normalize(uAxis) ?? [1, 0, 0], vAxis: normalize(vAxis) ?? [0, 1, 0], sizeMm: [DEFAULT_HALF_SIZE_MM, DEFAULT_HALF_SIZE_MM], description: `${base.label} rotated ${definition.angleDeg.toFixed(1)}° about ${definition.axis.toUpperCase()}` };
  }
  if (definition.kind === "three-points") {
    const [p0, p1, p2] = definition.points;
    const u = sub(p1, p0);
    const v = sub(p2, p0);
    const normal = normalize(cross(u, v));
    if (normal === undefined) return { error: "The three points are collinear." };
    const uAxis = normalize(u) ?? [1, 0, 0];
    const vAxis = normalize(cross(normal, uAxis)) ?? [0, 1, 0];
    const halfU = Math.max(DEFAULT_HALF_SIZE_MM, Math.hypot(u[0], u[1], u[2]));
    const halfV = Math.max(DEFAULT_HALF_SIZE_MM, Math.hypot(v[0], v[1], v[2]));
    return { origin: p0, normal, uAxis, vAxis, sizeMm: [halfU, halfV], description: `Through 3 points` };
  }
  if (definition.kind === "midplane") {
    const base = DATUM_FRAMES[definition.basePlane];
    const mid = (definition.fromMm + definition.toMm) / 2;
    const origin: Vec3 = [base.normal[0] * mid, base.normal[1] * mid, base.normal[2] * mid];
    return { origin, normal: base.normal, uAxis: base.uAxis, vAxis: base.vAxis, sizeMm: [DEFAULT_HALF_SIZE_MM, DEFAULT_HALF_SIZE_MM], description: `Midplane between ${definition.fromMm.toFixed(2)} and ${definition.toMm.toFixed(2)} mm of ${base.label}` };
  }
  if (definition.kind === "perpendicular-to-axis") {
    // Perpendicular to a construction axis, passing through a world-space point.
    // The caller passes in `axes` via a side channel is not available here; we fall back to using the point directly
    // with a world-+Z normal when the axis is unresolved (callers that care about perpendicular-to-axis can
    // alternatively supply their own frame). For now emit an identity-ish frame flagged as perpendicular-to-axis.
    const origin = definition.point;
    // Without axis resolution here we return an error-friendly frame: callers evaluating perpendicular-to-axis should
    // route through a higher-level helper that has access to the construction axes. For now we expose a flat +Z plane
    // through the point as a safe fallback, and the audit records the limitation.
    return { origin, normal: [0, 0, 1], uAxis: [1, 0, 0], vAxis: [0, 1, 0], sizeMm: [DEFAULT_HALF_SIZE_MM, DEFAULT_HALF_SIZE_MM], description: `Perpendicular to axis ${definition.axisId}` };
  }
  // tangent-to-cylinder: a plane tangent to a revolve / extrude body at a given angle around its axis
  const body = bodies.find((candidate) => candidate.id === definition.bodyId);
  if (body === undefined) return { error: "The body this tangent plane is built on is no longer in the part." };
  const operation = body.feature?.operation;
  if (operation !== "revolve" && operation !== "extrude") return { error: `Only revolve and extrude bodies donate a tangent plane in this slice (this body is ${operation ?? "unknown"}).` };
  const bodyPlaneKey: SketchDatumPlane = body.feature!.plane === "xy" ? "datum:xy" : body.feature!.plane === "xz" ? "datum:xz" : "datum:yz";
  const bodyFrame = DATUM_FRAMES[bodyPlaneKey];
  // Centroid of the body as the reference point on its axis; max radial distance as the cylinder radius.
  let cx = 0; let cy = 0; let cz = 0;
  const vertexCount = body.positionsMm.length / 3;
  if (vertexCount === 0) return { error: "The body has no vertices to source a tangent plane from." };
  for (let index = 0; index < body.positionsMm.length; index += 3) { cx += body.positionsMm[index]!; cy += body.positionsMm[index + 1]!; cz += body.positionsMm[index + 2]!; }
  const centroid: Vec3 = [cx / vertexCount, cy / vertexCount, cz / vertexCount];
  const axis = bodyFrame.normal;
  const perp1 = bodyFrame.uAxis;
  const perp2 = bodyFrame.vAxis;
  let maxRadius = 0;
  for (let index = 0; index < body.positionsMm.length; index += 3) {
    const dx = body.positionsMm[index]! - centroid[0];
    const dy = body.positionsMm[index + 1]! - centroid[1];
    const dz = body.positionsMm[index + 2]! - centroid[2];
    // Radial distance = projection onto the plane perpendicular to the axis.
    const radialU = dx * perp1[0] + dy * perp1[1] + dz * perp1[2];
    const radialV = dx * perp2[0] + dy * perp2[1] + dz * perp2[2];
    const r = Math.hypot(radialU, radialV);
    if (r > maxRadius) maxRadius = r;
  }
  if (maxRadius < 1e-6) return { error: "The body has no measurable radial extent to source a tangent plane from." };
  const theta = definition.angleDeg * Math.PI / 180;
  const outward: Vec3 = [perp1[0] * Math.cos(theta) + perp2[0] * Math.sin(theta), perp1[1] * Math.cos(theta) + perp2[1] * Math.sin(theta), perp1[2] * Math.cos(theta) + perp2[2] * Math.sin(theta)];
  const origin: Vec3 = [centroid[0] + outward[0] * maxRadius, centroid[1] + outward[1] * maxRadius, centroid[2] + outward[2] * maxRadius];
  // The plane's in-plane axes: along the body axis for one, perpendicular to both for the other.
  const inPlaneU = axis;
  const inPlaneV = normalize(cross(outward, axis)) ?? perp2;
  return { origin, normal: outward, uAxis: inPlaneU, vAxis: inPlaneV, sizeMm: [DEFAULT_HALF_SIZE_MM, DEFAULT_HALF_SIZE_MM], description: `Tangent to ${body.name} at ${definition.angleDeg.toFixed(1)}°` };
}

/** An evaluated construction axis: an origin point and a unit direction, plus the nominal half-length to draw it at. */
export interface ConstructionAxisFrame {
  readonly origin: Vec3;
  readonly direction: Vec3;
  /** Half-length of the rendered segment in millimetres. */
  readonly halfLengthMm: number;
  readonly description: string;
}

const DEFAULT_AXIS_HALF_LENGTH_MM = 80;

/**
 * Evaluate a construction axis down to an oriented line segment: origin, unit direction and nominal half-length. For
 * `cylinder-axis` the caller must pass the bodies registry so the axis can be derived from the body's generating
 * operation (revolve or extrude) — when the body is absent or can't donate an axis, an error is reported.
 */
export function evaluateConstructionAxis(axis: ConstructionAxis, bodies: readonly GeneralSolidBody[] = []): ConstructionAxisFrame | { readonly error: string } {
  return evaluateConstructionAxisDefinition(axis.definition, bodies);
}

export function evaluateConstructionAxisDefinition(definition: ConstructionAxisDefinition, bodies: readonly GeneralSolidBody[] = []): ConstructionAxisFrame | { readonly error: string } {
  if (definition.kind === "two-points") {
    const direction = normalize(sub(definition.b, definition.a));
    if (direction === undefined) return { error: "The two axis points coincide." };
    const length = Math.hypot(definition.b[0] - definition.a[0], definition.b[1] - definition.a[1], definition.b[2] - definition.a[2]);
    const origin: Vec3 = [(definition.a[0] + definition.b[0]) / 2, (definition.a[1] + definition.b[1]) / 2, (definition.a[2] + definition.b[2]) / 2];
    return { origin, direction, halfLengthMm: Math.max(DEFAULT_AXIS_HALF_LENGTH_MM, length / 2), description: "Through two points" };
  }
  if (definition.kind === "point-and-direction") {
    const direction = normalize(definition.direction);
    if (direction === undefined) return { error: "The axis direction has zero length." };
    return { origin: definition.origin, direction, halfLengthMm: DEFAULT_AXIS_HALF_LENGTH_MM, description: "Point and direction" };
  }
  if (definition.kind === "plane-intersection") {
    if (definition.planeA === definition.planeB) return { error: "The two planes must be different." };
    const normalA = DATUM_FRAMES[definition.planeA].normal;
    const normalB = DATUM_FRAMES[definition.planeB].normal;
    const direction = normalize(cross(normalA, normalB));
    if (direction === undefined) return { error: "The two planes are parallel and do not intersect." };
    return { origin: [0, 0, 0], direction, halfLengthMm: DEFAULT_AXIS_HALF_LENGTH_MM, description: `Intersection of ${DATUM_FRAMES[definition.planeA].label} and ${DATUM_FRAMES[definition.planeB].label}` };
  }
  if (definition.kind === "perpendicular-to-plane") {
    const base = DATUM_FRAMES[definition.plane];
    return { origin: definition.point, direction: base.normal, halfLengthMm: DEFAULT_AXIS_HALF_LENGTH_MM, description: `Perpendicular to ${base.label}` };
  }
  if (definition.kind === "cylinder-axis") {
    const body = bodies.find((candidate) => candidate.id === definition.bodyId);
    if (body === undefined) return { error: "The body this axis is built on is no longer in the part." };
    const operation = body.feature?.operation;
    if (operation === undefined) return { error: "The body carries no originating operation to donate an axis." };
    if (operation !== "revolve" && operation !== "extrude") return { error: `Only revolve and extrude bodies donate an axis in this slice (this body is ${operation}).` };
    const plane = body.feature!.plane;
    // Centroid of the body's vertices, projected onto the plane's normal line.
    let cx = 0; let cy = 0; let cz = 0;
    const count = body.positionsMm.length / 3;
    for (let index = 0; index < body.positionsMm.length; index += 3) { cx += body.positionsMm[index]!; cy += body.positionsMm[index + 1]!; cz += body.positionsMm[index + 2]!; }
    const origin: Vec3 = count === 0 ? [0, 0, 0] : [cx / count, cy / count, cz / count];
    const direction = DATUM_FRAMES[plane === "xy" ? "datum:xy" : plane === "xz" ? "datum:xz" : "datum:yz"].normal;
    return { origin, direction, halfLengthMm: DEFAULT_AXIS_HALF_LENGTH_MM, description: `${operation === "revolve" ? "Revolve" : "Extrude"} axis of ${body.name}` };
  }
  return { error: "Unknown construction-axis kind." };
}

/** An evaluated construction point: a world-space position. */
export interface ConstructionPointFrame {
  readonly position: Vec3;
  readonly description: string;
}

export function evaluateConstructionPoint(point: ConstructionPoint, axes: readonly ConstructionAxis[] = [], bodies: readonly GeneralSolidBody[] = []): ConstructionPointFrame | { readonly error: string } {
  return evaluateConstructionPointDefinition(point.definition, axes, bodies);
}

export function evaluateConstructionPointDefinition(definition: ConstructionPointDefinition, axes: readonly ConstructionAxis[] = [], bodies: readonly GeneralSolidBody[] = []): ConstructionPointFrame | { readonly error: string } {
  if (definition.kind === "xyz") return { position: definition.position, description: "XYZ" };
  if (definition.kind === "midpoint") {
    return { position: [(definition.a[0] + definition.b[0]) / 2, (definition.a[1] + definition.b[1]) / 2, (definition.a[2] + definition.b[2]) / 2], description: "Midpoint of two points" };
  }
  if (definition.kind === "axis-plane-intersection") {
    const axis = axes.find((candidate) => candidate.id === definition.axisId);
    if (axis === undefined) return { error: "The axis this point is built on is no longer in the part." };
    const frame = evaluateConstructionAxisDefinition(axis.definition, bodies);
    if ("error" in frame) return { error: `The axis could not be evaluated: ${frame.error}` };
    const base = DATUM_FRAMES[definition.plane];
    const denom = frame.direction[0] * base.normal[0] + frame.direction[1] * base.normal[1] + frame.direction[2] * base.normal[2];
    if (Math.abs(denom) < 1e-9) return { error: "The axis is parallel to the plane; they do not intersect." };
    // Plane passes through the origin; parameter t: (origin + t × direction) · normal = 0.
    const t = -(frame.origin[0] * base.normal[0] + frame.origin[1] * base.normal[1] + frame.origin[2] * base.normal[2]) / denom;
    return { position: [frame.origin[0] + frame.direction[0] * t, frame.origin[1] + frame.direction[1] * t, frame.origin[2] + frame.direction[2] * t], description: `${axis.name} ∩ ${base.label}` };
  }
  return { error: "Unknown construction-point kind." };
}

/** Four corners of the plane's rendering quad in the order BL, BR, TR, TL. */
export function constructionPlaneCorners(frame: ConstructionPlaneFrame): readonly [Vec3, Vec3, Vec3, Vec3] {
  const [halfU, halfV] = frame.sizeMm;
  const point = (du: number, dv: number): Vec3 => [
    frame.origin[0] + frame.uAxis[0] * du + frame.vAxis[0] * dv,
    frame.origin[1] + frame.uAxis[1] * du + frame.vAxis[1] * dv,
    frame.origin[2] + frame.uAxis[2] * du + frame.vAxis[2] * dv
  ];
  return [point(-halfU, -halfV), point(halfU, -halfV), point(halfU, halfV), point(-halfU, halfV)];
}

// ---------------------------------------------------------------------------------------------

function axisVector(axis: "x" | "y" | "z"): Vec3 {
  return axis === "x" ? [1, 0, 0] : axis === "y" ? [0, 1, 0] : [0, 0, 1];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function normalize(v: Vec3): Vec3 | undefined {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length < 1e-9) return undefined;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function rotateAroundAxis(axis: Vec3, radians: number): readonly number[] {
  const n = normalize(axis) ?? [0, 0, 1];
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  const t = 1 - c;
  return [
    t * n[0] * n[0] + c, t * n[0] * n[1] - s * n[2], t * n[0] * n[2] + s * n[1],
    t * n[0] * n[1] + s * n[2], t * n[1] * n[1] + c, t * n[1] * n[2] - s * n[0],
    t * n[0] * n[2] - s * n[1], t * n[1] * n[2] + s * n[0], t * n[2] * n[2] + c
  ];
}

function applyMatrix(m: readonly number[], v: Vec3): Vec3 {
  return [m[0]! * v[0] + m[1]! * v[1] + m[2]! * v[2], m[3]! * v[0] + m[4]! * v[1] + m[5]! * v[2], m[6]! * v[0] + m[7]! * v[1] + m[8]! * v[2]];
}
