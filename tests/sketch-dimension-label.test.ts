import { readFileSync } from "node:fs";
import { applyWorkbenchOperation, MAX_LABEL_OFFSET_PX, mergedLabelOffsets, MIN_LABEL_OFFSET_PX, parseWorkbenchProjectText, savedLabelOffsets, serializeWorkbenchProject, validateWorkbenchProject, type WorkbenchOperation, type WorkbenchProject, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { dimensionLayout } from "../packages/workbench-sketch/src/dimension-layout.js";
import { MAX_DIMENSION_OFFSET_PX, MIN_DIMENSION_OFFSET_PX, stackDimensionLabels } from "../packages/workbench-sketch/src/dimension-display.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { con, line, projectWith } from "./edit-test-kit.js";

/**
 * Where a dimension's text was dragged to is part of the sketch: it is written by one operation (one Undo step), saved with the
 * design and read back on reload. It used to live in the browser's local storage, so a design opened elsewhere showed default places.
 */

let serial = 0;
function apply(project: WorkbenchProject, operation: Record<string, unknown>): ReturnType<typeof applyWorkbenchOperation> {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:dim-label-${serial}`, expectedRevision: project.revision } as unknown as WorkbenchOperation);
}

function run(project: WorkbenchProject, operation: Record<string, unknown>): WorkbenchProject {
  const result = apply(project, operation);
  if (!result.ok) throw new Error(`${String(operation.kind)} refused: ${result.diagnostics[0]?.message}`);
  return result.value.project;
}

/** A 40 mm level line with a length dimension, and a Horizontal relation on it. */
function dimensionedLine(): { readonly project: WorkbenchProject; readonly dimensionId: string } {
  const base = projectWith([line("a", [0, 0], [40, 0])], [con("h", "horizontal", ["a"])]);
  const project = run(base, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 40 });
  const dimension = project.sketch.constraints.find((constraint) => constraint.kind === "distance");
  assert(dimension !== undefined, "the line has its length dimension");
  return { project, dimensionId: dimension.id };
}

const dimensionOf = (project: WorkbenchProject, id: string): WorkbenchSketchConstraint => {
  const found = project.sketch.constraints.find((constraint) => constraint.id === id);
  assert(found !== undefined, "the dimension is in the sketch");
  return found;
};

const repoFile = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");

export const sketchDimensionLabelTests: readonly TestCase[] = [
  {
    name: "Dimension text position: a drag is one operation that is saved with the sketch, survives reload and a value edit, and moves no geometry",
    run: () => {
      const { project, dimensionId } = dimensionedLine();
      equal(dimensionOf(project, dimensionId).labelOffsetPx, undefined, "a new dimension stands at the default place");
      const placed = run(project, { kind: "set-sketch-dimension-label", constraintId: dimensionId, offsetPx: 77.34 });
      equal(dimensionOf(placed, dimensionId).labelOffsetPx, 77.3, "the stand-off is stored on the dimension, to a tenth of a pixel");
      equal(placed.revision, project.revision + 1, "one operation, so one step to undo");
      equal(JSON.stringify(placed.sketch.entities), JSON.stringify(project.sketch.entities), "no curve moved");
      equal(dimensionOf(placed, dimensionId).valueMm, 40, "the value is untouched");
      equal(dimensionOf(placed, dimensionId).name, dimensionOf(project, dimensionId).name, "and so is its name");

      // The canvas draws the dimension line at the saved stand-off (1 mm per pixel here: 77.3 mm above the line).
      const offsets = mergedLabelOffsets(placed.sketch.constraints, {});
      equal(offsets[dimensionId], 77.3, "the saved position is what the canvas reads");
      const entity = placed.sketch.entities[0]!;
      const stacked = stackDimensionLabels([{ id: dimensionId, layoutAt: (offsetPx) => dimensionLayout(entity, "length", 40, 1, { offsetPx }), userOffsetPx: offsets[dimensionId] }], 1);
      near(stacked[0]!.layout.dimensionLine.from[1], 77.3, 1e-9, "the dimension line stands 77.3 px off the line");

      // Save and reload.
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(placed));
      assert(reloaded.ok, "the project reloads");
      equal(dimensionOf(reloaded.value, dimensionId).labelOffsetPx, 77.3, "with the label where it was put");

      // Changing the value, or making the dimension a reference, keeps the label where it is.
      const longer = run(reloaded.value, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 55 });
      equal(dimensionOf(longer, dimensionId).valueMm, 55, "the value changed");
      equal(dimensionOf(longer, dimensionId).labelOffsetPx, 77.3, "and the label stayed");
      const reference = run(longer, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 55, driven: true });
      equal(dimensionOf(reference, dimensionId).labelOffsetPx, 77.3, "a reference dimension keeps its place too");

      // Dragging again replaces the position.
      const moved = run(longer, { kind: "set-sketch-dimension-label", constraintId: dimensionId, offsetPx: 20 });
      equal(dimensionOf(moved, dimensionId).labelOffsetPx, 20, "a second drag replaces the first");
    }
  },
  {
    name: "Dimension text position: a sketch saved before positions were stored loads unchanged and keeps what this browser remembered",
    run: () => {
      const { project, dimensionId } = dimensionedLine();
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(project)) as unknown).ok, "a dimension without a saved position is valid");
      const local = { [dimensionId]: 48, "constraint:gone": 90 };
      equal(mergedLabelOffsets(project.sketch.constraints, local), local, "with nothing saved the browser's positions are used as they are");
      equal(Object.keys(savedLabelOffsets(project.sketch.constraints)).length, 0, "and the sketch reports none of its own");
      const placed = run(project, { kind: "set-sketch-dimension-label", constraintId: dimensionId, offsetPx: 120 });
      const merged = mergedLabelOffsets(placed.sketch.constraints, local);
      equal(merged[dimensionId], 120, "a position saved with the sketch wins over the browser's");
      equal(merged["constraint:gone"], 90, "other remembered positions are left alone");
      equal(MIN_LABEL_OFFSET_PX, MIN_DIMENSION_OFFSET_PX, "the stored range starts where the canvas range starts");
      equal(MAX_LABEL_OFFSET_PX, MAX_DIMENSION_OFFSET_PX, "and ends where it ends");
    }
  },
  {
    name: "Dimension text position: a relation, a missing dimension and a stand-off outside 12 to 400 px are refused with the reason",
    run: () => {
      const { project, dimensionId } = dimensionedLine();
      const missing = apply(project, { kind: "set-sketch-dimension-label", constraintId: "constraint:nope", offsetPx: 40 });
      assert(!missing.ok && missing.diagnostics[0]?.code === "BROKEN_REFERENCE", "a dimension that does not exist is a broken reference");
      const relation = apply(project, { kind: "set-sketch-dimension-label", constraintId: "constraint:h", offsetPx: 40 });
      assert(!relation.ok && /no dimension text/u.test(relation.diagnostics[0]?.message ?? ""), "a Horizontal relation has no text to place");
      for (const offsetPx of [5, 1000, "40"]) {
        const refused = apply(project, { kind: "set-sketch-dimension-label", constraintId: dimensionId, offsetPx });
        assert(!refused.ok && /12 to 400/u.test(refused.diagnostics[0]?.message ?? ""), `a stand-off of ${String(offsetPx)} is refused with the range`);
      }
      assert(!apply(project, { kind: "set-sketch-dimension-label", constraintId: dimensionId, offsetPx: Number.NaN }).ok, "a stand-off that is not a number is refused");
      const withConstraint = (constraint: WorkbenchSketchConstraint): boolean => validateWorkbenchProject(JSON.parse(JSON.stringify({ ...project, sketch: { ...project.sketch, constraints: [constraint] } })) as unknown).ok;
      assert(withConstraint({ id: "constraint:d", kind: "distance", entityIds: ["entity:a"], valueMm: 40, dimension: "length", labelOffsetPx: 64 }), "a saved position on a dimension is valid");
      assert(!withConstraint({ id: "constraint:d", kind: "distance", entityIds: ["entity:a"], valueMm: 40, dimension: "length", labelOffsetPx: 5000 }), "a position outside the range is not");
      assert(!withConstraint({ id: "constraint:h", kind: "horizontal", entityIds: ["entity:a"], labelOffsetPx: 64 }), "nor is one on a relation");
    }
  },
  {
    name: "Dimension text position: the sketch canvas writes the drag to the project and no longer says the position is not part of the model",
    run: () => {
      const workspace = repoFile("apps/studio-web/src/workspaces/SketchWorkspace.tsx");
      const app = repoFile("apps/studio-web/src/App.tsx");
      assert(workspace.includes("props.onPlaceDimensionLabel(labelDrag.constraintId, dragged.offsetPx)"), "releasing a dragged label hands the position to the project");
      assert(workspace.includes("mergedLabelOffsets(props.sketch.constraints, localDimensionOffsets)"), "the canvas draws with the saved positions first");
      assert(!workspace.includes("it is not part of the model"), "the old browser-only message is gone");
      assert(app.includes('onPlaceDimensionLabel={(constraintId, offsetPx) => applyProjectOperation({ kind: "set-sketch-dimension-label", constraintId, offsetPx })}'), "the app applies it as one audited operation");
    }
  }
];
