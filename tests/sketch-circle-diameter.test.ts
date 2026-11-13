import { buildSketchEntity } from "../packages/workbench-sketch/src/index.js";
import { resolveDynamicEntry } from "../packages/workbench-sketch/src/dynamic-entry.js";
import { dynamicFieldsFor, measureFromCursor } from "../packages/workbench-sketch/src/dynamic-input.js";
import { typedIntentConstraints } from "../packages/workbench-sketch/src/typed-intent.js";
import { parseWorkbenchProjectText, serializeWorkbenchProject, type SketchEntity, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { circ, fresh, pipelineApply, pipelineRun } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** The centre circle tool (C) is sized by its diameter: 5.5 typed for a 5.5 mm hole is a 5.5 mm hole, not an 11 mm one. */

function radiusOf(entity: SketchEntity | undefined): number {
  return entity?.kind === "circle" ? entity.radiusMm : Number.NaN;
}

export const sketchCircleDiameterTests: readonly TestCase[] = [
  {
    name: "Centre circle: the field after the centre click is Diameter and it reads twice the distance to the cursor",
    run: () => {
      const fields = dynamicFieldsFor("circle", 1);
      equal(fields.map((field) => `${field.id}:${field.label}`).join(","), "diameter:Diameter", "one field, the diameter");
      near(measureFromCursor("circle", [[10, 10]], [13, 14]).diameter ?? 0, 10, 1e-9, "5 mm from the centre shows a 10 mm diameter");
      // The 2-point circle is unchanged: its two clicks are the ends of the diameter.
      near(measureFromCursor("circle-two-point", [[0, 0]], [30, 0]).diameter ?? 0, 30, 1e-9, "2-point circle: the distance between the clicks is the diameter");
    }
  },
  {
    name: "Centre circle: typing 5.5 gives a 5.5 mm hole with a 5.5 mm diameter dimension, kept through an edit, save and reload",
    run: () => {
      const entry = resolveDynamicEntry({ tool: "circle", placed: [[20, 15]], cursor: [40, 15], fields: dynamicFieldsFor("circle", 1), texts: { diameter: "5.5" } });
      assert(entry.ok, `the typed diameter is accepted: ${entry.ok ? "" : entry.message}`);
      if (!entry.ok) return;
      const built = buildSketchEntity("circle", [[20, 15], entry.point], "entity:hole");
      assert(built.ok && built.value.kind === "circle", "a circle is built");
      if (!built.ok) return;
      near(radiusOf(built.value), 2.75, 1e-9, "radius 2.75 mm: the hole is 5.5 mm across (it used to be 11 mm)");
      let serial = 0;
      const relations = typedIntentConstraints({ tool: "circle", entity: built.value, typed: entry.typed, newId: () => `constraint:typed-${serial += 1}` });
      equal(relations.length, 1, "one driving dimension");
      const dimension = relations[0] as WorkbenchSketchConstraint;
      equal(`${dimension.kind}:${dimension.dimension}:${dimension.valueMm}`, "radius:diameter:5.5", "stored as a diameter of 5.5 mm");
      let project = pipelineRun(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [built.value], addConstraints: relations, label: "Circle" });
      near(radiusOf(project.sketch.entities.find((entity) => entity.id === "entity:hole")), 2.75, 1e-9, "the model keeps the 5.5 mm hole with its dimension");
      // The dimension drives the circle: changing it to 8 gives a radius of 4.
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:hole", dimension: "diameter", valueMm: 8 });
      near(radiusOf(project.sketch.entities.find((entity) => entity.id === "entity:hole")), 4, 1e-9, "editing the diameter to 8 gives radius 4");
      equal(project.sketch.constraints.filter((constraint) => constraint.kind === "radius").length, 1, "still one size dimension on the circle");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(project));
      assert(reloaded.ok, "the project reloads");
      if (!reloaded.ok) return;
      near(radiusOf(reloaded.value.sketch.entities.find((entity) => entity.id === "entity:hole")), 4, 1e-9, "the reloaded circle has radius 4");
      const kept = reloaded.value.sketch.constraints.find((constraint) => constraint.kind === "radius");
      equal(`${kept?.dimension}:${kept?.valueMm}`, "diameter:8", "and its diameter dimension of 8");
    }
  },
  {
    name: "Centre circle: a sketch saved with the old radius dimension still loads with the same circle",
    run: () => {
      const old: WorkbenchSketchConstraint = { id: "constraint:old", kind: "radius", entityIds: ["entity:c"], valueMm: 6, dimension: "radius" };
      const project = pipelineRun(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [circ("c", 0, 0, 6)], addConstraints: [old], label: "Old circle" });
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(project));
      assert(reloaded.ok, "reloads");
      if (!reloaded.ok) return;
      near(radiusOf(reloaded.value.sketch.entities.find((entity) => entity.id === "entity:c")), 6, 1e-9, "radius 6 as saved");
      equal(reloaded.value.sketch.constraints.find((constraint) => constraint.id === "constraint:old")?.dimension, "radius", "the radius dimension keeps its meaning");
    }
  },
  {
    name: "Centre circle: a negative or too small diameter is refused on the Diameter field, and a diameter dimension that fits the circle is accepted",
    run: () => {
      const negative = resolveDynamicEntry({ tool: "circle", placed: [[0, 0]], cursor: [10, 0], fields: dynamicFieldsFor("circle", 1), texts: { diameter: "-4" } });
      assert(!negative.ok && /negative/i.test(negative.message), "a negative diameter is refused with a reason");
      const tiny = resolveDynamicEntry({ tool: "circle", placed: [[0, 0]], cursor: [10, 0], fields: dynamicFieldsFor("circle", 1), texts: { diameter: "0.01" } });
      assert(!tiny.ok && /0\.02/.test(tiny.message), `a diameter under the 0.01 mm radius floor names the 0.02 mm limit: ${tiny.ok ? "" : tiny.message}`);
      const applied = pipelineApply(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [circ("c", 0, 0, 5)], addConstraints: [{ id: "constraint:d", kind: "radius", entityIds: ["entity:c"], valueMm: 10, dimension: "diameter" }], label: "Circle" });
      assert(applied.ok, "a 10 mm diameter on a radius-5 circle is consistent and accepted");
    }
  },
];
