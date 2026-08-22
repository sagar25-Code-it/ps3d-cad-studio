import { fail, type Result } from "../../model-schema/src/index.js";

export interface BracketSolidRequest {
  readonly bodyId: string;
  readonly widthMeters: number;
  readonly heightMeters: number;
  readonly thicknessMeters: number;
  readonly holeDiameterMeters: number;
  readonly circularSegments: 96;
}

export interface SolidBounds {
  readonly min: readonly [number, number, number];
  readonly max: readonly [number, number, number];
  readonly size: readonly [number, number, number];
}

export interface SolidTopology {
  readonly vertices: number;
  readonly edges: number;
  readonly triangles: number;
  readonly components: number;
  readonly genus: number;
  readonly closed: true;
  readonly manifold: true;
  readonly consistentlyOriented: true;
}

export interface SolidMeasurements {
  readonly boundsMeters: SolidBounds;
  readonly surfaceAreaSquareMeters: number;
  readonly volumeCubicMeters: number;
}

export interface RenderMesh {
  readonly positions: Float32Array;
  readonly indices: Uint32Array;
}

export interface ModelMesh {
  readonly positions: Float64Array;
  readonly indices: Uint32Array;
}

export interface EvaluatedSolid {
  readonly bodyId: string;
  readonly engineProfile: string;
  readonly kernelIdentity: KernelIdentity;
  readonly mesh: ModelMesh;
  readonly measurements: SolidMeasurements;
  readonly topology: SolidTopology;
  readonly toleranceMeters: number;
}

export interface KernelIdentity {
  readonly adapter: string;
  readonly adapterVersion: string;
  readonly dependency: string;
  readonly dependencyVersion: string;
  readonly representation: "closed-oriented-manifold-triangle-mesh";
}

export interface SolidKernel {
  readonly profile: KernelIdentity;
  buildBracket(request: BracketSolidRequest): Promise<Result<EvaluatedSolid>>;
}

export interface ValidatedMesh {
  readonly measurements: SolidMeasurements;
  readonly topology: SolidTopology;
}

const MAX_TRIANGLES = 250_000;
const MIN_TRIANGLE_DOUBLE_AREA = 1e-18;
const MIN_VOLUME = 1e-15;

export function validateClosedMesh(mesh: ModelMesh): Result<ValidatedMesh> {
  const { positions, indices } = mesh;
  if (positions.length === 0 || positions.length % 3 !== 0 || indices.length === 0 || indices.length % 3 !== 0) {
    return fail("INVALID_SOLID_OUTPUT", "The evaluated mesh has an invalid buffer shape.", [], "Restore the last valid parameters and retry.");
  }
  if (indices.length / 3 > MAX_TRIANGLES) {
    return fail("RESOURCE_LIMIT", "The evaluated mesh exceeds the Phase 0 triangle limit.", [], "Use the fixed 96-segment bore profile.");
  }
  for (const coordinate of positions) {
    if (!Number.isFinite(coordinate)) return fail("INVALID_SOLID_OUTPUT", "The evaluated mesh contains a non-finite coordinate.", [], "Restore the last valid parameters.");
  }

  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  const edgeIncidence = new Map<string, { count: number; balance: number }>();
  const usedVertices = new Set<number>();
  const parent = Array.from({ length: vertexCount }, (_, index) => index);
  const minimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  const maximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
  let area = 0;
  let areaCompensation = 0;
  let volume = 0;
  let volumeCompensation = 0;

  for (let offset = 0; offset < positions.length; offset += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const coordinate = positions[offset + axis]!;
      minimum[axis] = Math.min(minimum[axis]!, coordinate);
      maximum[axis] = Math.max(maximum[axis]!, coordinate);
    }
  }

  for (let offset = 0; offset < indices.length; offset += 3) {
    const a = indices[offset]!;
    const b = indices[offset + 1]!;
    const c = indices[offset + 2]!;
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount || a === b || b === c || c === a) {
      return fail("INVALID_SOLID_OUTPUT", "A triangle has invalid or repeated vertex indices.", [], "Restore the last valid parameters.");
    }
    const av = point(positions, a);
    const bv = point(positions, b);
    const cv = point(positions, c);
    const ab = subtract(bv, av);
    const ac = subtract(cv, av);
    const crossProduct = cross(ab, ac);
    const doubleArea = Math.hypot(...crossProduct);
    if (doubleArea <= MIN_TRIANGLE_DOUBLE_AREA) {
      return fail("INVALID_SOLID_OUTPUT", "The evaluated mesh contains a degenerate triangle.", [], "Use dimensions farther from the supported boundary.");
    }
    [area, areaCompensation] = compensatedAdd(area, areaCompensation, doubleArea / 2);
    [volume, volumeCompensation] = compensatedAdd(volume, volumeCompensation, dot(av, cross(bv, cv)) / 6);
    addEdge(edgeIncidence, a, b);
    addEdge(edgeIncidence, b, c);
    addEdge(edgeIncidence, c, a);
    usedVertices.add(a);
    usedVertices.add(b);
    usedVertices.add(c);
    union(parent, a, b);
    union(parent, b, c);
  }

  for (const incidence of edgeIncidence.values()) {
    if (incidence.count !== 2 || incidence.balance !== 0) {
      return fail("INVALID_SOLID_OUTPUT", "The evaluated body is open, non-manifold, or inconsistently oriented.", [], "Restore the last valid parameters.");
    }
  }
  if (volume <= MIN_VOLUME) {
    return fail("INVALID_SOLID_OUTPUT", "The evaluated body has non-positive or negligible signed volume.", [], "Restore the last valid parameters.");
  }

  const componentRoots = new Set<number>();
  for (const vertex of usedVertices) componentRoots.add(find(parent, vertex));
  const components = componentRoots.size;
  const eulerCharacteristic = usedVertices.size - edgeIncidence.size + triangleCount;
  const genusRaw = (2 * components - eulerCharacteristic) / 2;
  const genus = Math.round(genusRaw);
  if (!Number.isInteger(genusRaw) || genus < 0) {
    return fail("INVALID_SOLID_OUTPUT", "The evaluated topology has an invalid Euler characteristic.", [], "Restore the last valid parameters.");
  }

  const minTuple = minimum as [number, number, number];
  const maxTuple = maximum as [number, number, number];
  return {
    ok: true,
    value: {
      measurements: {
        boundsMeters: {
          min: minTuple,
          max: maxTuple,
          size: [maxTuple[0] - minTuple[0], maxTuple[1] - minTuple[1], maxTuple[2] - minTuple[2]]
        },
        surfaceAreaSquareMeters: area,
        volumeCubicMeters: volume
      },
      topology: {
        vertices: usedVertices.size,
        edges: edgeIncidence.size,
        triangles: triangleCount,
        components,
        genus,
        closed: true,
        manifold: true,
        consistentlyOriented: true
      }
    }
  };
}

function point(positions: Float64Array, index: number): [number, number, number] {
  const offset = index * 3;
  return [positions[offset]!, positions[offset + 1]!, positions[offset + 2]!];
}

function subtract(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}

function cross(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

function compensatedAdd(sum: number, compensation: number, value: number): [number, number] {
  const adjusted = value - compensation;
  const next = sum + adjusted;
  return [next, (next - sum) - adjusted];
}

function addEdge(map: Map<string, { count: number; balance: number }>, start: number, end: number): void {
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  const key = `${low}:${high}`;
  const existing = map.get(key) ?? { count: 0, balance: 0 };
  existing.count += 1;
  existing.balance += start === low ? 1 : -1;
  map.set(key, existing);
}

function find(parent: number[], node: number): number {
  let current = node;
  while (parent[current] !== current) {
    parent[current] = parent[parent[current]!]!;
    current = parent[current]!;
  }
  return current;
}

function union(parent: number[], a: number, b: number): void {
  const rootA = find(parent, a);
  const rootB = find(parent, b);
  if (rootA !== rootB) parent[Math.max(rootA, rootB)] = Math.min(rootA, rootB);
}
