import { buildWorkbenchMenus, type WorkbenchMenuActions, type WorkbenchMenuState } from "../apps/studio-web/src/ui/menu-model.js";
import { assert, equal, type TestCase } from "./test-kit.js";

function recordingActions(): { readonly actions: WorkbenchMenuActions; readonly calls: string[] } {
  const calls: string[] = [];
  const record = (name: string) => () => { calls.push(name); };
  const actions: WorkbenchMenuActions = {
    onUndo: record("undo"), onRedo: record("redo"), onCommandPalette: record("palette"),
    onNewSketch: record("new-sketch"), onCreateSolidFromSketch: record("create-solid"),
    onCreatePrimitive: (shape) => { calls.push(`primitive:${shape}`); },
    onCombine: record("combine"), onInsertToAssembly: record("insert-assembly"),
    onMasterCart: record("master-cart"), onRenderStudio: record("render-studio"),
    onEditSelectedFeature: record("edit-feature"), onToggleSuppressSelected: record("suppress"),
    onDeleteSelected: record("delete"), onMoveSelectedBody: record("move"), onResizeSelectedBody: record("resize"),
    onFit: record("fit"), onHome: record("home"), onToggleGrid: record("grid"),
    onWorkspace: (workspace) => { calls.push(`workspace:${workspace}`); },
    onDesignHealth: record("health"), onMeasure: record("measure"), onExchange: record("exchange"),
    onAccess: record("access"), onConnectAi: record("connect-ai"), onExportStl: record("stl"), onPlateJson: record("plate-json"),
    onLearning: record("learning"), onShortcuts: record("shortcuts")
  };
  return { actions, calls };
}

const BASE: WorkbenchMenuState = {
  workspace: "part", masterCartOpen: false, renderStudioOpen: false, working: false,
  gridVisible: true, canUndo: false, canRedo: false, generalBodyCount: 0,
  previewBodySelected: false, selectionDeletable: false
};

const item = (menus: ReturnType<typeof buildWorkbenchMenus>, id: string) => {
  const found = menus.flatMap((menu) => menu.items).find((candidate) => candidate.id === id);
  assert(found !== undefined, `menu item ${id} exists`);
  return found;
};

export const menuModelTests: readonly TestCase[] = [
  {
    name: "the menubar holds seven menus of uniquely named, actionable items",
    run: () => {
      const { actions } = recordingActions();
      const menus = buildWorkbenchMenus(BASE, actions);
      equal(menus.map((menu) => menu.id).join(","), "edit,create,modify,view,inspect,tools,help", "menu order");
      const ids = menus.flatMap((menu) => menu.items.map((entry) => entry.id));
      equal(new Set(ids).size, ids.length, "item ids are unique");
      assert(menus.every((menu) => menu.items.length > 0), "no empty menu");
      assert(menus.flatMap((menu) => menu.items).every((entry) => typeof entry.action === "function"), "every item carries an action");
      assert(menus.flatMap((menu) => menu.items).filter((entry) => entry.disabled === true).every((entry) => entry.hint !== undefined), "every disabled item says why");
    }
  },
  {
    name: "items disable honestly: no history, nothing selected, one body, 2D workspace",
    run: () => {
      const { actions } = recordingActions();
      const part = buildWorkbenchMenus({ ...BASE, generalBodyCount: 1 }, actions);
      assert(item(part, "edit.undo").disabled === true, "undo disabled with no history");
      assert(item(part, "modify.edit-feature").disabled === true, "edit feature needs a selection");
      assert(item(part, "modify.combine").disabled === true, "combine needs two bodies");
      assert(item(part, "modify.move").disabled === true, "move needs a preview body");
      assert(item(part, "view.fit").disabled !== true, "fit works in the part workspace");
      const drawing = buildWorkbenchMenus({ ...BASE, workspace: "drawing" }, actions);
      assert(item(drawing, "view.fit").disabled === true, "fit disabled in a 2D workspace");
      assert(item(drawing, "inspect.measure").disabled === true, "measure disabled in a 2D workspace");
      const sketch = buildWorkbenchMenus({ ...BASE, workspace: "sketch" }, actions);
      assert(item(sketch, "view.grid").disabled !== true, "the grid toggles in the sketch workspace");
      const ready = buildWorkbenchMenus({ ...BASE, canUndo: true, generalBodyCount: 2, previewBodySelected: true }, actions);
      assert(item(ready, "edit.undo").disabled !== true, "undo enabled with history");
      assert(item(ready, "modify.combine").disabled !== true, "combine enabled with two bodies");
      assert(item(ready, "modify.move").disabled !== true, "move enabled with a preview body");
    }
  },
  {
    name: "a selected feature names itself in Modify and flips between Suppress and Unsuppress",
    run: () => {
      const { actions } = recordingActions();
      const live = buildWorkbenchMenus({ ...BASE, selectedFeature: { name: "Cut 1", suppressed: false, kind: "extrude" }, selectionDeletable: true }, actions);
      equal(item(live, "modify.edit-feature").label, "Edit Cut 1…", "edit names the feature");
      equal(item(live, "modify.suppress").label, "Suppress Cut 1", "suppress names the feature");
      assert(item(live, "modify.delete").disabled !== true, "delete enabled with a selection");
      const suppressed = buildWorkbenchMenus({ ...BASE, selectedFeature: { name: "Cut 1", suppressed: true, kind: "extrude" }, selectionDeletable: true }, actions);
      equal(item(suppressed, "modify.suppress").label, "Unsuppress Cut 1", "a suppressed feature offers Unsuppress");
    }
  },
  {
    name: "menu items dispatch to their handlers",
    run: () => {
      const { actions, calls } = recordingActions();
      const menus = buildWorkbenchMenus({ ...BASE, canUndo: true, generalBodyCount: 2 }, actions);
      item(menus, "create.block").action();
      item(menus, "create.sketch").action();
      item(menus, "tools.export-stl").action();
      item(menus, "view.drawing").action();
      item(menus, "help.shortcuts").action();
      equal(calls.join(","), "primitive:block,new-sketch,stl,workspace:drawing,shortcuts", "each item calls its own handler");
    }
  }
];
