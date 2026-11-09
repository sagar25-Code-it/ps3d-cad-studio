import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesignSketchFeature, DesignSolidFeature, SketchEntity, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { createWorkbenchProject, designOf } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { WORKING_PATH_SKETCH, chainFromCurve, describePath, pathCurvesOf, pathSketchChoices, pathSketchOf, sweepPathParams } from "../apps/studio-web/src/sweep-path-ui.js";
import { rebuildSolidFeature, sketchLookupOf } from "../apps/studio-web/src/design-regeneration.js";
import { SketchWorkspace } from "../apps/studio-web/src/workspaces/SketchWorkspace.js";
import { sketchPrefs } from "../apps/studio-web/src/workspaces/sketch/sketch-prefs.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { circ, committedSketch, line, meshStats, pipelineRun, solidOf } from "./pipeline-kit.js";

/**
 * Wave 3, P10: the Sketch workspace builds a sweep along a path of several chained curves taken from another sketch on another plane,
 * through the same sweepPath reference the timeline rebuilds. The picker logic is tested directly; the sweep goes through the real engine.
 */

const arc = (id: string, start: [number, number], mid: [number, number], end: [number, number]): SketchEntity => ({ id: `entity:${id}`, kind: "arc", start, mid, end, construction: false });

function sketchWith(entities: readonly SketchEntity[]): WorkbenchSketch {
  const base = createWorkbenchProject("project:sweep-path").sketch;
  return { ...base, entities, constraints: [] };
}

const noop = (): undefined => undefined;

export const pipeline3SweepPathTests: readonly TestCase[] = [
  {
    name: "Wave3 P10: the path picker offers this sketch and the finished sketches that have curves, chains the connected curves of a pick, and describes a path or says why it is not one",
    run: () => {
      const outline = sketchWith([line("a", [0, 0], [0, 40]), line("b", [0, 40], [30, 40]), arc("c", [30, 40], [40, 30], [50, 40]), line("far", [100, 100], [120, 100]), { id: "entity:ring", kind: "circle", center: [0, 0], radiusMm: 4, construction: false }]);
      const curves = pathCurvesOf(outline);
      equal(curves.map((curve) => curve.id).join(), "entity:a,entity:b,entity:c,entity:far", "lines and arcs are path curves, a circle is not");
      equal(curves.map((curve) => curve.label).join(), "Line 1,Line 2,Arc 1,Line 3", "and each has a plain label");
      const finished = (id: string, name: string, sketch: WorkbenchSketch): DesignSketchFeature => ({ id, name, kind: "sketch", suppressed: false, sketch });
      const history = [finished("feature:s1", "Profile", sketchWith([circ("p", 0, 0, 5)])), finished("feature:s2", "Rail", outline), finished("feature:s3", "Editing", outline)];
      const choices = pathSketchChoices(history, sketchWith([line("w", [0, 0], [5, 0])]), "feature:s3");
      equal(choices.map((choice) => `${choice.id}:${choice.curves}`).join(), `${WORKING_PATH_SKETCH}:1,feature:s2:4`, "this sketch first, then only finished sketches with curves, never the one being edited");
      assert(pathSketchOf("feature:s2", history, outline)?.entities.length === 5 && pathSketchOf(WORKING_PATH_SKETCH, history, outline) === outline && pathSketchOf("feature:gone", history, outline) === undefined, "a choice resolves to its sketch");

      equal(chainFromCurve(outline, "entity:b").join(), "entity:a,entity:b,entity:c", "one pick selects the whole open chain, in walking order");
      equal(chainFromCurve(outline, "entity:far").join(), "entity:far", "a curve that touches nothing is a chain of one");
      equal(chainFromCurve(outline, "entity:ring").length, 0, "a circle cannot start a path");
      const branched = sketchWith([line("a", [0, 0], [10, 0]), line("b", [10, 0], [20, 0]), line("c", [10, 0], [10, 10])]);
      equal(chainFromCurve(branched, "entity:a").join(), "entity:a", "the chain stops where three curves meet");
      const reversed = sketchWith([line("a", [0, 0], [10, 0]), line("b", [20, 0], [10, 0])]);
      equal(chainFromCurve(reversed, "entity:a").join(), "entity:a,entity:b", "a curve drawn the other way round still continues the chain");

      const good = describePath(outline, ["entity:a", "entity:b", "entity:c"]);
      assert(good.ok && good.curves === 3 && Math.abs(good.lengthMm - (40 + 30 + Math.PI * 10)) < 1, `three chained curves have a length: ${good.ok ? good.lengthMm : good.message}`);
      const shuffled = describePath(outline, ["entity:c", "entity:a", "entity:b"]);
      assert(shuffled.ok, "the picks may be in any order");
      const gap = describePath(outline, ["entity:a", "entity:far"]);
      assert(!gap.ok && /not connected/u.test(gap.message) && /mm apart/u.test(gap.message), `a gap is named: ${gap.ok ? "" : gap.message}`);
      const notPath = describePath(outline, ["entity:ring"]);
      assert(!notPath.ok && /lines, arcs and splines/u.test(notPath.message), `a circle is not a path: ${notPath.ok ? "" : notPath.message}`);
      const none = describePath(outline, []);
      assert(!none.ok && /Pick the curves/u.test(none.message), "nothing picked asks for curves");

      const single = sweepPathParams(WORKING_PATH_SKETCH, ["entity:a"], "feature:new");
      equal(JSON.stringify(single), JSON.stringify({ sweepPathEntityId: "entity:a" }), "one curve of this sketch keeps the single-curve form");
      equal(JSON.stringify(sweepPathParams(WORKING_PATH_SKETCH, ["entity:a", "entity:b"], "feature:new")), JSON.stringify({ sweepPath: { sketchFeatureId: "feature:new", entityIds: ["entity:a", "entity:b"] } }), "several curves of this sketch point at it by the id it gets when finished");
      equal(JSON.stringify(sweepPathParams("feature:s2", ["entity:a"], "feature:new")), JSON.stringify({ sweepPath: { sketchFeatureId: "feature:s2", entityIds: ["entity:a"] } }), "a finished sketch is always a chained reference");
      equal(JSON.stringify(sweepPathParams("feature:s2", [], "feature:new")), "{}", "no curves, no path");
    }
  },
  {
    name: "Wave3 P10: a sweep along a three-curve path drawn on another plane, built from the picker's reference, has the right volume and rebuilds from the timeline",
    run: async () => {
      // The rail is drawn on the Front plane (XZ): up 40 mm, then 30 mm along +X. The profile is a 10 mm circle on the Top plane (XY).
      const rail = committedSketch("datum:xz", [line("up", [0, 0], [0, 40]), line("across", [0, 40], [30, 40])], { featureId: "feature:rail" });
      const withProfile = committedSketch("datum:xy", [circ("tube", 0, 0, 5)], { project: rail.project, featureId: "feature:profile" });
      const profileSketch = withProfile.sketch;
      const profile = detectSketchProfiles(profileSketch.sketch)[0]!;
      const params = sweepPathParams("feature:rail", ["entity:up", "entity:across"], "feature:profile");
      assert(params.sweepPath !== undefined, "the picker builds a chained reference");
      const feature: DesignSolidFeature = { id: "feature:sweep-1", name: "Sweep 1", kind: "sweep", suppressed: false, sketchFeatureId: profileSketch.id, profileIds: [profile.id], valueMm: 1, bodyId: "general-body:sweep-1", sweepPath: params.sweepPath! };
      const lookup = sketchLookupOf(designOf(withProfile.project));
      const built = await rebuildSolidFeature(feature, profileSketch, "#b9c2c8", lookup);
      const body = solidOf(built);
      const stats = meshStats(body);
      const expected = Math.PI * 25 * 70;
      assert(Math.abs(stats.volume - expected) / expected < 0.04, `the swept tube has about pi r^2 L = ${expected.toFixed(0)} mm3 (got ${stats.volume.toFixed(0)})`);
      assert(stats.hi[2] > 35 && stats.hi[0] > 25, `and follows the rail: bounds ${JSON.stringify(stats.hi)}`);
      // The feature is accepted into the timeline and replays from the stored reference.
      const project = pipelineRun(withProfile.project, { kind: "add-design-solid", feature, body });
      const stored = designOf(project).features.find((candidate) => candidate.id === "feature:sweep-1") as DesignSolidFeature;
      equal(JSON.stringify(stored.sweepPath), JSON.stringify(params.sweepPath), "the timeline keeps the chained path reference");
      const again = await rebuildSolidFeature(stored, profileSketch, "#b9c2c8", sketchLookupOf(designOf(project)));
      near(meshStats(solidOf(again)).volume, stats.volume, 1e-6, "and a rebuild gives the same solid");
      // A path with a gap is refused with the reason, not built.
      const broken = await rebuildSolidFeature({ ...feature, sweepPath: { sketchFeatureId: "feature:rail", entityIds: ["entity:up", "entity:missing"] } }, profileSketch, "#b9c2c8", lookup);
      assert(!broken.ok && /no longer in/u.test(broken.message), `a missing path curve is named: ${broken.ok ? "" : broken.message}`);
    }
  },
  {
    name: "Wave3 P10: the Sketch workspace renders the path sketch and path curve controls for a sweep",
    run: () => {
      const project = createWorkbenchProject("project:sweep-ui");
      const working = sketchWith([line("a", [0, 0], [0, 40]), line("b", [0, 40], [30, 40])]);
      const finished: DesignSketchFeature = { id: "feature:rail", name: "Rail sketch", kind: "sketch", suppressed: false, sketch: sketchWith([line("r1", [0, 0], [10, 0]), line("r2", [10, 0], [10, 10])]) };
      sketchPrefs.set("solidOp", "sweep", false);
      sketchPrefs.set("sweepMode", "path", false);
      try {
        const base = {
          projectId: project.id, sketch: working, finishedSketches: [finished], workingTimelineId: null, constraintExtras: { revision: 0, pierceHits: () => [], pierceRefresh: () => undefined, pierceUnresolved: () => [] }, tool: "select", dimensionMode: false, cancelVersion: 0, selectedId: null,
          targetBodies: [], solidBodies: [], displayUnit: "mm", editTool: null, showMovable: false, checkOpen: false, request: null, fitSerial: 0, optionsRevealRequest: 0,
          viewportState: { navigationMode: "select", selectionFilter: "any", gridVisible: true, axesVisible: true, orientation: "top", projection: "orthographic", shadingMode: "shaded", bodyColor: "steel", backgroundTone: "light", azimuthDeg: 0, elevationDeg: 0 }
        };
        const props = new Proxy(base as Record<string, unknown>, { get: (target, key) => (key in target ? target[key as string] : typeof key === "string" && key.startsWith("on") ? noop : undefined), has: () => true });
        const html = renderToStaticMarkup(createElement(SketchWorkspace, props as never));
        assert(html.includes("Sweep path sketch") && html.includes("This sketch (2 curves)") && html.includes("Rail sketch (2 curves)"), "the path sketch picker lists this sketch and the finished one");
        assert(html.includes("Path curve Line 1") && html.includes("Path curve Line 2") && html.includes("Chain the connected curves of the path"), "the curves are listed with a chain button");
        assert(html.includes("Pick the curves of the path."), "and the panel asks for curves until some are picked");
        assert(!html.includes("Sweep path entity"), "the single-curve select is gone");
      } finally {
        sketchPrefs.set("solidOp", "extrude", false);
        sketchPrefs.set("sweepMode", "direction", false);
      }
    }
  }
];
