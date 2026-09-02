import {
  AI_ENGINEERING_PROTOCOL_VERSION,
  CORE_AI_COMMAND_MANIFEST,
  InMemoryAiEngineeringGateway,
  createGatewaySchemaManifest,
  sha256,
  type FeaturePlan,
  type GatewayDiagnostic,
  type GatewayExecutor
} from "@ps3d/ai-engineering-gateway/src/index.js";
import {
  CAD_DOCUMENT_FORMAT,
  CAD_DOCUMENT_SCHEMA_VERSION,
  type CadDocument
} from "@ps3d/cad-document-core/src/index.js";
import { createFeatureOperationTableMapper, createParametricCadEngine, type ParametricCadRebuildOutcome } from "@ps3d/parametric-cad-engine";
import { analyticSketchSolver } from "@ps3d/parametric-sketch-core/src/index.js";
import {
  BODY_ID,
  COMPONENT_ID,
  ENGINE_GENERATION,
  ENGINE_REQUEST_ID,
  FEATURE_ID,
  PROJECT_ID,
  SESSION_ID,
  SKETCH_ID,
  createCanonicalFixtureDocument,
  createQualifiedFixtureBundle,
  createSolverSketchDocument,
  createStableFeaturePlan,
  createUnregisteredRecordedAdapter,
  type QualifiedFixtureBundle
} from "./fixture.js";

export interface AcceptanceHarnessCounters {
  previewExecutions: number;
  applyExecutions: number;
}

export interface PlatformAcceptanceHarness {
  readonly gateway: InMemoryAiEngineeringGateway;
  readonly sourceDocument: CadDocument;
  readonly plan: FeaturePlan;
  readonly fixture: QualifiedFixtureBundle;
  readonly counters: AcceptanceHarnessCounters;
  currentDocument(): CadDocument;
  lastEngineOutcome(): ParametricCadRebuildOutcome | null;
}

interface PendingCandidate {
  readonly planDigest: string;
  readonly candidateDigest: string;
  readonly candidateDocument: CadDocument;
  readonly engineOutcome: ParametricCadRebuildOutcome;
}

export async function createPlatformAcceptanceHarness(options: {
  readonly registerExactFixture?: boolean;
} = {}): Promise<PlatformAcceptanceHarness> {
  const sourceDocument = createCanonicalFixtureDocument();
  const sketchDocument = createSolverSketchDocument();
  const fixture = await createQualifiedFixtureBundle(sourceDocument);
  const kernelAdapter = options.registerExactFixture === false ? createUnregisteredRecordedAdapter() : fixture.adapter;
  const mapper = createFeatureOperationTableMapper([{
    featureId: FEATURE_ID,
    factory: (context) => {
      const sketch = context.sketchResults.find((entry) => entry.sketchId === SKETCH_ID);
      if (sketch === undefined) throw new Error("The exact extrusion requires the solved stable sketch result.");
      if (sketch.result.deterministicFingerprint !== fixture.solvedSketch.deterministicFingerprint) {
        throw new Error("The solved sketch no longer matches the qualified exact-profile record.");
      }
      return fixture.operation;
    }
  }]);
  const engine = createParametricCadEngine({ sketchSolver: analyticSketchSolver, kernelAdapter, featureMapper: mapper });
  const counters: AcceptanceHarnessCounters = { previewExecutions: 0, applyExecutions: 0 };
  const pending = new Map<string, PendingCandidate>();
  let liveDocument = sourceDocument;
  let latestEngineOutcome: ParametricCadRebuildOutcome | null = null;

  const executor: GatewayExecutor = {
    async preview(input) {
      counters.previewExecutions += 1;
      if (input.projectId !== liveDocument.project.id || input.expectedRevision !== liveDocument.revision) {
        return {
          accepted: false,
          candidateRevision: liveDocument.revision,
          candidateDigest: await sha256(liveDocument),
          changedEntityIds: [],
          diagnostics: [gatewayProblem(
            "REVISION_CONFLICT",
            "The deterministic executor does not own the requested live project revision.",
            "Re-inspect the current canonical document before preview."
          )]
        };
      }
      const stablePlanProblem = validateAcceptancePlan(input.plan, liveDocument);
      if (stablePlanProblem !== null) {
        return {
          accepted: false,
          candidateRevision: liveDocument.revision,
          candidateDigest: await sha256(liveDocument),
          changedEntityIds: [],
          diagnostics: [stablePlanProblem]
        };
      }
      const outcome = await engine.rebuild({
        requestId: ENGINE_REQUEST_ID,
        mode: "preview",
        document: liveDocument,
        generation: ENGINE_GENERATION,
        sessionId: SESSION_ID,
        changedFeatureIds: [FEATURE_ID],
        includeDirty: true,
        sketchDocuments: { [SKETCH_ID]: sketchDocument },
        openSession: true
      });
      latestEngineOutcome = outcome;
      if (outcome.status !== "succeeded" || outcome.candidateDocument === null) {
        return {
          accepted: false,
          candidateRevision: liveDocument.revision,
          candidateDigest: await sha256({ failedEngineReceipt: outcome.receipt.receiptSha256 }),
          changedEntityIds: [],
          diagnostics: outcome.diagnostics.length === 0
            ? [gatewayProblem("PREVIEW_FAILED", "The parametric rebuild did not produce a candidate.", "Resolve the rebuild failure before previewing again.")]
            : outcome.diagnostics.map((entry) => gatewayProblem(
                "PREVIEW_FAILED",
                entry.message,
                entry.recovery,
                entry.relatedIds,
                entry.severity
              ))
        };
      }
      const candidateDigest = await sha256(outcome.candidateDocument);
      pending.set(input.planDigest, {
        planDigest: input.planDigest,
        candidateDigest,
        candidateDocument: outcome.candidateDocument,
        engineOutcome: outcome
      });
      return {
        accepted: true,
        candidateRevision: outcome.candidateDocument.revision,
        candidateDigest,
        changedEntityIds: [SKETCH_ID, BODY_ID],
        diagnostics: []
      };
    },
    async apply(input) {
      counters.applyExecutions += 1;
      if (input.projectId !== liveDocument.project.id || input.expectedRevision !== liveDocument.revision) {
        return {
          applied: false,
          resultingRevision: liveDocument.revision,
          resultingDocumentDigest: await sha256(liveDocument),
          changedEntityIds: [],
          diagnostics: [gatewayProblem(
            "REVISION_CONFLICT",
            "The live canonical revision changed after preview.",
            "Re-inspect, preview, and approve the new revision."
          )]
        };
      }
      const candidate = pending.get(input.planDigest);
      if (candidate === undefined || candidate.candidateDigest !== input.previewReceipt.candidateDigest
        || candidate.candidateDocument.revision !== input.expectedRevision + 1) {
        return {
          applied: false,
          resultingRevision: liveDocument.revision,
          resultingDocumentDigest: await sha256(liveDocument),
          changedEntityIds: [],
          diagnostics: [gatewayProblem(
            "APPROVAL_BINDING_MISMATCH",
            "No pending rebuild candidate matches the approved preview receipt.",
            "Preview the exact plan again and approve its new receipt."
          )]
        };
      }
      liveDocument = candidate.candidateDocument;
      pending.delete(input.planDigest);
      return {
        applied: true,
        resultingRevision: liveDocument.revision,
        resultingDocumentDigest: await sha256(liveDocument),
        changedEntityIds: [SKETCH_ID, BODY_ID],
        diagnostics: []
      };
    }
  };

  const schemaManifest = await createGatewaySchemaManifest({
    documentSchemaId: `${CAD_DOCUMENT_FORMAT}/${CAD_DOCUMENT_SCHEMA_VERSION}`,
    documentSchemaDigest: await sha256({
      format: CAD_DOCUMENT_FORMAT,
      schemaVersion: CAD_DOCUMENT_SCHEMA_VERSION,
      canonicalOwnership: "project-components-sketches-bodies-features-occurrences-joints-drawings"
    }),
    commandManifest: CORE_AI_COMMAND_MANIFEST
  });
  const gateway = new InMemoryAiEngineeringGateway({
    schemaManifest,
    commandManifest: CORE_AI_COMMAND_MANIFEST,
    executor,
    clock: { now: () => "2026-09-01T12:00:00.000Z" }
  });
  return {
    gateway,
    sourceDocument,
    plan: createStableFeaturePlan(sourceDocument.revision),
    fixture,
    counters,
    currentDocument: () => liveDocument,
    lastEngineOutcome: () => latestEngineOutcome
  };
}

export async function performManifestHandshake(harness: PlatformAcceptanceHarness) {
  const handshake = await harness.gateway.handshake({
    requestId: "request:platform-handshake",
    provider: { name: "acceptance-ai-host", version: "1.0.0", model: "provider-neutral" },
    supportedProtocolVersions: [AI_ENGINEERING_PROTOCOL_VERSION],
    requestedCommandIds: ["command:sketch", "command:solid-create"]
  });
  return handshake;
}

function validateAcceptancePlan(plan: FeaturePlan, document: CadDocument): GatewayDiagnostic | null {
  const exactStep = plan.steps.find((step) => step.id === "plan-step:extrude-mounting-plate");
  const sketchStep = plan.steps.find((step) => step.id === "plan-step:solve-mounting-profile");
  const exactReference = exactStep?.intent.references.find((reference) => reference.entityId === SKETCH_ID);
  const canonicalSketch = document.project.sketches.find((sketch) => sketch.id === SKETCH_ID);
  const canonicalFeature = document.project.features.find((feature) => feature.id === FEATURE_ID);
  const stable = plan.projectId === PROJECT_ID
    && plan.targetComponentId === COMPONENT_ID
    && plan.baseRevision === document.revision
    && sketchStep !== undefined
    && exactStep !== undefined
    && exactStep.dependsOn.includes(sketchStep.id)
    && exactReference?.documentRevision === document.revision
    && exactReference.componentPath.length === 1
    && exactReference.componentPath[0] === COMPONENT_ID
    && canonicalSketch !== undefined
    && canonicalFeature?.inputs.some((input) => input.kind === "sketch" && input.id === SKETCH_ID) === true
    && canonicalFeature.outputBodyIds.includes(BODY_ID);
  return stable ? null : gatewayProblem(
    "INVALID_PLAN",
    "The feature plan is not bound to the canonical sketch, exact feature, body, component, and base revision.",
    "Rebuild the plan from stable canonical IDs after reading the current document."
  );
}

function gatewayProblem(
  code: GatewayDiagnostic["code"],
  message: string,
  recovery: string,
  relatedIds: readonly string[] = [],
  severity: GatewayDiagnostic["severity"] = "error"
): GatewayDiagnostic {
  return { code, severity, message, relatedIds, recovery };
}
