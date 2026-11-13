import { analyzeWorkbenchSketch, detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { buildSlot, buildSlotOverall } from "../packages/workbench-sketch/src/shapes.js";
import { typedShapeIntent } from "../packages/workbench-sketch/src/typed-shape-intent.js";
import { arcShape } from "../packages/workbench-core/src/sketch-measure.js";
import { dragLiveSketch, parseWorkbenchProjectText, serializeWorkbenchProject, type SketchEntity, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { fresh, pipelineRun } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * A slot has a construction centreline between its cap centres. It is what the slot is placed and turned by: its middle is the
 * slot's centre and it takes Horizontal, a length, or a Midpoint like any other line.
 */

function ids(): { readonly entity: () => string; readonly constraint: () => string } {
  let entities = 0;
  let constraints = 0;
  return { entity: () => `entity:slot-${entities += 1}`, constraint: () => `constraint:slot-${constraints += 1}` };
}

function slotProject(): { readonly project: WorkbenchProject; readonly centreline: string; readonly caps: readonly string[] } {
  const built = buildSlot([10, 5], [30, 5], [20, 8], ids());
  assert(built.ok, "the slot builds");
  const project = pipelineRun(pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" }), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: built.value.entities, addConstraints: built.value.constraints, label: "Slot" });
  const centreline = built.value.entities.find((entity) => entity.kind === "line" && entity.construction);
  assert(centreline !== undefined, "the slot has a construction centreline");
  return { project, centreline: centreline.id, caps: built.value.entities.filter((entity) => entity.kind === "arc").map((entity) => entity.id) };
}

const lineOf = (entities: readonly SketchEntity[], id: string): Extract<SketchEntity, { kind: "line" }> => {
  const entity = entities.find((candidate) => candidate.id === id);
  assert(entity?.kind === "line", `${id} is a line`);
  return entity;
};
const centreOf = (entities: readonly SketchEntity[], id: string): readonly [number, number] => {
  const entity = entities.find((candidate) => candidate.id === id);
  assert(entity?.kind === "arc", `${id} is an arc`);
  const shape = arcShape(entity.start, entity.mid, entity.end);
  assert(shape !== undefined, "the cap is a real arc");
  return shape.center;
};

export const sketchSlotCentrelineTests: readonly TestCase[] = [
  {
    name: "Slot: a construction centreline joins the two cap centres, adds no freedom and does not split the profile",
    run: () => {
      const built = buildSlot([10, 5], [30, 5], [20, 8], ids());
      assert(built.ok, "the slot builds");
      const last = built.value.entities.at(-1)!;
      assert(last.kind === "line" && last.construction && last.start[0] === 10 && last.end[0] === 30 && last.start[1] === 5, "the centreline runs from one cap centre to the other");
      equal(built.value.constraints.filter((constraint) => constraint.kind === "coincident" && constraint.points?.join("+").endsWith("center") === true).length, 2, "each end is held on a cap centre");
      const { project } = slotProject();
      const analysis = analyzeWorkbenchSketch(project.sketch);
      equal(analysis.degreesOfFreedom, 5, "the slot has its five freedoms (place, turn, length, width) and the centreline adds none");
      equal(analysis.conflicts.length, 0, "nothing conflicts");
      equal(analysis.redundant.length, 0, "nothing is redundant");
      equal(detectSketchProfiles(project.sketch).length, 1, "one closed profile: the centreline is construction");
      const overall = buildSlotOverall([0, 0], [10, 0], [5, 2], ids());
      assert(overall.ok && overall.value.entities.some((entity) => entity.kind === "line" && entity.construction), "the straight (overall) slot has the centreline too");
      // The typed length still lands on a side and the typed width on a cap, not on the centreline.
      const typed = typedShapeIntent({ tool: "slot", shape: built.value, typed: { length: 20, width: 6 }, newId: () => "constraint:typed" });
      assert(typed.every((relation) => relation.entityIds[0] !== last.id), "typed sizes are not put on the centreline");
    }
  },
  {
    name: "Slot centreline: it follows a dragged cap, drives the centre distance by its length, and centres the slot on the origin with Midpoint",
    run: () => {
      const { project, centreline, caps } = slotProject();
      const dragged = dragLiveSketch(project.sketch, { entityId: caps[0]!, point: "center", positionMm: [42, 12] });
      assert(dragged.ok, `dragging a cap centre solves: ${dragged.ok ? "" : dragged.message}`);
      if (dragged.ok) {
        const line = lineOf(dragged.entities, centreline);
        for (const cap of caps) {
          const centre = centreOf(dragged.entities, cap);
          const gap = Math.min(Math.hypot(line.start[0] - centre[0], line.start[1] - centre[1]), Math.hypot(line.end[0] - centre[0], line.end[1] - centre[1]));
          near(gap, 0, 1e-5, "the centreline's end is still on the cap centre");
        }
      }
      // Its length is the centre distance.
      let sized = pipelineRun(project, { kind: "set-sketch-dimension", entityId: centreline, dimension: "length", valueMm: 35 });
      const a = centreOf(sized.sketch.entities, caps[0]!);
      const b = centreOf(sized.sketch.entities, caps[1]!);
      near(Math.hypot(a[0] - b[0], a[1] - b[1]), 35, 1e-5, "35 on the centreline puts the cap centres 35 mm apart");
      equal(detectSketchProfiles(sized.sketch).length, 1, "the slot is still one closed profile");
      // Midpoint to the origin centres the slot, and Horizontal levels it.
      sized = pipelineRun(sized, { kind: "add-sketch-constraint", constraint: { id: "constraint:centred", kind: "midpoint", entityIds: ["sketch:origin", centreline], points: ["self"] } });
      sized = pipelineRun(sized, { kind: "add-sketch-constraint", constraint: { id: "constraint:level", kind: "horizontal", entityIds: [centreline] } });
      const line = lineOf(sized.sketch.entities, centreline);
      near((line.start[0] + line.end[0]) / 2, 0, 1e-5, "the slot's centre is on the origin in x");
      near((line.start[1] + line.end[1]) / 2, 0, 1e-5, "and in y");
      near(line.start[1], line.end[1], 1e-5, "and the slot is level");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(sized));
      assert(reloaded.ok && reloaded.value.sketch.entities.some((entity) => entity.id === centreline && entity.construction), "the centreline survives save and reload");
    }
  },
];
