import { ACROSS_PROMPT, DOUBLED_DISTANCE_LABEL, placeAcrossDistance, placedAcross, placementPreview, resolveDimensionPair, type AcrossLinePlacement } from "../packages/workbench-sketch/src/dimension-pick.js";
import { pointDistanceLayout } from "../packages/workbench-sketch/src/point-distance-layout.js";
import { describeConstraint, entityNames, parseWorkbenchProjectText, serializeWorkbenchProject, type SketchEntity, type WorkbenchProject, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { measureDimensionConstraint } from "../packages/workbench-core/src/sketch-measure.js";
import { fresh, line, pipelineApply, pipelineRun } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * The half profile of a turned part is dimensioned across its centreline: pick the profile line (or a point), pick the centreline,
 * place the dimension beyond the centreline and it is a diameter. The value shown, typed and stored is the diameter; the solver holds
 * half of it as the distance to the centreline.
 */

/** A centreline up the Y axis, a wall of the half profile 10 mm to its right, and a step line whose end is a point to dimension. */
function halfProfile(): WorkbenchProject {
  const project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xz" });
  return pipelineRun(project, {
    kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], label: "Half profile",
    addEntities: [line("axis", [0, -5], [0, 40], true), line("wall", [10, 0], [10, 30]), line("step", [10, 30], [6, 30])],
    addConstraints: [
      { id: "constraint:axis-fixed", kind: "fixed", entityIds: ["entity:axis"] },
      { id: "constraint:wall-plumb", kind: "vertical", entityIds: ["entity:wall"] },
      { id: "constraint:joint", kind: "coincident", entityIds: ["entity:wall", "entity:step"], points: ["end", "start"] }
    ]
  });
}

const lineOf = (project: WorkbenchProject, id: string): Extract<SketchEntity, { kind: "line" }> => {
  const entity = project.sketch.entities.find((candidate) => candidate.id === id);
  assert(entity?.kind === "line", `${id} is a line`);
  return entity;
};
const stored = (project: WorkbenchProject, dimension: string): WorkbenchSketchConstraint => {
  const found = project.sketch.constraints.find((constraint) => constraint.kind === "distance" && constraint.dimension === dimension);
  assert(found !== undefined, `a ${dimension} dimension is stored`);
  return found;
};

export const sketchDiameterAcrossTests: readonly TestCase[] = [
  {
    name: "Sketch Dimension: a line and a centreline wait to be placed; beyond the centreline is a diameter, on the near side the distance",
    run: () => {
      const sketch = halfProfile().sketch;
      const pair = resolveDimensionPair(sketch, { entityId: "entity:wall" }, { entityId: "entity:axis" });
      assert(pair.status === "place-across", `a line and a centreline are placed, not opened at once (${pair.status})`);
      if (pair.status !== "place-across") return;
      equal(pair.prompt, ACROSS_PROMPT, "the prompt says what the two sides give");
      equal(`${pair.placement.entityId}|${pair.placement.secondEntityId}|${pair.placement.dimension}`, "entity:axis|entity:wall|line-line", "the centreline is the line it is measured from");
      assert(placedAcross(pair.placement, [-8, 12]), "a click beyond the centreline is a diameter");
      assert(!placedAcross(pair.placement, [4, 12]), "a click between the wall and the centreline is not");
      assert(!placedAcross(pair.placement, [25, 12]), "nor is a click outside the wall");
      const diameter = placeAcrossDistance(sketch, pair.placement, [-8, 12]);
      assert(typeof diameter !== "string", "the diameter resolves");
      if (typeof diameter === "string") return;
      equal(diameter.doubled, true, "it is a diameter");
      equal(diameter.label, DOUBLED_DISTANCE_LABEL, "labelled as one");
      near(diameter.measured, 20, 1e-9, "the wall 10 mm from the centreline is a 20 mm diameter");
      const radius = placeAcrossDistance(sketch, pair.placement, [4, 12]);
      assert(typeof radius !== "string" && radius.doubled === false, "the near side gives a plain distance");
      if (typeof radius !== "string") near(radius.measured, 10, 1e-9, "of 10 mm");
      // The live preview follows the pointer: across the centreline it spans from the wall to its mirror image with a diameter sign.
      const preview = placementPreview(sketch, pair.placement, [-8, 12]);
      assert(preview !== undefined && preview.constraint.doubled === true, "the preview is the diameter");
      if (preview === undefined) return;
      const layout = pointDistanceLayout(sketch, preview.constraint, preview.measured, 0.1);
      assert(layout !== undefined, "it has a layout");
      if (layout === undefined) return;
      near(Math.abs(layout.dimensionLine.to[0] - layout.dimensionLine.from[0]), 20, 1e-9, "the dimension line is 20 mm long");
      assert(layout.label.startsWith("Ø"), `the label carries the diameter sign (${layout.label})`);
      const near10 = placementPreview(sketch, pair.placement, [4, 12]);
      assert(near10 !== undefined && near10.constraint.doubled !== true, "on the near side the preview is the plain distance");
      // Either pick order works, and two ordinary lines are not placed: they open the distance at once as before.
      equal(resolveDimensionPair(sketch, { entityId: "entity:axis" }, { entityId: "entity:wall" }).status, "place-across", "centreline first works too");
      const plain = pipelineRun(halfProfile(), { kind: "toggle-sketch-construction", entityId: "entity:axis" }).sketch;
      equal(resolveDimensionPair(plain, { entityId: "entity:wall" }, { entityId: "entity:axis" }).status, "ready", "without a centreline the distance opens at once");
    }
  },
  {
    name: "A diameter across the centreline drives the profile: 30 puts the wall 15 mm out; it is kept through edits, save and reload",
    run: () => {
      let project = halfProfile();
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:axis", secondEntityId: "entity:wall", dimension: "line-line", valueMm: 30, doubled: true });
      const made = stored(project, "line-line");
      equal(made.doubled, true, "stored as a diameter");
      equal(made.valueMm, 30, "with the value that was typed");
      near(lineOf(project, "entity:wall").start[0], 15, 1e-6, "the wall is 15 mm from the centreline");
      near(lineOf(project, "entity:axis").start[0], 0, 1e-9, "the centreline did not move");
      near(measureDimensionConstraint(project.sketch, made) ?? NaN, 30, 1e-6, "it measures as 30");
      const words = describeConstraint(made, entityNames(project.sketch));
      assert(/^Diameter 30/u.test(words), `it reads as a diameter (${words})`);
      // A later edit that only gives a value (an inspector field, a parameter rebuild) keeps it a diameter.
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:axis", secondEntityId: "entity:wall", dimension: "line-line", valueMm: 40 });
      equal(stored(project, "line-line").doubled, true, "still a diameter");
      near(lineOf(project, "entity:wall").start[0], 20, 1e-6, "40 across is 20 out");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(project));
      assert(reloaded.ok, "the project reloads");
      if (!reloaded.ok) return;
      equal(stored(reloaded.value, "line-line").doubled, true, "the diameter form survives save and reload");
      // The pair is now edited as it is: no second placement, the editor shows the diameter.
      const again = resolveDimensionPair(project.sketch, { entityId: "entity:wall" }, { entityId: "entity:axis" });
      assert(again.status === "ready" && again.dimension.doubled === true && again.dimension.existing?.value === 40, "picking the pair again opens the stored diameter");
      // Asking for a plain distance turns it back: 20 from the centreline is where the wall already is.
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:axis", secondEntityId: "entity:wall", dimension: "line-line", valueMm: 20, doubled: false });
      equal(stored(project, "line-line").doubled, undefined, "a plain distance carries no flag");
      near(lineOf(project, "entity:wall").start[0], 20, 1e-6, "and nothing moved");
      // As a reference it reads the diameter and holds nothing.
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:axis", secondEntityId: "entity:wall", dimension: "line-line", valueMm: 1, driven: true, doubled: true });
      const reference = stored(project, "line-line");
      assert(reference.driven === true && reference.doubled === true && reference.valueMm === undefined, "a reference diameter");
      near(measureDimensionConstraint(project.sketch, reference) ?? NaN, 40, 1e-6, "which measures 40");
    }
  },
  {
    name: "A point and a centreline: the diameter across is placed the same way and drives the point; only a distance to a line can be a diameter",
    run: () => {
      let project = halfProfile();
      const pair = resolveDimensionPair(project.sketch, { entityId: "entity:step", ref: "end" }, { entityId: "entity:axis" });
      assert(pair.status === "place-across", "a point and a centreline are placed");
      if (pair.status !== "place-across") return;
      const placement: AcrossLinePlacement = pair.placement;
      equal(`${placement.entityId}|${placement.secondEntityId}|${placement.dimension}|${placement.points?.join("+")}`, "entity:step|entity:axis|point-line|end", "point first, centreline second");
      const found = placeAcrossDistance(project.sketch, placement, [-3, 30]);
      assert(typeof found !== "string" && found.doubled === true, "placed beyond the centreline it is a diameter");
      if (typeof found !== "string") near(found.measured, 12, 1e-9, "the point 6 mm out is a 12 mm diameter");
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:step", secondEntityId: "entity:axis", dimension: "point-line", points: ["end"], valueMm: 16, doubled: true });
      near(Math.abs(lineOf(project, "entity:step").end[0]), 8, 1e-6, "16 across puts the point 8 mm from the centreline");
      equal(stored(project, "point-line").doubled, true, "stored as a diameter");
      // The flag belongs to distances to a line only.
      const onLength = pipelineApply(project, { kind: "set-sketch-dimension", entityId: "entity:wall", dimension: "length", valueMm: 30, doubled: true });
      assert(!onLength.ok, "a length cannot be doubled");
      const asRelation = pipelineApply(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:bad", kind: "distance", entityIds: ["entity:wall"], valueMm: 30, dimension: "length", doubled: true } });
      assert(!asRelation.ok && /point-line or line-line/u.test(asRelation.diagnostics[0]?.message ?? ""), "and the relation check says which dimensions can be");
      const direct = pipelineApply(halfProfile(), { kind: "add-sketch-constraint", constraint: { id: "constraint:across", kind: "distance", entityIds: ["entity:axis", "entity:wall"], valueMm: 20, dimension: "line-line", doubled: true } });
      assert(direct.ok, `a well formed diameter relation is accepted: ${direct.ok ? "" : direct.diagnostics[0]?.message ?? ""}`);
      // A project saved before this field existed has plain distances and loads as it always did.
      const old = pipelineRun(halfProfile(), { kind: "set-sketch-dimension", entityId: "entity:axis", secondEntityId: "entity:wall", dimension: "line-line", valueMm: 10 });
      const text = serializeWorkbenchProject(old);
      assert(!text.includes("doubled"), "a plain distance writes no new field");
      const back = parseWorkbenchProjectText(text);
      assert(back.ok && stored(back.value, "line-line").valueMm === 10, "and reloads with its value");
    }
  },
];
