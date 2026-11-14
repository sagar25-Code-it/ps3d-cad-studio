import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { sketchCurvePrimitives, withSketchCurves } from "../apps/studio-web/src/sketch-curves.js";
import { ProjectTree } from "../apps/studio-web/src/ui/ProjectTree.js";
import { designOf, isSketchShown, sketchEyeShown, stepsUsingSketch, validateWorkbenchProject, type DesignSketchFeature, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { buildDesignHealthReport } from "../packages/workbench-health/src/index.js";
import { buildPartPreview } from "../packages/workbench-geometry/src/index.js";
import { applyOp, PLATE_BODY as PLATE, plateHoleFillet, refusedOp } from "./history-kit.js";
import { committedSketch, rect } from "./pipeline-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-24: every finished sketch is listed under Sketches with an eye, and the sketches that are shown are drawn in the Part view. */

const noop = (): void => undefined;
const sketchOf = (project: WorkbenchProject, id = "feature:s1"): DesignSketchFeature => designOf(project).features.find((feature): feature is DesignSketchFeature => feature.id === id && feature.kind === "sketch")!;

/** Two sketches: s1 (a rectangle on XY) with a plate built on it, and s2 (a rectangle on XZ, offset 5 mm) nothing is built on. */
function twoSketches(): WorkbenchProject {
  const first = plateHoleFillet();
  const { project } = committedSketch("datum:xz", [rect("slot", 0, 0, 20, 10)], { project: first, featureId: "feature:s2", offsetMm: 5 });
  return { ...project, activeWorkspace: "part" };
}

export const sketchesFolderTests: readonly TestCase[] = [
  {
    name: "A finished sketch is shown while nothing is built on it and put away once a step is; its own eye overrides either, and a suppressed or rolled-back sketch is not drawn",
    run: () => {
      const project = twoSketches();
      const history = designOf(project);
      equal(stepsUsingSketch(history, "feature:s1").length, 3, "the plate's three steps are built on Sketch 1");
      assert(!sketchEyeShown(history, sketchOf(project, "feature:s1")) && sketchEyeShown(history, sketchOf(project, "feature:s2")), "the used sketch is hidden by default, the unused one shown");
      const shown = applyOp(project, { kind: "set-design-sketch-visibility", featureId: "feature:s1", visible: true });
      assert(isSketchShown(designOf(shown), sketchOf(shown, "feature:s1")), "an explicit eye shows a sketch that has steps built on it");
      const hidden = applyOp(project, { kind: "set-design-sketch-visibility", featureId: "feature:s2", visible: false });
      assert(!isSketchShown(designOf(hidden), sketchOf(hidden, "feature:s2")), "an explicit eye hides an unused sketch");
      const suppressed = applyOp(project, { kind: "set-design-feature-suppressed", featureId: "feature:s2", suppressed: true });
      assert(!isSketchShown(designOf(suppressed), sketchOf(suppressed, "feature:s2")), "a suppressed sketch is not drawn");
      const rolled = applyOp(project, { kind: "set-design-rollback", index: 4 });
      assert(!isSketchShown(designOf(rolled), sketchOf(rolled, "feature:s2")), "a sketch after the marker is not drawn");
    }
  },
  {
    name: "The eye is one operation that survives save and reload, refuses a solid step, and a non-boolean value in a file is rejected",
    run: () => {
      const project = twoSketches();
      const before = project.revision;
      const hidden = applyOp(project, { kind: "set-design-sketch-visibility", featureId: "feature:s2", visible: false });
      equal(hidden.revision, before + 1, "one revision, so one Undo step");
      equal(sketchOf(hidden, "feature:s2").visible, false, "the choice is stored on the sketch");
      const reloaded = validateWorkbenchProject(JSON.parse(JSON.stringify(hidden)));
      assert(reloaded.ok && sketchOf(reloaded.value, "feature:s2").visible === false, "it is saved and loaded");
      assert(refusedOp(project, { kind: "set-design-sketch-visibility", featureId: "feature:extrude-1", visible: true }).includes("solid"), "a solid step is refused with a reason");
      assert(refusedOp(project, { kind: "set-design-sketch-visibility", featureId: "feature:gone", visible: true }).length > 0, "a missing sketch is refused");
      const tampered = JSON.parse(JSON.stringify(hidden));
      tampered.design.features.find((feature: { id: string }) => feature.id === "feature:s2").visible = "yes";
      assert(!validateWorkbenchProject(tampered).ok, "a file with a visible that is not true or false is refused");
      // A project saved before the eye existed loads and shows the default.
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(project))).ok, "a project without the field still loads");
    }
  },
  {
    name: "Shown sketches are drawn in the Part view in their own place: closed curves close, an offset plane is applied, hidden ones add nothing",
    run: () => {
      const project = twoSketches();
      const lines = sketchCurvePrimitives(project);
      equal(lines.length, 1, "only the unused sketch is drawn by default");
      const line = lines[0]!;
      assert(line.kind === "line" && line.id.startsWith("feature:s2:curve:") && line.selectable === false, "a guide line that cannot be picked");
      if (line.kind !== "line") return;
      equal(line.pointsMm.length, 5 * 3, "a rectangle is four corners and back to the first");
      // An XZ sketch (X right, Z up) offset 5 mm along its normal (-Y): every point is at y = -5.
      for (let index = 1; index < line.pointsMm.length; index += 3) assert(Math.abs(line.pointsMm[index]! + 5) < 1e-9, `point ${index} lies on the offset plane: y = ${line.pointsMm[index]}`);
      equal(line.pointsMm[0], line.pointsMm[12], "the ring is closed");
      const shownBoth = applyOp(project, { kind: "set-design-sketch-visibility", featureId: "feature:s1", visible: true });
      equal(sketchCurvePrimitives(shownBoth).length, 2, "showing the plate's sketch adds its curve");
      const none = applyOp(applyOp(project, { kind: "set-design-sketch-visibility", featureId: "feature:s2", visible: false }), { kind: "set-design-sketch-visibility", featureId: "feature:s1", visible: false });
      equal(sketchCurvePrimitives(none).length, 0, "hidden sketches add nothing");
      const scene = buildPartPreview(project.part);
      equal(withSketchCurves(scene, none).primitives.length, scene.primitives.length, "the scene is unchanged when nothing is shown");
      equal(withSketchCurves(scene, project).primitives.length, scene.primitives.length + 1, "and gains the sketch's line when one is shown");
    }
  },
  {
    name: "The Sketches folder lists every finished sketch with an eye that offers Hide or Show, and a body keeps its own eye",
    run: () => {
      const project = twoSketches();
      const tree = (candidate: WorkbenchProject, withSketchEye = true): string => renderToStaticMarkup(createElement(ProjectTree, { project: candidate, selectedId: null, revealSelectionRequest: 0, designHealth: buildDesignHealthReport(candidate), onSelect: noop, onContextMenu: noop, onToggleBody: noop, ...(withSketchEye ? { onToggleSketch: noop } : {}) }));
      const html = tree(project);
      const eyes = [...html.matchAll(/<button[^>]*class="tree-eye"[^>]*aria-label="([^"]+)"[^>]*>/gu)].map((match) => match[1]!);
      const sketchNames = designOf(project).features.filter((feature) => feature.kind === "sketch").map((feature) => feature.name);
      for (const name of sketchNames) assert(eyes.some((label) => label.endsWith(` ${name}`) && /^(Hide|Show) /u.test(label)), `${name} has an eye: ${eyes.join(" | ")}`);
      assert(eyes.includes(`Hide ${sketchNames[1]!}`) && eyes.includes(`Show ${sketchNames[0]!}`), "the unused sketch offers Hide, the used one offers Show");
      assert(eyes.includes(`Hide ${PLATE}`), "the body row keeps its own eye");
      assert(html.includes("shown in the model") && html.includes("hidden"), "each row says whether it is drawn");
      assert(!tree(project, false).includes(`aria-label="Hide ${sketchNames[1]!}"`), "a host that cannot toggle shows no dead eye on a sketch");
      assert(html.includes("Hide this sketch") && html.includes("Show this sketch"), "the eye's tooltip says sketch, not body");
    }
  },
];

