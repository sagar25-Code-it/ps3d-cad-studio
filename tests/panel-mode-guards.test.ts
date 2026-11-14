import { openCommandPanel, openCommandPanelForEdit, panelNavigationLock, panelReopenPlan, panelToggleEdge, type PanelEdgeSet } from "../apps/studio-web/src/command-panel.js";
import { hotkeyCancelsPanel, PART_HOTKEYS } from "../apps/studio-web/src/part-hotkeys.js";
import type { DesignSolidFeature } from "../packages/workbench-core/src/index.js";
import { assert, type TestCase } from "./test-kit.js";

/**
 * PT-15: while a command runs, the canvas stays in its picking mode and every control that would disconnect it answers
 * out loud. `panelNavigationLock` is what App.setViewportNavigation shows instead of switching Select / Orbit / Pan /
 * Measure under an open panel; `panelReopenPlan` is what starting a panel command does when one is already open (the same
 * command keeps its picks, another cancels visibly); `hotkeyCancelsPanel` names the letters that must close the panel
 * before starting their own flow, so no live-looking panel is ever left with its picks going nowhere.
 */

const edgePick: PanelEdgeSet = {
  bodyId: "general-body:block", chain: 7, group: { segments: [[[0, 0, 0], [1, 0, 0]]] },
  segments: [[[0, 0, 0], [1, 0, 0]]], summary: "an edge"
};

export const panelModeGuardTests: readonly TestCase[] = [
  {
    name: "A navigation-mode switch under an open panel is answered, not silently obeyed — and switches freely once the panel is closed",
    run: () => {
      assert(panelNavigationLock(null) === undefined, "no panel: Select / Orbit / Pan switch as always");
      const lock = panelNavigationLock(openCommandPanel("fillet"));
      assert(lock !== undefined, "an open panel locks the picking mode");
      assert(/Fillet/.test(lock ?? "") && /pick/.test(lock ?? "") && /Esc cancels/.test(lock ?? ""), `the answer names the command, says clicks pick for it and how to leave: ${lock}`);
      assert(/middle/.test(lock ?? ""), "the answer says the camera is still available through the drag gestures");
    }
  },
  {
    name: "Pressing the running command's own letter keeps its picks; another command cancels the old one out loud",
    run: () => {
      let fillet = openCommandPanel("fillet");
      fillet = panelToggleEdge(fillet, edgePick, "Block");
      const again = panelReopenPlan(fillet, "fillet");
      assert(again.kind === "keep", "F while Fillet runs keeps the panel and its picked runs");
      assert(again.kind === "keep" && /already running/.test(again.message), `and says so: ${again.kind === "keep" ? again.message : ""}`);
      const switched = panelReopenPlan(fillet, "hole");
      assert(switched.kind === "replace" && /Fillet cancelled/.test(switched.note), `H while Fillet runs cancels it by name: ${switched.kind === "replace" ? switched.note : ""}`);
      assert(/nothing changed/.test(switched.kind === "replace" ? switched.note : ""), "the cancel says the model is untouched");
      const fresh = panelReopenPlan(null, "shell");
      assert(fresh.kind === "replace" && fresh.note === "", "no panel open: the command starts with no cancel note");
      // A fresh command over an Edit Feature session restarts too (the edit session is not silently reused).
      const editing: DesignSolidFeature = {
        id: "feature:edge-blend-guard", name: "Fillet R 2 mm", kind: "edge-blend", suppressed: false,
        sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 2, bodyId: "general-body:block",
        operation: "direct-edit", blendType: "fillet", blendEdges: [edgePick.group]
      };
      const editPanel = openCommandPanelForEdit(editing, "Block");
      assert(editPanel !== undefined, "the edit panel opens");
      const overEdit = panelReopenPlan(editPanel ?? null, "fillet");
      assert(overEdit.kind === "replace" && /Edit Feature cancelled/.test(overEdit.note), "F over an Edit Feature session starts a new fillet and says the edit was cancelled");
    }
  },
  {
    name: "The letters that leave the shared panel cancel it first; picking, view and navigation letters never do",
    run: () => {
      assert(hotkeyCancelsPanel("extrude") && hotkeyCancelsPanel("press-pull") && hotkeyCancelsPanel("move"), "E, Q and M start flows outside the panel, so they close it first");
      assert(!hotkeyCancelsPanel("fillet") && !hotkeyCancelsPanel("hole"), "F and H run through the panel itself (panelReopenPlan keeps or restarts it)");
      for (const entry of PART_HOTKEYS.filter((candidate) => candidate.command.startsWith("nav-") || candidate.command.startsWith("view-") || candidate.command === "fit" || candidate.command === "measure" || candidate.command === "appearance")) {
        assert(!hotkeyCancelsPanel(entry.command), `${entry.key} (${entry.command}) leaves the running command alone`);
      }
    }
  }
];
