import {
  applyWorkbenchOperation,
  createWorkbenchProject,
  friendlySketchText,
  sketchConstraintNames,
  sketchEntityName,
  sketchEntityNames,
  type SketchEntity,
  type WorkbenchOperation,
  type WorkbenchProject,
  type WorkbenchSketchConstraint
} from "../packages/workbench-core/src/index.js";
import { SKETCH_HOTKEY_HELP, SKETCH_LETTER_FAMILIES, resolveSketchHotkey, sketchToolHotkeyChip, type SketchHotkeyContext, type SketchHotkeyInput } from "../packages/workbench-sketch/src/hotkeys.js";
import type { SketchTool } from "../packages/workbench-sketch/src/index.js";
import { DATUM_PLANE_NAMES, INITIAL_PLANE_OFFER, decidePlaneOffer, describeSketchPlane, existingSketchPlanes, planeOfferAfterFinish } from "../apps/studio-web/src/sketch-plane-ui.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/**
 * Regression tests for the Sketch app chrome: ribbon hotkey chips that work, shortcut help that matches the keys, friendly curve names
 * instead of generated ids, and the sketch-plane chip and offer rules. The persistence, toast, build-info and unit tests that belong to
 * the same work package are registered from here too (see the bottom of this file).
 */

const idle: SketchHotkeyContext = { tool: "select", pendingPoints: 0, selectionCount: 0, curveSelectionCount: 0, dimensionMode: false, editToolActive: false, pickingRelation: false, dragging: false, dynamicFieldCount: 0 };
const press = (key: string, extra: Partial<SketchHotkeyInput> = {}): SketchHotkeyInput => ({ key, ctrl: false, meta: false, alt: false, shift: false, ...extra });

/** Presses the key `times` in a row, the way the workspace does: each press sees the tool the previous one chose. */
function pressRepeatedly(key: string, times: number, start: SketchTool = "select"): SketchTool[] {
  const chosen: SketchTool[] = [];
  let tool = start;
  for (let index = 0; index < times; index += 1) {
    const action = resolveSketchHotkey(press(key), { ...idle, tool });
    assert(action?.kind === "tool", `${key} press ${index + 1} selects a tool`);
    tool = action.tool;
    chosen.push(tool);
  }
  return chosen;
}

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): ReturnType<typeof applyWorkbenchOperation> {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-chrome-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}
function mustRun(project: WorkbenchProject, operation: Op): WorkbenchProject {
  const result = run(project, operation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const UUID_A = "3f9a1c52-40cb-4d7e-9b2a-0c5d6e7f8a91";
const UUID_B = "8e1c0a77-1d2b-4a3c-8f4e-5a6b7c8d9e0f";
const UUID_C = "c0ffee00-aaaa-4bbb-8ccc-123456789abc";
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/u;

function line(id: string, start: readonly [number, number], end: readonly [number, number]): SketchEntity {
  return { id, kind: "line", start, end, construction: false };
}

export const sketchChromeTests: TestCase[] = [
  {
    name: "Sketch hotkeys E14: pressing R, C or A again steps through the 2-point, centre and 3-point variants, and E selects the ellipse",
    run: () => {
      equal(pressRepeatedly("r", 4).join(","), "rectangle,rectangle-center,rectangle-three-point,rectangle", "R cycles the three rectangles and wraps");
      equal(pressRepeatedly("c", 4).join(","), "circle,circle-two-point,circle-three-point,circle", "C cycles the three circles and wraps");
      equal(pressRepeatedly("a", 4).join(","), "arc,arc-center,arc-tangent,arc", "A cycles the three arcs and wraps");
      equal(pressRepeatedly("e", 1)[0], "ellipse", "E selects the ellipse (it returned nothing before)");
      equal(pressRepeatedly("l", 2).join(","), "line,line", "L keeps the line tool");
      equal(pressRepeatedly("r", 1, "circle")[0], "rectangle", "R from another family's tool starts at the first rectangle");
      equal(pressRepeatedly("c", 1, "rectangle-center")[0], "circle", "C from the rectangles starts at the first circle");
    }
  },
  {
    name: "Sketch hotkeys E14: every ribbon chip is a key sequence that really selects that tool, and chips are unique",
    run: () => {
      const chips = new Map<string, SketchTool>();
      for (const [letter, family] of Object.entries(SKETCH_LETTER_FAMILIES)) {
        family.forEach((tool, index) => {
          const chip = sketchToolHotkeyChip(tool);
          assert(chip !== undefined, `${tool} has a chip`);
          assert(!chips.has(chip), `chip ${chip} is unique`);
          chips.set(chip, tool);
          // Pressing the letter index+1 times from the select tool lands on this tool.
          equal(pressRepeatedly(letter, index + 1).at(-1), tool, `${chip} (${letter} x${index + 1}) selects ${tool}`);
        });
      }
      for (const dead of ["R2", "R3", "C2", "C3", "A2", "A3"]) assert(!chips.has(dead), `the dead chip ${dead} is gone`);
      equal(sketchToolHotkeyChip("rectangle-center"), "R ×2", "the centre rectangle reads R ×2");
      equal(sketchToolHotkeyChip("arc-tangent"), "A ×3", "the tangent arc reads A ×3");
      equal(sketchToolHotkeyChip("polygon"), undefined, "a tool without a key shows no chip");
      equal(sketchToolHotkeyChip("select"), "V", "select is V");
    }
  },
  {
    name: "Sketch hotkeys E15: Enter ends a line chain, Shift+Tab focuses the last typed field, and the help text states what the keys do",
    run: () => {
      const drawing: SketchHotkeyContext = { ...idle, tool: "line", pendingPoints: 1 };
      equal(resolveSketchHotkey(press("Enter"), drawing)?.kind, "end-chain", "Enter on the Line tool with a pending point ends the chain");
      equal(resolveSketchHotkey(press("Enter"), { ...drawing, pendingPoints: 0 }), undefined, "Enter with nothing pending falls through");
      equal(resolveSketchHotkey(press("Enter"), { ...idle, tool: "profile", pendingPoints: 1 })?.kind, "finish", "Enter still finishes a profile");
      equal(resolveSketchHotkey(press("Enter"), { ...idle, tool: "spline", pendingPoints: 3 })?.kind, "finish", "Enter still finishes a spline");
      const typing: SketchHotkeyContext = { ...drawing, dynamicFieldCount: 2 };
      const forwards = resolveSketchHotkey(press("Tab"), typing);
      const backwards = resolveSketchHotkey(press("Tab", { shift: true }), typing);
      assert(forwards?.kind === "focus-dynamic" && !forwards.backwards, "Tab focuses the first field");
      assert(backwards?.kind === "focus-dynamic" && backwards.backwards, "Shift+Tab focuses the last field (it returned nothing before)");
      equal(resolveSketchHotkey(press("Tab", { shift: true }), drawing), undefined, "Shift+Tab falls through when no fields show");
      // Backspace / Delete behaviour is what the help claims.
      const selected: SketchHotkeyContext = { ...idle, curveSelectionCount: 2, selectionCount: 2 };
      equal(resolveSketchHotkey(press("Backspace"), selected)?.kind, "delete-selection", "Backspace deletes the selection with no points pending");
      equal(resolveSketchHotkey(press("Backspace"), { ...selected, tool: "line", pendingPoints: 1 })?.kind, "undo-point", "Backspace removes the last point while drawing");
      equal(resolveSketchHotkey(press("Delete"), { ...selected, tool: "line", pendingPoints: 1 })?.kind, "cancel-points", "Delete drops the pending points even with curves selected");
      const help = new Map(SKETCH_HOTKEY_HELP.map((entry) => [entry.keys, entry.action]));
      assert(help.get("Backspace")?.includes("delete the selected curves") === true, "the Backspace help mentions deleting the selection");
      assert(help.get("Delete")?.includes("points") === true && help.get("Delete")?.includes("delete the selected curves") === true, "the Delete help says what it does while drawing and when idle");
      assert(help.get("Enter")?.includes("line chain") === true && help.get("Enter")?.includes("profile") === true, "the Enter help lists line chains and profiles, not only splines");
      assert(help.has("E"), "the help lists E");
      assert(help.has("Tab / Shift+Tab"), "the help lists Tab and Shift+Tab");
    }
  },
  {
    name: "Sketch names (live walkthrough item 3): every curve gets a sequential per-kind name, in sketch order",
    run: () => {
      const entities: SketchEntity[] = [
        line(`entity:user-${UUID_A}`, [0, 0], [10, 0]),
        { id: `entity:user-${UUID_B}`, kind: "circle", center: [5, 5], radiusMm: 2, construction: false },
        line(`entity:user-${UUID_C}`, [10, 0], [10, 10]),
        { id: "entity:arc-1", kind: "arc", start: [0, 0], mid: [1, 1], end: [2, 0], construction: false }
      ];
      const names = sketchEntityNames(entities);
      equal(names.get(entities[0]!.id), "Line 1", "first line");
      equal(names.get(entities[1]!.id), "Circle 1", "first circle");
      equal(names.get(entities[2]!.id), "Line 2", "second line");
      equal(names.get(entities[3]!.id), "Arc 1", "first arc");
      equal(sketchEntityName({ entities }, "entity:missing"), "a sketch curve", "an unknown id gets a neutral phrase, not the id");
      const constraints: WorkbenchSketchConstraint[] = [
        { id: `constraint:user-${UUID_A}`, kind: "horizontal", entityIds: [entities[0]!.id] },
        { id: `constraint:user-${UUID_B}`, kind: "horizontal", entityIds: [entities[2]!.id] },
        { id: `constraint:user-${UUID_C}`, kind: "coincident", entityIds: [entities[0]!.id, entities[2]!.id], points: ["end", "start"] }
      ];
      const relations = sketchConstraintNames(constraints);
      equal(relations.get(`constraint:user-${UUID_B}`), "Horizontal 2", "relations are numbered per kind too");
      equal(relations.get(`constraint:user-${UUID_C}`), "Coincident 1", "coincident relation");
    }
  },
  {
    name: "Sketch names (live walkthrough item 3): status messages say \"Line 1\" instead of the generated entity id, through the real operations",
    run: () => {
      const id = `entity:user-${UUID_A}`;
      let project = createWorkbenchProject("project:test-chrome-names");
      const added = run(project, { kind: "add-sketch-entity", entity: line(id, [0, 0], [20, 0]) });
      assert(added.ok, "the line is added");
      assert(!uuidPattern.test(added.value.summary), `the add summary has no generated id: ${added.value.summary}`);
      const lineName = sketchEntityName(added.value.project.sketch, id);
      assert(/^Line \d+$/u.test(lineName) && added.value.summary === `Added ${lineName}.`, `the add summary names the line: ${added.value.summary}`);
      project = added.value.project;
      assert(!project.audit.some((entry) => uuidPattern.test(entry.summary)), "the audit log carries the friendly summary too");
      const dimensioned = run(project, { kind: "set-sketch-dimension", entityId: id, dimension: "length", valueMm: 30 });
      assert(dimensioned.ok, `the length is set: ${dimensioned.ok ? "" : dimensioned.diagnostics[0]?.message}`);
      assert(!uuidPattern.test(dimensioned.value.summary), `the dimension summary has no generated id: ${dimensioned.value.summary}`);
      assert(dimensioned.value.summary.includes(lineName), `the dimension summary names the line: ${dimensioned.value.summary}`);
      const missing = run(dimensioned.value.project, { kind: "set-sketch-dimension", entityId: `entity:user-${UUID_B}`, dimension: "length", valueMm: 5 });
      assert(!missing.ok, "a missing curve is refused");
      assert(missing.ok || !missing.diagnostics.some((entry) => uuidPattern.test(entry.message) || uuidPattern.test(entry.recovery)), "the refusal does not leak the generated id");
    }
  },
  {
    name: "Sketch names (live walkthrough item 3): a constraint-conflict message names the curves, not their generated ids",
    run: () => {
      const a = `entity:user-${UUID_A}`;
      const b = `entity:user-${UUID_B}`;
      let project = createWorkbenchProject("project:test-chrome-conflict");
      project = mustRun(project, { kind: "add-sketch-entity", entity: line(a, [0, 0], [20, 0]) });
      project = mustRun(project, { kind: "add-sketch-entity", entity: line(b, [20, 0], [20, 15]) });
      project = mustRun(project, { kind: "add-sketch-constraint", constraint: { id: `constraint:user-${UUID_C}`, kind: "coincident", entityIds: [a, b], points: ["end", "start"] } });
      project = mustRun(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:fixed-a", kind: "fixed", entityIds: [a] } });
      // Moving the fixed line is refused; whatever the outcome text is, it must not carry a generated id.
      const attempt = run(project, { kind: "apply-sketch-edit", label: "Move the fixed line", removeEntityIds: [], addEntities: [], addConstraints: [], updateEntities: [line(a, [5, 5], [25, 5])] });
      assert(!attempt.ok && attempt.diagnostics[0]?.code === "CONSTRAINT_CONFLICT", "moving the fixed line is a constraint conflict");
      const text = attempt.diagnostics.map((entry) => `${entry.message} ${entry.recovery}`).join(" ");
      assert(text.includes(sketchEntityName(project.sketch, b)), `the message names the moved line as ${sketchEntityName(project.sketch, b)}: ${text}`);
      assert(!uuidPattern.test(text), `no generated id in: ${text}`);
      assert(!/user-[0-9a-f]{8}/u.test(text), `no id fragment in: ${text}`);
    }
  },
  {
    name: "Sketch names: friendlySketchText rewrites generated ids (with or without the entity: prefix, with a leading kind word) and leaves hand-written ids alone",
    run: () => {
      const entities: SketchEntity[] = [line(`entity:user-${UUID_A}`, [0, 0], [1, 0]), line(`entity:user-${UUID_B}`, [0, 0], [0, 1]), line("entity:chain1", [0, 0], [2, 2])];
      const sketch = { entities, constraints: [] };
      equal(friendlySketchText(`Set length of entity:user-${UUID_B} to 5 mm.`, [sketch]), "Set length of Line 2 to 5 mm.", "prefix form");
      equal(friendlySketchText(`Moved line user-${UUID_A}`, [sketch]), "Moved Line 1", "kind word plus bare id names the curve once");
      equal(friendlySketchText(`conflict on user-${UUID_A}, user-${UUID_B}.`, [sketch]), "conflict on Line 1, Line 2.", "several ids in a list");
      equal(friendlySketchText("Moved line chain1", [sketch]), "Moved line chain1", "a short hand-written id is untouched");
      equal(friendlySketchText(`Deleted entity:user-${UUID_C}.`, [sketch]), "Deleted a sketch curve.", "an id no sketch knows never leaks");
      equal(friendlySketchText(`Deleted entity:user-${UUID_C}.`, [sketch, { entities: [line(`entity:user-${UUID_C}`, [0, 0], [1, 1])], constraints: [] }]), "Deleted Line 1.", "an earlier sketch can name a curve the later one lost");
      equal(friendlySketchText("Nothing to rewrite.", [sketch]), "Nothing to rewrite.", "plain text passes through");
    }
  },
  {
    name: "Sketch plane chip: the plane is described with its offset, tilt or three-point origin, and the wording is shared by the chip and the status line",
    run: () => {
      equal(describeSketchPlane({ plane: "datum:xy" }).chip, "Sketch plane: Top (XY)", "bare top plane");
      equal(describeSketchPlane({ plane: "datum:xz", planeOffsetMm: 25 }).chip, "Sketch plane: Front (XZ) · offset 25 mm", "front plane with an offset");
      equal(describeSketchPlane({ plane: "datum:yz", planeOffsetMm: -5.5, planeTilt: { axis: "y", angleDeg: 30 } }).chip, "Sketch plane: Right (YZ) · offset -5.5 mm · tilted 30° about Y", "offset and tilt");
      const three = describeSketchPlane({ plane: "datum:xy", planeFrame: { originMm: [1, 2, 3], uAxis: [1, 0, 0], normal: [0, 0, 1] } });
      equal(three.name, "Plane through three points", "three-point plane name");
      equal(three.chip, "Sketch plane: Plane through three points · origin (1, 2, 3) mm", "three-point chip shows the origin");
      equal(describeSketchPlane({ plane: "datum:xy", planeOffsetMm: 10 }).status, "Sketch plane: Top (XY), offset 10 mm.", "status sentence");
      equal(Object.keys(DATUM_PLANE_NAMES).length, 3, "three datum planes");
    }
  },
  {
    name: "Sketch plane dialog: existing sketch planes come from the timeline, newest first, one per placement, without the current plane",
    run: () => {
      let project = createWorkbenchProject("project:test-chrome-planes");
      const place = (plane: "datum:xy" | "datum:xz", offsetMm?: number): void => {
        project = mustRun(project, { kind: "new-design-sketch", plane, ...(offsetMm === undefined ? {} : { offsetMm }) });
        project = mustRun(project, { kind: "add-sketch-entity", entity: line(`entity:l-${serial}`, [0, 0], [10, 0]) });
        project = mustRun(project, { kind: "commit-design-sketch", featureId: `feature:sketch-${serial}`, name: `Sketch ${serial}` });
      };
      place("datum:xy");
      place("datum:xz", 20);
      place("datum:xy");
      const features = project.design?.features ?? [];
      const list = existingSketchPlanes(features);
      equal(list.length, 2, "the two distinct placements are listed once each");
      equal(list[0]?.plane, "datum:xy", "newest first (the last XY sketch)");
      equal(list[1]?.description, "Front (XZ) · offset 20 mm", "the offset front plane is described");
      const withoutCurrent = existingSketchPlanes(features, { plane: "datum:xy" });
      equal(withoutCurrent.length, 1, "the current plane is not repeated");
      equal(withoutCurrent[0]?.offsetMm, 20, "the remaining entry keeps its offset");
    }
  },
  {
    name: "Sketch plane offer (c): the plane choice is offered on the first entry of a session, after Finish Sketch, and for an empty sketch, never blocking and never from inside Sketch",
    run: () => {
      let state = INITIAL_PLANE_OFFER;
      const first = decidePlaneOffer(state, "sketch", "part", 0);
      assert(first.offer && first.mode === "set", "an empty sketch offers, moving the empty sketch");
      state = first.next;
      equal(decidePlaneOffer(state, "sketch", "part", 6).offer, false, "a sketch with curves, already offered, opens directly");
      equal(decidePlaneOffer(state, "sketch", "sketch", 0).offer, false, "clicking the Sketch tab while in Sketch never offers");
      equal(decidePlaneOffer(state, "part", "sketch", 0).offer, false, "entering another workspace never offers");
      const afterFinish = planeOfferAfterFinish(state);
      const second = decidePlaneOffer(afterFinish, "sketch", "part", 6);
      assert(second.offer && second.mode === "new", "after Finish Sketch the next entry offers a NEW sketch (the finished curves stay put)");
      equal(decidePlaneOffer(second.next, "sketch", "part", 6).offer, false, "once offered the flag resets until the next Finish");
      const fresh = decidePlaneOffer(INITIAL_PLANE_OFFER, "sketch", "assembly", 4);
      assert(fresh.offer && fresh.mode === "new", "the first entry with an existing sketch offers a new sketch, with Continue available in the dialog");
    }
  }
];
