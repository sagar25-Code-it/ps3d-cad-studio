export const AI_ENGINEERING_PROTOCOL_VERSION = "ps3d-ai-engineering/1" as const;

export type ProjectId = `project:${string}`;
export type ComponentId = `component:${string}`;
export type PlanId = `plan:${string}`;
export type PlanStepId = `plan-step:${string}`;
export type QuestionId = `question:${string}`;
export type EvidenceId = `evidence:${string}`;
export type ReceiptId = `receipt:${string}`;
export type ApprovalId = `approval:${string}`;
export type CommandId = `command:${string}`;
export type EntityId = `${"origin" | "sketch" | "body" | "feature" | "occurrence" | "joint" | "drawing" | "topology"}:${string}`;

export type WorkspaceKind = "document" | "sketch" | "solid" | "surface" | "assembly" | "drawing" | "render" | "exchange";
export type EngineeringEntityKind = "origin" | "sketch" | "profile" | "body" | "feature" | "face" | "edge" | "vertex" | "occurrence" | "joint" | "drawing-view";
export type EngineeringIntentKind =
  | "sketch.create" | "sketch.constrain" | "sketch.dimension"
  | "solid.extrude" | "solid.revolve" | "solid.sweep" | "solid.loft" | "solid.hole" | "solid.thread"
  | "solid.fillet" | "solid.chamfer" | "solid.draft" | "solid.shell" | "solid.rib" | "solid.thin-extrude"
  | "solid.boolean" | "solid.pattern" | "solid.mirror" | "solid.direct-edit"
  | "surface.create" | "surface.modify" | "surface.stitch" | "surface.thicken"
  | "assembly.insert" | "assembly.joint" | "assembly.motion" | "assembly.explode" | "assembly.inspect"
  | "drawing.view" | "drawing.annotate" | "drawing.gdt" | "drawing.parts-list"
  | "render.appearance" | "render.environment" | "exchange.import" | "exchange.export";

export type EngineeringUnit = "unitless" | "mm" | "deg" | "kg" | "N" | "Pa" | "s" | "rpm" | "ratio" | "text" | "boolean";
export type ParameterSource = "user" | "drawing" | "standard" | "supplier" | "calculated" | "inferred";

export interface EngineeringTolerance {
  readonly lower: number;
  readonly upper: number;
  readonly unit: Exclude<EngineeringUnit, "text" | "boolean">;
}

export interface EngineeringParameter {
  readonly name: string;
  readonly value: string | number | boolean;
  readonly unit: EngineeringUnit;
  readonly source: ParameterSource;
  readonly tolerance?: EngineeringTolerance;
  readonly expression?: string;
}

export interface StableEntityReference {
  readonly documentId: ProjectId;
  readonly documentRevision: number;
  readonly entityId: EntityId;
  readonly entityKind: EngineeringEntityKind;
  readonly componentPath: readonly ComponentId[];
  readonly semanticRole: string;
  readonly topologyLineageDigest?: string;
}

export interface EngineeringIntent {
  readonly kind: EngineeringIntentKind;
  readonly resultEntityIds: readonly EntityId[];
  readonly references: readonly StableEntityReference[];
  readonly parameters: readonly EngineeringParameter[];
  readonly rationale: string;
  readonly acceptanceCriteria: readonly string[];
}

export interface FeaturePlanStep {
  readonly id: PlanStepId;
  readonly commandId: CommandId;
  readonly workspace: WorkspaceKind;
  readonly dependsOn: readonly PlanStepId[];
  readonly intent: EngineeringIntent;
}

export interface EngineeringQuestion {
  readonly id: QuestionId;
  readonly category: "ambiguity" | "dimension" | "standard" | "material" | "interface" | "manufacturing" | "safety";
  readonly prompt: string;
  readonly whyRequired: string;
  readonly relatedStepIds: readonly PlanStepId[];
  readonly blocksPreview: boolean;
  readonly answer?: string;
  readonly answeredBy?: string;
}

export interface StandardsEvidence {
  readonly id: EvidenceId;
  readonly designation: string;
  readonly title: string;
  readonly jurisdiction?: string;
  readonly sourceKind: "official-standard" | "manufacturer-drawing" | "supplier-catalog" | "user-drawing" | "calculation";
  readonly sourceLocator: string;
  readonly sourceDigest?: string;
  readonly status: "unresolved" | "candidate" | "verified" | "rejected";
  readonly requiredForStepIds: readonly PlanStepId[];
  readonly verificationNote?: string;
  readonly verifiedBy?: string;
}

export interface FeaturePlan {
  readonly schemaVersion: "ps3d-feature-plan/1";
  readonly id: PlanId;
  readonly projectId: ProjectId;
  readonly baseRevision: number;
  readonly targetComponentId: ComponentId;
  readonly title: string;
  readonly engineeringGoal: string;
  readonly steps: readonly FeaturePlanStep[];
  readonly questions: readonly EngineeringQuestion[];
  readonly standardsEvidence: readonly StandardsEvidence[];
}

export interface GatewayDiagnostic {
  readonly code:
    | "PROTOCOL_MISMATCH" | "SCHEMA_ACK_REQUIRED" | "MANIFEST_MISMATCH" | "INVALID_ID" | "INVALID_PLAN"
    | "UNKNOWN_COMMAND" | "DEPENDENCY_CYCLE" | "AMBIGUITY_UNRESOLVED" | "EVIDENCE_UNVERIFIED"
    | "MESH_COORDINATE_BYPASS" | "REVISION_CONFLICT" | "IDEMPOTENCY_CONFLICT" | "PREVIEW_REQUIRED"
    | "PREVIEW_FAILED" | "APPROVAL_REQUIRED" | "APPROVAL_BINDING_MISMATCH" | "APPLY_FAILED"
    | "ADAPTER_MAPPING_GAP" | "HOST_VALIDATION_REQUIRED";
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly relatedIds: readonly string[];
  readonly recovery: string;
}

export interface CommandDefinition {
  readonly id: CommandId;
  readonly title: string;
  readonly description: string;
  readonly workspace: WorkspaceKind;
  readonly intentKinds: readonly EngineeringIntentKind[];
  readonly effect: "read" | "preview" | "apply" | "translate";
  readonly inputSchemaId: string;
  readonly outputSchemaId: string;
  readonly exactKernelRequired: boolean;
  readonly idempotent: boolean;
}

export interface CommandManifest {
  readonly schemaVersion: "ps3d-command-manifest/1";
  readonly manifestId: string;
  readonly revision: number;
  readonly commands: readonly CommandDefinition[];
}

export interface GatewaySchemaManifest {
  readonly protocolVersion: typeof AI_ENGINEERING_PROTOCOL_VERSION;
  readonly documentSchemaId: string;
  readonly documentSchemaDigest: string;
  readonly featurePlanSchemaId: "ps3d-feature-plan/1";
  readonly featurePlanSchemaDigest: string;
  readonly commandManifestDigest: string;
  readonly gatewayPolicyDigest: string;
}

export interface ProviderIdentity {
  readonly name: string;
  readonly version: string;
  readonly model?: string;
}

export interface HandshakeRequest {
  readonly requestId: string;
  readonly provider: ProviderIdentity;
  readonly supportedProtocolVersions: readonly string[];
  readonly requestedCommandIds: readonly CommandId[];
}

export interface HandshakeResponse {
  readonly handshakeId: string;
  readonly protocolVersion: typeof AI_ENGINEERING_PROTOCOL_VERSION;
  readonly provider: ProviderIdentity;
  readonly schemaManifest: GatewaySchemaManifest;
  readonly commandManifest: CommandManifest;
  readonly requiredSequence: readonly ["read-schema-manifest", "read-command-manifest", "acknowledge", "plan", "preview", "approve", "apply"];
  readonly diagnostics: readonly GatewayDiagnostic[];
}

export interface HandshakeAcknowledgement {
  readonly handshakeId: string;
  readonly protocolVersion: typeof AI_ENGINEERING_PROTOCOL_VERSION;
  readonly documentSchemaDigest: string;
  readonly featurePlanSchemaDigest: string;
  readonly commandManifestDigest: string;
  readonly gatewayPolicyDigest: string;
  readonly understood: true;
}

export interface PlanReadiness {
  readonly readyForPreview: boolean;
  readonly planDigest: string;
  readonly orderedStepIds: readonly PlanStepId[];
  readonly diagnostics: readonly GatewayDiagnostic[];
}

export interface PreviewExecutionResult {
  readonly accepted: boolean;
  readonly candidateRevision: number;
  readonly candidateDigest: string;
  readonly changedEntityIds: readonly EntityId[];
  readonly diagnostics: readonly GatewayDiagnostic[];
}

export interface ApplyExecutionResult {
  readonly applied: boolean;
  readonly resultingRevision: number;
  readonly resultingDocumentDigest: string;
  readonly changedEntityIds: readonly EntityId[];
  readonly diagnostics: readonly GatewayDiagnostic[];
}

export interface PreviewRequest {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly handshakeAcknowledgement: HandshakeAcknowledgement;
  readonly projectId: ProjectId;
  readonly currentRevision: number;
  readonly plan: FeaturePlan;
}

export interface PreviewReceipt {
  readonly receiptVersion: 1;
  readonly id: ReceiptId;
  readonly kind: "preview";
  readonly requestId: string;
  readonly requestDigest: string;
  readonly projectId: ProjectId;
  readonly baseRevision: number;
  readonly candidateRevision: number;
  readonly planId: PlanId;
  readonly planDigest: string;
  readonly candidateDigest: string;
  readonly changedEntityIds: readonly EntityId[];
  readonly status: "accepted" | "blocked" | "failed";
  readonly diagnostics: readonly GatewayDiagnostic[];
  readonly sequence: number;
  readonly issuedAt: string;
  readonly receiptDigest: string;
}

export interface ApprovalRequest {
  readonly approvalId: ApprovalId;
  readonly previewReceiptDigest: string;
  readonly projectId: ProjectId;
  readonly baseRevision: number;
  readonly planId: PlanId;
  readonly planDigest: string;
  readonly approvedBy: string;
  readonly decision: "approve";
}

export interface ApprovalToken {
  readonly tokenVersion: 1;
  readonly token: `ps3d-approval-v1.${string}`;
  readonly approvalId: ApprovalId;
  readonly previewReceiptDigest: string;
  readonly projectId: ProjectId;
  readonly baseRevision: number;
  readonly planId: PlanId;
  readonly planDigest: string;
  readonly approvedBy: string;
  readonly issuedAt: string;
  readonly bindingDigest: string;
}

export interface ApplyRequest {
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly handshakeAcknowledgement: HandshakeAcknowledgement;
  readonly projectId: ProjectId;
  readonly currentRevision: number;
  readonly plan: FeaturePlan;
  readonly previewReceipt: PreviewReceipt;
  readonly approvalToken: ApprovalToken;
}

export interface ApplyReceipt {
  readonly receiptVersion: 1;
  readonly id: ReceiptId;
  readonly kind: "apply";
  readonly requestId: string;
  readonly requestDigest: string;
  readonly projectId: ProjectId;
  readonly baseRevision: number;
  readonly resultingRevision: number;
  readonly planId: PlanId;
  readonly planDigest: string;
  readonly previewReceiptDigest: string;
  readonly approvalBindingDigest: string;
  readonly resultingDocumentDigest: string;
  readonly changedEntityIds: readonly EntityId[];
  readonly status: "applied" | "blocked" | "failed";
  readonly diagnostics: readonly GatewayDiagnostic[];
  readonly sequence: number;
  readonly issuedAt: string;
  readonly receiptDigest: string;
}

export interface GatewayExecutor {
  preview(input: { readonly projectId: ProjectId; readonly expectedRevision: number; readonly plan: FeaturePlan; readonly planDigest: string }): Promise<PreviewExecutionResult>;
  apply(input: { readonly projectId: ProjectId; readonly expectedRevision: number; readonly plan: FeaturePlan; readonly planDigest: string; readonly previewReceipt: PreviewReceipt }): Promise<ApplyExecutionResult>;
}

export interface GatewayClock {
  now(): string;
}

export type GatewayMcpCommandName = "ps3d.ai.handshake" | "ps3d.ai.plan.validate" | "ps3d.ai.preview" | "ps3d.ai.approve" | "ps3d.ai.apply" | "ps3d.ai.adapter.plan";

export interface GatewayMcpEnvelope<Payload = unknown> {
  readonly protocolVersion: typeof AI_ENGINEERING_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly idempotencyKey: string;
  readonly provider: ProviderIdentity;
  readonly command: {
    readonly name: GatewayMcpCommandName;
    readonly payload: Payload;
  };
}

export type AdapterTarget =
  | "fusion-360-python"
  | "nxopen-python" | "nxopen-csharp"
  | "solidworks-vba" | "solidworks-csharp"
  | "creo-toolkit-cpp" | "creo-jlink-java"
  | "catia-v5-vba";

export interface AdapterTargetDefinition {
  readonly id: AdapterTarget;
  readonly host: "Fusion 360" | "NX" | "SOLIDWORKS" | "Creo" | "CATIA V5";
  readonly apiFamily: string;
  readonly language: "Python" | "C#" | "VBA" | "C++" | "Java";
  readonly nativeFilePreservationClaim: false;
}

export interface AdapterCommandMapping {
  readonly commandId: CommandId;
  readonly target: AdapterTarget;
  readonly hostOperation: string;
  readonly parameterMap: Readonly<Record<string, string>>;
  readonly limitations: readonly string[];
}

export interface AdapterTranslationStep {
  readonly planStepId: PlanStepId;
  readonly commandId: CommandId;
  readonly hostOperation: string | null;
  readonly status: "mapped" | "mapping-gap";
  readonly limitations: readonly string[];
}

export interface AdapterTranslationPlan {
  readonly schemaVersion: "ps3d-adapter-translation-plan/1";
  readonly id: string;
  readonly target: AdapterTarget;
  readonly targetDefinition: AdapterTargetDefinition;
  readonly featurePlanId: PlanId;
  readonly featurePlanDigest: string;
  readonly status: "translation-plan-unvalidated";
  readonly hostValidationRequired: true;
  readonly scriptExecutionAllowed: false;
  readonly steps: readonly AdapterTranslationStep[];
  readonly diagnostics: readonly GatewayDiagnostic[];
  readonly validationChecklist: readonly string[];
  readonly translationPlanDigest: string;
}

export interface GeneratedAdapterArtifact {
  readonly schemaVersion: "ps3d-generated-adapter/1";
  readonly translationPlanDigest: string;
  readonly target: AdapterTarget;
  readonly fileName: string;
  readonly contentDigest: string;
  readonly status: "generated-unvalidated" | "host-validated" | "rejected";
  readonly hostValidationRequired: boolean;
  readonly validationEvidence?: {
    readonly hostVersion: string;
    readonly testProjectDigest: string;
    readonly resultDigest: string;
    readonly validatedBy: string;
    readonly validatedAt: string;
  };
}

export type AuditReceipt = PreviewReceipt | ApplyReceipt;
