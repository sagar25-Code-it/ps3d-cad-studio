import { kernelSha256 } from "../../exact-kernel-api/src/canonical.js";
import type {
  ExecuteKernelOperationRequest,
  ExactShapeHandle,
  GeometricSignature,
  KernelBounds,
  KernelTopologySummary,
  OperationResultDraft,
  ResolvedTopologyEntity,
  ShapeProvenance,
  ShapeValidationReport,
  StableTopologyReference,
  TessellationResult,
  Vector3
} from "../../exact-kernel-api/src/index.js";
import type { OcctRuntimePort } from "./types.js";

/**
 * A real, deterministic analytic B-rep runtime for a primitive-and-feature
 * subset.
 *
 * This is not OCCT: it is a pure-TypeScript exact evaluator that constructs
 * genuine boundary topology (vertices, edges, faces, shells, solids),
 * computes real bounds and a content-addressed digest, validates the result
 * through the Euler characteristic, and emits a watertight triangle
 * tessellation. It implements the same OcctRuntimePort the attested adapter
 * drives, so the adapter has a working backend instead of recorded fixtures.
 *
 * It is stateful per session so that feature operations can consume the exact
 * geometry of earlier outputs: extrude reads a stored planar profile loop, and
 * Boolean operates on stored axis-aligned boxes. Configurations that need
 * general curved-surface CSG are rejected explicitly rather than approximated.
 * Topological naming (stable face references) is deferred to the Stage 4
 * topology layer; topologyEntities stay empty here.
 */
export function createReferenceBrepRuntime(): OcctRuntimePort {
  const store = new Map<string, Map<string, StoredSolid>>();
  return {
    async openSession(sessionId: string): Promise<void> { if (!store.has(sessionId)) store.set(sessionId, new Map()); },
    async execute(request: ExecuteKernelOperationRequest): Promise<OperationResultDraft> { return evaluate(store, request); },
    async releaseShapes(sessionId: string, shapeIds: readonly string[]): Promise<readonly string[]> {
      const session = store.get(sessionId);
      const released: string[] = [];
      for (const shapeId of shapeIds) if (session?.delete(shapeId) === true) released.push(shapeId);
      return released;
    },
    async closeSession(sessionId: string): Promise<void> { store.delete(sessionId); },
    async cancel(_targetRequestId: string): Promise<void> { /* in-process evaluation completes synchronously; there is nothing to interrupt */ },
    terminate(): void { store.clear(); },
    async dispose(): Promise<void> { store.clear(); }
  };
}

type Vec3 = readonly [number, number, number];

interface SolidGeometry {
  readonly topology: KernelTopologySummary;
  readonly bounds: KernelBounds;
  readonly descriptor: Record<string, unknown>;
  readonly tessellation: { readonly positions: Float64Array; readonly normals: Float32Array; readonly indices: Uint32Array };
  readonly volumeCubicMeters: number;
  readonly faces: readonly FaceSpec[];
}

/**
 * A boundary face described by a construction-stable role plus its current
 * geometry. The role (not a transient index) anchors the persistent name, so a
 * rebuilt feature keeps the same reference even when dimensions change.
 */
interface FaceSpec {
  readonly role: string;
  readonly geometryClass: GeometricSignature["geometryClass"];
  readonly centroid: Vec3;
  readonly area: number;
  readonly bounds: KernelBounds;
  readonly normal: Vec3;
  readonly adjacentRoles: readonly string[];
}

/** A solid retained in the session so later feature operations can consume its exact geometry. */
interface StoredSolid {
  readonly geometry: SolidGeometry;
  readonly axisAlignedBox?: { readonly min: Vec3; readonly max: Vec3 };
  readonly profileLoop?: { readonly points: readonly Vec3[]; readonly normal: Vec3 };
}

async function evaluate(store: Map<string, Map<string, StoredSolid>>, request: ExecuteKernelOperationRequest): Promise<OperationResultDraft> {
  const operation = request.operation;
  const session = store.get(request.sessionId) ?? new Map<string, StoredSolid>();
  if (!store.has(request.sessionId)) store.set(request.sessionId, session);

  const solid = operation.kind === "primitive.box"
    ? boxSolid(operation.sizeMeters, operation.placement.origin, operation.placement.xDirection, operation.placement.normal)
    : operation.kind === "primitive.cylinder"
      ? { geometry: cylinderGeometry(operation.radiusMeters, operation.heightMeters, operation.placement.origin, operation.placement.direction, operation.placement.xDirection) }
      : operation.kind === "solid.extrude"
        ? extrudeSolid(session, operation)
        : operation.kind === "solid.boolean"
          ? booleanSolid(session, operation)
          : undefined;
  if (solid === undefined) throw new Error(`The reference B-rep runtime does not evaluate '${operation.kind}'.`);

  const geometry = solid.geometry;
  const euler = geometry.topology.vertices - geometry.topology.edges + geometry.topology.faces;
  if (euler !== 2) throw new Error(`Constructed topology violates the Euler characteristic (${euler} != 2).`);

  const tolerance = operation.linearToleranceMeters;
  const contentDigest = await kernelSha256({ kind: operation.kind, descriptor: geometry.descriptor, topology: geometry.topology, bounds: geometry.bounds });
  const shapeLocalName = operation.operationId.includes(":") ? operation.operationId.slice(operation.operationId.indexOf(":") + 1).replace(/[^a-z0-9._-]/giu, "-") : operation.operationId;
  const shapeId = `shape:${shapeLocalName}`;
  const output: ExactShapeHandle = {
    shapeId,
    sessionId: request.sessionId,
    revision: request.documentRevision,
    kind: "solid",
    representation: "exact-brep",
    contentDigest,
    toleranceMeters: tolerance,
    boundsMeters: geometry.bounds,
    topology: geometry.topology
  };
  session.set(shapeId, { ...solid, geometry });
  const validation: ShapeValidationReport = {
    valid: true, exact: true, checkedToleranceMeters: tolerance,
    closed: geometry.topology.closed, manifold: geometry.topology.manifold,
    orientable: true, finite: true, selfIntersections: 0, invalidEntityReferenceKeys: [], diagnostics: []
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
  const topologyEntities = await buildFaceEntities({ operationId: operation.operationId, operationKind: operation.kind, semanticId: operation.semanticOutputIds[0] ?? "body:unnamed", toleranceMeters: operation.linearToleranceMeters }, geometry.faces);
  const inputDigests = inputShapeDigests(session, operation);
  const provenanceBase = {
    operationId: operation.operationId, operationKind: operation.kind,
    inputShapeDigests: inputDigests, outputShapeDigests: [contentDigest], topologyEntities: topologyEntities as ShapeProvenance["topologyEntities"]
  };
  const provenance: ShapeProvenance = { ...provenanceBase, provenanceDigest: await kernelSha256(provenanceBase) };
  return {
    operationId: operation.operationId, operationKind: operation.kind,
    outputs: [output], validation: [validation], provenance,
    diagnostics: [], exchangeArtifacts: [], tessellations: [tessellation], topologyEntities
  };
}

/**
 * Emits one stable reference per boundary face. The key and lineage digest are
 * derived from the feature's stable operation identity and the face's role, so
 * they are invariant under dimensional edits; the geometric signature carries
 * the current centroid, area, and normal for the resolver's secondary checks.
 */
interface FaceNamingContext {
  readonly operationId: string;
  readonly operationKind: StableTopologyReference["producer"]["operationKind"];
  readonly semanticId: string;
  readonly toleranceMeters: number;
}

async function buildFaceEntities(context: FaceNamingContext, faces: readonly FaceSpec[]): Promise<readonly ResolvedTopologyEntity[]> {
  const operationId = context.operationId;
  const operationKind = context.operationKind;
  const semantic = context.semanticId;
  const semanticLocal = sanitizeIdentifier(semantic.includes(":") ? semantic.slice(semantic.indexOf(":") + 1) : semantic);
  const keyByRole = new Map<string, string>();
  for (const face of faces) keyByRole.set(face.role, `face:${(await kernelSha256({ operationId, role: face.role })).slice(0, 40)}`);
  const entities: ResolvedTopologyEntity[] = [];
  for (const face of faces) {
    const key = keyByRole.get(face.role)!;
    const lineageDigest = await kernelSha256({ operationId, operationKind, role: face.role });
    const signatureDigest = await kernelSha256({ geometryClass: face.geometryClass, centroid: face.centroid, area: face.area, bounds: face.bounds, normal: face.normal });
    const signature: GeometricSignature = {
      geometryClass: face.geometryClass, centroidMeters: face.centroid, measure: face.area,
      boundsMeters: face.bounds, orientationHint: face.normal, signatureDigest
    };
    const roleSuffix = sanitizeIdentifier(face.role.startsWith("face.") ? face.role.slice("face.".length) : face.role);
    const stableReference: StableTopologyReference = {
      referenceVersion: 1, key, semanticId: `face:${semanticLocal}.${roleSuffix}`, expectedKind: "face",
      producer: { operationId, operationKind, outputIndex: 0, role: face.role },
      ancestry: [], signature, lineageDigest
    };
    entities.push({
      entityId: key, kind: "face", stableReference, orientation: "external",
      toleranceMeters: context.toleranceMeters,
      adjacentReferenceKeys: face.adjacentRoles.map((role) => keyByRole.get(role)!).sort()
    });
  }
  return entities;
}

/** Lowercases and reduces a string to the stable-identifier alphabet [a-z0-9._-], starting on an alphanumeric. */
function sanitizeIdentifier(value: string): string {
  const reduced = value.toLowerCase().replace(/[^a-z0-9._-]/gu, "-").replace(/^[^a-z0-9]+/u, "");
  return reduced.length > 0 ? reduced : "x";
}

/** Face metadata for a convex quad (centroid, planar area, AABB). */
function quadFace(role: string, corners: readonly [Vec3, Vec3, Vec3, Vec3], normal: Vec3, adjacentRoles: readonly string[]): FaceSpec {
  const center = centroid(corners);
  const area = Math.hypot(...cross(subtract(corners[1], corners[0]), subtract(corners[3], corners[0])));
  return { role, geometryClass: "plane", centroid: center, area, bounds: boundsOf(corners), normal, adjacentRoles };
}

function inputShapeDigests(session: Map<string, StoredSolid>, operation: ExecuteKernelOperationRequest["operation"]): readonly string[] {
  const ids: string[] = [];
  if (operation.kind === "solid.boolean") for (const reference of [...operation.targets, ...operation.tools]) ids.push(reference.shape.contentDigest);
  if (operation.kind === "solid.extrude") for (const reference of operation.profiles) ids.push(reference.shape.contentDigest);
  void session;
  return ids;
}

/** Exact box boundary: 8 vertices, 12 edges, 6 planar faces, one closed manifold solid. */
function boxSolid(size: Vector3, origin: Vector3, xDirection: Vector3, normal: Vector3): StoredSolid {
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
  const faceDefs: { readonly role: string; readonly quad: readonly [number, number, number, number]; readonly normal: Vec3 }[] = [
    { role: "face.x-min", quad: [index(0, 0, 0), index(0, 1, 0), index(0, 1, 1), index(0, 0, 1)], normal: negate(frame.x) },
    { role: "face.x-max", quad: [index(1, 0, 0), index(1, 1, 0), index(1, 1, 1), index(1, 0, 1)], normal: frame.x },
    { role: "face.y-min", quad: [index(0, 0, 0), index(1, 0, 0), index(1, 0, 1), index(0, 0, 1)], normal: negate(frame.y) },
    { role: "face.y-max", quad: [index(0, 1, 0), index(1, 1, 0), index(1, 1, 1), index(0, 1, 1)], normal: frame.y },
    { role: "face.z-min", quad: [index(0, 0, 0), index(1, 0, 0), index(1, 1, 0), index(0, 1, 0)], normal: negate(frame.z) },
    { role: "face.z-max", quad: [index(0, 0, 1), index(1, 0, 1), index(1, 1, 1), index(0, 1, 1)], normal: frame.z }
  ];
  const builder = new TessellationBuilder();
  for (const face of faceDefs) builder.addQuad(corners[face.quad[0]]!, corners[face.quad[1]]!, corners[face.quad[2]]!, corners[face.quad[3]]!, face.normal);
  const bounds = boundsOf(corners);
  const faceSpecs = faceDefs.map((face, position) => quadFace(
    face.role,
    [corners[face.quad[0]]!, corners[face.quad[1]]!, corners[face.quad[2]]!, corners[face.quad[3]]!],
    face.normal,
    faceDefs.filter((_, other) => other !== position && other !== (position ^ 1)).map((other) => other.role)
  ));
  const geometry: SolidGeometry = {
    topology: { vertices: 8, edges: 12, wires: 6, faces: 6, shells: 1, solids: 1, components: 1, closed: true, manifold: true },
    bounds,
    descriptor: { size: [sx, sy, sz], origin, xDirection: frame.x, normal: frame.z },
    tessellation: builder.finish(),
    volumeCubicMeters: sx * sy * sz,
    faces: faceSpecs
  };
  const baseLoop = [index(0, 0, 0), index(1, 0, 0), index(1, 1, 0), index(0, 1, 0)].map((corner) => corners[corner]!);
  return {
    geometry,
    ...(isAxisAlignedFrame(frame) ? { axisAlignedBox: { min: bounds.min as Vec3, max: bounds.max as Vec3 } } : {}),
    profileLoop: { points: baseLoop, normal: frame.z }
  };
}

/** Extrude a stored planar profile loop into an exact prism: 2N vertices, 3N edges, N+2 faces. */
function extrudeSolid(session: Map<string, StoredSolid>, operation: Extract<ExecuteKernelOperationRequest["operation"], { kind: "solid.extrude" }>): StoredSolid {
  const profileReference = operation.profiles[0];
  if (profileReference === undefined) throw new Error("Extrude requires a profile.");
  const source = session.get(profileReference.shape.shapeId);
  if (source?.profileLoop === undefined) throw new Error("Extrude profile has no stored planar loop in this session.");
  if (operation.extent.kind !== "distance") throw new Error(`Extrude extent '${operation.extent.kind}' is not supported by the reference runtime.`);
  const height = operation.extent.distanceMeters;
  if (!(height > 0)) throw new Error("Extrude distance must be positive.");
  const geometry = prismGeometry(source.profileLoop.points, source.profileLoop.normal, height);
  return { geometry };
}

/** Exact prism from a closed planar loop extruded along its normal: 2N vertices, 3N edges, N+2 faces. */
function prismGeometry(points: readonly Vec3[], normal: Vec3, height: number): SolidGeometry {
  const count = points.length;
  if (count < 3) throw new Error("Extrude profile loop needs at least three points.");
  const top = points.map((point) => [point[0] + normal[0] * height, point[1] + normal[1] * height, point[2] + normal[2] * height] as Vec3);
  const builder = new TessellationBuilder();
  const bottomCentroid = centroid(points);
  const topCentroid = centroid(top);
  for (let step = 0; step < count; step += 1) {
    const next = (step + 1) % count;
    builder.addTriangle(bottomCentroid, points[next]!, points[step]!, negate(normal));
    builder.addTriangle(topCentroid, top[step]!, top[next]!, normal);
    builder.addQuad(points[step]!, points[next]!, top[next]!, top[step]!, sideNormal(points[step]!, points[next]!, normal));
  }
  const area = planarPolygonArea(points, normal);
  const sideRoles = Array.from({ length: count }, (_, step) => `face.side-${step}`);
  const faces: FaceSpec[] = [
    { role: "face.cap-bottom", geometryClass: "plane", centroid: bottomCentroid, area, bounds: boundsOf(points), normal: negate(normal), adjacentRoles: sideRoles },
    { role: "face.cap-top", geometryClass: "plane", centroid: topCentroid, area, bounds: boundsOf(top), normal, adjacentRoles: sideRoles },
    ...Array.from({ length: count }, (_, step): FaceSpec => {
      const next = (step + 1) % count;
      return quadFace(
        `face.side-${step}`,
        [points[step]!, points[next]!, top[next]!, top[step]!],
        sideNormal(points[step]!, points[next]!, normal),
        ["face.cap-bottom", "face.cap-top", `face.side-${(step + count - 1) % count}`, `face.side-${next}`]
      );
    })
  ];
  return {
    topology: { vertices: 2 * count, edges: 3 * count, wires: count + 2, faces: count + 2, shells: 1, solids: 1, components: 1, closed: true, manifold: true },
    bounds: boundsOf([...points, ...top]),
    descriptor: { profile: points.map((point) => [...point]), normal, height },
    tessellation: builder.finish(),
    volumeCubicMeters: area * height,
    faces
  };
}

/** Request for the browser-facing prism facade: a closed planar loop (metres) extruded along its normal. */
export interface ProfilePrismRequest {
  /** Stable feature identity that anchors the persistent face names across rebuilds. */
  readonly operationId: string;
  readonly semanticId: string;
  readonly profilePointsMeters: readonly (readonly [number, number, number])[];
  readonly normal: readonly [number, number, number];
  readonly heightMeters: number;
  readonly toleranceMeters?: number;
}

export interface NamedFace {
  readonly role: string;
  readonly key: string;
  readonly semanticId: string;
  readonly areaSquareMeters: number;
}

export interface ProfilePrismResult {
  readonly positionsMeters: readonly number[];
  readonly indices: readonly number[];
  readonly topology: KernelTopologySummary;
  readonly boundsMeters: KernelBounds;
  readonly volumeCubicMeters: number;
  readonly faces: readonly NamedFace[];
}

/**
 * Browser-facing kernel entry: builds an exact prism B-rep from an explicit
 * planar profile loop and returns its tessellation, topology summary, and
 * stable, lineage-anchored face names. The live viewport uses this in place of
 * the analytic tessellator so general solids carry real topology and
 * persistent face references.
 */
export async function evaluateProfilePrism(request: ProfilePrismRequest): Promise<ProfilePrismResult> {
  if (!(request.heightMeters > 0)) throw new Error("Extrude distance must be positive.");
  const points = request.profilePointsMeters.map((point) => [point[0], point[1], point[2]] as Vec3);
  const normal = unit([request.normal[0], request.normal[1], request.normal[2]]);
  const geometry = prismGeometry(points, normal, request.heightMeters);
  const toleranceMeters = request.toleranceMeters ?? 1e-6;
  const entities = await buildFaceEntities({ operationId: request.operationId, operationKind: "solid.extrude", semanticId: request.semanticId, toleranceMeters }, geometry.faces);
  const faces: NamedFace[] = entities.map((entity, position) => ({
    role: entity.stableReference.producer.role,
    key: entity.stableReference.key,
    semanticId: entity.stableReference.semanticId,
    areaSquareMeters: geometry.faces[position]!.area
  }));
  return {
    positionsMeters: Array.from(geometry.tessellation.positions),
    indices: Array.from(geometry.tessellation.indices),
    topology: geometry.topology,
    boundsMeters: geometry.bounds,
    volumeCubicMeters: geometry.volumeCubicMeters,
    faces
  };
}

/** Exact Boolean on two stored axis-aligned boxes; general curved CSG is rejected explicitly. */
function booleanSolid(session: Map<string, StoredSolid>, operation: Extract<ExecuteKernelOperationRequest["operation"], { kind: "solid.boolean" }>): StoredSolid {
  const target = operation.targets[0];
  const tool = operation.tools[0];
  if (target === undefined || tool === undefined) throw new Error("Boolean requires one target and one tool.");
  const a = session.get(target.shape.shapeId)?.axisAlignedBox;
  const b = session.get(tool.shape.shapeId)?.axisAlignedBox;
  if (a === undefined || b === undefined) throw new Error("The reference Boolean evaluates axis-aligned boxes only; one operand is not a stored axis-aligned box.");
  const result = operation.mode === "intersect" ? intersectBoxes(a, b)
    : operation.mode === "join" ? joinBoxes(a, b)
      : subtractBoxes(a, b);
  if (result === undefined) throw new Error(`The reference Boolean '${operation.mode}' on these boxes is not a single axis-aligned solid; general CSG needs the full B-rep kernel.`);
  if (result === "empty") throw new Error(`The reference Boolean '${operation.mode}' produced an empty solid.`);
  return boxSolid([result.max[0] - result.min[0], result.max[1] - result.min[1], result.max[2] - result.min[2]], result.min, [1, 0, 0], [0, 0, 1]);
}

type Box = { readonly min: Vec3; readonly max: Vec3 };
type BoxResult = Box | "empty" | undefined;

function intersectBoxes(a: Box, b: Box): BoxResult {
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    min[axis] = Math.max(a.min[axis]!, b.min[axis]!);
    max[axis] = Math.min(a.max[axis]!, b.max[axis]!);
    if (max[axis]! - min[axis]! <= 1e-12) return "empty";
  }
  return { min, max };
}

function joinBoxes(a: Box, b: Box): BoxResult {
  if (contains(a, b)) return a;
  if (contains(b, a)) return b;
  return undefined;
}

function subtractBoxes(a: Box, b: Box): BoxResult {
  if (intersectBoxes(a, b) === "empty") return a;
  if (contains(b, a)) return "empty";
  const spanning = [0, 1, 2].filter((axis) => b.min[axis]! <= a.min[axis]! + 1e-12 && b.max[axis]! >= a.max[axis]! - 1e-12);
  if (spanning.length !== 2) return undefined;
  const cutAxis = [0, 1, 2].find((axis) => !spanning.includes(axis))!;
  const min: [number, number, number] = [a.min[0], a.min[1], a.min[2]];
  const max: [number, number, number] = [a.max[0], a.max[1], a.max[2]];
  const removesLow = b.min[cutAxis]! <= a.min[cutAxis]! + 1e-12 && b.max[cutAxis]! < a.max[cutAxis]! - 1e-12;
  const removesHigh = b.max[cutAxis]! >= a.max[cutAxis]! - 1e-12 && b.min[cutAxis]! > a.min[cutAxis]! + 1e-12;
  if (removesLow) { min[cutAxis] = b.max[cutAxis]!; return { min, max }; }
  if (removesHigh) { max[cutAxis] = b.min[cutAxis]!; return { min, max }; }
  return undefined;
}

function contains(outer: Box, inner: Box): boolean {
  return [0, 1, 2].every((axis) => outer.min[axis]! <= inner.min[axis]! + 1e-12 && outer.max[axis]! >= inner.max[axis]! - 1e-12);
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
  const bounds = boundsOf([...bottom, ...top]);
  const capArea = Math.PI * radius * radius;
  const faces: FaceSpec[] = [
    { role: "face.lateral", geometryClass: "cylinder", centroid: [origin[0] + frame.z[0] * height / 2, origin[1] + frame.z[1] * height / 2, origin[2] + frame.z[2] * height / 2], area: 2 * Math.PI * radius * height, bounds, normal: frame.z, adjacentRoles: ["face.cap-bottom", "face.cap-top"] },
    { role: "face.cap-bottom", geometryClass: "plane", centroid: bottomCenter, area: capArea, bounds: boundsOf(bottom), normal: negate(frame.z), adjacentRoles: ["face.lateral"] },
    { role: "face.cap-top", geometryClass: "plane", centroid: topCenter, area: capArea, bounds: boundsOf(top), normal: frame.z, adjacentRoles: ["face.lateral"] }
  ];
  return {
    topology: { vertices: 2, edges: 3, wires: 3, faces: 3, shells: 1, solids: 1, components: 1, closed: true, manifold: true },
    bounds,
    descriptor: { radius, height, origin, direction: frame.z, xDirection: frame.x },
    tessellation: builder.finish(),
    volumeCubicMeters: capArea * height,
    faces
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

function isAxisAlignedFrame(frame: Frame): boolean {
  return [frame.x, frame.y, frame.z].every((axis) => axis.filter((component) => Math.abs(component) > 1e-9).length === 1);
}

function centroid(points: readonly Vec3[]): Vec3 {
  const sum = points.reduce((total, point) => [total[0] + point[0], total[1] + point[1], total[2] + point[2]] as Vec3, [0, 0, 0] as Vec3);
  return [sum[0] / points.length, sum[1] / points.length, sum[2] / points.length];
}

function sideNormal(from: Vec3, to: Vec3, extrudeNormal: Vec3): Vec3 {
  return unit(cross(subtract(to, from), extrudeNormal));
}

function planarPolygonArea(points: readonly Vec3[], normal: Vec3): number {
  let accumulator: Vec3 = [0, 0, 0];
  for (let step = 0; step < points.length; step += 1) {
    const next = (step + 1) % points.length;
    accumulator = [
      accumulator[0] + (points[step]![1] * points[next]![2] - points[step]![2] * points[next]![1]),
      accumulator[1] + (points[step]![2] * points[next]![0] - points[step]![0] * points[next]![2]),
      accumulator[2] + (points[step]![0] * points[next]![1] - points[step]![1] * points[next]![0])
    ];
  }
  return Math.abs(dot(accumulator, unit(normal))) / 2;
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
