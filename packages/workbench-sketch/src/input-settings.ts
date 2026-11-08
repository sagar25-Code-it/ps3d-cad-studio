import { keymapFromOverrides, overridesOfKeymap, type SketchKeymap } from "./hotkeys.js";
import { DEFAULT_SNAP_ASSIST, snapAssistFromJson, type SnapAssistSettings } from "./snap-assist.js";

/**
 * The sketch input settings that live in the browser (like the block library), not in the project file: the customised
 * keymap and the snap / polar / ortho choices. A missing, blocked or damaged storage just means the defaults.
 */
export interface SettingsStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem?(key: string): void;
}

export const KEYMAP_STORAGE_KEY = "ps3d.sketch-keymap.v1";
export const SNAP_ASSIST_STORAGE_KEY = "ps3d.sketch-snap-assist.v1";

function readJson(storage: SettingsStorage | undefined, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw === null || raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function loadKeymap(storage?: SettingsStorage): SketchKeymap {
  return keymapFromOverrides(readJson(storage, KEYMAP_STORAGE_KEY));
}

/** Saves only what differs from the defaults; the defaults themselves clear the entry. */
export function saveKeymap(storage: SettingsStorage | undefined, keymap: SketchKeymap): void {
  try {
    const overrides = overridesOfKeymap(keymap);
    if (Object.keys(overrides).length > 0) storage?.setItem(KEYMAP_STORAGE_KEY, JSON.stringify(overrides));
    else if (storage?.removeItem !== undefined) storage.removeItem(KEYMAP_STORAGE_KEY);
    else storage?.setItem(KEYMAP_STORAGE_KEY, "{}");
  } catch { /* the keymap still works for this session */ }
}

export function loadSnapAssist(storage?: SettingsStorage): SnapAssistSettings {
  const stored = readJson(storage, SNAP_ASSIST_STORAGE_KEY);
  return stored === undefined ? DEFAULT_SNAP_ASSIST : snapAssistFromJson(stored);
}

export function saveSnapAssist(storage: SettingsStorage | undefined, settings: SnapAssistSettings): void {
  try { storage?.setItem(SNAP_ASSIST_STORAGE_KEY, JSON.stringify(settings)); } catch { /* the choice still holds for this session */ }
}
