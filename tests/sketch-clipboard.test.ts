import type { SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { resolveSketchHotkey, type SketchHotkeyContext } from "../packages/workbench-sketch/src/hotkeys.js";
import {
  clearSketchClipboard, copySketchSelection, cutSketchSelection, nextPasteNumber, parseClipboard, pasteOffset, pasteSketchClipboard,
  readSketchClipboard, serializeClipboard, storeSketchClipboard
} from "../packages/workbench-sketch/src/sketch-clipboard.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { circle, commitOk, constraint, context, line, linesOf, planOf, projectWith, relationsHold } from "./sketch-edit-kit.js";

let serial = 0;
function runOp(project: WorkbenchProject, operation: Record<string, unknown>): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:clip-test-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${String(operation.kind)} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

/** A 10 x 10 square with joints, horizontal / vertical sides and a 10 mm length dimension, plus a circle with a radius dimension. */
function drawing(): WorkbenchProject {
  return projectWith(
    [line("s0", [0, 0], [10, 0]), line("s1", [10, 0], [10, 10]), line("s2", [10, 10], [0, 10]), line("s3", [0, 10], [0, 0]), circle("c", [30, 5], 4), line("far", [60, 0], [70, 0])],
    [
      constraint("c01", "coincident", ["s0", "s1"], { points: ["end", "start"] }),
      constraint("c12", "coincident", ["s1", "s2"], { points: ["end", "start"] }),
      constraint("c23", "coincident", ["s2", "s3"], { points: ["end", "start"] }),
      constraint("c30", "coincident", ["s3", "s0"], { points: ["end", "start"] }),
      constraint("h0", "horizontal", ["s0"]), constraint("v1", "vertical", ["s1"]), constraint("h2", "horizontal", ["s2"]), constraint("v3", "vertical", ["s3"]),
      constraint("len", "distance", ["s0"], { valueMm: 10, dimension: "length" }),
      constraint("rad", "radius", ["c"], { valueMm: 4, dimension: "radius" }),
      constraint("fix", "fixed", ["s0"]),
      constraint("link", "parallel", ["s0", "far"])
    ]
  );
}

const SQUARE = ["entity:s0", "entity:s1", "entity:s2", "entity:s3"];

export const sketchClipboardTests: readonly TestCase[] = [
  {
    name: "copy takes the selection with only the relations between its own entities; paste adds shifted copies with fresh ids and the same relations",
    run: () => {
      const project = drawing();
      const copied = copySketchSelection(project.sketch, SQUARE);
      assert(copied.ok, "copy works");
      if (!copied.ok) return;
      equal(copied.value.entities.length, 4, "four curves copied");
      equal(copied.value.constraints.length, 9, "four joints, four orientations and the length dimension travel (fixed does not)");
      assert(!copied.value.constraints.some((c) => c.kind === "fixed"), "a fixed pin is not carried");
      equal(copied.value.leftBehind, 1, "the parallel link to the outside curve stays behind");

      const pasted = commitOk(project, pasteSketchClipboard(context(project), copied.value));
      equal(pasted.sketch.entities.length, project.sketch.entities.length + 4, "four curves added");
      const fresh = pasted.sketch.entities.filter((entity) => !project.sketch.entities.some((old) => old.id === entity.id));
      equal(fresh.length, 4, "with new ids");
      const originalBounds = linesOf(project).filter((l) => SQUARE.includes(l.id));
      const copyLines = fresh.filter((entity): entity is Extract<SketchEntity, { kind: "line" }> => entity.kind === "line");
      const shiftX = copyLines[0]!.start[0] - originalBounds[0]!.start[0];
      const shiftY = copyLines[0]!.start[1] - originalBounds[0]!.start[1];
      assert(Math.hypot(shiftX, shiftY) >= 3, `the copy is visibly offset (${shiftX.toFixed(2)}, ${shiftY.toFixed(2)})`);
      copyLines.forEach((copy, index) => {
        near(copy.start[0] - originalBounds[index]!.start[0], shiftX, 1e-9, "every corner shifts the same way (x)");
        near(copy.start[1] - originalBounds[index]!.start[1], shiftY, 1e-9, "every corner shifts the same way (y)");
      });
      const newIds = new Set(fresh.map((entity) => entity.id));
      const newRelations = pasted.sketch.constraints.filter((c) => c.entityIds.every((id) => newIds.has(id)) && c.entityIds.length > 0);
      equal(newRelations.length, 9, "nine relations re-created on the copies");
      assert(newRelations.every((c) => !project.sketch.constraints.some((old) => old.id === c.id)), "with new relation ids");
      assert(newRelations.some((c) => c.kind === "distance" && c.valueMm === 10), "the 10 mm dimension came along");
      assert(relationsHold(pasted), "all relations hold");
      equal(detectSketchProfiles(pasted.sketch).length, 3, "the square, the circle and the square copy are three closed profiles");
      assert(!pasted.sketch.constraints.some((c) => c.kind === "fixed" && c.entityIds.some((id) => newIds.has(id))), "the copy is not pinned");
    }
  },
  {
    name: "pasting again steps the offset further so copies never stack, and an explicit offset is honoured",
    run: () => {
      const project = drawing();
      const copied = copySketchSelection(project.sketch, SQUARE);
      if (!copied.ok) throw new Error("copy failed");
      const first = pasteOffset(copied.value, 1);
      const second = pasteOffset(copied.value, 2);
      near(second[0], 2 * first[0], 1e-12, "second paste is twice as far");
      assert(first[0] > 0 && first[1] < 0, "down and to the right");
      const once = commitOk(project, pasteSketchClipboard(context(project), copied.value, { pasteNumber: 1 }));
      const twice = commitOk(once, pasteSketchClipboard(context(once), copied.value, { pasteNumber: 2 }));
      equal(detectSketchProfiles(twice.sketch).length, 4, "three squares and the circle");
      const explicit = planOf(pasteSketchClipboard(context(project), copied.value, { offsetMm: [100, 0] }));
      assert(explicit.addEntities.every((entity) => entity.kind !== "line" || entity.start[0] >= 100), "an explicit offset replaces the automatic one");
      storeSketchClipboard(copied.value);
      equal(nextPasteNumber(), 1, "first paste number");
      equal(nextPasteNumber(), 2, "second paste number");
      storeSketchClipboard(copied.value);
      equal(nextPasteNumber(), 1, "a new copy restarts the offset");
      clearSketchClipboard();
      equal(readSketchClipboard(), undefined, "cleared");
    }
  },
  {
    name: "cut removes the originals in one edit and the clipboard pastes them back with their relations",
    run: () => {
      const project = drawing();
      const cut = cutSketchSelection(context(project), SQUARE);
      assert(cut.ok, "cut plans");
      if (!cut.ok) return;
      const after = commitOk(project, cut.value.plan);
      equal(after.sketch.entities.some((entity) => SQUARE.includes(entity.id)), false, "the square is gone");
      assert(!after.sketch.constraints.some((c) => c.entityIds.some((id) => SQUARE.includes(id))), "and so are its relations");
      const back = commitOk(after, pasteSketchClipboard(context(after), cut.value.clipboard, { offsetMm: [0, 0] }));
      const profiles = detectSketchProfiles(back.sketch).filter((profile) => profile.boundary.kind !== "circle");
      equal(profiles.length, 1, "pasting at zero offset restores the closed square");
      near(profiles[0]!.areaMm2, 100, 1e-9, "same area");
      assert(back.sketch.constraints.filter((c) => c.kind === "distance").length === 1, "the dimension is back");
      assert(relationsHold(back), "relations hold");
    }
  },
  {
    name: "copy from one sketch and paste into another sketch on a different plane, through the clipboard text",
    run: () => {
      const project = drawing();
      const copied = copySketchSelection(project.sketch, [...SQUARE, "entity:c"], "Sketch 1");
      if (!copied.ok) throw new Error("copy failed");
      // Finish the first sketch into the timeline and start a new, empty one on the XZ plane.
      let next = runOp(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      next = runOp(next, { kind: "new-design-sketch", plane: "datum:xz" });
      equal(next.sketch.plane, "datum:xz", "the working sketch is now on XZ");
      equal(next.sketch.entities.length, 0, "and empty");
      const text = serializeClipboard(copied.value);
      const parsed = parseClipboard(text);
      assert(parsed.ok, "the text parses back");
      if (!parsed.ok) return;
      const pasted = commitOk(next, pasteSketchClipboard(context(next), parsed.value));
      equal(pasted.sketch.entities.length, 5, "the square and the circle arrived");
      equal(pasted.sketch.plane, "datum:xz", "on the new sketch's plane");
      assert(pasted.sketch.constraints.some((c) => c.kind === "radius" && c.valueMm === 4), "with the circle's radius dimension");
      assert(relationsHold(pasted), "relations hold on the other sketch");
      const sameIds = pasted.sketch.entities.every((entity) => !SQUARE.includes(entity.id) && entity.id !== "entity:c");
      assert(sameIds, "none of the source ids was reused");
      equal(detectSketchProfiles(pasted.sketch).length, 2, "a square and a circle profile");
    }
  },
  {
    name: "parseClipboard refuses text that is not exactly a sketch clipboard",
    run: () => {
      const good = copySketchSelection(drawing().sketch, SQUARE);
      if (!good.ok) throw new Error("copy failed");
      const text = serializeClipboard(good.value);
      assert(parseClipboard(text).ok, "the real thing parses");
      assert(!parseClipboard("hello world").ok, "plain text");
      assert(!parseClipboard("{not json").ok, "broken json");
      assert(!parseClipboard(JSON.stringify({ format: "other", entities: [], constraints: [] })).ok, "another format");
      const withKind = JSON.parse(text) as { entities: Record<string, unknown>[] };
      withKind.entities[0]!.kind = "teapot";
      assert(!parseClipboard(JSON.stringify(withKind)).ok, "an unknown curve kind");
      const withNaN = JSON.parse(text) as { entities: Record<string, unknown>[] };
      withNaN.entities[0]!.start = [1e9, 0];
      assert(!parseClipboard(JSON.stringify(withNaN)).ok, "a coordinate far outside any sketch");
      const dangling = JSON.parse(text) as { constraints: Record<string, unknown>[] };
      dangling.constraints[0]!.entityIds = ["entity:not-there"];
      assert(!parseClipboard(JSON.stringify(dangling)).ok, "a relation to a curve that is not on the clipboard");
      const empty = JSON.parse(text) as { entities: unknown[] };
      empty.entities = [];
      assert(!parseClipboard(JSON.stringify(empty)).ok, "an empty clipboard");
      assert(!copySketchSelection(drawing().sketch, []).ok, "copying nothing is refused");
      assert(!copySketchSelection(drawing().sketch, ["entity:ghost"]).ok, "copying a missing curve is refused");
      const emptyProject = projectWith([]);
      assert(!pasteSketchClipboard(context(emptyProject), { ...good.value, entities: [], constraints: [] }).ok, "pasting an empty clipboard is refused");
    }
  },
  {
    name: "Ctrl+C / Ctrl+X / Ctrl+V resolve to clipboard actions only when they make sense, and other Ctrl keys still fall through",
    run: () => {
      const base: SketchHotkeyContext = { tool: "select", pendingPoints: 0, selectionCount: 0, curveSelectionCount: 0, dimensionMode: false, editToolActive: false, pickingRelation: false, dragging: false, dynamicFieldCount: 0 };
      const selected: SketchHotkeyContext = { ...base, selectionCount: 2, curveSelectionCount: 2 };
      const press = (key: string, extra: { shift?: boolean; meta?: boolean } = {}) => ({ key, ctrl: extra.meta !== true, meta: extra.meta === true, alt: false, shift: extra.shift === true });
      equal(resolveSketchHotkey(press("c"), selected)?.kind, "copy", "Ctrl+C with a selection copies");
      equal(resolveSketchHotkey(press("x"), selected)?.kind, "cut", "Ctrl+X with a selection cuts");
      equal(resolveSketchHotkey(press("c"), base), undefined, "Ctrl+C with nothing selected falls through");
      equal(resolveSketchHotkey(press("v"), base)?.kind, "paste", "Ctrl+V pastes");
      equal(resolveSketchHotkey(press("v", { meta: true }), base)?.kind, "paste", "Cmd+V pastes on a Mac");
      equal(resolveSketchHotkey(press("v"), { ...base, pendingPoints: 1 }), undefined, "but not while a shape is half drawn");
      equal(resolveSketchHotkey(press("v", { shift: true }), base), undefined, "Ctrl+Shift+V is left alone");
      equal(resolveSketchHotkey(press("z"), selected), undefined, "Ctrl+Z still falls through to undo");
      equal(resolveSketchHotkey(press("a"), base)?.kind, "select-all", "Ctrl+A still selects all");
    }
  }
];
