import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { applyIntent } from "../apps/studio-web/src/sketch-session.js";
import { chooseBodyFor } from "../apps/studio-web/src/body-choice.js";
import { TreeItem } from "../apps/studio-web/src/ui/ProjectTree.js";
import { createRenameGuard } from "../apps/studio-web/src/ui/inline-rename.js";
import { isGlobalRenameKey, renameTargetFor } from "../apps/studio-web/src/rename-target.js";
import { TimelineGroupMenu } from "../apps/studio-web/src/ui/TimelineBar.js";
import { chainAllButLast, groupDeleteHeadline, groupDeleteImpact, groupDeleteIntents, groupMenuModel, groupSuppressIntents } from "../apps/studio-web/src/ui/timeline-group-actions.js";
import { timelineGroups } from "../apps/studio-web/src/ui/timeline-groups.js";
import { DeleteStepDialog } from "../apps/studio-web/src/ui/DeleteStepDialog.js";
import { DRAW_PROFILE_NEXT, FINISHED_SKETCH_NEXT, needsSecondSolid } from "../apps/studio-web/src/flow-text.js";
import { blendLimitMm, blendSizeProblem, resizeBlendNext, trimKeptProblem } from "../apps/studio-web/src/part-limits.js";
import { applyWorkbenchOperation, designOf, validateWorkbenchProject, type DesignSolidFeature, type WorkbenchOperation, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { PLATE_BODY, plateHoleFillet, stepOf, tetra } from "./history-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** Cosmetic-review polish round (fx-polish): Combine as one project, refusals that name limits and candidates, rename and group menus, layout. */

function stepless(): WorkbenchProject {
  const plate = plateHoleFillet();
  const history = designOf(plate);
  const sketches = history.features.filter((feature) => feature.kind === "sketch");
  return { ...plate, part: { ...plate.part, generalBodies: [tetra("general-body:a"), tetra("general-body:b")] }, design: { ...history, features: sketches, rollbackIndex: sketches.length } };
}

const copyStep = (index: number, of: number): DesignSolidFeature => stepOf(`feature:a-${index}`, `Rectangular pattern (${index} of ${of})`, "pattern", {
  bodyId: `general-body:a-${index}`, operation: "new-body",
  pattern: { type: "rectangular", result: "new-bodies", groupId: "pattern:a", sourceBodyId: PLATE_BODY, copyIndex: index, countA: of, spacingAMm: 20, directionA: [1, 0, 0], countB: 1, spacingBMm: 0, directionB: [0, 1, 0], sizing: "spacing" }
});

/** The plate steps, three copies of one pattern, then a join onto the second copy's body. */
function withGroup(): WorkbenchProject {
  const project = plateHoleFillet();
  const history = designOf(project);
  const features = [...history.features, copyStep(1, 3), copyStep(2, 3), copyStep(3, 3), stepOf("feature:join-on-copy", "Join on copy", "extrude", { operation: "join", bodyId: "general-body:a-2" })];
  return { ...project, design: { ...history, features, rollbackIndex: features.length } };
}

export const fxPolishTests: readonly TestCase[] = [
  {
    name: "Combine on bodies without timeline steps is one operation: target and tool become one body in one project",
    run: () => {
      const before = stepless();
      const result = tetra("general-body:result");
      const done = applyIntent(before, { kind: "boolean-general-bodies", targetBodyId: "general-body:a", toolBodyId: "general-body:b", mode: "join", keepTool: false, body: result });
      assert(done.ok, `the Boolean is accepted as one operation: ${done.ok ? "" : done.message}`);
      if (!done.ok) return;
      const ids = done.value.project.part.generalBodies!.map((body) => body.id);
      equal(ids.join(","), "general-body:result", "both inputs are replaced by the result in the same project, so one Undo restores both");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(done.value.project))).ok, "the result saves and reloads");
      equal(before.part.generalBodies!.length, 2, "the project before the command is untouched");
    }
  },
  {
    name: "Edge Blend / Chamfer size over the limit is refused with the limit named, never clamped",
    run: () => {
      const size: [number, number, number] = [40, 20, 10];
      equal(blendLimitMm(size), 9.5, "limit is half the narrower side less 0.5 mm");
      const refused = blendSizeProblem("Block 1", "Blend radius", 12, size);
      assert(refused !== undefined && refused.includes("9.5 mm") && refused.includes("12 mm") && refused.includes("Block 1"), `names the typed value and the limit: ${refused}`);
      assert(refused.includes("Nothing was applied"), "says nothing was applied");
      equal(blendSizeProblem("Block 1", "Blend radius", 9.5, size), undefined, "exactly the limit is accepted as typed");
      equal(blendSizeProblem("Block 1", "Chamfer distance", 0.3, size), undefined, "a small value is applied as typed (no 0.25 mm floor clamp)");
      assert(blendSizeProblem("Block 1", "Blend radius", 0, size) !== undefined, "zero is refused");
      assert(blendSizeProblem("Thin", "Blend radius", 0.2, [1, 1, 5])?.includes("too narrow") === true, "a body too narrow for any blend says so");
    }
  },
  {
    name: "Resize Blend at the limit refuses instead of repeating the clamped value",
    run: () => {
      const size: [number, number, number] = [40, 20, 10];
      const grown = resizeBlendNext("Block 1", 3, size);
      assert(grown.ok && grown.sizeMm === 3.5, "grows by half a millimetre inside the limit");
      const stuck = resizeBlendNext("Block 1", 9.2, size);
      assert(!stuck.ok && stuck.message.includes("9.5 mm") && stuck.message.includes("Nothing was changed"), "past the limit it names the limit");
    }
  },
  {
    name: "Trim Body keeps exactly the typed length or refuses naming the height",
    run: () => {
      equal(trimKeptProblem("Block 1", 0.25, 10), undefined, "0.25 mm is applied as typed (no 0.5 mm floor clamp)");
      const tooLong = trimKeptProblem("Block 1", 14, 10);
      assert(tooLong !== undefined && tooLong.includes("10 mm") && tooLong.includes("14 mm"), `names both numbers: ${tooLong}`);
      assert(trimKeptProblem("Block 1", 10, 10) !== undefined, "keeping the whole height removes nothing and is refused");
      assert(trimKeptProblem("Block 1", -1, 10) !== undefined, "a negative length is refused");
    }
  },
  {
    name: "Hole / Fillet All / Chamfer All name the candidate bodies and never pick among several",
    run: () => {
      const solids = [{ id: "a", name: "Body 1" }, { id: "b", name: "Body 2" }, { id: "c", name: "Body 3" }];
      const several = chooseBodyFor("Hole", solids, null, "a solid made with Extrude or Revolve");
      assert(!several.ok && several.message.includes("Body 1, Body 2, Body 3") && several.message.includes("run Hole again"), "several and none selected: names them all");
      const chosen = chooseBodyFor("Hole", solids, "b", "a solid");
      assert(chosen.ok && chosen.body.id === "b", "the selected body is used");
      const only = chooseBodyFor("Fillet All", [solids[0]!], null, "a solid");
      assert(only.ok && only.body.id === "a", "the only candidate is used");
      const wrong = chooseBodyFor("Chamfer All", solids, "x", "a solid made with Extrude or Revolve", "Block 7");
      assert(!wrong.ok && wrong.message.includes("Block 7 is not a solid made with Extrude or Revolve") && wrong.message.includes("Body 2"), "a selection of the wrong kind is explained and the candidates named");
      const wrongOne = chooseBodyFor("Chamfer All", [solids[0]!], "x", "a solid", "Block 7");
      assert(!wrongOne.ok, "one candidate but a different body selected: not picked silently");
      const none = chooseBodyFor("Hole", [], null, "a solid");
      assert(!none.ok && none.message.includes("none yet"), "no candidates: says to create one");
      const many = chooseBodyFor("Hole", Array.from({ length: 9 }, (_, index) => ({ id: String(index), name: `Body ${index + 1}` })), null, "a solid");
      assert(!many.ok && many.message.includes("and 3 more"), "a long list is shortened");
    }
  },
  {
    name: "F2 renames the picked step, else the selected solid, else a sketch selected by its own id; nothing selected means no target",
    run: () => {
      const plate = plateHoleFillet();
      const history = designOf(plate);
      const bodies = [{ id: PLATE_BODY, name: "Body 1" }];
      const cut = history.features.find((feature) => feature.id === "feature:cut-1")!;
      equal(renameTargetFor(history, null, null, bodies), undefined, "nothing selected");
      const body = renameTargetFor(history, PLATE_BODY, null, bodies);
      assert(body !== undefined && body.kind === "body" && body.id === PLATE_BODY && body.name === "Body 1", "a selected solid is renamed as a body, not as the step that made it");
      const picked = renameTargetFor(history, PLATE_BODY, { featureId: cut.id, selectionId: PLATE_BODY }, bodies);
      assert(picked !== undefined && picked.kind === "step" && picked.id === "feature:cut-1", "a step the user picked wins over its body");
      const stale = renameTargetFor(history, PLATE_BODY, { featureId: cut.id, selectionId: "something else" }, bodies);
      assert(stale !== undefined && stale.kind === "body", "a pick that is no longer the selection does not count");
      const sketch = history.features.find((feature) => feature.kind === "sketch")!;
      const bySketch = renameTargetFor(history, sketch.id, null, bodies);
      assert(bySketch !== undefined && bySketch.kind === "step" && bySketch.id === sketch.id, "a sketch selected by its own id");
      equal(renameTargetFor(history, "datum:xy", null, bodies), undefined, "a plane is not renamable here");
    }
  },
  {
    name: "F2 is global only in the Part workspace, never while typing in a field, under a dialog, or with a modifier",
    run: () => {
      const plain = { key: "F2", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false };
      assert(isGlobalRenameKey(plain, "part", false, false), "F2 in Part renames");
      assert(!isGlobalRenameKey(plain, "sketch", false, false), "the sketch workspace keeps its own keys");
      assert(!isGlobalRenameKey(plain, "part", true, false), "typing in a field is left alone");
      assert(!isGlobalRenameKey(plain, "part", false, true), "a dialog owns the keyboard");
      assert(!isGlobalRenameKey({ ...plain, shiftKey: true }, "part", false, false), "Shift+F2 is not rename");
      assert(!isGlobalRenameKey({ ...plain, key: "F3" }, "part", false, false), "other keys are ignored");
    }
  },
  {
    name: "Inline rename: clicking away keeps the typed name, Escape cancels, and the blur after Enter or Escape does nothing",
    run: () => {
      const away = createRenameGuard("Body 1");
      const kept = away.end("blur", "  Housing ");
      assert(kept !== undefined && kept.action === "commit" && kept.name === "Housing", "blur commits the trimmed name");
      equal(away.end("blur", "Other"), undefined, "a second ending is ignored");
      const escaped = createRenameGuard("Body 1");
      const cancelled = escaped.end("escape", "Housing");
      assert(cancelled !== undefined && cancelled.action === "cancel", "Escape cancels");
      equal(escaped.end("blur", "Housing"), undefined, "the blur that follows Escape must not commit");
      const entered = createRenameGuard("Body 1");
      assert(entered.end("enter", "Housing")?.action === "commit", "Enter commits");
      equal(entered.end("blur", "Housing"), undefined, "the blur that follows Enter must not commit twice");
      assert(createRenameGuard("Body 1").end("blur", "   ")?.action === "cancel", "an empty name is a cancel");
      assert(createRenameGuard("Body 1").end("blur", "Body 1")?.action === "cancel", "an unchanged name is a cancel (no empty undo step)");
    }
  },
  {
    name: "A Sketches-folder style row (with an eye) shows the rename field beside its eye while renaming",
    run: () => {
      const noop = (): void => undefined;
      const html = renderToStaticMarkup(createElement(TreeItem, { kind: "sketch", id: "feature:s1", featureId: "feature:s1", label: "Sketch 1", meta: "4 curves", selectedId: null, onSelect: noop, onOpen: noop, eye: { shown: true, what: "sketch", onToggle: noop }, rename: { editing: true, onStart: noop, onCommit: noop, onCancel: noop } }));
      assert(html.includes('aria-label="Rename Sketch 1"') && html.includes("tree-eye"), `field and eye share the row: ${html}`);
    }
  },
  {
    name: "A folded group's menu names the whole group in every entry and offers no single-step Rename or Move",
    run: () => {
      const project = withGroup();
      const history = designOf(project);
      const group = timelineGroups(history)[0]!;
      const model = groupMenuModel(history, group);
      equal(model.count, 3, "three copies");
      equal(model.editLabel, "Edit pattern (3 copies)", "edit names the pattern");
      equal(model.suppressLabel, "Suppress all 3 copies", "suppress names the group");
      equal(model.deleteLabel, "Delete all 3 copies", "delete names the group");
      equal(model.rollbackIndex, group.lastIndex + 1, "the marker goes after the last copy");
      const allSuppressed = { ...history, features: history.features.map((feature) => feature.kind !== "sketch" && feature.pattern?.groupId === "pattern:a" ? { ...feature, suppressed: true } : feature) };
      equal(groupMenuModel(allSuppressed, group).suppressLabel, "Unsuppress all 3 copies", "all suppressed offers to bring them back");
      const html = renderToStaticMarkup(createElement(TimelineGroupMenu, { menuRef: { current: null }, group, history, placement: { left: 0, top: 0, maxHeight: 300 }, onClose: () => undefined, onEdit: () => undefined, onShow: () => undefined, onRollback: () => undefined, onSuppressGroup: () => undefined, onDeleteGroup: () => undefined }));
      for (const text of ["Edit pattern (3 copies)", "Show the 3 copies", "Suppress all 3 copies", "Delete all 3 copies", "Roll marker after the group"]) assert(html.includes(text), `${text} is in the menu`);
      assert(!html.includes(">Rename<") && !html.includes("Move earlier"), "no entry that would act on one copy only");
      const bare = renderToStaticMarkup(createElement(TimelineGroupMenu, { menuRef: { current: null }, group, history, placement: undefined, onClose: () => undefined, onEdit: () => undefined, onShow: () => undefined, onRollback: () => undefined }));
      assert(!bare.includes("Suppress all") && !bare.includes("Delete all"), "a host that cannot act on the whole group shows no dead Suppress or Delete");
    }
  },
  {
    name: "Right-clicking a folded group does not open it: only a single step's menu counts as in use",
    run: () => {
      const source = readFileSync("apps/studio-web/src/ui/TimelineBar.tsx", "utf8");
      assert(source.includes("menu?.group === undefined ? menu?.feature.id : undefined"), "a group-scoped menu is left out of the ids that force a group open");
      assert(source.includes("setMenu({ feature, group, x: event.clientX, y: event.clientY })"), "the folded chip opens a group-scoped menu");
      assert(/menu\.group === undefined && createPortal\(<TimelineMenu/u.test(source), "a single step's menu is not used for a group");
    }
  },
  {
    name: "Suppress on a group acts on every copy as one project, and the project before it is untouched",
    run: () => {
      const project = withGroup();
      const history = designOf(project);
      const group = timelineGroups(history)[0]!;
      const members = groupMenuModel(history, group).members;
      const intents = groupSuppressIntents(members, true);
      equal(intents.length, 3, "one operation per copy");
      const chained = chainAllButLast(project, intents);
      assert(chained.ok, "the first two apply on a scratch project");
      if (!chained.ok) return;
      const mid = designOf(chained.project).features.filter((feature) => feature.id.startsWith("feature:a-") && feature.suppressed);
      equal(mid.length, 2, "two copies suppressed before the last is committed");
      const done = applyWorkbenchOperation(chained.project, { ...chained.last, operationId: "operation:test-last", expectedRevision: chained.project.revision } as unknown as WorkbenchOperation);
      assert(done.ok, "the last applies");
      if (!done.ok) return;
      equal(designOf(done.value.project).features.filter((feature) => feature.id.startsWith("feature:a-") && feature.suppressed).length, 3, "every copy is suppressed in the one resulting project");
      equal(designOf(project).features.filter((feature) => feature.suppressed).length, 0, "the project before the command has nothing suppressed, so one Undo restores all");
      equal(groupSuppressIntents(members, false).length, 0, "copies already in the wanted state need no operation");
    }
  },
  {
    name: "Delete on a group confirms with every copy and what else goes, and deletes each copy once",
    run: () => {
      const project = withGroup();
      const history = designOf(project);
      const group = timelineGroups(history)[0]!;
      const impact = groupDeleteImpact(project, group)!;
      equal(impact.featureName, "Rectangular pattern ×3", "the confirmation is about the group");
      const names = impact.dependents.map((item) => item.name);
      assert(names.includes("Rectangular pattern (2 of 3)") && names.includes("Rectangular pattern (3 of 3)") && names.includes("Join on copy"), `lists the other copies and the join built on a copy: ${names.join(", ")}`);
      const headline = groupDeleteHeadline(impact, group);
      assert(headline.includes("all 3 copies") && headline.includes("1 other step"), `headline counts copies and outsiders: ${headline}`);
      equal(groupDeleteIntents(history, group).length, 3, "one delete per copy");
      const chained = chainAllButLast(project, groupDeleteIntents(history, group));
      assert(chained.ok, "the deletes chain");
      if (!chained.ok) return;
      const done = applyWorkbenchOperation(chained.project, { ...chained.last, operationId: "operation:test-del", expectedRevision: chained.project.revision } as unknown as WorkbenchOperation);
      assert(done.ok, "the last delete applies");
      if (!done.ok) return;
      const left = designOf(done.value.project).features.map((feature) => feature.id);
      assert(!left.some((id) => id.startsWith("feature:a-")) && !left.includes("feature:join-on-copy"), "copies and the dependent join are gone");
      assert(left.includes("feature:join-1"), "unrelated steps stay");
    }
  },
  {
    name: "The model-parameters grid wraps by its own width: auto-fit columns, and no window media query for it",
    run: () => {
      const css = readFileSync("apps/studio-web/src/styles/parameters.css", "utf8");
      const start = css.indexOf("/* Model parameters:");
      assert(start >= 0, "the model-parameters block is in the sheet");
      const block = css.slice(start);
      assert(!block.includes("@media") && !block.includes("@container"), "no query of any kind for the model-parameters block");
      const row = /\.studio-app \.parameters-model-row \{[^}]*\}/u.exec(block);
      assert(row !== null && row[0].includes("repeat(auto-fit, minmax(min(100%, 9rem), 1fr))"), `the row is an auto-fit grid: ${row?.[0] ?? "missing"}`);
      assert(!/max-width:\s*720px[^{]*\{[^}]*parameters-model/u.test(css), "the old 720 px rule for the model rows is gone");
      assert(!/font-size:\s*(0\.[0-6]\d*rem|1[01](\.\d+)?px|[0-9](\.\d+)?px)/u.test(block), "text stays at 12 px or more");
    }
  },
  {
    name: "Status text after Finish Sketch and after choosing a plane names E (Part) as well as the Sketch palette",
    run: () => {
      assert(FINISHED_SKETCH_NEXT.includes("Press E in the Part workspace") && FINISHED_SKETCH_NEXT.includes("Create solid in the Sketch palette"), FINISHED_SKETCH_NEXT);
      assert(DRAW_PROFILE_NEXT.includes("press E in Part"), DRAW_PROFILE_NEXT);
      assert(needsSecondSolid("Combine").includes("Extrude (E)") && !needsSecondSolid("Combine").includes("Make solid"), needsSecondSolid("Combine"));
      const app = readFileSync("apps/studio-web/src/App.tsx", "utf8");
      assert(!app.includes("Make solid"), "no status text names a Make solid command that does not exist");
      assert(!app.includes("Extrude it with Create solid in the Sketch palette"), "the old Finish message is gone");
    }
  },
  {
    name: "The delete confirmation uses the shared dialog focus: Esc closes, Tab stays inside, Cancel is first",
    run: () => {
      const source = readFileSync("apps/studio-web/src/ui/DeleteStepDialog.tsx", "utf8");
      assert(source.includes("useDialogFocus"), "the shared hook handles Esc, the Tab trap and focus return");
      const html = renderToStaticMarkup(createElement(DeleteStepDialog, { impact: { featureId: "f", featureName: "Group", featureKind: "pattern", dependents: [], removedBodyNames: [], kept: { featureId: "f", featureName: "Group", marks: [], removedBodyNames: [] } }, headline: "Delete all 3 copies of Rectangular pattern.", onConfirm: () => undefined, onCancel: () => undefined }));
      assert(html.includes("Delete all 3 copies of Rectangular pattern.") && html.includes("data-dialog-initial-focus"), "a custom headline is shown and Cancel takes the first focus");
      assert(html.indexOf("data-dialog-initial-focus") < html.indexOf("primary danger"), "Cancel comes before the destructive button in focus order");
    }
  },
];

void PLATE_BODY;
