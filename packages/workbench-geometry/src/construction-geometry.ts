/**
 * Pure evaluation of a {@link ConstructionPlane} down to an oriented frame
 * (origin, outward normal, two in-plane axes) and a nominal rendering size.
 * No persistent-topology state is kept: each call recomputes from the plane's
 * definition. Used by {@link buildPartPreview} to draw the translucent quad
 * and by the browser tree / inspector to describe the plane.
 */

import type { ConstructionPlane, ConstructionPlaneDefinition, SketchDatumPlane, Vec3 } from "../../workbench-core/src/index.js";

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

export function evaluateConstructionPlane(plane: ConstructionPlane): ConstructionPlaneFrame | { readonly error: string } {
  return evaluateConstructionPlaneDefinition(plane.definition);
}

export function evaluateConstructionPlaneDefinition(definition: ConstructionPlaneDefinition): ConstructionPlaneFrame | { readonly error: string } {
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
  // midplane: halfway between two offsets of the same base plane
  const base = DATUM_FRAMES[definition.basePlane];
  const mid = (definition.fromMm + definition.toMm) / 2;
  const origin: Vec3 = [base.normal[0] * mid, base.normal[1] * mid, base.normal[2] * mid];
  return { origin, normal: base.normal, uAxis: base.uAxis, vAxis: base.vAxis, sizeMm: [DEFAULT_HALF_SIZE_MM, DEFAULT_HALF_SIZE_MM], description: `Midplane between ${definition.fromMm.toFixed(2)} and ${definition.toMm.toFixed(2)} mm of ${base.label}` };
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
