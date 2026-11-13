import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SKETCH_ORIGIN_ID, createWorkbenchProject, parseWorkbenchProjectText, serializeWorkbenchProject, type SketchEntity, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { orientationForPlacement, placePointDistance, resolveDimensionPair, type PairDimension } from "../packages/workbench-sketch/src/dimension-pick.js";
import { SketchWorkspace } from "../apps/studio-web/src/workspaces/SketchWorkspace.js";
import { DimensionEditor } from "../apps/studio-web/src/workspaces/sketch/DimensionEditor.js";
import { circ, fresh, line, pipelineRun, rect } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * Sketch Dimension with two picks: the pair decides the dimension (distance between parallel lines, angle between lines, point to line,
 * point to point placed as straight, horizontal or vertical), and the value typed goes through the ordinary dimension operation.
 */

function sketchOf(entities: readonly SketchEntity[]): WorkbenchProject {
  const project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
  return pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: entities, addConstraints: [], label: "Draw" });
}

/** What the canvas sends when the editor's value is entered for a pair dimension. */
function drive(project: WorkbenchProject, found: PairDimension, value: number): WorkbenchProject {
  return pipelineRun(project, { kind: "set-sketch-dimension", entityId: found.entityId, secondEntityId: found.secondEntityId, dimension: found.dimension, valueMm: value, ...(found.points === undefined ? {} : { points: found.points }) });
}

const spline: SketchEntity = { id: "entity:s", kind: "spline", fitPoints: [[0, 50], [10, 60], [20, 50]], construction: false };
const noop = (): undefined => undefined;

export const sketchDimensionPickTests: readonly TestCase[] = [
  {
    name: "Dimension two picks: parallel lines give their distance, crossing lines their angle, a centre and a line the point-to-line distance, in either order",
    run: () => {
      const project = sketchOf([line("a", [0, 0], [40, 0]), line("b", [5, 15], [45, 15]), line("c", [0, 0], [20, 20]), circ("hole", 30, 40, 4), rect("plate", 100, 0, 20, 10), spline]);
      const parallel = resolveDimensionPair(project.sketch, { entityId: "entity:a" }, { entityId: "entity:b" });
      assert(parallel.status === "ready" && parallel.dimension.dimension === "line-line" && parallel.dimension.points === undefined, `two parallel lines: ${parallel.status}`);
      if (parallel.status !== "ready") return;
      near(parallel.dimension.measured, 15, 1e-9, "they are 15 mm apart");
      equal(parallel.dimension.label, "Distance between the lines", "the editor says what it is");
      const angle = resolveDimensionPair(project.sketch, { entityId: "entity:a" }, { entityId: "entity:c" });
      assert(angle.status === "ready" && angle.dimension.dimension === "angle", "two lines that are not parallel");
      if (angle.status !== "ready") return;
      near(angle.dimension.measured, 45, 1e-9, "45 degrees from the first to the second");
      const toLine = resolveDimensionPair(project.sketch, { entityId: "entity:hole" }, { entityId: "entity:a" });
      const fromLine = resolveDimensionPair(project.sketch, { entityId: "entity:a" }, { entityId: "entity:hole" });
      assert(toLine.status === "ready" && fromLine.status === "ready", "a circle and a line, either way round");
      if (toLine.status !== "ready" || fromLine.status !== "ready") return;
      equal(JSON.stringify(fromLine.dimension), JSON.stringify(toLine.dimension), "the pick order does not matter");
      equal(`${toLine.dimension.dimension}:${toLine.dimension.entityId}>${toLine.dimension.secondEntityId}:${toLine.dimension.points?.join()}`, "point-line:entity:hole>entity:a:center", "the circle's centre to the line");
      near(toLine.dimension.measured, 40, 1e-9, "40 mm");
      const corner = resolveDimensionPair(project.sketch, { entityId: "entity:a" }, { entityId: "entity:plate", ref: "corner-0" });
      assert(corner.status === "ready" && corner.dimension.points?.join() === "corner-0", "a picked rectangle corner to a line");
      const none = resolveDimensionPair(project.sketch, { entityId: "entity:a" }, { entityId: "entity:s" });
      assert(none.status === "none" && /spline/u.test(none.message), "a spline is refused with the reason");
      assert(resolveDimensionPair(project.sketch, { entityId: "entity:a" }, { entityId: "entity:a" }).status === "none", "the same line twice is not a pair");
      assert(resolveDimensionPair(project.sketch, { entityId: "entity:a" }, { entityId: "entity:a", ref: "end" }).status === "none", "a line and its own end are not a pair");
      assert(resolveDimensionPair(project.sketch, { entityId: "entity:a" }, { entityId: "entity:gone" }).status === "none", "a curve that is gone is not a pair");
    }
  },
  {
    name: "Dimension two picks: two centres or points wait for a placing click, which chooses straight, horizontal or vertical",
    run: () => {
      const project = sketchOf([circ("p", 10, 10, 3), circ("q", 50, 40, 3), line("a", [0, 0], [40, 0])]);
      const pair = resolveDimensionPair(project.sketch, { entityId: "entity:p" }, { entityId: "entity:q" });
      assert(pair.status === "place" && /above or below/u.test(pair.prompt), "two circles ask where to place the dimension");
      if (pair.status !== "place") return;
      equal(pair.placement.points.join(), "center,center", "centre to centre");
      equal(orientationForPlacement([10, 10], [50, 40], [30, 60]), "horizontal", "placed above the points: the horizontal distance");
      equal(orientationForPlacement([10, 10], [50, 40], [30, -5]), "horizontal", "or below them");
      equal(orientationForPlacement([10, 10], [50, 40], [70, 25]), "vertical", "placed beside them: the vertical distance");
      equal(orientationForPlacement([10, 10], [50, 40], [30, 25]), "aligned", "placed between them: the straight distance");
      equal(orientationForPlacement([10, 10], [50, 40], [80, 80]), "aligned", "placed past a corner: the straight distance");
      equal(orientationForPlacement([10, 10], [10, 40], [10, 60]), "aligned", "points in one column have no horizontal distance to drive");
      const across = placePointDistance(project.sketch, pair.placement, [30, 60]);
      assert(typeof across !== "string" && across.dimension === "horizontal" && across.label === "Horizontal distance", "the placed dimension is horizontal");
      if (typeof across === "string") return;
      near(across.measured, 40, 1e-9, "40 mm across");
      const straight = placePointDistance(project.sketch, pair.placement, [30, 25]);
      assert(typeof straight !== "string" && straight.dimension === "aligned", "straight");
      if (typeof straight === "string") return;
      near(straight.measured, 50, 1e-9, "50 mm straight");
      // The origin and a line end, picked as points (the blue dots).
      const fromOrigin = resolveDimensionPair(project.sketch, { entityId: SKETCH_ORIGIN_ID, ref: "self" }, { entityId: "entity:a", ref: "end" });
      assert(fromOrigin.status === "place" && fromOrigin.placement.points.join() === "self,end", "the origin to a line end");
      assert(resolveDimensionPair(project.sketch, { entityId: "entity:p", ref: "center" }, { entityId: "entity:p", ref: "center" }).status === "none", "one point twice is not a pair");
    }
  },
  {
    name: "Dimension two picks: the typed value drives the geometry, is found again as the pair's dimension, and survives save and reload",
    run: () => {
      const project = sketchOf([line("a", [0, 0], [40, 0]), line("b", [5, 15], [45, 15]), line("c", [60, 0], [80, 20]), circ("p", 10, 60, 3), circ("q", 50, 90, 3)]);
      // Distance between the parallel lines: 15 -> 25.
      const parallel = resolveDimensionPair(project.sketch, { entityId: "entity:a" }, { entityId: "entity:b" });
      assert(parallel.status === "ready", "parallel lines");
      if (parallel.status !== "ready") return;
      let driven = drive(project, parallel.dimension, 25);
      const b = driven.sketch.entities.find((entity) => entity.id === "entity:b");
      const a = driven.sketch.entities.find((entity) => entity.id === "entity:a");
      assert(a?.kind === "line" && b?.kind === "line", "both lines");
      near(Math.abs(b.start[1] - a.start[1]), 25, 1e-6, "the lines are 25 mm apart");
      near(b.end[1] - b.start[1], 0, 1e-6, "and still parallel");
      // Angle between a and c: 45 -> 60.
      const angle = resolveDimensionPair(driven.sketch, { entityId: "entity:a" }, { entityId: "entity:c" });
      assert(angle.status === "ready" && angle.dimension.dimension === "angle", "angle");
      if (angle.status !== "ready") return;
      driven = drive(driven, angle.dimension, 60);
      const c = driven.sketch.entities.find((entity) => entity.id === "entity:c");
      const a2 = driven.sketch.entities.find((entity) => entity.id === "entity:a");
      assert(c?.kind === "line" && a2?.kind === "line", "lines");
      const turn = (Math.atan2(c.end[1] - c.start[1], c.end[0] - c.start[0]) - Math.atan2(a2.end[1] - a2.start[1], a2.end[0] - a2.start[0])) * 180 / Math.PI;
      near(((turn % 360) + 360) % 360, 60, 1e-5, "the lines are at 60 degrees");
      // Horizontal distance between the two holes: 40 -> 32.
      const holes = resolveDimensionPair(driven.sketch, { entityId: "entity:p" }, { entityId: "entity:q" });
      assert(holes.status === "place", "two circles");
      if (holes.status !== "place") return;
      const across = placePointDistance(driven.sketch, holes.placement, [30, 120]);
      assert(typeof across !== "string", "placed");
      if (typeof across === "string") return;
      driven = drive(driven, across, 32);
      const p = driven.sketch.entities.find((entity) => entity.id === "entity:p");
      const q = driven.sketch.entities.find((entity) => entity.id === "entity:q");
      assert(p?.kind === "circle" && q?.kind === "circle", "circles");
      near(Math.abs(q.center[0] - p.center[0]), 32, 1e-6, "the centres are 32 mm apart across");
      near(p.center[0], 10, 1e-6, "the first pick stayed where it was");
      // Picking the same pairs again finds the dimensions that now exist, so the editor opens on their values.
      const again = resolveDimensionPair(driven.sketch, { entityId: "entity:a" }, { entityId: "entity:b" });
      assert(again.status === "ready" && again.dimension.existing?.value === 25 && again.dimension.existing.reference === false, "the line distance is found with its value");
      const againAcross = placePointDistance(driven.sketch, holes.placement, [30, 120]);
      assert(typeof againAcross !== "string" && againAcross.existing?.value === 32, "and the horizontal distance");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(driven));
      assert(reloaded.ok, "reloads");
      if (!reloaded.ok) return;
      equal(reloaded.value.sketch.constraints.length, 3, "the three dimensions are saved");
      equal(JSON.stringify(reloaded.value.sketch.entities), JSON.stringify(driven.sketch.entities), "with the geometry they drove");
      equal(project.sketch.constraints.length, 0, "the project before the edits (what Undo returns to) is untouched");
    }
  },
  {
    name: "Dimension two picks: the canvas banner says what the next click does, and the editor tells Esc from a click elsewhere",
    run: () => {
      const project = createWorkbenchProject("project:dimension-pick-ui");
      const base = {
        projectId: project.id, sketch: { ...project.sketch, entities: [line("a", [0, 0], [40, 0]), line("b", [5, 15], [45, 15])], constraints: [] }, finishedSketches: [], workingTimelineId: null, constraintExtras: { revision: 0, pierceHits: () => [], pierceRefresh: () => undefined, pierceUnresolved: () => [] }, tool: "select", dimensionMode: true, cancelVersion: 0, selectedId: null,
        targetBodies: [], solidBodies: [], displayUnit: "mm", editTool: null, showMovable: false, checkOpen: false, request: null, fitSerial: 0, optionsRevealRequest: 0,
        viewportState: { navigationMode: "select", selectionFilter: "any", gridVisible: true, axesVisible: true, orientation: "top", projection: "orthographic", shadingMode: "shaded", bodyColor: "steel", backgroundTone: "light", azimuthDeg: 0, elevationDeg: 0 }
      };
      const props = new Proxy(base as Record<string, unknown>, { get: (target, key) => (key in target ? target[key as string] : typeof key === "string" && key.startsWith("on") ? noop : undefined), has: () => true });
      const html = renderToStaticMarkup(createElement(SketchWorkspace, props as never));
      assert(html.includes("Click a curve for its size, then a second curve or point for a distance or an angle."), "the banner names the two-pick flow");
      assert(html.includes("Click a second curve for the distance or the angle between the two"), "and so does the inspector");
      // The editor reports why it closed: Esc forgets the first pick, a click on a second curve (which blurs it) keeps it.
      const editor = readFileSync(new URL("../../apps/studio-web/src/workspaces/sketch/DimensionEditor.tsx", import.meta.url), "utf8");
      assert(editor.includes('props.onCancel("blur")') && editor.split('props.onCancel("escape")').length === 3, "blur and Esc are told apart");
      const workspace = readFileSync(new URL("../../apps/studio-web/src/workspaces/SketchWorkspace.tsx", import.meta.url), "utf8");
      assert(workspace.includes('if (reason === "escape") setDimensionFirst(undefined);'), "Esc forgets the first pick; a click elsewhere does not");
      const closed = renderToStaticMarkup(createElement(DimensionEditor, { label: "Distance between the lines", text: "15", unitLabel: "mm", position: [0, 0], onChange: noop, onCommit: noop, onCancel: noop }));
      assert(closed.includes("Distance between the lines"), "the editor shows the pair dimension's label");
    }
  },
];
