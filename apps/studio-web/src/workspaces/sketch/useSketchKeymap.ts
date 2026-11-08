import { useSyncExternalStore } from "react";
import { getActiveSketchKeymap, setActiveSketchKeymap, subscribeSketchKeymap, type SketchKeymap } from "../../../../../packages/workbench-sketch/src/hotkeys.js";
import { loadKeymap, loadSnapAssist, saveKeymap, saveSnapAssist, type SettingsStorage } from "../../../../../packages/workbench-sketch/src/input-settings.js";
import type { SnapAssistSettings } from "../../../../../packages/workbench-sketch/src/snap-assist.js";

/**
 * The sketch keymap and the snap / polar / ortho choices live in the browser's local storage (like the block library), not in
 * the project file: they are the user's habits, not the design's. A blocked or missing storage means the defaults and
 * changes that last until the page closes.
 */
export function browserSettingsStorage(): SettingsStorage | undefined {
  try { return window.localStorage; } catch { return undefined; }
}

let keymapLoaded = false;

/** Loads the saved keymap into the live keymap once. Safe to call from anywhere (the ribbon, the canvas, the command search). */
export function ensureSketchKeymapLoaded(): void {
  if (keymapLoaded) return;
  keymapLoaded = true;
  setActiveSketchKeymap(loadKeymap(browserSettingsStorage()));
}

/** The live keymap; the component re-renders when the user changes a key. Use keyLabelForTool / keyChipForTool for a tool's chip. */
export function useSketchKeymap(): SketchKeymap {
  ensureSketchKeymapLoaded();
  return useSyncExternalStore(subscribeSketchKeymap, getActiveSketchKeymap, getActiveSketchKeymap);
}

/** Makes `keymap` the live keymap and remembers it. */
export function updateSketchKeymap(keymap: SketchKeymap): void {
  keymapLoaded = true;
  setActiveSketchKeymap(keymap);
  saveKeymap(browserSettingsStorage(), keymap);
}

export function loadStoredSnapAssist(): SnapAssistSettings {
  return loadSnapAssist(browserSettingsStorage());
}

export function storeSnapAssist(settings: SnapAssistSettings): void {
  saveSnapAssist(browserSettingsStorage(), settings);
}
