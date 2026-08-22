import { validateWorkbenchProject, type WorkbenchProject } from "../../../packages/workbench-core/src/index.js";

const DATABASE = "ps3d-workbench-preview";
const STORE = "projects";
const KEY = "current";

export async function saveWorkbenchProject(project: WorkbenchProject): Promise<void> {
  const valid = validateWorkbenchProject(project);
  if (!valid.ok) throw new Error(valid.diagnostics[0]?.message ?? "The workbench project is invalid.");
  const database = await openDatabase();
  try {
    await transactionPromise(database, "readwrite", (store) => store.put(structuredClone(valid.value), KEY));
  } finally {
    database.close();
  }
}

export async function loadWorkbenchProject(): Promise<WorkbenchProject | undefined> {
  const database = await openDatabase();
  try {
    const value = await transactionPromise(database, "readonly", (store) => store.get(KEY));
    if (value === undefined) return undefined;
    const valid = validateWorkbenchProject(value);
    if (!valid.ok) throw new Error(valid.diagnostics[0]?.message ?? "The stored workbench project is invalid.");
    return valid.value;
  } finally {
    database.close();
  }
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB could not be opened."));
    request.onblocked = () => reject(new Error("IndexedDB upgrade is blocked by another PS3D tab."));
  });
}

function transactionPromise(
  database: IDBDatabase,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(STORE, mode, { durability: "strict" });
    const request = action(transaction.objectStore(STORE));
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });
}
