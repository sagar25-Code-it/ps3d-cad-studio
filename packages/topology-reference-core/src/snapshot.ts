import type { GeometricSignature } from "../../exact-kernel-api/src/index.js";
import { compareStrings } from "./canonical.js";
import {
  isPersistentSubshapeKind,
  type CreateTopologySnapshotInput,
  type PersistentTopologyEntity,
  type TopologyNeighborContext,
  type TopologyRevisionSnapshot,
  type TrackedTopologyReference
} from "./types.js";

/**
 * Converts complete exact-kernel topology provenance into a revision snapshot.
 * Missing adjacency is rejected because a partial neighborhood can produce an
 * unsafe unique match where the complete graph would be ambiguous.
 */
export function createTopologyRevisionSnapshot(input: CreateTopologySnapshotInput): TopologyRevisionSnapshot {
  assertNonNegativeInteger(input.documentRevision, "documentRevision");
  assertNonNegativeInteger(input.topologyRevision, "topologyRevision");
  assertDigest(input.shapeDigest, "shapeDigest");

  const byKernelKey = new Map(input.associations.map((association) => [association.kernelEntity.stableReference.key, association]));
  if (byKernelKey.size !== input.associations.length) throw new TypeError("Topology associations contain duplicate stable reference keys.");

  const entities = input.associations.map((association): PersistentTopologyEntity => {
    const kernel = association.kernelEntity;
    if (!isPersistentSubshapeKind(kernel.kind)) {
      throw new TypeError(`Persistent references support vertex, edge, and face topology; received '${kernel.kind}'.`);
    }
    if (association.documentReference.bodyId !== input.bodyId) throw new TypeError("A topology association belongs to another body.");
    if (association.documentReference.subshape !== kernel.kind) throw new TypeError("Canonical and kernel topology kinds disagree.");
    if (association.documentReference.sourceFeatureId !== association.featureLineage.featureId) {
      throw new TypeError("Canonical reference and semantic feature lineage disagree.");
    }
    if (association.featureLineage.operationId !== kernel.stableReference.producer.operationId
      || association.featureLineage.operationKind !== kernel.stableReference.producer.operationKind
      || association.featureLineage.role !== kernel.stableReference.producer.role) {
      throw new TypeError("Feature lineage does not match exact-kernel provenance.");
    }
    if (association.createdDocumentRevision > input.documentRevision) throw new TypeError("A reference cannot be created after its snapshot revision.");

    const neighbors = kernel.adjacentReferenceKeys.map((referenceKey): TopologyNeighborContext => {
      const neighbor = byKernelKey.get(referenceKey);
      if (neighbor === undefined) throw new TypeError(`Adjacency reference '${referenceKey}' is absent from the topology snapshot.`);
      if (!isPersistentSubshapeKind(neighbor.kernelEntity.kind)) throw new TypeError("Adjacency includes unsupported topology.");
      const stable = neighbor.kernelEntity.stableReference;
      return Object.freeze({
        kind: neighbor.kernelEntity.kind,
        semanticId: stable.semanticId,
        producerRole: stable.producer.role,
        geometryClass: stable.signature.geometryClass,
        measure: stable.signature.measure
      });
    }).sort(compareNeighborContexts);

    const trackedReference: TrackedTopologyReference = Object.freeze({
      referenceVersion: 1,
      documentReference: association.documentReference,
      kernelReference: kernel.stableReference,
      featureLineage: association.featureLineage,
      createdDocumentRevision: association.createdDocumentRevision
    });
    return Object.freeze({
      entityId: kernel.entityId,
      kind: kernel.kind,
      trackedReference,
      orientation: kernel.orientation,
      toleranceMeters: kernel.toleranceMeters,
      neighbors: Object.freeze(neighbors)
    });
  }).sort((first, second) => compareStrings(
    first.trackedReference.kernelReference.key,
    second.trackedReference.kernelReference.key
  ));

  return Object.freeze({
    snapshotVersion: 1,
    projectId: input.projectId,
    documentRevision: input.documentRevision,
    bodyId: input.bodyId,
    topologyRevision: input.topologyRevision,
    shapeDigest: input.shapeDigest,
    entities: Object.freeze(entities)
  });
}

function compareNeighborContexts(first: TopologyNeighborContext, second: TopologyNeighborContext): number {
  return compareStrings(neighborKey(first), neighborKey(second));
}

function neighborKey(neighbor: TopologyNeighborContext): string {
  return `${neighbor.kind}\u0000${neighbor.semanticId}\u0000${neighbor.producerRole}\u0000${neighbor.geometryClass}\u0000${neighbor.measure}`;
}

function assertNonNegativeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} must be a non-negative safe integer.`);
}

function assertDigest(value: string, label: string): void {
  if (!/^[a-z0-9][a-z0-9:._-]{2,255}$/u.test(value)) throw new TypeError(`${label} is not a stable digest identifier.`);
}

export function signatureOf(entity: PersistentTopologyEntity): GeometricSignature {
  return entity.trackedReference.kernelReference.signature;
}
