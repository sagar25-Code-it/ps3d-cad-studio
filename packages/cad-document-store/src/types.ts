import type { CadDocument, ProjectId } from "../../cad-document-core/src/index.js";

export const CAD_DOCUMENT_STORE_FORMAT = "ps3d-cad-document-store" as const;
export const CAD_DOCUMENT_STORE_VERSION = 1 as const;

export type TenantId = string & { readonly __tenantId: unique symbol };

export interface DocumentStoreKey {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

export type StoreErrorCode =
  | "INVALID_KEY"
  | "NOT_FOUND"
  | "ALREADY_EXISTS"
  | "INVALID_DOCUMENT"
  | "REVISION_CONFLICT"
  | "IDEMPOTENCY_CONFLICT"
  | "INVALID_PREVIEW"
  | "TAMPER_DETECTED"
  | "MIGRATION_INVALID"
  | "MIGRATION_MISSING"
  | "STORAGE_CONFLICT";

export class CadDocumentStoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "CadDocumentStoreError";
    this.code = code;
  }
}

export interface MigrationTrace {
  readonly sourceSchemaVersion: number;
  readonly targetSchemaVersion: number;
  readonly appliedSteps: readonly string[];
}

export interface CadDocumentSnapshot {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly schemaVersion: number;
  readonly operationId: string;
  readonly createdAt: string;
  readonly document: CadDocument;
  readonly documentSha256: string;
  readonly previousSnapshotSha256: string | null;
  readonly migration: MigrationTrace | null;
  readonly snapshotSha256: string;
}

export interface CadDocumentEvent {
  readonly sequence: number;
  readonly kind: "create" | "migration" | "apply";
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly revision: number;
  readonly operationId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly snapshotSha256: string;
  readonly previousEventSha256: string | null;
  readonly occurredAt: string;
  readonly migration: MigrationTrace | null;
  readonly eventSha256: string;
}

export interface PreviewReceipt {
  readonly receiptVersion: 1;
  readonly kind: "preview";
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly operationId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly baseRevision: number;
  readonly candidateRevision: number;
  readonly baseSnapshotSha256: string;
  readonly candidateDocumentSha256: string;
  readonly requestSha256: string;
  readonly receiptSha256: string;
  readonly authorization: StoreAuthorization;
}

export interface CommitReceipt {
  readonly receiptVersion: 1;
  readonly kind: "create" | "migration" | "apply";
  readonly status: "applied";
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
  readonly operationId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
  readonly baseRevision: number | null;
  readonly resultingRevision: number;
  readonly requestSha256: string;
  readonly documentSha256: string;
  readonly snapshotSha256: string;
  readonly eventSha256: string;
  readonly previewReceiptSha256: string | null;
  readonly issuedAt: string;
  readonly receiptSha256: string;
  readonly authorization: StoreAuthorization;
}

export type StoreAuthorizationScope = "preview-receipt" | "commit-receipt" | "state-head";

/** Opaque authorization produced by a key or signing service outside document storage. */
export interface StoreAuthorization {
  readonly scheme: string;
  readonly keyId: string;
  readonly value: string;
}

/**
 * Security boundary supplied by the host. `issue` must be deterministic for
 * the same scope and digest so preview retries work across application nodes.
 * Signing/HMAC keys must not be stored in DocumentStoragePort.
 */
export interface DocumentStoreAuthority {
  issue(scope: StoreAuthorizationScope, digest: string): Promise<StoreAuthorization>;
  verify(scope: StoreAuthorizationScope, digest: string, authorization: StoreAuthorization): Promise<boolean>;
}

export interface IdempotencyRecord {
  readonly idempotencyKey: string;
  readonly requestSha256: string;
  readonly receipt: CommitReceipt;
}

export interface PersistedProjectState {
  readonly format: typeof CAD_DOCUMENT_STORE_FORMAT;
  readonly storeVersion: typeof CAD_DOCUMENT_STORE_VERSION;
  readonly storageVersion: number;
  readonly key: DocumentStoreKey;
  readonly headRevision: number;
  readonly snapshots: readonly CadDocumentSnapshot[];
  readonly events: readonly CadDocumentEvent[];
  readonly idempotency: readonly IdempotencyRecord[];
  readonly headAuthorization: StoreAuthorization | null;
}

export interface DocumentStoragePort {
  readonly kind: "memory" | "indexeddb" | "server";
  read(key: DocumentStoreKey): Promise<PersistedProjectState | null>;
  compareAndSwap(
    key: DocumentStoreKey,
    expectedStorageVersion: number | null,
    next: PersistedProjectState
  ): Promise<boolean>;
}

/** Contract only. A browser host supplies the actual IndexedDB transaction. */
export interface IndexedDbDocumentStoragePort extends DocumentStoragePort {
  readonly kind: "indexeddb";
  readonly databaseName: string;
}

/** Contract only. A server host supplies durable tenant-isolated storage. */
export interface ServerDocumentStoragePort extends DocumentStoragePort {
  readonly kind: "server";
  readonly storageNamespace: string;
}

export interface StoreClock {
  now(): string;
}

export interface CreateDocumentInput {
  readonly key: DocumentStoreKey;
  readonly document: CadDocument;
  readonly operationId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
}

export interface PreviewDocumentInput extends CreateDocumentInput {
  readonly expectedRevision: number;
}

export interface ApplyDocumentInput extends PreviewDocumentInput {
  readonly previewReceipt: PreviewReceipt;
}

export interface MigrateAndCreateInput {
  readonly key: DocumentStoreKey;
  readonly document: unknown;
  readonly sourceSchemaVersion: number;
  readonly targetSchemaVersion: number;
  readonly operationId: string;
  readonly actorId: string;
  readonly idempotencyKey: string;
}

export interface AuditTrail {
  readonly key: DocumentStoreKey;
  readonly headRevision: number;
  readonly snapshots: readonly CadDocumentSnapshot[];
  readonly events: readonly CadDocumentEvent[];
  readonly verified: true;
  readonly integrity: "externally-authorized";
  readonly rollbackProtection: "external-anchor-required";
  readonly stateSha256: string;
}
