/**
 * Sketch preferences that outlive the Sketch workspace. SketchWorkspace is unmounted whenever another workspace opens, so every
 * `useState` inside it used to start over: Snap, Auto-constrain, the Dimensions toggle, the polygon side count, the Create solid
 * settings, Dynamic Mirror. This store keeps them for the session (in memory) and across reloads (localStorage, for the values that
 * are plain data). Values that name geometry (a mirror axis, a sweep path) stay in memory only, because their ids mean nothing
 * to a different project or after a reload.
 */

export interface PrefStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "ps3d.sketch.prefs.v1";
const MAX_STORED_BYTES = 64_000;

/**
 * Makes a stored value safe to use as the preference's value: it must have the same JSON type as the default. An object is merged onto
 * the default field by field (only known keys of the same type are taken), so a newer build that adds a field does not lose it and a
 * damaged store cannot inject one.
 */
export function coercePref<T>(initial: T, stored: unknown): T {
  if (stored === undefined) return initial;
  if (Array.isArray(initial)) return (Array.isArray(stored) ? stored : initial) as T;
  if (initial !== null && typeof initial === "object") {
    if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return initial;
    const merged: Record<string, unknown> = { ...(initial as Record<string, unknown>) };
    for (const [key, fallback] of Object.entries(initial as Record<string, unknown>)) {
      const candidate = (stored as Record<string, unknown>)[key];
      if (candidate !== undefined && typeof candidate === typeof fallback) merged[key] = candidate;
    }
    return merged as T;
  }
  if (typeof stored !== typeof initial) return initial;
  if (typeof stored === "number" && !Number.isFinite(stored)) return initial;
  return stored as T;
}

export class SketchPrefStore {
  private readonly memory = new Map<string, unknown>();
  private durable: Record<string, unknown> = {};
  private readonly storage: PrefStorage | undefined;

  constructor(storage?: PrefStorage) {
    this.storage = storage;
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      const parsed: unknown = raw === null || raw === undefined ? undefined : JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) this.durable = { ...(parsed as Record<string, unknown>) };
    } catch {
      this.durable = {};
    }
  }

  /** The remembered value, or `initial` when nothing usable is stored. */
  get<T>(key: string, initial: T, durable = true): T {
    // Memory-only values (ids of geometry) are the caller's to validate; plain-data values are checked against the default's type.
    if (!durable) return this.memory.has(key) ? (this.memory.get(key) as T) : initial;
    return coercePref(initial, this.memory.has(key) ? this.memory.get(key) : this.durable[key]);
  }

  set(key: string, value: unknown, durable = true): void {
    this.memory.set(key, value);
    if (!durable) return;
    this.durable[key] = value;
    try {
      const text = JSON.stringify(this.durable);
      if (text.length <= MAX_STORED_BYTES) this.storage?.setItem(STORAGE_KEY, text);
    } catch {
      // Storage full or blocked: the value still lasts for the session.
    }
  }

  /** Forgets everything (the "Reset sketch settings" action and tests). */
  clear(): void {
    this.memory.clear();
    this.durable = {};
    try {
      this.storage?.setItem(STORAGE_KEY, "{}");
    } catch {
      // Nothing to do.
    }
  }
}

function browserStorage(): PrefStorage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

/** The one store the Sketch workspace uses. */
export const sketchPrefs = new SketchPrefStore(browserStorage());

/** Palette placement: docked beside the canvas (the canvas gives up the space) or floating over it; and whether it is folded to its header. */
export interface PaletteLayout {
  readonly dock: "docked" | "floating";
  readonly collapsed: boolean;
}
export const DEFAULT_PALETTE_LAYOUT: PaletteLayout = { dock: "docked", collapsed: false };
