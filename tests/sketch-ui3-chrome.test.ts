import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  CAD_COMMANDS,
  applyWorkbenchOperation,
  createWorkbenchProject,
  type SketchEntity,
  type WorkbenchOperation,
  type WorkbenchProject,
  type WorkbenchSketchConstraint
} from "../packages/workbench-core/src/index.js";
import { DEFAULT_SKETCH_KEYMAP, rebindKey } from "../packages/workbench-sketch/src/hotkeys.js";
import { DEFAULT_SNAP_ASSIST } from "../packages/workbench-sketch/src/snap-assist.js";
import { constraintAnchor, constraintsToDraw, layoutConstraintGlyphs } from "../packages/workbench-sketch/src/constraint-glyph-layout.js";
import { relationsEmptyHelp } from "../apps/studio-web/src/sketch-help-text.js";
import { DRAW_CONSTRUCTION_OFF_MESSAGE, drawConstructionOnMessage } from "../packages/workbench-sketch/src/draw-construction.js";
import { matchesCommandQuery } from "../apps/studio-web/src/ui/command-match.js";
import { searchableCommands } from "../apps/studio-web/src/ui/sketch-tool-commands.js";
import { ShortcutsOverlay } from "../apps/studio-web/src/ui/ShortcutsOverlay.js";
import { shortcutGroupsFor, sketchShortcutItems, type ShortcutGroup } from "../apps/studio-web/src/ui/sketch-shortcut-items.js";
import { describeFailure } from "../apps/studio-web/src/failure-text.js";
import { CentreMarker, CentrePickButton, centreFieldTexts, centreOfFields, isUnhandledPick, nextPickedCentre, snapPickedCentre, type CentrePickBridge } from "../apps/studio-web/src/workspaces/sketch/CentrePick.js";
import { SketchEditPanel } from "../apps/studio-web/src/workspaces/SketchEditPanel.js";
import { SketchPatternPanel } from "../apps/studio-web/src/workspaces/sketch/SketchPatternPanel.js";
import { DimensionMarks } from "../apps/studio-web/src/workspaces/sketch/DimensionMarks.js";
import { ExtraDimensionMarks } from "../apps/studio-web/src/workspaces/sketch/ConstraintExtras.js";
import { SelectOtherPopup } from "../apps/studio-web/src/workspaces/sketch/SelectOtherPopup.js";
import { checkSketch } from "../packages/workbench-sketch/src/edit-tools.js";
import { dimensionLayout } from "../packages/workbench-sketch/src/dimension-layout.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { renderWorkspaceMarkup } from "./sketch-ui3-dimensions.test.js";

/** Wave 3 (ui3): the shortcut list and tooltips follow the live keymap, command search reaches every ribbon command, the origin glyph, picking a centre, canvas accessibility. */

type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
let serial = 0;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:ui3-chrome-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  if (!result.ok) throw new Error(`${operation.kind} refused: ${result.diagnostics[0]?.message}`);
  return result.value.project;
}
const noop = (): undefined => undefined;
const repoFile = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const line = (id: string, start: [number, number], end: [number, number]): SketchEntity => ({ id, kind: "line", start, end, construction: false });

function projectWith(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchProject {
  const project = createWorkbenchProject("project:ui3-chrome");
  return { ...project, sketch: { ...project.sketch, entities, constraints } };
}

const BASE_GROUPS: readonly ShortcutGroup[] = [
  { title: "View & navigation", items: [{ keys: ["F"], label: "Fit all visible geometry" }] },
  { title: "Sketch canvas", items: [] },
  { title: "Panels", items: [{ keys: ["?"], label: "Show this shortcut list" }] }
];

/** The relative luminance contrast of two #rrggbb colours (WCAG 2). */
function contrast(foreground: string, background: string): number {
  const channel = (hex: string, offset: number): number => {
    const value = parseInt(hex.slice(1 + offset * 2, 3 + offset * 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (hex: string): number => 0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}

export const sketchUi3ChromeTests: readonly TestCase[] = [
  {
    name: "Re-audit UX R2-7 and N13: the global shortcut list is built from the live keymap, so a rebound key shows under its new key, and the other hard-coded key hints follow it too",
    run: () => {
      const rebound = rebindKey(DEFAULT_SKETCH_KEYMAP, "tool:line", "K");
      assert(rebound.ok, "Line can be moved to K");
      if (!rebound.ok) return;
      const defaults = shortcutGroupsFor(BASE_GROUPS, DEFAULT_SKETCH_KEYMAP).find((group) => group.title === "Sketch canvas")!;
      assert(defaults.items.some((item) => item.label === "Line" && item.keys[0] === "L"), "with the default keys Line is on L");
      const live = shortcutGroupsFor(BASE_GROUPS, rebound.keymap).find((group) => group.title === "Sketch canvas")!;
      assert(live.items.some((item) => item.label === "Line" && item.keys[0] === "K"), "after rebinding, the list says K");
      assert(!live.items.some((item) => item.label === "Line" && item.keys[0] === "L"), "and no longer says L");
      // Every other group passes through untouched.
      equal(shortcutGroupsFor(BASE_GROUPS, rebound.keymap)[0], BASE_GROUPS[0], "the view group is untouched");
      // A command whose key was removed is not listed under a key it no longer has.
      const removed = rebindKey(DEFAULT_SKETCH_KEYMAP, "dimension", undefined);
      assert(removed.ok, "a key can be removed");
      if (removed.ok) assert(!sketchShortcutItems(removed.keymap).some((item) => item.label === "Sketch dimension"), "Sketch dimension is not listed once it has no key");
      // The rendered overlay is a modal dialog showing the rebound key.
      const html = renderToStaticMarkup(createElement(ShortcutsOverlay, { open: true, groups: shortcutGroupsFor(BASE_GROUPS, rebound.keymap), onClose: noop }));
      assert(html.includes('role="dialog"') && html.includes('aria-modal="true"') && html.includes("data-dialog-initial-focus"), "the overlay is a modal dialog that takes focus into it");
      assert(html.includes("<kbd>K</kbd>") && html.includes("Line"), "and lists K for Line");
      equal(renderToStaticMarkup(createElement(ShortcutsOverlay, { open: false, groups: BASE_GROUPS, onClose: noop })), "", "closed, it renders nothing");
      // The overlay in the app no longer reads the constant default list.
      const app = repoFile("apps/studio-web/src/App.tsx");
      assert(!app.includes("SKETCH_HOTKEY_HELP") && app.includes("shortcutGroupsFor(SHORTCUT_GROUPS, sketchKeymap)"), "App builds the sketch group from the live keymap");
      // Help text that names a key follows the keymap as well.
      assert(relationsEmptyHelp(DEFAULT_SKETCH_KEYMAP).includes("press D"), "the Relations tab names D by default");
      const moved = rebindKey(DEFAULT_SKETCH_KEYMAP, "dimension", "J");
      assert(moved.ok && relationsEmptyHelp(moved.keymap).includes("press J") && !relationsEmptyHelp(moved.keymap).includes("press D"), "and J once Sketch dimension is moved there");
      if (removed.ok) assert(!relationsEmptyHelp(removed.keymap).includes("press ") && relationsEmptyHelp(removed.keymap).includes("ribbon"), "and the ribbon when it has no key");
      assert(drawConstructionOnMessage("Q").includes("Press Q") && drawConstructionOnMessage("Z").includes("Press Z") && !drawConstructionOnMessage(undefined).includes("Press"), "Draw as construction names the key it has now");
      assert(DRAW_CONSTRUCTION_OFF_MESSAGE.length > 0, "and its off message is unchanged");
      const chrome = repoFile("apps/studio-web/src/ui/ViewportChrome.tsx");
      assert(chrome.includes('keyLabelForCommand("pan-mode"') && !chrome.includes("pans the sketch (P)"), "the Pan tooltip reads its key from the keymap");
    }
  },
  {
    name: "Re-audit UX R2-8: command search reaches the seven ribbon commands it missed (elliptical arc, 3-tangent and 2-tangent circles, Break, Import and Export DXF/SVG, Picture) and every other ribbon sketch tool",
    run: () => {
      const commands = searchableCommands();
      const find = (query: string): readonly string[] => commands.filter((command) => matchesCommandQuery(command, query)).map((command) => `${command.action.kind}:${"tool" in command.action ? command.action.tool : ""}`);
      assert(find("elliptical arc").includes("activate-sketch-tool:ellipse-arc"), "Elliptical arc is found");
      assert(find("tangent circle").includes("activate-sketch-tool:circle-tangent-3") && find("tangent circle").includes("activate-sketch-tool:circle-tangent-2"), "the 3-tangent and 2-tangent circles are found");
      assert(find("break").includes("activate-sketch-edit:break"), "Break is found");
      assert(find("dxf").includes("activate-sketch-edit:import-drawing") && find("dxf").includes("activate-sketch-edit:export-drawing"), "Import and Export DXF are found");
      assert(find("svg").includes("activate-sketch-edit:import-drawing") && find("svg").includes("activate-sketch-edit:export-drawing"), "and by SVG");
      assert(find("picture").includes("activate-sketch-edit:underlay") && find("trace").includes("activate-sketch-edit:underlay"), "Picture is found by picture and by trace");
      // Every tool the ribbon can start is in the search, by reading the ribbon's own source.
      const ribbon = repoFile("apps/studio-web/src/ui/WorkbenchRibbon.tsx");
      const toolIds = [...ribbon.matchAll(/\{ id: "([a-z0-9-]+)", icon:/gu)].map((match) => match[1]!).concat([...ribbon.matchAll(/onSketchTool\("([a-z0-9-]+)"\)/gu)].map((match) => match[1]!));
      const editIds = [...ribbon.matchAll(/onSketchEditTool\("([a-z0-9-]+)"\)/gu)].map((match) => match[1]!);
      const commandIds = [...ribbon.matchAll(/onSketchCommand\("([a-z0-9-]+)"\)/gu)].map((match) => match[1]!);
      assert(toolIds.length > 25 && editIds.length > 20 && commandIds.length >= 10, `the ribbon source was read (${toolIds.length} tools, ${editIds.length} edit tools, ${commandIds.length} commands)`);
      const have = new Set(commands.map((command) => `${command.action.kind}:${"tool" in command.action ? command.action.tool : "command" in command.action ? command.action.command : ""}`));
      const missing = [
        ...toolIds.filter((id) => id !== "select" && !have.has(`activate-sketch-tool:${id}`)).map((id) => `tool ${id}`),
        ...editIds.filter((id) => !have.has(`activate-sketch-edit:${id}`)).map((id) => `edit ${id}`),
        ...commandIds.filter((id) => !have.has(`sketch-command:${id}`)).map((id) => `command ${id}`)
      ];
      equal(JSON.stringify(missing), "[]", "no ribbon sketch command is missing from the search");
      assert(CAD_COMMANDS.length > 100, "the catalog itself is untouched (the extras live beside it)");
      // A search entry carries the live key, and a rebound key shows.
      const rebound = rebindKey(DEFAULT_SKETCH_KEYMAP, "tool:line", "K");
      assert(rebound.ok, "Line moves to K");
      if (rebound.ok) assert(searchableCommands(rebound.keymap).some((command) => command.action.kind === "activate-sketch-tool" && command.action.tool === "line" && command.shortcut === "K"), "and the search shows K");
    }
  },
  {
    name: "Re-audit UX R2-8: a point held on the sketch origin has a glyph on the canvas at the origin, so an anchored sketch shows its anchor",
    run: () => {
      let project = projectWith([line("entity:a", [0, 0], [60, 0]), line("entity:b", [60, 0], [60, 20])]);
      project = run(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:anchor", kind: "coincident", entityIds: ["sketch:origin", "entity:a"], points: ["self", "start"] } });
      project = run(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:flip", kind: "coincident", entityIds: ["entity:b", "sketch:origin"], points: ["end", "self"] } });
      const draw = constraintsToDraw(project.sketch.constraints, { level: "all", hiddenKinds: [] }, { selectedEntityIds: [], hoveredEntityId: null, selectedConstraintIds: [], hoveredConstraintId: null });
      assert(draw.some((constraint) => constraint.id === "constraint:anchor"), "the anchor relation is one to draw");
      const glyphs = layoutConstraintGlyphs(draw, project.sketch.entities, { mmPerPx: 0.2 });
      const anchor = glyphs.find((glyph) => glyph.id === "constraint:anchor");
      assert(anchor !== undefined, "the origin coincident relation has a glyph (it had none: the origin is not in the curve list)");
      equal(anchor.anchor.join(","), "0,0", "attached at the origin");
      assert(Math.hypot(anchor.at[0], anchor.at[1]) < 12 * 0.2 + 8 * 0.2 * 2, "and drawn right beside it");
      assert(glyphs.some((glyph) => glyph.id === "constraint:flip"), "the same holds when the origin is the second thing named");
      const byId = new Map(project.sketch.entities.map((entity) => [entity.id, entity] as const));
      equal(constraintAnchor({ id: "constraint:x", kind: "parallel", entityIds: ["sketch:axis-x", "entity:a"] }, byId)?.point.join(","), "30,0", "a relation to an axis is drawn at the curve it constrains");
      equal(constraintAnchor({ id: "constraint:y", kind: "horizontal", entityIds: ["entity:gone"] }, byId), undefined, "a relation whose curve is gone has nowhere to be drawn");
    }
  },
  {
    name: "Re-audit UX E19: the centre of Rotate, Scale and a circular Pattern can be picked on the canvas (snapped, with a visible marker), and the panels take the picked point",
    run: () => {
      // The pick snaps like any placed point.
      const sketch = projectWith([{ id: "entity:c", kind: "circle", center: [30, 40], radiusMm: 5, construction: false }]).sketch;
      const snapped = snapPickedCentre({ sketch, point: [30.4, 40.3], toleranceMm: 2, gridMm: 1, settings: DEFAULT_SNAP_ASSIST, ctrl: false });
      near(snapped[0], 30, 1e-9, "a click near a circle's centre lands on it (x)");
      near(snapped[1], 40, 1e-9, "(y)");
      const free = snapPickedCentre({ sketch, point: [30.4, 40.3], toleranceMm: 2, gridMm: 1, settings: DEFAULT_SNAP_ASSIST, ctrl: true });
      near(free[0], 30.4, 1e-9, "with Ctrl the click is taken as it is");
      const nearOrigin = snapPickedCentre({ sketch, point: [0.3, -0.2], toleranceMm: 2, gridMm: 1, settings: DEFAULT_SNAP_ASSIST, ctrl: false });
      near(Math.hypot(nearOrigin[0], nearOrigin[1]), 0, 1e-9, "and near the origin lands on the origin");
      // The bridge: a new pick has a new serial (the same point twice still refills), an old pick is not applied twice.
      const first = nextPickedCentre(undefined, [3, 4]);
      const again = nextPickedCentre(first, [3, 4]);
      assert(again.serial > first.serial, "picking the same point twice is a new pick");
      assert(isUnhandledPick(0, first) && !isUnhandledPick(first.serial, first) && !isUnhandledPick(0, undefined), "a pick is applied once");
      const texts = centreFieldTexts(nextPickedCentre(undefined, [25.4, 50.8]), (value) => String(value / 25.4));
      equal(`${texts.x}|${texts.y}`, "1|2", "the picked point fills the fields in the field's unit");
      equal(centreOfFields({ x: "10", y: "5" }, Number)?.join(","), "10,5", "the typed centre is read back for the marker");
      equal(centreOfFields({ x: "10", y: "" }, (text) => (text === "" ? Number.NaN : Number(text))), undefined, "a half-typed centre has no marker");
      // The panels offer the button when the workspace gives them the bridge, and not otherwise.
      const bridge = (picking: boolean): CentrePickBridge => ({ picking, picked: undefined, onPicking: noop, onCentre: noop });
      const sketchWithLine = projectWith([line("entity:l", [0, 0], [10, 0])]).sketch;
      for (const tool of ["rotate", "scale"] as const) {
        const withBridge = renderToStaticMarkup(createElement(SketchEditPanel, { tool, sketch: sketchWithLine, selectionIds: ["entity:l"], onApply: noop, onMessage: noop, onClose: noop, centrePick: bridge(false) }));
        assert(withBridge.includes("Pick on canvas") && withBridge.includes("Origin") && withBridge.includes("Centre of selection"), `${tool}: Pick on canvas sits with the other centre buttons`);
        const picking = renderToStaticMarkup(createElement(SketchEditPanel, { tool, sketch: sketchWithLine, selectionIds: ["entity:l"], onApply: noop, onMessage: noop, onClose: noop, centrePick: bridge(true) }));
        assert(picking.includes('aria-pressed="true"') && picking.includes("Click the centre on the canvas"), `${tool}: while picking, the button says what to do`);
        const without = renderToStaticMarkup(createElement(SketchEditPanel, { tool, sketch: sketchWithLine, selectionIds: ["entity:l"], onApply: noop, onMessage: noop, onClose: noop }));
        assert(!without.includes("Pick on canvas"), `${tool}: without a bridge the panel is as before`);
      }
      const pattern = renderToStaticMarkup(createElement(SketchPatternPanel, { sketch: sketchWithLine, selectionIds: ["entity:l"], onApply: noop, onMessage: noop, onClose: noop, centrePick: bridge(false) }));
      assert(!pattern.includes("Pick on canvas"), "a rectangular pattern has no centre to pick");
      assert(renderToStaticMarkup(createElement(CentrePickButton, { bridge: undefined })) === "", "no bridge, no button");
      // The marker: a ring and cross at the centre, and a lighter one under the pointer while picking.
      const marker = renderToStaticMarkup(createElement("svg", null, createElement(CentreMarker, { centre: [10, 5], hover: [20, 8], px: 0.5 })));
      assert(marker.includes("centre-marker-current") && marker.includes("centre-marker-hover") && marker.includes('transform="translate(10 -5)"'), "the marker is drawn at the centre (y flipped for the screen), with the pointer's one beside it");
      assert(!renderToStaticMarkup(createElement("svg", null, createElement(CentreMarker, { centre: undefined, hover: undefined, px: 0.5 }))).includes("centre-marker"), "no centre, no marker");
      // The workspace wires the pick in front of the curves, ends it on Esc, and hands the bridge to both panels.
      const workspace = repoFile("apps/studio-web/src/workspaces/SketchWorkspace.tsx");
      const capture = workspace.slice(workspace.indexOf("const handleCanvasPointerDownCapture"), workspace.indexOf("const handleCanvasPointerDown ="));
      assert(capture.includes("centrePick.picking") && capture.includes("centrePick.deliver(point)") && capture.indexOf("centrePick.picking") < capture.indexOf("cycleSelectOther"), "a click while picking is taken before any curve under it");
      assert(workspace.includes("pickingRelation: pickRelation !== null || centrePick.picking") && workspace.includes("centrePick.cancel()"), "Esc cancels the pick first");
      assert(workspace.includes("centrePick={centrePick.bridge}") && workspace.includes("<CentreMarker"), "both panels get the bridge and the canvas draws the marker");
    }
  },
  {
    name: "Re-audit UX E28: the dimension labels, the relation points, the Select Other list and the dimension editor can all be reached and operated from the keyboard, with names and a sensible focus order",
    run: () => {
      const entity: SketchEntity = line("entity:l", [0, 0], [40, 0]);
      const layout = dimensionLayout(entity, "length", 40, 0.2)!;
      const marks = (interactive: boolean): string => renderToStaticMarkup(createElement("svg", null, createElement(DimensionMarks, { constraintId: "constraint:d", entityId: entity.id, layout, px: 0.2, relaxed: false, selected: true, interactive, repositionable: true, title: "Length: Line 1 = 40 mm", onPress: noop, onEdit: noop, onSelect: noop })));
      const live = marks(true);
      assert(live.includes('tabindex="0"') && live.includes('role="button"') && live.includes('aria-pressed="true"'), "an editable dimension label is a focusable toggle button");
      assert(live.includes("Press Enter to edit") && live.includes("Length: Line 1 = 40 mm") && live.includes("double-click to edit"), "and says how to edit it with the keyboard and with the pointer");
      assert(!marks(false).includes("tabindex"), "while a drawing tool is active the labels are only drawn, not in the tab order");
      const bridge = projectWith([line("entity:a", [0, 0], [40, 0]), line("entity:b", [0, 30], [40, 30])]);
      const withDimension = run(bridge, { kind: "set-sketch-dimension", entityId: "entity:a", secondEntityId: "entity:b", dimension: "line-line", valueMm: 30 });
      const extra = renderToStaticMarkup(createElement("svg", null, createElement(ExtraDimensionMarks, { sketch: withDimension.sketch, px: 0.2, onEdit: noop, onSelect: noop, selectedIds: [] })));
      assert(extra.includes('tabindex="0"') && extra.includes("Press Enter to edit") && extra.includes('role="button"'), "a distance between lines can be focused and edited from the keyboard");
      const drawnOnly = renderToStaticMarkup(createElement("svg", null, createElement(ExtraDimensionMarks, { sketch: withDimension.sketch, px: 0.2 })));
      assert(!drawnOnly.includes("tabindex"), "and is not focusable when it is only drawn");
      // Select Other: a group holding the title and a listbox of options only.
      const popup = renderToStaticMarkup(createElement(SelectOtherPopup, { candidates: [{ id: "entity:a", label: "Line 1, 40 mm" }, { id: "entity:b", label: "Line 2, 40 mm" }] as never, selectedId: "entity:a", position: [10, 10], onPick: noop, onClose: noop }));
      const listbox = popup.slice(popup.indexOf('role="listbox"'), popup.indexOf("</div>", popup.indexOf('role="listbox"')));
      assert(popup.includes('role="group"') && !listbox.includes("Close the list") && (listbox.match(/role="option"/gu) ?? []).length === 2, "the listbox holds only options (the close button sits outside it)");
      assert(repoFile("apps/studio-web/src/workspaces/sketch/SelectOtherPopup.tsx").includes('event.key === "ArrowDown"') && repoFile("apps/studio-web/src/workspaces/sketch/SelectOtherPopup.tsx").includes('event.key === "Escape"'), "the arrows move between the rows and Esc closes the list");
      // The dimension editor gives the keyboard back to the canvas when it closes.
      const editor = repoFile("apps/studio-web/src/workspaces/sketch/DimensionEditor.tsx");
      assert(editor.includes("before.focus()") && editor.includes("activeElement"), "the editor returns focus to what had it");
      // Focus order in the rendered workspace: the plane chip, then the canvas, then its points, then the palette and the inspector.
      const rect: SketchEntity = { id: "entity:plate", kind: "rectangle", center: [50, 25], widthMm: 100, heightMm: 50, rotationDeg: 0, construction: false };
      const markup = renderWorkspaceMarkup(projectWith([rect]), { dimensionMode: true });
      const order = [markup.indexOf("sketch-plane-chip"), markup.indexOf('role="application"'), markup.indexOf("data-dimension-point"), markup.indexOf('class="sketch-palette')];
      assert(order.every((position, index) => position >= 0 && (index === 0 || position > order[index - 1]!)), `focus order is chip, canvas, points, palette (${order.join(", ")})`);
      assert(markup.includes('aria-describedby="sketch-canvas-help"') && markup.includes('id="sketch-canvas-help"'), "the canvas help it points at exists");
      // Colours the new controls use are readable on the surfaces they sit on.
      assert(contrast("#4aa8f0", "#081522") >= 3, "the focus ring is visible on the dark canvas");
      assert(contrast("#ffd36a", "#081522") >= 3 && contrast("#7bd88f", "#081522") >= 3, "the centre markers are visible on the dark canvas");
      assert(contrast("#5c4400", "#ffffff") >= 4.5 && contrast("#5c4400", "#f4f1ea") >= 4.5, "the bound-expression note is readable text on the inspector");
      assert(contrast("#124a7c", "#eaf5fb") >= 4.5, "an active palette button is readable");
    }
  },
  {
    name: "Re-audit UX (d): a step that throws is reported as a sentence that names the step and what to do, without generated ids, and the sketch messages and checks name curves the way the sketch lists them",
    run: () => {
      const text = describeFailure(new Error("Cannot read entity:user-3f2a9c1b-77 of constraint:auto-12"), "Finishing the sketch");
      assert(text.startsWith("Finishing the sketch did not finish"), "it names the step");
      assert(!/entity:|constraint:|user-3f2a/u.test(text), `no generated id reaches the person (${text})`);
      assert(text.includes("Ctrl+Z") && text.includes("Try again"), "and says what to do");
      assert(describeFailure(undefined, "Combine").includes("Combine did not finish."), "an error without a message still reads as a sentence");
      // The Sketch Checking messages name curves ("Line 2"), not generated ids.
      const project = projectWith([line("entity:user-3f2a9c1b-77aa", [0, 0], [0.05, 0]), line("entity:user-9d8e7f6a-11bb", [10, 0], [30, 0])]);
      const report = checkSketch(project.sketch);
      assert(report.items.every((item) => !/entity:|user-3f2a|user-9d8e/u.test(item.message)), `no generated id in the checking report (${report.items.map((item) => item.message).join(" | ")})`);
      assert(report.items.some((item) => item.message.includes("Line 1") && item.message.includes("shorter than 0.1 mm")), "the short line is called Line 1");
      const workspace = repoFile("apps/studio-web/src/workspaces/SketchWorkspace.tsx");
      assert(!/stable ID \$\{/u.test(workspace), "adding a curve no longer announces its generated id");
      assert(!workspace.includes("({shortId(entity.id)})"), "the revolve-axis list names lines by name, not by id");
    }
  }
];
