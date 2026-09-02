import type {
  AssetUriPolicy,
  ExchangeContentReceipt,
  ExchangeFormat,
  ExchangeJob,
  ExchangeTransferReport,
  OpenExchangeJob,
  ProprietaryExchangeFormat,
  RenderExchangeDiagnostic,
  TransferPreservationRequest,
  TransferPreservationReport,
  TranslatorCapability,
  TranslatorManifest
} from "./types.js";
import {
  DRAWING_FORMATS,
  EXACT_NEUTRAL_FORMATS,
  MESH_FORMATS,
  PROPRIETARY_FORMATS,
  RENDER_EXCHANGE_PROTOCOL_VERSION
} from "./types.js";
import {
  DEFAULT_ASSET_URI_POLICY,
  diagnostic,
  validateContentReference,
  validateDigest,
  validateFinite,
  validateStableId
} from "./validation.js";

const OPEN_FORMAT_SET = new Set<ExchangeFormat>([...EXACT_NEUTRAL_FORMATS, ...MESH_FORMATS, ...DRAWING_FORMATS]);
const PROPRIETARY_FORMAT_SET = new Set<ExchangeFormat>(PROPRIETARY_FORMATS);

export interface ExchangeAuthorization {
  readonly authorized: boolean;
  readonly capability: TranslatorCapability | null;
  readonly diagnostics: readonly RenderExchangeDiagnostic[];
}

export function validateExchangeJob(
  job: ExchangeJob,
  assetPolicy: AssetUriPolicy = DEFAULT_ASSET_URI_POLICY
): readonly RenderExchangeDiagnostic[] {
  const diagnostics: RenderExchangeDiagnostic[] = [
    ...validateStableId(job.jobId, "job.jobId"),
    ...validateStableId(job.documentId, "job.documentId"),
    ...validateDigest(job.documentDigest, "job.documentDigest"),
    ...validateFinite(job.documentRevision, "job.documentRevision", { min: 0, integer: true }),
    ...validateFinite(job.validation.maximumToleranceMeters, "job.validation.maximumToleranceMeters", { min: Number.MIN_VALUE }),
    ...validateFinite(job.healing.maximumHealingToleranceMeters, "job.healing.maximumHealingToleranceMeters", { min: Number.MIN_VALUE }),
    ...validateContentReference(job.artifact, "job.artifact", assetPolicy)
  ];
  if (job.protocolVersion !== RENDER_EXCHANGE_PROTOCOL_VERSION) diagnostics.push(diagnostic(
    "INVALID_EXCHANGE_JOB", "error", "job.protocolVersion", "Unsupported render/exchange protocol version.", "Negotiate the current protocol before transfer."
  ));
  if (job.healing.maximumHealingToleranceMeters > job.validation.maximumToleranceMeters) diagnostics.push(diagnostic(
    "INVALID_EXCHANGE_JOB", "error", "job.healing.maximumHealingToleranceMeters",
    "Healing tolerance exceeds the maximum accepted validation tolerance.", "Reduce the healing tolerance or explicitly raise the accepted modelling tolerance."
  ));
  if (job.translatorKind === "open-format") diagnostics.push(...validateOpenJob(job));
  else diagnostics.push(...validateProprietaryJob(job));
  return diagnostics;
}

export function authorizeExchangeJob(job: ExchangeJob, manifest: TranslatorManifest): ExchangeAuthorization {
  const diagnostics: RenderExchangeDiagnostic[] = [...validateExchangeJob(job)];
  const requiredCapabilityId = job.translatorKind === "licensed-proprietary" ? job.translatorRequirement.capabilityId : null;
  const capability = manifest.capabilities.find((candidate) => (
    requiredCapabilityId === null || candidate.capabilityId === requiredCapabilityId
  ) && candidate.format === job.format && candidate.directions.includes(job.direction)) ?? null;

  if (capability === null) {
    diagnostics.push(diagnostic(
      job.translatorKind === "licensed-proprietary" ? "LICENSED_TRANSLATOR_REQUIRED" : "TRANSLATOR_CAPABILITY_MISSING",
      "error", "job.format", `Translator does not advertise ${job.direction} capability for '${job.format}'.`,
      job.translatorKind === "licensed-proprietary"
        ? "Install and license an approved native translator, or export a supported neutral format from the originating CAD system."
        : "Route the job to a translator that explicitly advertises this open format and direction."
    ));
    return { authorized: false, capability: null, diagnostics };
  }

  if (job.translatorKind === "licensed-proprietary") {
    if (!capability.requiresLicense) diagnostics.push(diagnostic(
      "LICENSED_TRANSLATOR_REQUIRED", "error", "manifest.capabilities",
      "A proprietary native-format capability cannot be declared license-free.", "Use a capability backed by an approved licensed translator."
    ));
    if (manifest.identity.licenseProvider !== job.translatorRequirement.provider) diagnostics.push(diagnostic(
      "LICENSED_TRANSLATOR_REQUIRED", "error", "manifest.identity.licenseProvider",
      "Translator license provider does not match the requested native translator.", "Select the translator provider required by the job."
    ));
    if (!capability.activeEntitlementIds.includes(job.translatorRequirement.licenseEntitlementId)) diagnostics.push(diagnostic(
      "LICENSE_ENTITLEMENT_MISSING", "error", "job.translatorRequirement.licenseEntitlementId",
      "The required native-translator entitlement is not active.", "Activate the entitlement or use a neutral format."
    ));
    if (compareVersions(manifest.identity.implementationVersion, job.translatorRequirement.minimumVersion) < 0) diagnostics.push(diagnostic(
      "TRANSLATOR_CAPABILITY_MISSING", "error", "manifest.identity.implementationVersion",
      "Translator implementation is older than the requested minimum version.", "Upgrade the licensed translator."
    ));
  }

  diagnostics.push(...preservationCapabilityDiagnostics(job.preservation, capability));
  return { authorized: diagnostics.every((item) => item.severity !== "error"), capability, diagnostics };
}

export function unsupportedProprietaryFormatDiagnostics(format: ProprietaryExchangeFormat): readonly RenderExchangeDiagnostic[] {
  return [diagnostic(
    "LICENSED_TRANSLATOR_REQUIRED", "error", "job.format",
    `Native '${format}' transfer is unavailable without a separately installed and licensed translator.`,
    "Install an approved translator with an active entitlement, or export STEP/IGES from the originating system. Native feature history may still not be preserved."
  )];
}

export function validateTransferReport(
  job: ExchangeJob,
  report: ExchangeTransferReport,
  receipt?: ExchangeContentReceipt
): readonly RenderExchangeDiagnostic[] {
  const diagnostics: RenderExchangeDiagnostic[] = [];
  if (report.jobId !== job.jobId || report.direction !== job.direction || report.format !== job.format) diagnostics.push(diagnostic(
    "RECEIPT_MISMATCH", "error", "report", "Transfer report does not identify the submitted job.", "Discard the report and retry with correlated job metadata."
  ));
  if (report.sourceArtifact.contentDigest !== job.artifact.contentDigest) diagnostics.push(diagnostic(
    "RECEIPT_MISMATCH", "error", "report.sourceArtifact.contentDigest", "Transfer report source digest differs from the requested artifact.", "Discard the report."
  ));
  diagnostics.push(...validateContentReference(report.sourceArtifact, "report.sourceArtifact"));
  if (report.resultArtifact !== null) diagnostics.push(...validateContentReference(report.resultArtifact, "report.resultArtifact"));
  diagnostics.push(...validateDigest(report.translator.buildDigest, "report.translator.buildDigest"));
  diagnostics.push(...validateFinite(report.scaleApplied, "report.scaleApplied", { min: Number.MIN_VALUE }));
  diagnostics.push(...validateFinite(report.healing.inputToleranceMeters, "report.healing.inputToleranceMeters", { min: 0 }));
  diagnostics.push(...validateFinite(report.healing.outputToleranceMeters, "report.healing.outputToleranceMeters", { min: 0 }));
  diagnostics.push(...validateFinite(report.validation.checkedToleranceMeters, "report.validation.checkedToleranceMeters", { min: 0 }));
  for (const key of ["fixedSmallEdges", "fixedWireGaps", "sewnShells", "remainingOpenShells"] as const) {
    diagnostics.push(...validateFinite(report.healing[key], `report.healing.${key}`, { min: 0, integer: true }));
  }
  diagnostics.push(...validateFinite(report.validation.invalidEntityCount, "report.validation.invalidEntityCount", { min: 0, integer: true }));
  for (const key of ["assemblies", "components", "bodies", "solids", "shells", "faces", "curves", "meshes", "drawingEntities", "skippedEntities"] as const) {
    diagnostics.push(...validateFinite(report.statistics[key], `report.statistics.${key}`, { min: 0, integer: true }));
  }
  diagnostics.push(...preservationOutcomeDiagnostics(job.preservation, report.preservation));

  if (job.validation.validateExactGeometry && (EXACT_NEUTRAL_FORMATS as readonly string[]).includes(job.format)
    && (!report.validation.attempted || !report.validation.exact)) diagnostics.push(diagnostic(
      "GEOMETRY_INVALID", "error", "report.validation", "Exact neutral transfer did not complete exact-geometry validation.",
      "Validate the translated B-rep with the exact kernel before publishing the artifact."
    ));
  if (job.validation.rejectInvalidGeometry && report.validation.attempted && !report.validation.valid) diagnostics.push(diagnostic(
    "GEOMETRY_INVALID", "error", "report.validation.valid", "Transferred geometry failed validation and the job requires rejection.", "Repair the source or inspect the transfer diagnostics."
  ));
  if (job.healing.enabled && report.healing.attempted && report.healing.remainingOpenShells > 0) diagnostics.push(diagnostic(
    "HEALING_INCOMPLETE", job.validation.rejectInvalidGeometry ? "error" : "warning", "report.healing.remainingOpenShells",
    "Shape healing left open shells.", "Repair the source topology or use a more capable exact-geometry worker."
  ));
  if (report.status === "succeeded" && (report.resultArtifact === null || report.diagnostics.some((item) => item.severity === "error"))) diagnostics.push(diagnostic(
    "RECEIPT_MISMATCH", "error", "report.status", "A successful report must have a result artifact and no error diagnostics.", "Correct the report status or translator result."
  ));
  if (report.status === "failed" && report.resultArtifact !== null) diagnostics.push(diagnostic(
    "RECEIPT_MISMATCH", "error", "report.resultArtifact", "A failed transfer must not publish a result artifact.", "Quarantine the partial artifact."
  ));
  if (receipt !== undefined && receipt.sourceContentDigest !== report.sourceArtifact.contentDigest) diagnostics.push(diagnostic(
    "RECEIPT_MISMATCH", "error", "receipt.sourceContentDigest", "Receipt is not bound to the report source artifact.", "Regenerate the receipt from this report."
  ));
  return diagnostics;
}

function validateOpenJob(job: OpenExchangeJob): readonly RenderExchangeDiagnostic[] {
  const diagnostics: RenderExchangeDiagnostic[] = [];
  if (!OPEN_FORMAT_SET.has(job.format)) diagnostics.push(diagnostic(
    "UNSUPPORTED_FORMAT", "error", "job.format", `Format '${job.format}' is not an open exchange format.`, "Use the licensed-proprietary job contract."
  ));
  if (job.meshOptions !== undefined && !(MESH_FORMATS as readonly string[]).includes(job.format)) diagnostics.push(diagnostic(
    "INVALID_EXCHANGE_JOB", "error", "job.meshOptions", "Mesh options are valid only for STL, OBJ, or 3MF.", "Remove mesh options or select a mesh format."
  ));
  if ((MESH_FORMATS as readonly string[]).includes(job.format) && job.direction === "export" && job.meshOptions === undefined) diagnostics.push(diagnostic(
    "INVALID_EXCHANGE_JOB", "error", "job.meshOptions", "Mesh export requires explicit tessellation tolerances.", "Supply linear and angular deflection values."
  ));
  if (job.meshOptions !== undefined) {
    diagnostics.push(...validateFinite(job.meshOptions.linearDeflectionMeters, "job.meshOptions.linearDeflectionMeters", { min: Number.MIN_VALUE }));
    diagnostics.push(...validateFinite(job.meshOptions.angularDeflectionRadians, "job.meshOptions.angularDeflectionRadians", { min: Number.MIN_VALUE, max: Math.PI }));
  }
  if (job.drawingOptions !== undefined && !(DRAWING_FORMATS as readonly string[]).includes(job.format)) diagnostics.push(diagnostic(
    "INVALID_EXCHANGE_JOB", "error", "job.drawingOptions", "Drawing options are valid only for DXF or SVG.", "Remove drawing options or select a drawing format."
  ));
  return diagnostics;
}

function validateProprietaryJob(job: ExchangeJob & { readonly translatorKind: "licensed-proprietary" }): readonly RenderExchangeDiagnostic[] {
  const diagnostics: RenderExchangeDiagnostic[] = [];
  if (!PROPRIETARY_FORMAT_SET.has(job.format)) diagnostics.push(diagnostic(
    "UNSUPPORTED_FORMAT", "error", "job.format", `Format '${job.format}' is not a recognized native proprietary format.`, "Use the open-format job contract."
  ));
  if (job.translatorRequirement.provider.trim().length === 0
    || job.translatorRequirement.capabilityId.trim().length === 0
    || job.translatorRequirement.licenseEntitlementId.trim().length === 0
    || job.translatorRequirement.minimumVersion.trim().length === 0) diagnostics.push(diagnostic(
      "LICENSED_TRANSLATOR_REQUIRED", "error", "job.translatorRequirement",
      "Native-format jobs require a provider, capability, active entitlement, and minimum translator version.",
      "Select an installed and licensed translator explicitly."
    ));
  return diagnostics;
}

function preservationCapabilityDiagnostics(
  request: TransferPreservationRequest,
  capability: TranslatorCapability
): readonly RenderExchangeDiagnostic[] {
  const diagnostics: RenderExchangeDiagnostic[] = [];
  for (const key of preservationKeys()) {
    if (request[key] === "required" && !capability.preserves[key]) diagnostics.push(diagnostic(
      "PRESERVATION_UNAVAILABLE", "error", `job.preservation.${key}`,
      `Translator cannot preserve required ${humanize(key)}.`, "Choose a capable translator or relax the requirement explicitly."
    ));
  }
  return diagnostics;
}

function preservationOutcomeDiagnostics(
  request: TransferPreservationRequest,
  report: TransferPreservationReport
): readonly RenderExchangeDiagnostic[] {
  const diagnostics: RenderExchangeDiagnostic[] = [];
  for (const key of preservationKeys()) {
    const outcome = report[key];
    if (request[key] === "required" && outcome !== "preserved" && outcome !== "not-applicable") diagnostics.push(diagnostic(
      "TRANSFER_LOSS", "error", `report.preservation.${key}`, `Required ${humanize(key)} was ${outcome}.`, "Reject this result or retry with a more capable translator."
    ));
    else if (request[key] === "preferred" && (outcome === "partial" || outcome === "lost" || outcome === "unknown")) diagnostics.push(diagnostic(
      "TRANSFER_LOSS", "warning", `report.preservation.${key}`, `Preferred ${humanize(key)} was ${outcome}.`, "Review the translated model before use."
    ));
  }
  return diagnostics;
}

function preservationKeys(): readonly (keyof TransferPreservationRequest)[] {
  return ["assemblyStructure", "names", "colors", "layers", "productMetadata"];
}

function humanize(value: string): string {
  return value.replace(/([A-Z])/gu, " $1").toLowerCase();
}

function compareVersions(actual: string, required: string): number {
  const first = actual.split(/[.+-]/u).map((part) => Number.parseInt(part, 10));
  const second = required.split(/[.+-]/u).map((part) => Number.parseInt(part, 10));
  const length = Math.max(first.length, second.length);
  for (let index = 0; index < length; index += 1) {
    const left = Number.isFinite(first[index]) ? first[index] ?? 0 : 0;
    const right = Number.isFinite(second[index]) ? second[index] ?? 0 : 0;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}
