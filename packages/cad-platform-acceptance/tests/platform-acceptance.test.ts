import assert from "node:assert/strict";
import test from "node:test";
import { acknowledgementFor, type ApplyRequest } from "@ps3d/ai-engineering-gateway/src/index.js";
import {
  BODY_ID,
  SKETCH_ID,
  createBlockedFeaturePlan,
  createPlatformAcceptanceHarness,
  performManifestHandshake
} from "../src/index.js";

test("manifest-first plan rebuilds an exact candidate and applies only after bound approval", async () => {
  const harness = await createPlatformAcceptanceHarness();
  const handshake = await performManifestHandshake(harness);
  const acknowledgement = acknowledgementFor(handshake);

  assert.deepEqual(handshake.requiredSequence, [
    "read-schema-manifest",
    "read-command-manifest",
    "acknowledge",
    "plan",
    "preview",
    "approve",
    "apply"
  ]);

  const preview = await harness.gateway.preview({
    requestId: "request:platform-preview",
    idempotencyKey: "platform-preview-key-0001",
    handshakeAcknowledgement: acknowledgement,
    projectId: harness.plan.projectId,
    currentRevision: harness.plan.baseRevision,
    plan: harness.plan
  });

  assert.equal(preview.status, "accepted", JSON.stringify(preview.diagnostics));
  assert.equal(harness.currentDocument().revision, harness.plan.baseRevision);
  assert.deepEqual(preview.changedEntityIds, [SKETCH_ID, BODY_ID]);
  assert.equal(harness.counters.previewExecutions, 1);
  assert.equal(harness.lastEngineOutcome()?.status, "succeeded");
  assert.equal(harness.lastEngineOutcome()?.candidateDocument?.revision, harness.plan.baseRevision + 1);

  const approval = await harness.gateway.approve({
    approvalId: "approval:platform-acceptance",
    previewReceiptDigest: preview.receiptDigest,
    projectId: harness.plan.projectId,
    baseRevision: harness.plan.baseRevision,
    planId: harness.plan.id,
    planDigest: preview.planDigest,
    approvedBy: "acceptance-engineer@example.test",
    decision: "approve"
  });
  const applyRequest: ApplyRequest = {
    requestId: "request:platform-apply",
    idempotencyKey: "platform-apply-key-0001",
    handshakeAcknowledgement: acknowledgement,
    projectId: harness.plan.projectId,
    currentRevision: harness.plan.baseRevision,
    plan: harness.plan,
    previewReceipt: preview,
    approvalToken: approval
  };
  const applied = await harness.gateway.apply(applyRequest);

  assert.equal(applied.status, "applied");
  assert.equal(applied.resultingRevision, harness.plan.baseRevision + 1);
  assert.equal(harness.currentDocument().revision, harness.plan.baseRevision + 1);
  assert.equal(harness.counters.applyExecutions, 1);
  assert.ok(harness.gateway.auditReceipts().every((receipt) => Object.isFrozen(receipt)));
});

test("unresolved dimensions and standards block before the preview executor", async () => {
  const harness = await createPlatformAcceptanceHarness();
  const handshake = await performManifestHandshake(harness);
  const blockedPlan = createBlockedFeaturePlan(harness.sourceDocument.revision);
  const preview = await harness.gateway.preview({
    requestId: "request:blocked-platform-preview",
    idempotencyKey: "blocked-platform-preview-key-0001",
    handshakeAcknowledgement: acknowledgementFor(handshake),
    projectId: blockedPlan.projectId,
    currentRevision: blockedPlan.baseRevision,
    plan: blockedPlan
  });

  assert.equal(preview.status, "blocked");
  assert.ok(preview.diagnostics.some((entry) => entry.code === "AMBIGUITY_UNRESOLVED"));
  assert.ok(preview.diagnostics.some((entry) => entry.code === "EVIDENCE_UNVERIFIED"));
  assert.equal(harness.counters.previewExecutions, 0);
  assert.equal(harness.lastEngineOutcome(), null);
});

test("an unregistered exact operation fails closed without changing the live document", async () => {
  const harness = await createPlatformAcceptanceHarness({ registerExactFixture: false });
  const handshake = await performManifestHandshake(harness);
  const preview = await harness.gateway.preview({
    requestId: "request:missing-exact-fixture",
    idempotencyKey: "missing-exact-fixture-key-0001",
    handshakeAcknowledgement: acknowledgementFor(handshake),
    projectId: harness.plan.projectId,
    currentRevision: harness.plan.baseRevision,
    plan: harness.plan
  });

  assert.equal(preview.status, "failed");
  assert.equal(harness.counters.previewExecutions, 1);
  assert.equal(harness.lastEngineOutcome()?.status, "partial");
  assert.equal(harness.currentDocument().revision, harness.plan.baseRevision);
  assert.ok(preview.diagnostics.some((entry) => entry.code === "PREVIEW_FAILED"));
});

test("a stale revision is rejected before the apply executor mutates the document", async () => {
  const harness = await createPlatformAcceptanceHarness();
  const handshake = await performManifestHandshake(harness);
  const acknowledgement = acknowledgementFor(handshake);
  const preview = await harness.gateway.preview({
    requestId: "request:stale-platform-preview",
    idempotencyKey: "stale-platform-preview-key-0001",
    handshakeAcknowledgement: acknowledgement,
    projectId: harness.plan.projectId,
    currentRevision: harness.plan.baseRevision,
    plan: harness.plan
  });
  assert.equal(preview.status, "accepted", JSON.stringify(preview.diagnostics));
  const approval = await harness.gateway.approve({
    approvalId: "approval:stale-platform",
    previewReceiptDigest: preview.receiptDigest,
    projectId: harness.plan.projectId,
    baseRevision: harness.plan.baseRevision,
    planId: harness.plan.id,
    planDigest: preview.planDigest,
    approvedBy: "acceptance-engineer@example.test",
    decision: "approve"
  });
  const result = await harness.gateway.apply({
    requestId: "request:stale-platform-apply",
    idempotencyKey: "stale-platform-apply-key-0001",
    handshakeAcknowledgement: acknowledgement,
    projectId: harness.plan.projectId,
    currentRevision: harness.plan.baseRevision + 1,
    plan: harness.plan,
    previewReceipt: preview,
    approvalToken: approval
  });

  assert.equal(result.status, "blocked");
  assert.ok(result.diagnostics.some((entry) => entry.code === "REVISION_CONFLICT"));
  assert.equal(harness.counters.applyExecutions, 0);
  assert.equal(harness.currentDocument().revision, harness.plan.baseRevision);
});
