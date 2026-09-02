import type {
  ExactKernelCapabilities,
  ExecuteKernelOperationRequest,
  KernelExecutionTarget,
  KernelIdentity,
  OperationResultDraft
} from "../../exact-kernel-api/src/index.js";

export type Sha256Digest = `sha256:${string}`;

export interface OcctSourceEvidence {
  readonly repository: "https://github.com/Open-Cascade-SAS/OCCT";
  readonly tag: string;
  readonly commit: string;
  readonly sourceArchiveSha256: Sha256Digest;
}

export interface OcctArtifactEvidence {
  readonly kind: "wasm-module" | "native-library";
  readonly artifactSha256: Sha256Digest;
  readonly buildConfigurationSha256: Sha256Digest;
  readonly toolchain: string;
}

export interface OcctLicenseEvidence {
  readonly license: "LGPL-2.1-only";
  readonly specialException: "Open CASCADE Technology exception 1.0";
  readonly licenseTextSha256: Sha256Digest;
  readonly exceptionTextSha256: Sha256Digest;
  readonly thirdPartyNoticesSha256: Sha256Digest;
  readonly relinkMaterialsAvailable: boolean;
}

export interface OcctQualificationEvidence {
  readonly suiteId: string;
  readonly suiteVersion: string;
  readonly resultSha256: Sha256Digest;
  readonly passed: true;
}

/**
 * Evidence supplied by the trusted runtime loader after it hashes the bytes it
 * is about to execute. This is an attestation record, not a bundled OCCT build.
 */
export interface OcctRuntimeAttestation {
  readonly attestationVersion: 1;
  readonly identity: KernelIdentity;
  readonly capabilities: ExactKernelCapabilities;
  readonly source: OcctSourceEvidence;
  readonly artifact: OcctArtifactEvidence;
  readonly license: OcctLicenseEvidence;
  readonly qualification: OcctQualificationEvidence;
}

/** Exact deployment evidence accepted by the adapter factory. */
export interface OcctQualificationManifest extends OcctRuntimeAttestation {
  readonly manifestId: string;
}

/**
 * Isolated runtime process/worker. `terminate` must synchronously make further
 * geometry mutation impossible (Worker.terminate/process kill semantics).
 */
export interface OcctRuntimePort {
  openSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  execute(request: ExecuteKernelOperationRequest, signal?: AbortSignal): Promise<OperationResultDraft>;
  releaseShapes(sessionId: string, shapeIds: readonly string[], signal?: AbortSignal): Promise<readonly string[]>;
  closeSession(sessionId: string, signal?: AbortSignal): Promise<void>;
  cancel?(targetRequestId: string): Promise<void>;
  terminate(reason: string): void;
  dispose?(): Promise<void>;
}

export interface LoadedOcctRuntime {
  readonly runtime: OcctRuntimePort;
  readonly attestation: OcctRuntimeAttestation;
}

/**
 * Trusted computing boundary. The loader, not the executable runtime, hashes
 * the bytes it loads and returns the observed evidence with an isolated port.
 */
export interface TrustedOcctRuntimeLoader {
  load(manifest: OcctQualificationManifest, signal?: AbortSignal): Promise<LoadedOcctRuntime>;
}

export type OcctAttestationFindingCode =
  | "MANIFEST_INVALID"
  | "IDENTITY_MISMATCH"
  | "SOURCE_MISMATCH"
  | "ARTIFACT_MISMATCH"
  | "LICENSE_EVIDENCE_MISMATCH"
  | "QUALIFICATION_MISMATCH"
  | "CAPABILITY_MISMATCH"
  | "RUNTIME_CONTRACT_MISMATCH";

export interface OcctAttestationFinding {
  readonly code: OcctAttestationFindingCode;
  readonly field: string;
  readonly message: string;
}

export interface OcctAdapterOptions {
  readonly operationTimeoutMilliseconds?: number;
  readonly managementTimeoutMilliseconds?: number;
  readonly maximumTessellationBytes?: number;
}

export interface AttestedOcctKernel {
  readonly adapter: import("../../exact-kernel-api/src/index.js").ExactKernelAdapter & {
    dispose(): Promise<void>;
  };
  readonly attestation: OcctRuntimeAttestation;
  readonly manifestId: string;
}

export function isOcctExecutionTarget(target: KernelExecutionTarget): target is "wasm-worker" | "native-worker" {
  return target === "wasm-worker" || target === "native-worker";
}
