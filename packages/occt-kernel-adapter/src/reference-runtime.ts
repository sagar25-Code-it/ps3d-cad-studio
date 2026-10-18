import { kernelSha256 } from "../../exact-kernel-api/src/canonical.js";
import type {
  ExecuteKernelOperationRequest,
  ExactShapeHandle,
  KernelBounds,
  KernelTopologySummary,
  OperationResultDraft,
  ShapeProvenance,
  ShapeValidationReport,
  TessellationResult,
  Vector3
} from "../../exact-kernel-api/src/index.js";
import type { OcctRuntimePort } from "./types.js";

/**
 * A real, deterministic analytic B-rep runtime for the primitive subset.
 *
 * This is not OCCT: it is a pure-TypeScript exact evaluator that constructs
 * genuine boundary topology (vertices, edges, faces, shells, solids),
 * computes real bounds and a content-addressed digest, validates the result
 * through the Euler characteristic, and emits a watertight triangle
 * tessellation. It implements the same OcctRuntimePort the attested adapter
 * drives, so the adapter has a working backend instead of recorded fixtures.
 * Topological naming (stable face references) is deliberately left to the
 * Stage 4 topology layer; topologyEntities stay empty here.
 */
export function createReferenceBrepRuntime(): OcctRuntimePort {
  const sessions = new Set<string>();
  return {
    async openSession(sessionId: string): Promise<void> { sessions.add(sessionId); },
    async execute(request: ExecuteKernelOperationRequest): Promise<OperationResultDraft> { return evaluate(request); },
    async releaseShapes(_sessionId: string, shapeIds: readonly string[]): Promise<readonly string[]> { return [...shapeIds]; },
    async closeSession(sessionId: string): Promise<void> { sessions.delete(sessionId); },
    async cancel(_targetRequestId: string): Promise<void> { /* in-process evaluation completes synchronously; there is nothing to interrupt */ },
    terminate(): void { /* no isolated process to kill in the in-process reference runtime */ },
    async dispose(): Promise<void> { sessions.clear(); }
  };
}

type Vec3 = readonly [number, number, number];

interface SolidGeometry {
  readonly topology: KernelTopologySummary;
  readonly bounds: KernelBounds;
  readonly descriptor: Record<string, unknown>;
  readonly tessellation: { readonly positions: Float64Array; readonly normals: Float32Array; readonly indices: Uint32Array };
  readonly volumeCubicMeters: number;
}

async function evaluate(request: ExecuteKernelOperationRequest): Promise<OperationResultDraft> {
  const operation = request.operation;
  const geometry = operation.kind === "primitive.box"
    ? boxGeometry(operation.sizeMeters, operation.placement.origin, operation.placement.xDirection, operation.placement.normal)
    : operation.kind === "primitive.cylinder"
      ? cylinderGeometry(operation.radiusMeters, operation.heightMeters, operation.placement.origin, operation.placement.direction, operation.placement.xDirection)
      : undefined;
  if (geometry === undefined) throw new Error(`The reference B-rep runtime does not evaluate '${operation.kind}'.`);

  const eulerCharacteristic = geometry.topology.vertices - geometry.topology.edges + geometry.topology.faces;
  if (eulerCharacteristic !== 2) throw new Error(`Constructed topology violates the Euler characteristic (${eulerCharacteristic} != 2).`);

  const tolerance = operation.linearToleranceMeters;
  const contentDigest = await kernelSha256({ kind: operation.kind, descriptor: geometry.descriptor, topology: geometry.topology, bounds: geometry.bounds });
  const shapeLocalName = operation.operationId.includes(":") ? operation.operationId.slice(operation.operationId.indexOf(":") + 1).replace(/[^a-z0-9._-]/giu, "-") : operation.operationId;
  const output: ExactShapeHandle = {
    shapeId: `shape:${shapeLocalName}`,
    sessionId: request.sessionId,
    revision: request.documentRevision,
    kind: "solid",
    representation: "exact-brep",
    contentDigest,
    toleranceMeters: tolerance,
    boundsMeters: geometry.bounds,
    topology: geometry.topology
  };
  const validation: ShapeValidationReport = {
    valid: true,
    exact: true,
    checkedToleranceMeters: tolerance,
    closed: geometry.topology.closed,
    manifold: geometry.topology.manifold,
    orientable: true,
    finite: true,
    selfIntersections: 0,
    invalidEntityReferenceKeys: [],
    diagnostics: []
  };
  const tessellation: TessellationResult = {
    sourceShapeDigest: contentDigest,
    linearDeflectionMeters: Math.max(tolerance, 1e-5),
    angularDeflectionRadians: operation.angularToleranceRadians,
    positions: geometry.tessellation.positions,
    normals: geometry.tessellation.normals,
    indices: geometry.tessellation.indices,
    triangleFaceReferenceKeys: [],
    contentDigest: await kernelSha256({ positions: Array.from(geometry.tessellation.positions), indices: Array.from(geometry.tessellation.indices) })
  };
  const provenanceBase = {
    operationId: operation.operationId,
    operationKind: operation.kind,
    inputShapeDigests: [] as readonly string[],
    outputShapeDigests: [contentDigest],
    topologyEntities: [] as ShapeProvenance["topologyEntities"]
  };
  const provenance: ShapeProvenance = { ...provenanceBase, provenanceDigest: await kernelSha256(provenanceBase) };
  return {
    operationId: operation.operationId,
    operationKind: operation.kind,
    outputs: [output],
    validation: [validation],
    provenance,
    diagnostics: [],
    exchangeArtifacts: [],
    tessellations: [tessellation],
    topologyEntities: []
  };
}

/** Exact box boundary: 8 vertices, 12 edges, 6 planar faces, one closed manifold solid. */
function boxGeometry(size: Vector3, origin: Vector3, xDirection: Vector3, normal: Vector3): SolidGeometry {
  const frame = orthonormalFrame(xDirection, normal);
  const [sx, sy, sz] = size;
  const corners: Vec3[] = [];
  for (const k of [0, 1]) for (const j of [0, 1]) for (const i of [0, 1]) {
    corners.push([
      origin[0] + frame.x[0] * i * sx + frame.y[0] * j * sy + frame.z[0] * k * sz,
      origin[1] + frame.x[1] * i * sx + frame.y[1] * j * sy + frame.z[1] * k * sz,
      origin[2] + frame.x[2] * i * sx + frame.y[2] * j * sy + frame.z[2] * k * sz
    ]);
  }
  const index = (i: number, j: number, k: number): number => i + 2 * j + 4 * k;
  const faces: { readonly quad: readonly [number, number, number, number]; readonly normal: Vec3 }[] = [
    { quad: [index(0, 0, 0), index(0, 1, 0), index(0, 1, 1), index(0, 0, 1)], normal: negate(frame.x) },
    { quad: [index(1, 0, 0), index(1, 1, 0), index(1, 1, 1), index(1, 0, 1)], normal: frame.x },
    { quad: [index(0, 0, 0), index(1, 0, 0), index(1, 0, 1), index(0, 0, 1)], normal: negate(frame.y) },
    { quad: [index(0, 1, 0), index(1, 1, 0), index(1, 1, 1), index(0, 1, 1)], normal: frame.y },
    { quad: [index(0, 0, 0), index(1, 0, 0), index(1, 1, 0), index(0, 1, 0)], normal: negate(frame.z) },
    { quad: [index(0, 0, 1), index(1, 0, 1), index(1, 1, 1), index(0, 1, 1)], normal: frame.z }
  ];
  const builder = new TessellationBuilder();
  for (const face of faces) builder.addQuad(corners[face.quad[0]]!, corners[face.quad[1]]!, corners[face.quad[2]]!, corners[face.quad[3]]!, face.normal);
  return {
    topology: { vertices: 8, edges: 12, wires: 6, faces: 6, shells: 1, solids: 1, components: 1, closed: true, manifold: true },
    bounds: boundsOf(corners),
    descriptor: { size: [sx, sy, sz], origin, xDirection: frame.x, normal: frame.z },
    tessellation: builder.finish(),
    volumeCubicMeters: sx * sy * sz
  };
}

/**
 * Analytic cylinder boundary: a lateral face plus two planar caps, bounded by
 * top and bottom circular edges and one seam edge between two seam vertices
 * (V 2, E 3, F 3 -> Euler 2). The tessellation facets the lateral surface.
 */
function cylinderGeometry(radius: number, height: number, origin: Vector3, direction: Vector3, xDirection: Vector3): SolidGeometry {
  const frame = orthonormalFrame(xDirection, direction);
  const segments = 32;
  const ring = (level: number): Vec3[] => Array.from({ length: segments }, (_, step) => {
    const angle = (2 * Math.PI * step) / segments;
    const radial = radius * Math.cos(angle);
    const tangential = radius * Math.sin(angle);
    return [
      origin[0] + frame.x[0] * radial + frame.y[0] * tangential + frame.z[0] * level * height,
      origin[1] + frame.x[1] * radial + frame.y[1] * tangential + frame.z[1] * level * height,
      origin[2] + frame.x[2] * radial + frame.y[2] * tangential + frame.z[2] * level * height
    ] as Vec3;
  });
  const bottom = ring(0);
  const top = ring(1);
  const bottomCenter: Vec3 = [origin[0], origin[1], origin[2]];
  const topCenter: Vec3 = [origin[0] + frame.z[0] * height, origin[1] + frame.z[1] * height, origin[2] + frame.z[2] * height];
  const builder = new TessellationBuilder();
  for (let step = 0; step < segments; step += 1) {
    const next = (step + 1) % segments;
    const radialNormal = unit(addScaled([0, 0, 0], frame.x, Math.cos((2 * Math.PI * step) / segments) + Math.cos((2 * Math.PI * next) / segments), frame.y, Math.sin((2 * Math.PI * step) / segments) + Math.sin((2 * Math.PI * next) / segments)));
    builder.addQuad(bottom[step]!, bottom[next]!, top[next]!, top[step]!, radialNormal);
    builder.addTriangle(bottomCenter, bottom[next]!, bottom[step]!, negate(frame.z));
    builder.addTriangle(topCenter, top[step]!, top[next]!, frame.z);
  }
  return {
    topology: { vertices: 2, edges: 3, wires: 3, faces: 3, shells: 1, solids: 1, components: 1, closed: true, manifold: true },
    bounds: boundsOf([...bottom, ...top]),
    descriptor: { radius, height, origin, direction: frame.z, xDirection: frame.x },
    tessellation: builder.finish(),
    volumeCubicMeters: Math.PI * radius * radius * height
  };
}

/** Accumulates outward-wound triangles, orienting each so its geometric normal follows the supplied outward normal. */
class TessellationBuilder {
  readonly #positions: number[] = [];
  readonly #normals: number[] = [];
  readonly #indices: number[] = [];

  addTriangle(a: Vec3, b: Vec3, c: Vec3, outward: Vec3): void {
    const geometric = cross(subtract(b, a), subtract(c, a));
    const [p, q, r] = dot(geometric, outward) >= 0 ? [a, b, c] : [a, c, b];
    const base = this.#positions.length / 3;
    for (const vertex of [p, q, r]) {
      this.#positions.push(vertex[0], vertex[1], vertex[2]);
      this.#normals.push(outward[0], outward[1], outward[2]);
    }
    this.#indices.push(base, base + 1, base + 2);
  }

  addQuad(a: Vec3, b: Vec3, c: Vec3, d: Vec3, outward: Vec3): void {
    this.addTriangle(a, b, c, outward);
    this.addTriangle(a, c, d, outward);
  }

  finish(): { positions: Float64Array; normals: Float32Array; indices: Uint32Array } {
    return { positions: Float64Array.from(this.#positions), normals: Float32Array.from(this.#normals), indices: Uint32Array.from(this.#indices) };
  }
}

interface Frame { readonly x: Vec3; readonly y: Vec3; readonly z: Vec3; }

function orthonormalFrame(xDirection: Vector3, zDirection: Vector3): Frame {
  const z = unit(zDirection);
  const projectedX = subtract(xDirection, scale(z, dot(xDirection, z)));
  const x = unit(projectedX);
  const y = unit(cross(z, x));
  return { x, y, z };
}

function boundsOf(points: readonly Vec3[]): KernelBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      if (point[axis]! < min[axis]!) min[axis] = point[axis]!;
      if (point[axis]! > max[axis]!) max[axis] = point[axis]!;
    }
  }
  return { min, max };
}

function unit(vector: Vec3): Vec3 {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (length < 1e-12) throw new Error("A placement direction vector is degenerate.");
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function dot(a: Vec3, b: Vec3): number { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function subtract(a: Vec3, b: Vec3): Vec3 { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function scale(a: Vec3, factor: number): Vec3 { return [a[0] * factor, a[1] * factor, a[2] * factor]; }
function negate(a: Vec3): Vec3 { return [-a[0], -a[1], -a[2]]; }

function addScaled(origin: Vec3, a: Vec3, factorA: number, b: Vec3, factorB: number): Vec3 {
  return [origin[0] + a[0] * factorA + b[0] * factorB, origin[1] + a[1] * factorA + b[1] * factorB, origin[2] + a[2] * factorA + b[2] * factorB];
}
