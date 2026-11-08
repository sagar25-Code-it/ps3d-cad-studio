import type { DesignExtentTarget, DesignSolidFeature, SketchEntity, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { createWorkbenchProject, describeFeature, designOf, validateWorkbenchProject, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { nearestMeshVertex, offsetPolygon, pickableVertices, revolveAngleToFace } from "../packages/workbench-geometry/src/index.js";
import { replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { PLATE, apply, bodyOf, boundsOf, isClosedManifold, plateAndBlock, run, step, volumeOf, withSketch, withStep } from "./extent-kit.js";

const RING = Math.PI * (20 ** 2 - 10 ** 2) * 30; // x 10..20, y 0..30 turned a full turn about the Y axis
const SPIN = "general-body:spin";

/** A project whose only sketch is a 10 x 30 rectangle standing 10 mm off the Y axis, ready to revolve. */
function spinProject(rect: SketchEntity = { id: "entity:rib", kind: "rectangle", center: [15, 15], widthMm: 10, heightMm: 30, rotationDeg: 0, construction: false }): WorkbenchProject {
  const fresh = run(createWorkbenchProject("project:test-revolve"), { kind: "new-design-sketch", plane: "datum:xy" });
  const withRect = run(fresh, { kind: "add-sketch-entity", entity: rect });
  return run(withRect, { kind: "commit-design-sketch", featureId: "feature:sketch-spin", name: "Spin sketch" });
}

const spin = (extra: Partial<DesignSolidFeature>, id = "feature:spin", bodyId = SPIN): DesignSolidFeature => step(id, "feature:sketch-spin", bodyId, { kind: "revolve", valueMm: 360, ...extra });

export const revolveTerminationTests: readonly TestCase[] = [
  {
    name: "revolve Thin wall: a full turn leaves a closed hollow shell whose volume is the wall, on each side of the outline",
    run: async () => {
      const solid = await withStep(spinProject(), spin({}));
      near(volumeOf(bodyOf(solid, SPIN)), RING, RING * 0.01, "the plain revolve is the solid ring");
      const inside = await withStep(spinProject(), spin({ thinWallMm: 2, thinSide: "inside" }));
      const hollow = bodyOf(inside, SPIN);
      const insideExpected = RING - Math.PI * (18 ** 2 - 12 ** 2) * 26;
      near(volumeOf(hollow), insideExpected, insideExpected * 0.015, "inside: the outline's 10 x 30 section loses its 6 x 26 core");
      assert(isClosedManifold(hollow), "the hollow shell is closed");
      near(boundsOf(hollow).max[0]!, 20, 1e-3, "inside: the outer skin stays where the sketch is");
      assert(volumeOf(hollow) < volumeOf(bodyOf(solid, SPIN)) * 0.6, "and it is far lighter than the solid");
      assert(hollow.brep !== undefined && hollow.brep.faces.length > 4, "the shell keeps named faces");
      const outside = bodyOf(await withStep(spinProject(), spin({ thinWallMm: 2, thinSide: "outside" })), SPIN);
      const outsideExpected = Math.PI * (22 ** 2 - 8 ** 2) * 34 - RING;
      near(volumeOf(outside), outsideExpected, outsideExpected * 0.015, "outside: the wall grows 2 mm outward from the outline");
      near(boundsOf(outside).max[0]!, 22, 1e-3, "outside: the shell reaches 2 mm past the sketch");
      assert(isClosedManifold(outside), "outside shell is closed");
      const centre = bodyOf(await withStep(spinProject(), spin({ thinWallMm: 2, thinSide: "center" })), SPIN);
      const centreExpected = Math.PI * (21 ** 2 - 9 ** 2) * 32 - Math.PI * (19 ** 2 - 11 ** 2) * 28;
      near(volumeOf(centre), centreExpected, centreExpected * 0.015, "center: 1 mm either side of the outline");
      near(boundsOf(centre).max[0]!, 21, 1e-3, "center: reaches 1 mm past the sketch");
    }
  },
  {
    name: "revolve Thin wall over part of a turn opens the ends, and a wall too thick for the profile is refused",
    run: async () => {
      const half = bodyOf(await withStep(spinProject(), spin({ valueMm: 180, thinWallMm: 2 })), SPIN);
      const expected = (RING - Math.PI * (18 ** 2 - 12 ** 2) * 26) / 2;
      near(volumeOf(half), expected, expected * 0.015, "half a turn of wall is half the wall");
      assert(isClosedManifold(half), "a half-turn shell is closed: its ends are the wall's own section");
      const b = boundsOf(half);
      near(b.min[2]!, 0, 1e-3, "starts at the sketch plane");
      near(b.max[2]!, 20, 1e-3, "and reaches the outer radius at the quarter turn");
      // A 10 mm wide profile cannot take a 6 mm wall on its inside: the two walls would meet.
      const staged = spinProject();
      const thick: WorkbenchProject = { ...staged, design: { ...designOf(staged), features: [...designOf(staged).features, spin({ thinWallMm: 6 })], rollbackIndex: designOf(staged).features.length + 1 } };
      const results = await replayAllBodies(thick);
      assert(results.find((result) => result.featureId === "feature:spin")?.message?.includes("thicker"), "a wall thicker than the profile allows is reported");
    }
  },
  {
    name: "revolve Symmetric, Two sides and flipped turn the profile either side of the sketch plane",
    run: async () => {
      const quarter = RING / 4;
      const one = boundsOf(bodyOf(await withStep(spinProject(), spin({ valueMm: 90 })), SPIN));
      near(one.min[2]!, 0, 1e-3, "one side: starts at the sketch plane");
      near(one.max[2]!, 20, 1e-3, "one side: sweeps toward +Z");
      const symmetricBody = bodyOf(await withStep(spinProject(), spin({ valueMm: 90, direction: "symmetric" })), SPIN);
      const sym = boundsOf(symmetricBody);
      near(sym.min[2]!, -20 * Math.sin(Math.PI / 4), 0.05, "symmetric: 45 degrees back");
      near(sym.max[2]!, 20 * Math.sin(Math.PI / 4), 0.05, "symmetric: 45 degrees forward");
      near(sym.max[0]!, 20, 1e-3, "symmetric: still reaches the outer radius on the sketch plane");
      near(volumeOf(symmetricBody), quarter, quarter * 0.015, "symmetric: the same volume as one side of 90 degrees");
      assert(isClosedManifold(symmetricBody), "symmetric: closed");
      const twoBody = bodyOf(await withStep(spinProject(), spin({ valueMm: 30, direction: "two-side", secondValueMm: 60 })), SPIN);
      const two = boundsOf(twoBody);
      near(two.max[2]!, 20 * Math.sin(Math.PI / 6), 0.05, "two sides: 30 degrees one way");
      near(two.min[2]!, -20 * Math.sin(Math.PI / 3), 0.05, "two sides: 60 degrees the other way");
      near(volumeOf(twoBody), quarter, quarter * 0.015, "two sides: 30 + 60 = 90 degrees of ring");
      const flipped = boundsOf(bodyOf(await withStep(spinProject(), spin({ valueMm: 90, direction: "flipped" })), SPIN));
      near(flipped.min[2]!, -20, 1e-3, "flipped: sweeps toward -Z");
      near(flipped.max[2]!, 0, 1e-3, "flipped: ends at the sketch plane");
      const over = spinProject();
      const staged: WorkbenchProject = { ...over, design: { ...designOf(over), features: [...designOf(over).features, spin({ valueMm: 200, direction: "two-side", secondValueMm: 200 })], rollbackIndex: designOf(over).features.length + 1 } };
      assert(!validateWorkbenchProject(staged).ok, "two sides adding up to more than a full turn are refused when validated");
      const thinSym = bodyOf(await withStep(spinProject(), spin({ valueMm: 90, direction: "symmetric", thinWallMm: 2 })), SPIN);
      near(boundsOf(thinSym).min[2]!, -20 * Math.sin(Math.PI / 4), 0.05, "a thin wall can be symmetric too");
      assert(isClosedManifold(thinSym), "and stays closed");
    }
  },
  {
    name: "revolve To first / To last runs the profile until it meets the picked face, measured from the face's current place",
    run: async () => {
      // A block standing against the plane x = 0, at z 10..20 and y 0..10: turning the profile 90 degrees lays it against the block's x = 0 face.
      const withBlock = async (project: WorkbenchProject, sketchId: string, bodyId: string, entity: SketchEntity, plane: "datum:xy" | "datum:yz", offset: number, depth: number): Promise<WorkbenchProject> =>
        withStep(withSketch(project, sketchId, entity, plane, offset), step(`feature:${bodyId}`, sketchId, `general-body:${bodyId}`, { kind: "extrude", valueMm: depth }));
      const target = (bodyId: string, role = "face.cap-bottom"): DesignExtentTarget => ({ kind: "face", bodyId: `general-body:${bodyId}`, faceRole: role, pointMm: [0, 5, 15], normal: [-1, 0, 0] });
      let project = await withBlock(spinProject(), "feature:sketch-stop", "stop", { id: "entity:stop", kind: "rectangle", center: [-15, 5], widthMm: 10, heightMm: 10, rotationDeg: 0, construction: false }, "datum:yz", 0, 5);
      const stop = bodyOf(project, "general-body:stop");
      near(boundsOf(stop).min[0]!, 0, 1e-6, "the stop's face is the plane x = 0");
      near(boundsOf(stop).min[2]!, 10, 1e-6, "and it covers z 10..20");
      project = await withStep(project, spin({ valueMm: 1, extent: "to-first", extentTarget: target("stop") }));
      const toFace = bodyOf(project, SPIN);
      const b = boundsOf(toFace);
      near(b.max[2]!, 20, 1e-3, "the turn ended with the profile on the stop's face (z reaches 20)");
      near(b.min[0]!, 0, 1e-3, "and 90 degrees round, so x has come back to 0");
      near(volumeOf(toFace), RING / 4, RING / 4 * 0.015, "which is a quarter of the full ring");
      assert(isClosedManifold(toFace), "closed");
      assert(designOf(project).features.every((feature) => feature.health === undefined), "no step is flagged");
      // Move the stop 3 mm along +x: the profile now meets it earlier, so the revolve is shorter once replayed.
      project = await withStep(project, step("feature:move-stop", "feature:sketch-stop", "general-body:stop", { kind: "move-body", valueMm: 3, operation: "direct-edit", moveDeltaMm: [3, 0, 0] }));
      const expectedDeg = (Math.acos(3 / 20) * 180) / Math.PI;
      const moved = bodyOf(project, SPIN);
      near(volumeOf(moved), RING * expectedDeg / 360, RING * 0.015, `after the stop moved the revolve is ${expectedDeg.toFixed(1)} degrees`);
      assert(volumeOf(moved) < volumeOf(toFace) - RING * 0.005, "so it shrank");
      // Flipped sweeps toward -Z, to a stop on that side.
      let flipped = await withBlock(spinProject(), "feature:sketch-back", "back", { id: "entity:back", kind: "rectangle", center: [15, 5], widthMm: 10, heightMm: 10, rotationDeg: 0, construction: false }, "datum:yz", 0, 5);
      flipped = await withStep(flipped, spin({ valueMm: 1, direction: "flipped", extent: "to-last", extentTarget: { ...target("back"), pointMm: [0, 5, -15] } }));
      near(boundsOf(bodyOf(flipped, SPIN)).min[2]!, -20, 1e-3, "flipped: the profile turned 90 degrees toward -Z");
      near(volumeOf(bodyOf(flipped, SPIN)), RING / 4, RING / 4 * 0.015, "a quarter ring");
    }
  },
  {
    name: "revolve To first and To last differ when the corners of the profile reach a slanting-away face at different times",
    run: async () => {
      // The profile's corners lie 14 and 20 mm from the axis; the face is the plane z = 12 (sweeping +x toward +z gives z = r sin angle).
      const rect: SketchEntity = { id: "entity:band", kind: "rectangle", center: [17, 15], widthMm: 6, heightMm: 30, rotationDeg: 0, construction: false };
      const withFloor = async (): Promise<WorkbenchProject> => withStep(
        withSketch(spinProject(rect), "feature:sketch-floor", { id: "entity:floor", kind: "rectangle", center: [0, 0], widthMm: 200, heightMm: 200, rotationDeg: 0, construction: false }, "datum:xy", 12),
        step("feature:floor", "feature:sketch-floor", "general-body:floor", { kind: "extrude", valueMm: 4 }));
      const target: DesignExtentTarget = { kind: "face", bodyId: "general-body:floor", faceRole: "face.cap-bottom", pointMm: [0, 0, 12], normal: [0, 0, -1] };
      const first = bodyOf(await withStep(await withFloor(), spin({ valueMm: 1, extent: "to-first", extentTarget: target })), SPIN);
      near(boundsOf(first).max[2]!, 12, 1e-3, "To first: stops when the outer corner (20 mm out) touches z = 12");
      const last = bodyOf(await withStep(await withFloor(), spin({ valueMm: 1, extent: "to-last", extentTarget: target })), SPIN);
      const lastAngle = Math.asin(12 / 14);
      near(boundsOf(last).max[2]!, 20 * Math.sin(lastAngle), 0.02, "To last: keeps turning until the inner corner (14 mm out) has reached z = 12 too");
      assert(boundsOf(last).max[2]! > boundsOf(first).max[2]! + 4, "so it turns further");
      // A face the profile can never reach (the plane z = 25, past the 20 mm outer radius) is reported, not guessed.
      const project = await withStep(withSketch(await withFloor(), "feature:sketch-ceiling", { id: "entity:ceiling", kind: "rectangle", center: [0, 0], widthMm: 200, heightMm: 200, rotationDeg: 0, construction: false }, "datum:xy", 25), step("feature:ceiling", "feature:sketch-ceiling", "general-body:ceiling", { kind: "extrude", valueMm: 4 }));
      const unreachable: DesignExtentTarget = { kind: "face", bodyId: "general-body:ceiling", faceRole: "face.cap-bottom", pointMm: [0, 0, 25], normal: [0, 0, -1] };
      const staged: WorkbenchProject = { ...project, design: { ...designOf(project), features: [...designOf(project).features, spin({ valueMm: 1, extent: "to-first", extentTarget: unreachable })], rollbackIndex: designOf(project).features.length + 1 } };
      const message = (await replayAllBodies(staged)).find((result) => result.featureId === "feature:spin")?.message ?? "";
      assert(message.includes("never reaches"), `an unreachable face is reported: ${message}`);
    }
  },
  {
    name: "revolveAngleToFace works on a bare mesh: a flat face through the axis is reached at its angle, and a curved face is refused",
    run: () => {
      // A single square face in the plane x = 0 (z 10..20, y 0..10), with its outward direction -X.
      const mesh = { positionsMm: [0, 0, 10, 0, 0, 20, 0, 10, 20, 0, 10, 10], indices: [0, 2, 1, 0, 3, 2], faceTriangles: [0, 0] };
      const corners: readonly (readonly [number, number, number])[] = [[10, 2, 0], [20, 2, 0], [20, 8, 0], [10, 8, 0]];
      const reach = revolveAngleToFace(mesh, 0, corners, [0, 0, 0], [0, -1, 0], "first");
      assert(reach.ok, "a reachable face gives an angle");
      if (reach.ok) near(reach.angleDeg, 90, 1e-6, "a quarter turn");
      const wrongWay = revolveAngleToFace(mesh, 0, corners, [0, 0, 0], [0, 1, 0], "first");
      assert(!wrongWay.ok || Math.abs(wrongWay.angleDeg - 270) < 1e-6, "turning the other way does not reach it in 90");
      const far = revolveAngleToFace(mesh, 0, [[10, 40, 0]], [0, 0, 0], [0, -1, 0], "first");
      assert(!far.ok, "a profile that lands beside the face (y = 40) never reaches it");
    }
  },
  {
    name: "the revolve fields are validated, labelled and survive a save and reload",
    run: async () => {
      const base = { id: "feature:r", name: "R", kind: "revolve", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 90, bodyId: SPIN } as const;
      const face = { kind: "face", bodyId: PLATE, faceRole: "face.cap-top", pointMm: [0, 0, 10], normal: [0, 0, 1] };
      assert(validSolidFeaturePayload({ ...base, extent: "to-first", extentTarget: face }), "revolve To first is valid");
      assert(validSolidFeaturePayload({ ...base, extent: "to-last", direction: "flipped", extentTarget: face }), "revolve To last flipped is valid");
      assert(validSolidFeaturePayload({ ...base, direction: "symmetric", thinWallMm: 2, thinSide: "center" }), "symmetric thin revolve is valid");
      assert(!validSolidFeaturePayload({ ...base, extent: "to-face", extentTarget: face }), "a revolve cannot run To face");
      assert(!validSolidFeaturePayload({ ...base, extent: "to-first", direction: "two-side", secondValueMm: 5, extentTarget: face }), "To first with two sides is refused");
      assert(!validSolidFeaturePayload({ ...base, extent: "to-first", extentTarget: { kind: "vertex", bodyId: PLATE, pointMm: [0, 0, 0] } }), "To first needs a face");
      assert(!validSolidFeaturePayload({ ...base, thinSide: "inside" }), "a thin side needs a thin wall");
      assert(!validSolidFeaturePayload({ ...base, thinWallMm: 0 }), "a zero wall is refused");
      assert(!validSolidFeaturePayload({ ...base, thinSide: "middle", thinWallMm: 2 }), "an unknown side is refused");
      assert(!validSolidFeaturePayload({ ...base, valueMm: 400 }), "more than a full turn is refused");
      // Labels
      const project = await withStep(spinProject(), spin({ valueMm: 40, direction: "two-side", secondValueMm: 20, thinWallMm: 2, thinSide: "outside" }));
      const feature = designOf(project).features.find((candidate) => candidate.id === "feature:spin")!;
      const label = describeFeature(designOf(project), feature);
      assert(label.includes("40° + 20° two sides") && label.includes("thin 2 mm outside"), `the timeline label says what it does: ${label}`);
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(project)) as unknown).ok, "the project validates after a save and reload");
      const reloaded = JSON.parse(JSON.stringify(project)) as WorkbenchProject;
      const replayed = apply(reloaded, await replayAllBodies(reloaded));
      near(volumeOf(bodyOf(replayed, SPIN)), volumeOf(bodyOf(project, SPIN)), 1e-6, "a reloaded project replays to the same solid");
    }
  },
  {
    name: "vertex picking offers only real corners of a solid, welded once, and finds the one nearest a click",
    run: async () => {
      const project = await plateAndBlock();
      const plate = bodyOf(project, PLATE);
      const corners = pickableVertices(plate);
      assert(typeof corners !== "string", "the plate has few enough corners");
      if (typeof corners === "string") return;
      equal(corners.length, 8, "a plate with a round bore has 8 corners: the bore's rim and its facets are not corners");
      assert(corners.every((corner) => corner.surfaces >= 3), "each corner is where three surfaces meet");
      const block = bodyOf(project, "general-body:block");
      const blockCorners = pickableVertices(block);
      if (typeof blockCorners === "string") return;
      equal(blockCorners.length, 8, "a block has 8 corners, however many triangles meet at each");
      const nearest = nearestMeshVertex(blockCorners, [18, -17, 41]);
      assert(nearest !== undefined, "there is a nearest corner");
      if (nearest !== undefined) {
        equal(nearest.vertex.pointMm.join(","), "20,-20,40", "a click near the bottom corner at x = 20, y = -20 picks it");
        near(nearest.distanceMm, Math.hypot(2, 3, 1), 1e-6, "and reports how far the click was");
      }
      // A cylinder has no corners at all: its rims are smooth runs of facets.
      const peg = bodyOf(await withStep(withSketch(project, "feature:sketch-peg", { id: "entity:peg", kind: "circle", center: [12, 12], radiusMm: 3, construction: false }, "datum:xy", 0), step("feature:peg", "feature:sketch-peg", "general-body:peg", { kind: "extrude", valueMm: 20 })), "general-body:peg");
      equal((pickableVertices(peg) as readonly unknown[]).length, 0, "a cylinder offers no vertex");
    }
  },
  {
    name: "offsetPolygon moves an outline sideways, in either direction, and refuses a wall that folds over",
    run: () => {
      const square = [[0, 0], [10, 0], [10, 10], [0, 10]] as const;
      const inward = offsetPolygon(square, 2);
      assert(inward.ok, "a square can be inset");
      if (inward.ok) {
        const xs = inward.points.map((point) => point[0]); const ys = inward.points.map((point) => point[1]);
        equal(`${Math.min(...xs)},${Math.max(...xs)},${Math.min(...ys)},${Math.max(...ys)}`, "2,8,2,8", "a 6 x 6 square");
        equal(inward.points[0]!.join(","), "2,2", "points stay in the order they were given");
      }
      const outward = offsetPolygon(square, -1.5);
      assert(outward.ok && outward.points[0]!.join(",") === "-1.5,-1.5", "a negative distance grows the square");
      const clockwise = offsetPolygon([...square].reverse(), 2);
      assert(clockwise.ok && clockwise.points.every((point) => point[0] >= 2 - 1e-9 && point[0] <= 8 + 1e-9), "a clockwise outline is inset, not outset");
      const ell = [[0, 0], [20, 0], [20, 6], [6, 6], [6, 20], [0, 20]] as const;
      const ellInset = offsetPolygon(ell, 2);
      assert(ellInset.ok, "an L shape with a concave corner can be inset");
      if (ellInset.ok) {
        assert(ellInset.points.some((point) => Math.abs(point[0] - 4) < 1e-9 && Math.abs(point[1] - 4) < 1e-9), "the reflex corner (6, 6) moves into the material, to (4, 4)");
        assert(ellInset.points.some((point) => Math.abs(point[0] - 18) < 1e-9 && Math.abs(point[1] - 4) < 1e-9), "and the end of the arm closes in to (18, 4)");
      }
      assert(!offsetPolygon(square, 6).ok, "a wall thicker than half the square folds over and is refused");
      assert(!offsetPolygon(ell, 3.2).ok, "an arm too narrow for the wall is refused");
      assert(!offsetPolygon([[0, 0], [10, 0], [0, 0.2]], 1).ok, "a sliver too sharp for a mitred wall is refused");
      assert(!offsetPolygon([[0, 0], [1, 1]], 1).ok, "fewer than three corners is refused");
      const unchanged = offsetPolygon(square, 0);
      assert(unchanged.ok && unchanged.points.length === 4, "no distance changes nothing");
    }
  }
];
