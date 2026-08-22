import { isDocumentCommand } from "../../commands/src/index.js";
import {
  canonicalMeshHash,
  commandJournalPrefixHash,
  isRevisionEvidence,
  revisionEvidenceEqual,
  semanticDocumentHash
} from "../../evidence/src/index.js";
import {
  hasExactKeys,
  isDiagnosticCode,
  isDisplayUnit,
  isStableId,
  replayCommandJournal,
  validateCadDocument
} from "../../model-schema/src/index.js";
import { validateClosedMesh } from "../../solid-kernel-api/src/index.js";
import type {
  CommandResult,
  ModelSuccessResponse,
  WorkerRequest,
  WorkerResponse
} from "./index.js";

const REQUEST_ID = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u;

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  try {
    if (!hasRequestEnvelope(value)) return false;
    if (value.kind === "bootstrap") {
      if (!hasExactKeys(value, ["protocolVersion", "requestId", "generation", "kind", "fallbackDocument", "fallbackEvidence", "recoverLocal"])
        || typeof value.recoverLocal !== "boolean") return false;
      const document = validateCadDocument(value.fallbackDocument);
      return document.ok && (value.fallbackEvidence === null || isRevisionEvidence(value.fallbackEvidence, document.value));
    }
    if (!isRevision(value.baseRevision)) return false;
    if (value.kind === "commit") {
      return hasExactKeys(value, ["protocolVersion", "requestId", "generation", "kind", "baseRevision", "command"])
        && isDocumentCommand(value.command) && value.command.expectedRevision === value.baseRevision;
    }
    if (value.kind === "history") {
      return hasExactKeys(value, ["protocolVersion", "requestId", "generation", "kind", "baseRevision", "direction", "commandId"])
        && (value.direction === "undo" || value.direction === "redo") && isCommandId(value.commandId);
    }
    if (value.kind === "export-stl") {
      return hasExactKeys(value, ["protocolVersion", "requestId", "generation", "kind", "baseRevision", "unit"])
        && isDisplayUnit(value.unit);
    }
    return value.kind === "persist"
      && hasExactKeys(value, ["protocolVersion", "requestId", "generation", "kind", "baseRevision"]);
  } catch {
    return false;
  }
}

function isWorkerResponseStructure(value: unknown): value is WorkerResponse {
  try {
    if (!hasResponseEnvelope(value)) return false;
    if (value.status === "error") return isFailure(value);
    if (value.status !== "ok") return false;
    if (value.kind === "persist") {
      return hasExactKeys(value, ["protocolVersion", "requestId", "generation", "currentRevision", "status", "kind"]);
    }
    if (value.kind === "export-stl") return isExport(value);
    return value.kind === "model" && isModel(value);
  } catch {
    return false;
  }
}

function isExpectedWorkerResponseStructure(response: WorkerResponse, request: WorkerRequest): boolean {
  if (response.requestId !== request.requestId || response.generation !== request.generation) return false;
  if (response.status === "error") return true;
  if (request.kind === "bootstrap") {
    return response.kind === "model" && response.operation === "bootstrap" && response.commandResult === null;
  }
  if (request.kind === "commit") {
    if (response.kind !== "model" || response.operation !== "commit" || response.recoveredFromLocal
      || response.commandResult?.commandId !== request.command.commandId) return false;
    const entry = response.document.commandJournal[response.commandResult.commandRevision];
    if (entry?.parentRevision !== request.baseRevision || entry.kind !== request.command.kind) return false;
    return entry.kind === "set-parameter"
      ? request.command.kind === "set-parameter" && entry.parameterKey === request.command.parameterKey
        && entry.expression.decimal === request.command.expression.decimal && entry.expression.unit === request.command.expression.unit
      : request.command.kind === "set-display-unit" && entry.displayUnit === request.command.displayUnit;
  }
  if (request.kind === "history") {
    if (response.kind !== "model" || response.operation !== request.direction || response.recoveredFromLocal
      || response.commandResult?.commandId !== request.commandId) return false;
    const entry = response.document.commandJournal[response.commandResult.commandRevision];
    return entry?.kind === request.direction && entry.parentRevision === request.baseRevision;
  }
  if (request.kind === "export-stl") return response.kind === "export-stl" && response.unit === request.unit
    && response.currentRevision === request.baseRevision;
  return response.kind === "persist" && response.currentRevision === request.baseRevision;
}

export async function validateWorkerResponse(value: unknown): Promise<WorkerResponse | null> {
  if (!isWorkerResponseStructure(value)) return null;
  if (value.status === "error" || value.kind !== "model") return value;
  try {
    const mesh = { positions: value.render.positions, indices: value.render.indices };
    const validatedMesh = validateClosedMesh(mesh);
    if (!validatedMesh.ok) return null;
    const [semanticHash, journalHash, meshHash] = await Promise.all([
      semanticDocumentHash(value.document),
      commandJournalPrefixHash(value.document.commandJournal),
      canonicalMeshHash(mesh)
    ]);
    if (semanticHash !== value.evidence.semanticHash
      || journalHash !== value.evidence.commandJournalPrefixHash
      || meshHash !== value.evidence.body.canonicalMeshHash) return null;
    if (!sameMeasurements(validatedMesh.value.measurements, value.render.measurements)
      || !sameTopology(validatedMesh.value.topology, value.render.topology)) return null;
    return value;
  } catch {
    return null;
  }
}

export async function validateExpectedWorkerResponse(value: unknown, request: WorkerRequest): Promise<WorkerResponse | null> {
  const response = await validateWorkerResponse(value);
  if (response === null || !isExpectedWorkerResponseStructure(response, request)) return null;
  if (response.status === "error" || request.kind !== "bootstrap") return response;
  if (response.kind !== "model") return null;
  if (response.recoveredFromLocal) return request.recoverLocal ? response : null;
  try {
    if (response.evidence.semanticHash !== await semanticDocumentHash(request.fallbackDocument)) return null;
    if (request.fallbackEvidence !== null && !revisionEvidenceEqual(response.evidence, request.fallbackEvidence)) return null;
    return response;
  } catch {
    return null;
  }
}

export function requestCorrelation(value: unknown): { requestId: string; generation: number } | null {
  try {
    if (!isPlainRecord(value) || !isRequestId(value.requestId) || !isRevision(value.generation)) return null;
    return { requestId: value.requestId, generation: value.generation };
  } catch {
    return null;
  }
}

function isModel(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, [
    "protocolVersion", "requestId", "generation", "currentRevision", "status", "kind", "operation", "document",
    "evidence", "render", "changedSemanticIds", "recoveredFromLocal", "history", "commandResult"
  ]) || !(value.operation === "bootstrap" || value.operation === "commit" || value.operation === "undo" || value.operation === "redo")
    || typeof value.recoveredFromLocal !== "boolean") return false;
  const document = validateCadDocument(value.document);
  if (!document.ok || document.value.revision !== value.currentRevision || !isRevisionEvidence(value.evidence, document.value)
    || value.evidence.body.id !== document.value.bodies[0].id || !isRender(value.render, value.evidence, document.value.bodies[0].id)
    || !isChangedIds(value.changedSemanticIds) || !isHistory(value.history, document.value)) return false;
  if (value.operation === "bootstrap") return value.commandResult === null;
  return isCommandResult(value.commandResult, value.operation, document.value.commandJournal);
}

function isRender(value: unknown, evidence: ModelSuccessResponse["evidence"], bodyId: string): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["bodyId", "positions", "indices", "measurements", "topology"])
    || value.bodyId !== bodyId || !(value.positions instanceof Float64Array) || !(value.indices instanceof Uint32Array)
    || value.positions.length === 0 || value.positions.length % 3 !== 0 || value.indices.length === 0 || value.indices.length % 3 !== 0) return false;
  const vertexCount = value.positions.length / 3;
  if (vertexCount > 750_000 || value.indices.length / 3 > 250_000) return false;
  if (!allFinite(value.positions) || !isMeasurements(value.measurements) || !isTopology(value.topology)) return false;
  const used = new Set<number>();
  for (let offset = 0; offset < value.indices.length; offset += 3) {
    const a = value.indices[offset]!;
    const b = value.indices[offset + 1]!;
    const c = value.indices[offset + 2]!;
    if (a >= vertexCount || b >= vertexCount || c >= vertexCount || a === b || b === c || c === a) return false;
    used.add(a); used.add(b); used.add(c);
  }
  if (used.size !== vertexCount || value.indices.length / 3 > 250_000 || value.topology.vertices !== vertexCount
    || value.topology.triangles !== value.indices.length / 3) return false;
  return sameMeasurements(value.measurements, evidence.body) && sameTopology(value.topology, evidence.body.topology);
}

function isMeasurements(value: unknown): value is ModelSuccessResponse["render"]["measurements"] {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["boundsMeters", "surfaceAreaSquareMeters", "volumeCubicMeters"])
    || !isPositive(value.surfaceAreaSquareMeters) || !isPositive(value.volumeCubicMeters) || !isBounds(value.boundsMeters)) return false;
  return true;
}

function isBounds(value: unknown): value is ModelSuccessResponse["render"]["measurements"]["boundsMeters"] {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["min", "max", "size"])
    || !isTriple(value.min) || !isTriple(value.max) || !isTriple(value.size)) return false;
  const minimum = value.min;
  const maximum = value.max;
  return value.size.every((part, axis) => part > 0 && Math.abs(part - (maximum[axis]! - minimum[axis]!)) <= 1e-12);
}

function isTopology(value: unknown): value is ModelSuccessResponse["render"]["topology"] {
  return isPlainRecord(value) && hasExactKeys(value, [
    "vertices", "edges", "triangles", "components", "genus", "closed", "manifold", "consistentlyOriented"
  ]) && isPositiveInteger(value.vertices) && isPositiveInteger(value.edges) && isPositiveInteger(value.triangles)
    && (value.triangles as number) <= 250_000 && (value.vertices as number) <= 750_000
    && isPositiveInteger(value.components) && isRevision(value.genus) && value.closed === true && value.manifold === true
    && value.consistentlyOriented === true;
}

function isHistory(value: unknown, document: ModelSuccessResponse["document"]): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["undoDepth", "redoDepth"])
    || !isRevision(value.undoDepth) || !isRevision(value.redoDepth)) return false;
  const replay = replayCommandJournal(document.commandJournal, document.revision, document.commandId);
  return replay.ok && value.undoDepth === replay.value.undoRevisions.length && value.redoDepth === replay.value.redoRevisions.length;
}

function isCommandResult(value: unknown, operation: Exclude<ModelSuccessResponse["operation"], "bootstrap">, journal: ModelSuccessResponse["document"]["commandJournal"]): value is CommandResult {
  if (!isPlainRecord(value) || !hasExactKeys(value, ["commandId", "commandRevision", "disposition"])
    || !isCommandId(value.commandId) || !isRevision(value.commandRevision)
    || !(value.disposition === "committed" || value.disposition === "replayed")) return false;
  const entry = journal[value.commandRevision];
  if (entry === undefined || entry.commandId !== value.commandId) return false;
  if (value.disposition === "committed" && value.commandRevision !== journal.length - 1) return false;
  return operation === "commit" ? entry.kind === "set-parameter" || entry.kind === "set-display-unit" : entry.kind === operation;
}

function isExport(value: Record<string, unknown>): boolean {
  if (!hasExactKeys(value, ["protocolVersion", "requestId", "generation", "currentRevision", "status", "kind", "bytes", "unit", "triangleCount"])
    || !(value.bytes instanceof ArrayBuffer) || !isDisplayUnit(value.unit) || !isPositiveInteger(value.triangleCount)
    || (value.triangleCount as number) > 250_000) return false;
  const triangleCount = value.triangleCount as number;
  if (value.bytes.byteLength !== 84 + triangleCount * 50) return false;
  const bytes = new Uint8Array(value.bytes);
  const header = new TextDecoder().decode(bytes.subarray(0, 80)).replace(/\0+$/u, "");
  if (header !== `PS3D Phase 0 | unit=${value.unit} | closed mesh solid`) return false;
  const view = new DataView(value.bytes);
  if (view.getUint32(80, true) !== triangleCount) return false;
  for (let triangle = 0; triangle < triangleCount; triangle += 1) {
    const record = 84 + triangle * 50;
    for (let component = 0; component < 12; component += 1) {
      if (!Number.isFinite(view.getFloat32(record + component * 4, true))) return false;
    }
    if (view.getUint16(record + 48, true) !== 0) return false;
  }
  return true;
}

function isFailure(value: Record<string, unknown>): boolean {
  return value.kind === "failure" && hasExactKeys(value, [
    "protocolVersion", "requestId", "generation", "currentRevision", "status", "kind", "diagnostics"
  ]) && Array.isArray(value.diagnostics) && value.diagnostics.length > 0 && value.diagnostics.length <= 16
    && value.diagnostics.every(isDiagnostic);
}

function isDiagnostic(value: unknown): boolean {
  return isPlainRecord(value) && hasExactKeys(value, ["code", "severity", "message", "relatedIds", "recovery"])
    && isDiagnosticCode(value.code) && (value.severity === "warning" || value.severity === "error")
    && isSafeText(value.message) && isSafeText(value.recovery) && Array.isArray(value.relatedIds)
    && value.relatedIds.length <= 32 && value.relatedIds.every(isStableId);
}

function hasRequestEnvelope(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && value.protocolVersion === 1 && isRequestId(value.requestId) && isRevision(value.generation);
}

function hasResponseEnvelope(value: unknown): value is Record<string, unknown> {
  return isPlainRecord(value) && value.protocolVersion === 1 && isRequestId(value.requestId)
    && isRevision(value.generation) && isRevision(value.currentRevision);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isChangedIds(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 32 && value.every(isStableId) && new Set(value).size === value.length;
}

function sameMeasurements(
  left: ModelSuccessResponse["render"]["measurements"],
  right: ModelSuccessResponse["render"]["measurements"]
): boolean {
  return left.surfaceAreaSquareMeters === right.surfaceAreaSquareMeters
    && left.volumeCubicMeters === right.volumeCubicMeters
    && (["min", "max", "size"] as const).every((key) => left.boundsMeters[key].every((part, axis) => part === right.boundsMeters[key][axis]));
}

function sameTopology(left: ModelSuccessResponse["render"]["topology"], right: ModelSuccessResponse["evidence"]["body"]["topology"]): boolean {
  return left.vertices === right.vertices && left.edges === right.edges && left.triangles === right.triangles
    && left.components === right.components && left.genus === right.genus && left.closed === right.closed
    && left.manifold === right.manifold && left.consistentlyOriented === right.consistentlyOriented;
}

function isTriple(value: unknown): value is [number, number, number] {
  return Array.isArray(value) && value.length === 3 && value.every((part) => typeof part === "number" && Number.isFinite(part));
}

function allFinite(value: Float64Array): boolean {
  for (const part of value) if (!Number.isFinite(part)) return false;
  return true;
}

function isRequestId(value: unknown): value is string { return typeof value === "string" && value.length <= 128 && REQUEST_ID.test(value); }
function isCommandId(value: unknown): value is string { return typeof value === "string" && /^command:[a-z0-9][a-z0-9._-]{0,100}$/u.test(value); }
function isRevision(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
function isPositiveInteger(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) > 0; }
function isPositive(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value > 0; }
function isSafeText(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 500 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value); }
