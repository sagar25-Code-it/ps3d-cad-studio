import {
  revisionEvidencePayloadHash,
  validateCommittedRevision,
  type CommittedRevision
} from "../../evidence/src/index.js";
import { fail, hasExactKeys, isRecord, type Result } from "../../model-schema/src/index.js";

export interface ModelRepository {
  saveCommitted(record: CommittedRevision): Promise<Result<void>>;
  loadLatest(): Promise<Result<CommittedRevision | null>>;
}

interface StoredRevision extends CommittedRevision {
  readonly storageSchemaVersion: 2;
  readonly key: "latest";
  readonly evidenceSha256: string;
}

export class IndexedDbModelRepository implements ModelRepository {
  readonly #databaseName = "ps3d-phase0-revisions";
  readonly #storeName = "committed-revisions";

  async saveCommitted(record: CommittedRevision): Promise<Result<void>> {
    const valid = await validateCommittedRevision(record);
    if (!valid.ok) return valid;
    try {
      const evidenceSha256 = await revisionEvidencePayloadHash(valid.value.evidence);
      const database = await this.#open();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(this.#storeName, "readwrite");
        const stored: StoredRevision = {
          storageSchemaVersion: 2,
          key: "latest",
          document: structuredClone(valid.value.document),
          evidence: structuredClone(valid.value.evidence),
          evidenceSha256
        };
        transaction.objectStore(this.#storeName).put(stored);
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(new Error("transaction-aborted"));
        transaction.onerror = () => reject(new Error("transaction-failed"));
      });
      database.close();
      return { ok: true, value: undefined };
    } catch {
      return fail("PERSISTENCE_FAILURE", "Browser-local save failed.", [record.document.id], "Download native JSON and verify browser storage is available.");
    }
  }

  async loadLatest(): Promise<Result<CommittedRevision | null>> {
    try {
      const database = await this.#open();
      const stored = await new Promise<unknown>((resolve, reject) => {
        const transaction = database.transaction(this.#storeName, "readonly");
        const request = transaction.objectStore(this.#storeName).get("latest");
        request.onsuccess = () => resolve(request.result as unknown);
        request.onerror = () => reject(new Error("read-failed"));
      });
      database.close();
      if (stored === undefined) return { ok: true, value: null };
      if (!isStoredRevision(stored)) return corruptStorage();
      const valid = await validateCommittedRevision({ document: stored.document, evidence: stored.evidence });
      if (!valid.ok) return corruptStorage();
      if (await revisionEvidencePayloadHash(valid.value.evidence) !== stored.evidenceSha256) return corruptStorage();
      return valid;
    } catch {
      return fail("PERSISTENCE_FAILURE", "Browser-local recovery failed.", [], "Open a downloaded native revision artifact.");
    }
  }

  async #open(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.#databaseName, 2);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.#storeName)) {
          request.result.createObjectStore(this.#storeName, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("open-failed"));
      request.onblocked = () => reject(new Error("upgrade-blocked"));
    });
  }
}

function isStoredRevision(value: unknown): value is StoredRevision {
  return isRecord(value) && hasExactKeys(value, [
    "storageSchemaVersion", "key", "document", "evidence", "evidenceSha256"
  ]) && value.storageSchemaVersion === 2 && value.key === "latest"
    && typeof value.evidenceSha256 === "string" && /^[a-f0-9]{64}$/u.test(value.evidenceSha256);
}

function corruptStorage(): Result<never> {
  return fail("PERSISTENCE_FAILURE", "The browser-local revision or its evidence failed validation.", [], "Open a downloaded native revision artifact.");
}
