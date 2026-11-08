import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { analyzeFaces } from "../packages/workbench-geometry/src/face-analysis.js";
import { shellBody } from "../packages/workbench-geometry/src/face-edits.js";
import { addWebs, firstHit, triangulatePolygon2D, webSlab, type WebSpec } from "../packages/workbench-geometry/src/web.js";
import type { DesignSketchFeature, DesignSolidFeature, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, designOf, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { openCurveIds } from "../apps/studio-web/src/web-profile.js";
import { addAndReplay, blockProject, bodyOf, editStep, replayed, volumeOfBody } from "./body-edit-timeline.test.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";
import { boxMesh, face, volumeOf, type Mesh } from "./body-edits.test.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function applyOp(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-web-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

/** A 40 x 30 x 20 box shelled 2 mm with the top open: a cup whose cavity is x 2..38, y 2..28, z 2..20. */
function cup(): Mesh {
  const result = shellBody(boxMesh(40, 30, 20), { thicknessMm: 2, side: "inside", openFaces: [face([20, 15, 20], [0, 0, 1])] });
  assert(result.ok, "the cup is built");
  if (!result.ok) throw new Error("unreachable");
  return { positionsMm: Array.from(result.positionsMm), indices: Array.from(result.indices) };
}
const spec = (extra: Partial<WebSpec> = {}): WebSpec => ({ thicknessMm: 1.5, direction: "symmetric", extendToBody: true, normal: [0, 1, 0], ...extra });
const nearestVertex = (mesh: Mesh, target: readonly [number, number, number]): number => {
  let best = Infinity;
  for (let i = 0; i + 2 < mesh.positionsMm.length; i += 3) best = Math.min(best, Math.hypot(mesh.positionsMm[i]! - target[0], mesh.positionsMm[i + 1]! - target[1], mesh.positionsMm[i + 2]! - target[2]));
  return best;
};

export const bodyWebTests: readonly TestCase[] = [
  {
    name: "Ray casting finds the nearest surface, and the ear-clipping triangulator covers a concave polygon exactly",
    run: () => {
      const box = boxMesh(10, 10, 10);
      near(firstHit(box, [5, 5, 30], [0, 0, -1]) ?? -1, 20, 1e-9, "a ray from above hits the top face 20 mm down");
      near(firstHit(box, [5, 5, 5], [0, 0, 1]) ?? -1, 5, 1e-9, "from inside it hits the top face 5 mm up");
      assert(firstHit(box, [50, 50, 30], [0, 0, -1]) === undefined, "a ray that misses the box finds nothing");
      const l: [number, number][] = [[0, 0], [4, 0], [4, 2], [2, 2], [2, 4], [0, 4]];
      const triangles = triangulatePolygon2D(l)!;
      let area = 0;
      for (let i = 0; i < triangles.length; i += 3) { const a = l[triangles[i]!]!; const b = l[triangles[i + 1]!]!; const c = l[triangles[i + 2]!]!; area += ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2; }
      near(area, 12, 1e-9, "the triangles of an L-shaped polygon add up to its area");
    }
  },
  {
    name: "A rib across a cup stands on the floor and runs to both walls: the added volume is the wall's length, thickness and height",
    run: () => {
      const body = cup();
      const before = volumeOf(body);
      const joined = addWebs(body, [[[10, 15, 12], [30, 15, 12]]], spec());
      assert(joined.ok, `rib joins: ${joined.ok ? "" : joined.message}`);
      if (!joined.ok) return;
      assert(isClosedAndOriented(joined.indices), "the ribbed cup is closed and consistently wound");
      assert(solidMetrics(joined.positionsMm, joined.indices).outward, "and winds outward");
      near(volumeOf(joined) - before, 36 * 1.5 * 10, 0.5, "36 mm (wall to wall) x 1.5 mm x 10 mm (floor to the profile) was added");
      const size = solidMetrics(joined.positionsMm, joined.indices).sizeMm;
      near(size[0], 40, 1e-6, "the outside of the cup did not grow"); near(size[2], 20, 1e-6, "or its height");
      assert(!joined.flip, "the side that meets the floor was chosen: for this profile it is the unflipped one (the profile normal crossed with its direction)");
      assert(nearestVertex(joined, [10, 15.75, 12]) < 1e-6 && nearestVertex(joined, [2, 14.25, 12]) < 0.01, "the rib's top edge is at the profile and reaches the wall");
      const bare = addWebs(body, [[[10, 15, 12], [30, 15, 12]]], spec({ extendToBody: false }));
      assert(bare.ok, "a rib with the ends as drawn");
      if (bare.ok) near(volumeOf(bare) - before, 20 * 1.5 * 10, 0.5, "without extending, it is only as long as it was drawn");
      const oneSide = addWebs(body, [[[10, 15, 12], [30, 15, 12]]], spec({ direction: "one-side" }));
      assert(oneSide.ok, "one-sided rib");
      if (oneSide.ok) {
        near(volumeOf(oneSide) - before, 36 * 1.5 * 10, 0.5, "one side gives the same volume");
        assert(nearestVertex(oneSide, [10, 16.5, 12]) < 1e-6 && nearestVertex(oneSide, [10, 13.5, 12]) > 1, "and grows only to one side of the sketch plane");
      }
    }
  },
  {
    name: "A bent profile is carried on along its end tangents and straight down to the floor; two chains do not double-count where they overlap",
    run: () => {
      const body = cup();
      const before = volumeOf(body);
      const vee = addWebs(body, [[[10, 15, 12], [20, 15, 8], [30, 15, 12]]], spec());
      assert(vee.ok, `V-shaped rib: ${vee.ok ? "" : vee.message}`);
      if (vee.ok) near(volumeOf(vee) - before, 345.6 * 1.5, 1.5, "the area between the slanted profile and the floor, 345.6 mm², times the thickness");
      const two = addWebs(body, [[[10, 15, 12], [30, 15, 12]], [[5, 15, 6], [15, 15, 6]]], spec());
      assert(two.ok, `two chains: ${two.ok ? "" : two.message}`);
      if (two.ok) near(volumeOf(two) - before, 36 * 1.5 * 10, 0.6, "the lower rib lies inside the higher one, so the web adds nothing more");
      const stacked = addWebs(body, [[[10, 15, 8], [30, 15, 8]], [[10, 15, 14], [30, 15, 14]]], spec());
      assert(stacked.ok, "two ribs at different heights");
      if (stacked.ok) near(volumeOf(stacked) - before, 36 * 1.5 * 12, 0.6, "the union of ribs 6 and 12 mm tall is the taller one");
    }
  },
  {
    name: "A rib that meets nothing, an explicit side with no body on it, a closed or one-point profile, are refused with a reason",
    run: () => {
      const body = cup();
      const far = webSlab(body, [[10, 150, 12], [30, 150, 12]], spec());
      assert(!far.ok && far.message.includes("does not reach the body"), "a profile beside the cup has nothing underneath");
      const wrongSide = webSlab(body, [[10, 15, 12], [30, 15, 12]], spec({ flip: true }));
      assert(!wrongSide.ok && wrongSide.message.includes("does not reach the body"), "growing towards the open top finds no body there");
      const chosen = webSlab(body, [[10, 15, 12], [30, 15, 12]], spec({ flip: false }));
      assert(chosen.ok, "the explicit side that meets the floor works");
      assert(!webSlab(body, [[10, 15, 12], [30, 15, 12], [10, 15, 12]], spec()).ok, "a closed profile is not a rib");
      assert(!webSlab(body, [[10, 15, 12]], spec()).ok, "one point is not a profile");
      assert(!webSlab(body, [[10, 15, 12], [30, 15, 12]], spec({ normal: [0, 0, 0] })).ok, "no sketch plane");
      const tilted = webSlab(body, [[10, 15, 12], [30, 15, 12]], spec({ normal: [0, 0, 1] }));
      assert(!tilted.ok || tilted.flip !== undefined, "a profile that lies along the plane normal is handled without a crash");
      const analysis = analyzeFaces(cup());
      assert(typeof analysis !== "string", "the cup itself is analysable");
    }
  }
];

export const bodyWebTimelineTests: readonly TestCase[] = [
  {
    name: "A rib drawn as an open line on a second sketch joins the shelled block through the timeline, follows a thicker wall, and is flagged when its curve is gone",
    run: async () => {
      const { project: block } = await blockProject();
      let project = await addAndReplay(block, editStep("shell-web", "shell", { kind: "shell", thicknessMm: 2, side: "inside", openFaces: [face([0, 0, 20], [0, 0, 1])] }, 2));
      near(volumeOfBody(project), 24000 - 36 * 26 * 18, 1e-3, "the block is a cup first");
      project = applyOp(project, { kind: "new-design-sketch", plane: "datum:xz" });
      project = applyOp(project, { kind: "add-sketch-entity", entity: { id: "entity:rib-line", kind: "line", start: [-10, 12], end: [10, 12], construction: false } });
      project = applyOp(project, { kind: "commit-design-sketch", featureId: "feature:sketch-2", name: "Rib sketch" });
      const sketch = designOf(project).features.find((feature) => feature.id === "feature:sketch-2") as DesignSketchFeature;
      assert(openCurveIds(sketch.sketch).join() === "entity:rib-line", "the sketch's one open curve is offered as a rib profile");
      const rib: DesignSolidFeature = { ...editStep("rib-1", "web", { kind: "web", thicknessMm: 1.5, direction: "symmetric", entityIds: ["entity:rib-line"], extendToBody: true }, 1.5), sketchFeatureId: "feature:sketch-2" };
      assert(validSolidFeaturePayload(rib), "a web step is a valid feature");
      project = await addAndReplay(project, rib);
      const flagged = designOf(project).features.find((feature) => feature.id === rib.id);
      assert(flagged !== undefined && flagged.health === undefined, `the rib applied: ${flagged?.health?.message ?? ""}`);
      near(volumeOfBody(project), 24000 - 36 * 26 * 18 + 36 * 1.5 * 10, 0.6, "the rib added 36 x 1.5 x 10 mm³ running wall to wall from the floor up to the profile");
      assert(typeof analyzeFaces(bodyOf(project)) !== "string", "the ribbed cup is a closed outward solid");
      // A thicker wall moves the walls and the floor; the rib is found against the new body.
      const shellStep = designOf(project).features.find((feature) => feature.id === "feature:shell-web") as DesignSolidFeature;
      const thicker: DesignSolidFeature = { ...shellStep, valueMm: 3, bodyEdit: { kind: "shell", thicknessMm: 3, side: "inside", openFaces: [face([0, 0, 20], [0, 0, 1])] } };
      project = applyOp(project, { kind: "update-design-solid", feature: thicker, body: bodyOf(project) });
      project = await replayed(project);
      near(volumeOfBody(project), 24000 - 34 * 24 * 17 + 34 * 1.5 * 9, 0.6, "with 3 mm walls the rib is 34 mm long and 9 mm tall");
      assert(designOf(project).features.every((feature) => feature.health === undefined), "nothing is flagged after the base edit");
      // Moving the profile off the body makes the step fail visibly.
      const lostCurve: DesignSolidFeature = { ...rib, bodyEdit: { kind: "web", thicknessMm: 1.5, direction: "symmetric", entityIds: ["entity:gone"], extendToBody: true } };
      const broken = applyOp(project, { kind: "update-design-solid", feature: lostCurve, body: bodyOf(project) });
      const after = await replayed(broken);
      const health = designOf(after).features.find((feature) => feature.id === rib.id);
      assert(health?.health?.message.includes("no longer in its sketch") === true, "a rib whose curve was deleted says so");
      // Suppressing the rib's sketch drops the rib from the body.
      const off = applyOp(project, { kind: "set-design-feature-suppressed", featureId: "feature:sketch-2", suppressed: true });
      near(volumeOfBody(await replayed(off)), 24000 - 34 * 24 * 17, 1e-3, "suppressing the rib's sketch removes the rib");
    }
  }
];
