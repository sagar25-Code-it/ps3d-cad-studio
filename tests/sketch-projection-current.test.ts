import { designOf, isHealthNote, linkedSketchEntityIds, parseWorkbenchProjectText, PROJECTION_NOTE_PREFIX, serializeWorkbenchProject, type DesignSketchFeature, type DesignSolidFeature, type GeneralSolidBody, type SketchEntity, type WorkbenchProject, type WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { rebuildDependents, rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { planSketchProject } from "../apps/studio-web/src/sketch-project-command.js";
import { planSketchProjectForSession, projectionSourceBody, refreshLooseSketchProjections, refreshSketchProjections } from "../apps/studio-web/src/sketch-projection-refresh.js";
import { commitWorkingSketchAtomically, workingSketchState } from "../apps/studio-web/src/sketch-session.js";
import { withStep } from "./extent-kit.js";
import { circ, committedSketch, fresh, meshStats, pipelineApply, pipelineRun, rect, solidFeature, type Op } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * Curves projected from a solid are where the solid is, wherever the sketch is looked at: in the working copy after a rebuild, in a
 * sketch that has no step yet, in a sketch that is opened, and in a sketch that already cut the solid it projects.
 */

type Line = Extract<SketchEntity, { kind: "line" }>;
const PLATE = "general-body:extrude-1";

const sketchOf = (project: WorkbenchProject, id: string): DesignSketchFeature => {
  const found = designOf(project).features.find((feature): feature is DesignSketchFeature => feature.id === id && feature.kind === "sketch");
  assert(found !== undefined, `${id} is in the timeline`);
  return found;
};
const bodyOf = (project: WorkbenchProject, id: string): GeneralSolidBody => {
  const found = project.part.generalBodies?.find((body) => body.id === id);
  assert(found !== undefined, `${id} is in the part`);
  return found;
};
/** The x of the linked upright line furthest to the right: the projected right edge of the plate. */
function rightEdgeX(sketch: WorkbenchSketch): number {
  const linked = linkedSketchEntityIds(sketch);
  const uprights = sketch.entities.filter((entity): entity is Line => entity.kind === "line" && linked.has(entity.id) && Math.abs(entity.start[0] - entity.end[0]) < 1e-6);
  assert(uprights.length > 0, "the sketch holds projected upright edges");
  return Math.max(...uprights.map((entity) => entity.start[0]));
}
const linkedCount = (sketch: WorkbenchSketch): number => linkedSketchEntityIds(sketch).size;

/** A 40 x 20 x 10 plate (Sketch 1, feature:s1; Extrude 1). With `parameter`, its width is the parameter w. */
async function plate(parameter = false): Promise<WorkbenchProject> {
  let start = fresh();
  if (parameter) start = pipelineRun(start, { kind: "set-design-parameters", parameters: [{ name: "w", expression: "40", unit: "mm", comment: "" }] });
  let project = pipelineRun(start, { kind: "new-design-sketch", plane: "datum:xy" });
  project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [rect("plate", 0, 0, 40, 20)], addConstraints: [], label: "Plate" });
  if (parameter) project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:plate", dimension: "width", valueMm: 40, expression: "w" });
  project = pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:s1", name: "Sketch 1" });
  const first = sketchOf(project, "feature:s1");
  const step = solidFeature("extrude", first, { id: "feature:extrude-1", name: "Extrude 1", bodyId: PLATE, valueMm: 10 });
  const body = await rebuildSolidFeature(step, first);
  assert(body.ok, "the plate builds");
  return pipelineRun(project, { kind: "add-design-solid", feature: step, body: body.body });
}

let projected = 0;
/** Project (whole body, linked, as reference curves) into the working sketch, as the P key does. */
async function projectPlate(project: WorkbenchProject): Promise<WorkbenchProject> {
  const planned = await planSketchProjectForSession(project, bodyOf(project, PLATE), "project-body", { construction: true, newId: () => `entity:pc-${projected += 1}` });
  assert(planned.ok, `Project plans: ${planned.ok ? "" : planned.message}`);
  return pipelineRun(project, planned.operation as Op);
}

/** The plate, then Sketch 2 (feature:s2) holding its projected outline and, with `hole`, a circle; Sketch 2 is finished and stays in the working slot. */
async function plateWithProjectingSketch(options: { readonly parameter?: boolean; readonly hole?: boolean } = {}): Promise<WorkbenchProject> {
  let project = pipelineRun(await plate(options.parameter === true), { kind: "new-design-sketch", plane: "datum:xy" });
  project = await projectPlate(project);
  near(rightEdgeX(project.sketch), 20, 1e-6, "the projected right edge of the 40 mm plate is at x = 20");
  if (options.hole === true) project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [circ("hole", 0, 0, 3)], addConstraints: [], label: "Hole" });
  return pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:s2", name: "Sketch 2" });
}

/** Edit Sketch 1, set the plate's width, and finish with only the bodies rebuilt (no refresh by sketch), as a rebuild path that does not know about loose sketches would. */
async function widenWithBareRebuild(project: WorkbenchProject, widthMm: number): Promise<WorkbenchProject> {
  let next = pipelineRun(project, { kind: "edit-design-sketch", featureId: "feature:s1" });
  next = pipelineRun(next, { kind: "set-sketch-dimension", entityId: "entity:plate", dimension: "width", valueMm: widthMm });
  next = pipelineRun(next, { kind: "commit-design-sketch", featureId: "feature:s1", name: "Sketch 1" });
  return pipelineRun(next, { kind: "regenerate-design", results: await rebuildDependents(next, "feature:s1") });
}

export const sketchProjectionCurrentTests: readonly TestCase[] = [
  {
    name: "After a rebuild the working copy of a sketch has its projected curves where the body is now, and is not reported as unfinished work",
    run: async () => {
      // Plate of width w; Sketch 2 projects it and holds a hole; the hole is extruded. Sketch 2 stays in the working slot, as after every Finish.
      let project = await plateWithProjectingSketch({ parameter: true, hole: true });
      const second = sketchOf(project, "feature:s2");
      const pin = solidFeature("extrude", second, { id: "feature:extrude-2", name: "Extrude 2", bodyId: "general-body:extrude-2", valueMm: 4 });
      const pinBody = await rebuildSolidFeature(pin, second);
      assert(pinBody.ok, "the pin builds from the hole");
      project = pipelineRun(project, { kind: "add-design-solid", feature: pin, body: pinBody.body });
      equal(designOf(project).editingSketchId, "feature:s2", "Sketch 2 is still the working sketch");
      equal(workingSketchState(project).kind, "clean", "and it is clean");

      // Change Parameters: w 40 to 60. Every body is replayed.
      project = pipelineRun(project, { kind: "set-design-parameters", parameters: [{ name: "w", expression: "60", unit: "mm", comment: "" }] });
      project = pipelineRun(project, { kind: "regenerate-design", results: await replayAllBodies(project) });
      const stats = meshStats(bodyOf(project, PLATE));
      near(stats.hi[0] - stats.lo[0], 60, 1e-3, "the plate is 60 wide");
      near(rightEdgeX(sketchOf(project, "feature:s2").sketch), 30, 1e-6, "the timeline Sketch 2 has its projected right edge at x = 30");
      near(rightEdgeX(project.sketch), 30, 1e-6, "and so has the working copy the sketcher opens");
      equal(workingSketchState(project).kind, "clean", "which is still clean: nothing reads as unfinished work");
      // The next Finish therefore records nothing (no extra Undo step, no extra rebuild).
      const finish = await commitWorkingSketchAtomically(project, { featureId: "feature:unused", name: "Sketch" });
      assert(finish.ok && !finish.value.changed && finish.value.rebuilt.length === 0, "a Finish now has nothing to record");
    }
  },
  {
    name: "Project inside a sketch that already cut the solid reads the solid before that cut, so Finish leaves no warning on the cut",
    run: async () => {
      // Plate; Sketch 2 with a circle; Cut 1 through the plate.
      let project = pipelineRun(await plate(), { kind: "new-design-sketch", plane: "datum:xy" });
      project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [circ("hole", 0, 0, 4)], addConstraints: [], label: "Hole" });
      project = pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:s2", name: "Sketch 2" });
      const cut: DesignSolidFeature = { ...solidFeature("extrude", sketchOf(project, "feature:s2"), { id: "feature:cut-1", name: "Cut 1", bodyId: PLATE, valueMm: 30 }), direction: "symmetric", operation: "cut" };
      project = await withStep(project, cut);
      const drilled = meshStats(bodyOf(project, PLATE)).volume;
      near(drilled, 40 * 20 * 10 - Math.PI * 16 * 10, 5, "the plate has its hole");

      // Double-click Sketch 2, press P.
      project = pipelineRun(project, { kind: "edit-design-sketch", featureId: "feature:s2" });
      let serial = 0;
      const options = { construction: true, newId: (): string => `entity:own-${serial += 1}` };
      const naive = planSketchProject(project, bodyOf(project, PLATE), "project-body", options);
      assert(naive.ok && naive.operation.addEntities.length === 5, "read from the finished solid, the projection includes the edge of this sketch's own hole (4 lines and a circle)");
      const source = await projectionSourceBody(project, "feature:s2", PLATE);
      assert(source.ok && source.before?.id === "feature:cut-1", "the sketch sees the plate as it is before Cut 1");
      if (source.ok) near(meshStats(source.body).volume, 40 * 20 * 10, 1e-3, "which is the plate without the hole");
      const planned = await planSketchProjectForSession(project, bodyOf(project, PLATE), "project-body", options);
      assert(planned.ok, `Project plans: ${planned.ok ? "" : planned.message}`);
      if (!planned.ok) return;
      equal(planned.operation.addEntities.length, 4, "Project brings in the four edges of the plate, not the hole");
      assert(/read as it is before Cut 1/u.test(planned.summary), `and the status says which shape was read: ${planned.summary}`);
      project = pipelineRun(project, planned.operation as Op);

      const finished = await commitWorkingSketchAtomically(project, { featureId: "feature:unused", name: "Sketch" });
      assert(finished.ok, "Finish is accepted");
      if (!finished.ok) return;
      const after = finished.value.project;
      const cutAfter = designOf(after).features.find((feature) => feature.id === "feature:cut-1");
      equal(cutAfter?.health, undefined, `Cut 1 carries no warning: ${cutAfter?.health?.message ?? ""}`);
      equal(finished.value.failed.length, 0, "nothing failed to rebuild");
      equal(linkedCount(sketchOf(after, "feature:s2").sketch), 4, "the four curves are still linked");
      near(meshStats(bodyOf(after, PLATE)).volume, drilled, 1e-3, "and the plate still has its hole");

      // The curves follow: widen the plate and the linked edge moves with it, still with no warning.
      const wider = pipelineRun(await widenWithBareRebuild(after, 60), { kind: "edit-design-sketch", featureId: "feature:s2" });
      near(rightEdgeX(sketchOf(wider, "feature:s2").sketch), 30, 1e-6, "after the plate is widened the linked edge is at x = 30");
      equal(designOf(wider).features.find((feature) => feature.id === "feature:cut-1")?.health, undefined, "and Cut 1 still has no warning");
    }
  },
  {
    name: "Project refuses a solid that is made from the sketch being edited, with the reason",
    run: async () => {
      const project = pipelineRun(await plate(), { kind: "edit-design-sketch", featureId: "feature:s1" });
      const planned = await planSketchProjectForSession(project, bodyOf(project, PLATE), "project-body", { construction: true, newId: () => "entity:never" });
      assert(!planned.ok && /is made from this sketch \(Extrude 1\)/u.test(planned.message), `refused with the reason: ${planned.ok ? "" : planned.message}`);
      // A picked edge is a snapshot of what was clicked and is not held to this rule.
      const snapshot = await planSketchProjectForSession(project, bodyOf(project, PLATE), "project-edge", { construction: true, newId: () => "entity:never" });
      assert(!snapshot.ok && /Pick an edge/u.test(snapshot.message), "Project edge still asks for its pick");
    }
  },
  {
    name: "A sketch with projected curves and no step yet follows its solid when the solid is rebuilt by a Finish",
    run: async () => {
      // Sketch 2 projects the plate and is finished without being extruded.
      let project = await plateWithProjectingSketch();
      equal((await refreshLooseSketchProjections(project)).length, 0, "nothing to refresh while the plate has not changed");
      // Edit Sketch 1 to widen the plate, Finish.
      project = pipelineRun(project, { kind: "edit-design-sketch", featureId: "feature:s1" });
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:plate", dimension: "width", valueMm: 60 });
      const finished = await commitWorkingSketchAtomically(project, { featureId: "feature:unused", name: "Sketch" });
      assert(finished.ok, "Finish is accepted");
      if (!finished.ok) return;
      const after = finished.value.project;
      near(rightEdgeX(sketchOf(after, "feature:s2").sketch), 30, 1e-6, "Sketch 2's projected right edge moved to the new edge of the plate");
      equal(sketchOf(after, "feature:s2").health, undefined, "with no note on the sketch");
      equal(linkedCount(sketchOf(after, "feature:s2").sketch), 4, "and the curves are still linked");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(after));
      assert(reloaded.ok && Math.abs(rightEdgeX(sketchOf(reloaded.value, "feature:s2").sketch) - 30) < 1e-6, "the refreshed sketch is what is saved");
    }
  },
  {
    name: "Opening a sketch brings its projected curves up to date, in the timeline and in the working copy, as part of the same step",
    run: async () => {
      // A rebuild that did not refresh the loose sketch leaves Sketch 2 at the old outline.
      const stale = await widenWithBareRebuild(await plateWithProjectingSketch(), 60);
      near(rightEdgeX(sketchOf(stale, "feature:s2").sketch), 20, 1e-6, "Sketch 2 is stale: its edge is still at x = 20");
      const refresh = await refreshSketchProjections(stale, "feature:s2");
      assert(refresh !== undefined && refresh.entities.length > 0 && refresh.message === undefined, "the refresh has moved curves and no message");

      // Double-click Sketch 2 (the browser and the timeline both go through this).
      const opened = await commitWorkingSketchAtomically(stale, { featureId: "feature:unused", name: "Sketch", then: [{ kind: "edit-design-sketch", featureId: "feature:s2" }] });
      assert(opened.ok, "the sketch opens");
      if (!opened.ok) return;
      const project = opened.value.project;
      equal(designOf(project).editingSketchId, "feature:s2", "Sketch 2 is being edited");
      near(rightEdgeX(project.sketch), 30, 1e-6, "the opened sketch shows the projected edge at the plate's new edge");
      near(rightEdgeX(sketchOf(project, "feature:s2").sketch), 30, 1e-6, "and the timeline holds the same");
      equal(workingSketchState(project).kind, "clean", "opening it is not an edit");
      equal(await refreshSketchProjections(project, "feature:s2"), undefined, "and there is nothing more to refresh");
    }
  },
  {
    name: "A sketch whose projected solid is gone is marked with a note saying so, the note clears when the curves can follow again, and the operation refuses a bad entry",
    run: async () => {
      let project = await plateWithProjectingSketch();
      project = pipelineRun(project, { kind: "delete-design-feature", featureId: "feature:extrude-1" });
      const before = JSON.stringify(sketchOf(project, "feature:s2").sketch.entities);
      const opened = await commitWorkingSketchAtomically(project, { featureId: "feature:unused", name: "Sketch", then: [{ kind: "edit-design-sketch", featureId: "feature:s2" }] });
      assert(opened.ok, "the sketch opens");
      if (!opened.ok) return;
      const marked = sketchOf(opened.value.project, "feature:s2");
      assert(marked.health !== undefined && marked.health.message.startsWith(PROJECTION_NOTE_PREFIX) && /no longer in the design/u.test(marked.health.message), `the sketch says its curves are out of date: ${marked.health?.message ?? ""}`);
      assert(isHealthNote(marked.health?.message), "as a note, not as a failed step");
      equal(JSON.stringify(marked.sketch.entities), before, "the curves stay where they were");
      equal(await refreshSketchProjections(opened.value.project, "feature:s2"), undefined, "the same note is not written again");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(opened.value.project));
      assert(reloaded.ok, "a project with the note saves and reloads");

      // A clean refresh for that sketch clears the note; a note of another kind is left alone.
      const cleared = pipelineRun(opened.value.project, { kind: "regenerate-design", results: [], sketchCurves: [{ sketchFeatureId: "feature:s2", entities: [] }] });
      equal(sketchOf(cleared, "feature:s2").health, undefined, "the note is cleared");
      const unknown = pipelineApply(opened.value.project, { kind: "regenerate-design", results: [], sketchCurves: [{ sketchFeatureId: "feature:nope", entities: [] }] });
      assert(!unknown.ok, "an entry for a sketch that is not in the timeline is refused");
      const twice = pipelineApply(opened.value.project, { kind: "regenerate-design", results: [], sketchCurves: [{ sketchFeatureId: "feature:s2", entities: [] }, { sketchFeatureId: "feature:s2", entities: [] }] });
      assert(!twice.ok, "and so is the same sketch twice");
      const plain = pipelineRun(opened.value.project, { kind: "regenerate-design", results: [] });
      equal(sketchOf(plain, "feature:s2").health?.message, marked.health?.message, "a rebuild without entries (every operation saved before this) changes no sketch");
    }
  },
];
