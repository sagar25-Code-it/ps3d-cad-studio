import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { breakProjectionLinks, designOf, dragLiveSketch, linkedSketchEntityIds, parseWorkbenchProjectText, serializeWorkbenchProject, validateWorkbenchProject, type DesignSketchFeature, type GeneralSolidBody, type SketchEntity, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { analyzeLiveSketch } from "../packages/workbench-core/src/sketch-analysis.js";
import { rebuildDependents, rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import { LINKED_PROJECT_MODES, planSketchProject } from "../apps/studio-web/src/sketch-project-command.js";
import { followSketchProjections } from "../apps/studio-web/src/sketch-projection-follow.js";
import { SketchWorkspace } from "../apps/studio-web/src/workspaces/SketchWorkspace.js";
import { circ, committedSketch, meshStats, pipelineApply, pipelineRun, rect, solidFeature, type Op } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * Project, Intersect and Silhouette of a whole solid stay linked to it: the curves are recorded as a projection of the sketch, are
 * held where the solid puts them, follow the solid when it is rebuilt (and carry what is dimensioned from them), and can be unlinked.
 */

type Line = Extract<SketchEntity, { kind: "line" }>;

const sketchFeature = (project: WorkbenchProject, id: string): DesignSketchFeature => {
  const found = designOf(project).features.find((feature): feature is DesignSketchFeature => feature.id === id && feature.kind === "sketch");
  assert(found !== undefined, `${id} is in the timeline`);
  return found;
};

const bodyOf = (project: WorkbenchProject, id: string): GeneralSolidBody => {
  const found = project.part.generalBodies?.find((body) => body.id === id);
  assert(found !== undefined, `${id} is in the part`);
  return found;
};

/** The linked line whose both ends are at the largest x: the right edge of the projected plate. */
function rightEdge(entities: readonly SketchEntity[], linked: ReadonlySet<string>): Line {
  const lines = entities.filter((entity): entity is Line => entity.kind === "line" && linked.has(entity.id) && Math.abs(entity.start[0] - entity.end[0]) < 1e-6);
  assert(lines.length > 0, "the projection has upright edges");
  return lines.reduce((best, line) => (line.start[0] > best.start[0] ? line : best));
}

interface Built {
  /** A 40 x 20 x 10 plate (Sketch 1, Extrude 1); the working sketch holds its projected outline and a hole 5 mm in from the right edge. */
  readonly drawn: WorkbenchProject;
  readonly holeId: string;
  readonly edgeId: string;
  readonly projectedIds: readonly string[];
}

async function projectedPlate(): Promise<Built> {
  const first = committedSketch("datum:xy", [rect("plate", 0, 0, 40, 20)], { featureId: "feature:s1" });
  const plate = solidFeature("extrude", first.sketch, { id: "feature:extrude-1", name: "Extrude 1", bodyId: "general-body:extrude-1", valueMm: 10 });
  const plateBody = await rebuildSolidFeature(plate, first.sketch);
  assert(plateBody.ok, "the plate builds");
  let project = pipelineRun(first.project, { kind: "add-design-solid", feature: plate, body: plateBody.body });
  project = pipelineRun(project, { kind: "new-design-sketch", plane: "datum:xy" });
  let serial = 0;
  const planned = planSketchProject(project, bodyOf(project, "general-body:extrude-1"), "project-body", { construction: true, newId: () => `entity:proj-${serial += 1}` });
  assert(planned.ok, `Project plans: ${planned.ok ? "" : planned.message}`);
  assert(/stay linked to the body/u.test(planned.summary) && !/snapshot/u.test(planned.summary), "the status says the curves are linked, not a snapshot");
  project = pipelineRun(project, planned.operation as Op);
  const linked = linkedSketchEntityIds(project.sketch);
  const edge = rightEdge(project.sketch.entities, linked);
  near(edge.start[0], 20, 1e-6, "the right edge of the 40 mm plate is at x = 20");
  project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [circ("hole", 10, 0, 3)], addConstraints: [], label: "Circle" });
  project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:hole", secondEntityId: edge.id, dimension: "point-line", points: ["center"], valueMm: 5 });
  return { drawn: project, holeId: "entity:hole", edgeId: edge.id, projectedIds: [...linked] };
}

const holeCentre = (entities: readonly SketchEntity[]): readonly [number, number] => {
  const hole = entities.find((entity) => entity.id === "entity:hole");
  assert(hole?.kind === "circle", "the hole is in the sketch");
  return hole.center;
};

const noop = (): void => undefined;
function workspaceMarkup(sketch: WorkbenchProject["sketch"]): string {
  const base = {
    projectId: "project:linked", sketch, finishedSketches: [], workingTimelineId: null, constraintExtras: { revision: 0, pierceHits: () => [], pierceRefresh: () => undefined, pierceUnresolved: () => [] }, tool: "select", dimensionMode: false, cancelVersion: 0, selectedId: null,
    targetBodies: [], solidBodies: [], displayUnit: "mm", editTool: null, showMovable: false, checkOpen: false, request: null, fitSerial: 0, optionsRevealRequest: 0,
    viewportState: { navigationMode: "select", selectionFilter: "any", gridVisible: true, axesVisible: true, orientation: "top", projection: "orthographic", shadingMode: "shaded", bodyColor: "steel", backgroundTone: "light", azimuthDeg: 0, elevationDeg: 0 }
  };
  const props = new Proxy(base as Record<string, unknown>, { get: (target, key) => (key in target ? target[key as string] : typeof key === "string" && key.startsWith("on") ? noop : undefined), has: () => true });
  return renderToStaticMarkup(createElement(SketchWorkspace, props as never));
}

export const sketchProjectLinkedTests: readonly TestCase[] = [
  {
    name: "Project of a solid records a link: the curves are held in place, drawn as projected, saved and reloaded, and a picked edge stays a snapshot",
    run: async () => {
      const { drawn, edgeId, projectedIds } = await projectedPlate();
      const projections = drawn.sketch.projections ?? [];
      equal(projections.length, 1, "one projection is recorded with the sketch");
      equal(projections[0]!.mode, "project", "it remembers how the curves were made");
      equal(projections[0]!.bodyId, "general-body:extrude-1", "and which solid they came from");
      assert(projectedIds.length >= 4 && projections[0]!.entityIds.every((id) => id !== null && drawn.sketch.entities.some((entity) => entity.id === id)), "every projected curve is in the sketch and linked");
      near(holeCentre(drawn.sketch.entities)[0], 15, 1e-6, "the hole sits 5 mm in from the projected right edge");

      // Held: nothing left to move on a linked curve, and a drag of its end leaves it where the solid put it.
      const analysis = analyzeLiveSketch(drawn.sketch);
      for (const id of projectedIds) equal(analysis.entityFreedom[id], 0, "a linked curve has no freedom");
      const before = JSON.stringify(drawn.sketch.entities.find((entity) => entity.id === edgeId));
      const dragged = dragLiveSketch(drawn.sketch, { entityId: edgeId, point: "start", positionMm: [35, 3] });
      const after = dragged.ok ? JSON.stringify(dragged.entities.find((entity) => entity.id === edgeId)) : before;
      const edgeBefore = JSON.parse(before) as Line;
      const edgeAfter = JSON.parse(after) as Line;
      near(edgeAfter.start[0], edgeBefore.start[0], 1e-6, "dragging a linked curve does not move it");
      near(edgeAfter.end[0], edgeBefore.end[0], 1e-6, "at either end");

      // Drawn in the projected colour, with the key in the palette.
      const html = workspaceMarkup(drawn.sketch);
      const at = html.indexOf(`data-selection-id="${edgeId}"`);
      assert(at >= 0 && /class="sketch-entity [^"]*\blinked\b/u.test(html.slice(at, at + 900)), "the canvas draws the curve with the linked class");
      assert(html.includes(">Projected from a solid<"), "the colour key names the state");

      // Save and reload.
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(drawn));
      assert(reloaded.ok, "the project reloads");
      equal(JSON.stringify(reloaded.value.sketch.projections), JSON.stringify(drawn.sketch.projections), "with its projection");

      // A single picked edge or face cannot be found again after a rebuild on this kernel, so those commands do not record a link.
      equal(LINKED_PROJECT_MODES["project-edge"], undefined, "Project edge stays a snapshot");
      equal(LINKED_PROJECT_MODES["convert-face"], undefined, "and so does Convert face");
      const withoutLink = { ...drawn, sketch: (({ projections: _gone, ...rest }) => rest)(drawn.sketch) };
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(withoutLink)) as unknown).ok, "a sketch with no projection record (every sketch saved before this) is valid");
    }
  },
  {
    name: "Linked projection follows its solid: widening the plate moves the projected edge, the hole dimensioned from it, and the feature built on the hole",
    run: async () => {
      const { drawn, edgeId } = await projectedPlate();
      let project = pipelineRun(drawn, { kind: "commit-design-sketch", featureId: "feature:s2", name: "Sketch 2" });
      const second = sketchFeature(project, "feature:s2");
      const pin = solidFeature("extrude", second, { id: "feature:extrude-2", name: "Extrude 2", bodyId: "general-body:extrude-2", valueMm: 4 });
      const pinBody = await rebuildSolidFeature(pin, second);
      assert(pinBody.ok, "the pin builds from the hole");
      project = pipelineRun(project, { kind: "add-design-solid", feature: pin, body: pinBody.body });
      const pinBefore = meshStats(bodyOf(project, "general-body:extrude-2"));
      near((pinBefore.lo[0] + pinBefore.hi[0]) / 2, 15, 1e-3, "the pin stands at x = 15");

      // Edit Sketch 1: the plate goes from 40 mm to 60 mm wide.
      project = pipelineRun(project, { kind: "edit-design-sketch", featureId: "feature:s1" });
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:plate", dimension: "width", valueMm: 60 });
      project = pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:s1", name: "Sketch 1" });
      const results = await rebuildDependents(project, "feature:s1");
      const pinResult = results.find((result) => result.featureId === "feature:extrude-2");
      assert(pinResult !== undefined, "the feature built on the projecting sketch is rebuilt with the plate");
      assert(pinResult.message === undefined, `it rebuilt cleanly: ${pinResult.message ?? ""}`);
      assert((pinResult.sketchEntities?.length ?? 0) > 0, "and carries the moved projected curves for the sketch");
      project = pipelineRun(project, { kind: "regenerate-design", results });

      const followed = sketchFeature(project, "feature:s2").sketch;
      const edge = followed.entities.find((entity) => entity.id === edgeId);
      assert(edge?.kind === "line", "the projected edge kept its id");
      near(edge.start[0], 30, 1e-6, "the projected right edge moved to the new edge of the plate");
      near(holeCentre(followed.entities)[0], 25, 1e-5, "the hole kept its 5 mm from the edge");
      equal(JSON.stringify(followed.projections), JSON.stringify(second.sketch.projections), "the link itself is unchanged");
      const pinAfter = meshStats(bodyOf(project, "general-body:extrude-2"));
      near((pinAfter.lo[0] + pinAfter.hi[0]) / 2, 25, 1e-3, "and the pin moved with it");

      // Reload, then widen again: the link still works.
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(project));
      assert(reloaded.ok, "the project reloads");
      let again = pipelineRun(reloaded.value, { kind: "edit-design-sketch", featureId: "feature:s1" });
      again = pipelineRun(again, { kind: "set-sketch-dimension", entityId: "entity:plate", dimension: "width", valueMm: 80 });
      again = pipelineRun(again, { kind: "commit-design-sketch", featureId: "feature:s1", name: "Sketch 1" });
      again = pipelineRun(again, { kind: "regenerate-design", results: await rebuildDependents(again, "feature:s1") });
      near(holeCentre(sketchFeature(again, "feature:s2").sketch.entities)[0], 35, 1e-5, "after a reload the hole follows the plate again");
    }
  },
  {
    name: "Linked projection: a solid that no longer gives the same curves leaves them alone with a reason; a hand edit, a delete and Break link each unlink",
    run: async () => {
      const { drawn, edgeId, projectedIds } = await projectedPlate();
      const committed = pipelineRun(drawn, { kind: "commit-design-sketch", featureId: "feature:s2", name: "Sketch 2" });
      const second = sketchFeature(committed, "feature:s2");

      // A solid with a different outline (a round bar): the curve count differs, so nothing is replaced and the feature is told why.
      const barSketch = committedSketch("datum:xy", [circ("bar", 0, 0, 12)], { featureId: "feature:bar" });
      const bar = await rebuildSolidFeature(solidFeature("extrude", barSketch.sketch, { id: "feature:bar-1", bodyId: "general-body:extrude-1" }), barSketch.sketch);
      assert(bar.ok, "the bar builds");
      const mismatch = followSketchProjections(second, () => bar.body);
      assert(mismatch.warning !== undefined && /left as they were/u.test(mismatch.warning), `a different outline is reported: ${mismatch.warning ?? ""}`);
      equal(mismatch.entities.length, 0, "and no curve is replaced");
      equal(mismatch.sketchFeature, second, "the sketch is untouched");
      const gone = followSketchProjections(second, () => undefined);
      assert(gone.warning !== undefined && /no longer in the design/u.test(gone.warning), "a deleted solid is reported too");

      // Moving a linked curve by hand unlinks that curve and says so; the others stay linked.
      const edge = drawn.sketch.entities.find((entity) => entity.id === edgeId) as Line;
      const nudged = pipelineApply(drawn, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [{ ...edge, start: [edge.start[0] + 2, edge.start[1]], end: [edge.end[0] + 2, edge.end[1]] }], addEntities: [], addConstraints: [], removeConstraintIds: drawn.sketch.constraints.map((constraint) => constraint.id), label: "Move" });
      assert(nudged.ok, `the hand edit applies: ${nudged.ok ? "" : nudged.diagnostics[0]?.message ?? ""}`);
      assert(/changed by hand/u.test(nudged.value.summary), "the status says the curve no longer follows the solid");
      const afterNudge = linkedSketchEntityIds(nudged.value.project.sketch);
      assert(!afterNudge.has(edgeId) && afterNudge.size === projectedIds.length - 1, "only the moved curve lost its link");
      equal(nudged.value.project.sketch.projections![0]!.entityIds.length, projectedIds.length, "the other curves keep their places in the projection");

      // Deleting a linked curve unlinks it.
      const other = projectedIds.find((id) => id !== edgeId)!;
      const deleted = pipelineRun({ ...drawn, sketch: { ...drawn.sketch, constraints: [] } }, { kind: "delete-sketch-entity", entityId: other });
      assert(!linkedSketchEntityIds(deleted.sketch).has(other) && linkedSketchEntityIds(deleted.sketch).size === projectedIds.length - 1, "a deleted curve leaves the projection");

      // Break link on every projected curve: they stay as ordinary curves that can move again, in one step.
      const objects = breakProjectionLinks(drawn.sketch, projectedIds);
      assert(objects !== undefined, "there is a link to break");
      const unlinked = pipelineRun(drawn, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], objects, label: "Break projection link" });
      equal(unlinked.sketch.projections, undefined, "the projection is forgotten");
      equal(unlinked.sketch.entities.length, drawn.sketch.entities.length, "every curve is still there");
      equal(unlinked.revision, drawn.revision + 1, "one operation, one step to undo");
      assert((analyzeLiveSketch(unlinked.sketch).entityFreedom[edgeId] ?? 0) > 0, "an unlinked curve can move again");
      equal(breakProjectionLinks(unlinked.sketch, projectedIds), undefined, "and there is nothing left to break");
    }
  }
];
