import { validateWorkbenchProject, type WorkbenchProject } from "../../../packages/workbench-core/src/index.js";

const WORKSPACE_NAME = "PS CAD Studio";
const DATABASE_NAME = "ps3d-file-workspace";
const DATABASE_VERSION = 1;
const SETTINGS_STORE = "settings";
const DIRECTORY_KEY = "workspace-directory";
const CURRENT_FILE_KEY = "current-project-file";
const RECENT_KEY = "recent-projects";
const MAX_RECENT_PROJECTS = 12;
const MAX_PROJECT_BYTES = 50 * 1024 * 1024;

type WritablePermission = PermissionState | "unsupported";
type ProjectLocator = "workspace" | "file-handle" | "metadata";

interface PermissionCapableHandle extends FileSystemHandle {
  queryPermission?: (descriptor?: { readonly mode?: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (descriptor?: { readonly mode?: "read" | "readwrite" }) => Promise<PermissionState>;
}

interface PickerWindow extends Window {
  showDirectoryPicker?: (options?: {
    readonly id?: string;
    readonly mode?: "read" | "readwrite";
    readonly startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos";
  }) => Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?: (options?: {
    readonly id?: string;
    readonly multiple?: boolean;
    readonly startIn?: "desktop" | "documents" | "downloads";
    readonly types?: readonly {
      readonly description: string;
      readonly accept: Readonly<Record<string, readonly string[]>>;
    }[];
  }) => Promise<readonly FileSystemFileHandle[]>;
  showSaveFilePicker?: (options?: {
    readonly id?: string;
    readonly suggestedName?: string;
    readonly startIn?: "desktop" | "documents" | "downloads";
    readonly types?: readonly {
      readonly description: string;
      readonly accept: Readonly<Record<string, readonly string[]>>;
    }[];
  }) => Promise<FileSystemFileHandle>;
}

interface StoredCurrentFile {
  readonly locator: Exclude<ProjectLocator, "metadata">;
  readonly fileName: string;
  readonly handle?: FileSystemFileHandle;
}

interface StoredRecentProject extends RecentProjectEntry {
  readonly locator: ProjectLocator;
  readonly handle?: FileSystemFileHandle;
}

export interface RecentProjectEntry {
  readonly id: string;
  readonly fileName: string;
  readonly projectName: string;
  readonly revision: number;
  readonly updatedAt: string;
  readonly sizeBytes: number;
  readonly canReopen: boolean;
}

export interface PsCadWorkspaceStatus {
  readonly apiSupported: boolean;
  readonly bound: boolean;
  readonly permission: WritablePermission;
  readonly folderName: string;
  readonly persistentStorage: boolean;
  readonly cacheReady: boolean;
  readonly usageBytes: number;
  readonly quotaBytes: number;
  readonly currentFileName: string | null;
}

export interface ProjectFilePayload {
  readonly text: string;
  readonly fileName: string;
}

export interface ProjectSaveOptions {
  readonly mode: "save" | "save-as" | "copy";
  readonly suggestedName: string;
  readonly projectName: string;
  readonly revision: number;
}

export interface ProjectSaveOutcome {
  readonly destination: "workspace" | "file-picker" | "download";
  readonly fileName: string;
  readonly workspaceName: string | null;
}

export async function preparePsCadLocalStorage(): Promise<void> {
  await Promise.allSettled([
    navigator.storage?.persist?.() ?? Promise.resolve(false),
    ensureOpfsLayout()
  ]);
}

export async function initializePsCadWorkspace(): Promise<PsCadWorkspaceStatus> {
  const picker = (window as PickerWindow).showDirectoryPicker;
  if (picker === undefined) throw new Error("Folder workspaces are not supported by this browser. PS3D will keep using its private recovery cache and standard downloads.");
  const selected = await picker.call(window, { id: "ps3d-workspace", mode: "readwrite", startIn: "downloads" });
  const selectedPermission = await ensurePermission(selected, true);
  if (selectedPermission !== "granted") throw new Error("Read/write permission is required to create the PS CAD Studio workspace.");
  const workspace = selected.name.toLocaleLowerCase() === WORKSPACE_NAME.toLocaleLowerCase()
    ? selected
    : await selected.getDirectoryHandle(WORKSPACE_NAME, { create: true });
  for (const directory of ["Projects", "Exports", "Renders", "Recovery", "Cache"]) {
    await workspace.getDirectoryHandle(directory, { create: true });
  }
  await writeTextFile(workspace, "README.txt", workspaceReadme());
  await putSetting(DIRECTORY_KEY, workspace);
  await navigator.storage?.persist?.().catch(() => false);
  await ensureOpfsLayout();
  return getPsCadWorkspaceStatus();
}

export async function getPsCadWorkspaceStatus(): Promise<PsCadWorkspaceStatus> {
  const pickerSupported = (window as PickerWindow).showDirectoryPicker !== undefined;
  const directory = await getSetting<FileSystemDirectoryHandle>(DIRECTORY_KEY).catch(() => undefined);
  const permission = directory === undefined ? "unsupported" : await ensurePermission(directory, false);
  const current = await getSetting<StoredCurrentFile>(CURRENT_FILE_KEY).catch(() => undefined);
  const estimate = await navigator.storage?.estimate?.().catch(() => undefined);
  const persistentStorage = await navigator.storage?.persisted?.().catch(() => false) ?? false;
  return {
    apiSupported: pickerSupported,
    bound: directory !== undefined,
    permission,
    folderName: directory?.name ?? WORKSPACE_NAME,
    persistentStorage,
    cacheReady: await opfsCacheExists().catch(() => false),
    usageBytes: estimate?.usage ?? 0,
    quotaBytes: estimate?.quota ?? 0,
    currentFileName: current?.fileName ?? null
  };
}

export async function saveProjectText(text: string, options: ProjectSaveOptions): Promise<ProjectSaveOutcome> {
  assertProjectText(text);
  const fileName = normalizeProjectFileName(options.suggestedName);
  const current = options.mode === "save" ? await getSetting<StoredCurrentFile>(CURRENT_FILE_KEY).catch(() => undefined) : undefined;
  if (current !== undefined) {
    const saved = await writeCurrentFile(current, text);
    if (saved) {
      await recordRecentProject({ fileName: current.fileName, projectName: options.projectName, revision: options.revision, sizeBytes: byteLength(text) }, current.locator, current.handle);
      await cacheProjectText(text);
      return { destination: current.locator === "workspace" ? "workspace" : "file-picker", fileName: current.fileName, workspaceName: current.locator === "workspace" ? WORKSPACE_NAME : null };
    }
  }

  const workspace = await writableWorkspaceDirectory(false);
  if (workspace !== undefined) {
    const projects = await workspace.getDirectoryHandle("Projects", { create: true });
    const handle = await projects.getFileHandle(fileName, { create: true });
    await writeFileHandle(handle, text);
    if (options.mode !== "copy") await putSetting(CURRENT_FILE_KEY, { locator: "workspace", fileName } satisfies StoredCurrentFile);
    await recordRecentProject({ fileName, projectName: options.projectName, revision: options.revision, sizeBytes: byteLength(text) }, "workspace");
    await writeVisibleSessionManifest(workspace, fileName, options.projectName, options.revision);
    await cacheProjectText(text);
    return { destination: "workspace", fileName, workspaceName: workspace.name };
  }

  const picker = (window as PickerWindow).showSaveFilePicker;
  if (picker !== undefined) {
    const handle = await picker.call(window, {
      id: "ps3d-project-save",
      startIn: "downloads",
      suggestedName: fileName,
      types: projectPickerTypes()
    });
    await writeFileHandle(handle, text);
    if (options.mode !== "copy") await putSetting(CURRENT_FILE_KEY, { locator: "file-handle", fileName: handle.name, handle } satisfies StoredCurrentFile);
    await recordRecentProject({ fileName: handle.name, projectName: options.projectName, revision: options.revision, sizeBytes: byteLength(text) }, "file-handle", handle);
    await cacheProjectText(text);
    return { destination: "file-picker", fileName: handle.name, workspaceName: null };
  }

  downloadBlob(new Blob([text], { type: "application/json" }), fileName);
  await recordRecentProject({ fileName, projectName: options.projectName, revision: options.revision, sizeBytes: byteLength(text) }, "metadata");
  await cacheProjectText(text);
  return { destination: "download", fileName, workspaceName: null };
}

export async function openProjectWithPicker(): Promise<ProjectFilePayload | undefined> {
  const picker = (window as PickerWindow).showOpenFilePicker;
  if (picker === undefined) return undefined;
  const handles = await picker.call(window, { id: "ps3d-project-open", multiple: false, startIn: "downloads", types: projectPickerTypes() });
  const handle = handles[0];
  if (handle === undefined) return undefined;
  const permission = await ensurePermission(handle, false);
  if (permission === "denied") throw new Error("The selected project cannot be read because file permission was denied.");
  const file = await handle.getFile();
  if (file.size > MAX_PROJECT_BYTES) throw new Error("The selected PS3D project exceeds the 50 MB browser safety limit.");
  await putSetting(CURRENT_FILE_KEY, { locator: "file-handle", fileName: file.name, handle } satisfies StoredCurrentFile);
  return { text: await file.text(), fileName: file.name };
}

export async function openRecentProject(entryId: string): Promise<ProjectFilePayload> {
  const entries = await readStoredRecentProjects();
  const entry = entries.find((candidate) => candidate.id === entryId);
  if (entry === undefined) throw new Error("The recent project entry no longer exists.");
  if (entry.locator === "workspace") {
    const workspace = await writableWorkspaceDirectory(false);
    if (workspace === undefined) throw new Error("Reconnect the PS CAD Studio folder before opening this recent project.");
    const projects = await workspace.getDirectoryHandle("Projects");
    const handle = await projects.getFileHandle(entry.fileName);
    const file = await handle.getFile();
    await putSetting(CURRENT_FILE_KEY, { locator: "workspace", fileName: entry.fileName } satisfies StoredCurrentFile);
    return { text: await file.text(), fileName: file.name };
  }
  if (entry.locator === "file-handle" && entry.handle !== undefined) {
    const permission = await ensurePermission(entry.handle, true);
    if (permission !== "granted") throw new Error("File permission is required to reopen this recent project.");
    const file = await entry.handle.getFile();
    await putSetting(CURRENT_FILE_KEY, { locator: "file-handle", fileName: file.name, handle: entry.handle } satisfies StoredCurrentFile);
    return { text: await file.text(), fileName: file.name };
  }
  throw new Error("This recent item was downloaded without a reusable file handle. Use Open Project and select it again.");
}

export async function rememberOpenedProject(fileName: string, project: WorkbenchProject): Promise<void> {
  const current = await getSetting<StoredCurrentFile>(CURRENT_FILE_KEY).catch(() => undefined);
  const locator = current?.fileName === fileName ? current.locator : "metadata";
  const handle = current?.fileName === fileName ? current.handle : undefined;
  await recordRecentProject({ fileName, projectName: project.name, revision: project.revision, sizeBytes: byteLength(JSON.stringify(project)) }, locator, handle);
}

export async function listRecentProjects(): Promise<readonly RecentProjectEntry[]> {
  return (await readStoredRecentProjects()).map(({ locator: _locator, handle: _handle, ...entry }) => entry);
}

export async function clearCurrentProjectFile(): Promise<void> {
  await deleteSetting(CURRENT_FILE_KEY);
}

export async function cacheWorkbenchProject(project: WorkbenchProject): Promise<void> {
  const valid = validateWorkbenchProject(project);
  if (!valid.ok) throw new Error(valid.diagnostics[0]?.message ?? "The workbench project is invalid.");
  await cacheProjectText(`${JSON.stringify(valid.value)}\n`);
}

export async function loadCachedWorkbenchProject(): Promise<WorkbenchProject | undefined> {
  const text = await readOpfsText("Recovery", "autosave-latest.workbench.json").catch(() => undefined);
  if (text === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(text) as unknown; } catch { return undefined; }
  const valid = validateWorkbenchProject(value);
  return valid.ok ? valid.value : undefined;
}

export async function clearPsCadCaches(): Promise<void> {
  const root = await navigator.storage?.getDirectory?.();
  if (root !== undefined) {
    await root.removeEntry(WORKSPACE_NAME, { recursive: true }).catch(() => undefined);
    await ensureOpfsLayout();
  }
}

export async function writeWorkspaceArtifact(directoryName: "Exports" | "Renders" | "Recovery", fileName: string, blob: Blob): Promise<boolean> {
  const workspace = await writableWorkspaceDirectory(false);
  if (workspace === undefined) return false;
  const directory = await workspace.getDirectoryHandle(directoryName, { create: true });
  const handle = await directory.getFileHandle(safeFileName(fileName), { create: true });
  const writable = await handle.createWritable();
  try { await writable.write(blob); } finally { await writable.close(); }
  return true;
}

export function normalizeProjectFileName(value: string): string {
  const trimmed = value.trim().replace(/\.(?:ps3d(?:\.json)?|workbench\.json|json)$/iu, "");
  const stem = trimmed.replace(/[^a-z0-9 _.-]+/giu, "-").replace(/\s+/gu, " ").replace(/^[ .-]+|[ .-]+$/gu, "").slice(0, 96);
  return `${stem.length === 0 ? "Untitled" : stem}.ps3d.json`;
}

export function formatStorageSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"] as const;
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

async function writeCurrentFile(current: StoredCurrentFile, text: string): Promise<boolean> {
  if (current.locator === "workspace") {
    const workspace = await writableWorkspaceDirectory(false);
    if (workspace === undefined) return false;
    const projects = await workspace.getDirectoryHandle("Projects", { create: true });
    await writeFileHandle(await projects.getFileHandle(current.fileName, { create: true }), text);
    return true;
  }
  if (current.handle === undefined || await ensurePermission(current.handle, true) !== "granted") return false;
  await writeFileHandle(current.handle, text);
  return true;
}

async function writableWorkspaceDirectory(request: boolean): Promise<FileSystemDirectoryHandle | undefined> {
  const directory = await getSetting<FileSystemDirectoryHandle>(DIRECTORY_KEY).catch(() => undefined);
  if (directory === undefined) return undefined;
  return await ensurePermission(directory, request) === "granted" ? directory : undefined;
}

async function ensurePermission(handle: FileSystemHandle, request: boolean): Promise<WritablePermission> {
  const capable = handle as PermissionCapableHandle;
  if (capable.queryPermission === undefined) return "granted";
  const current = await capable.queryPermission({ mode: "readwrite" }).catch(() => "denied" as PermissionState);
  if (current === "granted" || !request || capable.requestPermission === undefined) return current;
  return capable.requestPermission({ mode: "readwrite" }).catch(() => "denied" as PermissionState);
}

async function writeFileHandle(handle: FileSystemFileHandle, content: string): Promise<void> {
  const writable = await handle.createWritable();
  try { await writable.write(content); } finally { await writable.close(); }
}

async function writeTextFile(directory: FileSystemDirectoryHandle, fileName: string, content: string): Promise<void> {
  await writeFileHandle(await directory.getFileHandle(fileName, { create: true }), content);
}

async function writeVisibleSessionManifest(workspace: FileSystemDirectoryHandle, fileName: string, projectName: string, revision: number): Promise<void> {
  const cache = await workspace.getDirectoryHandle("Cache", { create: true });
  await writeTextFile(cache, "session-manifest.json", `${JSON.stringify({ schema: "ps3d-workspace-session/1", projectName, fileName, revision, savedAt: new Date().toISOString() }, null, 2)}\n`);
}

async function recordRecentProject(input: { readonly fileName: string; readonly projectName: string; readonly revision: number; readonly sizeBytes: number }, locator: ProjectLocator, handle?: FileSystemFileHandle): Promise<void> {
  const current = await readStoredRecentProjects();
  const id = recentId(locator, input.fileName);
  const entry: StoredRecentProject = {
    id,
    fileName: input.fileName,
    projectName: input.projectName,
    revision: input.revision,
    updatedAt: new Date().toISOString(),
    sizeBytes: input.sizeBytes,
    canReopen: locator !== "metadata",
    locator,
    ...(handle === undefined ? {} : { handle })
  };
  await putSetting(RECENT_KEY, [entry, ...current.filter((candidate) => candidate.id !== id)].slice(0, MAX_RECENT_PROJECTS));
}

async function readStoredRecentProjects(): Promise<readonly StoredRecentProject[]> {
  const value = await getSetting<unknown>(RECENT_KEY).catch(() => undefined);
  if (!Array.isArray(value)) return [];
  return value.filter(isStoredRecentProject);
}

function isStoredRecentProject(value: unknown): value is StoredRecentProject {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<StoredRecentProject>;
  return typeof entry.id === "string" && typeof entry.fileName === "string" && typeof entry.projectName === "string"
    && typeof entry.revision === "number" && typeof entry.updatedAt === "string" && typeof entry.sizeBytes === "number"
    && typeof entry.canReopen === "boolean" && (entry.locator === "workspace" || entry.locator === "file-handle" || entry.locator === "metadata");
}

async function cacheProjectText(text: string): Promise<void> {
  await ensureOpfsLayout();
  await Promise.all([
    writeOpfsText("Cache", "current.workbench.json", text),
    writeOpfsText("Recovery", "autosave-latest.workbench.json", text)
  ]);
}

async function ensureOpfsLayout(): Promise<void> {
  const root = await navigator.storage?.getDirectory?.();
  if (root === undefined) return;
  const ps3d = await root.getDirectoryHandle(WORKSPACE_NAME, { create: true });
  await Promise.all(["Cache", "Recovery", "Thumbnails"].map((name) => ps3d.getDirectoryHandle(name, { create: true })));
}

async function opfsCacheExists(): Promise<boolean> {
  const root = await navigator.storage?.getDirectory?.();
  if (root === undefined) return false;
  try {
    const ps3d = await root.getDirectoryHandle(WORKSPACE_NAME);
    const cache = await ps3d.getDirectoryHandle("Cache");
    await cache.getFileHandle("current.workbench.json");
    return true;
  } catch { return false; }
}

async function writeOpfsText(directoryName: string, fileName: string, text: string): Promise<void> {
  const root = await navigator.storage?.getDirectory?.();
  if (root === undefined) return;
  const ps3d = await root.getDirectoryHandle(WORKSPACE_NAME, { create: true });
  const directory = await ps3d.getDirectoryHandle(directoryName, { create: true });
  await writeTextFile(directory, fileName, text);
}

async function readOpfsText(directoryName: string, fileName: string): Promise<string | undefined> {
  const root = await navigator.storage?.getDirectory?.();
  if (root === undefined) return undefined;
  const ps3d = await root.getDirectoryHandle(WORKSPACE_NAME);
  const directory = await ps3d.getDirectoryHandle(directoryName);
  return (await (await directory.getFileHandle(fileName)).getFile()).text();
}

function projectPickerTypes(): readonly { readonly description: string; readonly accept: Readonly<Record<string, readonly string[]>> }[] {
  return [{ description: "PS3D CAD Studio project", accept: { "application/json": [".ps3d.json", ".workbench.json", ".json"] } }];
}

function assertProjectText(text: string): void {
  const bytes = byteLength(text);
  if (bytes <= 0 || bytes > MAX_PROJECT_BYTES) throw new Error("The PS3D project must be between 1 byte and 50 MB.");
}

function byteLength(text: string): number { return new TextEncoder().encode(text).byteLength; }
function recentId(locator: ProjectLocator, fileName: string): string { return `${locator}:${fileName.toLocaleLowerCase()}`; }
function safeFileName(value: string): string { return value.replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, "-").replace(/[ .]+$/gu, "").slice(0, 128) || "ps3d-artifact"; }

function workspaceReadme(): string {
  return [
    "PS3D CAD Studio workspace",
    "",
    "Projects  - native PS3D workbench project files",
    "Exports   - engineering exchange outputs",
    "Renders   - Render Studio image outputs",
    "Recovery  - user-visible recovery copies",
    "Cache     - small manifests only; fast private cache also lives in browser OPFS",
    "",
    "This folder is written only after explicit browser permission. Do not edit files while PS3D is saving.",
    ""
  ].join("\n");
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(SETTINGS_STORE)) request.result.createObjectStore(SETTINGS_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The PS3D file-workspace database could not be opened."));
    request.onblocked = () => reject(new Error("Close other PS3D tabs before upgrading the file workspace."));
  });
}

async function getSetting<T>(key: string): Promise<T | undefined> {
  const database = await openDatabase();
  try { return await transactionResult<T | undefined>(database, "readonly", (store) => store.get(key)); }
  finally { database.close(); }
}

async function putSetting(key: string, value: unknown): Promise<void> {
  const database = await openDatabase();
  try { await transactionResult(database, "readwrite", (store) => store.put(value, key)); }
  finally { database.close(); }
}

async function deleteSetting(key: string): Promise<void> {
  const database = await openDatabase();
  try { await transactionResult(database, "readwrite", (store) => store.delete(key)); }
  finally { database.close(); }
}

function transactionResult<T = unknown>(database: IDBDatabase, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(SETTINGS_STORE, mode, { durability: "strict" });
    const request = action(transaction.objectStore(SETTINGS_STORE));
    request.onerror = () => reject(request.error ?? new Error("The PS3D file-workspace request failed."));
    transaction.oncomplete = () => resolve(request.result as T);
    transaction.onerror = () => reject(transaction.error ?? new Error("The PS3D file-workspace transaction failed."));
    transaction.onabort = () => reject(transaction.error ?? new Error("The PS3D file-workspace transaction was aborted."));
  });
}
