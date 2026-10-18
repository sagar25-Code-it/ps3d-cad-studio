import { createCadId } from "../packages/cad-document-core/src/index.js";
import { EXACT_KERNEL_PROTOCOL_VERSION, type ExecuteKernelOperationRequest } from "../packages/exact-kernel-api/src/index.js";
import { createReferenceBrepRuntime } from "../packages/occt-kernel-adapter/src/index.js";
import {
  createTopologyRevisionSnapshot,
  resolvePersistentTopologyReference,
  type KernelTopologyAssociation,
  type TopologyRevisionSnapshot
} from "../packages/topology-reference-core/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

const OPERATION_ID = "operation:plate";

function boxRequest(size: readonly [number, number, number]): ExecuteKernelOperationRequest {
  return {
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: "request:plate",
    generation: 0,
    documentId: "document:naming",
    documentRevision: 0,
    kind: "execute",
    sessionId: "session:naming",
    expectedCapabilityVersion: "reference-runtime-1",
    operation: {
      operationId: OPERATION_ID,
      kind: "primitive.box",
      semanticOutputIds: ["body:plate"],
      linearToleranceMeters: 1e-6,
      angularToleranceRadians: 1e-6,
      expectedOutputCount: 1,
      sizeMeters: size,
      placement: { origin: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] }
    }
  };
}

/** Builds a topology snapshot for one revision of the plate feature and returns its top-face key. */
async function snapshotForRevision(revision: number, size: readonly [number, number, number]): Promise<{ readonly snapshot: TopologyRevisionSnapshot; readonly topFaceKey: string }> {
  const runtime = createReferenceBrepRuntime();
  await runtime.openSession("session:naming");
  const draft = await runtime.execute(boxRequest(size));
  const projectId = createCadId("project", "naming");
  const bodyId = createCadId("body", "plate");
  const featureId = createCadId("feature", "plate-extrude");
  const associations: readonly KernelTopologyAssociation[] = draft.topologyEntities.map((entity) => ({
    documentReference: { kind: "topology", bodyId, subshape: "face", persistentName: entity.stableReference.key, sourceFeatureId: featureId, expectedGeometry: "planar" },
    featureLineage: { featureId, operationId: OPERATION_ID, operationKind: "primitive.box", role: entity.stableReference.producer.role },
    kernelEntity: entity,
    createdDocumentRevision: revision
  }));
  const snapshot = createTopologyRevisionSnapshot({
    projectId, documentRevision: revision, bodyId, topologyRevision: revision,
    shapeDigest: draft.outputs[0]!.contentDigest, associations
  });
  const topFace = draft.topologyEntities.find((entity) => entity.stableReference.producer.role === "face.z-max")!;
  return { snapshot, topFaceKey: topFace.stableReference.key };
}

export const topologyNamingTests: readonly TestCase[] = [
  {
    name: "a stable top-face reference resolves exactly across a dimensional rebuild",
    run: async () => {
      const first = await snapshotForRevision(1, [0.1, 0.2, 0.3]);
      const second = await snapshotForRevision(2, [0.5, 0.6, 0.7]);
      equal(first.topFaceKey, second.topFaceKey, "the top-face stable key must be identical across revisions");

      const result = await resolvePersistentTopologyReference({
        requestId: "request:naming-1",
        sourceSnapshot: first.snapshot,
        sourceReferenceKey: first.topFaceKey,
        targetSnapshot: second.snapshot,
        // Generous geometric tolerances: the point is that the lineage-stable key carries the
        // name across a large dimensional edit, which the resolver then confirms.
        policy: { centroidToleranceMeters: 1, boundsToleranceMeters: 1, relativeMeasureTolerance: 100, angularToleranceRadians: 1, analyticParameterTolerance: 1, maximumEntityToleranceMeters: 1, maximumNeighborhoodMismatch: 1 }
      });
      equal(result.outcome, "exact", "the stable key must resolve to exactly one face in the rebuilt body");
      assert(result.selected !== null && result.selected.trackedReference.kernelReference.producer.role === "face.z-max", "the resolved face must still be the top face");
    }
  },
  {
    name: "a deleted-feature reference reports missing instead of mis-binding",
    run: async () => {
      const plate = await snapshotForRevision(1, [0.1, 0.2, 0.3]);
      const cylinder = await (async (): Promise<TopologyRevisionSnapshot> => {
        const runtime = createReferenceBrepRuntime();
        await runtime.openSession("session:naming");
        const draft = await runtime.execute({
          ...boxRequest([0.1, 0.1, 0.1]),
          operation: {
            operationId: "operation:post", kind: "primitive.cylinder", semanticOutputIds: ["body:post"],
            linearToleranceMeters: 1e-6, angularToleranceRadians: 1e-6, expectedOutputCount: 1,
            radiusMeters: 0.05, heightMeters: 0.2, placement: { origin: [0, 0, 0], direction: [0, 0, 1], xDirection: [1, 0, 0] }
          }
        });
        const bodyId = createCadId("body", "plate");
        const featureId = createCadId("feature", "post");
        const associations: readonly KernelTopologyAssociation[] = draft.topologyEntities.map((entity) => ({
          documentReference: { kind: "topology", bodyId, subshape: "face", persistentName: entity.stableReference.key, sourceFeatureId: featureId, expectedGeometry: "any" },
          featureLineage: { featureId, operationId: "operation:post", operationKind: "primitive.cylinder", role: entity.stableReference.producer.role },
          kernelEntity: entity, createdDocumentRevision: 2
        }));
        return createTopologyRevisionSnapshot({ projectId: createCadId("project", "naming"), documentRevision: 2, bodyId, topologyRevision: 2, shapeDigest: draft.outputs[0]!.contentDigest, associations });
      })();
      const result = await resolvePersistentTopologyReference({
        requestId: "request:naming-2", sourceSnapshot: plate.snapshot, sourceReferenceKey: plate.topFaceKey, targetSnapshot: cylinder
      });
      equal(result.outcome, "missing", "a reference whose feature is gone must not silently bind to an unrelated face");
      equal(result.selected, null, "no face is selected when the lineage is absent");
    }
  }
];
