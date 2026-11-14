import { buildWorkbenchMenus, type WorkbenchMenuActions, type WorkbenchMenuState } from "../apps/studio-web/src/ui/menu-model.js";
import { hasModifiers, replayAllBodies, rebuildSolidFeature, type RebuildResult } from "../apps/studio-web/src/design-regeneration.js";
import { CAD_COMMANDS, CAD_EXECUTABLE_ACTION_KINDS, designOf, faceReferenceOf, planarFacesOfBody, type DesignSketchFeature, type DesignSolidFeature, type GeneralSolidBody, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { committedSketch, meshStats, pipelineRun, rect, solidFeature, solidOf } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** HS-17: a sketch on another body's face makes the project replay on every timeline change, and Compute All is a real command. */

function applyResults(project: WorkbenchProject, results: readonly RebuildResult[]): WorkbenchProject {
  return pipelineRun(project, {
    kind: "regenerate-design",
    results: results.map((result) => ({
      featureId: result.featureId,
      ...(result.body === undefined ? {} : { body: result.body }),
      ...(result.pieces === undefined ? {} : { pieces: result.pieces }),
      ...(result.message === undefined ? {} : { message: result.message }),
      ...(result.sketchPlaneOffsetMm === undefined ? {} : { sketchPlaneOffsetMm: result.sketchPlaneOffsetMm })
    }))
  });
}

const sketchOf = (project: WorkbenchProject, id: string): DesignSketchFeature => designOf(project).features.find((feature): feature is DesignSketchFeature => feature.id === id && feature.kind === "sketch")!;
const bodyOf = (project: WorkbenchProject, id: string): GeneralSolidBody => project.part.generalBodies!.find((body) => body.id === id)!;

/** A 40 x 40 base extruded `height` mm, and a SEPARATE new body (a 10 x 10 boss, 15 mm tall) sketched on the base's top face. Nothing joins or cuts. */
async function baseWithSeparateBoss(height: number): Promise<WorkbenchProject> {
  const base = committedSketch("datum:xy", [rect("base", 0, 0, 40, 40)]);
  const e1 = solidFeature("extrude", base.sketch, { id: "feature:e1", valueMm: height, bodyId: "general-body:base" });
  const baseBody = solidOf(await rebuildSolidFeature(e1, base.sketch));
  let project = pipelineRun(base.project, { kind: "add-design-solid", feature: e1, body: baseBody });
  const top = planarFacesOfBody(baseBody).find((face) => face.axis === "z" && face.outwardPositive)!;
  project = pipelineRun(project, { kind: "new-design-sketch", plane: "datum:xy", offsetMm: top.coordinateMm, face: faceReferenceOf("general-body:base", top) });
  project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [rect("boss", 0, 0, 10, 10)], addConstraints: [], label: "Draw boss" });
  project = pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:s2", name: "Boss sketch" });
  const bossSketch = sketchOf(project, "feature:s2");
  const e2: DesignSolidFeature = { id: "feature:e2", name: "Boss", kind: "extrude", suppressed: false, sketchFeatureId: "feature:s2", profileIds: [detectSketchProfiles(bossSketch.sketch)[0]!.id], valueMm: 15, bodyId: "general-body:boss" };
  const bossBody = solidOf(await rebuildSolidFeature(e2, bossSketch));
  return pipelineRun(project, { kind: "add-design-solid", feature: e2, body: bossBody });
}

const noop = (): void => undefined;
const menus = (withCompute: boolean) => {
  const calls: string[] = [];
  const actions = new Proxy({}, { get: (_target, key) => key === "onComputeAll" ? (withCompute ? () => { calls.push("compute"); } : undefined) : noop }) as WorkbenchMenuActions;
  const state: WorkbenchMenuState = { workspace: "part", masterCartOpen: false, renderStudioOpen: false, working: false, gridVisible: true, canUndo: false, canRedo: false, generalBodyCount: 2, previewBodySelected: false, generalBodySelected: false, selectionDeletable: false };
  return { menus: buildWorkbenchMenus(state, actions), calls };
};

export const computeAllTests: readonly TestCase[] = [
  {
    name: "A new body sketched on another body's face now makes the project replay on a timeline change, and the replay moves it with an edit of the base",
    run: async () => {
      let project = await baseWithSeparateBoss(10);
      equal(hasModifiers(project), true, "a sketch on a body's face needs the replay path even though nothing joins or cuts");
      near(meshStats(bodyOf(project, "general-body:boss")).hi[2], 25, 0.01, "the boss stands on the 10 mm base: 10 + 15 = 25 mm");
      const e1 = { ...designOf(project).features.find((feature): feature is DesignSolidFeature => feature.id === "feature:e1")!, valueMm: 25 };
      const rebuilt = solidOf(await rebuildSolidFeature(e1, sketchOf(project, "feature:s1")));
      project = pipelineRun(project, { kind: "update-design-solid", feature: e1, body: rebuilt });
      // Without the replay the boss would stay where it was (its sketch still at the old height): that was the gap.
      near(meshStats(bodyOf(project, "general-body:boss")).hi[2], 25, 0.01, "an update of the base alone leaves the boss at its old place");
      project = applyResults(project, await replayAllBodies(project));
      near(meshStats(bodyOf(project, "general-body:boss")).hi[2], 40, 0.01, "after the replay the boss stands on the raised top: 25 + 15 = 40 mm");
      near(meshStats(bodyOf(project, "general-body:boss")).lo[2], 25, 0.01, "and starts at the new top face");
    }
  },
  {
    name: "Without a face sketch, joins, cuts, patterns or reaches a plain extrude still skips the replay",
    run: () => {
      const { project } = committedSketch("datum:xy", [rect("a", 0, 0, 20, 20)]);
      equal(hasModifiers(project), false, "a lone sketch does not need it");
    }
  },
  {
    name: "Compute All is a catalog command with Ctrl+B and an executable action, and a Modify menu item that runs the host's handler",
    run: () => {
      const entry = CAD_COMMANDS.find((command) => command.id === "command:part-compute-all");
      assert(entry !== undefined && entry.action.kind === "compute-all", "the command is in the catalog");
      equal(entry.shortcut, "Ctrl+B", "with the Fusion shortcut");
      assert((CAD_EXECUTABLE_ACTION_KINDS as readonly string[]).includes("compute-all"), "its action is executable, not cataloged-only");
      const on = menus(true);
      const modify = on.menus.find((menu) => menu.id === "modify")!;
      const row = modify.items.find((candidate) => candidate.id === "modify.compute-all");
      assert(row !== undefined && row.shortcut === "Ctrl+B" && row.disabled !== true, "the Modify menu offers Compute all");
      row.action();
      equal(on.calls.join(","), "compute", "and it runs the handler");
      const off = menus(false);
      assert(!off.menus.flatMap((menu) => menu.items).some((candidate) => candidate.id === "modify.compute-all"), "a host without the handler shows no dead item");
    }
  },
];
