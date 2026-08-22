import {
  CommandSession,
  classifyCommandRetry,
  classifyHistoryRetry,
  type DocumentCommand
} from "../../commands/src/index.js";
import {
  buildRevisionEvidence,
  revisionEvidenceEqual,
  type RevisionEvidence
} from "../../evidence/src/index.js";
import { exportBinaryStl } from "../../import-export/src/index.js";
import {
  fail,
  isDiagnosticCode,
  isStableId,
  PARAMETER_IDS,
  parameterByKey,
  validateCadDocument,
  type CadDocument,
  type Diagnostic,
  type Result
} from "../../model-schema/src/index.js";
import { IndexedDbModelRepository } from "../../persistence/src/index.js";
import { validateDocumentSketch } from "../../sketch-kernel/src/index.js";
import { BracketSolidKernel } from "../../solid-bracket-kernel/src/index.js";
import type { EvaluatedSolid, SolidKernel } from "../../solid-kernel-api/src/index.js";
import {
  isWorkerRequest,
  requestCorrelation,
  type CommandResult,
  type ModelSuccessResponse,
  type WorkerFailureResponse,
  type WorkerRequest,
  type WorkerResponse
} from "../../worker-protocol/src/index.js";

interface WorkerScope {
  onmessage: ((event: MessageEvent<unknown>) => void) | null;
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
}

interface Evaluation {
  readonly solid: EvaluatedSolid;
  readonly evidence: RevisionEvidence;
}

const scope = self as unknown as WorkerScope;
const repository = new IndexedDbModelRepository();
const kernel: SolidKernel = new BracketSolidKernel();
let session: CommandSession | undefined;
let currentEvaluation: Evaluation | undefined;
let queue = Promise.resolve();

scope.onmessage = (event) => {
  const correlation = requestCorrelation(event.data) ?? { requestId: "request:invalid", generation: 0 };
  queue = queue.then(async () => {
    if (!isWorkerRequest(event.data)) {
      postFailure(correlation.requestId, correlation.generation, [diagnostic("INVALID_GRAPH", "The worker request envelope is invalid.", "Retry after restarting the geometry worker.")]);
      return;
    }
    await handle(event.data);
  }).catch(() => {
    postFailure(correlation.requestId, correlation.generation, [diagnostic("WORKER_FAILURE", "The geometry worker stopped the current operation.", "Restart from the last committed local revision.")]);
  });
};

async function handle(request: WorkerRequest): Promise<void> {
  if (request.kind === "bootstrap") {
    await bootstrap(request);
    return;
  }
  if (session === undefined || currentEvaluation === undefined) {
    postFailure(request.requestId, request.generation, [diagnostic("WORKER_FAILURE", "The geometry worker is not initialized.", "Restart the worker and restore the latest committed revision.")]);
    return;
  }
  if (request.kind === "commit") {
    await commit(request);
    return;
  }
  if (request.kind === "history") {
    await moveHistory(request);
    return;
  }
  if (request.baseRevision !== session.current.revision) {
    postRevisionConflict(request.requestId, request.generation, request.baseRevision);
    return;
  }
  if (request.kind === "persist") {
    const saved = await repository.saveCommitted({ document: session.current, evidence: currentEvaluation.evidence });
    if (!saved.ok) postFailure(request.requestId, request.generation, saved.diagnostics);
    else scope.postMessage({ protocolVersion: 1, requestId: request.requestId, generation: request.generation, currentRevision: session.current.revision, status: "ok", kind: "persist" });
    return;
  }
  const exported = exportBinaryStl(currentEvaluation.solid, request.unit);
  if (!exported.ok) {
    postFailure(request.requestId, request.generation, exported.diagnostics);
    return;
  }
  const response: WorkerResponse = {
    protocolVersion: 1,
    requestId: request.requestId,
    generation: request.generation,
    currentRevision: session.current.revision,
    status: "ok",
    kind: "export-stl",
    bytes: exported.value.bytes,
    unit: request.unit,
    triangleCount: exported.value.triangleCount
  };
  scope.postMessage(response, [exported.value.bytes]);
}

async function bootstrap(request: Extract<WorkerRequest, { kind: "bootstrap" }>): Promise<void> {
  const fallback = validateCadDocument(request.fallbackDocument);
  if (!fallback.ok) {
    postFailure(request.requestId, request.generation, fallback.diagnostics);
    return;
  }
  let document = fallback.value;
  let expectedEvidence = request.fallbackEvidence;
  let recovered = false;
  if (request.recoverLocal) {
    const loaded = await repository.loadLatest();
    if (!loaded.ok) {
      postFailure(request.requestId, request.generation, loaded.diagnostics);
      return;
    }
    if (loaded.value !== null) {
      document = loaded.value.document;
      expectedEvidence = loaded.value.evidence;
      recovered = true;
    }
  }
  const evaluation = await evaluate(document);
  if (!evaluation.ok) {
    postFailure(request.requestId, request.generation, evaluation.diagnostics);
    return;
  }
  if (expectedEvidence !== null && !revisionEvidenceEqual(expectedEvidence, evaluation.value.evidence)) {
    postFailure(request.requestId, request.generation, [diagnostic(
      "UNSUPPORTED_OR_CORRUPT_FILE",
      "Stored revision evidence does not match replay under the current qualified evaluator build.",
      "Open an artifact produced by this build or retain the prior build for migration."
    )]);
    return;
  }
  session = new CommandSession(document);
  currentEvaluation = evaluation.value;
  postModel(request.requestId, request.generation, "bootstrap", document, evaluation.value, document.parameters.map((parameter) => parameter.id), recovered, null);
}

async function commit(request: Extract<WorkerRequest, { kind: "commit" }>): Promise<void> {
  const retry = classifyCommandRetry(session!.current, request.command);
  if (retry === "exact-retry") {
    postModel(request.requestId, request.generation, "commit", session!.current, currentEvaluation!, [], false, commandResult(session!.current, request.command.commandId, "replayed"));
    return;
  }
  if (retry === "conflict") {
    postFailure(request.requestId, request.generation, [idempotencyDiagnostic(request.command.commandId)]);
    return;
  }
  let proposed: Evaluation | undefined;
  const result = await session!.execute(request.command, async (candidate) => {
    const evaluated = await evaluate(candidate);
    if (!evaluated.ok) return evaluated;
    const saved = await repository.saveCommitted({ document: candidate, evidence: evaluated.value.evidence });
    if (!saved.ok) return saved;
    proposed = evaluated.value;
    return { ok: true, value: undefined };
  });
  if (!result.ok || proposed === undefined) {
    postFailure(request.requestId, request.generation, result.ok
      ? [diagnostic("WORKER_FAILURE", "The evaluated candidate was not retained.", "Restart the worker from the latest commit.")]
      : result.diagnostics);
    return;
  }
  currentEvaluation = proposed;
  postModel(request.requestId, request.generation, "commit", result.value, proposed, changedIds(request.command), false, commandResult(result.value, request.command.commandId, "committed"));
}

async function moveHistory(request: Extract<WorkerRequest, { kind: "history" }>): Promise<void> {
  const retry = classifyHistoryRetry(session!.current, request.direction, request.commandId, request.baseRevision);
  if (retry === "exact-retry") {
    postModel(request.requestId, request.generation, request.direction, session!.current, currentEvaluation!, [], false, commandResult(session!.current, request.commandId, "replayed"));
    return;
  }
  if (retry === "conflict") {
    postFailure(request.requestId, request.generation, [idempotencyDiagnostic(request.commandId)]);
    return;
  }
  if (request.baseRevision !== session!.current.revision) {
    postRevisionConflict(request.requestId, request.generation, request.baseRevision);
    return;
  }
  let proposed: Evaluation | undefined;
  const validate = async (candidate: CadDocument): Promise<Result<void>> => {
    const evaluated = await evaluate(candidate);
    if (!evaluated.ok) return evaluated;
    const saved = await repository.saveCommitted({ document: candidate, evidence: evaluated.value.evidence });
    if (!saved.ok) return saved;
    proposed = evaluated.value;
    return { ok: true, value: undefined };
  };
  const result = request.direction === "undo"
    ? await session!.undo(request.commandId, validate)
    : await session!.redo(request.commandId, validate);
  if (!result.ok || proposed === undefined) {
    postFailure(request.requestId, request.generation, result.ok
      ? [diagnostic("WORKER_FAILURE", "History evaluation did not complete.", "Restart from the latest local revision.")]
      : result.diagnostics);
    return;
  }
  currentEvaluation = proposed;
  postModel(request.requestId, request.generation, request.direction, result.value, proposed, result.value.parameters.map((parameter) => parameter.id), false, commandResult(result.value, request.commandId, "committed"));
}

async function evaluate(document: CadDocument): Promise<Result<Evaluation>> {
  const sketch = validateDocumentSketch(document);
  if (!sketch.ok) return sketch;
  if (sketch.value.classification !== "fully-constrained" || sketch.value.profile === undefined) {
    return fail("UNDERCONSTRAINED", "Only a fully constrained bracket profile can regenerate.", [document.sketches[0].id], "Complete the missing driving dimensions.");
  }
  const solid = await kernel.buildBracket({
    bodyId: document.bodies[0].id,
    widthMeters: parameterByKey(document, "width").valueMeters,
    heightMeters: parameterByKey(document, "height").valueMeters,
    thicknessMeters: parameterByKey(document, "thickness").valueMeters,
    holeDiameterMeters: parameterByKey(document, "holeDiameter").valueMeters,
    circularSegments: 96
  });
  if (!solid.ok) return solid;
  try {
    const evidence = await buildRevisionEvidence(document, solid.value);
    return { ok: true, value: { solid: solid.value, evidence } };
  } catch {
    return fail("INVALID_SOLID_OUTPUT", "Geometry evidence generation failed.", [document.bodies[0].id], "Restore the last valid dimensions and retry.");
  }
}

function postModel(
  requestId: string,
  generation: number,
  operation: ModelSuccessResponse["operation"],
  document: CadDocument,
  evaluation: Evaluation,
  changedSemanticIds: readonly string[],
  recoveredFromLocal: boolean,
  command: CommandResult | null
): void {
  const positions = evaluation.solid.mesh.positions.slice();
  const indices = evaluation.solid.mesh.indices.slice();
  const response: ModelSuccessResponse = {
    protocolVersion: 1,
    requestId,
    generation,
    currentRevision: document.revision,
    status: "ok",
    kind: "model",
    operation,
    document,
    evidence: evaluation.evidence,
    render: {
      bodyId: evaluation.solid.bodyId,
      positions,
      indices,
      measurements: evaluation.solid.measurements,
      topology: evaluation.solid.topology
    },
    changedSemanticIds,
    recoveredFromLocal,
    history: { undoDepth: session!.undoDepth, redoDepth: session!.redoDepth },
    commandResult: command
  };
  scope.postMessage(response, [positions.buffer as ArrayBuffer, indices.buffer as ArrayBuffer]);
}

function postFailure(requestId: string, generation: number, diagnostics: readonly Diagnostic[]): void {
  const response: WorkerFailureResponse = {
    protocolVersion: 1,
    requestId,
    generation,
    currentRevision: session?.current.revision ?? 0,
    status: "error",
    kind: "failure",
    diagnostics: sanitizeDiagnostics(diagnostics)
  };
  scope.postMessage(response);
}

function postRevisionConflict(requestId: string, generation: number, requestedRevision: number): void {
  postFailure(requestId, generation, [diagnostic(
    "REVISION_CONFLICT",
    `Request revision ${requestedRevision} is stale; current is ${session!.current.revision}.`,
    "Reload the current revision before retrying."
  )]);
}

function diagnostic(code: Diagnostic["code"], message: string, recovery: string): Diagnostic {
  return { code, severity: "error", message, relatedIds: [], recovery };
}

function idempotencyDiagnostic(commandId: string): Diagnostic {
  return { code: "IDEMPOTENCY_CONFLICT", severity: "error", message: "A committed command ID was reused with different intent.", relatedIds: [commandId], recovery: "Generate a new command ID for a different operation." };
}

function sanitizeDiagnostics(diagnostics: readonly Diagnostic[]): readonly Diagnostic[] {
  const safe = diagnostics.slice(0, 16).map((item): Diagnostic => ({
    code: isDiagnosticCode(item.code) ? item.code : "WORKER_FAILURE",
    severity: item.severity === "warning" ? "warning" : "error",
    message: sanitizeText(item.message, "The operation failed."),
    relatedIds: item.relatedIds.filter(isStableId).slice(0, 32),
    recovery: sanitizeText(item.recovery, "Restore the last committed revision.")
  }));
  return safe.length > 0 ? safe : [diagnostic("WORKER_FAILURE", "The operation failed.", "Restore the last committed revision.")];
}

function sanitizeText(value: string, fallback: string): string {
  const normalized = value.replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 500);
  return normalized.length > 0 ? normalized : fallback;
}

function commandResult(document: CadDocument, commandId: string, disposition: CommandResult["disposition"]): CommandResult {
  const entry = document.commandJournal.find((candidate) => candidate.commandId === commandId);
  if (entry === undefined) throw new TypeError("Committed command result is absent from the validated journal.");
  return { commandId, commandRevision: entry.revision, disposition };
}

function changedIds(command: DocumentCommand): readonly string[] {
  return command.kind === "set-parameter"
    ? [PARAMETER_IDS[command.parameterKey], "sketch:bracket-profile", "body:bracket"]
    : ["document:display-unit"];
}
