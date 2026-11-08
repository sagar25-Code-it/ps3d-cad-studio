import type { SketchTool } from "./index.js";

/**
 * Pure keyboard model for the sketch canvas. The workspace feeds it a key and the current interaction state and gets back
 * one action (or nothing, which lets the key fall through to the rest of the app: undo, save, command search).
 *
 * The letter keys are a KEYMAP: a table from command to key that the user can change in the shortcut editor. The default
 * follows Fusion's sketch habits (L line, R rectangle, C circle, A arc, D dimension, T trim, O offset) and adds Shift
 * variants for the sibling tools (Shift+R centre rectangle, Shift+C 2-point circle, Shift+A centerpoint arc ...). The ribbon
 * chips and the help sheet read the live keymap through keyLabelForTool, so they can never advertise a key that does nothing.
 */

/** Edit tools that a key can open. Every one is also a SketchEditToolId in the studio. */
export type SketchEditHotkeyTool =
  | "trim" | "offset" | "fillet" | "chamfer" | "extend" | "move" | "mirror" | "rotate" | "scale" | "pattern" | "corner" | "stretch" | "split";

export type SketchHotkeyAction =
  | { readonly kind: "tool"; readonly tool: Exclude<SketchTool, "select"> }
  | { readonly kind: "dimension" }
  | { readonly kind: "edit-tool"; readonly tool: SketchEditHotkeyTool }
  | { readonly kind: "toggle-construction" }
  /** Q: everything drawn from now on is construction geometry (or back). */
  | { readonly kind: "toggle-draw-construction" }
  | { readonly kind: "fit" }
  | { readonly kind: "pan-mode" }
  | { readonly kind: "select-tool" }
  | { readonly kind: "cancel-points" }
  | { readonly kind: "undo-point" }
  | { readonly kind: "cancel-drag" }
  | { readonly kind: "exit-pick" }
  | { readonly kind: "exit-dimension" }
  | { readonly kind: "exit-edit-tool" }
  | { readonly kind: "clear-selection" }
  | { readonly kind: "delete-selection" }
  | { readonly kind: "finish" }
  | { readonly kind: "select-all" }
  /** Ctrl/Cmd+C, X and V: the sketch clipboard. Copy and cut need a curve selection; paste is always offered and says if the clipboard is empty. */
  | { readonly kind: "copy" }
  | { readonly kind: "cut" }
  | { readonly kind: "paste" }
  /** A digit, point or minus pressed while typed-input fields are showing: start typing into the first field. */
  | { readonly kind: "type-value"; readonly key: string }
  /** Tab while typed-input fields are showing: move the focus into them. */
  | { readonly kind: "focus-dynamic" }
  /** Enter on the canvas while typed values are waiting: place the point with them. */
  | { readonly kind: "commit-dynamic" }
  /** Tab over curves that overlap under the pointer: select the next one (Select Other). */
  | { readonly kind: "select-other" }
  | { readonly kind: "toggle-snap" }
  | { readonly kind: "toggle-ortho" }
  | { readonly kind: "toggle-polar" };

export interface SketchHotkeyInput {
  /** The character the key produces (`event.key`). */
  readonly key: string;
  /** The physical key (`event.code`); used for letters only when `key` is not a Latin letter, so a Cyrillic or Greek layout still works. */
  readonly code?: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
}

export interface SketchHotkeyContext {
  readonly tool: SketchTool;
  readonly pendingPoints: number;
  /** Everything selected: curves and shaded profiles. Escape clears all of it. */
  readonly selectionCount: number;
  /** Selected curves only: Delete and Backspace remove curves, never a profile. */
  readonly curveSelectionCount: number;
  readonly dimensionMode: boolean;
  readonly editToolActive: boolean;
  /** Picking the points of a Coincident or Midpoint relation on the canvas. */
  readonly pickingRelation: boolean;
  /** A curve or point is being dragged. Escape abandons the drag and puts everything back. */
  readonly dragging: boolean;
  /** How many typed-input fields (length, angle, width...) the canvas is showing next to the cursor. */
  readonly dynamicFieldCount: number;
  /** Typed text is waiting in the fields (Enter on the canvas places it). */
  readonly dynamicTyped?: boolean;
  /** How many curves overlap under the pointer (Tab cycles through them when this is 2 or more). */
  readonly overlapUnderCursor?: number;
}

// ---------------------------------------------------------------------------------------------
// The keymap
// ---------------------------------------------------------------------------------------------

export type SketchCommandId =
  | `tool:${Exclude<SketchTool, "select">}`
  | `edit:${SketchEditHotkeyTool}`
  | "dimension" | "toggle-construction" | "toggle-draw-construction" | "fit" | "pan-mode" | "select-tool"
  | "toggle-snap" | "toggle-ortho" | "toggle-polar";

export type SketchCommandGroup = "Draw" | "Modify" | "Dimension and view" | "Input assistance";

export interface SketchCommandInfo {
  readonly id: SketchCommandId;
  readonly label: string;
  readonly group: SketchCommandGroup;
  /** The key the command has until the user changes it; undefined when it ships unbound. */
  readonly defaultKey: string | undefined;
}

const c = (id: SketchCommandId, label: string, group: SketchCommandGroup, defaultKey?: string): SketchCommandInfo => ({ id, label, group, defaultKey });

/** Every command a key can reach, in the order the shortcut editor lists them. */
export const SKETCH_KEYMAP_COMMANDS: readonly SketchCommandInfo[] = [
  c("tool:line", "Line", "Draw", "L"),
  c("tool:rectangle", "2-point rectangle", "Draw", "R"),
  c("tool:rectangle-center", "Center rectangle", "Draw", "Shift+R"),
  c("tool:rectangle-three-point", "3-point rectangle", "Draw"),
  c("tool:rectangle-rounded", "Rounded rectangle", "Draw"),
  c("tool:circle", "Center circle", "Draw", "C"),
  c("tool:circle-two-point", "2-point circle", "Draw", "Shift+C"),
  c("tool:circle-three-point", "3-point circle", "Draw"),
  c("tool:ellipse", "Center ellipse", "Draw", "E"),
  c("tool:arc", "3-point arc", "Draw", "A"),
  c("tool:arc-center", "Centerpoint arc", "Draw", "Shift+A"),
  c("tool:arc-tangent", "Tangent arc", "Draw"),
  c("tool:polygon", "Polygon", "Draw", "G"),
  c("tool:slot", "Slot", "Draw", "U"),
  c("tool:slot-straight", "Straight slot", "Draw", "Shift+U"),
  c("tool:spline", "Fit-point spline", "Draw", "Shift+S"),
  c("tool:spline-control", "Control-point spline", "Draw"),
  c("tool:point", "Point", "Draw", "Shift+P"),
  c("tool:line-midpoint", "Midpoint line", "Draw"),
  c("tool:centerline", "Centerline", "Draw"),
  c("tool:parallelogram", "Parallelogram", "Draw"),
  c("tool:slot-arc-three-point", "3-point arc slot", "Draw"),
  c("tool:slot-arc-center", "Centerpoint arc slot", "Draw"),
  c("tool:parabola", "Parabola", "Draw"),
  c("tool:hyperbola", "Hyperbola", "Draw"),
  c("tool:conic", "Conic (rho)", "Draw"),
  c("tool:conic-five", "Conic (5 points)", "Draw"),
  c("tool:blend", "Blend curve", "Draw"),
  c("tool:profile", "Profile", "Draw"),
  c("tool:text", "Text", "Draw"),
  c("tool:block", "Insert block", "Draw"),
  c("edit:trim", "Trim", "Modify", "T"),
  c("edit:extend", "Extend", "Modify", "Shift+T"),
  c("edit:offset", "Offset", "Modify", "O"),
  c("edit:fillet", "Fillet", "Modify", "Shift+F"),
  c("edit:chamfer", "Chamfer", "Modify"),
  c("edit:move", "Move / Copy", "Modify", "M"),
  c("edit:mirror", "Mirror", "Modify", "Shift+M"),
  c("edit:rotate", "Rotate", "Modify"),
  c("edit:scale", "Scale", "Modify"),
  c("edit:pattern", "Pattern", "Modify"),
  c("edit:corner", "Corner", "Modify"),
  c("edit:stretch", "Stretch", "Modify"),
  c("edit:split", "Split", "Modify"),
  c("dimension", "Sketch dimension", "Dimension and view", "D"),
  c("toggle-construction", "Toggle construction on the selection", "Dimension and view", "X"),
  c("toggle-draw-construction", "Draw as construction: new curves are construction geometry (toggle)", "Dimension and view", "Q"),
  c("select-tool", "Select tool", "Dimension and view", "V"),
  c("pan-mode", "Pan navigation", "Dimension and view", "P"),
  c("fit", "Fit the sketch to the window", "Dimension and view", "F"),
  c("toggle-snap", "Snap on / off", "Input assistance", "F9"),
  c("toggle-ortho", "Ortho lock on / off", "Input assistance", "F8"),
  c("toggle-polar", "Polar tracking on / off", "Input assistance", "F10")
];

const COMMAND_BY_ID: ReadonlyMap<string, SketchCommandInfo> = new Map(SKETCH_KEYMAP_COMMANDS.map((info) => [info.id, info]));

export function sketchCommandInfo(id: string): SketchCommandInfo | undefined {
  return COMMAND_BY_ID.get(id);
}

/**
 * Keys that cannot be given to a command: plain S opens the command search, F1 / F5 / F11 / F12 belong to the browser.
 * (Digits and the sign keys type into the dynamic input and Space pans, so they are not offered at all: a key is a letter,
 * optionally with Shift, or one of F2 to F12.)
 */
export const RESERVED_KEY_REASONS: Readonly<Record<string, string>> = {
  S: "S opens the command search.",
  F1: "F1 is the browser's help key.",
  F5: "F5 reloads the page.",
  F11: "F11 is the browser's full screen key.",
  F12: "F12 opens the browser's developer tools."
};

const KEY_RULE = "Use a letter (optionally with Shift) or a function key F2 to F12.";

/** A key spec is `Key` or `Shift+Key`, where Key is a letter A-Z or F2-F12. Returns the normalised text or undefined. */
export function normalizeKeySpec(text: string): string | undefined {
  const parts = text.trim().split("+").map((part) => part.trim()).filter((part) => part !== "");
  if (parts.length === 0 || parts.length > 2) return undefined;
  let shift = false;
  if (parts.length === 2) {
    if (parts[0]!.toLowerCase() !== "shift") return undefined;
    shift = true;
  }
  const key = parts[parts.length - 1]!.toUpperCase();
  const valid = /^[A-Z]$/.test(key) || /^F([2-9]|1[0-2])$/.test(key);
  if (!valid) return undefined;
  return shift ? `Shift+${key}` : key;
}

/** The problem with giving `spec` to a command, or undefined when it is allowed. */
export function keySpecProblem(spec: string): string | undefined {
  const normal = normalizeKeySpec(spec);
  if (normal === undefined) return KEY_RULE;
  const shifted = normal.startsWith("Shift+");
  const bare = shifted ? normal.slice(6) : normal;
  const reason = RESERVED_KEY_REASONS[bare];
  if (reason === undefined) return undefined;
  // The command search is plain S; Shift+S is free.
  if (shifted && bare === "S") return undefined;
  return reason;
}

/** What is stored in the user's settings: only the commands whose key differs from the default. `null` means unbound. */
export type SketchKeymapOverrides = Readonly<Partial<Record<SketchCommandId, string | null>>>;

export interface SketchKeymap {
  /** Command to key spec; a command with no key is absent. */
  readonly keys: Readonly<Partial<Record<SketchCommandId, string>>>;
  /** Key spec to command. */
  readonly commands: ReadonlyMap<string, SketchCommandId>;
}

function buildKeymap(keys: Partial<Record<SketchCommandId, string>>): SketchKeymap {
  const commands = new Map<string, SketchCommandId>();
  for (const info of SKETCH_KEYMAP_COMMANDS) {
    const spec = keys[info.id];
    if (spec !== undefined && !commands.has(spec)) commands.set(spec, info.id);
  }
  return { keys, commands };
}

export const DEFAULT_SKETCH_KEYMAP: SketchKeymap = buildKeymap(Object.fromEntries(SKETCH_KEYMAP_COMMANDS.filter((info) => info.defaultKey !== undefined).map((info) => [info.id, info.defaultKey!])) as Partial<Record<SketchCommandId, string>>);

/**
 * The keymap for a set of saved overrides. Unknown commands, unusable keys and a key claimed twice are dropped (the earlier
 * command in the editor's order keeps it), so a damaged settings entry can never produce two commands on one key. A default
 * key that an override takes over is removed from the command that used to own it.
 */
export function keymapFromOverrides(overrides: unknown): SketchKeymap {
  const keys: Partial<Record<SketchCommandId, string>> = { ...DEFAULT_SKETCH_KEYMAP.keys };
  if (typeof overrides !== "object" || overrides === null) return buildKeymap(keys);
  const accepted: Partial<Record<SketchCommandId, string | null>> = {};
  for (const [id, value] of Object.entries(overrides as Record<string, unknown>)) {
    if (!COMMAND_BY_ID.has(id)) continue;
    if (value === null) { accepted[id as SketchCommandId] = null; continue; }
    if (typeof value !== "string") continue;
    const spec = normalizeKeySpec(value);
    if (spec === undefined || keySpecProblem(spec) !== undefined) continue;
    accepted[id as SketchCommandId] = spec;
  }
  const taken = new Set<string>();
  for (const info of SKETCH_KEYMAP_COMMANDS) {
    const value = accepted[info.id];
    if (value === undefined) continue;
    if (value === null) { delete keys[info.id]; continue; }
    if (taken.has(value)) { delete accepted[info.id]; continue; }
    taken.add(value);
    keys[info.id] = value;
  }
  for (const info of SKETCH_KEYMAP_COMMANDS) {
    if (accepted[info.id] !== undefined) continue;
    const current = keys[info.id];
    if (current !== undefined && taken.has(current)) delete keys[info.id];
  }
  return buildKeymap(keys);
}

/** The overrides that turn the defaults into `keymap`; this is what gets saved. */
export function overridesOfKeymap(keymap: SketchKeymap): SketchKeymapOverrides {
  const overrides: Partial<Record<SketchCommandId, string | null>> = {};
  for (const info of SKETCH_KEYMAP_COMMANDS) {
    const now = keymap.keys[info.id];
    if (now === info.defaultKey) continue;
    overrides[info.id] = now ?? null;
  }
  return overrides;
}

export type RebindResult =
  | { readonly ok: true; readonly keymap: SketchKeymap; readonly displaced?: SketchCommandId }
  | { readonly ok: false; readonly reason: string; readonly conflict?: SketchCommandId };

/**
 * Gives `spec` to `id`. When another command already has the key the change is refused and the conflicting command is named;
 * with `replace` the other command loses the key (becomes unbound) and the change goes through. `spec` of undefined unbinds.
 */
export function rebindKey(keymap: SketchKeymap, id: SketchCommandId, spec: string | undefined, options: { readonly replace?: boolean } = {}): RebindResult {
  if (!COMMAND_BY_ID.has(id)) return { ok: false, reason: `Unknown command "${id}".` };
  const keys: Partial<Record<SketchCommandId, string>> = { ...keymap.keys };
  if (spec === undefined) {
    delete keys[id];
    return { ok: true, keymap: buildKeymap(keys) };
  }
  const normal = normalizeKeySpec(spec);
  if (normal === undefined) return { ok: false, reason: KEY_RULE };
  const problem = keySpecProblem(normal);
  if (problem !== undefined) return { ok: false, reason: problem };
  const owner = keymap.commands.get(normal);
  if (owner !== undefined && owner !== id) {
    const ownerLabel = COMMAND_BY_ID.get(owner)?.label ?? owner;
    if (options.replace !== true) return { ok: false, reason: `${normal} is already used by ${ownerLabel}.`, conflict: owner };
    delete keys[owner];
    keys[id] = normal;
    return { ok: true, keymap: buildKeymap(keys), displaced: owner };
  }
  keys[id] = normal;
  return { ok: true, keymap: buildKeymap(keys) };
}

/** Every key that two or more commands claim. A keymap built by this module has none; this exists to check a hand-made one. */
export function keymapConflicts(keys: Readonly<Partial<Record<SketchCommandId, string>>>): readonly { readonly key: string; readonly commands: readonly SketchCommandId[] }[] {
  const byKey = new Map<string, SketchCommandId[]>();
  for (const info of SKETCH_KEYMAP_COMMANDS) {
    const spec = keys[info.id];
    if (spec === undefined) continue;
    byKey.set(spec, [...(byKey.get(spec) ?? []), info.id]);
  }
  return [...byKey.entries()].filter(([, commands]) => commands.length > 1).map(([key, commands]) => ({ key, commands }));
}

// ---------------------------------------------------------------------------------------------
// The live keymap (what the canvas, the ribbon chips and the help sheet all read)
// ---------------------------------------------------------------------------------------------

let activeKeymap: SketchKeymap = DEFAULT_SKETCH_KEYMAP;
const listeners = new Set<() => void>();

export function getActiveSketchKeymap(): SketchKeymap {
  return activeKeymap;
}

export function setActiveSketchKeymap(keymap: SketchKeymap): void {
  activeKeymap = keymap;
  for (const listener of [...listeners]) listener();
}

/** For useSyncExternalStore: the callback runs whenever the live keymap changes. Returns the unsubscribe function. */
export function subscribeSketchKeymap(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** The key a command has in `keymap` as plain text ("L", "Shift+R"), or undefined when it has none. */
export function keyLabelForCommand(id: SketchCommandId, keymap: SketchKeymap = activeKeymap): string | undefined {
  return keymap.keys[id];
}

/** The ribbon-sized form of a key: Shift+R becomes "⇧R". */
export function shortKeyLabel(spec: string): string {
  return spec.replace(/^Shift\+/, "⇧");
}

function commandIdForTool(toolId: string): string {
  if (toolId === "select") return "select-tool";
  if (toolId === "dimension") return "dimension";
  if (COMMAND_BY_ID.has(`tool:${toolId}`)) return `tool:${toolId}`;
  if (COMMAND_BY_ID.has(`edit:${toolId}`)) return `edit:${toolId}`;
  return toolId;
}

/**
 * The key that selects a sketch tool or opens an edit tool, from the live keymap, as text ("L", "Shift+R"). Undefined when
 * the tool has no key, so a chip is only printed for a key that works. `toolId` is a drawing tool id ("rectangle-center"),
 * an edit tool id ("trim") or "select" / "dimension".
 */
export function keyLabelForTool(toolId: string, keymap: SketchKeymap = activeKeymap): string | undefined {
  return keymap.keys[commandIdForTool(toolId) as SketchCommandId];
}

/** Same as keyLabelForTool but in the short chip form ("⇧R"). */
export function keyChipForTool(toolId: string, keymap: SketchKeymap = activeKeymap): string | undefined {
  const label = keyLabelForTool(toolId, keymap);
  return label === undefined ? undefined : shortKeyLabel(label);
}

function actionForCommand(id: SketchCommandId): SketchHotkeyAction | undefined {
  if (id.startsWith("tool:")) return { kind: "tool", tool: id.slice(5) as Exclude<SketchTool, "select"> };
  if (id.startsWith("edit:")) return { kind: "edit-tool", tool: id.slice(5) as SketchEditHotkeyTool };
  switch (id) {
    case "dimension": return { kind: "dimension" };
    case "toggle-construction": return { kind: "toggle-construction" };
    case "toggle-draw-construction": return { kind: "toggle-draw-construction" };
    case "fit": return { kind: "fit" };
    case "pan-mode": return { kind: "pan-mode" };
    case "select-tool": return { kind: "select-tool" };
    case "toggle-snap": return { kind: "toggle-snap" };
    case "toggle-ortho": return { kind: "toggle-ortho" };
    case "toggle-polar": return { kind: "toggle-polar" };
    default: return undefined;
  }
}

/** The key spec an input produces: a Latin letter from `key`, otherwise the physical key's letter; F2 to F12 by name. */
export function keySpecOfInput(input: Pick<SketchHotkeyInput, "key" | "code" | "shift">): string | undefined {
  let name: string | undefined;
  if (/^[a-zA-Z]$/.test(input.key)) name = input.key.toUpperCase();
  else if (/^F([2-9]|1[0-2])$/.test(input.key)) name = input.key;
  else if (input.code !== undefined && /^Key[A-Z]$/.test(input.code)) name = input.code.slice(3);
  if (name === undefined) return undefined;
  return input.shift ? `Shift+${name}` : name;
}

export function resolveSketchHotkey(input: SketchHotkeyInput, context: SketchHotkeyContext, keymap: SketchKeymap = activeKeymap): SketchHotkeyAction | undefined {
  if (input.alt) return undefined;
  const key = input.key.length === 1 ? input.key.toLowerCase() : input.key;
  if (input.ctrl || input.meta) {
    if (input.shift) return undefined;
    if (key === "a") return { kind: "select-all" };
    if (key === "c" && context.curveSelectionCount > 0) return { kind: "copy" };
    if (key === "x" && context.curveSelectionCount > 0) return { kind: "cut" };
    if (key === "v" && context.pendingPoints === 0) return { kind: "paste" };
    return undefined;
  }

  if (key === "Escape") {
    // Escape backs out one level at a time: a drag in progress, points being placed, then a pick mode, a dimension or edit tool, then the drawing tool, then the selection.
    if (context.dragging) return { kind: "cancel-drag" };
    if (context.pendingPoints > 0) return { kind: "cancel-points" };
    if (context.pickingRelation) return { kind: "exit-pick" };
    if (context.dimensionMode) return { kind: "exit-dimension" };
    if (context.editToolActive) return { kind: "exit-edit-tool" };
    if (context.tool !== "select") return { kind: "select-tool" };
    if (context.selectionCount > 0) return { kind: "clear-selection" };
    return undefined;
  }
  if (key === "Backspace") {
    if (context.pendingPoints > 0) return { kind: "undo-point" };
    return context.curveSelectionCount > 0 ? { kind: "delete-selection" } : undefined;
  }
  if (key === "Delete") {
    if (context.pendingPoints > 0) return { kind: "cancel-points" };
    return context.curveSelectionCount > 0 ? { kind: "delete-selection" } : undefined;
  }
  if (key === "Enter") {
    if (context.dynamicFieldCount > 0 && context.dynamicTyped === true) return { kind: "commit-dynamic" };
    return ((context.tool === "spline" || context.tool === "spline-control") && context.pendingPoints >= 3) || (context.tool === "profile" && context.pendingPoints >= 1) ? { kind: "finish" } : undefined;
  }
  if (key === "Tab") {
    if (context.dynamicFieldCount > 0) return input.shift ? undefined : { kind: "focus-dynamic" };
    if (context.tool === "select" && (context.overlapUnderCursor ?? 0) >= 2) return { kind: "select-other" };
    return undefined;
  }
  if (context.dynamicFieldCount > 0 && /^[0-9.,-]$/.test(input.key)) return { kind: "type-value", key: input.key };

  const spec = keySpecOfInput(input);
  if (spec === undefined) return undefined;
  const command = keymap.commands.get(spec);
  return command === undefined ? undefined : actionForCommand(command);
}

/** Human-readable shortcut rows for the help sheet, read from a keymap (the live one by default). */
export function sketchHotkeyHelp(keymap: SketchKeymap = activeKeymap): readonly { readonly keys: string; readonly action: string }[] {
  const rows: { keys: string; action: string }[] = [];
  for (const info of SKETCH_KEYMAP_COMMANDS) {
    const spec = keymap.keys[info.id];
    if (spec !== undefined) rows.push({ keys: spec, action: info.label });
  }
  return [
    ...rows,
    { keys: "Tab / Shift+Tab", action: "Next / previous typed-input field; over overlapping curves, Select Other" },
    { keys: "Enter", action: "Place the typed point; finish a spline or a profile" },
    { keys: "Esc", action: "Cancel the pending point, then the tool, then the selection" },
    { keys: "Backspace", action: "Remove the last placed point" },
    { keys: "Delete", action: "Delete the selected curves" },
    { keys: "Hold Ctrl", action: "Snapping off while held" },
    { keys: "Hold Shift", action: "Constrain to horizontal / vertical (square for rectangles)" },
    { keys: "Alt+click", action: "Select Other: cycle through overlapping curves" },
    { keys: "Ctrl+A", action: "Select every visible curve" },
    { keys: "Ctrl+C / Ctrl+X / Ctrl+V", action: "Copy, cut and paste the selected curves with their relations" },
    { keys: "Wheel", action: "Zoom at the cursor" },
    { keys: "Middle drag / Space drag", action: "Pan" }
  ];
}

/** The help rows for the default keymap, kept for callers that do not follow the user's changes. */
export const SKETCH_HOTKEY_HELP: readonly { readonly keys: string; readonly action: string }[] = sketchHotkeyHelp(DEFAULT_SKETCH_KEYMAP);
