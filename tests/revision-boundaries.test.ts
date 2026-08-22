import { CommandSession } from "../packages/commands/src/index.js";
import { buildRevisionEvidence, type RevisionEvidence } from "../packages/evidence/src/index.js";
import { exportBinaryStl, parseNativeRevisionText, serializeNativeRevision } from "../packages/import-export/src/index.js";
import { createBracketDocument, type CadDocument } from "../packages/model-schema/src/index.js";
import { BracketSolidKernel } from "../packages/solid-bracket-kernel/src/index.js";
import type { EvaluatedSolid } from "../packages/solid-kernel-api/src/index.js";
import {
  isWorkerRequest,
  validateExpectedWorkerResponse,
  validateWorkerResponse,
  type CommandResult,
  type ModelSuccessResponse,
  type WorkerRequest,
  type WorkerResponse
} from "../packages/worker-protocol/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

const ACCEPT = () => ({ ok: true as const, value: undefined });

export const revisionBoundaryTests: readonly TestCase[] = [
  {
    name: "every worker request variant is exact and fail-closed through nested commands",
    run: () => {
      const document = createBracketDocument("document:test-protocol-requests");
      const command = {
        protocolVersion: 1 as const,
        kind: "set-parameter" as const,
        commandId: "command:protocol-width",
        expectedRevision: 0,
        parameterKey: "width" as const,
        expression: { decimal: "70", unit: "mm" as const }
      };
      const valid: WorkerRequest[] = [
        { protocolVersion: 1, requestId: "request:bootstrap", generation: 1, kind: "bootstrap", fallbackDocument: document, fallbackEvidence: null, recoverLocal: true },
        { protocolVersion: 1, requestId: "request:commit", generation: 1, kind: "commit", baseRevision: 0, command },
        { protocolVersion: 1, requestId: "request:history", generation: 1, kind: "history", baseRevision: 0, direction: "undo", commandId: "command:protocol-undo" },
        { protocolVersion: 1, requestId: "request:export", generation: 1, kind: "export-stl", baseRevision: 0, unit: "mm" },
        { protocolVersion: 1, requestId: "request:persist", generation: 1, kind: "persist", baseRevision: 0 }
      ];
      valid.forEach((request) => assert(isWorkerRequest(request), `valid ${request.kind} request must pass`));

      const malformed: unknown[] = valid.map((request) => ({ ...structuredClone(request), unexpected: true }));
      for (const request of valid) {
        for (const key of Object.keys(request)) {
          const missing = structuredClone(request) as unknown as Record<string, unknown>;
          delete missing[key];
          malformed.push(missing);
        }
      }
      malformed.push(
        { ...valid[1], baseRevision: 1 },
        { ...valid[1], command: { ...command, ignored: true } },
        { ...valid[1], command: { ...command, expression: { ...command.expression, ignored: true } } },
        { ...valid[1], command: { ...command, expectedRevision: -1 } },
        { ...valid[1], command: { ...command, expectedRevision: 0.5 } },
        { ...valid[1], command: { ...command, expression: { decimal: "1".repeat(65), unit: "mm" } } },
        { ...valid[2], commandId: "" },
        { ...valid[2], commandId: `command:${"a".repeat(102)}` },
        { ...valid[3], unit: "cm" },
        { ...valid[4], generation: Number.NaN },
        new Proxy({}, { ownKeys: () => { throw new Error("hostile"); } })
      );
      malformed.forEach((request) => assert(!isWorkerRequest(request), "malformed requests must reject without throwing"));
    }
  },
  {
    name: "every worker response variant validates exact payloads and pending-request correlation",
    run: async () => {
      const fixture = await createResponseFixture();
      const responses: WorkerResponse[] = [fixture.bootstrap, fixture.commit, fixture.undo, fixture.redo, fixture.exported, fixture.persisted, fixture.failed];
      for (const response of responses) assert(await validateWorkerResponse(response) !== null, `valid ${response.kind} response must pass`);
      assert(await validateExpectedWorkerResponse(fixture.bootstrap, fixture.requests.bootstrap) !== null, "bootstrap response must correlate");
      assert(await validateExpectedWorkerResponse(fixture.commit, fixture.requests.commit) !== null, "commit response must correlate");
      assert(await validateExpectedWorkerResponse(fixture.undo, fixture.requests.undo) !== null, "undo response must correlate");
      assert(await validateExpectedWorkerResponse(fixture.redo, fixture.requests.redo) !== null, "redo response must correlate");
      assert(await validateExpectedWorkerResponse(fixture.exported, fixture.requests.exported) !== null, "export response must correlate");
      assert(await validateExpectedWorkerResponse(fixture.persisted, fixture.requests.persisted) !== null, "persist response must correlate");
      assert(await validateExpectedWorkerResponse(fixture.failed, fixture.requests.commit) !== null, "typed failure may answer the matching request");
      assert(await validateExpectedWorkerResponse({ ...fixture.persisted, requestId: fixture.requests.commit.requestId }, fixture.requests.commit) === null, "wrong success variant must not satisfy a pending commit");

      const alternate = createBracketDocument(fixture.bootstrap.document.id, "in");
      const alternateBootstrap = await modelResponse(alternate, "bootstrap", fixture.requests.bootstrap.requestId, null);
      assert(await validateExpectedWorkerResponse(alternateBootstrap, fixture.requests.bootstrap) === null, "non-recovered bootstrap must bind the complete fallback document");
      const recoveredBootstrap = { ...structuredClone(fixture.bootstrap), recoveredFromLocal: true };
      assert(await validateExpectedWorkerResponse(recoveredBootstrap, fixture.requests.bootstrap) !== null, "a requested local recovery may return a verified recovered revision");
      const noRecoveryRequest = { ...fixture.requests.bootstrap, recoverLocal: false };
      assert(await validateExpectedWorkerResponse(recoveredBootstrap, noRecoveryRequest) === null, "an unrequested recovered revision must not satisfy bootstrap");
      assert(await validateExpectedWorkerResponse({ ...structuredClone(fixture.commit), recoveredFromLocal: true }, fixture.requests.commit) === null, "commit responses cannot claim local recovery");
    }
  },
  {
    name: "malformed success and failure responses reject nested evidence, render, buffers, and diagnostics safely",
    run: async () => {
      const fixture = await createResponseFixture();
      const extraTop = { ...structuredClone(fixture.bootstrap), unexpected: true };
      const badEvidence = structuredClone(fixture.bootstrap) as unknown as { evidence: { body: Record<string, unknown> } };
      badEvidence.evidence.body.unexpected = true;
      const badDocument = structuredClone(fixture.bootstrap) as unknown as { document: { revision: number } };
      badDocument.document.revision = 4;
      const badPositions = structuredClone(fixture.bootstrap) as unknown as { render: { positions: Float64Array } };
      badPositions.render.positions[0] = Number.NaN;
      const wrongPositions = structuredClone(fixture.bootstrap) as unknown as { render: { positions: unknown } };
      wrongPositions.render.positions = new Float32Array([0, 0, 0]);
      const badIndices = structuredClone(fixture.bootstrap) as unknown as { render: { indices: Uint32Array } };
      badIndices.render.indices[0] = 4_000_000_000;
      const badHistory = structuredClone(fixture.commit) as unknown as { history: { undoDepth: number } };
      badHistory.history.undoDepth = 0;
      const badExport = { ...structuredClone(fixture.exported), bytes: new ArrayBuffer(84) };
      const badExportCount = structuredClone(fixture.exported);
      new DataView(badExportCount.bytes).setUint32(80, badExportCount.triangleCount + 1, true);
      const badExportFinite = structuredClone(fixture.exported);
      new DataView(badExportFinite.bytes).setFloat32(84, Number.NaN, true);
      const badExportHeader = structuredClone(fixture.exported);
      new Uint8Array(badExportHeader.bytes)[0] = 0;
      const badFailure = structuredClone(fixture.failed) as unknown as { diagnostics: Array<Record<string, unknown>> };
      badFailure.diagnostics[0]!.internalStack = "secret";
      const badSemanticHash = structuredClone(fixture.bootstrap) as unknown as { evidence: { semanticHash: string } };
      badSemanticHash.evidence.semanticHash = "0".repeat(64);
      const badJournalHash = structuredClone(fixture.bootstrap) as unknown as { evidence: { commandJournalPrefixHash: string } };
      badJournalHash.evidence.commandJournalPrefixHash = "0".repeat(64);
      const badMeshHash = structuredClone(fixture.bootstrap) as unknown as { evidence: { body: { canonicalMeshHash: string } } };
      badMeshHash.evidence.body.canonicalMeshHash = "0".repeat(64);
      const badTopology = structuredClone(fixture.bootstrap);
      (badTopology.render.topology as { genus: number }).genus = 0;
      (badTopology.evidence.body.topology as { genus: number }).genus = 0;
      const badMeasurements = structuredClone(fixture.bootstrap);
      (badMeasurements.render.measurements as { volumeCubicMeters: number }).volumeCubicMeters *= 2;
      (badMeasurements.evidence.body as { volumeCubicMeters: number }).volumeCubicMeters *= 2;
      const missingTopLevel: unknown[] = [];
      for (const response of [fixture.bootstrap, fixture.exported, fixture.persisted, fixture.failed]) {
        for (const key of Object.keys(response)) {
          const missing = structuredClone(response) as unknown as Record<string, unknown>;
          delete missing[key];
          missingTopLevel.push(missing);
        }
      }
      const probes: unknown[] = [
        extraTop, badEvidence, badDocument, badPositions, wrongPositions, badIndices, badHistory, badExport,
        badExportCount, badExportFinite, badExportHeader, badFailure, badSemanticHash, badJournalHash, badMeshHash,
        badTopology, badMeasurements,
        { ...fixture.failed, diagnostics: [] },
        { ...fixture.failed, status: "ok" },
        ...missingTopLevel,
        new Proxy({}, { getPrototypeOf: () => { throw new Error("hostile"); } })
      ];
      for (const probe of probes) assert(await validateWorkerResponse(probe) === null, "malformed response probe must reject without throwing");
    }
  },
  {
    name: "versioned native artifacts preserve and verify revision evidence bindings",
    run: async () => {
      const document = createBracketDocument("document:test-native-evidence");
      const { evidence } = await evaluate(document);
      const serialized = await serializeNativeRevision({ document, evidence });
      assert(serialized.ok, "document and evidence should serialize together");
      const parsed = await parseNativeRevisionText(serialized.value);
      assert(parsed.ok, "versioned native artifact should round trip");
      equal(parsed.value.evidence.semanticHash, evidence.semanticHash, "native artifact must preserve exact evidence");

      const tampered = JSON.parse(serialized.value) as { evidence: RevisionEvidence };
      (tampered.evidence as unknown as { semanticHash: string }).semanticHash = "0".repeat(64);
      assert(!(await parseNativeRevisionText(JSON.stringify(tampered))).ok, "semantic/evidence mismatch must fail closed");
      assert(!(await parseNativeRevisionText(JSON.stringify(document))).ok, "bare legacy document JSON must not bypass the versioned envelope");
    }
  }
];

async function createResponseFixture() {
  const initial = createBracketDocument("document:test-protocol-responses");
  const session = new CommandSession(initial);
  const command = {
    protocolVersion: 1 as const, kind: "set-parameter" as const, commandId: "command:protocol-commit",
    expectedRevision: 0, parameterKey: "width" as const, expression: { decimal: "70", unit: "mm" as const }
  };
  const committed = await session.execute(command, ACCEPT);
  assert(committed.ok, "protocol fixture commit should succeed");
  const undone = await session.undo("command:protocol-undo", ACCEPT);
  assert(undone.ok, "protocol fixture undo should succeed");
  const redone = await session.redo("command:protocol-redo", ACCEPT);
  assert(redone.ok, "protocol fixture redo should succeed");
  const redoneEvaluation = await evaluate(redone.value);
  const stl = exportBinaryStl(redoneEvaluation.solid, "mm");
  assert(stl.ok, "protocol fixture STL should export");

  const bootstrapRequest = { protocolVersion: 1 as const, requestId: "request:bootstrap-response", generation: 2, kind: "bootstrap" as const, fallbackDocument: initial, fallbackEvidence: null, recoverLocal: true };
  const commitRequest = { protocolVersion: 1 as const, requestId: "request:commit-response", generation: 2, kind: "commit" as const, baseRevision: 0, command };
  const undoRequest = { protocolVersion: 1 as const, requestId: "request:undo-response", generation: 2, kind: "history" as const, baseRevision: 1, direction: "undo" as const, commandId: "command:protocol-undo" };
  const redoRequest = { protocolVersion: 1 as const, requestId: "request:redo-response", generation: 2, kind: "history" as const, baseRevision: 2, direction: "redo" as const, commandId: "command:protocol-redo" };
  const exportRequest = { protocolVersion: 1 as const, requestId: "request:export-response", generation: 2, kind: "export-stl" as const, baseRevision: 3, unit: "mm" as const };
  const persistRequest = { protocolVersion: 1 as const, requestId: "request:persist-response", generation: 2, kind: "persist" as const, baseRevision: 3 };

  return {
    requests: { bootstrap: bootstrapRequest, commit: commitRequest, undo: undoRequest, redo: redoRequest, exported: exportRequest, persisted: persistRequest },
    bootstrap: await modelResponse(initial, "bootstrap", bootstrapRequest.requestId, null),
    commit: await modelResponse(committed.value, "commit", commitRequest.requestId, result("command:protocol-commit", 1)),
    undo: await modelResponse(undone.value, "undo", undoRequest.requestId, result("command:protocol-undo", 2)),
    redo: await modelResponse(redone.value, "redo", redoRequest.requestId, result("command:protocol-redo", 3)),
    exported: { protocolVersion: 1, requestId: exportRequest.requestId, generation: 2, currentRevision: 3, status: "ok", kind: "export-stl", bytes: stl.value.bytes, unit: "mm", triangleCount: stl.value.triangleCount } as const,
    persisted: { protocolVersion: 1, requestId: persistRequest.requestId, generation: 2, currentRevision: 3, status: "ok", kind: "persist" } as const,
    failed: { protocolVersion: 1, requestId: commitRequest.requestId, generation: 2, currentRevision: 0, status: "error", kind: "failure", diagnostics: [{ code: "REVISION_CONFLICT", severity: "error", message: "A bounded revision conflict occurred.", relatedIds: [initial.id], recovery: "Reload the current revision." }] } as const
  };
}

async function modelResponse(document: CadDocument, operation: ModelSuccessResponse["operation"], requestId: string, commandResult: CommandResult | null): Promise<ModelSuccessResponse> {
  const { solid, evidence } = await evaluate(document);
  const history = new CommandSession(document);
  return {
    protocolVersion: 1, requestId, generation: 2, currentRevision: document.revision, status: "ok", kind: "model",
    operation, document, evidence,
    render: {
      bodyId: solid.bodyId,
      positions: solid.mesh.positions.slice(),
      indices: solid.mesh.indices.slice(),
      measurements: solid.measurements,
      topology: solid.topology
    },
    changedSemanticIds: operation === "bootstrap" ? document.parameters.map((parameter) => parameter.id) : [],
    recoveredFromLocal: false,
    history: { undoDepth: history.undoDepth, redoDepth: history.redoDepth },
    commandResult
  };
}

async function evaluate(document: CadDocument): Promise<{ solid: EvaluatedSolid; evidence: RevisionEvidence }> {
  const solid = await new BracketSolidKernel().buildBracket({
    bodyId: document.bodies[0].id,
    widthMeters: document.parameters.find((parameter) => parameter.key === "width")!.valueMeters,
    heightMeters: document.parameters.find((parameter) => parameter.key === "height")!.valueMeters,
    thicknessMeters: document.parameters.find((parameter) => parameter.key === "thickness")!.valueMeters,
    holeDiameterMeters: document.parameters.find((parameter) => parameter.key === "holeDiameter")!.valueMeters,
    circularSegments: 96
  });
  assert(solid.ok, "protocol fixture geometry should evaluate");
  return { solid: solid.value, evidence: await buildRevisionEvidence(document, solid.value) };
}

function result(commandId: string, commandRevision: number): CommandResult {
  return { commandId, commandRevision, disposition: "committed" };
}
