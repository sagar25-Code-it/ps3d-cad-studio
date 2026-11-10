import { sketchHotkeyHelp, type SketchKeymap } from "../../../../packages/workbench-sketch/src/hotkeys.js";

/**
 * The "Sketch canvas" group of the global shortcut list (the ? overlay). It is built from the keymap that is live right now, so a key the
 * user rebound in the shortcut editor shows under its new key, and a command whose key was removed is not listed at all. The list in the
 * Sketch palette is built from the same function, so the two can never disagree.
 */
export interface ShortcutItem {
  readonly keys: readonly string[];
  readonly label: string;
}

export interface ShortcutGroup {
  readonly title: string;
  readonly items: readonly ShortcutItem[];
}

export const SKETCH_SHORTCUT_GROUP_TITLE = "Sketch canvas";

export function sketchShortcutItems(keymap: SketchKeymap): readonly ShortcutItem[] {
  return sketchHotkeyHelp(keymap).map((entry) => ({ keys: [entry.keys], label: entry.action }));
}

/** The groups with the sketch group's items replaced by the live keymap's. Other groups pass through unchanged. */
export function shortcutGroupsFor(groups: readonly ShortcutGroup[], keymap: SketchKeymap): readonly ShortcutGroup[] {
  return groups.map((group) => group.title === SKETCH_SHORTCUT_GROUP_TITLE ? { ...group, items: sketchShortcutItems(keymap) } : group);
}
