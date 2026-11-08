import { createMemoryImageStore, type ImageStore } from "../../../packages/workbench-sketch/src/underlay.js";

/**
 * Keeps the pixels of sketch underlay pictures in this browser (IndexedDB), keyed by the image id the sketch refers to. The pictures
 * are never uploaded; they are read from a local file and stay here. When IndexedDB is unavailable (private windows, blocked storage)
 * the pictures live in memory until the tab closes.
 */
const DATABASE = "ps3d-sketch-underlays";
const STORE = "images";

const fallback = createMemoryImageStore();

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB is not available.")); return; }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
    request.onblocked = () => reject(new Error("IndexedDB is blocked by another PS3D tab."));
  });
}

function run<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then((database) => new Promise<T>((resolve, reject) => {
    const transaction = database.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    transaction.oncomplete = () => { database.close(); resolve(request.result); };
    transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error("IndexedDB transaction failed.")); };
    transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error("IndexedDB transaction was aborted.")); };
  }));
}

interface StoredImage {
  readonly bytes: ArrayBuffer;
  readonly mime: string;
}

export const browserImageStore: ImageStore = {
  async put(imageId, bytes, mime) {
    await fallback.put(imageId, bytes, mime);
    try {
      const copy = new Uint8Array(bytes).buffer;
      await run("readwrite", (store) => store.put({ bytes: copy, mime } satisfies StoredImage, imageId));
    } catch {
      // Memory copy above is enough for this session.
    }
  },
  async get(imageId) {
    const local = await fallback.get(imageId);
    if (local !== undefined) return local;
    try {
      const stored = await run<StoredImage | undefined>("readonly", (store) => store.get(imageId) as IDBRequest<StoredImage | undefined>);
      if (stored === undefined) return undefined;
      const value = { bytes: new Uint8Array(stored.bytes), mime: stored.mime };
      await fallback.put(imageId, value.bytes, value.mime);
      return value;
    } catch {
      return undefined;
    }
  },
  async remove(imageId) {
    await fallback.remove(imageId);
    try { await run("readwrite", (store) => store.delete(imageId)); } catch { /* nothing to remove */ }
  }
};
