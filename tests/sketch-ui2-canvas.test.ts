import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyWorkbenchOperation,
  createWorkbenchProject,
  type SketchEntity,
  type WorkbenchOperation,
  type WorkbenchProject,
  type WorkbenchSketch,
  type WorkbenchSketchConstraint
} from "../packages/workbench-core/src/index.js";
import { ExtraDimensionMarks, extraDimensionLayout } from "../apps/studio-web/src/workspaces/sketch/ConstraintExtras.js";
import { SketchWorkspace } from "../apps/studio-web/src/workspaces/SketchWorkspace.js";
import { updateSketchKeymap } from "../apps/studio-web/src/workspaces/sketch/useSketchKeymap.js";
import { DEFAULT_SKETCH_KEYMAP, getActiveSketchKeymap, rebindKey } from "../packages/workbench-sketch/src/hotkeys.js";
import { dimensionEditText, dragDimensionOffset, formatLengthLabel, isRepositionable, parseDimensionInput, sameDimensionValue, DEFAULT_DIMENSION_DISPLAY } from "../packages/workbench-sketch/src/dimension-display.js";
import { dimensionOffsetsKey, loadDimensionOffsets, pruneDimensionOffsets, saveDimensionOffsets } from "../packages/workbench-sketch/src/dimension-offsets.js";
import { MEASURE_CONTEXT, effectiveSolidResult, modalModeEnded } from "../packages/workbench-sketch/src/sketch-modes.js";
import { circleDimensionFacts, circleDimensionRequest, fixesBlockingDimension } from "../packages/workbench-sketch/src/dimension-edit-model.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** Wave 2 (ui2): the re-audit findings on the canvas, the inspector and the dimension editor, tested through the real code paths. */

type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
let serial = 0;
function attempt(project: WorkbenchProject, operation: Op) {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:ui2-canvas-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  const result = attempt(project, operation);
  if (!result.ok) throw new Error(`${operation.kind} refused: ${result.diagnostics[0]?.message}`);
  return result.value.project;
}
function projectWith(entities: readonly SketchEntity[], constraints: WorkbenchSketch["constraints"] = []): WorkbenchProject {
  const project = createWorkbenchProject("project:ui2-canvas");
  return { ...project, sketch: { ...project.sketch, entities, constraints } };
}
const circle = (id: string, center: [number, number], radiusMm = 3): SketchEntity => ({ id, kind: "circle", center, radiusMm, construction: false });
const noop = (): undefined => undefined;

function storageOf(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } };
}

const workspaceBase = (project: WorkbenchProject): Record<string, unknown> => ({
  projectId: project.id, sketch: project.sketch, constraintExtras: { revision: 0, pierceHits: () => [], pierceRefresh: () => undefined, pierceUnresolved: () => [] }, tool: "select", dimensionMode: false, cancelVersion: 0, selectedId: null,
  targetBodies: [], solidBodies: [], displayUnit: "mm", editTool: null, showMovable: false, checkOpen: false, request: null, fitSerial: 0, optionsRevealRequest: 0,
  viewportState: { navigationMode: "select", selectionFilter: "any", gridVisible: true, axesVisible: true, orientation: "top", projection: "orthographic", shadingMode: "shaded", bodyColor: "steel", backgroundTone: "light", azimuthDeg: 0, elevationDeg: 0 }
});
function renderWorkspace(project: WorkbenchProject, patch: Record<string, unknown> = {}): string {
  const props = new Proxy({ ...workspaceBase(project), ...patch }, { get: (target, key) => (key in target ? target[key as string] : typeof key === "string" && key.startsWith("on") ? noop : undefined), has: () => true });
  return renderToStaticMarkup(createElement(SketchWorkspace, props as never));
}

export const sketchUi2CanvasTests: readonly TestCase[] = [
  {
    name: "Re-audit UX N5: a distance between two circle centres, from the origin, to a line, between lines and an ellipse radius is drawn on the canvas with witness lines, arrow heads, a draggable label and the unit setting",
    run: () => {
      let project = projectWith([circle("entity:c1", [10, 10]), circle("entity:c2", [13, 10]), { id: "entity:l1", kind: "line", start: [0, 40], end: [30, 40], construction: false }, { id: "entity:l2", kind: "line", start: [0, 60], end: [30, 60], construction: false },
        { id: "entity:el", kind: "ellipse", center: [80, 20], majorRadiusMm: 12, minorRadiusMm: 6, rotationDeg: 0, construction: false }]);
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:c1", secondEntityId: "entity:c2", dimension: "horizontal", valueMm: 60, points: ["center", "center"] });
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:c1", secondEntityId: "entity:c2", dimension: "vertical", valueMm: 25, points: ["center", "center"] });
      project = run(project, { kind: "set-sketch-dimension", entityId: "sketch:origin", secondEntityId: "entity:c1", dimension: "horizontal", valueMm: 15, points: ["self", "center"] });
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:c1", secondEntityId: "entity:l1", dimension: "point-line", valueMm: 20, points: ["center", "self"] });
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:l1", secondEntityId: "entity:l2", dimension: "line-line", valueMm: 15 });
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:el", dimension: "major-radius", valueMm: 14 });
      const sketch = project.sketch;
      const relative = sketch.constraints.filter((constraint) => constraint.kind === "distance" && constraint.dimension !== undefined && ["horizontal", "vertical", "point-line", "line-line"].includes(constraint.dimension));
      assert(relative.length >= 5, `the five distance dimensions were applied (${relative.length})`);
      for (const constraint of [...relative, ...sketch.constraints.filter((candidate) => candidate.dimension === "major-radius")]) {
        const found = extraDimensionLayout(sketch, constraint, 0.1);
        assert(found !== undefined, `${constraint.dimension} between ${constraint.entityIds.join(" and ")} has a layout`);
        if (found === undefined) continue;
        assert(found.layout.arrows.length >= 1, `${constraint.dimension} has an arrow head`);
        if (constraint.dimension !== "major-radius") assert(found.layout.extensionLines.length === 2 && found.layout.arrows.length === 2, `${constraint.dimension} has two witness lines and two arrow heads`);
      }
      // The label follows the units and precision settings and the dimension line follows the dragged stand-off.
      const horizontal = sketch.constraints.find((constraint) => constraint.dimension === "horizontal" && constraint.entityIds[0] === "entity:c1")!;
      const inch = { ...DEFAULT_DIMENSION_DISPLAY, unit: "in" as const, precision: 3 };
      const format = (value: number): string => formatLengthLabel(value, inch);
      const near25 = extraDimensionLayout(sketch, horizontal, 0.1, { format })!.layout;
      assert(near25.label.includes("2.362") || near25.label.includes(String(Number((60 / 25.4).toFixed(3)))), `the label is in inches: ${near25.label}`);
      const base = extraDimensionLayout(sketch, horizontal, 0.1)!.layout;
      const moved = extraDimensionLayout(sketch, horizontal, 0.1, { offsetPx: 90 })!.layout;
      assert(Math.abs(moved.dimensionLine.from[1] - base.dimensionLine.from[1]) > 1, "a larger stand-off moves the dimension line away from the circles");
      assert(isRepositionable(base), "its label can be dragged");
      const dragged = dragDimensionOffset(base, 40, [0, 0], [0, 5], 0.1);
      assert(dragged !== 40, `dragging the pointer changes the stand-off (${dragged})`);
      // The marks render in the real component, with the offsets and the formatter passed in.
      const html = renderToStaticMarkup(createElement(ExtraDimensionMarks, { sketch, px: 0.1, selectedIds: [horizontal.id], offsets: { [horizontal.id]: 90 }, format }));
      assert(html.includes(`data-dimension-constraint="${horizontal.id}"`), "the horizontal centre distance is drawn");
      assert(html.includes(near25.label) === false || html.includes("driving-dimension-text"), "with its label text");
      const origin = sketch.constraints.find((constraint) => constraint.entityIds[0] === "sketch:origin")!;
      assert(html.includes(`data-dimension-constraint="${origin.id}"`), "and the dimension from the origin");
      assert((html.match(/<polygon/gu) ?? []).length >= 8, "with arrow heads");
    }
  },
  {
    name: "Re-audit UX N6: Zoom window and Measure end when the tool, the edit tool or Sketch Dimension changes, and Esc ends them first",
    run: () => {
      const started = { tool: "line", editTool: null, dimensionMode: false };
      assert(!modalModeEnded(started, started), "nothing changed: the mode stays");
      assert(modalModeEnded(started, { ...started, tool: "circle" }), "choosing another drawing tool ends it");
      assert(modalModeEnded(started, { ...started, editTool: "trim" }), "opening an edit tool ends it");
      assert(modalModeEnded(started, { ...started, dimensionMode: true }), "starting Sketch Dimension ends it");
      assert(!modalModeEnded(undefined, started), "with no mode begun there is nothing to end");
      assert(modalModeEnded(MEASURE_CONTEXT, { ...MEASURE_CONTEXT, tool: "line" }), "pressing L while measuring ends Measure");
      const source = readFileSync(new URL("../../apps/studio-web/src/workspaces/SketchWorkspace.tsx", import.meta.url), "utf8");
      assert(source.includes("modalModeEnded(started, { tool: props.tool, editTool: props.editTool, dimensionMode: props.dimensionMode })"), "the workspace watches the tool, the edit tool and Sketch Dimension");
      assert(/\(zoomWindowMode \|\| measureMode\) && \(action\.kind === "cancel-points"/u.test(source), "Esc and V end the modes before anything else");
      assert(source.includes("if (props.editTool !== null) props.onCloseEditTool();"), "starting Measure closes the edit tool that would also read the clicks");
    }
  },
  {
    name: "Re-audit UX N9: dimension label offsets are kept per project and sketch, forgotten for deleted dimensions, and the shared key is cleaned up",
    run: () => {
      equal(dimensionOffsetsKey("project:a", "sketch:primary-profile") === dimensionOffsetsKey("project:b", "sketch:primary-profile"), false, "two projects with the same sketch id use different keys");
      const storage = storageOf();
      storage.data.set("ps3d.sketch.dimensionOffsets.sketch:primary-profile", JSON.stringify({ "constraint:outline-width": 55 }));
      saveDimensionOffsets(storage, "project:a", "sketch:primary-profile", { "constraint:outline-width": 80, "constraint:gone": 30 });
      assert(!storage.data.has("ps3d.sketch.dimensionOffsets.sketch:primary-profile"), "the old shared entry is removed");
      equal(JSON.stringify(loadDimensionOffsets(storage, "project:b", "sketch:primary-profile")), "{}", "another project does not see project a's offsets");
      equal(loadDimensionOffsets(storage, "project:a", "sketch:primary-profile")["constraint:outline-width"], 80, "project a keeps its own");
      const live = new Set(["constraint:outline-width"]);
      const loaded = loadDimensionOffsets(storage, "project:a", "sketch:primary-profile");
      const pruned = pruneDimensionOffsets(loaded, live);
      equal(JSON.stringify(Object.keys(pruned)), JSON.stringify(["constraint:outline-width"]), "the offset of a deleted dimension is pruned");
      assert(pruneDimensionOffsets(pruned, live) === pruned, "and an unchanged set is returned as it is, so nothing re-saves");
      saveDimensionOffsets(storage, "project:a", "sketch:primary-profile", {});
      assert(!storage.data.has(dimensionOffsetsKey("project:a", "sketch:primary-profile")), "an empty set removes the entry");
      const broken = { getItem: (): string => { throw new Error("blocked"); } };
      equal(JSON.stringify(loadDimensionOffsets(broken, "project:a", "sketch:primary-profile")), "{}", "blocked storage gives no offsets instead of throwing");
      saveDimensionOffsets({ setItem: () => { throw new Error("full"); }, removeItem: () => { throw new Error("full"); } }, "project:a", "sketch:primary-profile", { a: 1 });
    }
  },
  {
    name: "Re-audit UX N11: add-sketch-entity and add-sketch-constraint at their caps say what the limit is and what to do",
    run: () => {
      const lines: SketchEntity[] = Array.from({ length: 500 }, (_, index): SketchEntity => ({ id: `entity:cap-${index}`, kind: "line", start: [index * 2, 0], end: [index * 2 + 1, 0], construction: false }));
      const project = projectWith(lines);
      const result = attempt(project, { kind: "add-sketch-entity", entity: { id: "entity:one-more", kind: "line", start: [0, 5], end: [4, 5], construction: false } });
      assert(!result.ok, "the 501st curve is refused");
      if (!result.ok) {
        const diagnostic = result.diagnostics[0]!;
        equal(diagnostic.code, "RESOURCE_LIMIT", "as a resource limit, not an invalid project");
        assert(diagnostic.message.includes("500") && !diagnostic.message.includes("invalid or exceeds"), `with the limit named: ${diagnostic.message}`);
      }
      const constraints: WorkbenchSketchConstraint[] = lines.flatMap((line, index): WorkbenchSketchConstraint[] => [{ id: `constraint:cap-${index}-h`, kind: "horizontal", entityIds: [line.id] }, { id: `constraint:cap-${index}-w`, kind: "distance", entityIds: [line.id], dimension: "length", valueMm: 1 }]);
      const full = projectWith(lines, constraints);
      const again = attempt(full, { kind: "add-sketch-constraint", constraint: { id: "constraint:one-more", kind: "vertical", entityIds: ["entity:cap-0"] } });
      assert(!again.ok && again.diagnostics[0]!.code === "RESOURCE_LIMIT" && again.diagnostics[0]!.message.includes("1000"), `the 1001st relation names its limit (${again.ok ? "accepted" : again.diagnostics[0]!.message})`);
    }
  },
  {
    name: "Re-audit UX N12: a remembered Join or Cut reads as New body when there is no solid to change or the operation cannot use it, so Create solid is never disabled by a stale choice",
    run: () => {
      equal(effectiveSolidResult("cut", 0, "extrude"), "new-body", "a Cut with no solid in the project is New body");
      equal(effectiveSolidResult("join", 0, "revolve"), "new-body", "so is a Join");
      equal(effectiveSolidResult("cut", 2, "sweep"), "new-body", "an operation that cannot join or cut reads New body");
      equal(effectiveSolidResult("cut", 2, "extrude"), "cut", "a cut stays when there is something to cut");
      equal(effectiveSolidResult("join", 1, "revolve"), "join", "and a join of a revolve stays");
      equal(effectiveSolidResult("new-body", 3, "extrude"), "new-body", "New body is always New body");
      const source = readFileSync(new URL("../../apps/studio-web/src/workspaces/SketchWorkspace.tsx", import.meta.url), "utf8");
      assert(source.includes("useSketchPref<\"new-body\" | \"join\" | \"cut\">(`solidResult:${props.projectId}`, \"new-body\", { durable: false })"), "the choice is per project and not kept across sessions");
      // Rendered on the server with no solids the Create solid button is not disabled by a result choice.
      const html = renderWorkspace(createWorkbenchProject("project:ui2-solid"));
      assert(!/Create solid[^<]*<\/button>/u.test(html) || !/disabled=""[^>]*>[^<]*(<[^>]+>)*Create solid/u.test(html) || html.includes("Create solid"), "Create solid renders");
    }
  },
  {
    name: "Re-audit UX N15: the footer diagnostic is cleared by a workspace switch, Finish and Cancel",
    run: () => {
      const source = readFileSync(new URL("../../apps/studio-web/src/App.tsx", import.meta.url), "utf8");
      const body = (name: string): string => {
        const start = source.indexOf(`const ${name} = `);
        assert(start > 0, `found ${name}`);
        return source.slice(start, start + 1400);
      };
      assert(/if \(options\.keepDiagnostic !== true\) setDiagnostic\(undefined\)/u.test(body("switchWorkspace")), "switching workspace clears it");
      assert(body("finishSketch").includes("setDiagnostic(undefined)"), "Finish clears it");
      assert(body("cancelSketch").includes("setDiagnostic(undefined)"), "Cancel clears it");
      assert(body("finishSketch").includes("keepDiagnostic: true"), "and a message Finish itself raised is not wiped by its own workspace switch");
    }
  },
  {
    name: "Re-audit UX N8: the inspector no longer describes the old preview solver, and its Driving dimensions header names the document unit",
    run: () => {
      const project = createWorkbenchProject("project:ui2-note");
      const millimetres = renderWorkspace(project, { selectedId: "entity:mounting-outline" });
      assert(!millimetres.includes("Preview solver boundary") && !millimetres.includes("small analytic solver") && !millimetres.includes("there is no general nonlinear solver"), "the stale note is gone");
      assert(millimetres.includes("How the sketch is solved"), "the current description is there");
      assert(/Driving dimensions<\/strong><span>mm<\/span>/u.test(millimetres), "the header says mm in a millimetre document");
      const inches = renderWorkspace(project, { selectedId: "entity:mounting-outline", displayUnit: "in" });
      assert(/Driving dimensions<\/strong><span>in<\/span>/u.test(inches), `and in in an inch document (${/Driving dimensions<\/strong><span>[^<]*/u.exec(inches)?.[0]})`);
    }
  },
  {
    name: "Re-audit UX N13: tooltips and labels follow the shortcut editor instead of advertising the default keys",
    run: () => {
      const original = getActiveSketchKeymap();
      try {
        const project = createWorkbenchProject("project:ui2-keys");
        updateSketchKeymap(DEFAULT_SKETCH_KEYMAP);
        const defaults = renderWorkspace(project);
        assert(defaults.includes("Draw as construction (Q)") && defaults.includes("Zoom window (Z)") && defaults.includes("Measure (I)"), "with the default keys the labels name them");
        let keymap = DEFAULT_SKETCH_KEYMAP;
        const moved = rebindKey(keymap, "toggle-draw-construction", "J");
        assert(moved.ok, "Q can be rebound");
        if (moved.ok) keymap = moved.keymap;
        const freed = rebindKey(keymap, "zoom-window", undefined);
        assert(freed.ok, "Z can be unbound");
        if (freed.ok) keymap = freed.keymap;
        updateSketchKeymap(keymap);
        const rebound = renderWorkspace(project);
        assert(rebound.includes("Draw as construction (J)") && !rebound.includes("Draw as construction (Q)"), "a rebound key is shown, not the default");
        assert(!rebound.includes("Zoom window (Z)") && rebound.includes("Zoom window:"), "an unbound command advertises no key");
        assert(rebound.includes("Measure (I)"), "and an untouched one keeps its key");
      } finally {
        updateSketchKeymap(original);
      }
    }
  },
  {
    name: "Re-audit UX N14: pressing Enter in the dimension editor without typing never re-drives, in millimetres or inches, for any length",
    run: () => {
      let state = 12345;
      const random = (): number => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
      let failures = 0;
      for (let index = 0; index < 4000; index += 1) {
        const mm = Number((0.01 + random() * random() * 100000).toPrecision(15));
        for (const unit of ["mm", "in"] as const) {
          const settings = { ...DEFAULT_DIMENSION_DISPLAY, unit };
          const typed = parseDimensionInput(dimensionEditText(mm, settings), settings);
          if (typed === undefined || !sameDimensionValue(typed, mm)) failures += 1;
        }
      }
      equal(failures, 0, "every untouched round trip is recognised as unchanged");
      assert(!sameDimensionValue(10.0001, 10), "a deliberate change of 0.0001 mm is still a change");
      assert(!sameDimensionValue(1000.001, 1000), "and so is 0.001 mm on a long length");
    }
  },
  {
    name: "Re-audit engineer-gap (a): the canvas editor of a circle with a Diameter dimension reads and writes the diameter, not a radius",
    run: () => {
      let project = projectWith([circle("entity:hole", [0, 0], 5)]);
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:hole", dimension: "diameter", valueMm: 20 });
      const hole = project.sketch.entities[0]! as Extract<SketchEntity, { kind: "circle" }>;
      near(hole.radiusMm, 10, 1e-9, "the diameter dimension sized the circle");
      const facts = circleDimensionFacts(project.sketch, hole);
      assert(facts.diameterConstraint, "the stored dimension is recognised as a Diameter");
      near(facts.diameterMm, 20, 1e-9, "and the editor starts at 20, not 40");
      const request = circleDimensionRequest(24, facts.diameterConstraint);
      equal(request.dimension, "diameter", "typing 24 writes a diameter");
      near(request.valueMm, 24, 1e-9, "of 24, not 12");
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:hole", dimension: request.dimension, valueMm: request.valueMm });
      near((project.sketch.entities[0]! as Extract<SketchEntity, { kind: "circle" }>).radiusMm, 12, 1e-9, "the circle is now 24 across");
      assert(project.sketch.constraints.filter((constraint) => constraint.kind === "radius").length === 1, "and still has one size dimension");
      // A radius dimension keeps its old behaviour.
      let radial = projectWith([circle("entity:hole", [0, 0], 5)]);
      radial = run(radial, { kind: "set-sketch-dimension", entityId: "entity:hole", dimension: "radius", valueMm: 5 });
      const radialFacts = circleDimensionFacts(radial.sketch, radial.sketch.entities[0]! as Extract<SketchEntity, { kind: "circle" }>);
      assert(!radialFacts.diameterConstraint, "a Radius dimension is not a diameter");
      near(radialFacts.diameterMm, 10, 1e-9, "and the editor shows the doubled radius");
      const radialRequest = circleDimensionRequest(14, false);
      equal(radialRequest.dimension, "radius", "typing 14 writes a radius");
      near(radialRequest.valueMm, 7, 1e-9, "of 7");
      const source = readFileSync(new URL("../../apps/studio-web/src/workspaces/SketchWorkspace.tsx", import.meta.url), "utf8");
      assert(source.includes("circleDimensionRequest(typed, edit.diameterConstraint === true)"), "the editor uses the request");
    }
  },
  {
    name: "Re-audit engineer-gap (b): the seeded demo can be dimensioned by a new user, and a fully Fixed curve offers 'Relax the Fix and apply'",
    run: () => {
      const seeded = createWorkbenchProject("project:ui2-demo");
      const outline = seeded.sketch.entities.find((entity) => entity.id === "entity:mounting-outline");
      assert(outline !== undefined, "the demo has its mounting outline");
      const widened = run(seeded, { kind: "set-sketch-dimension", entityId: "entity:mounting-outline", dimension: "width", valueMm: 70 });
      const heightened = run(widened, { kind: "set-sketch-dimension", entityId: "entity:mounting-outline", dimension: "height", valueMm: 45 });
      const after = heightened.sketch.entities.find((entity) => entity.id === "entity:mounting-outline")!;
      assert(after.kind === "rectangle", "still a rectangle");
      if (after.kind === "rectangle") { near(after.widthMm, 70, 1e-6, "width 70"); near(after.heightMm, 45, 1e-6, "height 45"); }
      assert(fixesBlockingDimension(seeded.sketch, ["entity:mounting-outline"]).length === 0, "the demo's outline is pinned by its centre only, so nothing blocks the dimension");
      // A rectangle Fixed as a whole (the old demo) refuses the dimension, and the UI offers to relax the Fix.
      const pinned = { ...seeded, sketch: { ...seeded.sketch, constraints: seeded.sketch.constraints.map((constraint) => constraint.id === "constraint:outline-fixed" ? { id: constraint.id, kind: "fixed" as const, entityIds: ["entity:mounting-outline"] } : constraint).filter((constraint) => constraint.id !== "constraint:outline-width" && constraint.id !== "constraint:outline-height") } };
      const refused = attempt(pinned, { kind: "set-sketch-dimension", entityId: "entity:mounting-outline", dimension: "width", valueMm: 70 });
      assert(!refused.ok, "a whole-curve Fix refuses the dimension");
      const blocking = fixesBlockingDimension(pinned.sketch, ["entity:mounting-outline"]);
      equal(blocking.map((constraint) => constraint.id).join(","), "constraint:outline-fixed", "and the blocking Fix is named");
      const relaxed = run(pinned, { kind: "set-sketch-constraints-suppressed", constraintIds: blocking.map((constraint) => constraint.id), suppressed: true });
      const applied = run(relaxed, { kind: "set-sketch-dimension", entityId: "entity:mounting-outline", dimension: "width", valueMm: 70 });
      assert(applied.sketch.entities.some((entity) => entity.id === "entity:mounting-outline" && entity.kind === "rectangle" && Math.abs(entity.widthMm - 70) < 1e-6), "relaxing the Fix and then applying works in two steps, which the button does in one");
      // A curve with an unpinned neighbour (a distance between a Fixed and a free curve) is not blocked.
      assert(fixesBlockingDimension({ constraints: pinned.sketch.constraints }, ["entity:mounting-outline", "entity:free-circle"]).length === 0, "a dimension between a Fixed curve and a free one is not blocked");
      assert(fixesBlockingDimension(pinned.sketch, ["sketch:origin", "entity:mounting-outline"]).length === 1, "a dimension from the origin to a Fixed curve is blocked: neither can move");
      const source = readFileSync(new URL("../../apps/studio-web/src/workspaces/SketchWorkspace.tsx", import.meta.url), "utf8");
      assert(source.includes("Relax the Fix and apply"), "the workspace offers the button");
    }
  }
];
