import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, modifiesBody, validateWorkbenchProject, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { boundsOverlap, defaultCreateOperation, meshBoundsMm, touchingBodies } from "../apps/studio-web/src/operation-default.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

/**
 * PT-14: a create feature whose result touches an existing body offers Join / Cut / Intersect / New Body with a sensible
 * default. The touch test and the default are pure functions, and "intersect" is a first-class operation on the step:
 * it validates, replays (keeping only the overlap) and round-trips in a saved project.
 */

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-opdef-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value.project;
}

const BODY = "general-body:opdef-block";
const rectangle = (id: string, center: readonly [number, number], width: number, height: number): SketchEntity => ({ id, kind: "rectangle", center, widthMm: width, heightMm: height, rotationDeg: 0, construction: false });
const volumeOf = (body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => solidMetrics(body.positionsMm, body.indices).volumeMm3;
const bodyOf = (project: WorkbenchProject) => project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;

export const operationDefaultTests: readonly TestCase[] = [
  {
    name: "The touch test and the Fusion default: bounds that meet propose Join, a clear gap proposes New Body, and the touched bodies are named",
    run: () => {
      const bounds = meshBoundsMm([0, 0, 0, 10, 5, 2, -3, 8, 1]);
      assert(bounds !== undefined && bounds.min.join(",") === "-3,0,0" && bounds.max.join(",") === "10,8,2", `mesh bounds: ${JSON.stringify(bounds)}`);
      assert(meshBoundsMm([]) === undefined, "an empty mesh has no bounds");
      const a = { min: [0, 0, 0] as const, max: [10, 10, 10] as const };
      assert(boundsOverlap(a, { min: [5, 5, 5], max: [15, 15, 15] }), "overlapping boxes touch");
      assert(boundsOverlap(a, { min: [10, 0, 0], max: [20, 10, 10] }), "boxes meeting exactly on a face count as touching (an extrude landing on a face offers Join)");
      assert(!boundsOverlap(a, { min: [11, 0, 0], max: [20, 10, 10] }), "a 1 mm gap is not a touch");
      const makeBody = (id: string, x: number, visible: boolean): GeneralSolidBody => ({
        id, name: id, visible, color: "#808080",
        positionsMm: [x, 0, 0, x + 10, 0, 0, x + 10, 10, 0, x, 0, 10], indices: [0, 1, 2, 0, 2, 3, 0, 3, 1, 1, 3, 2]
      });
      const tool = [5, 0, 0, 12, 5, 5];
      const touched = touchingBodies(tool, [makeBody("general-body:near", 0, true), makeBody("general-body:far", 100, true), makeBody("general-body:hidden", 0, false)]);
      assert(touched.length === 1 && touched[0]!.id === "general-body:near", `only the visible touched body is proposed: ${touched.map((body) => body.id).join(",")}`);
      assert(defaultCreateOperation(1, true) === "join", "touching a body defaults to Join");
      assert(defaultCreateOperation(0, true) === "new", "touching nothing defaults to New Body");
      assert(defaultCreateOperation(2, false) === "new", "with no target to modify the default stays New Body");
    }
  },
  {
    name: "Intersect is a first-class operation: an extrude that intersects the block keeps only the overlap, replays after a sketch edit, and round-trips",
    run: async () => {
      let project = createWorkbenchProject("project:test-opdef");
      project = { ...project, sketch: { ...project.sketch, entities: [rectangle("entity:outline", [0, 0], 60, 40)], constraints: [] } };
      project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      const sketch1 = designOf(project).features[0] as DesignSketchFeature;
      const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: sketch1.id, profileIds: [], valueMm: 20, bodyId: BODY };
      const built = await rebuildSolidFeature(extrude, sketch1);
      assert(built.ok, `the block builds: ${built.ok ? "" : built.message}`);
      if (!built.ok) return;
      project = run(project, { kind: "add-design-solid", feature: extrude, body: built.body });
      // A second sketch holds a 40 × 40 square centred at x = 20: it overlaps the block over x ∈ [0, 30].
      project = run(project, { kind: "new-design-sketch", plane: "datum:xy" });
      project = run(project, { kind: "add-sketch-entity", entity: rectangle("entity:overlap", [20, 0], 40, 40) });
      project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-2", name: "Sketch 2" });
      const sketch2 = designOf(project).features.filter((candidate): candidate is DesignSketchFeature => candidate.kind === "sketch").at(-1)!;
      assert(sketch2.id !== sketch1.id, "the second sketch is its own timeline feature");
      const intersect: DesignSolidFeature = {
        id: "feature:extrude-2", name: "Intersect 1", kind: "extrude", suppressed: false,
        sketchFeatureId: sketch2.id, profileIds: [], valueMm: 30, bodyId: BODY, operation: "intersect"
      };
      assert(validSolidFeaturePayload(intersect), "an intersect step passes the saved-project validator");
      assert(modifiesBody(intersect), "an intersect step modifies the body it targets, like a join or a cut");
      project = run(project, { kind: "add-design-solid", feature: intersect, body: bodyOf(project) });
      const results = await replayAllBodies(project);
      const failed = results.find((result) => result.message !== undefined && result.featureId === intersect.id);
      assert(failed === undefined, `the intersect replays: ${failed?.message ?? ""}`);
      project = run(project, { kind: "regenerate-design", results });
      const body = bodyOf(project);
      assert(isClosedAndOriented(body.indices), "the intersected body is closed");
      near(volumeOf(body), 30 * 40 * 20, 30 * 40 * 20 * 0.01, `only the overlap is kept: ${volumeOf(body).toFixed(0)} mm³ of 30 × 40 × 20`);
      // A sketch edit rebuilds through the intersect: widening the block does not change the overlap's x-range start, only its reach.
      let edited = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-1" });
      edited = run(edited, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "width", valueMm: 100 });
      edited = run(edited, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      edited = run(edited, { kind: "regenerate-design", results: await replayAllBodies(edited) });
      near(volumeOf(bodyOf(edited)), 40 * 40 * 20, 40 * 40 * 20 * 0.01, "after widening the block the whole 40 × 40 tool overlaps");
      const saved = validateWorkbenchProject(JSON.parse(JSON.stringify(edited)));
      assert(saved.ok, `the project with the intersect step round-trips: ${saved.ok ? "" : saved.diagnostics[0]?.message ?? ""}`);
    }
  }
];
