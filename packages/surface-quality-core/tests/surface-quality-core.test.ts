import assert from "node:assert/strict";
import test from "node:test";
import type {
  ExactShapeHandle,
  KernelTopologyKind,
  TopologySelection,
  Vector3
} from "../../exact-kernel-api/src/index.js";
import {
  createSurfaceQualityService,
  invalidateSurfaceReceipts,
  SurfaceContractError,
  validateSurfaceFeatureRequest,
  type ExactSurfaceBackend,
  type SurfaceAnalysisBackendResult,
  type SurfaceAnalysisRequest,
  type SurfaceFeatureBackendResult,
  type SurfaceFeatureRequest,
  type SurfacePatchRequest,
  type SurfaceTolerancePolicy,
  type ZebraAnalysisRequest
} from "../src/index.js";

const tolerance: SurfaceTolerancePolicy = {
  positionalMeters: 1e-6,
  angularRadians: 1e-4,
  curvaturePerMeter: 1e-3,
  parameterTolerance: 1e-8
};

const shell = exactShape("shape-shell", "shape-digest-shell");
const edgeA = selection(shell, "edge:a", "lineage:a", "edge");
const edgeB = selection(shell, "edge:b", "lineage:b", "edge");
const faceA = selection(shell, "face:a", "lineage:face-a", "face");

const patchRequest: SurfacePatchRequest = {
  schemaVersion: 1,
  featureId: "surface-feature:patch-1",
  revision: 4,
  operation: "surface.patch",
  tolerance,
  boundaryConditions: [{
    boundaryId: "boundary:a",
    boundary: edgeA,
    goal: "G2",
    referenceSurface: faceA,
    tolerance,
    influence: 1,
    reverseDirection: false
  }],
  outerLoop: {
    pathId: "loop:outer",
    segments: [edgeA, edgeB],
    closed: true,
    requireTangentChain: true
  },
  innerLoops: [],
  internalRails: []
};

const zebraRequest: ZebraAnalysisRequest = {
  schemaVersion: 1,
  analysisId: "analysis:zebra-1",
  revision: 4,
  analysis: "surface-analysis.zebra",
  faces: [faceA],
  sampling: {
    uSamples: 8,
    vSamples: 8,
    adaptive: true,
    chordToleranceMeters: 1e-5,
    angularToleranceRadians: 1e-3
  },
  stripeDirection: [1, 0, 0],
  stripeCount: 12,
  phase: 0
};

test("G2 boundaries require an exact reference face and patch loops must close", () => {
  const invalid: SurfacePatchRequest = {
    ...patchRequest,
    boundaryConditions: [{
      boundaryId: "boundary:invalid",
      boundary: edgeA,
      goal: "G2",
      tolerance: { ...tolerance, curvaturePerMeter: 0 },
      influence: 1,
      reverseDirection: false
    }],
    outerLoop: { ...patchRequest.outerLoop, closed: false }
  };

  const codes = validateSurfaceFeatureRequest(invalid).map((item) => item.code);
  assert.ok(codes.includes("CONTINUITY_REFERENCE_REQUIRED"));
  assert.ok(codes.includes("NUMBER_NOT_POSITIVE"));
  assert.ok(codes.includes("G2_CURVATURE_TOLERANCE"));
  assert.ok(codes.includes("PATCH_LOOP_OPEN"));
});

test("surface evaluation refuses to exist without an injected exact backend", () => {
  assert.throws(
    () => createSurfaceQualityService(),
    (error: unknown) => error instanceof SurfaceContractError && error.code === "EXACT_BACKEND_REQUIRED"
  );
});

test("identical exact evaluations produce deterministic receipts and dependency invalidation", async () => {
  const service = createSurfaceQualityService(exactBackend());
  const first = await service.evaluateFeature(patchRequest);
  const second = await service.evaluateFeature(patchRequest);

  assert.deepEqual(first.receipt, second.receipt);
  assert.ok(first.receipt.dependencyKeys.includes("topology:edge:a"));
  assert.ok(first.receipt.dependencyKeys.includes("lineage:lineage:face-a"));
  assert.equal(first.result.evaluatedFromExactGeometry, true);

  const unrelated = {
    ...first.receipt,
    artifactId: "surface-feature:unrelated",
    dependencyKeys: ["topology:unrelated"]
  };
  const invalidation = await invalidateSurfaceReceipts(
    { changedKeys: ["topology:edge:a"] },
    [unrelated, first.receipt]
  );
  assert.deepEqual(invalidation.invalidatedArtifactIds, [patchRequest.featureId]);
  assert.deepEqual(invalidation.retainedArtifactIds, ["surface-feature:unrelated"]);
});

test("analysis values are accepted only from the exact backend and non-finite results are rejected", async () => {
  const service = createSurfaceQualityService(exactBackend());
  const evaluated = await service.analyze(zebraRequest);
  assert.equal(evaluated.result.payload.analysis, "surface-analysis.zebra");
  assert.equal(evaluated.receipt.deterministic, true);

  const bad = exactBackend();
  bad.analyze = async (_request, requestDigest) => zebraResult(requestDigest, Number.NaN);
  const badService = createSurfaceQualityService(bad);
  await assert.rejects(
    () => badService.analyze(zebraRequest),
    (error: unknown) => error instanceof SurfaceContractError && error.code === "NON_FINITE_BACKEND_RESULT"
  );
});

function exactBackend(): ExactSurfaceBackend & {
  analyze(request: SurfaceAnalysisRequest, requestDigest: string): Promise<SurfaceAnalysisBackendResult>;
} {
  return {
    identity: {
      implementation: "test-exact-surface-adapter",
      implementationVersion: "1.0.0",
      exactKernel: "test-exact-brep",
      exactKernelVersion: "1.0.0",
      buildId: "reproducible-test-build",
      executionTarget: "wasm-worker"
    },
    capabilities: {
      supportedOperations: ["surface.patch"],
      supportedAnalyses: ["surface-analysis.zebra"],
      supportedContinuity: ["G0", "G1", "G2"],
      deterministicForIdenticalBuildAndInputs: true,
      minimumPositionalToleranceMeters: 1e-9,
      minimumAngularToleranceRadians: 1e-8,
      maximumSamplesPerAnalysis: 10_000
    },
    async evaluateFeature(request: SurfaceFeatureRequest, requestDigest: string): Promise<SurfaceFeatureBackendResult> {
      return {
        requestDigest,
        operation: request.operation,
        evaluatedFromExactGeometry: true,
        outputs: [shell],
        edgeMatches: [{
          first: edgeA.reference,
          second: edgeB.reference,
          status: "within-tolerance",
          samplesEvaluated: 16,
          maximumGapMeters: 2e-7,
          maximumAngleRadians: 3e-5,
          maximumCurvatureDeltaPerMeter: 4e-4,
          achievedContinuity: "G2"
        }],
        trimLoops: [{
          loopId: "loop:outer",
          edges: [edgeA.reference, edgeB.reference],
          closed: true,
          orientation: "counter-clockwise",
          maximumClosureGapMeters: 1e-7,
          selfIntersectionCount: 0
        }],
        diagnostics: []
      };
    },
    async analyze(_request: SurfaceAnalysisRequest, requestDigest: string): Promise<SurfaceAnalysisBackendResult> {
      return zebraResult(requestDigest, 0.75);
    }
  };
}

function zebraResult(requestDigest: string, intensity: number): SurfaceAnalysisBackendResult {
  return {
    requestDigest,
    analysis: "surface-analysis.zebra",
    evaluatedFromExactGeometry: true,
    payload: {
      analysis: "surface-analysis.zebra",
      samples: [{
        face: faceA.reference,
        uv: [0.25, 0.5],
        positionMeters: [0, 0, 0],
        normal: [0, 0, 1],
        stripeCoordinate: 0.25,
        reflectionIntensity: intensity
      }]
    },
    diagnostics: []
  };
}

function selection(shape: ExactShapeHandle, key: string, lineageDigest: string, kind: KernelTopologyKind): TopologySelection {
  return {
    shape,
    reference: {
      referenceVersion: 1,
      key,
      semanticId: `semantic:${key}`,
      expectedKind: kind,
      producer: {
        operationId: "operation:source",
        operationKind: "surface.patch",
        outputIndex: 0,
        role: "boundary"
      },
      ancestry: [],
      signature: {
        geometryClass: kind === "face" ? "plane" : "line",
        centroidMeters: [0, 0, 0],
        measure: 1,
        boundsMeters: { min: [0, 0, 0], max: [1, 1, 0] },
        signatureDigest: `signature:${key}`
      },
      lineageDigest
    }
  };
}

function exactShape(shapeId: string, contentDigest: string): ExactShapeHandle {
  const min: Vector3 = [0, 0, 0];
  const max: Vector3 = [1, 1, 0];
  return {
    shapeId,
    sessionId: "session:test",
    revision: 4,
    kind: "shell",
    representation: "exact-brep",
    contentDigest,
    toleranceMeters: 1e-7,
    boundsMeters: { min, max },
    topology: {
      vertices: 4,
      edges: 4,
      wires: 1,
      faces: 1,
      shells: 1,
      solids: 0,
      components: 1,
      closed: false,
      manifold: true
    }
  };
}
