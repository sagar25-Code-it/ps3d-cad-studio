import assert from "node:assert/strict";
import test from "node:test";
import {
  appendFeature,
  createCadId,
  createCadScopedId,
  createDefaultCadDocument,
  reviseCadDocument,
  setComponentRollback,
  setFeatureSuppressed,
  type BodyId,
  type CadBody,
  type CadDocument,
  type CadFeature,
  type CadSketch,
  type FeatureId,
  type SketchId
} from "@ps3d/cad-document-core/src/index.js";
import {
  EXACT_KERNEL_PROTOCOL_VERSION,
  failureResponse,
  finalizeOperationProducts,
  inputShapeHandles,
  kernelSha256,
  protocolDiagnostic,
  responseEnvelope,
  type ExactKernelAdapter,
  type ExactKernelCapabilities,
  type ExactKernelRequest,
  type ExactKernelResponse,
  type ExactShapeHandle,
  type KernelIdentity,
  type OperationResultDraft
} from "@ps3d/exact-kernel-api/src/index.js";
import { analyticSketchSolver, type ParametricSketchDocument } from "@ps3d/parametric-sketch-core/src/index.js";
import {
  createFeatureOperationTableMapper,
  createParametricCadEngine,
  type FeatureMappingContext,
  type ParametricCadRebuildRequest
} from "../src/index.js";

const BASE_FEATURE_ID = createCadId("feature", "base");
const FINISH_FEATURE_ID = createCadId("feature", "finish");
const BASE_BODY_ID = createCadId("body", "base");
const FINISH_BODY_ID = createCadId("body", "finish");
const SKETCH_ID = createCadId("sketch", "layout");

test("rebuild is deterministic, solves sketches and returns SHA-bound exact results", async () => {
  const document = fixtureDocument();
  const adapter = new DeterministicFakeKernelAdapter();
  const engine = fixtureEngine(adapter);
  const first = await engine.rebuild(rebuildRequest(document));
  const second = await fixtureEngine(new DeterministicFakeKernelAdapter()).rebuild(rebuildRequest(document));

  assert.equal(first.status, "succeeded");
  assert.equal(first.candidateDocument?.revision, document.revision + 1);
  assert.deepEqual(first.features.map((item) => [item.featureId, item.status]), [
    [BASE_FEATURE_ID, "succeeded"],
    [FINISH_FEATURE_ID, "succeeded"]
  ]);
  assert.equal(first.sketches[0]?.status, "succeeded");
  assert.match(first.receipt.receiptSha256, /^[a-f0-9]{64}$/u);
  assert.equal(first.receipt.receiptSha256, second.receipt.receiptSha256);
  assert.equal(first.receipt.resultCacheSha256, second.receipt.resultCacheSha256);
  assert.equal(first.cache.features.length, 2);
  assert.ok(first.candidateDocument?.project.bodies.every((body) => body.representation === "exact-brep"));
});

test("a failed recomputation preserves last-good geometry and deterministically blocks descendants", async () => {
  const document = fixtureDocument();
  const successful = await fixtureEngine(new DeterministicFakeKernelAdapter()).rebuild(rebuildRequest(document));
  const failingAdapter = new DeterministicFakeKernelAdapter(new Set([BASE_FEATURE_ID]));
  const request = rebuildRequest(document, successful.cache);
  const failed = await fixtureEngine(failingAdapter).rebuild(request);

  assert.equal(failed.status, "partial");
  const base = failed.features.find((item) => item.featureId === BASE_FEATURE_ID);
  const finish = failed.features.find((item) => item.featureId === FINISH_FEATURE_ID);
  assert.equal(base?.status, "failed");
  assert.equal(base?.retainedLastGood, true);
  assert.equal(finish?.status, "blocked");
  assert.equal(finish?.retainedLastGood, true);
  assert.equal(failingAdapter.executedOperationIds.includes(FINISH_FEATURE_ID), false);
  assert.deepEqual(
    failed.cache.features.map((entry) => entry.kernelReceipt.resultDigest),
    successful.cache.features.map((entry) => entry.kernelReceipt.resultDigest)
  );
  assert.ok(failed.candidateDocument?.project.bodies.every((body) => body.geometryHandle !== null));
});

test("suppression uses canonical plan semantics and never calls the skipped feature", async () => {
  const source = fixtureDocument();
  const document = setFeatureSuppressed(source, "operation:suppress-finish", FINISH_FEATURE_ID, true);
  const adapter = new DeterministicFakeKernelAdapter();
  const outcome = await fixtureEngine(adapter).rebuild(rebuildRequest(document));

  const finish = outcome.features.find((item) => item.featureId === FINISH_FEATURE_ID);
  assert.equal(finish?.status, "skipped");
  assert.equal(finish?.reason, "suppressed");
  assert.equal(adapter.executedOperationIds.includes(FINISH_FEATURE_ID), false);
});

test("component rollback excludes later timeline features without discarding their last-good cache", async () => {
  const source = fixtureDocument();
  const first = await fixtureEngine(new DeterministicFakeKernelAdapter()).rebuild(rebuildRequest(source));
  const rolledBack = setComponentRollback(
    source,
    "operation:rollback-after-base",
    source.project.rootComponentId,
    BASE_FEATURE_ID
  );
  const adapter = new DeterministicFakeKernelAdapter();
  const outcome = await fixtureEngine(adapter).rebuild(rebuildRequest(rolledBack, first.cache));

  const finish = outcome.features.find((item) => item.featureId === FINISH_FEATURE_ID);
  assert.equal(finish?.status, "skipped");
  assert.equal(finish?.reason, "rolled-back");
  assert.equal(finish?.retainedLastGood, true);
  assert.equal(adapter.executedOperationIds.includes(FINISH_FEATURE_ID), false);
  assert.ok(outcome.cache.features.some((entry) => entry.featureId === FINISH_FEATURE_ID));
});

test("an invalid mapper is rejected before the exact adapter and produces no geometry", async () => {
  const document = fixtureDocument();
  const adapter = new DeterministicFakeKernelAdapter();
  const mapper = createFeatureOperationTableMapper([
    {
      featureId: BASE_FEATURE_ID,
      factory: () => ({
        ...operationBase(BASE_FEATURE_ID, BASE_BODY_ID),
        kind: "primitive.box",
        sizeMeters: [1, 1, 1],
        placement: { origin: [0, 0, 0], normal: [0, 0, 1], xDirection: [1, 0, 0] }
      })
    }
  ]);
  const engine = createParametricCadEngine({ sketchSolver: analyticSketchSolver, kernelAdapter: adapter, featureMapper: mapper });
  const outcome = await engine.rebuild(rebuildRequest(document));

  assert.equal(outcome.status, "partial");
  assert.equal(outcome.features.find((item) => item.featureId === BASE_FEATURE_ID)?.status, "failed");
  assert.equal(adapter.executedOperationIds.length, 0);
  assert.equal(outcome.cache.features.length, 0);
});

test("invalid canonical documents fail before sketch or kernel execution", async () => {
  const document = fixtureDocument();
  const invalid = {
    ...document,
    project: { ...document.project, rootComponentId: createCadId("component", "missing") }
  } as CadDocument;
  const adapter = new DeterministicFakeKernelAdapter();
  const outcome = await fixtureEngine(adapter).rebuild(rebuildRequest(invalid));

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.candidateDocument, null);
  assert.equal(adapter.executedOperationIds.length, 0);
  assert.ok(outcome.diagnostics.some((item) => item.code === "INVALID_DOCUMENT"));
});

function fixtureEngine(adapter: ExactKernelAdapter) {
  const mapper = createFeatureOperationTableMapper([
    {
      featureId: BASE_FEATURE_ID,
      factory: () => ({
        ...operationBase(BASE_FEATURE_ID, BASE_BODY_ID),
        kind: "exchange.import",
        format: "step",
        bytes: new Uint8Array([80, 83, 51, 68]),
        fileName: "verified-base.step",
        options: { heal: true, splitCompounds: false, sourceLengthUnit: "mm", maximumToleranceMeters: 1e-5 }
      })
    },
    {
      featureId: FINISH_FEATURE_ID,
      factory: (context: FeatureMappingContext) => {
        const target = context.dependencyResults[0]?.products.geometry.outputs[0];
        if (target === undefined) throw new Error("Exact dependency output is required.");
        return {
          ...operationBase(FINISH_FEATURE_ID, FINISH_BODY_ID),
          kind: "solid.fillet",
          target: { shape: target },
          edges: [],
          radiusMeters: 0.002,
          continuity: "g1"
        };
      }
    }
  ]);
  return createParametricCadEngine({ sketchSolver: analyticSketchSolver, kernelAdapter: adapter, featureMapper: mapper });
}

function operationBase(featureId: FeatureId, bodyId: BodyId) {
  return {
    operationId: featureId,
    semanticOutputIds: [bodyId],
    linearToleranceMeters: 1e-6,
    angularToleranceRadians: 1e-8,
    expectedOutputCount: 1
  } as const;
}

function rebuildRequest(document: CadDocument, priorCache?: ParametricCadRebuildRequest["priorCache"]): ParametricCadRebuildRequest {
  return {
    requestId: "engine:test-rebuild",
    mode: "preview",
    document,
    generation: 1,
    sessionId: "session:test",
    changedFeatureIds: [BASE_FEATURE_ID],
    includeDirty: true,
    sketchDocuments: { [SKETCH_ID]: solverSketch() },
    ...(priorCache === undefined ? {} : { priorCache }),
    openSession: true
  };
}

function fixtureDocument(): CadDocument {
  let document = createDefaultCadDocument("Engine fixture", "test");
  const componentId = document.project.rootComponentId;
  const originId = document.project.components[0]!.originId;
  const sketch: CadSketch = {
    id: SKETCH_ID,
    componentId,
    name: "Layout",
    support: { kind: "origin-plane", originId, plane: "xy" },
    transform: {
      translationMeters: [0, 0, 0],
      rotation: [0, 0, 0, 1],
      scale: [1, 1, 1]
    },
    entities: [{ id: createCadScopedId("sketch-entity", "line"), type: "line", startMeters: [0, 0], endMeters: [0.1, 0], construction: false }],
    constraints: [],
    dimensions: [],
    solveState: { classification: "unknown", degreesOfFreedom: null, diagnostics: [] },
    visible: true,
    suppressed: false
  };
  document = reviseCadDocument(document, "operation:add-sketch", (project) => ({
    ...project,
    sketches: [...project.sketches, sketch],
    components: project.components.map((component) => component.id === componentId
      ? { ...component, sketchIds: [...component.sketchIds, sketch.id] }
      : component)
  }));
  document = appendFeature(document, "operation:add-base", feature(BASE_FEATURE_ID, "imported-base", [], BASE_BODY_ID), [body(BASE_BODY_ID, BASE_FEATURE_ID, componentId)]);
  document = appendFeature(document, "operation:add-finish", feature(FINISH_FEATURE_ID, "fillet", [BASE_FEATURE_ID], FINISH_BODY_ID), [body(FINISH_BODY_ID, FINISH_FEATURE_ID, componentId)]);
  return document;
}

function feature(id: FeatureId, kind: CadFeature["kind"], dependencies: readonly FeatureId[], outputBodyId: BodyId): CadFeature {
  return {
    id,
    componentId: createCadId("component", "root"),
    name: id,
    kind,
    dependencies,
    inputs: [],
    parameters: [],
    outputBodyIds: [outputBodyId],
    suppressed: false,
    status: "dirty",
    evaluationRevision: null,
    diagnostics: []
  };
}

function body(id: BodyId, featureId: FeatureId, componentId: CadBody["componentId"]): CadBody {
  return {
    id,
    componentId,
    name: id,
    representation: "empty",
    geometryHandle: null,
    generatedByFeatureId: featureId,
    topologyRevision: 0,
    visible: true,
    suppressed: false,
    materialId: null,
    status: "dirty",
    diagnostics: []
  };
}

function solverSketch(): ParametricSketchDocument {
  return {
    schemaVersion: "1.0",
    id: SKETCH_ID,
    revision: 0,
    plane: { kind: "principal", referenceId: "origin:root/xy", originMm: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] },
    parameters: {},
    geometry: [{ id: "line", kind: "line", start: [0, 0], end: [100, 0], construction: false, suppressed: false }],
    constraints: [],
    dimensions: []
  };
}

class DeterministicFakeKernelAdapter implements ExactKernelAdapter {
  readonly identity: KernelIdentity = {
    implementation: "ps3d-test-exact",
    implementationVersion: "1.0.0",
    kernel: "deterministic-test-double",
    kernelVersion: "1",
    buildId: "test-build-1",
    executionTarget: "native-worker",
    contractVersion: EXACT_KERNEL_PROTOCOL_VERSION
  };
  readonly capabilities: ExactKernelCapabilities = {
    capabilityVersion: "test-capabilities-1",
    supportedOperations: ["exchange.import", "solid.fillet"],
    importFormats: ["step"],
    exportFormats: ["step"],
    supportedContinuity: ["g0", "g1"],
    canonicalLengthUnit: "m",
    canonicalAngleUnit: "rad",
    minimumLinearToleranceMeters: 1e-9,
    maximumLinearToleranceMeters: 1e-2,
    minimumAngularToleranceRadians: 1e-12,
    deterministicForIdenticalBuildAndInputs: true,
    supportsPersistentSessions: true,
    supportsCancellation: true,
    resourceLimits: {
      maximumInputShapes: 100,
      maximumOutputShapes: 100,
      maximumTopologyEntities: 10000,
      maximumExchangeBytes: 1000000,
      maximumOperationMilliseconds: 10000
    }
  };
  readonly executedOperationIds: string[] = [];

  constructor(readonly failures: ReadonlySet<string> = new Set()) {}

  async handle(request: ExactKernelRequest): Promise<ExactKernelResponse> {
    if (request.kind === "open-session") return { ...responseEnvelope(request), status: "ok", kind: "session-opened", sessionId: request.sessionId };
    if (request.kind !== "execute") return failureResponse(request, [protocolDiagnostic("INVALID_REQUEST", "Test adapter supports only session and execution requests.", "Use the test contract.")]);
    this.executedOperationIds.push(request.operation.operationId);
    if (this.failures.has(request.operation.operationId)) return failureResponse(request, [protocolDiagnostic(
      "KERNEL_FAILURE", `Deliberate test failure for ${request.operation.operationId}.`, "Retain last-good geometry.", request.operation.semanticOutputIds
    )]);
    const outputs: ExactShapeHandle[] = [];
    for (let index = 0; index < request.operation.expectedOutputCount; index += 1) {
      const semanticId = request.operation.semanticOutputIds[index]!;
      outputs.push({
        shapeId: `shape:${semanticId.replace(":", "-")}`,
        sessionId: request.sessionId,
        revision: request.documentRevision,
        kind: "solid",
        representation: "exact-brep",
        contentDigest: await kernelSha256({ operation: request.operation, semanticId }),
        toleranceMeters: request.operation.linearToleranceMeters,
        boundsMeters: { min: [0, 0, 0], max: [1, 1, 1] },
        topology: { vertices: 8, edges: 12, wires: 6, faces: 6, shells: 1, solids: 1, components: 1, closed: true, manifold: true }
      });
    }
    const inputDigests = inputShapeHandles(request.operation).map((shape) => shape.contentDigest);
    const outputDigests = outputs.map((shape) => shape.contentDigest);
    const draft: OperationResultDraft = {
      operationId: request.operation.operationId,
      operationKind: request.operation.kind,
      outputs,
      validation: outputs.map(() => ({
        valid: true,
        exact: true,
        checkedToleranceMeters: request.operation.linearToleranceMeters,
        closed: true,
        manifold: true,
        orientable: true,
        finite: true,
        selfIntersections: 0,
        invalidEntityReferenceKeys: [],
        diagnostics: []
      })),
      provenance: {
        operationId: request.operation.operationId,
        operationKind: request.operation.kind,
        inputShapeDigests: inputDigests,
        outputShapeDigests: outputDigests,
        topologyEntities: [],
        provenanceDigest: await kernelSha256({ inputDigests, outputDigests })
      },
      diagnostics: [],
      exchangeArtifacts: [],
      tessellations: [],
      topologyEntities: []
    };
    const products = await finalizeOperationProducts(this.identity, this.capabilities, request, draft);
    return { ...responseEnvelope(request), status: "ok", kind: "executed", sessionId: request.sessionId, products };
  }
}
