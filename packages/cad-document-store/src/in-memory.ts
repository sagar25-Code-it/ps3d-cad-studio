import { deepFreeze } from "../../cad-document-core/src/index.js";
import type { DocumentStoragePort, DocumentStoreKey, PersistedProjectState } from "./types.js";

export class InMemoryDocumentStoragePort implements DocumentStoragePort {
  readonly kind = "memory" as const;
  readonly #states = new Map<string, PersistedProjectState>();

  constructor(seed: readonly PersistedProjectState[] = []) {
    for (const state of seed) this.#states.set(keyString(state.key), immutableClone(state));
  }

  async read(key: DocumentStoreKey): Promise<PersistedProjectState | null> {
    const state = this.#states.get(keyString(key));
    return state === undefined ? null : immutableClone(state);
  }

  async compareAndSwap(
    key: DocumentStoreKey,
    expectedStorageVersion: number | null,
    next: PersistedProjectState
  ): Promise<boolean> {
    const id = keyString(key);
    const current = this.#states.get(id);
    if ((current?.storageVersion ?? null) !== expectedStorageVersion) return false;
    if (keyString(next.key) !== id) throw new TypeError("A CAS write cannot change its tenant/project key.");
    if (current === undefined) {
      if (next.storageVersion !== 1 || next.snapshots.length !== 1 || next.events.length !== 1) {
        throw new TypeError("An initial state must atomically contain exactly one snapshot and event.");
      }
    } else {
      if (next.storageVersion !== current.storageVersion + 1
        || next.snapshots.length !== current.snapshots.length + 1
        || next.events.length !== current.events.length + 1
        || next.idempotency.length !== current.idempotency.length + 1
        || !isHashPrefix(current.snapshots.map((entry) => entry.snapshotSha256), next.snapshots.map((entry) => entry.snapshotSha256))
        || !isHashPrefix(current.events.map((entry) => entry.eventSha256), next.events.map((entry) => entry.eventSha256))
        || !isHashPrefix(current.idempotency.map((entry) => entry.receipt.receiptSha256), next.idempotency.map((entry) => entry.receipt.receiptSha256))) {
        throw new TypeError("The in-memory port accepts append-only atomic state transitions only.");
      }
    }
    this.#states.set(id, immutableClone(next));
    return true;
  }

  /** Returns a detached test/backup image; modifying it cannot mutate this port. */
  exportState(key: DocumentStoreKey): PersistedProjectState | null {
    const state = this.#states.get(keyString(key));
    return state === undefined ? null : immutableClone(state);
  }
}

export function keyString(key: DocumentStoreKey): string {
  return `${key.tenantId}\u0000${key.projectId}`;
}

function isHashPrefix(current: readonly string[], next: readonly string[]): boolean {
  return current.every((value, index) => next[index] === value);
}

function immutableClone<Value>(value: Value): Value {
  return deepFreeze(structuredClone(value));
}
