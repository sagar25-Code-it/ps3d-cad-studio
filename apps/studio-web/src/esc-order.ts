/**
 * Who owns the Esc key. Several things listen for it at once (a dialog, an open menu, a running tool or pick, the shared
 * command panel, the Extrude / Revolve panel, the docked Edit Feature panel), and each one must act only when it is the
 * innermost thing open. These are the pure rules, so the order is tested without a window.
 *
 * The bug this fixes: the ribbon's panel drop-downs are `role="menu"` elements that live inside a closed <details>, so
 * a plain `querySelector('[role="menu"]')` found one all the time in the Part tab, "another menu is open" was always
 * true, and Esc never closed the docked Edit panel from the canvas (nor did S open command search). A surface counts as
 * open only when the user can see it.
 */

/** The part of an element the openness test needs (a DOM Element satisfies it; tests pass plain objects). */
export interface SurfaceElementLike {
  readonly hidden?: boolean;
  closest(selector: string): unknown;
  getAttribute(name: string): string | null;
}

/** A dialog or menu element is open when it is not hidden and not inside a closed <details>. */
export function surfaceElementOpen(element: SurfaceElementLike): boolean {
  if (element.hidden === true) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  return element.closest("details:not([open])") === null && element.closest("[hidden]") === null;
}

/** What `querySelectorAll` of a document gives back, as much as the check needs. */
export interface SurfaceDocumentLike {
  querySelectorAll(selector: string): Iterable<SurfaceElementLike>;
}

/** True when a visible dialog or menu is open: it owns the keyboard, with its own Esc. */
export function anotherSurfaceOpen(doc: SurfaceDocumentLike, selector = '[role="dialog"], [role="menu"]'): boolean {
  for (const element of doc.querySelectorAll(selector)) if (surfaceElementOpen(element)) return true;
  return false;
}

export interface EscapeContext {
  /** A visible dialog or menu is open (it has its own Esc). */
  readonly otherSurfaceOpen: boolean;
  /** Focus is in a text field that is not part of the surface asking (an inline rename, the timeline rename). */
  readonly foreignTextFieldFocused: boolean;
  /** A viewport pick that is not the command panel's own is waiting for a click (it ends on Esc by itself). */
  readonly pendingPick: boolean;
  /** A sketch tool or another running tool owns Esc. */
  readonly toolRunning: boolean;
  /** The shared Fillet / Chamfer / Shell / Hole panel is open. */
  readonly commandPanelOpen: boolean;
  /** The Extrude / Revolve panel is open. */
  readonly partCreateOpen: boolean;
  /** The docked Edit Feature panel is open. */
  readonly editPanelOpen: boolean;
  /** A commit is running: Esc must not tear the panel away from under it. */
  readonly busy: boolean;
}

export type EscapeOwner = "other-surface" | "text-field" | "tool" | "pick" | "command-panel" | "part-create-panel" | "edit-panel" | "none";

/** The innermost thing Esc belongs to, in order: a dialog or menu, a text field being edited, a running tool, a pick, then the panels. */
export function escapeOwner(context: EscapeContext): EscapeOwner {
  if (context.otherSurfaceOpen) return "other-surface";
  if (context.foreignTextFieldFocused) return "text-field";
  if (context.toolRunning) return "tool";
  if (context.commandPanelOpen) return "command-panel";
  if (context.pendingPick) return "pick";
  if (context.partCreateOpen && !context.busy) return "part-create-panel";
  if (context.editPanelOpen) return "edit-panel";
  return "none";
}

/** What the caller knows about the app; the DOM facts are added where the listener runs. */
export type EscapeAppFlags = Pick<EscapeContext, "pendingPick" | "toolRunning" | "commandPanelOpen" | "partCreateOpen" | "busy">;

export const NO_ESCAPE_FLAGS: EscapeAppFlags = { pendingPick: false, toolRunning: false, commandPanelOpen: false, partCreateOpen: false, busy: false };

export const escapeClosesEditPanel = (context: EscapeContext): boolean => escapeOwner(context) === "edit-panel";
export const escapeCancelsPartCreate = (context: EscapeContext): boolean => escapeOwner(context) === "part-create-panel";

/** Enter/Esc keys of the Extrude / Revolve panel when focus is not inside it. */
export type PartCreateKey = "commit" | "cancel";

/**
 * The window-level keys of the Extrude / Revolve panel (focus inside the panel is the panel's own handler). Enter commits
 * unless a field, a dialog or a commit in progress has it; Esc cancels only when the panel is the innermost thing open.
 */
export function partCreateWindowKey(key: string, input: { readonly context: EscapeContext; readonly editableTarget: boolean }): PartCreateKey | undefined {
  if (key === "Enter") return input.context.partCreateOpen && !input.editableTarget && !input.context.otherSurfaceOpen && !input.context.busy ? "commit" : undefined;
  if (key === "Escape") return escapeCancelsPartCreate(input.context) ? "cancel" : undefined;
  return undefined;
}
