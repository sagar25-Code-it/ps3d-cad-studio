import {
  deepFreeze,
  validateCadDocument,
  type CadDocument,
  type ProjectId
} from "../../cad-document-core/src/index.js";
import { storeSha256 } from "./hash.js";
import { keyString } from "./in-memory.js";
import type { CadDocumentMigrationRegistry } from "./migration.js";
import {
  CAD_DOCUMENT_STORE_FORMAT,
  CAD_DOCUMENT_STORE_VERSION,
  CadDocumentStoreError,
  type ApplyDocumentInput,
  type AuditTrail,
  type CadDocumentEvent,
  type CadDocumentSnapshot,
  type CommitReceipt,
  type CreateDocumentInput,
  type DocumentStoragePort,
  type DocumentStoreAuthority,
  type DocumentStoreKey,
  type IdempotencyRecord,
  type MigrateAndCreateInput,
  type MigrationTrace,
  type PersistedProjectState,
  type PreviewDocumentInput,
  type PreviewReceipt,
  type StoreClock,
  type TenantId
} from "./types.js";

const SAFE_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

export function createTenantId(value: string): TenantId {
  if (typeof value !== "string" || !SAFE_ID.test(value)) {
    throw new CadDocumentStoreError("INVALID_KEY", "Tenant IDs must be stable lowercase identifiers.");
  }
  return value as TenantId;
}

export function createDocumentStoreKey(tenantId: string, projectId: ProjectId): DocumentStoreKey {
  const key = { tenantId: createTenantId(tenantId), projectId };
  assertKey(key);
  return deepFreeze(key);
}

export class CadDocumentStore {
  readonly #port: DocumentStoragePort;
  readonly #clock: StoreClock;
  readonly #authority: DocumentStoreAuthority;

  constructor(port: DocumentStoragePort, options: { readonly authority: DocumentStoreAuthority; readonly clock?: StoreClock }) {
    this.#port = port;
    this.#authority = options.authority;
    this.#clock = options.clock ?? { now: () => new Date().toISOString() };
  }

  async create(input: CreateDocumentInput): Promise<CommitReceipt> {
    return this.#createValidated(input, "create", null);
  }

  async migrateAndCreate(
    input: MigrateAndCreateInput,
    registry: CadDocumentMigrationRegistry
  ): Promise<CommitReceipt> {
    assertMutationInput(input);
    const migrated = await registry.migrate(input.document, input.sourceSchemaVersion, input.targetSchemaVersion);
    const document = requireValidDocument(migrated.document);
    return this.#createValidated({
      key: input.key,
      document,
      operationId: input.operationId,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey
    }, "migration", migrated.trace);
  }

  async load(key: DocumentStoreKey, revision?: number): Promise<CadDocument> {
    const state = await this.#verifiedState(key);
    const target = revision === undefined
      ? state.snapshots[state.snapshots.length - 1]
      : state.snapshots.find((snapshot) => snapshot.revision === revision);
    if (target === undefined) throw new CadDocumentStoreError("NOT_FOUND", `Revision ${revision ?? "head"} does not exist.`);
    return immutableClone(target.document);
  }

  async preview(input: PreviewDocumentInput): Promise<PreviewReceipt> {
    assertMutationInput(input);
    const state = await this.#verifiedState(input.key);
    assertCurrentRevision(state, input.expectedRevision);
    const candidate = requireValidDocument(input.document);
    assertCandidate(input.key, candidate, input.expectedRevision, input.operationId);
    const candidateDocumentSha256 = await storeSha256(candidate);
    const baseSnapshot = state.snapshots[state.snapshots.length - 1]!;
    const requestSha256 = await storeSha256({
      kind: "preview",
      key: input.key,
      expectedRevision: input.expectedRevision,
      operationId: input.operationId,
      actorId: input.actorId,
      candidateDocumentSha256
    });
    const payload = {
      receiptVersion: 1 as const,
      kind: "preview" as const,
      tenantId: input.key.tenantId,
      projectId: input.key.projectId,
      operationId: input.operationId,
      actorId: input.actorId,
      idempotencyKey: input.idempotencyKey,
      baseRevision: input.expectedRevision,
      candidateRevision: candidate.revision,
      baseSnapshotSha256: baseSnapshot.snapshotSha256,
      candidateDocumentSha256,
      requestSha256
    };
    const receiptSha256 = await storeSha256(payload);
    const authorization = await this.#authority.issue("preview-receipt", receiptSha256);
    return deepFreeze({ ...payload, receiptSha256, authorization });
  }

  async apply(input: ApplyDocumentInput): Promise<CommitReceipt> {
    assertMutationInput(input);
    if (!isPreviewReceipt(input.previewReceipt)) {
      throw new CadDocumentStoreError("INVALID_PREVIEW", "The preview receipt envelope is malformed.");
    }
    const candidate = requireValidDocument(input.document);
    const candidateDocumentSha256 = await storeSha256(candidate);
    const requestSha256 = await storeSha256({
      kind: "apply",
      key: input.key,
      expectedRevision: input.expectedRevision,
      operationId: input.operationId,
      actorId: input.actorId,
      candidateDocumentSha256,
      previewReceiptSha256: input.previewReceipt.receiptSha256
    });
    let state = await this.#verifiedState(input.key);
    const replay = idempotentReplay(state, input.idempotencyKey, requestSha256);
    if (replay !== null) return replay;
    assertCurrentRevision(state, input.expectedRevision);
    assertCandidate(input.key, candidate, input.expectedRevision, input.operationId);
    await verifyPreview(input, state, candidateDocumentSha256, this.#authority);
    const next = await appendCommit(
      state,
      candidate,
      input.operationId,
      input.actorId,
      input.idempotencyKey,
      requestSha256,
      "apply",
      null,
      input.previewReceipt.receiptSha256,
      this.#clock.now(),
      this.#authority
    );
    if (await this.#port.compareAndSwap(input.key, state.storageVersion, next.state)) return next.receipt;
    state = await this.#verifiedState(input.key);
    const concurrentReplay = idempotentReplay(state, input.idempotencyKey, requestSha256);
    if (concurrentReplay !== null) return concurrentReplay;
    throw new CadDocumentStoreError("STORAGE_CONFLICT", "The document changed during atomic apply; preview the new head revision.");
  }

  async audit(key: DocumentStoreKey): Promise<AuditTrail> {
    const state = await this.#verifiedState(key);
    return deepFreeze({
      key: immutableClone(state.key),
      headRevision: state.headRevision,
      snapshots: immutableClone(state.snapshots),
      events: immutableClone(state.events),
      verified: true as const,
      integrity: "externally-authorized" as const,
      rollbackProtection: "external-anchor-required" as const,
      stateSha256: await storeSha256(state)
    });
  }

  async #createValidated(
    input: CreateDocumentInput,
    kind: "create" | "migration",
    migration: MigrationTrace | null
  ): Promise<CommitReceipt> {
    assertMutationInput(input);
    const document = requireValidDocument(input.document);
    if (document.project.id !== input.key.projectId) throw new CadDocumentStoreError("INVALID_KEY", "The document project does not match the storage key.");
    assertInitialDocument(document, input.operationId);
    const documentSha256 = await storeSha256(document);
    const requestSha256 = await storeSha256({
      kind,
      key: input.key,
      operationId: input.operationId,
      actorId: input.actorId,
      documentSha256,
      migration
    });
    let existing = await this.#port.read(input.key);
    if (existing !== null) {
      existing = await verifyState(existing, input.key, this.#authority);
      const replay = idempotentReplay(existing, input.idempotencyKey, requestSha256);
      if (replay !== null) return replay;
      throw new CadDocumentStoreError("ALREADY_EXISTS", "The tenant/project document already exists.");
    }
    const initial: PersistedProjectState = {
      format: CAD_DOCUMENT_STORE_FORMAT,
      storeVersion: CAD_DOCUMENT_STORE_VERSION,
      storageVersion: 0,
      key: input.key,
      headRevision: document.revision,
      snapshots: [],
      events: [],
      idempotency: [],
      headAuthorization: null
    };
    const next = await appendCommit(
      initial,
      document,
      input.operationId,
      input.actorId,
      input.idempotencyKey,
      requestSha256,
      kind,
      migration,
      null,
      this.#clock.now(),
      this.#authority
    );
    if (await this.#port.compareAndSwap(input.key, null, next.state)) return next.receipt;
    existing = await this.#verifiedState(input.key);
    const replay = idempotentReplay(existing, input.idempotencyKey, requestSha256);
    if (replay !== null) return replay;
    throw new CadDocumentStoreError("STORAGE_CONFLICT", "Another writer created the tenant/project document first.");
  }

  async #verifiedState(key: DocumentStoreKey): Promise<PersistedProjectState> {
    assertKey(key);
    const state = await this.#port.read(key);
    if (state === null) throw new CadDocumentStoreError("NOT_FOUND", "The tenant/project document does not exist.");
    return verifyState(state, key, this.#authority);
  }
}

async function appendCommit(
  state: PersistedProjectState,
  document: CadDocument,
  operationId: string,
  actorId: string,
  idempotencyKey: string,
  requestSha256: string,
  kind: "create" | "migration" | "apply",
  migration: MigrationTrace | null,
  previewReceiptSha256: string | null,
  issuedAt: string,
  authority: DocumentStoreAuthority
): Promise<{ readonly state: PersistedProjectState; readonly receipt: CommitReceipt }> {
  const documentSha256 = await storeSha256(document);
  const previousSnapshotSha256 = state.snapshots[state.snapshots.length - 1]?.snapshotSha256 ?? null;
  const snapshotPayload = {
    tenantId: state.key.tenantId,
    projectId: state.key.projectId,
    revision: document.revision,
    schemaVersion: document.schemaVersion,
    operationId,
    createdAt: issuedAt,
    document,
    documentSha256,
    previousSnapshotSha256,
    migration
  };
  const snapshot: CadDocumentSnapshot = deepFreeze({ ...snapshotPayload, snapshotSha256: await storeSha256(snapshotPayload) });
  const eventPayload = {
    sequence: state.events.length + 1,
    kind,
    tenantId: state.key.tenantId,
    projectId: state.key.projectId,
    revision: document.revision,
    operationId,
    actorId,
    idempotencyKey,
    requestSha256,
    snapshotSha256: snapshot.snapshotSha256,
    previousEventSha256: state.events[state.events.length - 1]?.eventSha256 ?? null,
    occurredAt: issuedAt,
    migration
  };
  const event: CadDocumentEvent = deepFreeze({ ...eventPayload, eventSha256: await storeSha256(eventPayload) });
  const receiptPayload = {
    receiptVersion: 1 as const,
    kind,
    status: "applied" as const,
    tenantId: state.key.tenantId,
    projectId: state.key.projectId,
    operationId,
    actorId,
    idempotencyKey,
    baseRevision: state.snapshots.length === 0 ? null : state.headRevision,
    resultingRevision: document.revision,
    requestSha256,
    documentSha256,
    snapshotSha256: snapshot.snapshotSha256,
    eventSha256: event.eventSha256,
    previewReceiptSha256,
    issuedAt
  };
  const receiptSha256 = await storeSha256(receiptPayload);
  const receipt: CommitReceipt = deepFreeze({
    ...receiptPayload,
    receiptSha256,
    authorization: await authority.issue("commit-receipt", receiptSha256)
  });
  const idempotencyRecord: IdempotencyRecord = { idempotencyKey, requestSha256, receipt };
  const stateWithoutAuthorization = {
    ...state,
    storageVersion: state.storageVersion + 1,
    headRevision: document.revision,
    snapshots: [...state.snapshots, snapshot],
    events: [...state.events, event],
    idempotency: [...state.idempotency, idempotencyRecord],
    headAuthorization: null
  };
  const headDigest = await storeSha256(stateWithoutAuthorization);
  const nextState: PersistedProjectState = {
    ...stateWithoutAuthorization,
    headAuthorization: await authority.issue("state-head", headDigest)
  };
  return deepFreeze({ state: nextState, receipt });
}

async function verifyPreview(
  input: ApplyDocumentInput,
  state: PersistedProjectState,
  candidateSha256: string,
  authority: DocumentStoreAuthority
): Promise<void> {
  const untrustedReceipt: unknown = input.previewReceipt;
  if (!isPreviewReceipt(untrustedReceipt)) {
    throw new CadDocumentStoreError("INVALID_PREVIEW", "The preview receipt envelope is malformed.");
  }
  const receipt = untrustedReceipt;
  const { receiptSha256, authorization, ...payload } = receipt;
  const baseSnapshot = state.snapshots[state.snapshots.length - 1]!;
  const expectedRequestSha256 = await storeSha256({
    kind: "preview",
    key: input.key,
    expectedRevision: input.expectedRevision,
    operationId: input.operationId,
    actorId: input.actorId,
    candidateDocumentSha256: candidateSha256
  });
  let authorized = false;
  try {
    authorized = await authority.verify("preview-receipt", receiptSha256, authorization);
  } catch {
    authorized = false;
  }
  if (await storeSha256(payload) !== receiptSha256
    || !authorized
    || receipt.tenantId !== input.key.tenantId
    || receipt.projectId !== input.key.projectId
    || receipt.operationId !== input.operationId
    || receipt.actorId !== input.actorId
    || receipt.baseRevision !== input.expectedRevision
    || receipt.candidateRevision !== input.document.revision
    || receipt.baseSnapshotSha256 !== baseSnapshot.snapshotSha256
    || receipt.candidateDocumentSha256 !== candidateSha256
    || receipt.requestSha256 !== expectedRequestSha256) {
    throw new CadDocumentStoreError("INVALID_PREVIEW", "Apply is not bound to the exact live base and previewed candidate.");
  }
}

async function verifyState(
  state: PersistedProjectState,
  key: DocumentStoreKey,
  authority: DocumentStoreAuthority
): Promise<PersistedProjectState> {
  try {
    if (state.format !== CAD_DOCUMENT_STORE_FORMAT
      || state.storeVersion !== CAD_DOCUMENT_STORE_VERSION
      || keyString(state.key) !== keyString(key)
      || state.storageVersion !== state.snapshots.length
      || state.snapshots.length !== state.events.length
      || state.snapshots.length !== state.idempotency.length
      || state.snapshots.length === 0
      || state.headRevision !== state.snapshots[state.snapshots.length - 1]!.revision) throw new Error("Invalid state envelope.");
    const { headAuthorization, ...statePayload } = state;
    const stateWithEmptyAuthorization = { ...statePayload, headAuthorization: null };
    if (headAuthorization === null || !await authority.verify(
      "state-head", await storeSha256(stateWithEmptyAuthorization), headAuthorization
    )) throw new Error("The persisted chain head is not authorized by the external integrity authority.");
    let previousSnapshot: string | null = null;
    let previousEvent: string | null = null;
    const idempotencyKeys = new Set<string>();
    for (let index = 0; index < state.snapshots.length; index += 1) {
      const snapshot = state.snapshots[index]!;
      const event = state.events[index]!;
      const record = state.idempotency[index]!;
      const { snapshotSha256, ...snapshotPayload } = snapshot;
      const { eventSha256, ...eventPayload } = event;
      const { receiptSha256, authorization, ...receiptPayload } = record.receipt;
      const validation = validateCadDocument(snapshot.document);
      const expectedBaseRevision = index === 0 ? null : state.snapshots[index - 1]!.revision;
      const migrationsMatch = await storeSha256(snapshot.migration) === await storeSha256(event.migration);
      const isMigration = event.kind === "migration";
      const hasMigration = snapshot.migration !== null;
      const requiresPreview = event.kind === "apply";
      if (!validation.ok
        || snapshot.tenantId !== key.tenantId
        || snapshot.projectId !== key.projectId
        || snapshot.revision !== index
        || snapshot.revision !== snapshot.document.revision
        || snapshot.schemaVersion !== snapshot.document.schemaVersion
        || snapshot.operationId !== snapshot.document.lastOperationId
        || snapshot.documentSha256 !== await storeSha256(snapshot.document)
        || snapshot.previousSnapshotSha256 !== previousSnapshot
        || snapshotSha256 !== await storeSha256(snapshotPayload)
        || event.sequence !== index + 1
        || event.tenantId !== key.tenantId
        || event.projectId !== key.projectId
        || event.revision !== snapshot.revision
        || event.operationId !== snapshot.operationId
        || event.occurredAt !== snapshot.createdAt
        || !migrationsMatch
        || isMigration !== hasMigration
        || event.snapshotSha256 !== snapshotSha256
        || event.previousEventSha256 !== previousEvent
        || eventSha256 !== await storeSha256(eventPayload)
        || record.idempotencyKey !== event.idempotencyKey
        || record.requestSha256 !== event.requestSha256
        || idempotencyKeys.has(record.idempotencyKey)
        || record.receipt.receiptVersion !== 1
        || record.receipt.status !== "applied"
        || record.receipt.kind !== event.kind
        || receiptSha256 !== await storeSha256(receiptPayload)
        || !await authority.verify("commit-receipt", receiptSha256, authorization)
        || record.receipt.tenantId !== key.tenantId
        || record.receipt.projectId !== key.projectId
        || record.receipt.operationId !== event.operationId
        || record.receipt.actorId !== event.actorId
        || record.receipt.idempotencyKey !== record.idempotencyKey
        || record.receipt.baseRevision !== expectedBaseRevision
        || record.receipt.requestSha256 !== record.requestSha256
        || record.receipt.resultingRevision !== snapshot.revision
        || record.receipt.documentSha256 !== snapshot.documentSha256
        || record.receipt.snapshotSha256 !== snapshotSha256
        || record.receipt.eventSha256 !== eventSha256
        || record.receipt.issuedAt !== event.occurredAt
        || requiresPreview !== (record.receipt.previewReceiptSha256 !== null)) {
        throw new Error(`Integrity failure at event ${index + 1}.`);
      }
      idempotencyKeys.add(record.idempotencyKey);
      previousSnapshot = snapshotSha256;
      previousEvent = eventSha256;
    }
    return immutableClone(state);
  } catch (error) {
    throw new CadDocumentStoreError("TAMPER_DETECTED", error instanceof Error ? error.message : "Stored state failed integrity verification.");
  }
}

function idempotentReplay(state: PersistedProjectState, key: string, requestSha256: string): CommitReceipt | null {
  const record = state.idempotency.find((candidate) => candidate.idempotencyKey === key);
  if (record === undefined) return null;
  if (record.requestSha256 !== requestSha256) throw new CadDocumentStoreError("IDEMPOTENCY_CONFLICT", "Idempotency key was reused with different input.");
  return record.receipt;
}

function requireValidDocument(input: unknown): CadDocument {
  const result = validateCadDocument(input);
  if (!result.ok) throw new CadDocumentStoreError("INVALID_DOCUMENT", result.diagnostics.map((entry) => entry.message).join(" "));
  return result.value;
}

function assertCurrentRevision(state: PersistedProjectState, expectedRevision: number): void {
  if (state.headRevision !== expectedRevision) throw new CadDocumentStoreError("REVISION_CONFLICT", `Expected revision ${expectedRevision}, found ${state.headRevision}.`);
}

function assertCandidate(key: DocumentStoreKey, candidate: CadDocument, expectedRevision: number, operationId: string): void {
  if (candidate.project.id !== key.projectId
    || candidate.revision !== expectedRevision + 1
    || candidate.parentRevision !== expectedRevision
    || candidate.lastOperationId !== operationId) {
    throw new CadDocumentStoreError("INVALID_DOCUMENT", "Candidate must be the next canonical revision for the keyed project and operation.");
  }
}

function assertInitialDocument(document: CadDocument, operationId: string): void {
  if (document.revision !== 0 || document.parentRevision !== null || document.lastOperationId !== operationId) {
    throw new CadDocumentStoreError(
      "INVALID_DOCUMENT",
      "Initial creation requires revision 0, a null parent revision, and a matching canonical operation ID."
    );
  }
}

function assertMutationInput(input: Pick<CreateDocumentInput, "key" | "operationId" | "actorId" | "idempotencyKey">): void {
  if (typeof input !== "object" || input === null) {
    throw new CadDocumentStoreError("INVALID_KEY", "A mutation requires keyed operation metadata.");
  }
  assertKey(input.key);
  for (const [label, value] of [["operation", input.operationId], ["actor", input.actorId], ["idempotency", input.idempotencyKey]] as const) {
    if (typeof value !== "string" || !SAFE_ID.test(value)) {
      throw new CadDocumentStoreError("INVALID_KEY", `${label} ID must be a stable lowercase identifier.`);
    }
  }
}

function assertKey(key: DocumentStoreKey): void {
  if (typeof key !== "object" || key === null
    || typeof key.tenantId !== "string" || !SAFE_ID.test(key.tenantId)
    || typeof key.projectId !== "string" || !/^project:[a-z0-9][a-z0-9._-]{0,95}$/u.test(key.projectId)) {
    throw new CadDocumentStoreError("INVALID_KEY", "A store key requires valid tenant and canonical project IDs.");
  }
}

function isPreviewReceipt(value: unknown): value is PreviewReceipt {
  if (typeof value !== "object" || value === null) return false;
  const receipt = value as Readonly<Record<string, unknown>>;
  const authorization = receipt.authorization;
  return receipt.receiptVersion === 1
    && receipt.kind === "preview"
    && typeof receipt.tenantId === "string"
    && typeof receipt.projectId === "string"
    && typeof receipt.operationId === "string"
    && typeof receipt.actorId === "string"
    && typeof receipt.idempotencyKey === "string"
    && Number.isSafeInteger(receipt.baseRevision)
    && Number.isSafeInteger(receipt.candidateRevision)
    && typeof receipt.baseSnapshotSha256 === "string" && SHA256.test(receipt.baseSnapshotSha256)
    && typeof receipt.candidateDocumentSha256 === "string" && SHA256.test(receipt.candidateDocumentSha256)
    && typeof receipt.requestSha256 === "string" && SHA256.test(receipt.requestSha256)
    && typeof receipt.receiptSha256 === "string" && SHA256.test(receipt.receiptSha256)
    && typeof authorization === "object" && authorization !== null
    && typeof (authorization as Readonly<Record<string, unknown>>).scheme === "string"
    && typeof (authorization as Readonly<Record<string, unknown>>).keyId === "string"
    && typeof (authorization as Readonly<Record<string, unknown>>).value === "string";
}

function immutableClone<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
}
