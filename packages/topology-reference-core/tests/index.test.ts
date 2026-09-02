import assert from "node:assert/strict";
import test from "node:test";
import {
  createCadId,
  type BodyId,
  type FeatureId,
  type ProjectId,
  type TopologyReference
} from "../../cad-document-core/src/index.js";
import type { GeometricSignature, StableTopologyReference } from "../../exact-kernel-api/src/index.js";
import {
  neighborhoodMismatch,
  resolvePersistentTopologyReference,
  type PersistentTopologyEntity,
  type TopologyNeighborContext,
  type TopologyResolutionRequest,
  type TopologyRevisionSnapshot
} from "../src/index.js";

const projectId = createCadId("project", "topology-tests");
const bodyId = createCadId("body", "bracket");
const featureId = createCadId("feature", "base-extrude");

test("an unchanged stable key resolves exactly after revision recomputation", async () => {
  const source = entity({ key: "reference:end-face", entityId: "old-face" });
  const target = entity({
    key: "reference:end-face",
    entityId: "new-transient-face",
    centroid: [0.05, 0, 0],
    boundsMin: [0.05, -0.5, -0.5],
    boundsMax: [0.05, 0.5, 0.5]
  });
  const result = await resolvePersistentTopologyReference(request(snapshot(1, [source]), snapshot(2, [target])));

  assert.equal(result.outcome, "exact");
  assert.equal(result.selected?.entityId, "new-transient-face");
  assert.equal(result.receipt.selectedReferenceKey, "reference:end-face");
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.candidates), true);
});

test("recovery is stable when a kernel changes topology enumeration order", async () => {
  const source = entity({ key: "reference:old-end", entityId: "old-face" });
  const match = entity({ key: "reference:new-end", entityId: "target-face" });
  const unrelated = entity({
    key: "reference:side-face",
    entityId: "other-face",
    semanticId: "semantic:side-face",
    role: "extrude:side-face",
    lineageDigest: "lineage:side-face",
    centroid: [0.05, 0, 0]
  });
  const first = await resolvePersistentTopologyReference(request(snapshot(1, [source]), snapshot(2, [unrelated, match])));
  const second = await resolvePersistentTopologyReference(request(snapshot(1, [source]), snapshot(2, [match, unrelated])));

  assert.equal(first.outcome, "unique-recovered");
  assert.equal(first.selected?.trackedReference.kernelReference.key, "reference:new-end");
  assert.equal(second.selected?.trackedReference.kernelReference.key, "reference:new-end");
  assert.equal(first.receipt.requestDigest, second.receipt.requestDigest);
  assert.equal(first.receipt.resultDigest, second.receipt.resultDigest);
});

test("symmetric equivalent faces remain explicitly ambiguous", async () => {
  const source = entity({ key: "reference:old-symmetric", entityId: "old-face" });
  const first = entity({ key: "reference:symmetric-a", entityId: "candidate-a" });
  const second = entity({ key: "reference:symmetric-b", entityId: "candidate-b" });
  const result = await resolvePersistentTopologyReference(request(snapshot(1, [source]), snapshot(2, [second, first])));

  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.selected, null);
  assert.deepEqual(
    result.ambiguousCandidates.map((candidate) => candidate.trackedReference.kernelReference.key),
    ["reference:symmetric-a", "reference:symmetric-b"]
  );
  assert.equal(result.diagnostics.some((item) => item.code === "REFERENCE_AMBIGUOUS"), true);
});

test("deleted topology returns missing rather than selecting an unrelated face", async () => {
  const source = entity({ key: "reference:deleted-face", entityId: "old-face" });
  const unrelated = entity({
    key: "reference:remaining-face",
    entityId: "remaining",
    semanticId: "semantic:remaining",
    role: "extrude:side-face",
    lineageDigest: "lineage:remaining"
  });
  const result = await resolvePersistentTopologyReference(request(snapshot(1, [source]), snapshot(2, [unrelated])));

  assert.equal(result.outcome, "missing");
  assert.equal(result.selected, null);
  assert.equal(result.receipt.selectedReferenceKey, null);
});

test("same operation kind, role and output index cannot rebind an unrelated feature", async () => {
  const source = entity({ key: "reference:deleted-output", entityId: "old-output" });
  const unrelated = entity({
    key: "reference:other-extrude-output",
    entityId: "other-output",
    semanticId: "semantic:other-end",
    lineageDigest: "lineage:other-extrude",
    featureId: createCadId("feature", "other-extrude"),
    operationId: "operation:other-extrude"
  });
  const result = await resolvePersistentTopologyReference(request(snapshot(1, [source]), snapshot(2, [unrelated])));

  assert.equal(result.outcome, "missing");
  assert.equal(result.selected, null);
  assert.equal(result.candidates[0]?.lineageRank, null);
  assert.equal(result.candidates[0]?.rejectionReasons.includes("lineage"), true);
});

test("a reused semantic output ID cannot rebind an unrelated feature", async () => {
  const source = entity({ key: "reference:deleted-semantic", entityId: "old-output" });
  const unrelated = entity({
    key: "reference:other-semantic-output",
    entityId: "other-output",
    semanticId: "semantic:end-face",
    lineageDigest: "lineage:other-extrude",
    featureId: createCadId("feature", "other-semantic-extrude"),
    operationId: "operation:other-semantic-extrude"
  });
  const result = await resolvePersistentTopologyReference(request(snapshot(1, [source]), snapshot(2, [unrelated])));

  assert.equal(result.outcome, "missing");
  assert.equal(result.selected, null);
  assert.equal(result.candidates[0]?.lineageRank, null);
  assert.equal(result.candidates[0]?.rejectionReasons.includes("lineage"), true);
});

test("neighborhood mismatch is symmetric and counts every unmatched neighbor once", () => {
  const first = [neighbor("semantic:edge-a", 1), neighbor("semantic:edge-b", 2)];
  const second = [neighbor("semantic:edge-a", 1)];
  const policy = {
    centroidToleranceMeters: 1e-4,
    boundsToleranceMeters: 1e-4,
    relativeMeasureTolerance: 0.02,
    angularToleranceRadians: 0.02,
    analyticParameterTolerance: 0.02,
    maximumEntityToleranceMeters: 1e-3,
    maximumNeighborhoodMismatch: 1,
    ambiguityScoreEpsilon: 1e-9
  };
  const forward = neighborhoodMismatch(first, second, policy);
  const reverse = neighborhoodMismatch(second, first, policy);
  assert.equal(forward, 0.5);
  assert.equal(reverse, forward);
});

test("a lineage match outside geometric tolerance is rejected", async () => {
  const source = entity({ key: "reference:old-close", entityId: "old-face" });
  const distant = entity({
    key: "reference:distant",
    entityId: "distant-face",
    centroid: [0.1, 0, 0],
    boundsMin: [0.1, -0.5, -0.5],
    boundsMax: [0.1, 0.5, 0.5]
  });
  const result = await resolvePersistentTopologyReference(request(snapshot(1, [source]), snapshot(2, [distant])));

  assert.equal(result.outcome, "missing");
  assert.equal(result.candidates[0]?.eligible, false);
  assert.equal(result.candidates[0]?.rejectionReasons.includes("centroid"), true);
  assert.equal(result.diagnostics.some((item) => item.code === "TOLERANCE_REJECTED"), true);
});

test("canonical receipts ignore candidate and neighborhood array order", async () => {
  const neighbors: readonly TopologyNeighborContext[] = [
    neighbor("semantic:edge-a", 1),
    neighbor("semantic:edge-b", 2)
  ];
  const source = entity({ key: "reference:old-neighborhood", entityId: "old", neighbors });
  const matchA = entity({ key: "reference:new-neighborhood", entityId: "new", neighbors });
  const matchB = entity({ key: "reference:new-neighborhood", entityId: "new", neighbors: [...neighbors].reverse() });
  const noise = entity({
    key: "reference:noise",
    entityId: "noise",
    semanticId: "semantic:noise",
    role: "extrude:side-face",
    lineageDigest: "lineage:noise",
    neighbors: [neighbor("semantic:edge-z", 8)]
  });
  const first = await resolvePersistentTopologyReference(request(snapshot(4, [source]), snapshot(5, [matchA, noise])));
  const second = await resolvePersistentTopologyReference(request(snapshot(4, [source]), snapshot(5, [noise, matchB])));

  assert.equal(first.outcome, "unique-recovered");
  assert.equal(second.outcome, "unique-recovered");
  assert.equal(first.receipt.requestDigest, second.receipt.requestDigest);
  assert.equal(first.receipt.resultDigest, second.receipt.resultDigest);
});

function request(sourceSnapshot: TopologyRevisionSnapshot, targetSnapshot: TopologyRevisionSnapshot): TopologyResolutionRequest {
  return {
    requestId: "topology-resolution:test",
    sourceSnapshot,
    sourceReferenceKey: sourceSnapshot.entities[0]?.trackedReference.kernelReference.key ?? "reference:missing",
    targetSnapshot
  };
}

function snapshot(documentRevision: number, entities: readonly PersistentTopologyEntity[]): TopologyRevisionSnapshot {
  return {
    snapshotVersion: 1,
    projectId: projectId as ProjectId,
    documentRevision,
    bodyId: bodyId as BodyId,
    topologyRevision: documentRevision,
    shapeDigest: `shape:revision-${documentRevision}`,
    entities
  };
}

interface EntityOptions {
  readonly key: string;
  readonly entityId: string;
  readonly semanticId?: string;
  readonly role?: string;
  readonly lineageDigest?: string;
  readonly centroid?: readonly [number, number, number];
  readonly boundsMin?: readonly [number, number, number];
  readonly boundsMax?: readonly [number, number, number];
  readonly neighbors?: readonly TopologyNeighborContext[];
  readonly featureId?: FeatureId;
  readonly operationId?: string;
  readonly outputIndex?: number;
}

function entity(options: EntityOptions): PersistentTopologyEntity {
  const semanticId = options.semanticId ?? "semantic:end-face";
  const role = options.role ?? "extrude:end-face";
  const operationId = options.operationId ?? "operation:base-extrude";
  const sourceFeatureId = options.featureId ?? featureId;
  const signature: GeometricSignature = {
    geometryClass: "plane",
    centroidMeters: options.centroid ?? [0, 0, 0],
    measure: 1,
    boundsMeters: {
      min: options.boundsMin ?? [0, -0.5, -0.5],
      max: options.boundsMax ?? [0, 0.5, 0.5]
    },
    orientationHint: [1, 0, 0],
    analyticParameters: { offset: 0 },
    signatureDigest: options.centroid === undefined ? "signature:end-face" : `signature:${options.centroid.join("-")}`
  };
  const kernelReference: StableTopologyReference = {
    referenceVersion: 1,
    key: options.key,
    semanticId,
    expectedKind: "face",
    producer: {
      operationId,
      operationKind: "solid.extrude",
      outputIndex: options.outputIndex ?? 0,
      role
    },
    ancestry: [],
    signature,
    lineageDigest: options.lineageDigest ?? "lineage:end-face"
  };
  const documentReference: TopologyReference = {
    kind: "topology",
    bodyId: bodyId as BodyId,
    subshape: "face",
    persistentName: options.key,
    sourceFeatureId,
    expectedGeometry: "planar"
  };
  return {
    entityId: options.entityId,
    kind: "face",
    trackedReference: {
      referenceVersion: 1,
      documentReference,
      kernelReference,
      featureLineage: {
        featureId: sourceFeatureId,
        operationId,
        operationKind: "solid.extrude",
        role
      },
      createdDocumentRevision: 1
    },
    orientation: "forward",
    toleranceMeters: 1e-7,
    neighbors: options.neighbors ?? []
  };
}

function neighbor(semanticId: string, measure: number): TopologyNeighborContext {
  return {
    kind: "edge",
    semanticId,
    producerRole: "extrude:boundary-edge",
    geometryClass: "line",
    measure
  };
}
