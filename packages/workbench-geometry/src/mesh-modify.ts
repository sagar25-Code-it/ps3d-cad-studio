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
  /** Optional face index per triangle. Edge treatments carry it through, so the faces a body already has keep their names. */
  readonly faceTriangles?: readonly number[];
}

export type ModifyMeshResult =
  | {
    readonly ok: true;
    readonly positionsMm: readonly number[];
    readonly indices: readonly number[];
    /** Edge treatments only, and only when the input had face indices: the face index of every result triangle. */
    readonly faceTriangles?: readonly number[];
    /** The face index the treatment's own surfaces (fillet, chamfer or filler faces) were given. */
    readonly newFaceIndex?: number;
    /** How many edge segments were treated and how many were skipped because their cut was rejected. */
    readonly treatedSegments?: number;
    readonly skippedSegments?: number;
  }
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
  /**
   * Treat only the sharp edges that lie on one of these segments instead of every sharp convex edge. The segments are read as
   * one run in the order and direction given, which is what a variable radius is spread along.
   */
  readonly onlyEdges?: readonly (readonly [V3, V3])[];
  /** Treat inside (concave) corners, adding material with a filler solid, instead of outside ones. */
  readonly concave?: boolean;
  /** Fillet only: the radius at the end of the picked run, which makes the radius vary evenly from `sizeMm` at its start. */
  readonly endSizeMm?: number;
  /** Chamfer only: the distance along the second face (the first face gets `sizeMm`). Cannot be combined with `angleDeg`. */
  readonly secondSizeMm?: number;
  /** Chamfer only: the angle the chamfer makes with the first face, with `sizeMm` along that face. */
  readonly angleDeg?: number;
  /** Chamfer only: give `sizeMm` to the second face instead of the first. */
  readonly flip?: boolean;
  /** Give up on the whole treatment when any picked segment is rejected, instead of skipping it. */
  readonly strict?: boolean;
  /** The face index to give the treatment's own surfaces when the input carries face indices. Default: one past the largest. */
  readonly newFaceIndex?: number;
}

/** A straight edge of the mesh a click can land on, tagged with the smooth run (chain) of edges it belongs to. */
export interface PickableEdge {
  readonly a: V3;
  readonly b: V3;
  readonly chain: number;
  /** An inside corner (only offered when asked for). */
  readonly concave?: boolean;
  /** The two triangles of the mesh on either side of the edge. */
  readonly triangles?: readonly [number, number];
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
// convex (or concave) and below (180° − threshold), with welded vertex positions.
// ---------------------------------------------------------------------------------------------

type EdgeSide = "convex" | "concave" | "both";

interface SharpEdge {
  readonly aIdx: number;
  readonly bIdx: number;
  readonly a: V3;
  readonly b: V3;
  /** Outward normals of the two faces. The first is the face that points more toward +Z, then +Y, then +X, so "first face" means the same thing after the body is rebuilt. */
  readonly n1: V3;
  readonly n2: V3;
  /** The triangles on each side, in the same order as the normals. */
  readonly triangles: readonly [number, number];
  /** An inside corner: the material wraps round the edge, so treating it adds material instead of removing it. */
  readonly concave: boolean;
}

/** The first of two faces: the one that points more toward +Z, then +Y, then +X. */
function leadsFirst(n1: V3, n2: V3): boolean {
  for (const axis of [2, 1, 0] as const) {
    const difference = n1[axis] - n2[axis];
    if (Math.abs(difference) > 1e-6) return difference > 0;
  }
  return true;
}

function detectSharpEdges(body: ModifyMeshInput, angleThresholdDeg: number, side: EdgeSide, limit: number = MAX_SHARP_EDGES): readonly SharpEdge[] | string {
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
  }
  const edgeToTri = new Map<string, number[]>();
  const positionOfWeld = new Map<number, number>();
  for (let i = 0; i < vertexCount; i += 1) if (!positionOfWeld.has(weldedIndex[i]!)) positionOfWeld.set(weldedIndex[i]!, i);
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
    const ia = positionOfWeld.get(weldA)!;
    const ib = positionOfWeld.get(weldB)!;
    const ax = body.positionsMm[ia * 3]!; const ay = body.positionsMm[ia * 3 + 1]!; const az = body.positionsMm[ia * 3 + 2]!;
    const bx = body.positionsMm[ib * 3]!; const by = body.positionsMm[ib * 3 + 1]!; const bz = body.positionsMm[ib * 3 + 2]!;
    const ex = bx - ax; const ey = by - ay; const ez = bz - az;
    const crossX = n1[1] * n2[2] - n1[2] * n2[1];
    const crossY = n1[2] * n2[0] - n1[0] * n2[2];
    const crossZ = n1[0] * n2[1] - n1[1] * n2[0];
    // The edge must be read in the direction the first triangle winds along it, or the sign says nothing about convexity.
    const first = [weldedIndex[body.indices[t1 * 3]!]!, weldedIndex[body.indices[t1 * 3 + 1]!]!, weldedIndex[body.indices[t1 * 3 + 2]!]!] as const;
    const forward = (first[0] === weldA && first[1] === weldB) || (first[1] === weldA && first[2] === weldB) || (first[2] === weldA && first[0] === weldB);
    const turn = (forward ? 1 : -1) * (crossX * ex + crossY * ey + crossZ * ez);
    if (Math.abs(turn) < 1e-12) continue; // Indeterminate.
    const concave = turn < 0;
    if (concave ? side === "convex" : side === "concave") continue;
    const swap = !leadsFirst(n1, n2);
    sharpSet.set(key, {
      aIdx: weldA, bIdx: weldB, a: [ax, ay, az], b: [bx, by, bz],
      n1: swap ? n2 : n1, n2: swap ? n1 : n2, triangles: swap ? [t2, t1] : [t1, t2], concave
    });
    if (sharpSet.size > limit) return `Too many sharp edges (${sharpSet.size}+); simplify the body before treating its edges.`;
  }
  return Array.from(sharpSet.values());
}

// ---------------------------------------------------------------------------------------------
// Edge picking: every sharp edge of a body can be picked by a click. Edges that meet end to
// end where nothing else joins them and that hardly turn (the segments of a round rim) form one
// chain, so picking one segment of a circle picks the whole circle.
// ---------------------------------------------------------------------------------------------

/** Two straight edges continue each other when the line turns by no more than this where they meet. */
const CHAIN_TURN_LIMIT_DEG = 35;
/** An edge that bends the surface by less than this is a facet seam, not a pickable edge. */
const PICK_MIN_BEND_DEG = 20;
/** How many sharp edges a body may have before picking is refused (inside corners double the count of a typical body). */
const MAX_PICKABLE_EDGES = 600;

export interface PickableEdgeOptions {
  /** Offer inside (concave) corners as well as outside ones. */
  readonly includeConcave?: boolean;
}

/** The sharp edges of a body as pickable segments, grouped into chains; a message when the body has too many. Convex edges only unless asked. */
export function pickableEdges(body: ModifyMeshInput, angleThresholdDeg: number = DEFAULT_ANGLE_THRESHOLD_DEG, options: PickableEdgeOptions = {}): readonly PickableEdge[] | string {
  const detected = detectSharpEdges(body, angleThresholdDeg, options.includeConcave === true ? "both" : "convex", options.includeConcave === true ? MAX_PICKABLE_EDGES : MAX_SHARP_EDGES);
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
    if (sharp[first]!.concave !== sharp[second]!.concave) continue;
    const d1 = direction(sharp[first]!);
    const d2 = direction(sharp[second]!);
    if (Math.abs(d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2]) >= cosLimit) parent[find(first)] = find(second);
  }
  const chainIds = new Map<number, number>();
  return sharp.map((edge, index) => {
    const root = find(index);
    let chain = chainIds.get(root);
    if (chain === undefined) { chain = chainIds.size; chainIds.set(root, chain); }
    return { a: edge.a, b: edge.b, chain, concave: edge.concave, triangles: edge.triangles };
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

/** A sharp edge a treatment applies to, read along the picked run, with where along the run it starts and ends (millimetres from the run's start). */
interface ChosenEdge {
  readonly edge: SharpEdge;
  readonly startMm: number;
  readonly endMm: number;
}

/** How close a mesh edge must lie to a picked segment to count as part of it. A treated corner shortens its neighbours, so a piece of a picked segment still matches. */
const PICK_MATCH_TOLERANCE_MM = 1e-3;

/**
 * The sharp edges a treatment applies to: all of them, or those lying on the picked segments. The picked segments are read
 * as one run in the order given, so a variable radius can be spread along it.
 */
function chosenEdges(sharp: readonly SharpEdge[], only: EdgeTreatmentOptions["onlyEdges"]): { readonly picks: readonly ChosenEdge[]; readonly runLengthMm: number } {
  if (only === undefined) return { picks: sharp.map((edge) => ({ edge, startMm: 0, endMm: 0 })), runLengthMm: 0 };
  const lengths = only.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  const starts: number[] = [];
  let runLengthMm = 0;
  for (const length of lengths) { starts.push(runLengthMm); runLengthMm += length; }
  const picks: ChosenEdge[] = [];
  for (const edge of sharp) {
    const index = only.findIndex(([a, b]) => distanceToSegmentMm(edge.a, a, b) <= PICK_MATCH_TOLERANCE_MM && distanceToSegmentMm(edge.b, a, b) <= PICK_MATCH_TOLERANCE_MM);
    if (index < 0) continue;
    const [a, b] = only[index]!;
    const length = lengths[index]!;
    const along = (point: V3): number => length < 1e-12 ? 0 : Math.max(0, Math.min(length, ((point[0] - a[0]) * (b[0] - a[0]) + (point[1] - a[1]) * (b[1] - a[1]) + (point[2] - a[2]) * (b[2] - a[2])) / length));
    const pa = along(edge.a);
    const pb = along(edge.b);
    const reversed = pa > pb;
    picks.push({ edge: reversed ? { ...edge, a: edge.b, b: edge.a } : edge, startMm: starts[index]! + Math.min(pa, pb), endMm: starts[index]! + Math.max(pa, pb) });
  }
  picks.sort((p, q) => p.startMm - q.startMm);
  return { picks, runLengthMm };
}

// ---------------------------------------------------------------------------------------------
// Treating edges. The picked edges are joined end to end into runs (a round rim is one run of many
// short segments), and every run gets ONE cutter solid swept along it: a chamfer wedge, a fillet
// profile, or on an inside corner the filler that is joined to the body instead. Cutting a rim one
// short segment at a time leaves overlapping cutters that a Boolean cannot resolve cleanly.
// ---------------------------------------------------------------------------------------------

interface TreatOutcome {
  readonly positionsMm: number[];
  readonly indices: number[];
  readonly faceTriangles: number[] | undefined;
  readonly applied: number;
  readonly failed: number;
  readonly firstFailure: string | undefined;
}

/** A run of picked edges, read along its direction of travel. */
interface Chain {
  /** The corner points, in order; a closed run does not repeat its first point at the end. */
  readonly points: readonly V3[];
  /** Millimetres along the picked run at each point, which is what a variable radius follows. */
  readonly positions: readonly number[];
  /** The edge from each point to the next, oriented along the travel. */
  readonly edges: readonly SharpEdge[];
  readonly closed: boolean;
}

/** What a treatment is: how to draw its cross-section on an edge and how big it is where. */
interface TreatmentSpec {
  readonly concave: boolean;
  readonly flip: boolean;
  /** The cross-section as offsets from the edge, going once round; undefined when the edge cannot take it. */
  readonly ring: (frame: EdgeFrame, size: number) => V3[] | undefined;
  /** The size at a position along the picked run (not limited to the run, so the cutter can reach past its ends). */
  readonly sizeAt: (positionMm: number) => number;
  /** How far along each face the treatment reaches from the edge, for a size. */
  readonly reach: (frame: EdgeFrame, size: number) => readonly [number, number] | undefined;
}

/** The sizes a cutter is tried at, in turn, when a Boolean rejects it: as asked, then a hair larger and a hair smaller. */
const CUTTER_NUDGES: readonly number[] = [1, 1.0013, 0.9987];

/** Two picked segments continue each other when the run turns by no more than this where they meet. */
const RUN_TURN_LIMIT_DEG = CHAIN_TURN_LIMIT_DEG;

function assembleChains(picks: readonly ChosenEdge[]): Chain[] {
  const keyOf = (p: V3): string => `${Math.round(p[0] / 1e-4)},${Math.round(p[1] / 1e-4)},${Math.round(p[2] / 1e-4)}`;
  interface End { readonly pick: number; readonly atStart: boolean }
  const ends = new Map<string, End[]>();
  const add2 = (key: string, end: End): void => { const bucket = ends.get(key); if (bucket === undefined) ends.set(key, [end]); else bucket.push(end); };
  picks.forEach((pick, index) => { add2(keyOf(pick.edge.a), { pick: index, atStart: true }); add2(keyOf(pick.edge.b), { pick: index, atStart: false }); });
  const cosLimit = Math.cos(RUN_TURN_LIMIT_DEG * Math.PI / 180);
  const unit = (from: V3, to: V3): V3 => normalize(sub(to, from)) ?? [0, 0, 0];
  /** The end that continues a run through the point where `pick` meets it, or undefined when the run stops there. */
  const continuation = (pick: number, atStart: boolean): End | undefined => {
    const edge = picks[pick]!.edge;
    const bucket = ends.get(keyOf(atStart ? edge.a : edge.b));
    if (bucket === undefined || bucket.length !== 2) return undefined;
    const other = bucket.find((end) => end.pick !== pick);
    if (other === undefined) return undefined;
    const otherEdge = picks[other.pick]!.edge;
    // Direction of travel into the joint along this edge, and out of it along the other.
    const into = atStart ? unit(edge.b, edge.a) : unit(edge.a, edge.b);
    const out = other.atStart ? unit(otherEdge.a, otherEdge.b) : unit(otherEdge.b, otherEdge.a);
    return into[0] * out[0] + into[1] * out[1] + into[2] * out[2] >= cosLimit ? other : undefined;
  };
  const visited = new Array<boolean>(picks.length).fill(false);
  const chains: Chain[] = [];
  for (let first = 0; first < picks.length; first += 1) {
    if (visited[first]) continue;
    // Walk forward from the first segment's end, then backward from its start.
    interface Step { readonly pick: number; readonly forward: boolean }
    const forwardSteps: Step[] = [{ pick: first, forward: true }];
    visited[first] = true;
    let closed = false;
    let cursor: End | undefined = continuation(first, false);
    while (cursor !== undefined) {
      if (cursor.pick === first) { closed = true; break; }
      if (visited[cursor.pick]) break;
      visited[cursor.pick] = true;
      forwardSteps.push({ pick: cursor.pick, forward: cursor.atStart });
      cursor = continuation(cursor.pick, !cursor.atStart);
    }
    const backwardSteps: Step[] = [];
    if (!closed) {
      cursor = continuation(first, true);
      while (cursor !== undefined) {
        if (visited[cursor.pick]) break;
        visited[cursor.pick] = true;
        // A segment that meets our start with its own end runs the same way we travel; one that meets it with its start runs against it.
        backwardSteps.push({ pick: cursor.pick, forward: !cursor.atStart });
        cursor = continuation(cursor.pick, !cursor.atStart);
      }
    }
    // The backward walk found the segments last-first.
    const steps: Step[] = [...backwardSteps.reverse(), ...forwardSteps];
    const points: V3[] = [];
    const positions: number[] = [];
    const edges: SharpEdge[] = [];
    steps.forEach((step, index) => {
      const pick = picks[step.pick]!;
      const from = step.forward ? pick.edge.a : pick.edge.b;
      const to = step.forward ? pick.edge.b : pick.edge.a;
      const fromPosition = step.forward ? pick.startMm : pick.endMm;
      const toPosition = step.forward ? pick.endMm : pick.startMm;
      if (index === 0) { points.push(from); positions.push(fromPosition); } else positions[positions.length - 1] = (positions[positions.length - 1]! + fromPosition) / 2;
      edges.push({ ...pick.edge, a: from, b: to });
      if (!(closed && index === steps.length - 1)) { points.push(to); positions.push(toPosition); }
    });
    chains.push({ points, positions, edges, closed });
  }
  return chains;
}

function treatChains(body: ModifyMeshInput, chains: readonly Chain[], spec: TreatmentSpec, newFaceIndex: number | undefined): TreatOutcome {
  let positionsMm = Array.from(body.positionsMm);
  let indices = Array.from(body.indices);
  let faceTriangles = body.faceTriangles === undefined ? undefined : Array.from(body.faceTriangles);
  const newFace = newFaceIndex ?? (faceTriangles === undefined ? -1 : faceTriangles.reduce((largest, face) => Math.max(largest, face), -1) + 1);
  let applied = 0;
  let failed = 0;
  let firstFailure: string | undefined;
  for (const chain of chains) {
    const count = chain.edges.length;
    const fail = (reason: string): void => { failed += count; firstFailure ??= reason; };
    const frames = chain.edges.map((edge) => edgeFrameOf(edge, spec.flip));
    if (frames.some((frame) => frame === undefined)) { fail("an edge is too short, or its two faces are too nearly flat, to treat"); continue; }
    const known = frames as EdgeFrame[];
    if (!chainFits(body, chain, known, spec)) { fail("the size reaches past the face beside the edge"); continue; }
    // A Boolean now and then trips over a cutter whose facets land exactly on the body's own vertices; the same cutter a hair larger or smaller does not.
    let cutterBuilt = false;
    let step: ReturnType<typeof booleanMeshes> | undefined;
    for (const nudge of CUTTER_NUDGES) {
      const cutter = chainCutter(chain, known, nudge === 1 ? spec : { ...spec, sizeAt: (position) => spec.sizeAt(position) * nudge, ring: (frame, size) => spec.ring(frame, size) });
      if (cutter === undefined) break;
      cutterBuilt = true;
      step = booleanMeshes({ positionsMm, indices, ...(faceTriangles === undefined ? {} : { faceTriangles }) }, cutter, spec.concave ? "join" : "cut");
      if (step.ok) break;
    }
    if (!cutterBuilt) { fail("the size does not fit this corner"); continue; }
    if (step === undefined || !step.ok) { fail(step === undefined ? "the cut was rejected" : step.message); continue; }
    positionsMm = Array.from(step.value.positionsMm);
    indices = Array.from(step.value.indices);
    if (faceTriangles !== undefined) faceTriangles = step.value.origins.map((origin) => origin.source === "target" ? origin.face : newFace);
    applied += count;
  }
  return { positionsMm, indices, faceTriangles, applied, failed, firstFailure };
}

/**
 * Whether the material is there for the treatment to work on: just under each face, where the treatment reaches it, the body must be
 * solid. A size that runs off the face (a radius bigger than the face beside the edge) would cut something other than the corner.
 */
function chainFits(body: ModifyMeshInput, chain: Chain, frames: readonly EdgeFrame[], spec: TreatmentSpec): boolean {
  for (let index = 0; index < chain.edges.length; index += 1) {
    const edge = chain.edges[index]!;
    const frame = frames[index]!;
    const startMm = chain.positions[index]!;
    const endMm = chain.positions[(index + 1) % chain.points.length]!;
    for (const fraction of [0.1, 0.5, 0.9]) {
      const at: V3 = [edge.a[0] + (edge.b[0] - edge.a[0]) * fraction, edge.a[1] + (edge.b[1] - edge.a[1]) * fraction, edge.a[2] + (edge.b[2] - edge.a[2]) * fraction];
      const reach = spec.reach(frame, spec.sizeAt(startMm + (endMm - startMm) * fraction));
      if (reach === undefined) return false;
      for (const [tangent, normal, distance] of [[frame.t1, frame.n1, reach[0]], [frame.t2, frame.n2, reach[1]]] as const) {
        const probe: V3 = [at[0] + tangent[0] * distance - normal[0] * FIT_PROBE_MM, at[1] + tangent[1] * distance - normal[1] * FIT_PROBE_MM, at[2] + tangent[2] * distance - normal[2] * FIT_PROBE_MM];
        if (!insideMesh(body, probe)) return false;
      }
    }
  }
  return true;
}

/** How far under a face the fit probes look. */
const FIT_PROBE_MM = 0.01;
/** Two ray directions that no axis-aligned or common face meets edge-on. */
const PROBE_RAYS: readonly V3[] = [[0.5773, 0.3017, 0.7581], [-0.2719, 0.8523, 0.4469]];

/** Whether a point is inside a closed mesh, by casting two rays: it is outside only when both agree. A point the rays disagree on is given the benefit of the doubt. */
function insideMesh(body: ModifyMeshInput, point: V3): boolean {
  const p = body.positionsMm;
  let outsideVotes = 0;
  for (const direction of PROBE_RAYS) {
    let crossings = 0;
    for (let t = 0; t + 2 < body.indices.length; t += 3) {
      const a = body.indices[t]! * 3; const b = body.indices[t + 1]! * 3; const c = body.indices[t + 2]! * 3;
      const e1: V3 = [p[b]! - p[a]!, p[b + 1]! - p[a + 1]!, p[b + 2]! - p[a + 2]!];
      const e2: V3 = [p[c]! - p[a]!, p[c + 1]! - p[a + 1]!, p[c + 2]! - p[a + 2]!];
      const h = cross(direction, e2);
      const det = e1[0] * h[0] + e1[1] * h[1] + e1[2] * h[2];
      if (Math.abs(det) < 1e-12) continue;
      const s: V3 = [point[0] - p[a]!, point[1] - p[a + 1]!, point[2] - p[a + 2]!];
      const u = (s[0] * h[0] + s[1] * h[1] + s[2] * h[2]) / det;
      if (u < 0 || u > 1) continue;
      const q = cross(s, e1);
      const v = (direction[0] * q[0] + direction[1] * q[1] + direction[2] * q[2]) / det;
      if (v < 0 || u + v > 1) continue;
      const distance = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) / det;
      if (distance > 1e-9) crossings += 1;
    }
    if (crossings % 2 === 0) outsideVotes += 1;
  }
  return outsideVotes < PROBE_RAYS.length;
}

function finishTreatment(outcome: TreatOutcome, noun: string, picked: number, strict: boolean, hint: string, newFaceIndex: number | undefined): ModifyMeshResult {
  if (outcome.applied === 0) return { ok: false, message: `Every ${noun.toLowerCase()} cut was rejected${outcome.firstFailure === undefined ? "" : ` (${outcome.firstFailure})`}; ${hint}.` };
  if (strict && outcome.failed > 0) return { ok: false, message: `${noun} could not be applied to ${outcome.failed} of ${picked} edge ${picked === 1 ? "segment" : "segments"} (${outcome.firstFailure ?? "the cut was rejected"}); ${hint}.` };
  const newFace = outcome.faceTriangles === undefined ? undefined : (newFaceIndex ?? outcome.faceTriangles.reduce((largest, face) => Math.max(largest, face), -1));
  return {
    ok: true, positionsMm: outcome.positionsMm, indices: outcome.indices,
    ...(outcome.faceTriangles === undefined ? {} : { faceTriangles: outcome.faceTriangles }),
    ...(newFace === undefined ? {} : { newFaceIndex: newFace }),
    treatedSegments: outcome.applied, skippedSegments: outcome.failed
  };
}

// ---------------------------------------------------------------------------------------------
// Chamfer: a wedge cutter along each run of sharp edges (asymmetric and distance + angle included);
// on an inside corner the same wedge is added instead, as a filler that sinks a little into the body.
// ---------------------------------------------------------------------------------------------

export function meshChamfer(body: ModifyMeshInput, options: EdgeTreatmentOptions): ModifyMeshResult {
  const size = options.sizeMm;
  if (!Number.isFinite(size) || size <= 0) return { ok: false, message: "Chamfer distance must be a positive length." };
  if (options.secondSizeMm !== undefined && options.angleDeg !== undefined) return { ok: false, message: "A chamfer takes a second distance or an angle, not both." };
  if (options.secondSizeMm !== undefined && (!Number.isFinite(options.secondSizeMm) || options.secondSizeMm <= 0)) return { ok: false, message: "The second chamfer distance must be a positive length." };
  if (options.angleDeg !== undefined && (!Number.isFinite(options.angleDeg) || options.angleDeg <= 0 || options.angleDeg >= 180)) return { ok: false, message: "The chamfer angle must be between 0° and 180°." };
  const concave = options.concave === true;
  const angleThreshold = options.angleThresholdDeg ?? DEFAULT_ANGLE_THRESHOLD_DEG;
  const found = detectSharpEdges(body, angleThreshold, concave ? "concave" : "convex", options.onlyEdges === undefined ? MAX_SHARP_EDGES : MAX_PICKABLE_EDGES);
  if (typeof found === "string") return { ok: false, message: found };
  const { picks } = chosenEdges(found, options.onlyEdges);
  if (picks.length === 0) return { ok: false, message: options.onlyEdges === undefined ? `No sharp ${concave ? "inside" : "convex"} edges were found on this body, so there is nothing to chamfer.` : `The picked edge is not a sharp ${concave ? "inside" : "convex"} edge of this body, so there is nothing to chamfer.` };
  const secondOf = (frame: EdgeFrame): number | undefined => options.angleDeg !== undefined ? chamferSecondDistance(frame, size, options.angleDeg) : (options.secondSizeMm ?? size);
  const spec: TreatmentSpec = {
    concave, flip: options.flip === true,
    ring: (frame, sized) => { const second = secondOf(frame); return second === undefined ? undefined : chamferRing(frame, sized, second * sized / size, concave, sinkDepth(Math.max(sized, second))); },
    sizeAt: () => size,
    reach: (frame) => { const second = secondOf(frame); return second === undefined ? undefined : [size, second]; }
  };
  const outcome = treatChains(body, assembleChains(picks), spec, options.newFaceIndex);
  return finishTreatment(outcome, "Chamfer", picks.length, options.strict === true, "try a smaller distance", options.newFaceIndex);
}

/** Where the second face's cut ends so the chamfer makes `angleDeg` with the first face, for a first distance of `first`. */
function chamferSecondDistance(frame: EdgeFrame, first: number, angleDeg: number): number | undefined {
  const theta = angleDeg * Math.PI / 180;
  const total = frame.opening + theta;
  if (total >= Math.PI - 1e-3) return undefined;
  const second = first * Math.sin(theta) / Math.sin(total);
  return Number.isFinite(second) && second > 1e-9 ? second : undefined;
}

/** How far the filler of an inside corner sinks into the body, so it overlaps the faces it joins instead of just touching them. */
function sinkDepth(size: number): number {
  return Math.max(0.01, Math.min(0.25, size * 0.1));
}

// ---------------------------------------------------------------------------------------------
// Fillet: a cutter whose cross-section is the corner between the edge and a circular arc tangent to
// both faces (the rolling ball). A radius that changes along the run makes the cutter a cone-like
// sweep: every cross-section across the edge is the exact arc of the radius at that point.
// ---------------------------------------------------------------------------------------------

export function meshFillet(body: ModifyMeshInput, options: EdgeTreatmentOptions): ModifyMeshResult {
  const radius = options.sizeMm;
  if (!Number.isFinite(radius) || radius <= 0) return { ok: false, message: "Fillet radius must be a positive length." };
  const endRadius = options.endSizeMm;
  if (endRadius !== undefined && (!Number.isFinite(endRadius) || endRadius <= 0)) return { ok: false, message: "The end radius of a variable fillet must be a positive length." };
  if (endRadius !== undefined && endRadius !== radius && options.onlyEdges === undefined) return { ok: false, message: "A variable-radius fillet needs a picked edge run to spread the radius along." };
  const concave = options.concave === true;
  const angleThreshold = options.angleThresholdDeg ?? DEFAULT_ANGLE_THRESHOLD_DEG;
  const segments = options.segments ?? DEFAULT_FILLET_SEGMENTS;
  if (!Number.isInteger(segments) || segments < 3 || segments > 48) return { ok: false, message: "Fillet tessellation must be between 3 and 48 segments." };
  const found = detectSharpEdges(body, angleThreshold, concave ? "concave" : "convex", options.onlyEdges === undefined ? MAX_SHARP_EDGES : MAX_PICKABLE_EDGES);
  if (typeof found === "string") return { ok: false, message: found };
  const { picks, runLengthMm } = chosenEdges(found, options.onlyEdges);
  if (picks.length === 0) return { ok: false, message: options.onlyEdges === undefined ? `No sharp ${concave ? "inside" : "convex"} edges were found on this body, so there is nothing to fillet.` : `The picked edge is not a sharp ${concave ? "inside" : "convex"} edge of this body, so there is nothing to fillet.` };
  const last = endRadius ?? radius;
  const smallest = Math.min(radius, last);
  const spec: TreatmentSpec = {
    concave, flip: false,
    ring: (frame, size) => filletRing(frame, size, segments, concave, sinkDepth(size)),
    sizeAt: (position) => runLengthMm < 1e-9 ? radius : Math.max(smallest * 0.25, radius + (last - radius) * (position / runLengthMm)),
    reach: (frame, size) => { const tangent = size * frame.cosHalf / frame.sinHalf; return [tangent, tangent]; }
  };
  const outcome = treatChains(body, assembleChains(picks), spec, options.newFaceIndex);
  return finishTreatment(outcome, "Fillet", picks.length, options.strict === true, "try a smaller radius", options.newFaceIndex);
}

// ---------------------------------------------------------------------------------------------
// Cutter geometry
// ---------------------------------------------------------------------------------------------

interface EdgeFrame {
  /** Unit direction along the edge, a to b. */
  readonly e: V3;
  /** Unit directions along the first and second face, away from the edge, bounding the wedge that is removed (outside corner) or filled (inside corner). */
  readonly t1: V3;
  readonly t2: V3;
  readonly n1: V3;
  readonly n2: V3;
  readonly bisector: V3;
  readonly cosHalf: number;
  readonly sinHalf: number;
  /** The angle between t1 and t2, in radians. */
  readonly opening: number;
}

function edgeFrameOf(edge: SharpEdge, flip: boolean): EdgeFrame | undefined {
  const length = Math.hypot(edge.b[0] - edge.a[0], edge.b[1] - edge.a[1], edge.b[2] - edge.a[2]);
  if (length < 1e-6) return undefined;
  const e: V3 = [(edge.b[0] - edge.a[0]) / length, (edge.b[1] - edge.a[1]) / length, (edge.b[2] - edge.a[2]) / length];
  const n1 = flip ? edge.n2 : edge.n1;
  const n2 = flip ? edge.n1 : edge.n2;
  // Along each face and perpendicular to the edge. Into the material at an outside corner (below the other face), into the air at an inside one (above it).
  const t1 = pickTangent(n1, e, n2, edge.concave);
  const t2 = pickTangent(n2, e, n1, edge.concave);
  if (t1 === undefined || t2 === undefined) return undefined;
  const sum: V3 = [t1[0] + t2[0], t1[1] + t2[1], t1[2] + t2[2]];
  const sumLength = Math.hypot(sum[0], sum[1], sum[2]);
  if (sumLength < 1e-6) return undefined;
  const bisector: V3 = [sum[0] / sumLength, sum[1] / sumLength, sum[2] / sumLength];
  const cosHalf = t1[0] * bisector[0] + t1[1] * bisector[1] + t1[2] * bisector[2];
  const sinHalf = Math.sqrt(Math.max(0, 1 - cosHalf * cosHalf));
  if (sinHalf < 1e-4) return undefined;
  return { e, t1, t2, n1, n2, bisector, cosHalf, sinHalf, opening: 2 * Math.atan2(sinHalf, cosHalf) };
}

function pickTangent(faceNormal: V3, edge: V3, otherFaceNormal: V3, concave: boolean): V3 | undefined {
  const candidate = normalize(cross(faceNormal, edge));
  if (candidate === undefined) return undefined;
  const sign = candidate[0] * otherFaceNormal[0] + candidate[1] * otherFaceNormal[1] + candidate[2] * otherFaceNormal[2];
  const pointsWrongWay = concave ? sign < 0 : sign > 0;
  return pointsWrongWay ? [-candidate[0], -candidate[1], -candidate[2]] : candidate;
}

/** Cross-section of a chamfer, as offsets from the edge, going once round: the corner, the cut on the first face, the cut on the second. */
function chamferRing(frame: EdgeFrame, first: number, second: number, concave: boolean, depth: number): V3[] {
  const p1: V3 = [frame.t1[0] * first, frame.t1[1] * first, frame.t1[2] * first];
  const p2: V3 = [frame.t2[0] * second, frame.t2[1] * second, frame.t2[2] * second];
  return concave ? fillerRing(frame, [p1, p2], depth) : [[0, 0, 0], p1, p2];
}

/**
 * Cross-section of a fillet of radius `radius`. The ball sits on the bisector, tangent to both faces; the section runs from the
 * edge to the tangent point on the first face, round the arc, to the tangent point on the second.
 */
function filletRing(frame: EdgeFrame, radius: number, segments: number, concave: boolean, depth: number): V3[] | undefined {
  const tangentDistance = radius * frame.cosHalf / frame.sinHalf;
  const centerOffset = radius / frame.sinHalf;
  const p1: V3 = [frame.t1[0] * tangentDistance, frame.t1[1] * tangentDistance, frame.t1[2] * tangentDistance];
  const p2: V3 = [frame.t2[0] * tangentDistance, frame.t2[1] * tangentDistance, frame.t2[2] * tangentDistance];
  const center: V3 = [frame.bisector[0] * centerOffset, frame.bisector[1] * centerOffset, frame.bisector[2] * centerOffset];
  const u1 = normalize(sub(p1, center));
  const u2 = normalize(sub(p2, center));
  if (u1 === undefined || u2 === undefined) return undefined;
  const theta = Math.acos(Math.max(-1, Math.min(1, u1[0] * u2[0] + u1[1] * u2[1] + u1[2] * u2[2])));
  // Turn about the edge, whichever way carries the first tangent point to the second through the short arc.
  const spin = cross(u1, u2);
  const axis: V3 = spin[0] * frame.e[0] + spin[1] * frame.e[1] + spin[2] * frame.e[2] >= 0 ? frame.e : [-frame.e[0], -frame.e[1], -frame.e[2]];
  const arc: V3[] = [];
  for (let step = 1; step < segments; step += 1) {
    const rotated = rotateAround(u1, axis, (step / segments) * theta);
    arc.push([center[0] + rotated[0] * radius, center[1] + rotated[1] * radius, center[2] + rotated[2] * radius]);
  }
  return concave ? fillerRing(frame, [p1, ...arc, p2], depth) : [[0, 0, 0], p1, ...arc, p2];
}

/** The outline of an inside-corner filler: the visible profile from the first face to the second, closed by a strip that sinks into the body. */
function fillerRing(frame: EdgeFrame, profile: readonly V3[], depth: number): V3[] {
  const first = profile[0]!;
  const last = profile[profile.length - 1]!;
  const below1: V3 = [-frame.n1[0] * depth, -frame.n1[1] * depth, -frame.n1[2] * depth];
  const below2: V3 = [-frame.n2[0] * depth, -frame.n2[1] * depth, -frame.n2[2] * depth];
  return [
    [below1[0] + below2[0], below1[1] + below2[1], below1[2] + below2[2]],
    [first[0] + below1[0], first[1] + below1[1], first[2] + below1[2]],
    ...profile,
    [last[0] + below2[0], last[1] + below2[1], last[2] + below2[2]]
  ];
}

/**
 * The cutter along a run of edges, as one closed solid. There is one outline at every corner of the run, set in the plane that
 * bisects the two edges meeting there (a mitre), so neighbouring segments share their outline and the surface is continuous.
 * An open run is capped at both ends; an outside corner's cutter runs a little past both ends so the cut is clean, while the
 * filler of an inside corner stops exactly at them. A closed run (a round rim) has no ends and makes a ring.
 */
function chainCutter(chain: Chain, frames: readonly EdgeFrame[], spec: TreatmentSpec): BooleanMeshInput | undefined {
  const count = chain.edges.length;
  const cornerCount = chain.closed ? count : count + 1;
  const dot = (p: V3, q: V3): number => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const sizes = chain.positions.map((position) => spec.sizeAt(position));
  const smallest = Math.min(...sizes);
  const largest = Math.max(...sizes);
  const reach = spec.concave || chain.closed ? 0 : largest * 0.05 + 0.01;
  const rings: V3[][] = [];
  for (let corner = 0; corner < cornerCount; corner += 1) {
    const before = chain.closed ? (corner + count - 1) % count : corner - 1;
    const after = chain.closed ? corner : corner < count ? corner : -1;
    const direction = (index: number): V3 => frames[index]!.e;
    const mitre = before >= 0 && after >= 0
      ? normalize([direction(before)[0] + direction(after)[0], direction(before)[1] + direction(after)[1], direction(before)[2] + direction(after)[2]])
      : direction(before >= 0 ? before : after);
    if (mitre === undefined) return undefined;
    const atStart = corner === 0 && !chain.closed;
    const atEnd = corner === cornerCount - 1 && !chain.closed;
    // The run's two ends move out by `reach`, and the size carries on along the same slope.
    const shift = atStart ? -reach : atEnd ? reach : 0;
    const size = Math.max(smallest * 0.25, spec.sizeAt(chain.positions[corner]! + shift));
    const origin = add(chain.points[corner]!, [mitre[0] * shift, mitre[1] * shift, mitre[2] * shift]);
    const parts: V3[][] = [];
    for (const index of [before, after]) {
      if (index < 0) continue;
      const frame = frames[index]!;
      const offsets = spec.ring(frame, size);
      if (offsets === undefined) return undefined;
      const along = dot(frame.e, mitre);
      if (along < 0.3) return undefined;
      // Slide each outline point along its own edge until it lies in the mitre plane.
      parts.push(offsets.map((offset): V3 => {
        const slide = dot(offset, mitre) / along;
        return [offset[0] - frame.e[0] * slide, offset[1] - frame.e[1] * slide, offset[2] - frame.e[2] * slide];
      }));
    }
    if (parts.length === 0 || parts.some((part) => part.length !== parts[0]!.length)) return undefined;
    rings.push(parts[0]!.map((_, point): V3 => {
      let sum: V3 = [0, 0, 0];
      for (const part of parts) sum = add(sum, part[point]!);
      return add(origin, [sum[0] / parts.length, sum[1] / parts.length, sum[2] / parts.length]);
    }));
  }
  const ringSize = rings[0]!.length;
  if (ringSize < 3 || rings.some((ring) => ring.length !== ringSize)) return undefined;

  // Outlines are laid out counter-clockwise about the direction of travel, so the sides face outward.
  const basisFor = (e: V3): { readonly u: V3; readonly v: V3 } | undefined => {
    const helper: V3 = Math.abs(e[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const u = normalize(cross(helper, e));
    return u === undefined ? undefined : { u, v: cross(e, u) };
  };
  const flatten = (ring: readonly V3[], basis: { readonly u: V3; readonly v: V3 }): [number, number][] => ring.map((p) => [dot(p, basis.u), dot(p, basis.v)]);
  const areaOf = (points: readonly (readonly [number, number])[]): number => {
    let area = 0;
    for (let i = 0; i < points.length; i += 1) { const p = points[i]!; const q = points[(i + 1) % points.length]!; area += p[0] * q[1] - q[0] * p[1]; }
    return area;
  };
  const startBasis = basisFor(frames[0]!.e);
  if (startBasis === undefined) return undefined;
  const startArea = areaOf(flatten(rings[0]!, startBasis));
  if (Math.abs(startArea) < 1e-12) return undefined;
  const ordered = startArea < 0 ? rings.map((ring) => [...ring].reverse()) : rings;

  const positions: number[] = [];
  for (const ring of ordered) for (const p of ring) positions.push(p[0], p[1], p[2]);
  const indices: number[] = [];
  const sideCount = chain.closed ? cornerCount : cornerCount - 1;
  for (let side = 0; side < sideCount; side += 1) {
    const from = side * ringSize;
    const to = ((side + 1) % cornerCount) * ringSize;
    for (let i = 0; i < ringSize; i += 1) {
      const j = (i + 1) % ringSize;
      indices.push(from + i, from + j, to + j, from + i, to + j, to + i);
    }
  }
  if (!chain.closed) {
    const startCap = earClip(flatten(ordered[0]!, startBasis));
    const endBasis = basisFor(frames[count - 1]!.e);
    if (startCap === undefined || endBasis === undefined) return undefined;
    const endFlat = flatten(ordered[cornerCount - 1]!, endBasis);
    if (areaOf(endFlat) <= 1e-12) return undefined;
    const endCap = earClip(endFlat);
    if (endCap === undefined) return undefined;
    for (const [i, j, k] of startCap) indices.push(i, k, j); // faces against the travel
    const endBase = (cornerCount - 1) * ringSize;
    for (const [i, j, k] of endCap) indices.push(endBase + i, endBase + j, endBase + k); // faces along it
  }
  return { positionsMm: positions, indices };
}

/** Triangulates a simple counter-clockwise polygon by clipping ears; undefined when none can be found. */
function earClip(points: readonly (readonly [number, number])[]): [number, number, number][] | undefined {
  const remaining = points.map((_, index) => index);
  const triangles: [number, number, number][] = [];
  const cross2 = (o: readonly [number, number], p: readonly [number, number], q: readonly [number, number]): number => (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
  const inside = (p: readonly [number, number], a: readonly [number, number], b: readonly [number, number], c: readonly [number, number]): boolean =>
    cross2(a, b, p) >= -1e-12 && cross2(b, c, p) >= -1e-12 && cross2(c, a, p) >= -1e-12;
  let guard = points.length * points.length + 10;
  while (remaining.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let at = 0; at < remaining.length; at += 1) {
      const prev = remaining[(at + remaining.length - 1) % remaining.length]!;
      const here = remaining[at]!;
      const next = remaining[(at + 1) % remaining.length]!;
      const a = points[prev]!; const b = points[here]!; const c = points[next]!;
      if (cross2(a, b, c) <= 1e-12) continue; // reflex or flat
      const blocked = remaining.some((other) => other !== prev && other !== here && other !== next && inside(points[other]!, a, b, c)
        && !(Math.abs(points[other]![0] - a[0]) < 1e-12 && Math.abs(points[other]![1] - a[1]) < 1e-12) && !(Math.abs(points[other]![0] - c[0]) < 1e-12 && Math.abs(points[other]![1] - c[1]) < 1e-12));
      if (blocked) continue;
      triangles.push([prev, here, next]);
      remaining.splice(at, 1);
      clipped = true;
      break;
    }
    if (!clipped) return undefined;
  }
  if (remaining.length === 3) triangles.push([remaining[0]!, remaining[1]!, remaining[2]!]);
  return triangles;
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

function add(a: V3, b: V3): V3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
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
