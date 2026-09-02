import {
  collectSurfaceDependencyKeys,
  surfaceInvalidationDigest,
  surfaceSha256
} from "./canonical.js";
import type {
  ExactSurfaceBackend,
  SurfaceAnalysisBackendResult,
  SurfaceAnalysisRequest,
  SurfaceEvaluation,
  SurfaceEvaluationReceipt,
  SurfaceFeatureBackendResult,
  SurfaceFeatureRequest
} from "./types.js";
import { SurfaceContractError } from "./types.js";
import {
  hasErrors,
  validateAnalysisBackendResult,
  validateFeatureBackendResult,
  validateSurfaceAnalysisRequest,
  validateSurfaceFeatureRequest
} from "./validation.js";

export class SurfaceQualityService {
  readonly backend: ExactSurfaceBackend;

  constructor(backend: ExactSurfaceBackend | null | undefined) {
    if (backend === null || backend === undefined) {
      throw new SurfaceContractError(
        "EXACT_BACKEND_REQUIRED",
        "Surface construction and analysis require an injected exact surface backend."
      );
    }
    this.backend = backend;
  }

  async evaluateFeature(request: SurfaceFeatureRequest): Promise<SurfaceEvaluation<SurfaceFeatureBackendResult>> {
    const requestDiagnostics = validateSurfaceFeatureRequest(request);
    if (hasErrors(requestDiagnostics)) {
      throw new SurfaceContractError("INVALID_REQUEST", "Surface feature request failed contract validation.", requestDiagnostics);
    }
    this.assertFeatureCapability(request);

    const requestDigest = await surfaceSha256(request);
    const result = await this.backend.evaluateFeature(request, requestDigest);
    const resultDiagnostics = validateFeatureBackendResult(result, request, requestDigest);
    this.assertBackendResult(resultDiagnostics);
    return {
      result,
      receipt: await this.createReceipt(
        request.featureId,
        request.operation,
        request,
        result,
        requestDigest
      )
    };
  }

  async analyze(request: SurfaceAnalysisRequest): Promise<SurfaceEvaluation<SurfaceAnalysisBackendResult>> {
    const requestDiagnostics = validateSurfaceAnalysisRequest(request);
    if (hasErrors(requestDiagnostics)) {
      throw new SurfaceContractError("INVALID_REQUEST", "Surface analysis request failed contract validation.", requestDiagnostics);
    }
    this.assertAnalysisCapability(request);

    const requestDigest = await surfaceSha256(request);
    const result = await this.backend.analyze(request, requestDigest);
    const resultDiagnostics = validateAnalysisBackendResult(result, request, requestDigest);
    this.assertBackendResult(resultDiagnostics);
    return {
      result,
      receipt: await this.createReceipt(
        request.analysisId,
        request.analysis,
        request,
        result,
        requestDigest
      )
    };
  }

  private assertFeatureCapability(request: SurfaceFeatureRequest): void {
    const capabilities = this.backend.capabilities;
    if (!capabilities.supportedOperations.includes(request.operation)) {
      throw new SurfaceContractError("UNSUPPORTED_CAPABILITY", `Exact surface backend does not support '${request.operation}'.`);
    }
    for (const boundary of request.boundaryConditions) {
      if (!capabilities.supportedContinuity.includes(boundary.goal)) {
        throw new SurfaceContractError("UNSUPPORTED_CAPABILITY", `Exact surface backend does not support ${boundary.goal} continuity.`);
      }
    }
    if (request.tolerance.positionalMeters < capabilities.minimumPositionalToleranceMeters) {
      throw new SurfaceContractError("UNSUPPORTED_CAPABILITY", "Requested positional tolerance is below the backend capability floor.");
    }
    if (request.tolerance.angularRadians < capabilities.minimumAngularToleranceRadians) {
      throw new SurfaceContractError("UNSUPPORTED_CAPABILITY", "Requested angular tolerance is below the backend capability floor.");
    }
  }

  private assertAnalysisCapability(request: SurfaceAnalysisRequest): void {
    const capabilities = this.backend.capabilities;
    if (!capabilities.supportedAnalyses.includes(request.analysis)) {
      throw new SurfaceContractError("UNSUPPORTED_CAPABILITY", `Exact surface backend does not support '${request.analysis}'.`);
    }
    const requestedSamples = request.sampling.uSamples * request.sampling.vSamples;
    if (!Number.isSafeInteger(requestedSamples) || requestedSamples > capabilities.maximumSamplesPerAnalysis) {
      throw new SurfaceContractError("UNSUPPORTED_CAPABILITY", "Requested surface-analysis sample budget exceeds the backend capability.");
    }
  }

  private assertBackendResult(diagnostics: ReturnType<typeof validateFeatureBackendResult>): void {
    if (!hasErrors(diagnostics)) return;
    const code = diagnostics.some((item) => item.code === "NON_FINITE_BACKEND_RESULT")
      ? "NON_FINITE_BACKEND_RESULT"
      : "BACKEND_PROTOCOL_ERROR";
    throw new SurfaceContractError(code, "Exact surface backend returned an invalid result.", diagnostics);
  }

  private async createReceipt(
    artifactId: string,
    artifactKind: SurfaceFeatureRequest["operation"] | SurfaceAnalysisRequest["analysis"],
    request: SurfaceFeatureRequest | SurfaceAnalysisRequest,
    result: SurfaceFeatureBackendResult | SurfaceAnalysisBackendResult,
    requestDigest: string
  ): Promise<SurfaceEvaluationReceipt> {
    const dependencyKeys = collectSurfaceDependencyKeys(request);
    return {
      schemaVersion: 1,
      artifactId,
      artifactKind,
      requestDigest,
      resultDigest: await surfaceSha256(result),
      dependencyKeys,
      invalidationDigest: await surfaceInvalidationDigest(artifactId, requestDigest, dependencyKeys),
      backend: this.backend.identity,
      deterministic: this.backend.capabilities.deterministicForIdenticalBuildAndInputs
    };
  }
}

export function createSurfaceQualityService(backend?: ExactSurfaceBackend | null): SurfaceQualityService {
  return new SurfaceQualityService(backend);
}
