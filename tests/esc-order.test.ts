import {
  anotherSurfaceOpen, escapeCancelsPartCreate, escapeClosesEditPanel, escapeOwner, NO_ESCAPE_FLAGS, partCreateWindowKey, surfaceElementOpen,
  type EscapeContext, type SurfaceElementLike
} from "../apps/studio-web/src/esc-order.js";
import { dockClosesOnKey } from "../apps/studio-web/src/ui/docked-panel.js";
import { assert, type TestCase } from "./test-kit.js";

/**
 * Esc ordering. The ribbon's panel drop-downs are role="menu" elements inside a closed <details>, present in the page at
 * all times in the Part tab; a plain "any menu in the page" test made Esc never close the docked Edit panel from the canvas.
 * These tests drive the decision as pure functions with stand-in elements.
 */

const BASE: EscapeContext = { ...NO_ESCAPE_FLAGS, otherSurfaceOpen: false, foreignTextFieldFocused: false, editPanelOpen: false };

/** A stand-in element: it is inside a closed <details> when `closedDetails` is set, or inside a [hidden] box. */
function element(options: { readonly closedDetails?: boolean; readonly hiddenAncestor?: boolean; readonly hidden?: boolean; readonly ariaHidden?: boolean } = {}): SurfaceElementLike {
  return {
    ...(options.hidden === undefined ? {} : { hidden: options.hidden }),
    closest: (selector: string) => (selector === "details:not([open])" ? (options.closedDetails === true ? {} : null) : selector === "[hidden]" ? (options.hiddenAncestor === true ? {} : null) : null),
    getAttribute: (name: string) => (name === "aria-hidden" && options.ariaHidden === true ? "true" : null)
  };
}

export const escOrderTests: readonly TestCase[] = [
  {
    name: "A menu inside a closed <details> (the ribbon's drop-downs) is not an open surface, so Esc still reaches the docked Edit panel",
    run: () => {
      assert(!surfaceElementOpen(element({ closedDetails: true })), "a drop-down in a closed details is not open");
      assert(surfaceElementOpen(element()), "a visible dialog or menu is open");
      assert(!surfaceElementOpen(element({ hidden: true })) && !surfaceElementOpen(element({ hiddenAncestor: true })) && !surfaceElementOpen(element({ ariaHidden: true })), "hidden things are not open");
      const closedRibbon = { querySelectorAll: () => [element({ closedDetails: true }), element({ closedDetails: true }), element({ closedDetails: true })] };
      assert(!anotherSurfaceOpen(closedRibbon), "three closed Create / Modify / Construct drop-downs do not count as an open menu");
      const oneOpen = { querySelectorAll: () => [element({ closedDetails: true }), element()] };
      assert(anotherSurfaceOpen(oneOpen), "a drop-down that is open does");
      // The old test, kept as the regression: any [role=menu] in the page counted, so this was true and Esc did nothing.
      const oldTest = closedRibbon.querySelectorAll().length > 0;
      assert(oldTest && !anotherSurfaceOpen(closedRibbon), "the old 'is there any menu element' answer was wrong for the ribbon");
      const press = { key: "Escape", defaultPrevented: false, otherSurfaceOpen: anotherSurfaceOpen(closedRibbon) };
      assert(dockClosesOnKey(press), "with only closed drop-downs, Esc from the canvas closes the Edit panel");
    }
  },
  {
    name: "Esc order: a dialog or menu, a text field elsewhere, a running tool, the command panel, a pending pick, then the Extrude / Revolve panel, then the Edit panel",
    run: () => {
      const edit = { ...BASE, editPanelOpen: true };
      assert(escapeOwner(edit) === "edit-panel" && escapeClosesEditPanel(edit), "alone, the Edit panel owns Esc");
      assert(escapeOwner({ ...edit, otherSurfaceOpen: true }) === "other-surface" && !escapeClosesEditPanel({ ...edit, otherSurfaceOpen: true }), "a dialog or open menu on top takes its own Esc");
      assert(escapeOwner({ ...edit, foreignTextFieldFocused: true }) === "text-field", "an inline rename elsewhere keeps its Esc");
      assert(escapeOwner({ ...edit, toolRunning: true }) === "tool" && !escapeClosesEditPanel({ ...edit, toolRunning: true }), "a running tool is cancelled first");
      assert(escapeOwner({ ...edit, pendingPick: true }) === "pick" && !escapeClosesEditPanel({ ...edit, pendingPick: true }), "a pick waiting for a click ends first");
      assert(escapeOwner({ ...edit, commandPanelOpen: true }) === "command-panel", "the Fillet / Shell / Hole panel is cancelled first");
      assert(escapeOwner({ ...edit, commandPanelOpen: true, pendingPick: true }) === "command-panel", "the command panel's own pick is part of the panel");
      assert(escapeOwner({ ...BASE, partCreateOpen: true }) === "part-create-panel" && escapeCancelsPartCreate({ ...BASE, partCreateOpen: true }), "the Extrude / Revolve panel owns Esc on its own");
      assert(escapeOwner({ ...edit, partCreateOpen: true }) === "part-create-panel", "the Extrude / Revolve panel goes before the Edit panel");
      assert(escapeOwner({ ...BASE, partCreateOpen: true, busy: true }) === "none", "while a build runs Esc does not tear the panel away");
      assert(escapeOwner(BASE) === "none" && !escapeClosesEditPanel(BASE) && !escapeCancelsPartCreate(BASE), "nothing open: Esc is left to the selection clear");
    }
  },
  {
    name: "Extrude / Revolve window keys: Enter commits from the canvas, Esc cancels only when it is the innermost thing, neither fires from a field, dialog or running commit",
    run: () => {
      const open = { ...BASE, partCreateOpen: true };
      assert(partCreateWindowKey("Enter", { context: open, editableTarget: false }) === "commit", "Enter on the canvas commits");
      assert(partCreateWindowKey("Enter", { context: open, editableTarget: true }) === undefined, "Enter in some other field keeps its own meaning");
      assert(partCreateWindowKey("Enter", { context: { ...open, otherSurfaceOpen: true }, editableTarget: false }) === undefined, "a dialog owns Enter");
      assert(partCreateWindowKey("Enter", { context: { ...open, busy: true }, editableTarget: false }) === undefined, "a commit already running is not doubled");
      assert(partCreateWindowKey("Enter", { context: BASE, editableTarget: false }) === undefined, "no panel open: not ours");
      assert(partCreateWindowKey("Escape", { context: open, editableTarget: false }) === "cancel", "Esc on the canvas cancels the panel");
      assert(partCreateWindowKey("Escape", { context: { ...open, pendingPick: true }, editableTarget: false }) === undefined, "a pending pick takes the first Esc");
      assert(partCreateWindowKey("Escape", { context: { ...open, otherSurfaceOpen: true }, editableTarget: false }) === undefined, "an open menu takes it");
      assert(partCreateWindowKey("Escape", { context: { ...open, busy: true }, editableTarget: false }) === undefined, "not while it builds");
      assert(partCreateWindowKey("a", { context: open, editableTarget: false }) === undefined, "other keys are not ours");
    }
  }
];
