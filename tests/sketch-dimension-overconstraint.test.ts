import { readFileSync } from "node:fs";
import { parseWorkbenchProjectText, serializeWorkbenchProject, type SketchEntity, type WorkbenchProject, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { dimensionOverConstraint } from "../packages/workbench-sketch/src/dimension-overconstraint.js";
import { fresh, line, message, pipelineApply, pipelineRun, rect } from "./pipeline-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/**
 * A new dimension that the sketch already decides (redundant) or contradicts (conflict) is offered as a reference dimension instead of
 * being added as a second driving one or refused outright.
 */

function sketchOf(entities: readonly SketchEntity[], constraints: readonly WorkbenchSketchConstraint[] = []): WorkbenchProject {
  const project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
  return pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: entities, addConstraints: constraints, label: "Draw" });
}

/** A level 80 x 50 plate with its width and height driven. */
function sizedPlate(): WorkbenchProject {
  return sketchOf([rect("plate", 40, 25, 80, 50)], [
    { id: "constraint:level", kind: "horizontal", entityIds: ["entity:plate"] },
    { id: "constraint:w", kind: "distance", entityIds: ["entity:plate"], valueMm: 80, dimension: "width" },
    { id: "constraint:h", kind: "distance", entityIds: ["entity:plate"], valueMm: 50, dimension: "height" }
  ]);
}

const acrossBottom = { entityId: "entity:plate", secondEntityId: "entity:plate", dimension: "horizontal" as const, points: ["corner-0", "corner-1"] as const };

export const sketchDimensionOverConstraintTests: readonly TestCase[] = [
  {
    name: "Over-constraint check: a dimension the sketch already decides is named as redundant, one that contradicts it as a conflict, and a free one passes",
    run: () => {
      const plate = sizedPlate();
      const same = dimensionOverConstraint(plate.sketch, { ...acrossBottom, valueMm: 80 });
      assert(same !== undefined && same.kind === "redundant", `the distance across the bottom edge repeats the width: ${same?.kind}`);
      assert(/over-constrain/u.test(same.message) && same.reason.length > 0, `the message says so and carries the solver's reason: ${same.message}`);
      const other = dimensionOverConstraint(plate.sketch, { ...acrossBottom, valueMm: 70 });
      assert(other !== undefined && other.kind === "conflict", `70 against a width of 80 is a conflict: ${other?.kind}`);
      equal(dimensionOverConstraint(sketchOf([rect("plate", 40, 25, 80, 50)]).sketch, { entityId: "entity:plate", dimension: "width", valueMm: 60 }), undefined, "a first width on a free rectangle is fine");
      equal(dimensionOverConstraint(plate.sketch, { entityId: "sketch:origin", secondEntityId: "entity:plate", dimension: "horizontal", points: ["self", "corner-0"], valueMm: 10 }), undefined, "placing the sized plate from the origin is fine");
    }
  },
  {
    name: "Over-constraint check: editing a dimension that already drives, a reference request and a parameter expression are left to the operation",
    run: () => {
      const plate = sizedPlate();
      equal(dimensionOverConstraint(plate.sketch, { entityId: "entity:plate", dimension: "width", valueMm: 95 }), undefined, "changing the driving width is an edit, not a new dimension");
      equal(dimensionOverConstraint(plate.sketch, { ...acrossBottom, valueMm: 80, driven: true }), undefined, "a reference dimension constrains nothing");
      equal(dimensionOverConstraint(plate.sketch, { ...acrossBottom, valueMm: 1, expression: "plate_w" }), undefined, "an expression is evaluated by the project");
      equal(JSON.stringify(plate.sketch), JSON.stringify(sizedPlate().sketch), "the check changes nothing");
    }
  },
  {
    name: "Over-constraint offer: adding the dimension as a reference keeps the sketch clean, shows the measured value, and survives save and reload",
    run: () => {
      const plate = sizedPlate();
      // What the sketch did before for the redundant case: a second driving dimension, flagged afterwards.
      const forced = pipelineRun(plate, { kind: "set-sketch-dimension", ...acrossBottom, valueMm: 80 });
      assert(analyzeWorkbenchSketch(forced.sketch).redundant.length > 0, "a second driving dimension is redundant");
      // And for the conflicting value: a refusal.
      const refused = pipelineApply(plate, { kind: "set-sketch-dimension", ...acrossBottom, valueMm: 70 });
      assert(!refused.ok, `the conflicting value is refused as a driving dimension: ${message(refused)}`);
      // The offer: the same request as a reference dimension.
      const offered = pipelineRun(plate, { kind: "set-sketch-dimension", ...acrossBottom, valueMm: 70, driven: true });
      const reference = offered.sketch.constraints.find((constraint) => constraint.driven === true);
      assert(reference !== undefined && reference.dimension === "horizontal" && reference.valueMm === undefined, "a reference dimension is stored with no value of its own");
      const analysis = analyzeWorkbenchSketch(offered.sketch);
      equal(`${analysis.redundant.length}:${analysis.conflicts.length}`, "0:0", "nothing is redundant and nothing conflicts");
      equal(JSON.stringify(offered.sketch.entities), JSON.stringify(plate.sketch.entities), "the geometry did not move");
      // Once it is a reference, asking to drive it is checked again (it is not an edit of a driving dimension).
      assert(dimensionOverConstraint(offered.sketch, { ...acrossBottom, valueMm: 80 })?.kind === "redundant", "making the reference drive is still over-constraining");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(offered));
      assert(reloaded.ok && reloaded.value.sketch.constraints.some((constraint) => constraint.id === reference.id && constraint.driven === true), "the reference dimension is saved");
      // Undo returns to the project before the request, which is untouched.
      equal(plate.sketch.constraints.length, 3, "the earlier project still has its three relations");
    }
  },
  {
    name: "Over-constraint check: a triangle held by three lengths refuses an angle it already has, and the prompt can be clicked and read",
    run: () => {
      const joints: WorkbenchSketchConstraint[] = [
        { id: "constraint:j1", kind: "coincident", entityIds: ["entity:a", "entity:b"], points: ["end", "start"] },
        { id: "constraint:j2", kind: "coincident", entityIds: ["entity:b", "entity:c"], points: ["end", "start"] },
        { id: "constraint:j3", kind: "coincident", entityIds: ["entity:c", "entity:a"], points: ["end", "start"] },
        { id: "constraint:la", kind: "distance", entityIds: ["entity:a"], valueMm: 30, dimension: "length" },
        { id: "constraint:lb", kind: "distance", entityIds: ["entity:b"], valueMm: 40, dimension: "length" },
        { id: "constraint:lc", kind: "distance", entityIds: ["entity:c"], valueMm: 50, dimension: "length" }
      ];
      const triangle = sketchOf([line("a", [0, 0], [30, 0]), line("b", [30, 0], [30, 40]), line("c", [30, 40], [0, 0])], joints);
      const angle = dimensionOverConstraint(triangle.sketch, { entityId: "entity:a", secondEntityId: "entity:b", dimension: "angle", valueMm: 90 });
      assert(angle !== undefined, "the right angle of a 3-4-5 triangle is already decided by its sides");
      const css = readFileSync(new URL("../../apps/studio-web/src/styles/sketch-canvas-ux.css", import.meta.url), "utf8");
      const rule = css.split("\n").find((row) => row.includes(".dimension-mode-banner.relax-fix-prompt {")) ?? "";
      assert(rule.includes("pointer-events: auto"), "the prompt takes the pointer, so its buttons can be pressed (the mode banner ignores it)");
      assert(rule.includes("max-height: calc(100% -") && rule.includes("overflow-y: auto"), "it is bounded by the canvas height and scrolls inside");
      assert(css.includes(".dimension-mode-banner.relax-fix-prompt span { flex: 1 1 100%; font-size: 12px;"), "its text is 12 px");
      const workspace = readFileSync(new URL("../../apps/studio-web/src/workspaces/SketchWorkspace.tsx", import.meta.url), "utf8");
      assert(workspace.includes("Add as a reference dimension") && workspace.includes("over-constraint-prompt"), "the canvas offers the reference dimension");
    }
  },
];
