/**
 * Mesh-level modify operations on general solid bodies, in pure TypeScript:
 * hole, shell, chamfer and fillet. Each one builds a cutter solid from the
 * input mesh and subtracts it with the existing BSP Boolean, so the only
 * extra assumption is that the input is a closed, consistently oriented
 * manifold (which {@link booleanMeshes} already enforces).
 *
 * The algorithms are deliberately simple: Hole is a cylinder cutter, Shell
 * offsets the body's vertices inward and pushes the "open face" vertices
 * through the body so the Boolean yields a single-component shell, and
 * Chamfer / Fillet detect sharp convex edges between triangles, build a
 * prism (chamfer) or circular-arc solid (fillet) at each one, and chain
 * Boolean cuts. Where the simple algorithm cannot produce a clean closed
 * manifold the Boolean returns a reason, which this module passes back.
 */

import { booleanMeshes, type BooleanMeshInput } from "./mesh-boolean.js";

export interface ModifyMeshInput {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
}

export type ModifyMeshResult =
  | { readonly ok: true; readonly positionsMm: readonly number[]; readonly indices: readonly number[] }
  | { readonly ok: false; readonly message: string };

type Axis = "x" | "y" | "z";
type OpenFace = "+x" | "-x" | "+y" | "-y" | "+z" | "-z";
type V3 = readonly [number, number, number];

export interface HoleOptions {
  readonly diameterMm: number;
  readonly depthMm: number;
  /** Which axis the hole runs along. Default "z". */
  readonly axis?: Axis;
  /** Point on the hole's top face. Default: body centroid XY at the body's maximum along the axis. */
  readonly originMm?: V3;
  readonly segments?: number;
}

export interface CounterboreOptions {
  readonly pilotDiameterMm: number;
  readonly pilotDepthMm: number;
  readonly headDiameterMm: number;
  readonly headDepthMm: number;
  readonly axis?: Axis;
  readonly originMm?: V3;
  readonly segments?: number;
}

export interface CountersinkOptions {
  readonly pilotDiameterMm: number;
  readonly pilotDepthMm: number;
  readonly headDiameterMm: number;
  /** Included angle of the countersink cone (ISO 10642 socket head = 90°). */
  readonly headAngleDeg: number;
  readonly axis?: Axis;
  readonly originMm?: V3;
  readonly segments?: number;
}

export interface TappedHoleOptions {
  /** Nominal fastener diameter (M-size). The tap-drill diameter is 0.85 × nominal for a basic ISO metric thread. */
  readonly nominalDiameterMm: number;
  readonly depthMm: number;
  readonly axis?: Axis;
  readonly originMm?: V3;
  readonly segments?: number;
}

/** ISO-metric clearance + socket-head counterbore dimensions for common sizes (DIN 912 / ISO 4762). */
export interface FastenerSpec {
  readonly nominalDiameterMm: number;
  readonly clearanceDiameterMm: number;
  readonly counterboreDiameterMm: number;
  readonly counterboreDepthMm: number;
  readonly countersinkDiameterMm: number;
}

export const METRIC_FASTENERS: Readonly<Record<string, FastenerSpec>> = {
  M3: { nominalDiameterMm: 3.0, clearanceDiameterMm: 3.4, counterboreDiameterMm: 6.5, counterboreDepthMm: 3.3, countersinkDiameterMm: 6.3 },
  M4: { nominalDiameterMm: 4.0, clearanceDiameterMm: 4.5, counterboreDiameterMm: 8.0, counterboreDepthMm: 4.4, countersinkDiameterMm: 9.4 },
  M5: { nominalDiameterMm: 5.0, clearanceDiameterMm: 5.5, counterboreDiameterMm: 10.0, counterboreDepthMm: 5.4, countersinkDiameterMm: 10.4 },
  M6: { nominalDiameterMm: 6.0, clearanceDiameterMm: 6.6, counterboreDiameterMm: 11.0, counterboreDepthMm: 6.5, countersinkDiameterMm: 12.6 },
  M8: { nominalDiameterMm: 8.0, clearanceDiameterMm: 9.0, counterboreDiameterMm: 15.0, counterboreDepthMm: 8.6, countersinkDiameterMm: 17.3 },
  M10: { nominalDiameterMm: 10.0, clearanceDiameterMm: 11.0, counterboreDiameterMm: 18.0, counterboreDepthMm: 10.8, countersinkDiameterMm: 20.0 }
};

export interface ShellOptions {
  readonly thicknessMm: number;
  /** Which face to leave open. Default "+z". */
  readonly openFace?: OpenFace;
}

export interface EdgeTreatmentOptions {
  readonly sizeMm: number;
  /** A sharp edge is one whose dihedral angle is at most 180° − threshold. Default 5°. */
  readonly angleThresholdDeg?: number;
  /** Fillet tessellation per edge. Default 8. */
  readonly segments?: number;
  /** Treat only the sharp edges that match one of these segments (by end points) instead of every sharp convex edge. */
  readonly onlyEdges?: readonly (readonly [V3, V3])[];
}

/** A straight edge of the mesh a click can land on, tagged with the smooth run (chain) of edges it belongs to. */
export interface PickableEdge {
  readonly a: V3;
  readonly b: V3;
  readonly chain: number;
}

const MAX_SHARP_EDGES = 200;
const DEFAULT_CYLINDER_SEGMENTS = 32;
const DEFAULT_FILLET_SEGMENTS = 8;
const DEFAULT_ANGLE_THRESHOLD_DEG = 5;
const CO_PLANAR_EPS = 1e-6;

// ---------------------------------------------------------------------------------------------
// Hole: cylinder cutter aligned with an axis, Boolean cut from the body.
// ---------------------------------------------------------------------------------------------

export function meshHole(body: ModifyMeshInput, options: HoleOptions): ModifyMeshResult {
  const radius = options.diameterMm / 2;
  const depth = options.depthMm;
  const axis: Axis = options.axis ?? "z";
  const segments = options.segments ?? DEFAULT_CYLINDER_SEGMENTS;
  if (!Number.isFinite(radius) || radius <= 0) return { ok: false, message: "Hole diameter must be a positive length." };
  if (!Number.isFinite(depth) || depth <= 0) return { ok: false, message: "Hole depth must be a positive length." };
  if (!Number.isInteger(segments) || segments < 8 || segments > 128) return { ok: false, message: "Hole tessellation must be between 8 and 128 segments." };

  const origin = options.originMm ?? defaultHoleOrigin(body, axis);
  const cutter = cylinderCutterAbove(radius, depth, origin, axis, segments);
  const result = booleanMeshes(body, cutter, "cut");
  if (!result.ok) return { ok: false, message: `Hole could not be cut: ${result.message}` };
  return { ok: true, positionsMm: result.value.positionsMm, indices: result.value.indices };
}

/**
 * Counterbore: drill a pilot hole all the way through (or to the given depth), then widen the top
 * section to accept a socket cap screw head. Two Boolean cuts in sequence — pilot, then head —
 * so the result stays a single clean manifold.
 */
export function meshCounterbore(body: ModifyMeshInput, options: CounterboreOptions): ModifyMeshResult {
  const pilotRadius = options.pilotDiameterMm / 2;
  const headRadius = options.headDiameterMm / 2;
  if (!(pilotRadius > 0) || !(headRadius > pilotRadius)) return { ok: false, message: "Counterbore: head diameter must be larger than the pilot diameter." };
  if (!(options.pilotDepthMm > 0) || !(options.headDepthMm > 0)) return { ok: false, message: "Counterbore: pilot and head depths must be positive." };
  const axis: Axis = options.axis ?? "z";
  const segments = options.segments ?? DEFAULT_CYLINDER_SEGMENTS;
  const origin = options.originMm ?? defaultHoleOrigin(body, axis);
  const pilotCutter = cylinderCutterAbove(pilotRadius, options.pilotDepthMm, origin, axis, segments);
  const pilotResult = booleanMeshes(body, pilotCutter, "cut");
  if (!pilotResult.ok) return { ok: false, message: `Counterbore pilot cut failed: ${pilotResult.message}` };
  const bored: ModifyMeshInput = { positionsMm: pilotResult.value.positionsMm, indices: pilotResult.value.indices };
  const headCutter = cylinderCutterAbove(headRadius, options.headDepthMm, origin, axis, segments);
  const headResult = booleanMeshes(bored, headCutter, "cut");
  if (!headResult.ok) return { ok: false, message: `Counterbore head cut failed: ${headResult.message}` };
  return { ok: true, positionsMm: headResult.value.positionsMm, indices: headResult.value.indices };
}

/**
 * Countersink: pilot hole + a conical cap at the top sized for an ISO flat-head screw
 * (default 90° included angle).
 */
export function meshCountersink(body: ModifyMeshInput, options: CountersinkOptions): ModifyMeshResult {
  const pilotRadius = options.pilotDiameterMm / 2;
  const headRadius = options.headDiameterMm / 2;
  if (!(pilotRadius > 0) || !(headRadius > pilotRadius)) return { ok: false, message: "Countersink: head diameter must be larger than the pilot diameter." };
  if (!(options.pilotDepthMm > 0)) return { ok: false, message: "Countersink: pilot depth must be positive." };
  if (!(options.headAngleDeg > 1) || !(options.headAngleDeg < 179)) return { ok: false, message: "Countersink: included angle must be between 1° and 179°." };
  const axis: Axis = options.axis ?? "z";
  const segments = options.segments ?? DEFAULT_CYLINDER_SEGMENTS;
  const origin = options.originMm ?? defaultHoleOrigin(body, axis);
  const halfAngle = options.headAngleDeg * Math.PI / 360;
  const sinkDepth = (headRadius - pilotRadius) / Math.tan(halfAngle);
  if (!(sinkDepth > 0)) return { ok: false, message: "Countersink: computed sink depth is not positive." };

  const pilotCutter = cylinderCutterAbove(pilotRadius, options.pilotDepthMm, origin, axis, segments);
  const pilotResult = booleanMeshes(body, pilotCutter, "cut");
  if (!pilotResult.ok) return { ok: false, message: `Countersink pilot cut failed: ${pilotResult.message}` };
  const bored: ModifyMeshInput = { positionsMm: pilotResult.value.positionsMm, indices: pilotResult.value.indices };
  // Cone frustum: narrower face (pilot diameter) at the BOTTOM at depth `sinkDepth`, wider face
  // (head diameter) at the TOP flush with the body surface. `coneCutterAbove` places the wider
  // top face at `origin` + overshoot and the narrower base face at `origin − sinkDepth`.
  const coneCutter = coneCutterAbove(pilotRadius, headRadius, sinkDepth, origin, axis, segments);
  const coneResult = booleanMeshes(bored, coneCutter, "cut");
  if (!coneResult.ok) return { ok: false, message: `Countersink cone cut failed: ${coneResult.message}` };
  return { ok: true, positionsMm: coneResult.value.positionsMm, indices: coneResult.value.indices };
}

/**
 * Tapped (threaded) hole: in V1 we draw it as a tap-drill-diameter cylinder (0.85 × nominal
 * for an ISO basic metric thread) — the thread pitch itself isn't modelled yet. The modifier
 * label carries the tap size so the browser and audit record the engineering intent.
 */
export function meshTappedHole(body: ModifyMeshInput, options: TappedHoleOptions): ModifyMeshResult {
  const nominal = options.nominalDiameterMm;
  if (!(nominal > 0)) return { ok: false, message: "Tapped hole: nominal diameter must be positive." };
  if (!(options.depthMm > 0)) return { ok: false, message: "Tapped hole: depth must be positive." };
  return meshHole(body, { diameterMm: nominal * 0.85, depthMm: options.depthMm, ...(options.axis !== undefined ? { axis: options.axis } : {}), ...(options.originMm !== undefined ? { originMm: options.originMm } : {}), ...(options.segments !== undefined ? { segments: options.segments } : {}) });
}


function buildConeCutter(baseRadius: number, topRadius: number, height: number, center: V3, axis: Axis, segments: number): BooleanMeshInput {
  // Builds a frustum (circular top AND bottom) so the cutter is always a closed manifold.
  const positions: number[] = [];
  const indices: number[] = [];
  const z0 = -height / 2;
  const z1 = height / 2;
  for (let i = 0; i < segments; i += 1) {
    const t = (i / segments) * 2 * Math.PI;
    positions.push(Math.cos(t) * baseRadius, Math.sin(t) * baseRadius, z0);
  }
  for (let i = 0; i < segments; i += 1) {
    const t = (i / segments) * 2 * Math.PI;
    positions.push(Math.cos(t) * topRadius, Math.sin(t) * topRadius, z1);
  }
  const bottomCenter = 2 * segments; positions.push(0, 0, z0);
  const topCenter = 2 * segments + 1; positions.push(0, 0, z1);
  for (let i = 0; i < segments; i += 1) {
    const a = i;
    const b = (i + 1) % segments;
    const c = i + segments;
    const d = (i + 1) % segments + segments;
    indices.push(a, b, d, a, d, c);
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i;
    const b = (i + 1) % segments;
    indices.push(bottomCenter, b, a);
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i + segments;
    const b = (i + 1) % segments + segments;
    indices.push(topCenter, a, b);
  }
  const final = new Array<number>(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!; const y = positions[i + 1]!; const z = positions[i + 2]!;
    if (axis === "x") { final[i] = z + center[0]; final[i + 1] = y + center[1]; final[i + 2] = -x + center[2]; }
    else if (axis === "y") { final[i] = x + center[0]; final[i + 1] = z + center[1]; final[i + 2] = -y + center[2]; }
    else { final[i] = x + center[0]; final[i + 1] = y + center[1]; final[i + 2] = z + center[2]; }
  }
  return { positionsMm: final, indices };
}

/**
 * `originMm` is the point on the TOP face of the hole — where the drill enters the body.
 * `depthMm` is how far the hole extends from there INTO the body along the axis.
 * Cutters extend from (origin − depth) up to (origin + overshoot) so the Boolean cleanly
 * reaches the top face regardless of small numerical drift.
 */
const HOLE_OVERSHOOT_MM = 2;

function cylinderCutterAbove(radius: number, depthMm: number, holeOrigin: V3, axis: Axis, segments: number): BooleanMeshInput {
  const height = depthMm + HOLE_OVERSHOOT_MM;
  const cutterCenter = shiftAlongAxis(holeOrigin, axis, (HOLE_OVERSHOOT_MM - depthMm) / 2);
  return buildCylinderCutter(radius, height, cutterCenter, axis, segments);
}

function coneCutterAbove(baseRadius: number, topRadius: number, depthMm: number, holeOrigin: V3, axis: Axis, segments: number): BooleanMeshInput {
  const height = depthMm + HOLE_OVERSHOOT_MM;
  const cutterCenter = shiftAlongAxis(holeOrigin, axis, (HOLE_OVERSHOOT_MM - depthMm) / 2);
  return buildConeCutter(baseRadius, topRadius, height, cutterCenter, axis, segments);
}

function shiftAlongAxis(point: V3, axis: Axis, delta: number): V3 {
  if (axis === "x") return [point[0] + delta, point[1], point[2]];
  if (axis === "y") return [point[0], point[1] + delta, point[2]];
  return [point[0], point[1], point[2] + delta];
}

function defaultHoleOrigin(body: ModifyMeshInput, axis: Axis): V3 {
  const axisIndex = axis === "x" ? 0 : axis === "y" ? 1 : 2;
  let sumX = 0, sumY = 0, sumZ = 0, count = 0;
  let maxAlong = -Infinity;
  for (let i = 0; i < body.positionsMm.length; i += 3) {
    sumX += body.positionsMm[i]!;
    sumY += body.positionsMm[i + 1]!;
    sumZ += body.positionsMm[i + 2]!;
    count += 1;
    const along = body.positionsMm[i + axisIndex]!;
    if (along > maxAlong) maxAlong = along;
  }
  const centroid: [number, number, number] = [sumX / count, sumY / count, sumZ / count];
  centroid[axisIndex] = maxAlong;
  return [centroid[0], centroid[1], centroid[2]];
}

function buildCylinderCutter(radius: number, height: number, center: V3, axis: Axis, segments: number): BooleanMeshInput {
  const positions: number[] = [];
  const indices: number[] = [];
  const z0 = -height / 2;
  const z1 = height / 2;
  for (let i = 0; i < segments; i += 1) {
    const t = (i / segments) * 2 * Math.PI;
    positions.push(Math.cos(t) * radius, Math.sin(t) * radius, z0);
  }
  for (let i = 0; i < segments; i += 1) {
    const t = (i / segments) * 2 * Math.PI;
    positions.push(Math.cos(t) * radius, Math.sin(t) * radius, z1);
  }
  const bottomCenter = 2 * segments; positions.push(0, 0, z0);
  const topCenter = 2 * segments + 1; positions.push(0, 0, z1);
  for (let i = 0; i < segments; i += 1) {
    const a = i;
    const b = (i + 1) % segments;
    const c = i + segments;
    const d = (i + 1) % segments + segments;
    indices.push(a, b, d, a, d, c);
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i;
    const b = (i + 1) % segments;
    indices.push(bottomCenter, b, a);
  }
  for (let i = 0; i < segments; i += 1) {
    const a = i + segments;
    const b = (i + 1) % segments + segments;
    indices.push(topCenter, a, b);
  }
  const final = new Array<number>(positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]!; const y = positions[i + 1]!; const z = positions[i + 2]!;
    if (axis === "x") { final[i] = z + center[0]; final[i + 1] = y + center[1]; final[i + 2] = -x + center[2]; }
    else if (axis === "y") { final[i] = x + center[0]; final[i + 1] = z + center[1]; final[i + 2] = -y + center[2]; }
    else { final[i] = x + center[0]; final[i + 1] = y + center[1]; final[i + 2] = z + center[2]; }
  }
  return { positionsMm: final, indices };
}

// ---------------------------------------------------------------------------------------------
// Shell: offset vertices inward, push the "open-face" vertices through the body so the Boolean
// produces a connected shell with an opening instead of two nested surfaces.
// ---------------------------------------------------------------------------------------------

export function meshShell(body: ModifyMeshInput, options: ShellOptions): ModifyMeshResult {
  const t = options.thicknessMm;
  if (!Number.isFinite(t) || t <= 0) return { ok: false, message: "Shell thickness must be a positive length." };
  const openFace: OpenFace = options.openFace ?? "+z";
  const openDir: V3 = (openFace === "+x") ? [1, 0, 0] : (openFace === "-x") ? [-1, 0, 0]
    : (openFace === "+y") ? [0, 1, 0] : (openFace === "-y") ? [0, -1, 0]
    : (openFace === "+z") ? [0, 0, 1] : [0, 0, -1];

  const vertexNormals = computeVertexNormals(body);
  const vertexCount = body.positionsMm.length / 3;
  let maxAlongOpen = -Infinity;
  for (let i = 0; i < vertexCount; i += 1) {
    const d = body.positionsMm[i * 3]! * openDir[0] + body.positionsMm[i * 3 + 1]! * openDir[1] + body.positionsMm[i * 3 + 2]! * openDir[2];
    if (d > maxAlongOpen) maxAlongOpen = d;
  }
  const extent = extentAlong(body, openDir);
  if (!(extent > 4 * t)) return { ok: false, message: "The body is too thin along the open-face direction to shell by that thickness; pick a smaller thickness or a different open face." };

  const PUSH = extent * 2 + 10;
  const topVertexEps = Math.max(1e-6, extent * 1e-4);
  const cutterPos = new Array<number>(body.positionsMm.length);
  for (let i = 0; i < vertexCount; i += 1) {
    const px = body.positionsMm[i * 3]!; const py = body.positionsMm[i * 3 + 1]!; const pz = body.positionsMm[i * 3 + 2]!;
    const nx = vertexNormals[i * 3]!; const ny = vertexNormals[i * 3 + 1]!; const nz = vertexNormals[i * 3 + 2]!;
    const alongOpen = px * openDir[0] + py * openDir[1] + pz * openDir[2];
    const normalAlongOpen = nx * openDir[0] + ny * openDir[1] + nz * openDir[2];
    const isTop = Math.abs(alongOpen - maxAlongOpen) < topVertexEps && normalAlongOpen > 0.25;
    if (isTop) {
      // Project the normal onto the plane perpendicular to the open direction; offset only in that plane,
      // and push the vertex along the open direction so the inner pokes above the outer.
      const perpX = nx - normalAlongOpen * openDir[0];
      const perpY = ny - normalAlongOpen * openDir[1];
      const perpZ = nz - normalAlongOpen * openDir[2];
      cutterPos[i * 3] = px - perpX * t + openDir[0] * PUSH;
      cutterPos[i * 3 + 1] = py - perpY * t + openDir[1] * PUSH;
      cutterPos[i * 3 + 2] = pz - perpZ * t + openDir[2] * PUSH;
    } else {
      cutterPos[i * 3] = px - nx * t;
      cutterPos[i * 3 + 1] = py - ny * t;
      cutterPos[i * 3 + 2] = pz - nz * t;
    }
  }
  const cutter: BooleanMeshInput = { positionsMm: cutterPos, indices: Array.from(body.indices) };
  const result = booleanMeshes(body, cutter, "cut");
  if (!result.ok) return { ok: false, message: `Shell could not be cut: ${result.message}` };
  return { ok: true, positionsMm: result.value.positionsMm, indices: result.value.indices };
}

function extentAlong(body: ModifyMeshInput, dir: V3): number {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (let i = 0; i < body.positionsMm.length; i += 3) {
    const d = body.positionsMm[i]! * dir[0] + body.positionsMm[i + 1]! * dir[1] + body.positionsMm[i + 2]! * dir[2];
    if (d < minimum) minimum = d;
    if (d > maximum) maximum = d;
  }
  return maximum - minimum;
}

function computeVertexNormals(body: ModifyMeshInput): number[] {
  const vertexCount = body.positionsMm.length / 3;
  const normals = new Array<number>(vertexCount * 3).fill(0);
  for (let i = 0; i < body.indices.length; i += 3) {
    const ia = body.indices[i]!; const ib = body.indices[i + 1]!; const ic = body.indices[i + 2]!;
    const ax = body.positionsMm[ia * 3]!; const ay = body.positionsMm[ia * 3 + 1]!; const az = body.positionsMm[ia * 3 + 2]!;
    const bx = body.positionsMm[ib * 3]!; const by = body.positionsMm[ib * 3 + 1]!; const bz = body.positionsMm[ib * 3 + 2]!;
    const cx = body.positionsMm[ic * 3]!; const cy = body.positionsMm[ic * 3 + 1]!; const cz = body.positionsMm[ic * 3 + 2]!;
    const ux = bx - ax; const uy = by - ay; const uz = bz - az;
    const vx = cx - ax; const vy = cy - ay; const vz = cz - az;
    const nx = uy * vz - uz * vy; const ny = uz * vx - ux * vz; const nz = ux * vy - uy * vx;
    for (const idx of [ia, ib, ic]) {
      normals[idx * 3] = normals[idx * 3]! + nx;
      normals[idx * 3 + 1] = normals[idx * 3 + 1]! + ny;
      normals[idx * 3 + 2] = normals[idx * 3 + 2]! + nz;
    }
  }
  for (let i = 0; i < vertexCount; i += 1) {
    const nx = normals[i * 3]!; const ny = normals[i * 3 + 1]!; const nz = normals[i * 3 + 2]!;
    const length = Math.hypot(nx, ny, nz);
    if (length > 1e-12) { normals[i * 3] = nx / length; normals[i * 3 + 1] = ny / length; normals[i * 3 + 2] = nz / length; }
  }
  return normals;
}

// ---------------------------------------------------------------------------------------------
// Sharp-edge detection: find pairs of triangles that share an edge whose dihedral angle is
// convex and below (180° − threshold), with welded vertex positions.
// ---------------------------------------------------------------------------------------------

interface SharpEdge {
  readonly aIdx: number;
  readonly bIdx: number;
  readonly a: V3;
  readonly b: V3;
  readonly n1: V3;
  readonly n2: V3;
}

function detectSharpConvexEdges(body: ModifyMeshInput, angleThresholdDeg: number): readonly SharpEdge[] | string {
  const vertexCount = body.positionsMm.length / 3;
  const weldedIndex = new Array<number>(vertexCount);
  const weldKey = new Map<string, number>();
  const WELD = 1e-5;
  let weldCount = 0;
  for (let i = 0; i < vertexCount; i += 1) {
    const x = body.positionsMm[i * 3]!; const y = body.positionsMm[i * 3 + 1]!; const z = body.positionsMm[i * 3 + 2]!;
    const key = `${Math.round(x / WELD)},${Math.round(y / WELD)},${Math.round(z / WELD)}`;
    let id = weldKey.get(key);
    if (id === undefined) { id = weldCount; weldKey.set(key, weldCount); weldCount += 1; }
    weldedIndex[i] = id;
  }
  const triangles = body.indices.length / 3;
  const triNormals: V3[] = [];
  for (let i = 0; i < triangles; i += 1) {
    const ia = weldedIndex[body.indices[i * 3]!]!;
    const ib = weldedIndex[body.indices[i * 3 + 1]!]!;
    const ic = weldedIndex[body.indices[i * 3 + 2]!]!;
    const ax = body.positionsMm[body.indices[i * 3]! * 3]!;
    const ay = body.positionsMm[body.indices[i * 3]! * 3 + 1]!;
    const az = body.positionsMm[body.indices[i * 3]! * 3 + 2]!;
    const bx = body.positionsMm[body.indices[i * 3 + 1]! * 3]!;
    const by = body.positionsMm[body.indices[i * 3 + 1]! * 3 + 1]!;
    const bz = body.positionsMm[body.indices[i * 3 + 1]! * 3 + 2]!;
    const cx = body.positionsMm[body.indices[i * 3 + 2]! * 3]!;
    const cy = body.positionsMm[body.indices[i * 3 + 2]! * 3 + 1]!;
    const cz = body.positionsMm[body.indices[i * 3 + 2]! * 3 + 2]!;
    const nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    const nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-12) { triNormals.push([0, 0, 0]); continue; }
    triNormals.push([nx / length, ny / length, nz / length]);
    void ia; void ib; void ic;
  }
  const edgeToTri = new Map<string, number[]>();
  for (let t = 0; t < triangles; t += 1) {
    const a = weldedIndex[body.indices[t * 3]!]!;
    const b = weldedIndex[body.indices[t * 3 + 1]!]!;
    const c = weldedIndex[body.indices[t * 3 + 2]!]!;
    for (const [from, to] of [[a, b], [b, c], [c, a]] as const) {
      const key = from < to ? `${from},${to}` : `${to},${from}`;
      let bucket = edgeToTri.get(key);
      if (bucket === undefined) { bucket = []; edgeToTri.set(key, bucket); }
      bucket.push(t);
    }
  }

  // A sharp edge is one where the two face normals bend by more than the threshold: cos(angle) < cos(threshold).
  const threshold = Math.cos(angleThresholdDeg * Math.PI / 180);
  const sharpSet = new Map<string, SharpEdge>();
  for (const [key, bucket] of edgeToTri) {
    if (bucket.length !== 2) continue;
    const [t1, t2] = bucket as [number, number];
    const n1 = triNormals[t1]!;
    const n2 = triNormals[t2]!;
    const d = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
    if (d >= threshold) continue; // Nearly coplanar, not a sharp edge.
    const [aStr, bStr] = key.split(",");
    const weldA = Number.parseInt(aStr!, 10);
    const weldB = Number.parseInt(bStr!, 10);
    const { ax, ay, az, bx, by, bz } = findEdgePositions(body, weldedIndex, weldA, weldB);
    const ex = bx - ax; const ey = by - ay; const ez = bz - az;
    const crossX = n1[1] * n2[2] - n1[2] * n2[1];
    const crossY = n1[2] * n2[0] - n1[0] * n2[2];
    const crossZ = n1[0] * n2[1] - n1[1] * n2[0];
    // The edge must be read in the direction the first triangle winds along it, or the sign says nothing about convexity.
    const first = [weldedIndex[body.indices[t1 * 3]!]!, weldedIndex[body.indices[t1 * 3 + 1]!]!, weldedIndex[body.indices[t1 * 3 + 2]!]!] as const;
    const forward = (first[0] === weldA && first[1] === weldB) || (first[1] === weldA && first[2] === weldB) || (first[2] === weldA && first[0] === weldB);
    const convex = (forward ? 1 : -1) * (crossX * ex + crossY * ey + crossZ * ez);
    if (convex <= 0) continue; // Concave or indeterminate.
    sharpSet.set(key, { aIdx: weldA, bIdx: weldB, a: [ax, ay, az], b: [bx, by, bz], n1, n2 });
    if (sharpSet.size > MAX_SHARP_EDGES) return `Too many sharp edges (${sharpSet.size}+); simplify the body before treating its edges.`;
  }
  return Array.from(sharpSet.values());
}

function findEdgePositions(body: ModifyMeshInput, weldedIndex: readonly number[], weldA: number, weldB: number): { ax: number; ay: number; az: number; bx: number; by: number; bz: number } {
  let ia = -1; let ib = -1;
  for (let i = 0; i < weldedIndex.length; i += 1) {
    if (ia < 0 && weldedIndex[i] === weldA) ia = i;
    if (ib < 0 && weldedIndex[i] === weldB) ib = i;
    if (ia >= 0 && ib >= 0) break;
  }
  return {
    ax: body.positionsMm[ia * 3]!, ay: body.positionsMm[ia * 3 + 1]!, az: body.positionsMm[ia * 3 + 2]!,
    bx: body.positionsMm[ib * 3]!, by: body.positionsMm[ib * 3 + 1]!, bz: body.positionsMm[ib * 3 + 2]!
  };
}

// ---------------------------------------------------------------------------------------------
// Edge picking: every sharp convex edge of a body can be picked by a click. Edges that meet end to
// end where nothing else joins them and that hardly turn (the segments of a round rim) form one
// chain, so picking one segment of a circle picks the whole circle.
// ---------------------------------------------------------------------------------------------

/** Two straight edges continue each other when the line turns by no more than this where they meet. */
const CHAIN_TURN_LIMIT_DEG = 35;
/** An edge that bends the surface by less than this is a facet seam, not a pickable edge. */
const PICK_MIN_BEND_DEG = 20;

/** The sharp convex edges of a body as pickable segments, grouped into chains; a message when the body has too many. */
export function pickableEdges(body: ModifyMeshInput, angleThresholdDeg: number = DEFAULT_ANGLE_THRESHOLD_DEG): readonly PickableEdge[] | string {
  const detected = detectSharpConvexEdges(body, angleThresholdDeg);
  if (typeof detected === "string") return detected;
  // The seams between the facets of a round face bend only a few degrees; they are not edges anyone means to pick.
  const seamCos = Math.cos(PICK_MIN_BEND_DEG * Math.PI / 180);
  const sharp = detected.filter((edge) => edge.n1[0] * edge.n2[0] + edge.n1[1] * edge.n2[1] + edge.n1[2] * edge.n2[2] <= seamCos);
  const parent = sharp.map((_, index) => index);
  const find = (index: number): number => { let root = index; while (parent[root] !== root) root = parent[root]!; return root; };
  const atVertex = new Map<number, number[]>();
  sharp.forEach((edge, index) => {
    for (const vertex of [edge.aIdx, edge.bIdx]) {
      const bucket = atVertex.get(vertex);
      if (bucket === undefined) atVertex.set(vertex, [index]); else bucket.push(index);
    }
  });
  const cosLimit = Math.cos(CHAIN_TURN_LIMIT_DEG * Math.PI / 180);
  const direction = (edge: SharpEdge): V3 => normalize(sub(edge.b, edge.a)) ?? [0, 0, 0];
  for (const bucket of atVertex.values()) {
    if (bucket.length !== 2) continue;
    const [first, second] = bucket as [number, number];
    const d1 = direction(sharp[first]!);
    const d2 = direction(sharp[second]!);
    if (Math.abs(d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) >= cosLimit) parent[find(first)] = find(second);
  }
  const chainIds = new Map<number, number>();
  return sharp.map((edge, index) => {
    const root = find(index);
    let chain = chainIds.get(root);
    if (chain === undefined) { chain = chainIds.size; chainIds.set(root, chain); }
    return { a: edge.a, b: edge.b, chain };
  });
}

function distanceToSegmentMm(point: V3, a: V3, b: V3): number {
  const ab = sub(b, a);
  const lengthSquared = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  const ap = sub(point, a);
  const t = lengthSquared < 1e-18 ? 0 : Math.max(0, Math.min(1, (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / lengthSquared));
  return Math.hypot(point[0] - (a[0] + ab[0] * t), point[1] - (a[1] + ab[1] * t), point[2] - (a[2] + ab[2] * t));
}

/** The pickable edge closest to a clicked point, with the whole chain it belongs to. */
export function nearestPickableEdge(edges: readonly PickableEdge[], point: V3): { readonly edge: PickableEdge; readonly distanceMm: number; readonly chain: readonly PickableEdge[] } | undefined {
  let best: PickableEdge | undefined;
  let bestDistance = Infinity;
  for (const edge of edges) {
    const distance = distanceToSegmentMm(point, edge.a, edge.b);
    if (distance < bestDistance) { best = edge; bestDistance = distance; }
  }
  if (best === undefined) return undefined;
  const chain = best.chain;
  return { edge: best, distanceMm: bestDistance, chain: edges.filter((edge) => edge.chain === chain) };
}

/** The sharp edges a treatment applies to: all of them, or only those matching the picked segments. */
function chosenEdges(sharp: readonly SharpEdge[], only: EdgeTreatmentOptions["onlyEdges"]): readonly SharpEdge[] {
  if (only === undefined) return sharp;
  const TOL = 1e-4;
  const same = (p: V3, q: V3): boolean => Math.abs(p[0] - q[0]) < TOL && Math.abs(p[1] - q[1]) < TOL && Math.abs(p[2] - q[2]) < TOL;
  return sharp.filter((edge) => only.some(([a, b]) => (same(edge.a, a) && same(edge.b, b)) || (same(edge.a, b) && same(edge.b, a))));
}

// ---------------------------------------------------------------------------------------------
// Chamfer: for each sharp convex edge, build a triangular prism cutter that removes the corner
// material, chaining Boolean cuts.
// ---------------------------------------------------------------------------------------------

export function meshChamfer(body: ModifyMeshInput, options: EdgeTreatmentOptions): ModifyMeshResult {
  const size = options.sizeMm;
  if (!Number.isFinite(size) || size <= 0) return { ok: false, message: "Chamfer distance must be a positive length." };
  const angleThreshold = options.angleThresholdDeg ?? DEFAULT_ANGLE_THRESHOLD_DEG;
  const found = detectSharpConvexEdges(body, angleThreshold);
  if (typeof found === "string") return { ok: false, message: found };
  const sharp = chosenEdges(found, options.onlyEdges);
  if (sharp.length === 0) return { ok: false, message: options.onlyEdges === undefined ? "No sharp convex edges were found on this body, so there is nothing to chamfer." : "The picked edge is not a sharp convex edge of this body, so there is nothing to chamfer." };

  let current: BooleanMeshInput = { positionsMm: Array.from(body.positionsMm), indices: Array.from(body.indices) };
  let applied = 0;
  for (const edge of sharp) {
    const cutter = buildEdgeChamferCutter(edge, size);
    if (cutter === undefined) continue;
    const step = booleanMeshes(current, cutter, "cut");
    if (!step.ok) continue; // Skip edges where the Boolean refuses (e.g., size too big for the body).
    current = { positionsMm: Array.from(step.value.positionsMm), indices: Array.from(step.value.indices) };
    applied += 1;
  }
  if (applied === 0) return { ok: false, message: "Every chamfer cut was rejected; try a smaller distance." };
  return { ok: true, positionsMm: current.positionsMm, indices: current.indices };
}

function buildEdgeChamferCutter(edge: SharpEdge, size: number): BooleanMeshInput | undefined {
  const inward = inwardTangents(edge);
  if (inward === undefined) return undefined;
  const { t1, t2 } = inward;
  const EXT = size * 0.05 + 0.01;
  const edgeLength = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1], edge.b[2] - edge.a[2]);
  if (edgeLength < 1e-6) return undefined;
  const e: V3 = [(edge.b[0] - edge.a[0]) / edgeLength, (edge.b[1] - edge.a[1]) / edgeLength, (edge.b[2] - edge.a[2]) / edgeLength];
  const extA: V3 = [edge.a[0] - e[0] * EXT, edge.a[1] - e[1] * EXT, edge.a[2] - e[2] * EXT];
  const extB: V3 = [edge.b[0] + e[0] * EXT, edge.b[1] + e[1] * EXT, edge.b[2] + e[2] * EXT];
  const v0a = extA;
  const v0b = extB;
  const v1a: V3 = [extA[0] + t1[0] * size, extA[1] + t1[1] * size, extA[2] + t1[2] * size];
  const v1b: V3 = [extB[0] + t1[0] * size, extB[1] + t1[1] * size, extB[2] + t1[2] * size];
  const v2a: V3 = [extA[0] + t2[0] * size, extA[1] + t2[1] * size, extA[2] + t2[2] * size];
  const v2b: V3 = [extB[0] + t2[0] * size, extB[1] + t2[1] * size, extB[2] + t2[2] * size];
  // Triangular prism: 6 vertices, 2 triangle caps and 3 quad sides (6 side triangles).
  const pos = [v0a, v1a, v2a, v0b, v1b, v2b].flatMap((v) => [v[0], v[1], v[2]]);
  // Order of corners CCW on the a-end seen from -e: v0a, v1a, v2a — orientation depends on t1, t2 handedness.
  // To guarantee outward normals, compute the a-cap normal and reorder if needed.
  const capNormal = cross(sub(v1a, v0a), sub(v2a, v0a));
  const capAlongEdge = capNormal[0] * (-e[0]) + capNormal[1] * (-e[1]) + capNormal[2] * (-e[2]);
  const flip = capAlongEdge < 0;
  // When flip is true, we reverse winding to make cap-a point along -e.
  const tri = (a: number, b: number, c: number): readonly number[] => flip ? [a, c, b] : [a, b, c];
  const indices: number[] = [
    ...tri(0, 1, 2),
    ...tri(3, 5, 4),
    ...tri(0, 3, 4), ...tri(0, 4, 1),
    ...tri(1, 4, 5), ...tri(1, 5, 2),
    ...tri(2, 5, 3), ...tri(2, 3, 0)
  ];
  return { positionsMm: pos, indices };
}

function inwardTangents(edge: SharpEdge): { readonly t1: V3; readonly t2: V3 } | undefined {
  const edgeLength = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1], edge.b[2] - edge.a[2]);
  if (edgeLength < 1e-6) return undefined;
  const e: V3 = [(edge.b[0] - edge.a[0]) / edgeLength, (edge.b[1] - edge.a[1]) / edgeLength, (edge.b[2] - edge.a[2]) / edgeLength];
  // t1 is perpendicular to e, lies in face 1 (perpendicular to n1), and points away from face 2 (into the body from face 1 side).
  const t1 = pickInwardTangent(edge.n1, e, edge.n2);
  const t2 = pickInwardTangent(edge.n2, e, edge.n1);
  if (t1 === undefined || t2 === undefined) return undefined;
  return { t1, t2 };
}

function pickInwardTangent(faceNormal: V3, edge: V3, otherFaceNormal: V3): V3 | undefined {
  const candidate = normalize(cross(faceNormal, edge));
  if (candidate === undefined) return undefined;
  const sign = candidate[0] * otherFaceNormal[0] + candidate[1] * otherFaceNormal[1] + candidate[2] * otherFaceNormal[2];
  return sign > 0 ? [-candidate[0], -candidate[1], -candidate[2]] : candidate;
}

// ---------------------------------------------------------------------------------------------
// Fillet: for each sharp convex edge, build a solid that represents "the material between the
// edge and the rolling-ball fillet", a prism whose cross-section is a chord (a half-moon
// capped by the two face planes at distance r from the edge and a circular arc on the
// opposite side). Subtracting it leaves a quarter-cylinder tangent to both faces.
// ---------------------------------------------------------------------------------------------

export function meshFillet(body: ModifyMeshInput, options: EdgeTreatmentOptions): ModifyMeshResult {
  const radius = options.sizeMm;
  if (!Number.isFinite(radius) || radius <= 0) return { ok: false, message: "Fillet radius must be a positive length." };
  const angleThreshold = options.angleThresholdDeg ?? DEFAULT_ANGLE_THRESHOLD_DEG;
  const segments = options.segments ?? DEFAULT_FILLET_SEGMENTS;
  if (!Number.isInteger(segments) || segments < 3 || segments > 48) return { ok: false, message: "Fillet tessellation must be between 3 and 48 segments." };
  const found = detectSharpConvexEdges(body, angleThreshold);
  if (typeof found === "string") return { ok: false, message: found };
  const sharp = chosenEdges(found, options.onlyEdges);
  if (sharp.length === 0) return { ok: false, message: options.onlyEdges === undefined ? "No sharp convex edges were found on this body, so there is nothing to fillet." : "The picked edge is not a sharp convex edge of this body, so there is nothing to fillet." };

  let current: BooleanMeshInput = { positionsMm: Array.from(body.positionsMm), indices: Array.from(body.indices) };
  let applied = 0;
  for (const edge of sharp) {
    const cutter = buildEdgeFilletCutter(edge, radius, segments);
    if (cutter === undefined) continue;
    const step = booleanMeshes(current, cutter, "cut");
    if (!step.ok) continue;
    current = { positionsMm: Array.from(step.value.positionsMm), indices: Array.from(step.value.indices) };
    applied += 1;
  }
  if (applied === 0) return { ok: false, message: "Every fillet cut was rejected; try a smaller radius." };
  return { ok: true, positionsMm: current.positionsMm, indices: current.indices };
}

function buildEdgeFilletCutter(edge: SharpEdge, radius: number, segments: number): BooleanMeshInput | undefined {
  const inward = inwardTangents(edge);
  if (inward === undefined) return undefined;
  const { t1, t2 } = inward;
  // Dihedral: the angle between (-t1) and (-t2) through the body's interior, so the edge-to-centre vector
  // of the rolling ball is the bisector of t1 and t2.
  const bisX = t1[0] + t2[0]; const bisY = t1[1] + t2[1]; const bisZ = t1[2] + t2[2];
  const bisLen = Math.hypot(bisX, bisY, bisZ);
  if (bisLen < 1e-6) return undefined;
  const bisector: V3 = [bisX / bisLen, bisY / bisLen, bisZ / bisLen];
  const cosHalf = (t1[0] * bisector[0] + t1[1] * bisector[1] + t1[2] * bisector[2]);
  const sinHalf = Math.sqrt(Math.max(0, 1 - cosHalf * cosHalf));
  if (sinHalf < 1e-4) return undefined;
  // The rolling-ball centre on each cross-section: move along the bisector by radius / sinHalf.
  const centerOffset = radius / sinHalf;
  const edgeLength = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1], edge.b[2] - edge.a[2]);
  const e: V3 = [(edge.b[0] - edge.a[0]) / edgeLength, (edge.b[1] - edge.a[1]) / edgeLength, (edge.b[2] - edge.a[2]) / edgeLength];
  const EXT = radius * 0.05 + 0.01;
  const extA: V3 = [edge.a[0] - e[0] * EXT, edge.a[1] - e[1] * EXT, edge.a[2] - e[2] * EXT];
  const extB: V3 = [edge.b[0] + e[0] * EXT, edge.b[1] + e[1] * EXT, edge.b[2] + e[2] * EXT];

  // Cross-section vertices (in the plane perpendicular to the edge):
  //   P_edge: the extended edge point
  //   P_face1: edge + t1 * (radius / tan(halfDihedral)) — point of tangency on face 1
  //   P_face2: edge + t2 * (radius / tan(halfDihedral))
  //   Arc between P_face1 and P_face2, centred at (edge + bisector * centerOffset), radius `radius`.
  const tanHalfComp = cosHalf / sinHalf;
  const tangentDistance = radius * tanHalfComp;
  const pFace1Offset: V3 = [t1[0] * tangentDistance, t1[1] * tangentDistance, t1[2] * tangentDistance];
  const pFace2Offset: V3 = [t2[0] * tangentDistance, t2[1] * tangentDistance, t2[2] * tangentDistance];
  const centerOffsetVec: V3 = [bisector[0] * centerOffset, bisector[1] * centerOffset, bisector[2] * centerOffset];

  // Build the cross-section ring in the plane perpendicular to `e`:
  //   Start at P_edge, go to P_face1, then along the arc to P_face2, close back to P_edge.
  // We want a ring of vertices starting at P_edge (one), then P_face1, arc samples (segments-1 inside), P_face2.
  const ringOffsets: V3[] = [];
  ringOffsets.push([0, 0, 0]); // P_edge
  ringOffsets.push(pFace1Offset);
  // Arc: we rotate P_face1 around the ring centre until it reaches P_face2, parameterising the signed angle.
  const u1: V3 = [pFace1Offset[0] - centerOffsetVec[0], pFace1Offset[1] - centerOffsetVec[1], pFace1Offset[2] - centerOffsetVec[2]];
  const u2: V3 = [pFace2Offset[0] - centerOffsetVec[0], pFace2Offset[1] - centerOffsetVec[1], pFace2Offset[2] - centerOffsetVec[2]];
  const u1Len = Math.hypot(u1[0], u1[1], u1[2]);
  const u2Len = Math.hypot(u2[0], u2[1], u2[2]);
  if (u1Len < 1e-6 || u2Len < 1e-6) return undefined;
  const u1n: V3 = [u1[0] / u1Len, u1[1] / u1Len, u1[2] / u1Len];
  const u2n: V3 = [u2[0] / u2Len, u2[1] / u2Len, u2[2] / u2Len];
  const dot12 = u1n[0] * u2n[0] + u1n[1] * u2n[1] + u1n[2] * u2n[2];
  const theta = Math.acos(Math.max(-1, Math.min(1, dot12)));
  // Cross axis is the edge direction (or its opposite); pick whichever makes u1 rotate toward u2 through the interior.
  const checkCross = cross(u1n, u2n);
  const sign = checkCross[0] * e[0] + checkCross[1] * e[1] + checkCross[2] * e[2];
  const axis: V3 = sign >= 0 ? e : [-e[0], -e[1], -e[2]];
  for (let s = 1; s < segments; s += 1) {
    const alpha = (s / segments) * theta;
    const rotated = rotateAround(u1n, axis, alpha);
    const point: V3 = [centerOffsetVec[0] + rotated[0] * radius, centerOffsetVec[1] + rotated[1] * radius, centerOffsetVec[2] + rotated[2] * radius];
    ringOffsets.push(point);
  }
  ringOffsets.push(pFace2Offset);

  const ringCount = ringOffsets.length;
  const positions: number[] = [];
  for (const offset of ringOffsets) positions.push(extA[0] + offset[0], extA[1] + offset[1], extA[2] + offset[2]);
  for (const offset of ringOffsets) positions.push(extB[0] + offset[0], extB[1] + offset[1], extB[2] + offset[2]);

  // Build the indices. The a-cap is a fan from ring[0] (the edge point); the b-cap is also a fan but reversed.
  const indices: number[] = [];
  const faceNormalSample = cross(sub([positions[3]!, positions[4]!, positions[5]!], [positions[0]!, positions[1]!, positions[2]!]), sub([positions[6]!, positions[7]!, positions[8]!], [positions[0]!, positions[1]!, positions[2]!]));
  const capDotEdge = faceNormalSample[0] * (-e[0]) + faceNormalSample[1] * (-e[1]) + faceNormalSample[2] * (-e[2]);
  const flip = capDotEdge < 0;
  const tri = (a: number, b: number, c: number): readonly number[] => flip ? [a, c, b] : [a, b, c];
  // Cap at a: triangles (0, i, i+1) for i in 1..ringCount-2
  for (let i = 1; i < ringCount - 1; i += 1) indices.push(...tri(0, i, i + 1));
  // Cap at b: the same ring offset by ringCount, with reversed winding
  const b0 = ringCount;
  for (let i = 1; i < ringCount - 1; i += 1) indices.push(...tri(b0, b0 + i + 1, b0 + i));
  // Side quads: wind each quad so the shared edge with the a-cap is reversed, closing the manifold.
  for (let i = 0; i < ringCount; i += 1) {
    const j = (i + 1) % ringCount;
    const ai = i;
    const aj = j;
    const bi = ringCount + i;
    const bj = ringCount + j;
    indices.push(...tri(aj, ai, bi));
    indices.push(...tri(aj, bi, bj));
  }
  return { positionsMm: positions, indices };
}

// ---------------------------------------------------------------------------------------------
// Small V3 helpers
// ---------------------------------------------------------------------------------------------

function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function sub(a: V3, b: V3): V3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function normalize(v: V3): V3 | undefined {
  const length = Math.hypot(v[0], v[1], v[2]);
  if (length < CO_PLANAR_EPS) return undefined;
  return [v[0] / length, v[1] / length, v[2] / length];
}

function rotateAround(v: V3, axis: V3, angle: number): V3 {
  // Rodrigues' rotation formula; axis is assumed to be a unit vector.
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const dot = v[0] * axis[0] + v[1] * axis[1] + v[2] * axis[2];
  const crossP = cross(axis, v);
  return [
    v[0] * cosA + crossP[0] * sinA + axis[0] * dot * (1 - cosA),
    v[1] * cosA + crossP[1] * sinA + axis[1] * dot * (1 - cosA),
    v[2] * cosA + crossP[2] * sinA + axis[2] * dot * (1 - cosA)
  ];
}
