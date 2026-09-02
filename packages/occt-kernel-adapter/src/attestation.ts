import {
  EXACT_KERNEL_OPERATION_KINDS,
  EXACT_KERNEL_PROTOCOL_VERSION,
  canonicalKernelJson
} from "../../exact-kernel-api/src/index.js";
import {
  isOcctExecutionTarget,
  type OcctAttestationFinding,
  type OcctQualificationManifest,
  type OcctRuntimeAttestation,
  type Sha256Digest
} from "./types.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;

export class OcctAttestationError extends Error {
  readonly findings: readonly OcctAttestationFinding[];

  constructor(findings: readonly OcctAttestationFinding[]) {
    super(findings.map((finding) => finding.message).join(" "));
    this.name = "OcctAttestationError";
    this.findings = structuredClone(findings);
  }
}

export function verifyOcctRuntimeAttestation(
  expected: OcctQualificationManifest,
  observed: OcctRuntimeAttestation
): readonly OcctAttestationFinding[] {
  const findings: OcctAttestationFinding[] = [];
  validateManifest(expected, findings);
  if (!isRecord(observed)) {
    findings.push(finding("MANIFEST_INVALID", "runtimeAttestation", "The runtime attestation is not a plain structured record."));
    return findings;
  }
  compare(findings, "identity", expected.identity, observed.identity, "IDENTITY_MISMATCH");
  compare(findings, "source", expected.source, observed.source, "SOURCE_MISMATCH");
  compare(findings, "artifact", expected.artifact, observed.artifact, "ARTIFACT_MISMATCH");
  compare(findings, "license", expected.license, observed.license, "LICENSE_EVIDENCE_MISMATCH");
  compare(findings, "qualification", expected.qualification, observed.qualification, "QUALIFICATION_MISMATCH");
  compare(findings, "capabilities", expected.capabilities, observed.capabilities, "CAPABILITY_MISMATCH");
  if (observed.attestationVersion !== 1) findings.push(finding(
    "MANIFEST_INVALID", "attestationVersion", "The runtime attestation version is unsupported."
  ));
  return findings;
}

function validateManifest(manifest: OcctQualificationManifest, findings: OcctAttestationFinding[]): void {
  if (manifest.attestationVersion !== 1) findings.push(finding("MANIFEST_INVALID", "attestationVersion", "The qualification manifest version is unsupported."));
  if (!validText(manifest.manifestId)) findings.push(finding("MANIFEST_INVALID", "manifestId", "The qualification manifest needs a bounded stable identifier."));
  if (manifest.identity.contractVersion !== EXACT_KERNEL_PROTOCOL_VERSION) findings.push(finding(
    "MANIFEST_INVALID", "identity.contractVersion", "The qualified runtime uses an incompatible exact-kernel contract."
  ));
  if (!isOcctExecutionTarget(manifest.identity.executionTarget)) findings.push(finding(
    "MANIFEST_INVALID", "identity.executionTarget", "An OCCT runtime must execute in an isolated WASM or native worker."
  ));
  if (manifest.identity.kernel !== "Open CASCADE Technology") findings.push(finding(
    "MANIFEST_INVALID", "identity.kernel", "The runtime does not identify Open CASCADE Technology."
  ));
  if (manifest.source.repository !== "https://github.com/Open-Cascade-SAS/OCCT") findings.push(finding(
    "MANIFEST_INVALID", "source.repository", "The source evidence must identify the official OCCT repository."
  ));
  if (!COMMIT_PATTERN.test(manifest.source.commit)) findings.push(finding(
    "MANIFEST_INVALID", "source.commit", "The source commit must be a full lowercase Git SHA-1."
  ));
  for (const [field, value] of [
    ["identity.implementation", manifest.identity.implementation],
    ["identity.implementationVersion", manifest.identity.implementationVersion],
    ["identity.kernelVersion", manifest.identity.kernelVersion],
    ["identity.buildId", manifest.identity.buildId],
    ["source.tag", manifest.source.tag],
    ["artifact.toolchain", manifest.artifact.toolchain],
    ["qualification.suiteId", manifest.qualification.suiteId],
    ["qualification.suiteVersion", manifest.qualification.suiteVersion]
  ] as const) {
    if (!validText(value)) findings.push(finding("MANIFEST_INVALID", field, `${field} must be a bounded non-empty string.`));
  }
  for (const [field, digest] of digestFields(manifest)) {
    if (!SHA256_PATTERN.test(digest)) findings.push(finding("MANIFEST_INVALID", field, `${field} must be a lowercase SHA-256 digest.`));
  }
  if (manifest.qualification.passed !== true) findings.push(finding(
    "MANIFEST_INVALID", "qualification.passed", "Only a passing qualification result can activate an OCCT runtime."
  ));
  if (!manifest.license.relinkMaterialsAvailable) findings.push(finding(
    "MANIFEST_INVALID", "license.relinkMaterialsAvailable", "Required relink materials are not recorded as available."
  ));
  if (manifest.capabilities.canonicalLengthUnit !== "m" || manifest.capabilities.canonicalAngleUnit !== "rad") findings.push(finding(
    "MANIFEST_INVALID", "capabilities.canonicalUnits", "The exact-kernel boundary requires metres and radians."
  ));
  const capabilities = manifest.capabilities;
  if (!Array.isArray(capabilities.supportedOperations)
    || capabilities.supportedOperations.length === 0
    || new Set(capabilities.supportedOperations).size !== capabilities.supportedOperations.length
    || !capabilities.supportedOperations.every((operation) => (EXACT_KERNEL_OPERATION_KINDS as readonly string[]).includes(operation))) {
    findings.push(finding("MANIFEST_INVALID", "capabilities.supportedOperations", "Qualified operations must be a unique, non-empty list of exact-kernel operation kinds."));
  }
  validateEnumList(capabilities.importFormats, ["step", "iges", "brep"], "capabilities.importFormats", findings);
  validateEnumList(capabilities.exportFormats, ["step", "iges", "brep", "stl", "obj", "3mf"], "capabilities.exportFormats", findings);
  validateEnumList(capabilities.supportedContinuity, ["g0", "g1", "g2"], "capabilities.supportedContinuity", findings);
  if (!positiveFinite(capabilities.minimumLinearToleranceMeters)
    || !positiveFinite(capabilities.maximumLinearToleranceMeters)
    || capabilities.minimumLinearToleranceMeters > capabilities.maximumLinearToleranceMeters) {
    findings.push(finding("MANIFEST_INVALID", "capabilities.linearToleranceMeters", "Qualified linear tolerance bounds must be finite, positive, and ordered."));
  }
  if (!positiveFinite(capabilities.minimumAngularToleranceRadians)) findings.push(finding(
    "MANIFEST_INVALID", "capabilities.minimumAngularToleranceRadians", "The minimum angular tolerance must be finite and positive."
  ));
  for (const [field, limit] of Object.entries(capabilities.resourceLimits)) {
    if (!Number.isSafeInteger(limit) || limit < 1) findings.push(finding(
      "MANIFEST_INVALID", `capabilities.resourceLimits.${field}`, `capabilities.resourceLimits.${field} must be a positive safe integer.`
    ));
  }
}

function digestFields(manifest: OcctQualificationManifest): readonly (readonly [string, Sha256Digest])[] {
  return [
    ["source.sourceArchiveSha256", manifest.source.sourceArchiveSha256],
    ["artifact.artifactSha256", manifest.artifact.artifactSha256],
    ["artifact.buildConfigurationSha256", manifest.artifact.buildConfigurationSha256],
    ["license.licenseTextSha256", manifest.license.licenseTextSha256],
    ["license.exceptionTextSha256", manifest.license.exceptionTextSha256],
    ["license.thirdPartyNoticesSha256", manifest.license.thirdPartyNoticesSha256],
    ["qualification.resultSha256", manifest.qualification.resultSha256]
  ];
}

function compare(
  findings: OcctAttestationFinding[],
  field: string,
  expected: unknown,
  observed: unknown,
  code: OcctAttestationFinding["code"]
): void {
  try {
    if (canonicalKernelJson(expected) === canonicalKernelJson(observed)) return;
  } catch {
    findings.push(finding(code, field, `Runtime ${field} is not a canonical protocol value.`));
    return;
  }
  findings.push(finding(code, field, `Runtime ${field} does not match qualification manifest.`));
}

function finding(code: OcctAttestationFinding["code"], field: string, message: string): OcctAttestationFinding {
  return { code, field, message };
}

function validateEnumList(
  value: readonly string[],
  allowed: readonly string[],
  field: string,
  findings: OcctAttestationFinding[]
): void {
  if (!Array.isArray(value) || new Set(value).size !== value.length || !value.every((item) => allowed.includes(item))) findings.push(finding(
    "MANIFEST_INVALID", field, `${field} must contain only unique, qualified protocol values.`
  ));
}

function validText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 16_384;
}

function positiveFinite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ArrayBuffer.isView(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
