/**
 * PT-10: the Part environment's single-letter commands, as one table like the sketch keymap, so the listener, the
 * menus and the shortcut overlay never disagree. Fusion's letters: E Extrude, Q Press Pull, F Fillet, H Hole,
 * M Move, I Measure, A Appearance; Fit moves to F6 (and stays on the Fit button), and S stays the command search.
 */

export type PartHotkeyCommand =
  | "extrude"
  | "press-pull"
  | "fillet"
  | "hole"
  | "move"
  | "measure"
  | "appearance"
  | "fit"
  | "view-front"
  | "view-top"
  | "view-right"
  | "view-isometric"
  | "nav-select"
  | "nav-orbit"
  | "nav-pan";

export interface PartHotkey {
  /** The key, lower case, as KeyboardEvent.key reports it. */
  readonly key: string;
  readonly command: PartHotkeyCommand;
  readonly label: string;
  /** Only meaningful in the Part workspace (the letter stays free elsewhere in 3D). */
  readonly partOnly?: boolean;
}

export const PART_HOTKEYS: readonly PartHotkey[] = [
  { key: "e", command: "extrude", label: "Extrude", partOnly: true },
  { key: "q", command: "press-pull", label: "Press Pull (offset faces)", partOnly: true },
  { key: "f", command: "fillet", label: "Fillet", partOnly: true },
  { key: "h", command: "hole", label: "Hole", partOnly: true },
  { key: "m", command: "move", label: "Move", partOnly: true },
  { key: "i", command: "measure", label: "Measure" },
  { key: "a", command: "appearance", label: "Appearance", partOnly: true },
  { key: "f6", command: "fit", label: "Fit" },
  { key: "1", command: "view-front", label: "Front view" },
  { key: "2", command: "view-top", label: "Top view" },
  { key: "3", command: "view-right", label: "Right view" },
  { key: "4", command: "view-isometric", label: "Isometric view" },
  { key: "v", command: "nav-select", label: "Select" },
  { key: "o", command: "nav-orbit", label: "Orbit" },
  { key: "p", command: "nav-pan", label: "Pan" },
];

/** The command a key starts in a 3D workspace; undefined when the key is unbound (or Part-only outside the Part workspace). */
export function partHotkeyCommand(key: string, workspace: string): PartHotkeyCommand | undefined {
  const entry = PART_HOTKEYS.find((candidate) => candidate.key === key.toLowerCase());
  if (entry === undefined) return undefined;
  if (entry.partOnly === true && workspace !== "part") return undefined;
  return entry.command;
}

/**
 * PT-15: the letters that start an interactive flow outside the shared command panel. Pressed while the panel is open
 * they cancel it first, visibly, so no live-looking panel stays behind whose picks go nowhere. Fillet and Hole run
 * through the panel itself (panelReopenPlan keeps or restarts it there), the view and navigation keys never touch it,
 * and Appearance only focuses the inspector.
 */
export function hotkeyCancelsPanel(command: PartHotkeyCommand): boolean {
  return command === "extrude" || command === "press-pull" || command === "move";
}
