import {
  planFeatureRebuild,
  reviseCadDocument,
  validateCadDocument,
  type CadDiagnostic,
  type CadDocument,
  type CadFeature,
  type FeatureId,
  type FeatureRebuildPlan,
  type SketchId
} from "@ps3d/cad-document-core/src/index.js";
import {
  EXACT_KERNEL_PROTOCOL_VERSION,
  kernelSha256,
  validateKernelRequest,
  validateKernelResponse,
  type ExactKernelRequest,
  type ExecuteKernelOperationRequest,
  type KernelDiagnostic,
  type KernelExecutionProducts
} from "@ps3d/exact-kernel-api/src/index.js";
import type { SketchDiagnostic, SketchSolveResult } from "@ps3d/parametric-sketch-core/src/index.js";
import { validateFeatureOperationMapping } from "./mapping.js";
import {
  PARAMETRIC_CAD_ENGINE_SCHEMA_VERSION,
  type EngineDiagnostic,
  type FeatureEvaluationRecord,
  type FeatureLastGoodResult,
  type ParametricCadEngine,
  type ParametricCadEngineCache,
  type ParametricCadEngineDependencies,
  type ParametricCadReceipt,
  type ParametricCadRebuildOutcome,
  type ParametricCadRebuildRequest,
  type SketchEvaluationRecord,
  type SketchLastGoodResult
} from "./types.js";

const REQUEST_ID = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]{0,95}$/u;

export function createParametricCadEngine(dependencies: ParametricCadEngineDependencies): ParametricCadEngine {
  return {
    rebuild: (request, signal) => rebuildParametricCadDocument(dependencies, request, signal)
  };
}

export async function rebuildParametricCadDocument(
  dependencies: ParametricCadEngineDependencies,
  request: ParametricCadRebuildRequest,
  signal?: AbortSignal
): Promise<ParametricCadRebuildOutcome> {
  assertRequest(request);
  const sourceDocumentSha256 = await kernelSha256(request.document);
  const diagnostics: EngineDiagnostic[] = [];
  const validation = validateCadDocument(request.document);
  const priorCache = normalizeCache(request, diagnostics);
  if (!validation.ok) {
    diagnostics.push(...validation.diagnostics.map(cadDiagnostic));
    return finishOutcome(request, sourceDocumentSha256, null, null, [], [], diagnostics, priorCache);
  }
  const document = validation.value;
  const planResult = planFeatureRebuild(document, featurePlanOptions(request));
  if (!planResult.ok) {
    diagnostics.push(...planResult.diagnostics.map(cadDiagnostic));
    return finishOutcome(request, sourceDocumentSha256, null, null, [], [], diagnostics, priorCache);
  }
  const plan = planResult.value;
  diagnostics.push(...plan.diagnostics.map(cadDiagnostic));

  const sketchRun = solveSketches(dependencies, request, document, priorCache);
  const sketches = sketchRun.records;
  diagnostics.push(...sketchRun.diagnostics);
  const sketchCache = sketchRun.cache;
  const sketchFailures = new Set(sketches.filter((record) => record.status === "failed").map((record) => record.sketchId));

  let sessionDiagnostic: EngineDiagnostic | null = null;
  if (request.openSession === true) sessionDiagnostic = await openKernelSession(dependencies, request, signal);
  if (sessionDiagnostic !== null) diagnostics.push(sessionDiagnostic);

  const currentFeatureIds = new Set(document.project.features.map((feature) => feature.id));
  const featureCache = new Map(priorCache.features
    .filter((entry) => currentFeatureIds.has(entry.featureId))
    .map((entry) => [entry.featureId, entry] as const));
  const featureRecords: FeatureEvaluationRecord[] = [];
  const runtimeBlocked = new Set<FeatureId>();
  for (const skipped of plan.skipped) {
    featureRecords.push({
      featureId: skipped.featureId,
      status: "skipped",
      reason: skipped.reason,
      operationKind: null,
      diagnostics: [],
      retainedLastGood: featureCache.has(skipped.featureId),
      kernelResultDigest: null
    });
    runtimeBlocked.add(skipped.featureId);
  }
  for (const blocked of plan.blocked) {
    const nodeDiagnostics = [engineDiagnostic(
      "DEPENDENCY_BLOCKED",
      "warning",
      "planning",
      `Feature ${blocked.featureId} is blocked by an inactive upstream feature.`,
      [blocked.featureId, ...blocked.blockingFeatureIds],
      "Unsuppress the upstream feature or move the component rollback point forward."
    )];
    featureRecords.push(blockedRecord(blocked.featureId, blocked.blockingFeatureIds, nodeDiagnostics, featureCache.has(blocked.featureId)));
    runtimeBlocked.add(blocked.featureId);
  }

  for (const step of plan.steps) {
    const feature = document.project.features.find((candidate) => candidate.id === step.featureId)!;
    const blockers = feature.dependencies.filter((dependencyId) => runtimeBlocked.has(dependencyId));
    const missingDependencies = feature.dependencies.filter((dependencyId) => !runtimeBlocked.has(dependencyId) && !featureCache.has(dependencyId));
    const sketchBlockers = referencedSketchIds(feature).filter((sketchId) => sketchFailures.has(sketchId) || !sketchCache.some((entry) => entry.sketchId === sketchId));
    if (sessionDiagnostic !== null || blockers.length > 0 || missingDependencies.length > 0 || sketchBlockers.length > 0) {
      const related = [feature.id, ...blockers, ...missingDependencies, ...sketchBlockers];
      const nodeDiagnostics = [engineDiagnostic(
        missingDependencies.length > 0 ? "DEPENDENCY_RESULT_MISSING" : "DEPENDENCY_BLOCKED",
        "error",
        "rebuild",
        sessionDiagnostic !== null
          ? `Feature ${feature.id} cannot run because the kernel session is unavailable.`
          : `Feature ${feature.id} cannot run because an exact upstream or solved-sketch result is unavailable.`,
        related,
        "Successfully rebuild every dependency and solve every referenced sketch before retrying."
      )];
      featureRecords.push(blockedRecord(feature.id, related.slice(1), nodeDiagnostics, featureCache.has(feature.id)));
      diagnostics.push(...nodeDiagnostics);
      runtimeBlocked.add(feature.id);
      continue;
    }

    const dependencyResults = feature.dependencies.map((dependencyId) => featureCache.get(dependencyId)!);
    const featureSketchResults = referencedSketchIds(feature)
      .map((sketchId) => sketchCache.find((entry) => entry.sketchId === sketchId))
      .filter((entry): entry is SketchLastGoodResult => entry !== undefined);
    let mapping;
    try {
      mapping = await dependencies.featureMapper.map({ document, feature, dependencyResults, sketchResults: featureSketchResults });
    } catch (error) {
      const nodeDiagnostics = [engineDiagnostic(
        "FEATURE_MAPPING_FAILED",
        "error",
        "mapping",
        `Feature mapper failed for ${feature.id}: ${safeErrorMessage(error)}`,
        [feature.id],
        "Correct the deterministic feature mapper and retry without changing the last-good geometry."
      )];
      featureRecords.push(failedRecord(feature, null, nodeDiagnostics, featureCache.has(feature.id)));
      diagnostics.push(...nodeDiagnostics);
      runtimeBlocked.add(feature.id);
      continue;
    }
    if (mapping.status === "unsupported") {
      const nodeDiagnostics = mapping.diagnostics.length > 0 ? mapping.diagnostics : [engineDiagnostic(
        "FEATURE_UNSUPPORTED", "error", "mapping", `Feature ${feature.id} is unsupported.`, [feature.id], "Register a reviewed exact operation mapper."
      )];
      featureRecords.push(failedRecord(feature, null, nodeDiagnostics, featureCache.has(feature.id)));
      diagnostics.push(...nodeDiagnostics);
      runtimeBlocked.add(feature.id);
      continue;
    }
    const mappingDiagnostics = validateFeatureOperationMapping(feature.kind, feature.id, feature.outputBodyIds, mapping.operation);
    if (mappingDiagnostics.length > 0) {
      featureRecords.push(failedRecord(feature, mapping.operation.kind, mappingDiagnostics, featureCache.has(feature.id)));
      diagnostics.push(...mappingDiagnostics);
      runtimeBlocked.add(feature.id);
      continue;
    }
    if (!dependencies.kernelAdapter.capabilities.supportedOperations.includes(mapping.operation.kind)) {
      const nodeDiagnostics = [engineDiagnostic(
        "KERNEL_CAPABILITY_MISSING",
        "error",
        "kernel",
        `Kernel does not advertise '${mapping.operation.kind}' for ${feature.id}.`,
        [feature.id],
        "Route the feature to a qualified exact-kernel worker."
      )];
      featureRecords.push(failedRecord(feature, mapping.operation.kind, nodeDiagnostics, featureCache.has(feature.id)));
      diagnostics.push(...nodeDiagnostics);
      runtimeBlocked.add(feature.id);
      continue;
    }

    const execution = await executeFeature(dependencies, request, mapping.operation, signal);
    if (!execution.ok) {
      featureRecords.push(failedRecord(feature, mapping.operation.kind, execution.diagnostics, featureCache.has(feature.id)));
      diagnostics.push(...execution.diagnostics);
      runtimeBlocked.add(feature.id);
      continue;
    }
    const result: FeatureLastGoodResult = {
      featureId: feature.id,
      sourceDocumentRevision: document.revision,
      operationKind: mapping.operation.kind,
      products: execution.products,
      kernelReceipt: execution.products.geometry.receipt
    };
    featureCache.set(feature.id, result);
    featureRecords.push({
      featureId: feature.id,
      status: "succeeded",
      reason: step.reason,
      operationKind: mapping.operation.kind,
      diagnostics: [],
      retainedLastGood: false,
      kernelResultDigest: execution.products.geometry.receipt.resultDigest
    });
  }

  const cache: ParametricCadEngineCache = {
    schemaVersion: PARAMETRIC_CAD_ENGINE_SCHEMA_VERSION,
    documentId: document.project.id,
    sessionId: request.sessionId,
    sourceDocumentRevision: document.revision,
    sketches: [...sketchCache].sort(bySketchId),
    features: [...featureCache.values()].sort(byFeatureId)
  };
  const candidateDocument = buildCandidateDocument(document, request, featureRecords, sketches, cache, diagnostics);
  return finishOutcome(request, sourceDocumentSha256, candidateDocument, plan, sketches, featureRecords, diagnostics, cache);
}

function solveSketches(
  dependencies: ParametricCadEngineDependencies,
  request: ParametricCadRebuildRequest,
  document: CadDocument,
  priorCache: ParametricCadEngineCache
): { readonly records: readonly SketchEvaluationRecord[]; readonly diagnostics: readonly EngineDiagnostic[]; readonly cache: readonly SketchLastGoodResult[] } {
  const records: SketchEvaluationRecord[] = [];
  const diagnostics: EngineDiagnostic[] = [];
  const currentSketchIds = new Set(document.project.sketches.map((sketch) => sketch.id));
  const cache = new Map(priorCache.sketches
    .filter((entry) => currentSketchIds.has(entry.sketchId))
    .map((entry) => [entry.sketchId, entry] as const));
  for (const sketch of [...document.project.sketches].sort((first, second) => first.id.localeCompare(second.id))) {
    if (sketch.suppressed) {
      records.push({ sketchId: sketch.id, status: "skipped", diagnostics: [], retainedLastGood: cache.has(sketch.id), deterministicFingerprint: null });
      continue;
    }
    const solverDocument = request.sketchDocuments[sketch.id];
    if (solverDocument === undefined || solverDocument.id !== sketch.id) {
      const nodeDiagnostics = [engineDiagnostic(
        "SKETCH_SOURCE_MISSING",
        "error",
        "sketch",
        `No matching solver document was supplied for ${sketch.id}.`,
        [sketch.id],
        "Run the deterministic canonical-sketch bridge before rebuilding dependent features."
      )];
      records.push({ sketchId: sketch.id, status: "failed", diagnostics: nodeDiagnostics, retainedLastGood: cache.has(sketch.id), deterministicFingerprint: null });
      diagnostics.push(...nodeDiagnostics);
      continue;
    }
    let result: SketchSolveResult;
    try {
      result = dependencies.sketchSolver.solve({ document: solverDocument, mode: "regenerate" });
    } catch (error) {
      const nodeDiagnostics = [engineDiagnostic(
        "SKETCH_SOLVE_FAILED",
        "error",
        "sketch",
        `Sketch solver failed for ${sketch.id}: ${safeErrorMessage(error)}`,
        [sketch.id],
        "Correct the solver input or use a qualified deterministic solver."
      )];
      records.push({ sketchId: sketch.id, status: "failed", diagnostics: nodeDiagnostics, retainedLastGood: cache.has(sketch.id), deterministicFingerprint: null });
      diagnostics.push(...nodeDiagnostics);
      continue;
    }
    if (result.status !== "solved" || result.diagnostics.some((item) => item.severity === "error")) {
      const nodeDiagnostics = [engineDiagnostic(
        "SKETCH_SOLVE_FAILED",
        "error",
        "sketch",
        `Sketch ${sketch.id} did not reach a solved state.`,
        [sketch.id],
        "Resolve conflicting, invalid, or unsupported sketch relations before exact feature evaluation.",
        result.diagnostics.map((item) => item.code)
      ), ...result.diagnostics.map(sketchDiagnostic)];
      records.push({ sketchId: sketch.id, status: "failed", diagnostics: nodeDiagnostics, retainedLastGood: cache.has(sketch.id), deterministicFingerprint: result.deterministicFingerprint });
      diagnostics.push(...nodeDiagnostics);
      continue;
    }
    cache.set(sketch.id, {
      sketchId: sketch.id,
      sourceDocumentRevision: document.revision,
      solverName: dependencies.sketchSolver.identity.name,
      solverVersion: dependencies.sketchSolver.identity.version,
      result
    });
    const nodeDiagnostics = result.diagnostics.map(sketchDiagnostic);
    records.push({ sketchId: sketch.id, status: "succeeded", diagnostics: nodeDiagnostics, retainedLastGood: false, deterministicFingerprint: result.deterministicFingerprint });
    diagnostics.push(...nodeDiagnostics);
  }
  return { records, diagnostics, cache: [...cache.values()].sort(bySketchId) };
}

async function openKernelSession(
  dependencies: ParametricCadEngineDependencies,
  request: ParametricCadRebuildRequest,
  signal?: AbortSignal
): Promise<EngineDiagnostic | null> {
  const openRequest: ExactKernelRequest = {
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: kernelRequestId(request, "open"),
    generation: request.generation,
    documentId: request.document.project.id,
    documentRevision: request.document.revision,
    kind: "open-session",
    sessionId: request.sessionId,
    expectedCapabilityVersion: dependencies.kernelAdapter.capabilities.capabilityVersion
  };
  try {
    const response = await dependencies.kernelAdapter.handle(openRequest, signal);
    const protocolDiagnostics = await validateKernelResponse(openRequest, response, dependencies.kernelAdapter.identity, dependencies.kernelAdapter.capabilities);
    if (protocolDiagnostics.length > 0 || response.status === "error"
      || response.kind !== "session-opened" || response.sessionId !== request.sessionId) {
      const source = response.status === "error" ? response.diagnostics : protocolDiagnostics;
      return engineDiagnostic("KERNEL_SESSION_FAILED", "error", "kernel", "Exact-kernel session could not be opened.", [request.sessionId], "Renegotiate capabilities and reopen a persistent session.", source.map((item) => item.code));
    }
    return null;
  } catch (error) {
    return engineDiagnostic("KERNEL_SESSION_FAILED", "error", "kernel", `Exact-kernel session failed: ${safeErrorMessage(error)}`, [request.sessionId], "Restore the kernel worker before rebuilding.");
  }
}

async function executeFeature(
  dependencies: ParametricCadEngineDependencies,
  request: ParametricCadRebuildRequest,
  operation: ExecuteKernelOperationRequest["operation"],
  signal?: AbortSignal
): Promise<{ readonly ok: true; readonly products: KernelExecutionProducts } | { readonly ok: false; readonly diagnostics: readonly EngineDiagnostic[] }> {
  const kernelRequest: ExecuteKernelOperationRequest = {
    protocolVersion: EXACT_KERNEL_PROTOCOL_VERSION,
    requestId: kernelRequestId(request, operation.operationId),
    generation: request.generation,
    documentId: request.document.project.id,
    documentRevision: request.document.revision,
    kind: "execute",
    sessionId: request.sessionId,
    expectedCapabilityVersion: dependencies.kernelAdapter.capabilities.capabilityVersion,
    operation
  };
  const requestDiagnostics = validateKernelRequest(kernelRequest);
  if (requestDiagnostics.length > 0) return { ok: false, diagnostics: requestDiagnostics.map(kernelDiagnostic) };
  try {
    const response = await dependencies.kernelAdapter.handle(kernelRequest, signal);
    const protocolDiagnostics = await validateKernelResponse(kernelRequest, response, dependencies.kernelAdapter.identity, dependencies.kernelAdapter.capabilities);
    if (protocolDiagnostics.length > 0) return { ok: false, diagnostics: protocolDiagnostics.map(kernelProtocolDiagnostic) };
    if (response.status === "error") return { ok: false, diagnostics: response.diagnostics.map(kernelDiagnostic) };
    if (response.kind !== "executed") return { ok: false, diagnostics: [engineDiagnostic(
      "KERNEL_PROTOCOL_FAILED", "error", "kernel", "Kernel returned a non-execution response.", [operation.operationId], "Discard the response and restart the exact-kernel session."
    )] };
    const resultErrors = [
      ...response.products.geometry.diagnostics.filter((item) => item.severity === "error"),
      ...response.products.geometry.validation.flatMap((report) => report.valid ? [] : report.diagnostics)
    ];
    if (response.products.geometry.validation.some((report) => !report.valid) || resultErrors.length > 0) {
      return { ok: false, diagnostics: [engineDiagnostic(
        "KERNEL_RESULT_INVALID",
        "error",
        "kernel",
        "Exact-kernel result failed geometric validation.",
        [operation.operationId],
        "Repair the feature inputs; the last-good exact result remains active.",
        resultErrors.map((item) => item.code)
      ), ...resultErrors.map(kernelDiagnostic)] };
    }
    return { ok: true, products: response.products };
  } catch (error) {
    const cancelled = signal?.aborted === true;
    return { ok: false, diagnostics: [engineDiagnostic(
      cancelled ? "CANCELLED" : "KERNEL_OPERATION_FAILED",
      "error",
      "kernel",
      cancelled ? `Feature ${operation.operationId} was cancelled.` : `Kernel operation failed for ${operation.operationId}: ${safeErrorMessage(error)}`,
      [operation.operationId],
      cancelled ? "Submit a new deterministic rebuild request if still required." : "Restore the exact-kernel worker and retry."
    )] };
  }
}

function buildCandidateDocument(
  document: CadDocument,
  request: ParametricCadRebuildRequest,
  featureRecords: readonly FeatureEvaluationRecord[],
  sketchRecords: readonly SketchEvaluationRecord[],
  cache: ParametricCadEngineCache,
  diagnostics: readonly EngineDiagnostic[]
): CadDocument {
  const recordByFeature = new Map(featureRecords.map((record) => [record.featureId, record] as const));
  const recordBySketch = new Map(sketchRecords.map((record) => [record.sketchId, record] as const));
  const cacheByFeature = new Map(cache.features.map((entry) => [entry.featureId, entry] as const));
  return reviseCadDocument(document, rebuildOperationId(request.requestId), (project) => ({
    ...project,
    features: project.features.map((feature) => {
      const record = recordByFeature.get(feature.id);
      if (record === undefined) return feature;
      return {
        ...feature,
        status: record.status === "succeeded" ? "succeeded" : record.status === "failed" ? "failed" : record.status === "blocked" ? "blocked"
          : record.reason === "suppressed" || record.reason === "component-suppressed" ? "suppressed" : "rolled-back",
        evaluationRevision: document.revision + 1,
        diagnostics: record.diagnostics.map(engineCadDiagnostic)
      };
    }),
    bodies: project.bodies.map((body) => {
      if (body.generatedByFeatureId === null) return body;
      const record = recordByFeature.get(body.generatedByFeatureId);
      const lastGood = cacheByFeature.get(body.generatedByFeatureId);
      if (record === undefined || lastGood === undefined) return record === undefined ? body : { ...body, status: record.status === "blocked" ? "blocked" : record.status === "failed" ? "failed" : body.status, diagnostics: record.diagnostics.map(engineCadDiagnostic) };
      const feature = project.features.find((candidate) => candidate.id === body.generatedByFeatureId)!;
      const outputIndex = feature.outputBodyIds.indexOf(body.id);
      const shape = lastGood.products.geometry.outputs[outputIndex];
      if (shape === undefined) return { ...body, status: "failed", diagnostics: [engineCadDiagnostic(engineDiagnostic(
        "KERNEL_RESULT_INVALID", "error", "rebuild", "Last-good output/body correspondence is invalid.", [body.id], "Rebuild the feature with a valid semantic output contract."
      ))] };
      return {
        ...body,
        representation: "exact-brep",
        geometryHandle: exactGeometryHandle(shape),
        topologyRevision: record.status === "succeeded" ? body.topologyRevision + 1 : body.topologyRevision,
        status: record.status === "succeeded" ? "succeeded" : record.status === "blocked" ? "blocked" : record.status === "failed" ? "failed" : body.status,
        diagnostics: record.diagnostics.map(engineCadDiagnostic)
      };
    }),
    sketches: project.sketches.map((sketch) => {
      const record = recordBySketch.get(sketch.id);
      const solved = cache.sketches.find((entry) => entry.sketchId === sketch.id);
      if (record === undefined) return sketch;
      return {
        ...sketch,
        solveState: {
          classification: record.status === "succeeded" && solved !== undefined ? cadSketchClassification(solved.result) : "conflicting",
          degreesOfFreedom: record.status === "succeeded" && solved !== undefined ? solved.result.dof.total : sketch.solveState.degreesOfFreedom,
          diagnostics: record.diagnostics.map(engineCadDiagnostic)
        }
      };
    }),
    diagnostics: [...project.diagnostics, ...diagnostics.map(engineCadDiagnostic)]
  }));
}

async function finishOutcome(
  request: ParametricCadRebuildRequest,
  sourceDocumentSha256: string,
  candidateDocument: CadDocument | null,
  plan: FeatureRebuildPlan | null,
  sketches: readonly SketchEvaluationRecord[],
  features: readonly FeatureEvaluationRecord[],
  diagnostics: readonly EngineDiagnostic[],
  cache: ParametricCadEngineCache
): Promise<ParametricCadRebuildOutcome> {
  const orderedSketches = [...sketches].sort((first, second) => first.sketchId.localeCompare(second.sketchId));
  const orderedFeatures = [...features].sort((first, second) => first.featureId.localeCompare(second.featureId));
  const orderedDiagnostics = [...diagnostics].sort(compareDiagnostics);
  const failures = orderedDiagnostics.some((item) => item.severity === "error") || orderedFeatures.some((item) => item.status === "failed" || item.status === "blocked") || orderedSketches.some((item) => item.status === "failed");
  const successes = orderedFeatures.some((item) => item.status === "succeeded") || orderedSketches.some((item) => item.status === "succeeded");
  const status = failures ? successes ? "partial" : "failed" : "succeeded";
  const priorCache = normalizeCache(request, []);
  const planSha256 = await kernelSha256(plan);
  const priorCacheSha256 = await kernelSha256(priorCache);
  const resultCacheSha256 = await kernelSha256(cache);
  const kernelResultSha256 = cache.features.map((entry) => entry.kernelReceipt.resultDigest).sort();
  const outcomeContent = {
    status,
    candidateDocumentRevision: candidateDocument?.revision ?? null,
    planSha256,
    sketches: orderedSketches,
    features: orderedFeatures,
    diagnostics: orderedDiagnostics,
    resultCacheSha256
  };
  const outcomeSha256 = await kernelSha256(outcomeContent);
  const receiptContent = {
    schemaVersion: PARAMETRIC_CAD_ENGINE_SCHEMA_VERSION,
    kind: request.mode === "preview" ? "preview-receipt" : "rebuild-receipt",
    requestId: request.requestId,
    documentId: request.document.project.id,
    sourceDocumentRevision: request.document.revision,
    candidateDocumentRevision: candidateDocument?.revision ?? null,
    sourceDocumentSha256,
    planSha256,
    priorCacheSha256,
    resultCacheSha256,
    kernelResultSha256,
    outcomeSha256
  } as const;
  const receipt: ParametricCadReceipt = { ...receiptContent, receiptSha256: await kernelSha256(receiptContent) };
  return { status, candidateDocument, plan, sketches: orderedSketches, features: orderedFeatures, diagnostics: orderedDiagnostics, cache, receipt };
}

function normalizeCache(request: ParametricCadRebuildRequest, diagnostics: EngineDiagnostic[]): ParametricCadEngineCache {
  const empty = (): ParametricCadEngineCache => ({
    schemaVersion: PARAMETRIC_CAD_ENGINE_SCHEMA_VERSION,
    documentId: request.document.project.id,
    sessionId: request.sessionId,
    sourceDocumentRevision: request.document.revision,
    sketches: [],
    features: []
  });
  const cache = request.priorCache;
  if (cache === undefined) return empty();
  if (cache.schemaVersion !== PARAMETRIC_CAD_ENGINE_SCHEMA_VERSION || cache.documentId !== request.document.project.id
    || cache.sessionId !== request.sessionId || cache.sourceDocumentRevision > request.document.revision) {
    diagnostics.push(engineDiagnostic(
      "STALE_CACHE", "warning", "validation", "Prior exact-result cache does not belong to this document/session revision.", [request.document.project.id, request.sessionId], "Discard the stale cache and rebuild the required upstream features."
    ));
    return empty();
  }
  return {
    ...cache,
    sketches: [...cache.sketches].sort(bySketchId),
    features: [...cache.features].sort(byFeatureId)
  };
}

function featurePlanOptions(request: ParametricCadRebuildRequest): { readonly changedFeatureIds?: readonly FeatureId[]; readonly includeDirty?: boolean } {
  return {
    ...(request.changedFeatureIds === undefined ? {} : { changedFeatureIds: request.changedFeatureIds }),
    ...(request.includeDirty === undefined ? {} : { includeDirty: request.includeDirty })
  };
}

function referencedSketchIds(feature: CadFeature): readonly SketchId[] {
  const ids = new Set<SketchId>();
  for (const input of feature.inputs) {
    if (input.kind === "sketch-element") ids.add(input.sketchId);
    else if (input.kind === "sketch") ids.add(input.id);
  }
  return [...ids].sort((first, second) => first.localeCompare(second));
}

function failedRecord(feature: CadFeature, operationKind: FeatureEvaluationRecord["operationKind"], diagnostics: readonly EngineDiagnostic[], retained: boolean): FeatureEvaluationRecord {
  return { featureId: feature.id, status: "failed", reason: "evaluation-failed", operationKind, diagnostics, retainedLastGood: retained, kernelResultDigest: null };
}

function blockedRecord(featureId: FeatureId, blockers: readonly string[], diagnostics: readonly EngineDiagnostic[], retained: boolean): FeatureEvaluationRecord {
  return { featureId, status: "blocked", reason: `blocked-by:${blockers.join(",")}`, operationKind: null, diagnostics, retainedLastGood: retained, kernelResultDigest: null };
}

function exactGeometryHandle(shape: KernelExecutionProducts["geometry"]["outputs"][number]): string {
  return `${shape.sessionId}/${shape.shapeId}@${shape.revision}#${shape.contentDigest}`;
}

function cadSketchClassification(result: SketchSolveResult): "under-constrained" | "fully-constrained" | "over-constrained" | "conflicting" {
  if (result.dof.classification === "fully-constrained") return "fully-constrained";
  if (result.dof.classification === "under-constrained") return "under-constrained";
  if (result.dof.classification === "over-constrained") return "over-constrained";
  return "conflicting";
}

function assertRequest(request: ParametricCadRebuildRequest): void {
  if (!REQUEST_ID.test(request.requestId)) throw new TypeError("Parametric CAD requestId must be a stable lowercase prefixed ID.");
  if (!REQUEST_ID.test(request.sessionId)) throw new TypeError("Exact-kernel sessionId must be a stable lowercase prefixed ID.");
  if (!Number.isSafeInteger(request.generation) || request.generation < 0) throw new TypeError("generation must be a non-negative safe integer.");
}

function kernelRequestId(request: ParametricCadRebuildRequest, suffix: string): string {
  const local = `${request.generation}-${slug(suffix)}`.slice(0, 90);
  return `kernel:${local}`;
}

function rebuildOperationId(requestId: string): string {
  return `rebuild:${slug(requestId).slice(0, 86)}`;
}

function slug(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return result.length > 0 ? result : "request";
}

function engineDiagnostic(
  code: EngineDiagnostic["code"],
  severity: EngineDiagnostic["severity"],
  stage: EngineDiagnostic["stage"],
  message: string,
  relatedIds: readonly string[],
  recovery: string,
  sourceCodes: readonly string[] = []
): EngineDiagnostic {
  return { code, severity, stage, message, relatedIds, recovery, sourceCodes };
}

function cadDiagnostic(item: CadDiagnostic): EngineDiagnostic {
  return engineDiagnostic("INVALID_DOCUMENT", item.severity, "validation", item.message, item.relatedIds, item.recovery, [item.code]);
}

function sketchDiagnostic(item: SketchDiagnostic): EngineDiagnostic {
  return engineDiagnostic("SKETCH_SOLVE_FAILED", item.severity, "sketch", item.message, item.relatedIds, item.recovery, [item.code]);
}

function kernelProtocolDiagnostic(item: KernelDiagnostic): EngineDiagnostic {
  return engineDiagnostic("KERNEL_PROTOCOL_FAILED", item.severity, "kernel", item.message, [...item.relatedSemanticIds, ...item.relatedReferenceKeys], item.recovery, [item.code]);
}

function kernelDiagnostic(item: KernelDiagnostic): EngineDiagnostic {
  return engineDiagnostic("KERNEL_OPERATION_FAILED", item.severity, "kernel", item.message, [...item.relatedSemanticIds, ...item.relatedReferenceKeys], item.recovery, [item.code]);
}

function engineCadDiagnostic(item: EngineDiagnostic): CadDiagnostic {
  return {
    code: item.code === "DEPENDENCY_BLOCKED" || item.code === "DEPENDENCY_RESULT_MISSING" ? "DEPENDENCY_BLOCKED"
      : item.stage === "sketch" ? "INVALID_SKETCH" : "FEATURE_EVALUATION_FAILED",
    severity: item.severity,
    message: item.message,
    relatedIds: item.relatedIds,
    recovery: item.recovery
  };
}

function byFeatureId(first: FeatureLastGoodResult, second: FeatureLastGoodResult): number {
  return first.featureId.localeCompare(second.featureId);
}

function bySketchId(first: SketchLastGoodResult, second: SketchLastGoodResult): number {
  return first.sketchId.localeCompare(second.sketchId);
}

function compareDiagnostics(first: EngineDiagnostic, second: EngineDiagnostic): number {
  return `${first.stage}:${first.code}:${first.relatedIds.join("|")}:${first.message}`.localeCompare(`${second.stage}:${second.code}:${second.relatedIds.join("|")}:${second.message}`);
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
