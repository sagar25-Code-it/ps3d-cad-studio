/**
 * Pure logic of the marking menu: the radial menu that opens on right-click. It picks the eight most relevant commands
 * for what was clicked (sketch curve, body, face, or empty space) from the same command list the ordinary context menu
 * uses, so enabled states and reasons stay in one place, lays them out round a circle, and maps pointer and keyboard
 * input to a slot.
 */

import { resolveWorkbenchContextCommands, type WorkbenchContextCommand, type WorkbenchContextRequest, type WorkbenchSelectionKind } from "../../../../packages/workbench-core/src/index.js";

export type MarkingContext = "sketch" | "body" | "face" | "empty";

export interface MarkingItem {
  /** A context-command id, or an `analysis:` id handled by the analysis layer. */
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly shortcut?: string;
}

export interface MarkingMenuModel {
  readonly context: MarkingContext;
  readonly title: string;
  /** Up to eight items, clockwise from the top. */
  readonly items: readonly MarkingItem[];
}

export interface MarkingRequest extends WorkbenchContextRequest {
  /** A face of the selected body is picked. */
  readonly faceSelected?: boolean;
  /** Number of solid bodies, for the analysis entries. */
  readonly bodyCount?: number;
}

export const MARKING_SLOTS = 8;

/** Candidate commands per context, most relevant first; the first eight that exist (and are offered) make the menu. */
const CANDIDATES: Readonly<Record<MarkingContext, readonly string[]>> = {
  sketch: ["sketch.dimension", "sketch.finish", "sketch.toggle-construction", "selection.delete", "sketch.select-connected", "sketch.select-tangent", "selection.toggle-visibility", "sketch.look-at", "sketch.edit", "history.undo", "history.redo", "view.fit"],
  body: ["body.appearance", "selection.toggle-visibility", "body.boolean-join", "body.boolean-cut", "analysis:geometry-check", "analysis:interference", "sketch.create", "body.create-component", "selection.delete", "view.fit"],
  face: ["body.offset-face", "body.move-face", "sketch.create", "body.draft", "analysis:draft", "body.delete-face", "inspect.measure", "analysis:wall-thickness", "view.fit"],
  empty: ["sketch.create", "inspect.measure", "analysis:geometry-check", "analysis:interference", "view.fit", "view.home", "history.undo", "history.redo"]
};

const ANALYSIS_ITEMS: Readonly<Record<string, { readonly label: string; readonly icon: string }>> = {
  "analysis:geometry-check": { label: "Check geometry", icon: "inspect" },
  "analysis:interference": { label: "Interference", icon: "interference" },
  "analysis:draft": { label: "Draft analysis", icon: "draft" },
  "analysis:wall-thickness": { label: "Wall thickness", icon: "section" }
};

export function markingContextOf(request: MarkingRequest): MarkingContext {
  const kind: WorkbenchSelectionKind = request.selectionKind ?? "empty";
  if (request.workspace === "sketch" || kind === "sketch" || kind === "profile") return "sketch";
  if (kind === "body") return request.faceSelected === true ? "face" : "body";
  return "empty";
}

function flatten(commands: readonly WorkbenchContextCommand[]): Map<string, WorkbenchContextCommand> {
  const map = new Map<string, WorkbenchContextCommand>();
  for (const entry of commands) {
    map.set(entry.id, entry);
    for (const child of entry.children ?? []) map.set(child.id, child);
  }
  return map;
}

export function buildMarkingMenu(request: MarkingRequest): MarkingMenuModel {
  const context = markingContextOf(request);
  const available = flatten(resolveWorkbenchContextCommands(request));
  const hasBodies = (request.bodyCount ?? 0) > 0;
  const candidates: MarkingItem[] = [];
  for (const id of CANDIDATES[context]) {
    const analysis = ANALYSIS_ITEMS[id];
    if (analysis !== undefined) {
      // Analysis tools belong to the Part workspace.
      if (request.workspace !== "part") continue;
      candidates.push({ id, label: analysis.label, icon: analysis.icon, enabled: hasBodies, ...(hasBodies ? {} : { disabledReason: "Create a solid body first." }) });
      continue;
    }
    const found = available.get(id);
    // Finishing the sketch is always one flick away in the sketch workspace, even when the click landed on a curve.
    if (found === undefined && id === "sketch.finish" && request.workspace === "sketch") {
      candidates.push({ id, label: "Finish sketch", icon: "finish", enabled: true });
      continue;
    }
    if (found === undefined) continue;
    candidates.push({
      id: found.id,
      label: shortLabel(found.label),
      icon: found.icon,
      enabled: found.enabled,
      ...(found.disabledReason === undefined ? {} : { disabledReason: found.disabledReason }),
      ...(found.shortcut === undefined ? {} : { shortcut: found.shortcut })
    });
  }
  // Commands that can run now take the slots first, so the menu is never mostly greyed out; disabled ones fill what is left.
  const items = [...candidates.filter((item) => item.enabled), ...candidates.filter((item) => !item.enabled)].slice(0, MARKING_SLOTS);
  const title = context === "sketch" ? "Sketch" : context === "face" ? "Face" : context === "body" ? "Body" : "Canvas";
  return { context, title, items };
}

function shortLabel(label: string): string {
  return label
    .replace("Show / Hide Sketch Entity", "Show / Hide")
    .replace("Delete Sketch Entity", "Delete")
    .replace("Normal / Construction", "Construction")
    .replace("Select Connected Curves", "Connected")
    .replace("Select Tangent Chain", "Tangent chain")
    .replace("Create Component from Body", "Make component")
    .replace("Delete Face / Heal", "Delete face")
    .replace("Look At sketch plane", "Look at")
    .replace("Create Sketch", "Sketch")
    .replace("Show / Hide Body", "Show / Hide")
    .replace("Home / Isometric", "Home");
}

// -- geometry ---------------------------------------------------------------------------------

/** Angle of slot `index` in degrees clockwise from straight up. */
export function slotAngleDeg(index: number, count = MARKING_SLOTS): number {
  return (360 / count) * index;
}

/** Centre of slot `index` relative to the menu centre, in pixels (y grows downward). */
export function slotOffset(index: number, radius: number, count = MARKING_SLOTS): { readonly x: number; readonly y: number } {
  const angle = slotAngleDeg(index, count) * Math.PI / 180;
  return { x: Math.round(Math.sin(angle) * radius * 1000) / 1000, y: Math.round(-Math.cos(angle) * radius * 1000) / 1000 };
}

/** The slot a pointer movement from the centre points at, or null inside the dead zone. */
export function slotFromPointer(dx: number, dy: number, itemCount: number, deadZone = 28): number | null {
  if (itemCount <= 0 || Math.hypot(dx, dy) < deadZone) return null;
  const clockwiseFromUp = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
  const slot = Math.round(clockwiseFromUp / (360 / MARKING_SLOTS)) % MARKING_SLOTS;
  return slot < itemCount ? slot : null;
}

export type MarkingKey = "ArrowUp" | "ArrowRight" | "ArrowDown" | "ArrowLeft" | "Tab" | "Shift+Tab" | "Home" | "End";

/** Where keyboard focus goes next. Arrows jump to the slot in that direction (the nearest enabled one); Tab walks clockwise. */
export function nextSlot(current: number, key: MarkingKey, items: readonly Pick<MarkingItem, "enabled">[]): number {
  const count = items.length;
  if (count === 0) return 0;
  const enabled = (slot: number): boolean => items[slot]?.enabled === true;
  const walk = (from: number, step: 1 | -1): number => {
    for (let hop = 1; hop <= count; hop += 1) {
      const slot = ((from + step * hop) % count + count) % count;
      if (enabled(slot)) return slot;
    }
    return from;
  };
  if (key === "Tab") return walk(current, 1);
  if (key === "Shift+Tab") return walk(current, -1);
  if (key === "Home") return enabled(0) ? 0 : walk(0, 1);
  if (key === "End") return enabled(count - 1) ? count - 1 : walk(count - 1, -1);
  const target = key === "ArrowUp" ? 0 : key === "ArrowRight" ? 2 : key === "ArrowDown" ? 4 : 6;
  // Prefer the slot exactly in that direction, then its neighbours either side, then anything.
  for (const offset of [0, 1, -1, 2, -2]) {
    const slot = ((target + offset) % MARKING_SLOTS + MARKING_SLOTS) % MARKING_SLOTS;
    if (slot < count && enabled(slot)) return slot;
  }
  return current;
}

/** Keeps the menu centre far enough from the window edges that all eight items stay visible. */
export function clampMenuCenter(x: number, y: number, viewport: { readonly width: number; readonly height: number }, margin = 182): { readonly x: number; readonly y: number } {
  const clamp = (value: number, size: number): number => size <= 2 * margin ? size / 2 : Math.max(margin, Math.min(size - margin, value));
  return { x: clamp(x, viewport.width), y: clamp(y, viewport.height) };
}
