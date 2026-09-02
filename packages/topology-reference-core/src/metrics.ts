import type { GeometricSignature, TopologyAncestry, Vector3 } from "../../exact-kernel-api/src/index.js";
import { compareStrings } from "./canonical.js";
import type {
  PersistentTopologyEntity,
  TopologyNeighborContext,
  TopologyResolutionPolicy
} from "./types.js";

export interface GeometryComparison {
  readonly geometryClassMatches: boolean;
  readonly centroidDeltaMeters: number;
  readonly boundsDeltaMeters: number;
  readonly relativeMeasureDelta: number;
  readonly orientationDeltaRadians: number | null;
  readonly analyticParameterDelta: number | null;
  readonly signatureDigestMatches: boolean;
}

export function compareGeometry(source: GeometricSignature, candidate: GeometricSignature): GeometryComparison {
  const sourceOrientation = source.orientationHint;
  const candidateOrientation = candidate.orientationHint;
  return {
    geometryClassMatches: source.geometryClass === candidate.geometryClass,
    centroidDeltaMeters: vectorDistance(source.centroidMeters, candidate.centroidMeters),
    boundsDeltaMeters: Math.max(
      maxCoordinateDelta(source.boundsMeters.min, candidate.boundsMeters.min),
      maxCoordinateDelta(source.boundsMeters.max, candidate.boundsMeters.max)
    ),
    relativeMeasureDelta: relativeDelta(source.measure, candidate.measure),
    orientationDeltaRadians: sourceOrientation === undefined || candidateOrientation === undefined
      ? null
      : vectorAngle(sourceOrientation, candidateOrientation),
    analyticParameterDelta: compareAnalyticParameters(source.analyticParameters, candidate.analyticParameters),
    signatureDigestMatches: source.signatureDigest === candidate.signatureDigest
  };
}

export function lineageRank(source: PersistentTopologyEntity, candidate: PersistentTopologyEntity): number | null {
  const sourceTracked = source.trackedReference;
  const candidateTracked = candidate.trackedReference;
  const sourceKernel = sourceTracked.kernelReference;
  const candidateKernel = candidateTracked.kernelReference;
  const sameFeature = sourceTracked.featureLineage.featureId === candidateTracked.featureLineage.featureId;
  const sameOperation = sourceTracked.featureLineage.operationId === candidateTracked.featureLineage.operationId;
  const sameKind = sourceTracked.featureLineage.operationKind === candidateTracked.featureLineage.operationKind;
  const sameRole = sourceTracked.featureLineage.role === candidateTracked.featureLineage.role;
  const sameSemanticId = sourceKernel.semanticId === candidateKernel.semanticId;

  if (sourceKernel.lineageDigest === candidateKernel.lineageDigest && sameKind && sameRole) return 0;
  if (sameFeature && sameOperation && sameKind && sameRole && sameSemanticId) return 1;
  if (sameFeature && sameKind && sameRole && sameSemanticId) return 2;
  // Semantic output names such as "end-face" are commonly reused by many
  // independent features. They are evidence only inside the same feature
  // lineage and must never bind an otherwise unrelated operation.
  if (sameKind && sameRole && ancestryOverlaps(sourceKernel.ancestry, candidateKernel.ancestry)) return 3;
  return null;
}

export function neighborhoodMismatch(
  source: readonly TopologyNeighborContext[],
  candidate: readonly TopologyNeighborContext[],
  policy: Readonly<TopologyResolutionPolicy>
): number {
  if (source.length === 0 && candidate.length === 0) return 0;
  const sortedSource = [...source].sort(compareNeighbors);
  const sortedCandidate = [...candidate].sort(compareNeighbors);
  const pairs = sortedSource.flatMap((sourceNeighbor, sourceIndex) => sortedCandidate.map((candidateNeighbor, candidateIndex) => ({
    sourceIndex,
    candidateIndex,
    cost: neighborCost(sourceNeighbor, candidateNeighbor, policy.relativeMeasureTolerance),
    tieBreak: `${neighborKey(sourceNeighbor)}\u0000${neighborKey(candidateNeighbor)}`
  }))).filter((pair) => Number.isFinite(pair.cost)).sort((first, second) => first.cost - second.cost
    || compareStrings(first.tieBreak, second.tieBreak));
  const matchedSource = new Set<number>();
  const matchedCandidate = new Set<number>();
  let total = 0;
  for (const pair of pairs) {
    if (matchedSource.has(pair.sourceIndex) || matchedCandidate.has(pair.candidateIndex)) continue;
    matchedSource.add(pair.sourceIndex);
    matchedCandidate.add(pair.candidateIndex);
    total += Math.min(1, pair.cost);
  }
  total += sortedSource.length - matchedSource.size;
  total += sortedCandidate.length - matchedCandidate.size;
  return Math.min(1, total / Math.max(source.length, candidate.length, 1));
}

export function normalizedGeometryScore(
  comparison: GeometryComparison,
  sourceToleranceMeters: number,
  candidateToleranceMeters: number,
  policy: Readonly<TopologyResolutionPolicy>
): number {
  if (comparison.signatureDigestMatches) return 0;
  const centroidGate = policy.centroidToleranceMeters + sourceToleranceMeters + candidateToleranceMeters;
  const boundsGate = policy.boundsToleranceMeters + sourceToleranceMeters + candidateToleranceMeters;
  const values = [
    comparison.centroidDeltaMeters / centroidGate,
    comparison.boundsDeltaMeters / boundsGate,
    comparison.relativeMeasureDelta / policy.relativeMeasureTolerance
  ];
  if (comparison.orientationDeltaRadians !== null) values.push(comparison.orientationDeltaRadians / policy.angularToleranceRadians);
  if (comparison.analyticParameterDelta !== null) values.push(comparison.analyticParameterDelta / policy.analyticParameterTolerance);
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function ancestryOverlaps(first: readonly TopologyAncestry[], second: readonly TopologyAncestry[]): boolean {
  for (const source of first) {
    for (const target of second) {
      if (source.relation !== target.relation) continue;
      if (source.sourceShapeDigest === target.sourceShapeDigest) return true;
      const targetKeys = new Set(target.sourceReferenceKeys);
      if (source.sourceReferenceKeys.some((key) => targetKeys.has(key))) return true;
    }
  }
  return false;
}

function neighborCost(source: TopologyNeighborContext, candidate: TopologyNeighborContext, measureTolerance: number): number {
  if (source.kind !== candidate.kind || source.geometryClass !== candidate.geometryClass) return Number.POSITIVE_INFINITY;
  let cost = 0;
  if (source.semanticId !== candidate.semanticId) cost += 0.45;
  if (source.producerRole !== candidate.producerRole) cost += 0.3;
  cost += Math.min(0.25, relativeDelta(source.measure, candidate.measure) / Math.max(measureTolerance, Number.EPSILON) * 0.25);
  return cost;
}

function compareNeighbors(first: TopologyNeighborContext, second: TopologyNeighborContext): number {
  return compareStrings(neighborKey(first), neighborKey(second));
}

function neighborKey(value: TopologyNeighborContext): string {
  return `${value.kind}\u0000${value.semanticId}\u0000${value.producerRole}\u0000${value.geometryClass}\u0000${value.measure}`;
}

function compareAnalyticParameters(
  source: Readonly<Record<string, number>> | undefined,
  candidate: Readonly<Record<string, number>> | undefined
): number | null {
  if (source === undefined && candidate === undefined) return null;
  if (source === undefined || candidate === undefined) return Number.POSITIVE_INFINITY;
  const keys = [...new Set([...Object.keys(source), ...Object.keys(candidate)])].sort(compareStrings);
  let maximum = 0;
  for (const key of keys) {
    const first = source[key];
    const second = candidate[key];
    if (first === undefined || second === undefined) return Number.POSITIVE_INFINITY;
    maximum = Math.max(maximum, relativeDelta(first, second));
  }
  return maximum;
}

function vectorDistance(first: Vector3, second: Vector3): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1], first[2] - second[2]);
}

function maxCoordinateDelta(first: Vector3, second: Vector3): number {
  return Math.max(Math.abs(first[0] - second[0]), Math.abs(first[1] - second[1]), Math.abs(first[2] - second[2]));
}

function vectorAngle(first: Vector3, second: Vector3): number {
  const firstLength = Math.hypot(...first);
  const secondLength = Math.hypot(...second);
  if (firstLength <= Number.EPSILON || secondLength <= Number.EPSILON) return Number.POSITIVE_INFINITY;
  const dot = (first[0] * second[0] + first[1] * second[1] + first[2] * second[2]) / (firstLength * secondLength);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

function relativeDelta(first: number, second: number): number {
  return Math.abs(first - second) / Math.max(Math.abs(first), Math.abs(second), 1e-15);
}
