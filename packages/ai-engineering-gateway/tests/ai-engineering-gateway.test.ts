import assert from "node:assert/strict";
import {
  AI_ENGINEERING_PROTOCOL_VERSION,
  CORE_AI_COMMAND_MANIFEST,
  GatewayWorkflowError,
  InMemoryAiEngineeringGateway,
  acknowledgementFor,
  analyzeFeaturePlan,
  createAdapterTranslationPlan,
  createGatewaySchemaManifest,
  recordAdapterHostValidation,
  registerGeneratedAdapterArtifact,
  validateGatewayMcpEnvelope,
  type AdapterCommandMapping,
  type ApplyRequest,
  type FeaturePlan,
  type GatewayExecutor,
  type HandshakeAcknowledgement,
  type PreviewRequest
} from "../src/index.js";

export interface AsyncTest {
  readonly name: string;
  run(): Promise<void>;
}

const validPlan = (baseRevision = 3): FeaturePlan => ({
  schemaVersion: "ps3d-feature-plan/1",
  id: "plan:mounting-plate",
  projectId: "project:fixture-study",
  baseRevision,
  targetComponentId: "component:root",
  title: "Mounting plate",
  engineeringGoal: "Create a parametric mounting plate from a constrained sketch.",
  steps: [{
    id: "plan-step:base-extrude",
    commandId: "command:solid-create",
    workspace: "solid",
    dependsOn: [],
    intent: {
      kind: "solid.extrude",
      resultEntityIds: ["body:mounting-plate"],
      references: [{
        documentId: "project:fixture-study",
        documentRevision: baseRevision,
        entityId: "sketch:mounting-profile",
        entityKind: "sketch",
        componentPath: ["component:root"],
        semanticRole: "closed profile"
      }],
      parameters: [{ name: "distance", value: 10, unit: "mm", source: "user" }],
      rationale: "The plate is a prismatic body driven by its mounting profile.",
      acceptanceCriteria: ["One closed solid body", "Thickness equals 10 mm"]
    }
  }],
  questions: [],
  standardsEvidence: []
});

async function contract() {
  return createGatewaySchemaManifest({
    documentSchemaId: "ps3d-cad-document/1",
    documentSchemaDigest: "d".repeat(64),
    commandManifest: CORE_AI_COMMAND_MANIFEST
  });
}

function executorCounters() {
  const counters = { preview: 0, apply: 0 };
  const executor: GatewayExecutor = {
    async preview(input) {
      counters.preview += 1;
      return {
        accepted: true,
        candidateRevision: input.expectedRevision + 1,
        candidateDigest: "candidate-digest",
        changedEntityIds: ["body:mounting-plate"],
        diagnostics: []
      };
    },
    async apply(input) {
      counters.apply += 1;
      return {
        applied: true,
        resultingRevision: input.expectedRevision + 1,
        resultingDocumentDigest: "document-digest",
        changedEntityIds: ["body:mounting-plate"],
        diagnostics: []
      };
    }
  };
  return { counters, executor };
}

async function readyGateway(baseRevision = 3) {
  const { counters, executor } = executorCounters();
  const gateway = new InMemoryAiEngineeringGateway({
    schemaManifest: await contract(),
    commandManifest: CORE_AI_COMMAND_MANIFEST,
    executor,
    clock: { now: () => "2026-09-01T12:00:00.000Z" }
  });
  const handshake = await gateway.handshake({
    requestId: "request:handshake",
    provider: { name: "test-provider", version: "1.0" },
    supportedProtocolVersions: [AI_ENGINEERING_PROTOCOL_VERSION],
    requestedCommandIds: ["command:solid-create"]
  });
  const acknowledgement = acknowledgementFor(handshake);
  const plan = validPlan(baseRevision);
  const previewRequest: PreviewRequest = {
    requestId: "request:preview",
    idempotencyKey: "preview-key-0001",
    handshakeAcknowledgement: acknowledgement,
    projectId: plan.projectId,
    currentRevision: baseRevision,
    plan
  };
  return { gateway, acknowledgement, plan, previewRequest, counters };
}

export const aiEngineeringGatewayTests: readonly AsyncTest[] = [
  {
    name: "handshake forces schema and command manifests before planning",
    async run() {
      const { gateway } = await readyGateway();
      const response = await gateway.handshake({
        requestId: "request:handshake-second",
        provider: { name: "another-ai", version: "2.1", model: "provider-neutral" },
        supportedProtocolVersions: [AI_ENGINEERING_PROTOCOL_VERSION],
        requestedCommandIds: ["command:solid-create"]
      });
      assert.deepEqual(response.requiredSequence, ["read-schema-manifest", "read-command-manifest", "acknowledge", "plan", "preview", "approve", "apply"]);
      assert.equal(response.schemaManifest.commandManifestDigest.length, 64);
      assert.equal(response.diagnostics.length, 0);
      assert.ok(Object.isFrozen(response));
    }
  },
  {
    name: "feature-plan readiness blocks ambiguity, unverified standards and mesh bypasses",
    async run() {
      const base = validPlan();
      const plan: FeaturePlan = {
        ...base,
        steps: [{
          ...base.steps[0]!,
          intent: {
            ...base.steps[0]!.intent,
            parameters: [...base.steps[0]!.intent.parameters, { name: "rawCoordinates", value: "0,0,0", unit: "text", source: "inferred" }]
          }
        }],
        questions: [{
          id: "question:corner-block-standard",
          category: "standard",
          prompt: "Which ISO corner fitting applies?",
          whyRequired: "The mounting interfaces depend on the selected standard.",
          relatedStepIds: ["plan-step:base-extrude"],
          blocksPreview: true
        }],
        standardsEvidence: [{
          id: "evidence:corner-fitting",
          designation: "ISO 1161",
          title: "Series 1 freight containers — Corner fittings",
          sourceKind: "official-standard",
          sourceLocator: "user must supply licensed standard",
          status: "candidate",
          requiredForStepIds: ["plan-step:base-extrude"]
        }]
      };
      const readiness = await analyzeFeaturePlan(plan, CORE_AI_COMMAND_MANIFEST);
      assert.equal(readiness.readyForPreview, false);
      assert.ok(readiness.diagnostics.some((entry) => entry.code === "AMBIGUITY_UNRESOLVED"));
      assert.ok(readiness.diagnostics.some((entry) => entry.code === "EVIDENCE_UNVERIFIED"));
      assert.ok(readiness.diagnostics.some((entry) => entry.code === "MESH_COORDINATE_BYPASS"));
    }
  },
  {
    name: "preview is idempotent and a conflicting reuse fails before executor access",
    async run() {
      const { gateway, previewRequest, counters } = await readyGateway();
      const first = await gateway.preview(previewRequest);
      const retry = await gateway.preview(previewRequest);
      assert.equal(first.receiptDigest, retry.receiptDigest);
      assert.equal(counters.preview, 1);
      const conflict = await gateway.preview({ ...previewRequest, requestId: "request:different-preview", plan: { ...previewRequest.plan, title: "Changed" } });
      assert.equal(conflict.status, "blocked");
      assert.ok(conflict.diagnostics.some((entry) => entry.code === "IDEMPOTENCY_CONFLICT"));
      assert.equal(counters.preview, 1);
    }
  },
  {
    name: "approval binds exact project revision, plan and preview before atomic apply",
    async run() {
      const { gateway, acknowledgement, plan, previewRequest, counters } = await readyGateway();
      const preview = await gateway.preview(previewRequest);
      assert.equal(preview.status, "accepted");
      await assert.rejects(
        gateway.approve({
          approvalId: "approval:wrong",
          previewReceiptDigest: preview.receiptDigest,
          projectId: plan.projectId,
          baseRevision: plan.baseRevision,
          planId: plan.id,
          planDigest: "wrong-digest",
          approvedBy: "engineer@example.test",
          decision: "approve"
        }),
        (error: unknown) => error instanceof GatewayWorkflowError && error.diagnostics.some((entry) => entry.code === "APPROVAL_BINDING_MISMATCH")
      );
      const approval = await gateway.approve({
        approvalId: "approval:mounting-plate",
        previewReceiptDigest: preview.receiptDigest,
        projectId: plan.projectId,
        baseRevision: plan.baseRevision,
        planId: plan.id,
        planDigest: preview.planDigest,
        approvedBy: "engineer@example.test",
        decision: "approve"
      });
      const request: ApplyRequest = {
        requestId: "request:apply",
        idempotencyKey: "apply-key-0001",
        handshakeAcknowledgement: acknowledgement,
        projectId: plan.projectId,
        currentRevision: plan.baseRevision,
        plan,
        previewReceipt: preview,
        approvalToken: approval
      };
      const applied = await gateway.apply(request);
      assert.equal(applied.status, "applied");
      assert.equal(applied.resultingRevision, plan.baseRevision + 1);
      assert.equal(counters.apply, 1);
      const retry = await gateway.apply(request);
      assert.equal(retry.receiptDigest, applied.receiptDigest);
      assert.equal(counters.apply, 1);
      assert.ok(gateway.auditReceipts().every((receipt) => Object.isFrozen(receipt)));
    }
  },
  {
    name: "stale apply is rejected without calling the mutation executor",
    async run() {
      const { gateway, acknowledgement, plan, previewRequest, counters } = await readyGateway();
      const preview = await gateway.preview(previewRequest);
      const approval = await gateway.approve({
        approvalId: "approval:stale",
        previewReceiptDigest: preview.receiptDigest,
        projectId: plan.projectId,
        baseRevision: plan.baseRevision,
        planId: plan.id,
        planDigest: preview.planDigest,
        approvedBy: "engineer@example.test",
        decision: "approve"
      });
      const result = await gateway.apply({
        requestId: "request:stale-apply",
        idempotencyKey: "apply-key-stale",
        handshakeAcknowledgement: acknowledgement,
        projectId: plan.projectId,
        currentRevision: plan.baseRevision + 1,
        plan,
        previewReceipt: preview,
        approvalToken: approval
      });
      assert.equal(result.status, "blocked");
      assert.ok(result.diagnostics.some((entry) => entry.code === "REVISION_CONFLICT"));
      assert.equal(counters.apply, 0);
    }
  },
  {
    name: "CAD adapter artifacts remain unvalidated until host evidence is recorded",
    async run() {
      const plan = validPlan();
      const mappings: readonly AdapterCommandMapping[] = [{
        commandId: "command:solid-create",
        target: "fusion-360-python",
        hostOperation: "adsk.fusion.ExtrudeFeatures.add",
        parameterMap: { distance: "distanceExtent.value" },
        limitations: ["Target document units and profile validity must be checked in Fusion."]
      }];
      const translation = await createAdapterTranslationPlan({ featurePlan: plan, target: "fusion-360-python", mappings });
      assert.equal(translation.status, "translation-plan-unvalidated");
      assert.equal(translation.scriptExecutionAllowed, false);
      assert.equal(translation.steps[0]?.status, "mapped");
      const artifact = await registerGeneratedAdapterArtifact({
        translationPlan: translation,
        baseFileName: "mounting plate",
        generatedContent: "# generated translation candidate"
      });
      assert.equal(artifact.status, "generated-unvalidated");
      assert.equal(artifact.fileName, "mounting-plate.py");
      const validated = recordAdapterHostValidation(artifact, {
        hostVersion: "Fusion 360 test host",
        testProjectDigest: "test-project-digest",
        resultDigest: "test-result-digest",
        validatedBy: "cad-validator@example.test",
        validatedAt: "2026-09-01T12:30:00.000Z"
      });
      assert.equal(validated.status, "host-validated");
      assert.equal(validated.hostValidationRequired, false);
    }
  },
  {
    name: "unmapped target APIs remain explicit translation gaps",
    async run() {
      const translation = await createAdapterTranslationPlan({ featurePlan: validPlan(), target: "catia-v5-vba", mappings: [] });
      assert.equal(translation.steps[0]?.status, "mapping-gap");
      assert.ok(translation.diagnostics.some((entry) => entry.code === "ADAPTER_MAPPING_GAP"));
    }
  },
  {
    name: "provider-neutral MCP envelopes validate protocol and identity only",
    async run() {
      const acknowledgement = {} as HandshakeAcknowledgement;
      const diagnostics = validateGatewayMcpEnvelope({
        protocolVersion: AI_ENGINEERING_PROTOCOL_VERSION,
        requestId: "request:mcp",
        idempotencyKey: "mcp-key-0001",
        provider: { name: "any-mcp-host", version: "1.0" },
        command: { name: "ps3d.ai.preview", payload: { acknowledgement } }
      });
      assert.deepEqual(diagnostics, []);
    }
  }
];
