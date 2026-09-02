import { renderExchangeSha256 } from "./canonical.js";
import { validateTransferReport } from "./exchange.js";
import { renderSceneDigest, renderSourceManifest } from "./render.js";
import type {
  ContentReference,
  ExchangeContentReceipt,
  ExchangeJob,
  ExchangeTransferReport,
  RenderExchangeDiagnostic,
  RenderProductReceipt,
  RenderRequest,
  Sha256Digest
} from "./types.js";
import { RENDER_EXCHANGE_PROTOCOL_VERSION } from "./types.js";
import { diagnostic, hasErrors, validateContentReference, validateDigest } from "./validation.js";

export interface RendererIdentity {
  readonly implementation: string;
  readonly version: string;
  readonly buildDigest: Sha256Digest;
}

export async function createRenderProductReceipt(
  request: RenderRequest,
  renderer: RendererIdentity,
  output: ContentReference,
  deterministic: boolean
): Promise<RenderProductReceipt> {
  const manifest = renderSourceManifest(request.scene);
  const requestDigest = await renderExchangeSha256(request);
  const sceneDigest = await renderSceneDigest(request.scene);
  const base = {
    protocolVersion: RENDER_EXCHANGE_PROTOCOL_VERSION,
    requestDigest,
    sceneDigest,
    exactDocumentDigest: manifest.exactDocumentDigest,
    tessellationDigests: manifest.tessellations.map((item) => item.tessellationDigest),
    renderer,
    output,
    deterministic
  } as const;
  return { ...base, resultDigest: await renderExchangeSha256(base) };
}

export async function validateRenderProductReceipt(
  request: RenderRequest,
  receipt: RenderProductReceipt
): Promise<readonly RenderExchangeDiagnostic[]> {
  const manifest = renderSourceManifest(request.scene);
  const diagnostics: RenderExchangeDiagnostic[] = [
    ...validateDigest(receipt.requestDigest, "receipt.requestDigest"),
    ...validateDigest(receipt.sceneDigest, "receipt.sceneDigest"),
    ...validateDigest(receipt.renderer.buildDigest, "receipt.renderer.buildDigest"),
    ...validateDigest(receipt.resultDigest, "receipt.resultDigest"),
    ...validateContentReference(receipt.output, "receipt.output")
  ];
  if (receipt.protocolVersion !== RENDER_EXCHANGE_PROTOCOL_VERSION
    || receipt.requestDigest !== await renderExchangeSha256(request)
    || receipt.sceneDigest !== await renderSceneDigest(request.scene)
    || receipt.exactDocumentDigest !== manifest.exactDocumentDigest
    || !sameStrings(receipt.tessellationDigests, manifest.tessellations.map((item) => item.tessellationDigest))) {
    diagnostics.push(diagnostic(
      "RECEIPT_MISMATCH", "error", "receipt", "Render receipt does not bind the submitted scene and exact-model sources.",
      "Discard the output and regenerate it from the current scene."
    ));
  }
  const { resultDigest: _ignored, ...base } = receipt;
  if (receipt.resultDigest !== await renderExchangeSha256(base)) diagnostics.push(diagnostic(
    "RECEIPT_MISMATCH", "error", "receipt.resultDigest", "Render result receipt digest is invalid.", "Regenerate the receipt after rendering."
  ));
  return diagnostics;
}

export async function createExchangeContentReceipt(
  job: ExchangeJob,
  report: ExchangeTransferReport
): Promise<ExchangeContentReceipt> {
  const diagnostics = validateTransferReport(job, report);
  if (hasErrors(diagnostics)) throw new TypeError(`Cannot receipt an invalid transfer report: ${diagnostics.map((item) => item.code).join(", ")}`);
  const base = {
    protocolVersion: RENDER_EXCHANGE_PROTOCOL_VERSION,
    jobDigest: await renderExchangeSha256(job),
    reportDigest: await renderExchangeSha256(report),
    sourceContentDigest: report.sourceArtifact.contentDigest,
    resultContentDigest: report.resultArtifact?.contentDigest ?? null,
    documentDigest: job.documentDigest,
    translatorBuildDigest: report.translator.buildDigest
  } as const;
  return { ...base, receiptDigest: await renderExchangeSha256(base) };
}

export async function validateExchangeContentReceipt(
  job: ExchangeJob,
  report: ExchangeTransferReport,
  receipt: ExchangeContentReceipt
): Promise<readonly RenderExchangeDiagnostic[]> {
  const diagnostics: RenderExchangeDiagnostic[] = [...validateTransferReport(job, report, receipt)];
  const expectedBase = {
    protocolVersion: RENDER_EXCHANGE_PROTOCOL_VERSION,
    jobDigest: await renderExchangeSha256(job),
    reportDigest: await renderExchangeSha256(report),
    sourceContentDigest: report.sourceArtifact.contentDigest,
    resultContentDigest: report.resultArtifact?.contentDigest ?? null,
    documentDigest: job.documentDigest,
    translatorBuildDigest: report.translator.buildDigest
  } as const;
  const expectedDigest = await renderExchangeSha256(expectedBase);
  if (receipt.protocolVersion !== expectedBase.protocolVersion
    || receipt.jobDigest !== expectedBase.jobDigest
    || receipt.reportDigest !== expectedBase.reportDigest
    || receipt.sourceContentDigest !== expectedBase.sourceContentDigest
    || receipt.resultContentDigest !== expectedBase.resultContentDigest
    || receipt.documentDigest !== expectedBase.documentDigest
    || receipt.translatorBuildDigest !== expectedBase.translatorBuildDigest
    || receipt.receiptDigest !== expectedDigest) diagnostics.push(diagnostic(
      "RECEIPT_MISMATCH", "error", "receipt", "Exchange receipt does not match the canonical job, report, artifacts, or translator build.",
      "Discard the transfer artifact and regenerate the receipt from trusted inputs."
    ));
  return diagnostics;
}

function sameStrings(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}
