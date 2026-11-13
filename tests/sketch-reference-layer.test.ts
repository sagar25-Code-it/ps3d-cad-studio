import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createWorkbenchProject, parseWorkbenchProjectText, serializeWorkbenchProject, type DesignSketchFeature, type GeneralSolidBody, type SketchEntity, type WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { autoConstraintsFor } from "../packages/workbench-sketch/src/auto-constraints.js";
import { inferSketchPoint } from "../packages/workbench-sketch/src/inference.js";
import { buildSketchEntity } from "../packages/workbench-sketch/src/index.js";
import { describeReferenceLayer, isReferenceId, sketchReferenceLayer, sketchWithReference } from "../apps/studio-web/src/sketch-reference.js";
import { sketchPrefs } from "../apps/studio-web/src/workspaces/sketch/sketch-prefs.js";
import { SketchWorkspace } from "../apps/studio-web/src/workspaces/SketchWorkspace.js";
import { buildSolid, circ, committedSketch, fresh, line, pipelineRun, rect, solidOf } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * The model and the other sketches are visible behind the working sketch as a dimmed, read-only layer the pointer snaps to.
 * Nothing of it is stored in the sketch and no relation is recorded for a snap to it.
 */

/** An 80 x 50 x 6 plate standing on the XY plane with a corner on the origin, and the project that holds its sketch. */
async function plate(): Promise<{ readonly body: GeneralSolidBody; readonly base: DesignSketchFeature }> {
  const { sketch } = committedSketch("datum:xy", [rect("plate", 40, 25, 80, 50)]);
  return { body: solidOf(await buildSolid(sketch, "extrude", { valueMm: 6 })), base: sketch };
}

/** A new sketch on the plate's top face (XY, 6 mm up). */
function topSketch(): WorkbenchSketch {
  return pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy", offsetMm: 6 }).sketch;
}

const ends = (entities: readonly SketchEntity[]): readonly string[] => entities.flatMap((entity) => entity.kind === "line" ? [entity.start, entity.end] : []).map((point) => `${Math.round(point[0] * 1000) / 1000},${Math.round(point[1] * 1000) / 1000}`);

const noop = (): void => undefined;
function workspaceMarkup(sketch: WorkbenchSketch, reference: ReturnType<typeof sketchReferenceLayer>): string {
  const base = {
    projectId: "project:reference-ui", sketch, reference, finishedSketches: [], workingTimelineId: null, constraintExtras: { revision: 0, pierceHits: () => [], pierceRefresh: () => undefined, pierceUnresolved: () => [] }, tool: "select", dimensionMode: false, cancelVersion: 0, selectedId: null,
    targetBodies: [], solidBodies: [], displayUnit: "mm", editTool: null, showMovable: false, checkOpen: false, request: null, fitSerial: 0, optionsRevealRequest: 0,
    viewportState: { navigationMode: "select", selectionFilter: "any", gridVisible: true, axesVisible: true, orientation: "top", projection: "orthographic", shadingMode: "shaded", bodyColor: "steel", backgroundTone: "light", azimuthDeg: 0, elevationDeg: 0 }
  };
  const props = new Proxy(base as Record<string, unknown>, { get: (target, key) => (key in target ? target[key as string] : typeof key === "string" && key.startsWith("on") ? noop : undefined), has: () => true });
  return renderToStaticMarkup(createElement(SketchWorkspace, props as never));
}

export const sketchReferenceLayerTests: readonly TestCase[] = [
  {
    name: "Model behind the sketch: a visible solid's edges are reference curves in the sketch's coordinates; a hidden solid gives none",
    run: async () => {
      const { body } = await plate();
      const layer = sketchReferenceLayer({ sketch: topSketch(), bodies: [body], sketches: [] });
      equal(layer.bodyCount, 1, "one solid contributes");
      assert(layer.entities.length >= 4, "at least the four outline edges");
      assert(layer.entities.every((entity) => isReferenceId(entity.id) && entity.id.startsWith(`reference:body:${body.id}:`)), "every curve is named after its source and marked as reference");
      const corners = new Set(ends(layer.entities));
      for (const corner of ["0,0", "80,0", "80,50", "0,50"]) assert(corners.has(corner), `the plate corner ${corner} is an end of a reference line`);
      equal(sketchReferenceLayer({ sketch: topSketch(), bodies: [{ ...body, visible: false }], sketches: [] }).entities.length, 0, "a hidden solid is not shown");
      assert(describeReferenceLayer(layer).startsWith("Showing 1 solid as "), "the palette line names what is shown");
      assert(describeReferenceLayer(undefined).startsWith("Nothing to show yet"), "and says so when there is nothing");
      const capped = sketchReferenceLayer({ sketch: topSketch(), bodies: [body], sketches: [], limit: 2 });
      equal(capped.entities.length, 2, "the limit is kept");
      equal(capped.omitted, layer.entities.length - 2, "and the curves left out are counted");
    }
  },
  {
    name: "Other sketches behind the sketch: a parallel sketch shows all its curves, a perpendicular one its lines, the sketch being edited is left out",
    run: () => {
      const same = committedSketch("datum:xy", [line("a", [0, 0], [30, 0]), circ("hole", 10, 10, 4)], { featureId: "feature:s1" });
      const side = committedSketch("datum:xz", [line("up", [5, 0], [5, 20]), circ("ring", 0, 0, 3)], { project: same.project, featureId: "feature:s2" });
      const sketches = [same.sketch, side.sketch];
      const layer = sketchReferenceLayer({ sketch: topSketch(), bodies: [], sketches });
      equal(layer.sketchCount, 1, "only the parallel sketch has something to show");
      const fromSame = layer.entities.filter((entity) => entity.id.startsWith("reference:sketch:feature:s1:"));
      equal(fromSame.map((entity) => entity.kind).sort().join(","), "circle,line", "the parallel sketch shows its line and its circle");
      const hole = fromSame.find((entity) => entity.kind === "circle");
      assert(hole?.kind === "circle" && hole.center[0] === 10 && hole.center[1] === 10 && hole.radiusMm === 4, "the circle keeps its place and size");
      const fromSide = layer.entities.filter((entity) => entity.id.startsWith("reference:sketch:feature:s2:"));
      equal(fromSide.length, 0, "a line that runs straight at this plane has no length on it and a circle seen edge-on is not a circle: neither is shown");
      // A line of the side sketch that runs along X is seen full length from the top.
      const along = committedSketch("datum:xz", [line("along", [5, 3], [25, 3])], { featureId: "feature:s3" });
      const seen = sketchReferenceLayer({ sketch: topSketch(), bodies: [], sketches: [along.sketch] }).entities;
      equal(seen.length, 1, "one line");
      assert(seen[0]?.kind === "line", "it is a line");
      if (seen[0]?.kind === "line") { near(seen[0].start[0], 5, 1e-9, "start x"); near(seen[0].end[0], 25, 1e-9, "end x"); near(seen[0].start[1], seen[0].end[1], 1e-9, "it lies level on this plane"); }
      equal(sketchReferenceLayer({ sketch: topSketch(), bodies: [], sketches, editingSketchId: "feature:s1" }).entities.some((entity) => entity.id.includes("feature:s1")), false, "the sketch open for editing is not shown behind itself");
      equal(sketchReferenceLayer({ sketch: topSketch(), bodies: [], sketches: [{ ...same.sketch, suppressed: true }] }).entities.length, 0, "a suppressed sketch is not shown");
    }
  },
  {
    name: "The pointer snaps to the model behind the sketch, the line is drawn there, and no relation or curve of the model is stored",
    run: async () => {
      const { body } = await plate();
      let project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy", offsetMm: 6 });
      const layer = sketchReferenceLayer({ sketch: project.sketch, bodies: [body], sketches: [] });
      const snapSketch = sketchWithReference(project.sketch, layer, true);
      equal(sketchWithReference(project.sketch, layer, false), project.sketch, "with the layer switched off the snapping sees the sketch only");
      const start = inferSketchPoint([79.6, 50.3], snapSketch, { toleranceMm: 1, gridMm: 5 });
      assert(start.snapped && start.primary?.kind === "endpoint" && isReferenceId(start.primary.entityId), "the pointer near the plate corner snaps to the end of a reference edge");
      near(start.point[0], 80, 1e-9, "at x = 80");
      near(start.point[1], 50, 1e-9, "at y = 50");
      equal(inferSketchPoint([79.6, 50.3], project.sketch, { toleranceMm: 1, gridMm: 0 }).primary?.kind === "endpoint", false, "without the layer there is nothing to snap to there");
      const end = inferSketchPoint([40.2, 49.8], snapSketch, { toleranceMm: 1, gridMm: 0 });
      assert(end.snapped && isReferenceId(end.primary?.entityId), "a second point snaps to the top edge of the plate");
      const built = buildSketchEntity("line", [start.point, end.point], "entity:on-model");
      assert(built.ok, "the line builds");
      if (!built.ok) return;
      const relations = autoConstraintsFor({ tool: "line", entity: built.value, placed: [{ point: start.point, ...(start.primary === undefined ? {} : { primary: start.primary }), guides: start.guides }, { point: end.point, ...(end.primary === undefined ? {} : { primary: end.primary }), guides: end.guides, anchor: start.point }], sketch: project.sketch, newId: () => "constraint:none" });
      assert(relations.every((relation) => relation.entityIds.every((id) => !isReferenceId(id))), "no relation names a curve of the model");
      project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [built.value], addConstraints: relations, label: "Line on the model" });
      equal(project.sketch.entities.length, 1, "only the drawn line is in the sketch");
      const text = serializeWorkbenchProject(project);
      assert(!text.includes("reference:"), "nothing of the reference layer is saved");
      const reloaded = parseWorkbenchProjectText(text);
      assert(reloaded.ok && reloaded.value.sketch.entities.length === 1, "the project reloads with the one line");
    }
  },
  {
    name: "The Sketch workspace draws the reference layer dimmed and unselectable, with a palette switch that names what is shown",
    run: async () => {
      const { body } = await plate();
      const sketch: WorkbenchSketch = { ...createWorkbenchProject("project:reference-ui").sketch, entities: [line("mine", [5, 5], [20, 5])], constraints: [], plane: "datum:xy", planeOffsetMm: 6 };
      const layer = sketchReferenceLayer({ sketch, bodies: [body], sketches: [] });
      const shown = workspaceMarkup(sketch, layer);
      assert(shown.includes("sketch-reference-layer"), "the layer is drawn");
      equal(shown.split("data-reference-id=").length - 1, layer.entities.length, "one mark per reference curve");
      assert(!shown.includes("data-selection-id=\"reference:"), "a reference curve has no selection id, so it cannot be selected or right-clicked");
      assert(shown.includes("Model behind sketch") && shown.includes("Showing 1 solid as"), "the palette has the switch and says what is shown");
      assert(shown.includes("the view stays straight at the sketch plane"), "and states that the view does not orbit while sketching");
      sketchPrefs.set("showReference", false, false);
      try {
        const hidden = workspaceMarkup(sketch, layer);
        assert(!hidden.includes("sketch-reference-layer"), "switched off, the layer is not drawn");
        assert(hidden.includes("Model behind sketch"), "the switch stays");
      } finally {
        sketchPrefs.set("showReference", true, false);
      }
    }
  },
];
