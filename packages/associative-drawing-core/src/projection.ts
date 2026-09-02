import type { DrawingDiagnostic, DrawingView, ModelEntityId, ViewId } from "./types.js";

export interface ProjectedCurve2d {
  readonly id: string;
  readonly kind: "line" | "circle" | "arc" | "ellipse" | "bspline";
  readonly sourceEntityId: ModelEntityId;
  readonly sourceTopologyKey: string;
  readonly visibility: "visible" | "hidden" | "tangent" | "section";
  readonly parameters: Readonly<Record<string, number | readonly number[]>>;
}

export interface DrawingProjectionRequest {
  readonly requestId: string;
  readonly modelDocumentId: string;
  readonly modelRevision: number;
  readonly view: DrawingView;
}

export interface DrawingProjectionResult {
  readonly viewId: ViewId;
  readonly modelRevision: number;
  readonly curves: readonly ProjectedCurve2d[];
  readonly digest: string;
  readonly exactSource: true;
  readonly diagnostics: readonly DrawingDiagnostic[];
}

export interface DrawingProjectionBackend {
  readonly identity: string;
  project(request: DrawingProjectionRequest, signal?: AbortSignal): Promise<DrawingProjectionResult>;
}
