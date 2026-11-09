import { type SketchEntity, type Vec2 } from "../packages/workbench-core/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";
import { PROFILE_CHAINS, addShape, emptyProject3, profileProject, stressProblem, wholeProblem } from "./sketch-shapes3-kit.js";
import { dimension } from "./sketch-shape-kit.js";

/**
 * Wave 3, package "shapes3". Curve creation F1 (Profile tool tears apart on edit), and the guard that an edit never reports success on an open outline.
 * Each test draws the way the canvas does and goes through the real operations.
 */

const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, kind: "line", start, end, construction: false });

export const sketchShapes3Tests: readonly TestCase[] = [
  ...PROFILE_CHAINS.map((chain): TestCase => ({
    name: `Curve creation F1: the Profile tool (${chain.name}) joins every junction and stays one closed profile through every edit and drag`,
    run: () => {
      const { project, closed } = profileProject(chain.clicks);
      assert(closed, "the last click closes the loop");
      const coincident = project.sketch.constraints.filter((constraint) => constraint.kind === "coincident").length;
      equal(coincident, project.sketch.entities.length, "one Coincident joint per junction, closing joint included");
      equal(stressProblem(project, 1, chain.name.startsWith("wavy") ? null : 1), undefined, "the profile through every edit and drag");
    }
  })),
  {
    name: "Curve creation F1: a tangent arc started on a tangent arc is held Tangent, and the reported repro (line, tangent arc, line, line) holds through a vertex drag",
    run: () => {
      const { project } = profileProject([{ point: [40, 0], mode: "line" }, { point: [40, 30], mode: "tangent-arc" }, { point: [0, 30], mode: "line" }, { point: [0, 0], mode: "line" }]);
      const tangents = project.sketch.constraints.filter((constraint) => constraint.kind === "tangent").length;
      assert(tangents >= 1, "the arc is held tangent to the line before it");
      const chain = profileProject([{ point: [20, 0], mode: "line" }, { point: [40, 15], mode: "tangent-arc" }, { point: [60, 0], mode: "tangent-arc" }, { point: [80, -10], mode: "line" }, { point: [60, -30], mode: "tangent-arc" }, { point: [0, 0], mode: "line" }]).project;
      const kinds = chain.sketch.constraints.filter((constraint) => constraint.kind === "tangent").length;
      assert(kinds >= 3, `three tangent arcs are held tangent (found ${kinds})`);
    }
  },
  {
    name: "Curve creation F1 guard: a dimension edit never reports success while a touching outline is torn open",
    run: () => {
      // An outline from an older build: four lines that touch end to end but carry no Coincident relation.
      const entities = [line("entity:g1", [0, 0], [40, 0]), line("entity:g2", [40, 0], [40, 30]), line("entity:g3", [40, 30], [0, 30]), line("entity:g4", [0, 30], [0, 0])];
      const project = addShape(emptyProject3(), { entities, constraints: [] });
      equal(wholeProblem(project), undefined, "the loose outline is one profile");
      const edited = dimension(project, { entityId: "entity:g1", dimension: "length", valueMm: 24 });
      if (edited.ok) equal(wholeProblem(edited.project), undefined, "an accepted edit leaves the outline closed");
      else assert(/outline|touch/iu.test(edited.message), `a refusal says why: ${edited.message}`);
      assert(edited.ok, "the edit is carried out, the touching ends being held together for it");
    }
  }
];
