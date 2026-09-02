import assert from "node:assert/strict";
import test from "node:test";
import {
  createCadId,
  createEmptyCadDocument,
  reviseCadDocument,
  type CadDocument,
  type CadProject
} from "../../cad-document-core/src/index.js";
import {
  CadDocumentMigrationRegistry,
  CadDocumentStore,
  CadDocumentStoreError,
  InMemoryDocumentStoragePort,
  createDocumentStoreKey,
  storeSha256,
  type DocumentStoreAuthority,
  type PersistedProjectState,
  type StoreAuthorization,
  type StoreAuthorizationScope
} from "../src/index.js";

class TestDocumentStoreAuthority implements DocumentStoreAuthority {
  readonly #material = "fixture-authority-material";

  async issue(scope: StoreAuthorizationScope, digest: string): Promise<StoreAuthorization> {
    return {
      scheme: "test-keyed-sha256",
      keyId: "test-authority",
      value: await storeSha256({ scope, digest, material: this.#material })
    };
  }

  async verify(scope: StoreAuthorizationScope, digest: string, authorization: StoreAuthorization): Promise<boolean> {
    const expected = await this.issue(scope, digest);
    return authorization.scheme === expected.scheme
      && authorization.keyId === expected.keyId
      && authorization.value === expected.value;
  }
}

const PROJECT_ID = createCadId("project", "store-acceptance");
const KEY = createDocumentStoreKey("tenant:acceptance", PROJECT_ID);
const CLOCK = { now: () => "2026-09-02T08:00:00.000Z" };
const AUTHORITY = new TestDocumentStoreAuthority();

test("creates and loads an immutable canonical snapshot with a verifiable audit record", async () => {
  const { store } = setup();
  const document = baseDocument();
  const receipt = await create(store, document);
  const loaded = await store.load(KEY);
  const audit = await store.audit(KEY);

  assert.equal(receipt.kind, "create");
  assert.match(receipt.receiptSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(loaded, document);
  assert.ok(Object.isFrozen(loaded));
  assert.equal(audit.verified, true);
  assert.equal(audit.integrity, "externally-authorized");
  assert.equal(audit.rollbackProtection, "external-anchor-required");
  assert.equal(audit.snapshots.length, 1);
  assert.equal(audit.events.length, 1);
  assert.equal(audit.events[0]!.snapshotSha256, audit.snapshots[0]!.snapshotSha256);
});

test("rejects optimistic-concurrency conflicts before candidate persistence", async () => {
  const { store } = setup();
  const base = baseDocument();
  await create(store, base);
  const candidate = changedDocument(base, "operation:rename-project", "Changed");

  await assert.rejects(
    store.preview({
      key: KEY,
      document: candidate,
      expectedRevision: base.revision + 1,
      operationId: "operation:rename-project",
      actorId: "actor:engineer",
      idempotencyKey: "idem:conflicting-preview"
    }),
    hasCode("REVISION_CONFLICT")
  );
  assert.equal((await store.audit(KEY)).snapshots.length, 1);
});

test("replays an identical idempotent create and rejects divergent key reuse", async () => {
  const { store } = setup();
  const document = baseDocument();
  const first = await create(store, document);
  const replay = await create(store, document);
  assert.equal(replay.receiptSha256, first.receiptSha256);
  assert.equal((await store.audit(KEY)).events.length, 1);

  await assert.rejects(
    store.create({
      key: KEY,
      document,
      operationId: document.lastOperationId,
      actorId: "actor:different-engineer",
      idempotencyKey: "idem:create-store"
    }),
    hasCode("IDEMPOTENCY_CONFLICT")
  );
});

test("detects a tampered persisted snapshot before load or audit", async () => {
  const { store, port } = setup();
  await create(store, baseDocument());
  const exported = port.exportState(KEY);
  assert.ok(exported !== null);
  const tampered = structuredClone(exported);
  const mutable = tampered as unknown as { snapshots: Array<{ document: { project: { name: string } } }> };
  mutable.snapshots[0]!.document.project.name = "Tampered without a new hash";
  const untrustedPort = new InMemoryDocumentStoragePort([tampered as PersistedProjectState]);
  const untrustedStore = new CadDocumentStore(untrustedPort, { authority: AUTHORITY, clock: CLOCK });

  await assert.rejects(untrustedStore.load(KEY), hasCode("TAMPER_DETECTED"));
});

test("runs only an explicitly registered schema migration before create", async () => {
  const { store } = setup();
  const current = baseDocument();
  const legacy = structuredClone(current) as unknown as { schemaVersion: number };
  legacy.schemaVersion = 0;
  const registry = new CadDocumentMigrationRegistry().register({
    id: "migration:canonical-0-to-1",
    fromSchemaVersion: 0,
    toSchemaVersion: 1,
    migrate(input) {
      return { ...(input as object), schemaVersion: 1, lastOperationId: "operation:migrate-store" };
    }
  });
  const receipt = await store.migrateAndCreate({
    key: KEY,
    document: legacy,
    sourceSchemaVersion: 0,
    targetSchemaVersion: 1,
    operationId: "operation:migrate-store",
    actorId: "actor:migration-service",
    idempotencyKey: "idem:migrate-store"
  }, registry);
  const audit = await store.audit(KEY);

  assert.equal(receipt.kind, "migration");
  assert.equal(audit.events[0]!.kind, "migration");
  assert.deepEqual(audit.events[0]!.migration?.appliedSteps, ["migration:canonical-0-to-1"]);
  assert.equal((await store.load(KEY)).schemaVersion, 1);
});

test("preview is idempotent and leaves every durable byte unchanged", async () => {
  const { store, port } = setup();
  const base = baseDocument();
  await create(store, base);
  const candidate = changedDocument(base, "operation:rename-project", "Previewed");
  const before = port.exportState(KEY)!;
  const input = {
    key: KEY,
    document: candidate,
    expectedRevision: base.revision,
    operationId: "operation:rename-project",
    actorId: "actor:engineer",
    idempotencyKey: "idem:preview-rename"
  } as const;
  const first = await store.preview(input);
  const replay = await store.preview(input);
  const after = port.exportState(KEY)!;

  assert.equal(first.receiptSha256, replay.receiptSha256);
  assert.equal(first.candidateDocumentSha256, await storeSha256(candidate));
  assert.equal(await storeSha256(after), await storeSha256(before));
  assert.equal((await store.load(KEY)).project.name, base.project.name);
});

test("issues the same preview receipt across store instances", async () => {
  const port = new InMemoryDocumentStoragePort();
  const firstStore = new CadDocumentStore(port, { authority: AUTHORITY, clock: CLOCK });
  const secondStore = new CadDocumentStore(port, {
    authority: AUTHORITY,
    clock: { now: () => "2030-01-01T00:00:00.000Z" }
  });
  const base = baseDocument();
  await create(firstStore, base);
  const candidate = changedDocument(base, "operation:cross-node-preview", "Cross-node candidate");
  const input = {
    key: KEY,
    document: candidate,
    expectedRevision: base.revision,
    operationId: "operation:cross-node-preview",
    actorId: "actor:engineer",
    idempotencyKey: "idem:cross-node-preview"
  } as const;

  const [first, second] = await Promise.all([firstStore.preview(input), secondStore.preview(input)]);
  assert.deepEqual(second, first);
  assert.equal(first.receiptSha256, second.receiptSha256);
});

test("apply atomically appends the exact previewed snapshot and event", async () => {
  const { store } = setup();
  const base = baseDocument();
  await create(store, base);
  const candidate = changedDocument(base, "operation:rename-project", "Applied");
  const preview = await store.preview({
    key: KEY,
    document: candidate,
    expectedRevision: base.revision,
    operationId: "operation:rename-project",
    actorId: "actor:engineer",
    idempotencyKey: "idem:preview-apply"
  });
  const applied = await store.apply({
    key: KEY,
    document: candidate,
    expectedRevision: base.revision,
    operationId: "operation:rename-project",
    actorId: "actor:engineer",
    idempotencyKey: "idem:apply-rename",
    previewReceipt: preview
  });
  const audit = await store.audit(KEY);

  assert.equal(applied.kind, "apply");
  assert.equal(applied.previewReceiptSha256, preview.receiptSha256);
  assert.equal((await store.load(KEY)).project.name, "Applied");
  assert.equal(audit.snapshots.length, 2);
  assert.equal(audit.events.length, 2);
  assert.equal(audit.events[1]!.snapshotSha256, audit.snapshots[1]!.snapshotSha256);
  assert.equal(audit.snapshots[1]!.previousSnapshotSha256, audit.snapshots[0]!.snapshotSha256);
  assert.equal(audit.events[1]!.previousEventSha256, audit.events[0]!.eventSha256);

  await assert.rejects(
    store.apply({
      key: KEY,
      document: candidate,
      expectedRevision: base.revision,
      operationId: "operation:rename-project",
      actorId: "actor:engineer",
      idempotencyKey: "idem:stale-apply",
      previewReceipt: preview
    }),
    hasCode("REVISION_CONFLICT")
  );
  assert.equal((await store.audit(KEY)).events.length, 2);
});

test("rejects a preview receipt that was not issued by the external authority", async () => {
  const { store } = setup();
  const base = baseDocument();
  await create(store, base);
  const candidate = changedDocument(base, "operation:rename-project", "Candidate");
  const preview = await store.preview({
    key: KEY,
    document: candidate,
    expectedRevision: base.revision,
    operationId: "operation:rename-project",
    actorId: "actor:engineer",
    idempotencyKey: "idem:preview-authorized"
  });
  const forged = structuredClone(preview) as { authorization: StoreAuthorization };
  forged.authorization = { ...forged.authorization, value: "0".repeat(64) };

  await assert.rejects(store.apply({
    key: KEY,
    document: candidate,
    expectedRevision: base.revision,
    operationId: "operation:rename-project",
    actorId: "actor:engineer",
    idempotencyKey: "idem:apply-forged-preview",
    previewReceipt: forged as typeof preview
  }), hasCode("INVALID_PREVIEW"));
});

test("rejects malformed runtime preview input with a domain error", async () => {
  const { store } = setup();
  const base = baseDocument();
  await create(store, base);
  const candidate = changedDocument(base, "operation:malformed-preview", "Candidate");

  await assert.rejects(store.apply({
    key: KEY,
    document: candidate,
    expectedRevision: base.revision,
    operationId: "operation:malformed-preview",
    actorId: "actor:engineer",
    idempotencyKey: "idem:malformed-preview",
    previewReceipt: null as unknown as Parameters<typeof store.apply>[0]["previewReceipt"]
  }), hasCode("INVALID_PREVIEW"));
});

test("rejects a fully rehashed storage rewrite without a new state-head authorization", async () => {
  const { store, port } = setup();
  await create(store, baseDocument());
  const exported = port.exportState(KEY)!;
  const rewritten = structuredClone(exported) as unknown as MutablePersistedState;
  const snapshot = rewritten.snapshots[0]!;
  snapshot.document.project.name = "Rewritten and rehashed";
  snapshot.documentSha256 = await storeSha256(snapshot.document);
  const { snapshotSha256: _oldSnapshotHash, ...snapshotPayload } = snapshot;
  snapshot.snapshotSha256 = await storeSha256(snapshotPayload);
  const event = rewritten.events[0]!;
  event.snapshotSha256 = snapshot.snapshotSha256;
  const { eventSha256: _oldEventHash, ...eventPayload } = event;
  event.eventSha256 = await storeSha256(eventPayload);
  const receipt = rewritten.idempotency[0]!.receipt;
  receipt.documentSha256 = snapshot.documentSha256;
  receipt.snapshotSha256 = snapshot.snapshotSha256;
  receipt.eventSha256 = event.eventSha256;
  const { receiptSha256: _oldReceiptHash, authorization: _authorization, ...receiptPayload } = receipt;
  receipt.receiptSha256 = await storeSha256(receiptPayload);

  const untrustedPort = new InMemoryDocumentStoragePort([rewritten as unknown as PersistedProjectState]);
  const untrustedStore = new CadDocumentStore(untrustedPort, { authority: AUTHORITY, clock: CLOCK });
  await assert.rejects(untrustedStore.load(KEY), hasCode("TAMPER_DETECTED"));
});

test("requires a canonical revision-zero document whose operation matches create", async () => {
  const { store } = setup();
  const base = baseDocument();
  await assert.rejects(store.create({
    key: KEY,
    document: base,
    operationId: "operation:different-create",
    actorId: "actor:engineer",
    idempotencyKey: "idem:invalid-create"
  }), hasCode("INVALID_DOCUMENT"));

  const revisionOne = changedDocument(base, "operation:premature-revision", "Revision one");
  await assert.rejects(store.create({
    key: KEY,
    document: revisionOne,
    operationId: revisionOne.lastOperationId,
    actorId: "actor:engineer",
    idempotencyKey: "idem:revision-one-create"
  }), hasCode("INVALID_DOCUMENT"));
});

test("binds migration declarations to the embedded source and every step output", async () => {
  const registry = new CadDocumentMigrationRegistry().register({
    id: "migration:invalid-output",
    fromSchemaVersion: 0,
    toSchemaVersion: 1,
    migrate(input) { return { ...(input as object), schemaVersion: 0 }; }
  });
  await assert.rejects(registry.migrate(baseDocument(), 0, 1), hasCode("MIGRATION_INVALID"));
  const legacy = { ...baseDocument(), schemaVersion: 0 };
  await assert.rejects(registry.migrate(legacy, 0, 1), hasCode("MIGRATION_INVALID"));
  await assert.rejects(registry.migrate(legacy, Number.NaN, 1), hasCode("MIGRATION_INVALID"));
});

function setup() {
  const port = new InMemoryDocumentStoragePort();
  const store = new CadDocumentStore(port, { authority: AUTHORITY, clock: CLOCK });
  return { port, store };
}

function baseDocument(): CadDocument {
  return createEmptyCadDocument({
    projectId: PROJECT_ID,
    rootComponentId: createCadId("component", "root"),
    rootOriginId: createCadId("origin", "root"),
    name: "Stored design",
    description: "Persistence acceptance fixture",
    applicationVersion: "acceptance",
    operationId: "operation:create-base",
    units: { length: "mm", angle: "deg", mass: "kg" }
  });
}

function changedDocument(document: CadDocument, operationId: string, name: string): CadDocument {
  return reviseCadDocument(document, operationId, (project: CadProject) => ({ ...project, name }));
}

function create(store: CadDocumentStore, document: CadDocument) {
  return store.create({
    key: KEY,
    document,
    operationId: document.lastOperationId,
    actorId: "actor:engineer",
    idempotencyKey: "idem:create-store"
  });
}

type MutablePersistedState = {
  snapshots: Array<{
    document: { project: { name: string } };
    documentSha256: string;
    snapshotSha256: string;
    [key: string]: unknown;
  }>;
  events: Array<{
    snapshotSha256: string;
    eventSha256: string;
    [key: string]: unknown;
  }>;
  idempotency: Array<{
    receipt: {
      documentSha256: string;
      snapshotSha256: string;
      eventSha256: string;
      receiptSha256: string;
      authorization: StoreAuthorization;
      [key: string]: unknown;
    };
  }>;
};

function hasCode(code: CadDocumentStoreError["code"]) {
  return (error: unknown) => error instanceof CadDocumentStoreError && error.code === code;
}
