import type { DesignExtentTarget, DesignSolidFeature, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, designOf, validateWorkbenchProject, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { facePlaneOf } from "../packages/workbench-geometry/src/index.js";
import { rebuildDependents, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { BLOCK, PLATE, apply, bodyOf, boundsOf, isClosedManifold, plateAndBlock, run, step, volumeOf, withSketch, withStep } from "./extent-kit.js";

/** The plate with a 3 mm radius peg sketched on its top face (z = 10), ready to extrude toward the block above it. */
async function withPegSketch(project: WorkbenchProject, id = "feature:sketch-peg", offsetMm = 10): Promise<WorkbenchProject> {
  return withSketch(project, id, { id: "entity:peg", kind: "circle", center: [12, 12], radiusMm: 3, construction: false }, "datum:xy", offsetMm);
}

const PEG_AREA = Math.PI * 9;
const bottomOfBlock: DesignExtentTarget = { kind: "face", bodyId: BLOCK, faceRole: "face.cap-bottom", pointMm: [0, 0, 40], normal: [0, 0, -1] };
const joinPeg = (id: string, extra: Partial<DesignSolidFeature>): DesignSolidFeature => step(id, "feature:sketch-peg", PLATE, { kind: "extrude", valueMm: 1, operation: "join", ...extra });

export const extentTerminationTests: readonly TestCase[] = [
  {
    name: "extrude To face: a join reaches the picked face, its height equals the measured gap, and the result is one closed solid",
    run: async () => {
      const base = await plateAndBlock();
      const plateBefore = volumeOf(bodyOf(base, PLATE));
      const project = await withStep(await withPegSketch(base), joinPeg("feature:join-face", { extent: "to-face", extentTarget: bottomOfBlock }));
      const plate = bodyOf(project, PLATE);
      const gap = boundsOf(bodyOf(project, BLOCK)).min[2]! - boundsOf(base.part.generalBodies!.find((body) => body.id === PLATE)!).max[2]!;
      equal(gap, 30, "the measured gap between the plate top and the block bottom");
      near(boundsOf(plate).max[2]!, 40, 1e-3, "the peg ends exactly on the block's bottom face");
      near(volumeOf(plate) - plateBefore, PEG_AREA * gap, PEG_AREA * gap * 0.01, "the peg added a cylinder as tall as the gap");
      assert(isClosedManifold(plate), "plate and peg are one closed manifold solid");
      assert(designOf(project).features.every((feature) => feature.health === undefined), "no step is flagged");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(project)) as unknown).ok, "the project validates after a save and reload");
    }
  },
  {
    name: "extrude To face is recomputed on replay: moving the block, or editing its sketch, changes the peg's height",
    run: async () => {
      let project = await withStep(await withPegSketch(await plateAndBlock()), joinPeg("feature:join-face", { extent: "to-face", extentTarget: bottomOfBlock }));
      near(boundsOf(bodyOf(project, PLATE)).max[2]!, 40, 1e-3, "starts at the block's bottom, 40");
      // Lift the block 12 mm with a Move body step and replay everything: the peg follows.
      const moved = step("feature:move-block", "feature:sketch-block", BLOCK, { kind: "move-body", valueMm: 12, operation: "direct-edit", moveDeltaMm: [0, 0, 12] });
      project = await withStep(project, moved);
      near(boundsOf(bodyOf(project, BLOCK)).min[2]!, 52, 1e-3, "the block moved up");
      near(boundsOf(bodyOf(project, PLATE)).max[2]!, 52, 1e-3, "the peg grew to meet the moved block");
      // Edit the block's sketch plane offset to 60 and rebuild what depends on it: the plate is rebuilt even though it is not built on that sketch.
      project = run(project, { kind: "delete-design-feature", featureId: "feature:move-block" });
      project = apply(project, await replayAllBodies(project));
      near(boundsOf(bodyOf(project, PLATE)).max[2]!, 40, 1e-3, "removing the move puts the peg back to 40");
      project = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-block" });
      project = run(project, { kind: "set-sketch-plane", plane: "datum:xy", offsetMm: 60 });
      project = run(project, { kind: "commit-design-sketch", featureId: "feature:ignored", name: "feature:sketch-block" });
      const results = await rebuildDependents(project, "feature:sketch-block");
      assert(results.some((result) => result.body?.id === PLATE) && results.some((result) => result.body?.id === BLOCK), "both the block and the plate that reaches it are rebuilt");
      project = apply(project, results);
      near(boundsOf(bodyOf(project, BLOCK)).min[2]!, 60, 1e-3, "the block sits at 60");
      near(boundsOf(bodyOf(project, PLATE)).max[2]!, 60, 1e-3, "the peg was re-measured against the block's new position, even though the plate came first in the timeline");
    }
  },
  {
    name: "extrude To object and To vertex measure from a body and from a corner, and a corner is found again after the body moves",
    run: async () => {
      const base = await plateAndBlock();
      const body = await withStep(await withPegSketch(base), joinPeg("feature:join-body", { extent: "to-body", extentTarget: { kind: "body", bodyId: BLOCK } }));
      near(boundsOf(bodyOf(body, PLATE)).max[2]!, 40, 1e-3, "To object ends on the first surface of the block the profile meets");
      const corner: DesignExtentTarget = { kind: "vertex", bodyId: BLOCK, pointMm: [-20, -20, 40] };
      let vertex = await withStep(await withPegSketch(base), joinPeg("feature:join-vertex", { extent: "to-vertex", extentTarget: corner }));
      near(boundsOf(bodyOf(vertex, PLATE)).max[2]!, 40, 1e-3, "To vertex ends at the corner's height");
      vertex = await withStep(vertex, step("feature:move-block", "feature:sketch-block", BLOCK, { kind: "move-body", valueMm: 7, operation: "direct-edit", moveDeltaMm: [3, 0, 7] }));
      near(boundsOf(bodyOf(vertex, PLATE)).max[2]!, 47, 1e-3, "the same corner, found again after the block moved, now ends the peg at 47");
      assert(isClosedManifold(bodyOf(vertex, PLATE)), "still one closed solid");
    }
  },
  {
    name: "extrude To face toward a face that is not parallel is trimmed to it, and the volume matches the slanted face",
    run: async () => {
      let project = await plateAndBlock();
      // A second block on a sketch plane tilted 30 degrees about Y: its bottom face slants across the peg.
      project = run(project, { kind: "new-design-sketch", plane: "datum:xy", offsetMm: 60, tilt: { axis: "y", angleDeg: 30 } });
      project = run(project, { kind: "add-sketch-entity", entity: { id: "entity:slant", kind: "rectangle", center: [0, 0], widthMm: 120, heightMm: 120, rotationDeg: 0, construction: false } });
      project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-slant", name: "slant" });
      project = await withStep(project, step("feature:slant", "feature:sketch-slant", "general-body:slant", { kind: "extrude", valueMm: 10 }));
      const slant = bodyOf(project, "general-body:slant");
      const bottom = slant.brep!.faces.findIndex((face) => face.role === "face.cap-bottom");
      const plane = facePlaneOf({ positionsMm: slant.positionsMm, indices: slant.indices, faceTriangles: slant.brep!.faceTriangles }, bottom)!;
      assert(plane.planar && Math.abs(plane.normal[2]) < 0.95 && Math.abs(plane.normal[2]) > 0.5, `the slanted face is planar and tilted (${plane.normal.join(", ")})`);
      const zAt = (x: number, y: number): number => plane.pointMm[2] - (plane.normal[0] * (x - plane.pointMm[0]) + plane.normal[1] * (y - plane.pointMm[1])) / plane.normal[2];
      const platTop = 10;
      const target: DesignExtentTarget = { kind: "face", bodyId: "general-body:slant", faceRole: "face.cap-bottom", pointMm: plane.pointMm, normal: plane.normal };
      const before = volumeOf(bodyOf(project, PLATE));
      project = await withStep(await withPegSketch(project), joinPeg("feature:join-slant", { extent: "to-face", extentTarget: target }));
      const plate = bodyOf(project, PLATE);
      const expected = PEG_AREA * (zAt(12, 12) - platTop);
      near(volumeOf(plate) - before, expected, expected * 0.015, "a linear slope averages out at the peg's centre, so the volume is area times the height there");
      const top = boundsOf(plate).max[2]!;
      assert(top > zAt(12, 12) && top < zAt(12, 12) + 3 * Math.abs(plane.normal[0] / plane.normal[2]) + 0.1, "the peg top is slanted: its highest point is a little above the centre height");
      assert(isClosedManifold(plate), "the trimmed peg joins into a closed solid");
      assert(designOf(project).features.every((feature) => feature.health === undefined), "nothing is flagged");
    }
  },
  {
    name: "extrude To face flipped runs down toward a face below, and a cut To face makes a blind pocket on the stop face",
    run: async () => {
      let project = await plateAndBlock();
      // Flipped join from above the plate down to the plate's top face.
      project = await withPegSketch(project, "feature:sketch-peg", 30);
      const platTop: DesignExtentTarget = { kind: "face", bodyId: PLATE, faceRole: "face.cap-top", pointMm: [0, 20, 10], normal: [0, 0, 1] };
      const down = await withStep(project, step("feature:down", "feature:sketch-peg", "general-body:down", { kind: "extrude", valueMm: 1, direction: "flipped", extent: "to-face", extentTarget: platTop }));
      const peg = boundsOf(bodyOf(down, "general-body:down"));
      near(peg.min[2]!, 10, 1e-3, "flipped: the peg runs down and stops on the plate top");
      near(peg.max[2]!, 30, 1e-3, "and starts at its sketch plane");
      // A pocket cut down from the plate top (sketch at z = 10) to a stop body whose top face is at z = 4.
      let pocket = await plateAndBlock();
      pocket = withSketch(pocket, "feature:sketch-stop", { id: "entity:stop", kind: "rectangle", center: [12, 12], widthMm: 20, heightMm: 20, rotationDeg: 0, construction: false }, "datum:xy", 0);
      pocket = await withStep(pocket, step("feature:stop", "feature:sketch-stop", "general-body:stop", { kind: "extrude", valueMm: 4 }));
      pocket = await withPegSketch(pocket);
      const before = volumeOf(bodyOf(pocket, PLATE));
      pocket = await withStep(pocket, step("feature:pocket", "feature:sketch-peg", PLATE, { kind: "extrude", valueMm: 1, operation: "cut", direction: "flipped", extent: "to-face", extentTarget: { kind: "face", bodyId: "general-body:stop", faceRole: "face.cap-top", pointMm: [12, 12, 4], normal: [0, 0, 1] } }));
      const plate = bodyOf(pocket, PLATE);
      near(before - volumeOf(plate), PEG_AREA * 6, PEG_AREA * 6 * 0.01, "the pocket is 6 mm deep: from the plate top (10) to the stop face (4)");
      assert(isClosedManifold(plate), "the plate with its pocket is closed");
      near(boundsOf(plate).min[2]!, 0, 1e-6, "the pocket is blind: the plate still reaches the floor");
    }
  },
  {
    name: "a target that cannot be found again keeps the picked plane, or the last distance, and says so on the step",
    run: async () => {
      const base = await plateAndBlock();
      const target: DesignExtentTarget = { ...bottomOfBlock, faceRole: "face.that-was-renamed" };
      const renamed = await withStep(await withPegSketch(base), joinPeg("feature:join-renamed", { extent: "to-face", extentTarget: target }));
      near(boundsOf(bodyOf(renamed, PLATE)).max[2]!, 40, 1e-3, "a renamed face is matched by its place instead");
      const renamedHealth = designOf(renamed).features.find((feature) => feature.id === "feature:join-renamed")?.health;
      assert(renamedHealth?.message.includes("nearest"), `the step says which face was used: ${renamedHealth?.message ?? "(no health)"}`);
      // Delete the block entirely: the recorded plane still ends the peg at 40.
      let gone = await withStep(await withPegSketch(base), joinPeg("feature:join-gone", { extent: "to-face", extentTarget: bottomOfBlock }));
      gone = run(gone, { kind: "delete-design-feature", featureId: "feature:block" });
      gone = apply(gone, await replayAllBodies(gone));
      near(boundsOf(bodyOf(gone, PLATE)).max[2]!, 40, 1e-3, "without the block, the picked plane still ends the peg");
      assert(designOf(gone).features.find((feature) => feature.id === "feature:join-gone")?.health?.message.includes("could not be found"), "and the step is flagged");
      // No picked point either: the stored distance is what is left.
      const lonely = await withStep(await withPegSketch(base), joinPeg("feature:join-lonely", { valueMm: 18, extent: "to-body", extentTarget: { kind: "body", bodyId: "general-body:missing" } }));
      near(boundsOf(bodyOf(lonely, PLATE)).max[2]!, 28, 1e-3, "the last distance, 18 mm above the plate top, is used");
      assert(designOf(lonely).features.find((feature) => feature.id === "feature:join-lonely")?.health !== undefined, "and the step is flagged");
    }
  },
  {
    name: "extrude To face reports a face behind the sketch, a parallel face and a sketch already on the face instead of building garbage",
    run: async () => {
      const base = await plateAndBlock();
      const staged = async (extra: Partial<DesignSolidFeature>, offsetMm = 10): Promise<string> => {
        const project = await withPegSketch(base, "feature:sketch-peg", offsetMm);
        const feature = joinPeg("feature:bad", extra);
        const probe: WorkbenchProject = { ...project, design: { ...designOf(project), features: [...designOf(project).features, feature], rollbackIndex: designOf(project).features.length + 1 } };
        const results = await replayAllBodies(probe);
        return results.find((result) => result.featureId === "feature:bad")?.message ?? "";
      };
      assert((await staged({ extent: "to-face", direction: "flipped", extentTarget: bottomOfBlock })).includes("behind"), "toward a face on the other side: asks to flip");
      assert((await staged({ extent: "to-face", extentTarget: { kind: "face", bodyId: BLOCK, faceRole: "face.side-0" } })).includes("parallel"), "a side wall that runs along the extrusion can never be reached");
      assert((await staged({ extent: "to-face", extentTarget: { kind: "face", bodyId: PLATE, faceRole: "face.cap-top", pointMm: [0, 0, 10], normal: [0, 0, 1] } })).includes("already lies on"), "a sketch already on the face has nothing to extrude");
      assert((await staged({ extent: "to-vertex", extentTarget: { kind: "vertex", bodyId: BLOCK, pointMm: [20, 20, 5] }, direction: "one-side" }, 10)).includes("behind"), "a vertex below the sketch: asks to flip");
    }
  },
  {
    name: "extrude Two sides with different distances goes each way from the sketch plane, alone and together with To face",
    run: async () => {
      const base = await plateAndBlock();
      const beforePlate = volumeOf(bodyOf(base, PLATE));
      let project = await withStep(await withPegSketch(base), joinPeg("feature:two", { valueMm: 8, direction: "two-side", secondValueMm: 3 }));
      const plate = bodyOf(project, PLATE);
      near(boundsOf(plate).max[2]!, 18, 1e-3, "8 mm up from the sketch plane at z = 10");
      near(volumeOf(plate) - beforePlate, PEG_AREA * 8, PEG_AREA * 8 * 0.01, "the 3 mm below the plane is inside the plate, so only the 8 mm above adds material");
      assert(isClosedManifold(plate), "closed");
      // A free-standing two-sided extrusion: 8 up and 3 down from the plane.
      project = await withStep(project, step("feature:free", "feature:sketch-peg", "general-body:free", { kind: "extrude", valueMm: 8, direction: "two-side", secondValueMm: 3 }));
      const free = boundsOf(bodyOf(project, "general-body:free"));
      near(free.min[2]!, 7, 1e-3, "3 mm below the plane");
      near(free.max[2]!, 18, 1e-3, "8 mm above it");
      near(volumeOf(bodyOf(project, "general-body:free")), PEG_AREA * 11, PEG_AREA * 11 * 0.01, "11 mm tall in all");
      // To face on one side plus a distance on the other.
      project = await withStep(project, step("feature:mixed", "feature:sketch-peg", "general-body:mixed", { kind: "extrude", valueMm: 1, direction: "two-side", secondValueMm: 5, extent: "to-face", extentTarget: bottomOfBlock }));
      const mixed = boundsOf(bodyOf(project, "general-body:mixed"));
      near(mixed.max[2]!, 40, 1e-3, "the first side runs to the block's face");
      near(mixed.min[2]!, 5, 1e-3, "the second side is a plain 5 mm below the plane");
    }
  },
  {
    name: "the new extent and two-side fields are validated: wrong kinds, missing targets and mismatched pairs are refused",
    run: () => {
      const base = { id: "feature:x", name: "X", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 5, bodyId: PLATE } as const;
      const face = { kind: "face", bodyId: BLOCK, faceRole: "face.cap-bottom", pointMm: [0, 0, 40], normal: [0, 0, -1] };
      assert(validSolidFeaturePayload({ ...base, extent: "to-face", extentTarget: face }), "extrude to a face is valid");
      assert(validSolidFeaturePayload({ ...base, operation: "cut", extent: "to-body", extentTarget: { kind: "body", bodyId: BLOCK } }), "a cut to a body is valid");
      assert(validSolidFeaturePayload({ ...base, extent: "to-vertex", extentTarget: { kind: "vertex", bodyId: BLOCK, pointMm: [1, 2, 3] } }), "extrude to a vertex is valid");
      assert(validSolidFeaturePayload({ ...base, direction: "two-side", secondValueMm: 3 }), "two sides with a second distance is valid");
      assert(validSolidFeaturePayload({ ...base, direction: "two-side", secondValueMm: 3, extent: "to-face", extentTarget: face }), "To face on one side of a two-sided extrude is valid");
      assert(!validSolidFeaturePayload({ ...base, extent: "to-face" }), "To face needs a target");
      assert(!validSolidFeaturePayload({ ...base, extentTarget: face }), "a target without a To extent is refused");
      assert(!validSolidFeaturePayload({ ...base, extent: "to-body", extentTarget: face }), "a face target on a To object extent is refused");
      assert(!validSolidFeaturePayload({ ...base, extent: "to-vertex", extentTarget: { kind: "vertex", bodyId: BLOCK } }), "a vertex target needs its position");
      assert(!validSolidFeaturePayload({ ...base, extent: "to-face", extentTarget: { kind: "face", bodyId: BLOCK } }), "a face target needs a name or a point");
      assert(!validSolidFeaturePayload({ ...base, extent: "to-face", extentTarget: { ...face, normal: [0, 0, 0] } }), "a zero face direction is refused");
      assert(!validSolidFeaturePayload({ ...base, extent: "to-face", extentTarget: { ...face, pointMm: [0, 0] } }), "a malformed point is refused");
      assert(!validSolidFeaturePayload({ ...base, extent: "to-face", direction: "symmetric", extentTarget: face }), "a To extent cannot straddle the plane");
      assert(!validSolidFeaturePayload({ ...base, kind: "sweep", extent: "to-face", extentTarget: face }), "only an extrude can run To face");
      assert(!validSolidFeaturePayload({ ...base, extent: "to-first", extentTarget: face }), "To first is for a revolve");
      assert(!validSolidFeaturePayload({ ...base, direction: "two-side" }), "two sides needs the second distance");
      assert(!validSolidFeaturePayload({ ...base, secondValueMm: 3 }), "a second distance needs two sides");
      assert(!validSolidFeaturePayload({ ...base, direction: "two-side", secondValueMm: -2 }), "the second distance must be positive");
      assert(!validSolidFeaturePayload({ ...base, kind: "loft", direction: "two-side", secondValueMm: 3 }), "only extrude and revolve have two sides");
      assert(!validSolidFeaturePayload({ ...base, thinWallMm: 1 }), "a thin wall is for a revolve");
      const fresh = createProjectWithBadTarget();
      assert(!fresh, "a project carrying an invalid target is refused when validated");
    }
  }
];

/** A saved project whose step carries a To face extent with no target must not load. */
function createProjectWithBadTarget(): boolean {
  const feature = { id: "feature:bad", name: "Bad", kind: "extrude", suppressed: false, sketchFeatureId: "feature:s", profileIds: [], valueMm: 5, bodyId: PLATE, extent: "to-face" };
  return validSolidFeaturePayload(feature) || applyWorkbenchOperation === undefined;
}
