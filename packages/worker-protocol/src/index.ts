import type { DocumentCommand } from "../../commands/src/index.js";
import type { RevisionEvidence } from "../../evidence/src/index.js";
import type { CadDocument, Diagnostic, DisplayUnit } from "../../model-schema/src/index.js";
import type { SolidMeasurements, SolidTopology } from "../../solid-kernel-api/src/index.js";

interface RequestEnvelope {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly generation: number;
}

export interface BootstrapRequest extends RequestEnvelope {
  readonly kind: "bootstrap";
  readonly fallbackDocument: CadDocument;
  readonly fallbackEvidence: RevisionEvidence | null;
  readonly recoverLocal: boolean;
}

export interface CommitRequest extends RequestEnvelope {
  readonly kind: "commit";
  readonly baseRevision: number;
  readonly command: DocumentCommand;
}

export interface HistoryRequest extends RequestEnvelope {
  readonly kind: "history";
  readonly baseRevision: number;
  readonly direction: "undo" | "redo";
  readonly commandId: string;
}

export interface ExportStlRequest extends RequestEnvelope {
  readonly kind: "export-stl";
  readonly baseRevision: number;
  readonly unit: DisplayUnit;
}

export interface PersistRequest extends RequestEnvelope {
  readonly kind: "persist";
  readonly baseRevision: number;
}

export type WorkerRequest = BootstrapRequest | CommitRequest | HistoryRequest | ExportStlRequest | PersistRequest;

interface ResponseEnvelope {
  readonly protocolVersion: 1;
  readonly requestId: string;
  readonly generation: number;
  readonly currentRevision: number;
}

export interface HistoryAvailability {
  readonly undoDepth: number;
  readonly redoDepth: number;
}

export interface CommandResult {
  readonly commandId: string;
  readonly commandRevision: number;
  readonly disposition: "committed" | "replayed";
}

export interface ModelSuccessResponse extends ResponseEnvelope {
  readonly status: "ok";
  readonly kind: "model";
  readonly operation: "bootstrap" | "commit" | "undo" | "redo";
  readonly document: CadDocument;
  readonly evidence: RevisionEvidence;
  readonly render: {
    readonly bodyId: string;
    readonly positions: Float64Array;
    readonly indices: Uint32Array;
    readonly measurements: SolidMeasurements;
    readonly topology: SolidTopology;
  };
  readonly changedSemanticIds: readonly string[];
  readonly recoveredFromLocal: boolean;
  readonly history: HistoryAvailability;
  readonly commandResult: CommandResult | null;
}

export interface ExportSuccessResponse extends ResponseEnvelope {
  readonly status: "ok";
  readonly kind: "export-stl";
  readonly bytes: ArrayBuffer;
  readonly unit: DisplayUnit;
  readonly triangleCount: number;
}

export interface PersistSuccessResponse extends ResponseEnvelope {
  readonly status: "ok";
  readonly kind: "persist";
}

export interface WorkerFailureResponse extends ResponseEnvelope {
  readonly status: "error";
  readonly kind: "failure";
  readonly diagnostics: readonly Diagnostic[];
}

export type WorkerResponse = ModelSuccessResponse | ExportSuccessResponse | PersistSuccessResponse | WorkerFailureResponse;

export {
  isWorkerRequest,
  requestCorrelation,
  validateExpectedWorkerResponse,
  validateWorkerResponse
} from "./validation.js";
