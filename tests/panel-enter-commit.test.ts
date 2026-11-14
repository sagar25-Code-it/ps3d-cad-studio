import { openCommandPanel, panelGlobalKeyCommits, panelSetHolePoint } from "../apps/studio-web/src/command-panel.js";
import { assert, type TestCase } from "./test-kit.js";

/**
 * PT-14: the command panel's footer says "Enter commits · Esc cancels", and Enter must keep that promise after the user
 * has clicked in the 3D view (focus then sits on the canvas or the body, outside the panel). The window-level listener in
 * App.tsx asks `panelGlobalKeyCommits` whether a key press commits; these tests pin that decision from every focus spot.
 */

const onCanvas = { panelOpen: true, editableTarget: false, dialogOpen: false, busy: false };

export const panelEnterCommitTests: readonly TestCase[] = [
  {
    name: "Enter commits the open command panel when focus sits outside it — the advertised pick-then-Enter flow",
    run: () => {
      assert(panelGlobalKeyCommits("Enter", onCanvas), "Enter with focus on the canvas or body commits");
      // The exact flow of the Fillet / Shell / Hole promise: open, pick in the view (focus leaves the panel), Enter.
      let state = openCommandPanel("hole");
      state = panelSetHolePoint(state, [10, 5, 20], [0, 0, 1], "general-body:block", "Block");
      assert(panelGlobalKeyCommits("Enter", { ...onCanvas, panelOpen: state !== null }), "after a canvas pick, Enter still reaches the commit");
    }
  },
  {
    name: "The global Enter stands aside wherever someone else owns the key: no panel, a field, a dialog, or a running commit",
    run: () => {
      assert(!panelGlobalKeyCommits("Enter", { ...onCanvas, panelOpen: false }), "no panel open: Enter is not captured");
      assert(!panelGlobalKeyCommits("Enter", { ...onCanvas, editableTarget: true }), "focus in an input or select: that control (or the panel's own handler) owns Enter");
      assert(!panelGlobalKeyCommits("Enter", { ...onCanvas, dialogOpen: true }), "a modal dialog owns the keyboard");
      assert(!panelGlobalKeyCommits("Enter", { ...onCanvas, busy: true }), "a commit already running is not doubled");
      assert(!panelGlobalKeyCommits("Escape", onCanvas), "Escape goes through its own cancel path, not the commit");
      assert(!panelGlobalKeyCommits("e", onCanvas), "ordinary letters never commit");
    }
  }
];
