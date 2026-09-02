import { deepFreeze, sha256 } from "./canonical.js";
import { createHandshake, validateHandshakeAcknowledgement } from "./manifest.js";
import { analyzeFeaturePlan } from "./plan.js";
import type {
  ApplyReceipt,
  ApplyRequest,
  ApprovalRequest,
  ApprovalToken,
  AuditReceipt,
  CommandManifest,
  GatewayClock,
  GatewayDiagnostic,
  GatewayExecutor,
  GatewaySchemaManifest,
  HandshakeRequest,
  HandshakeResponse,
  PreviewReceipt,
  PreviewRequest,
  ReceiptId
} from "./types.js";

const systemClock: GatewayClock = { now: () => new Date().toISOString() };

function problem(
  code: GatewayDiagnostic["code"],
  message: string,
  recovery: string,
  relatedIds: readonly string[] = []
): GatewayDiagnostic {
  return { code, severity: "error", message, relatedIds, recovery };
}

export class GatewayWorkflowError extends Error {
  readonly diagnostics: readonly GatewayDiagnostic[];

  constructor(message: string, diagnostics: readonly GatewayDiagnostic[]) {
    super(message);
    this.name = "GatewayWorkflowError";
    this.diagnostics = deepFreeze([...diagnostics]);
  }
}

interface CachedReceipt<T extends PreviewReceipt | ApplyReceipt> {
  readonly requestDigest: string;
  readonly receipt: T;
}

export class InMemoryAiEngineeringGateway {
  readonly schemaManifest: GatewaySchemaManifest;
  readonly commandManifest: CommandManifest;
  readonly executor: GatewayExecutor;
  readonly clock: GatewayClock;
  readonly #handshakes = new Map<string, HandshakeResponse>();
  readonly #previewByIdempotency = new Map<string, CachedReceipt<PreviewReceipt>>();
  readonly #applyByIdempotency = new Map<string, CachedReceipt<ApplyReceipt>>();
  readonly #previewByDigest = new Map<string, PreviewReceipt>();
  readonly #approvalByToken = new Map<string, ApprovalToken>();
  readonly #consumedApprovals = new Set<string>();
  readonly #audit: AuditReceipt[] = [];
  #sequence = 0;

  constructor(input: {
    readonly schemaManifest: GatewaySchemaManifest;
    readonly commandManifest: CommandManifest;
    readonly executor: GatewayExecutor;
    readonly clock?: GatewayClock;
  }) {
    this.schemaManifest = input.schemaManifest;
    this.commandManifest = input.commandManifest;
    this.executor = input.executor;
    this.clock = input.clock ?? systemClock;
  }

  async handshake(request: HandshakeRequest): Promise<HandshakeResponse> {
    const response = await createHandshake(request, this.schemaManifest, this.commandManifest);
    this.#handshakes.set(response.handshakeId, response);
    return response;
  }

  auditReceipts(): readonly AuditReceipt[] {
    return deepFreeze([...this.#audit]);
  }

  async preview(request: PreviewRequest): Promise<PreviewReceipt> {
    const requestDigest = await sha256(request);
    const cached = this.#previewByIdempotency.get(request.idempotencyKey);
    if (cached) {
      if (cached.requestDigest === requestDigest) return cached.receipt;
      return this.#previewReceipt(request, requestDigest, "blocked", request.currentRevision, await sha256({ blocked: "idempotency" }), [], [problem(
        "IDEMPOTENCY_CONFLICT",
        "This preview idempotency key was already used for different content.",
        "Reuse the original request unchanged or allocate a new idempotency key.",
        [request.idempotencyKey]
      )]);
    }

    const handshake = this.#handshakes.get(request.handshakeAcknowledgement.handshakeId);
    const gateDiagnostics = [...validateHandshakeAcknowledgement(request.handshakeAcknowledgement, handshake)];
    if (request.projectId !== request.plan.projectId || request.currentRevision !== request.plan.baseRevision) gateDiagnostics.push(problem(
      "REVISION_CONFLICT",
      `Plan base revision ${request.plan.baseRevision} does not match current revision ${request.currentRevision}.`,
      "Re-inspect the latest project, re-plan against that revision, and request a new preview.",
      [request.projectId, request.plan.id]
    ));
    const readiness = await analyzeFeaturePlan(request.plan, this.commandManifest);
    gateDiagnostics.push(...readiness.diagnostics);
    if (gateDiagnostics.some((entry) => entry.severity === "error")) {
      const receipt = await this.#previewReceipt(
        request, requestDigest, "blocked", request.currentRevision, await sha256({ blocked: gateDiagnostics }), [], gateDiagnostics, readiness.planDigest
      );
      this.#previewByIdempotency.set(request.idempotencyKey, { requestDigest, receipt });
      return receipt;
    }

    try {
      const result = await this.executor.preview({
        projectId: request.projectId,
        expectedRevision: request.currentRevision,
        plan: request.plan,
        planDigest: readiness.planDigest
      });
      const diagnostics = [...result.diagnostics];
      if (result.accepted && result.candidateRevision !== request.currentRevision + 1) diagnostics.push(problem(
        "PREVIEW_FAILED",
        "The preview executor returned a non-sequential candidate revision.",
        "Correct the executor so an accepted candidate is based on exactly baseRevision + 1.",
        [request.plan.id]
      ));
      const accepted = result.accepted && !diagnostics.some((entry) => entry.severity === "error");
      const receipt = await this.#previewReceipt(
        request,
        requestDigest,
        accepted ? "accepted" : "failed",
        result.candidateRevision,
        result.candidateDigest,
        result.changedEntityIds,
        diagnostics,
        readiness.planDigest
      );
      this.#previewByIdempotency.set(request.idempotencyKey, { requestDigest, receipt });
      if (accepted) this.#previewByDigest.set(receipt.receiptDigest, receipt);
      return receipt;
    } catch (error) {
      const receipt = await this.#previewReceipt(
        request,
        requestDigest,
        "failed",
        request.currentRevision,
        await sha256({ failed: "preview-executor" }),
        [],
        [problem("PREVIEW_FAILED", error instanceof Error ? error.message : "Preview executor failed.", "Correct the deterministic executor failure and request a new preview.")],
        readiness.planDigest
      );
      this.#previewByIdempotency.set(request.idempotencyKey, { requestDigest, receipt });
      return receipt;
    }
  }

  async approve(request: ApprovalRequest): Promise<ApprovalToken> {
    const preview = this.#previewByDigest.get(request.previewReceiptDigest);
    if (!preview || preview.status !== "accepted") throw new GatewayWorkflowError("Approval requires an accepted preview receipt.", [problem(
      "PREVIEW_REQUIRED", "No accepted preview matches the requested receipt digest.", "Create a valid preview and approve that exact receipt."
    )]);
    const matches = preview.projectId === request.projectId
      && preview.baseRevision === request.baseRevision
      && preview.planId === request.planId
      && preview.planDigest === request.planDigest;
    if (!matches) throw new GatewayWorkflowError("Approval binding mismatch.", [problem(
      "APPROVAL_BINDING_MISMATCH",
      "Approval fields do not match the accepted preview's project, revision, plan, and plan digest.",
      "Approve the exact accepted preview without modifying its binding fields."
    )]);
    const issuedAt = this.clock.now();
    const binding = {
      tokenVersion: 1 as const,
      approvalId: request.approvalId,
      previewReceiptDigest: request.previewReceiptDigest,
      projectId: request.projectId,
      baseRevision: request.baseRevision,
      planId: request.planId,
      planDigest: request.planDigest,
      approvedBy: request.approvedBy,
      issuedAt
    };
    const bindingDigest = await sha256(binding);
    const token: ApprovalToken = deepFreeze({
      ...binding,
      token: `ps3d-approval-v1.${bindingDigest}`,
      bindingDigest
    });
    this.#approvalByToken.set(token.token, token);
    return token;
  }

  async apply(request: ApplyRequest): Promise<ApplyReceipt> {
    const requestDigest = await sha256(request);
    const cached = this.#applyByIdempotency.get(request.idempotencyKey);
    if (cached) {
      if (cached.requestDigest === requestDigest) return cached.receipt;
      return this.#applyReceipt(request, requestDigest, "blocked", request.currentRevision, "", [], [problem(
        "IDEMPOTENCY_CONFLICT",
        "This apply idempotency key was already used for different content.",
        "Retry the original apply unchanged or allocate a new idempotency key for a new approved transaction.",
        [request.idempotencyKey]
      )]);
    }

    const readiness = await analyzeFeaturePlan(request.plan, this.commandManifest);
    const handshake = this.#handshakes.get(request.handshakeAcknowledgement.handshakeId);
    const diagnostics = [...validateHandshakeAcknowledgement(request.handshakeAcknowledgement, handshake), ...readiness.diagnostics];
    const registeredPreview = this.#previewByDigest.get(request.previewReceipt.receiptDigest);
    if (!registeredPreview || registeredPreview.status !== "accepted") diagnostics.push(problem(
      "PREVIEW_REQUIRED", "Apply does not reference an accepted preview issued by this gateway.", "Preview the exact feature plan before approval and apply."
    ));
    if (request.currentRevision !== request.plan.baseRevision || request.projectId !== request.plan.projectId) diagnostics.push(problem(
      "REVISION_CONFLICT",
      `Current revision ${request.currentRevision} is incompatible with plan base revision ${request.plan.baseRevision}.`,
      "Re-inspect, re-plan, preview, and approve at the latest revision.",
      [request.projectId, request.plan.id]
    ));
    if (registeredPreview && (registeredPreview.planDigest !== readiness.planDigest || registeredPreview.projectId !== request.projectId
      || registeredPreview.baseRevision !== request.currentRevision)) diagnostics.push(problem(
      "APPROVAL_BINDING_MISMATCH", "The supplied plan no longer matches the accepted preview.", "Apply the exact previewed plan or request a new preview."
    ));
    const registeredApproval = this.#approvalByToken.get(request.approvalToken.token);
    if (!registeredApproval) diagnostics.push(problem(
      "APPROVAL_REQUIRED", "The approval token was not issued by this gateway instance.", "Approve the accepted preview through this gateway."
    ));
    else {
      const approvalMatches = registeredApproval.bindingDigest === request.approvalToken.bindingDigest
        && registeredApproval.previewReceiptDigest === request.previewReceipt.receiptDigest
        && registeredApproval.projectId === request.projectId
        && registeredApproval.baseRevision === request.currentRevision
        && registeredApproval.planId === request.plan.id
        && registeredApproval.planDigest === readiness.planDigest;
      if (!approvalMatches || this.#consumedApprovals.has(registeredApproval.token)) diagnostics.push(problem(
        "APPROVAL_BINDING_MISMATCH",
        this.#consumedApprovals.has(registeredApproval.token) ? "The approval token has already been consumed." : "Approval token fields do not match this apply transaction.",
        "Obtain a fresh approval for the exact project revision, plan, and preview receipt."
      ));
    }
    if (diagnostics.some((entry) => entry.severity === "error")) {
      const receipt = await this.#applyReceipt(request, requestDigest, "blocked", request.currentRevision, "", [], diagnostics, readiness.planDigest);
      this.#applyByIdempotency.set(request.idempotencyKey, { requestDigest, receipt });
      return receipt;
    }

    try {
      const result = await this.executor.apply({
        projectId: request.projectId,
        expectedRevision: request.currentRevision,
        plan: request.plan,
        planDigest: readiness.planDigest,
        previewReceipt: registeredPreview ?? request.previewReceipt
      });
      const resultDiagnostics = [...result.diagnostics];
      if (result.applied && result.resultingRevision !== request.currentRevision + 1) resultDiagnostics.push(problem(
        "APPLY_FAILED", "The executor returned an invalid resulting revision.", "Commit atomically from expectedRevision to expectedRevision + 1."
      ));
      const applied = result.applied && !resultDiagnostics.some((entry) => entry.severity === "error");
      const receipt = await this.#applyReceipt(
        request,
        requestDigest,
        applied ? "applied" : "failed",
        result.resultingRevision,
        result.resultingDocumentDigest,
        result.changedEntityIds,
        resultDiagnostics,
        readiness.planDigest
      );
      this.#applyByIdempotency.set(request.idempotencyKey, { requestDigest, receipt });
      if (applied) this.#consumedApprovals.add(request.approvalToken.token);
      return receipt;
    } catch (error) {
      const receipt = await this.#applyReceipt(
        request, requestDigest, "failed", request.currentRevision, "", [],
        [problem("APPLY_FAILED", error instanceof Error ? error.message : "Apply executor failed.", "Resolve the atomic commit failure and re-inspect the current revision.")],
        readiness.planDigest
      );
      this.#applyByIdempotency.set(request.idempotencyKey, { requestDigest, receipt });
      return receipt;
    }
  }

  async #previewReceipt(
    request: PreviewRequest,
    requestDigest: string,
    status: PreviewReceipt["status"],
    candidateRevision: number,
    candidateDigest: string,
    changedEntityIds: PreviewReceipt["changedEntityIds"],
    diagnostics: readonly GatewayDiagnostic[],
    suppliedPlanDigest?: string
  ): Promise<PreviewReceipt> {
    const planDigest = suppliedPlanDigest ?? await sha256(request.plan);
    const sequence = ++this.#sequence;
    const issuedAt = this.clock.now();
    const content = {
      receiptVersion: 1 as const,
      id: `receipt:preview-${sequence}` as ReceiptId,
      kind: "preview" as const,
      requestId: request.requestId,
      requestDigest,
      projectId: request.projectId,
      baseRevision: request.plan.baseRevision,
      candidateRevision,
      planId: request.plan.id,
      planDigest,
      candidateDigest,
      changedEntityIds,
      status,
      diagnostics,
      sequence,
      issuedAt
    };
    const receipt: PreviewReceipt = deepFreeze({ ...content, receiptDigest: await sha256(content) });
    this.#audit.push(receipt);
    return receipt;
  }

  async #applyReceipt(
    request: ApplyRequest,
    requestDigest: string,
    status: ApplyReceipt["status"],
    resultingRevision: number,
    resultingDocumentDigest: string,
    changedEntityIds: ApplyReceipt["changedEntityIds"],
    diagnostics: readonly GatewayDiagnostic[],
    suppliedPlanDigest?: string
  ): Promise<ApplyReceipt> {
    const planDigest = suppliedPlanDigest ?? await sha256(request.plan);
    const sequence = ++this.#sequence;
    const issuedAt = this.clock.now();
    const content = {
      receiptVersion: 1 as const,
      id: `receipt:apply-${sequence}` as ReceiptId,
      kind: "apply" as const,
      requestId: request.requestId,
      requestDigest,
      projectId: request.projectId,
      baseRevision: request.plan.baseRevision,
      resultingRevision,
      planId: request.plan.id,
      planDigest,
      previewReceiptDigest: request.previewReceipt.receiptDigest,
      approvalBindingDigest: request.approvalToken.bindingDigest,
      resultingDocumentDigest,
      changedEntityIds,
      status,
      diagnostics,
      sequence,
      issuedAt
    };
    const receipt: ApplyReceipt = deepFreeze({ ...content, receiptDigest: await sha256(content) });
    this.#audit.push(receipt);
    return receipt;
  }
}
