import type { DesignSolidFeature, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { DEFAULT_REACH, buildReach, extentChoices, faceChoices, reachBodyOf, vertexChoices, type ReachSettings } from "../apps/studio-web/src/reach-settings.js";
import { reachTargetFromClick, vertexPickGuides } from "../apps/studio-web/src/reach-pick.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { BLOCK, PLATE, bodyOf, boundsOf, isClosedManifold, plateAndBlock, step, volumeOf, withSketch, withStep } from "./extent-kit.js";

const settings = (change: Partial<ReachSettings>): ReachSettings => ({ ...DEFAULT_REACH, ...change });

async function withPeg(): Promise<WorkbenchProject> {
  return withSketch(await plateAndBlock(), "feature:sketch-peg", { id: "entity:peg", kind: "circle", center: [12, 12], radiusMm: 3, construction: false }, "datum:xy", 10);
}

/** What the create-solid palette sends for these settings, built into a join on the plate and replayed through the real timeline. */
async function joinWith(project: WorkbenchProject, change: Partial<ReachSettings>): Promise<{ readonly project: WorkbenchProject; readonly feature: DesignSolidFeature }> {
  const bodies = project.part.generalBodies ?? [];
  const reach = buildReach("extrude", settings(change), 5, bodies, null);
  assert(reach.ok, `the settings are accepted: ${reach.ok ? "" : reach.message}`);
  if (!reach.ok) throw new Error("unreachable");
  const feature = step("feature:palette", "feature:sketch-peg", PLATE, { kind: "extrude", valueMm: 5, operation: "join", ...(reach.direction === "one-side" ? {} : { direction: reach.direction }), ...reach.params });
  return { project: await withStep(project, feature), feature };
}

export const reachUiTests: readonly TestCase[] = [
  {
    name: "the create-solid palette's To face, To object and To vertex settings build steps that replay to the right height",
    run: async () => {
      const base = await withPeg();
      const block = bodyOf(base, BLOCK);
      const faces = faceChoices(block);
      const bottom = faces.find((face) => face.role === "face.cap-bottom");
      assert(bottom?.label.includes("faces -Z") && bottom.label.includes("z = 40.00 mm"), `a face is described by where it lies: ${bottom?.label ?? "(none)"}`);
      assert(faces.every((face) => face.planar), "every face of a block is flat");
      const toFace = await joinWith(base, { extent: "to-face", targetBodyId: BLOCK, faceRole: "face.cap-bottom" });
      near(boundsOf(bodyOf(toFace.project, PLATE)).max[2]!, 40, 1e-3, "To face: the peg ends on the picked face");
      equal(toFace.feature.extentTarget?.faceRole, "face.cap-bottom", "the step stores the face name");
      assert(toFace.feature.extentTarget?.normal?.[2] === -1, "and the face's direction as the fallback");
      const toBody = await joinWith(base, { extent: "to-body", targetBodyId: BLOCK });
      near(boundsOf(bodyOf(toBody.project, PLATE)).max[2]!, 40, 1e-3, "To object: ends on the first surface of the solid");
      const corners = vertexChoices(block);
      equal(corners.length, 8, "a block lists 8 corner vertices");
      const upper = corners.find((corner) => corner.pointMm[2] === 50);
      assert(upper !== undefined && upper.label.includes("50.00"), "each vertex is listed by its position");
      const toVertex = await joinWith(base, { extent: "to-vertex", targetBodyId: BLOCK, vertexIndex: String(upper!.index) });
      near(boundsOf(bodyOf(toVertex.project, PLATE)).max[2]!, 50, 1e-3, "To vertex: ends at the height of the picked corner");
      assert(isClosedManifold(bodyOf(toVertex.project, PLATE)), "and stays one closed solid");
      // The selected solid is the default target when none is chosen.
      equal(reachBodyOf(base.part.generalBodies ?? [], "", BLOCK)?.id, BLOCK, "the selected solid is the default target");
      equal(reachBodyOf(base.part.generalBodies ?? [], "", null)?.id, BLOCK, "else the newest");
    }
  },
  {
    name: "the palette's two-side, flipped and thin-wall settings are turned into step fields, and bad settings are refused with a reason",
    run: async () => {
      const bodies = (await plateAndBlock()).part.generalBodies ?? [];
      const two = buildReach("extrude", settings({ direction: "two-side", second: "4" }), 6, bodies, null);
      assert(two.ok && two.direction === "two-side" && two.params.secondValueMm === 4, "two sides carry the second distance");
      assert(!buildReach("extrude", settings({ direction: "two-side", second: "0" }), 6, bodies, null).ok, "a zero second distance is refused");
      assert(!buildReach("revolve", settings({ direction: "two-side", second: "200" }), 200, bodies, null).ok, "two angles past a full turn are refused");
      const thin = buildReach("revolve", settings({ thin: true, thinWall: "1.5", thinSide: "center" }), 360, bodies, null);
      assert(thin.ok && thin.params.thinWallMm === 1.5 && thin.params.thinSide === "center", "a thin wall carries its thickness and side");
      assert(!buildReach("revolve", settings({ thin: true, thinWall: "-1" }), 360, bodies, null).ok, "a negative wall is refused");
      const noThin = buildReach("extrude", settings({ thin: true }), 5, bodies, null);
      assert(noThin.ok && noThin.params.thinWallMm === undefined, "an extrusion has no thin wall");
      const flipped = buildReach("extrude", settings({ direction: "flipped" }), 5, bodies, null);
      assert(flipped.ok && flipped.direction === "flipped" && flipped.params.extent === undefined, "flipped needs no extra fields");
      const symmetricTo = buildReach("extrude", settings({ direction: "symmetric", extent: "to-body" }), 5, bodies, null);
      assert(symmetricTo.ok && symmetricTo.direction === "one-side", "a To extent cannot be symmetric, so it runs one way");
      const stale = buildReach("revolve", settings({ extent: "to-face" }), 90, bodies, null);
      assert(stale.ok && stale.params.extent === undefined, "an extent left over from an extrude counts as an angle on a revolve");
      const first = buildReach("revolve", settings({ extent: "to-first", faceRole: "face.cap-bottom", targetBodyId: BLOCK }), 90, bodies, null);
      assert(first.ok && first.params.extent === "to-first" && first.params.extentTarget?.kind === "face", "a revolve To first face carries a face target");
      assert(!buildReach("extrude", settings({ extent: "to-body" }), 5, [], null).ok, "with no solid there is nothing to reach");
      assert(extentChoices("extrude", true).some((choice) => choice.value === "through-all") && !extentChoices("extrude", false).some((choice) => choice.value === "through-all"), "Through all is offered for a cut only");
      assert(extentChoices("revolve", false).map((choice) => choice.value).join() === "distance,to-first,to-last", "a revolve offers an angle, To first and To last");
    }
  },
  {
    name: "a click in the 3D view becomes a face, solid or corner target, and the corners are marked while picking a vertex",
    run: async () => {
      const base = await withPeg();
      const bodies = base.part.generalBodies ?? [];
      const block = bodyOf(base, BLOCK);
      const bottomIndex = block.brep!.faces.findIndex((face) => face.role === "face.cap-bottom");
      const face = reachTargetFromClick("face", { pointMm: [3, 4, 40], semanticId: BLOCK, faceIndex: bottomIndex, normalMm: [0, 0, -1] }, bodies);
      assert(face.ok && face.target.kind === "face" && face.target.faceRole === "face.cap-bottom", "a click on a named face picks it");
      if (face.ok) assert(face.target.normal?.[2] === -1 && face.target.pointMm !== undefined && Math.abs(face.target.pointMm[2] - 40) < 1e-6, "with the face's plane as the fallback");
      assert(!reachTargetFromClick("face", { pointMm: [0, 0, 0], semanticId: null }, bodies).ok, "a click on empty space picks no face");
      assert(!reachTargetFromClick("face", { pointMm: [0, 0, 40], semanticId: BLOCK, faceIndex: null }, bodies).ok, "a click on a body without a face index picks no face");
      const solid = reachTargetFromClick("body", { pointMm: [1, 2, 3], semanticId: BLOCK }, bodies);
      assert(solid.ok && solid.target.kind === "body" && solid.target.bodyId === BLOCK, "a click on a solid picks the solid");
      const corner = reachTargetFromClick("vertex", { pointMm: [19, 18, 41], semanticId: BLOCK }, bodies);
      assert(corner.ok && corner.target.kind === "vertex" && corner.target.pointMm?.join(",") === "20,20,40", "a click near a corner picks that corner");
      const stray = reachTargetFromClick("vertex", { pointMm: [29, 19, 11], semanticId: null }, bodies);
      assert(stray.ok && stray.target.kind === "vertex" && stray.target.bodyId === PLATE && stray.target.pointMm?.join(",") === "30,20,10", "a click on empty space takes the nearest corner of any solid");
      const guides = vertexPickGuides(bodies);
      equal(guides.length, (8 + 8) * 3, "three little cross strokes mark each of the 16 corners of the plate and block");
      // The picked corner drives a real replay.
      if (corner.ok) {
        const reach = await withStep(base, step("feature:picked", "feature:sketch-peg", PLATE, { kind: "extrude", valueMm: 1, operation: "join", extent: "to-vertex", extentTarget: corner.target }));
        near(boundsOf(bodyOf(reach, PLATE)).max[2]!, 40, 1e-3, "the peg ends at the picked corner's height");
        near(volumeOf(bodyOf(reach, PLATE)) - volumeOf(bodyOf(base, PLATE)), Math.PI * 9 * 30, Math.PI * 9 * 30 * 0.01, "as a 30 mm peg");
      }
    }
  }
];
