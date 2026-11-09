import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, WorkbenchProject, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { datumAxesOf, designOf, faceReferenceOf, parseWorkbenchProjectText, planarFacesOfBody, serializeWorkbenchProject, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { detectSketchProfiles } from "../packages/workbench-sketch/src/index.js";
import { planProjection, sketchFrameOf } from "../packages/workbench-geometry/src/index.js";
import { linePlaneCrossing, sketchPointToWorld as pierceToWorld, worldToSketchPoint } from "../packages/workbench-geometry/src/sketch-pierce.js";
import { rebuildSolidFeature, replayAllBodies, sketchLookupOf, sketchNormal, type RebuildResult } from "../apps/studio-web/src/design-regeneration.js";
import { sketchPointToWorld as extentToWorld } from "../apps/studio-web/src/extent-resolve.js";
import { sketchPointToWorld as constructionToWorld } from "../apps/studio-web/src/construction-ui.js";
import { sketchPointToWorld as webToWorld } from "../apps/studio-web/src/web-profile.js";
import { sketchPointsToWorld } from "../apps/studio-web/src/surface-workflow.js";
import { sketchToWorld, worldToSketch } from "../apps/studio-web/src/sketch-world.js";
import { conventionOf, describeSketchPlane } from "../apps/studio-web/src/sketch-plane-ui.js";
import { cancelSketchSession } from "../apps/studio-web/src/sketch-session.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { buildSolid, circ, committedSketch, fresh, line, message, meshStats, pipelineApply, pipelineRun, rect, solidFeature, solidOf } from "./pipeline-kit.js";

/**
 * Re-audit P22: the Right (YZ) plane was Y-up in a Z-up world. New sketches carry planeConvention "z-up" (sketch X = world +Y, sketch Y =
 * world +Z, normal +X); a sketch without the marker keeps the old mapping (sketch X = world -Z, sketch Y = world +Y) for good.
 */

type V3 = readonly [number, number, number];
const world = (sketch: WorkbenchSketch, u: number, v: number): V3 => sketchToWorld(sketch, u, v);

function sketchOf(project: WorkbenchProject, id: string): DesignSketchFeature {
  return designOf(project).features.find((feature): feature is DesignSketchFeature => feature.id === id && feature.kind === "sketch")!;
}
const bodyOf = (project: WorkbenchProject, id: string): GeneralSolidBody => project.part.generalBodies!.find((body) => body.id === id)!;
const featureOf = (project: WorkbenchProject, id: string): DesignSolidFeature => designOf(project).features.find((feature): feature is DesignSolidFeature => feature.id === id && feature.kind !== "sketch")!;

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

export const pipeline3PlaneTests: readonly TestCase[] = [
  {
    name: "P22 a new Right-plane sketch carries the z-up marker, other planes and legacy sketches carry none, and a stored legacy sketch keeps its mapping",
    run: () => {
      const start = (plane: "datum:xy" | "datum:xz" | "datum:yz", extra: Record<string, unknown> = {}): WorkbenchProject => pipelineRun(fresh(), { kind: "new-design-sketch", plane, ...extra } as never);
      equal(start("datum:yz").sketch.planeConvention, "z-up", "a new sketch on the Right plane is z-up");
      equal(start("datum:xy").sketch.planeConvention, undefined, "the Top plane has no marker");
      equal(start("datum:xz").sketch.planeConvention, undefined, "the Front plane has no marker");
      equal(start("datum:yz", { convention: "legacy" }).sketch.planeConvention, undefined, "a sketch asked for with the legacy mapping has no marker");
      equal(start("datum:yz", { offsetMm: 7, tilt: { axis: "z", angleDeg: 30 } }).sketch.planeConvention, "z-up", "an offset or tilted Right-plane sketch is z-up too");
      // set-sketch-plane: moving a legacy sketch's offset keeps its mapping; going to another plane and back takes the new one.
      const legacy = start("datum:yz", { convention: "legacy" });
      equal(pipelineRun(legacy, { kind: "set-sketch-plane", plane: "datum:yz", offsetMm: 5 }).sketch.planeConvention, undefined, "changing the offset of a legacy sketch keeps the legacy mapping");
      equal(pipelineRun(legacy, { kind: "set-sketch-plane", plane: "datum:yz", convention: "z-up" }).sketch.planeConvention, "z-up", "asking for z-up on it switches it");
      const zup = start("datum:yz");
      equal(pipelineRun(zup, { kind: "set-sketch-plane", plane: "datum:yz", offsetMm: 5 }).sketch.planeConvention, "z-up", "changing the offset of a z-up sketch keeps z-up");
      equal(pipelineRun(zup, { kind: "set-sketch-plane", plane: "datum:xz" }).sketch.planeConvention, undefined, "moving it to another plane drops the marker");
      equal(pipelineRun(pipelineRun(zup, { kind: "set-sketch-plane", plane: "datum:xz" }), { kind: "set-sketch-plane", plane: "datum:yz" }).sketch.planeConvention, "z-up", "and coming back to the Right plane takes z-up");
      equal(pipelineRun(legacy, { kind: "set-sketch-plane", plane: "datum:xy" }).sketch.planeConvention, undefined, "a legacy sketch moved away has no marker");
      equal(pipelineRun(pipelineRun(legacy, { kind: "set-sketch-plane", plane: "datum:xy" }), { kind: "set-sketch-plane", plane: "datum:yz" }).sketch.planeConvention, "z-up", "and a sketch that comes back to the Right plane is z-up");
      // The marker is validated, named when wrong, and survives save and open.
      const bad = pipelineApply(fresh(), { kind: "new-design-sketch", plane: "datum:yz", convention: "sideways" } as never);
      assert(!bad.ok && /"sideways"/u.test(message(bad)) && /z-up/u.test(message(bad)), `an unknown convention is named: ${message(bad)}`);
      const onXy = { ...fresh(), sketch: { ...fresh().sketch, planeConvention: "z-up" } } as unknown as WorkbenchProject;
      assert(!validateWorkbenchProject(onXy).ok, "a z-up marker on the Top plane is refused");
      const saved = parseWorkbenchProjectText(serializeWorkbenchProject(zup));
      assert(saved.ok && saved.value.sketch.planeConvention === "z-up", "the marker survives save and open");
      const savedLegacy = parseWorkbenchProjectText(serializeWorkbenchProject(legacy));
      assert(savedLegacy.ok && savedLegacy.value.sketch.planeConvention === undefined && !serializeWorkbenchProject(legacy).includes("planeConvention"), "a legacy sketch is saved without the field, byte for byte as before");
      equal(conventionOf(legacy.sketch), "legacy", "the UI reads an unmarked Right-plane sketch as legacy");
      equal(conventionOf(zup.sketch), "z-up", "and a marked one as z-up");
    }
  },
  {
    name: "P22 a revolve about a vertical line on a new YZ sketch turns about world Z (the re-audit repro: bbox was [-15,0,-15]-[15,20,15]); a legacy YZ sketch builds the same solid as before",
    run: async () => {
      const profile = [rect("r", 10, 10, 10, 20)];
      const up = meshStats(solidOf(await buildSolid(committedSketch("datum:yz", profile).sketch, "revolve", { valueMm: 360 })));
      near(up.lo[0], -15, 0.01, "z-up: spreads 15 mm either way in X");
      near(up.hi[0], 15, 0.01, "and X");
      near(up.lo[1], -15, 0.01, "and in Y");
      near(up.hi[1], 15, 0.01, "and Y");
      near(up.lo[2], 0, 0.01, "it starts at z = 0");
      near(up.hi[2], 20, 0.01, "and stands 20 mm along world Z");
      const old = meshStats(solidOf(await buildSolid(committedSketch("datum:yz", profile, { convention: "legacy" }).sketch, "revolve", { valueMm: 360 })));
      near(old.lo[0], -15, 0.01, "legacy: the re-audit's bbox is unchanged, X");
      near(old.hi[0], 15, 0.01, "X");
      near(old.lo[1], 0, 0.01, "y from 0");
      near(old.hi[1], 20, 0.01, "to 20 (it turns about world Y)");
      near(old.lo[2], -15, 0.01, "and Z");
      near(old.hi[2], 15, 0.01, "and Z");
      near(up.volume, old.volume, 1e-6 * old.volume, "both are the same solid, turned");
      // A partial turn starts at the sketch plane and goes toward the normal on both conventions.
      const quarterUp = meshStats(solidOf(await buildSolid(committedSketch("datum:yz", [rect("r", 10, 10, 10, 20)]).sketch, "revolve", { valueMm: 90 })));
      near(quarterUp.lo[0], 0, 0.01, "a quarter turn from the plane goes to the +X side");
      near(quarterUp.hi[0], 15, 0.01, "reaching 15 mm");
      // Revolve about a vertical construction line that is not the sketch Y axis (a chosen axis), on both conventions.
      const aboutLine = async (convention: "legacy" | "z-up"): Promise<ReturnType<typeof meshStats>> => {
        const sketch = committedSketch("datum:yz", [rect("r", 20, 10, 10, 20), line("axis", [0, 0], [0, 20], true)], { convention }).sketch;
        const entity = sketch.sketch.entities.find((candidate) => candidate.kind === "line")!;
        return meshStats(solidOf(await buildSolid(sketch, "revolve", { valueMm: 360, revolveAxis: { kind: "sketch-line", entityId: entity.id } })));
      };
      const lineUp = await aboutLine("z-up");
      const lineOld = await aboutLine("legacy");
      near(lineUp.hi[2], 20, 0.01, "z-up: a revolve about a vertical sketch line stands along world Z");
      near(lineUp.hi[0], 25, 0.01, "reaching 25 mm out in X");
      near(lineOld.hi[1], 20, 0.01, "legacy: the same line turns about world Y");
      near(lineUp.volume, lineOld.volume, 1e-6 * lineOld.volume, "and both volumes agree");
    }
  },
  {
    name: "P22 an extrude on a new YZ sketch goes along +X with sketch X on world Y and sketch Y on world Z; a legacy YZ extrude is unchanged; an offset moves along X for both",
    run: async () => {
      const profile = [rect("r", 10, 5, 20, 10)];
      const up = meshStats(solidOf(await buildSolid(committedSketch("datum:yz", profile, { offsetMm: 4 }).sketch, "extrude", { valueMm: 7 })));
      near(up.lo[0], 4, 0.01, "z-up: starts at the offset");
      near(up.hi[0], 11, 0.01, "and rises 7 mm along +X");
      near(up.lo[1], 0, 0.01, "sketch X 0..20 is world Y 0..20");
      near(up.hi[1], 20, 0.01, "Y");
      near(up.lo[2], 0, 0.01, "sketch Y 0..10 is world Z 0..10");
      near(up.hi[2], 10, 0.01, "Z");
      near(up.volume, 20 * 10 * 7, 0.01, "with the right volume");
      const old = meshStats(solidOf(await buildSolid(committedSketch("datum:yz", profile, { offsetMm: 4, convention: "legacy" }).sketch, "extrude", { valueMm: 7 })));
      near(old.lo[0], 4, 0.01, "legacy: starts at the offset");
      near(old.hi[0], 11, 0.01, "rises along +X");
      near(old.lo[1], 0, 0.01, "sketch Y 0..10 is world Y 0..10");
      near(old.hi[1], 10, 0.01, "Y");
      near(old.lo[2], -20, 0.01, "sketch X 0..20 is world Z 0..-20");
      near(old.hi[2], 0, 0.01, "Z");
      // A thin revolve and a symmetric extrude follow the same mapping.
      const sym = meshStats(solidOf(await buildSolid(committedSketch("datum:yz", profile).sketch, "extrude", { valueMm: 6, direction: "symmetric" })));
      near(sym.lo[0], -3, 0.01, "a symmetric extrude straddles the plane");
      near(sym.hi[0], 3, 0.01, "evenly");
      const thin = meshStats(solidOf(await buildSolid(committedSketch("datum:yz", [rect("r", 10, 10, 6, 20)]).sketch, "revolve", { valueMm: 360, thinWallMm: 1, thinSide: "inside" })));
      near(thin.hi[2], 20, 0.05, "a thin revolve on the new Right plane stands along world Z too");
      near(thin.hi[0], 13, 0.05, "and spreads in X");
    }
  },
  {
    name: "P22 every sketch-to-world mapping in the app agrees for a new YZ sketch (offset, tilted), a legacy one, and the other planes: sketch-world, extent, construction, web profile, surface, pierce and project",
    run: () => {
      const make = (plane: "datum:xy" | "datum:xz" | "datum:yz", extra: Record<string, unknown>): WorkbenchSketch => pipelineRun(fresh(), { kind: "new-design-sketch", plane, ...extra } as never).sketch;
      const sketches: readonly (readonly [string, WorkbenchSketch])[] = [
        ["xy", make("datum:xy", {})], ["xz offset", make("datum:xz", { offsetMm: 6 })],
        ["yz z-up", make("datum:yz", {})], ["yz z-up offset", make("datum:yz", { offsetMm: 9 })], ["yz z-up tilted", make("datum:yz", { offsetMm: 3, tilt: { axis: "z", angleDeg: 25 } })],
        ["yz legacy", make("datum:yz", { convention: "legacy" })], ["yz legacy offset", make("datum:yz", { convention: "legacy", offsetMm: 9 })], ["yz legacy tilted", make("datum:yz", { convention: "legacy", offsetMm: 3, tilt: { axis: "z", angleDeg: 25 } })]
      ];
      const point: [number, number] = [7, -3];
      const close = (a: V3, b: V3, label: string): void => { for (let i = 0; i < 3; i += 1) near(a[i]!, b[i]!, 1e-9, `${label} [${i}]`); };
      for (const [name, sketch] of sketches) {
        const reference = world(sketch, point[0], point[1]);
        const feature: DesignSketchFeature = { id: "feature:s", name: "S", kind: "sketch", suppressed: false, sketch };
        close(pierceToWorld(sketch, point), reference, `${name}: pierce`);
        close(extentToWorld(feature, point[0], point[1]), reference, `${name}: extent`);
        close(constructionToWorld(sketch, point), reference, `${name}: construction`);
        close(webToWorld(sketch, point), reference, `${name}: web profile`);
        const surface = sketchPointsToWorld(feature, [point])[0]!;
        close(surface, reference, `${name}: surface`);
        const frame = sketchFrameOf(sketch);
        close([frame.originMm[0] + frame.uAxis[0] * point[0] + frame.vAxis[0] * point[1], frame.originMm[1] + frame.uAxis[1] * point[0] + frame.vAxis[1] * point[1], frame.originMm[2] + frame.uAxis[2] * point[0] + frame.vAxis[2] * point[1]], reference, `${name}: project frame`);
        const back = worldToSketchPoint(sketch, reference);
        near(back.uv[0], point[0], 1e-9, `${name}: pierce back u`);
        near(back.uv[1], point[1], 1e-9, `${name}: pierce back v`);
        const around = worldToSketch(sketch, reference);
        near(around.u, point[0], 1e-9, `${name}: world to sketch u`);
        near(around.v, point[1], 1e-9, `${name}: world to sketch v`);
        const normal = sketchNormal(feature);
        const tip = world(sketch, point[0], point[1]);
        const lifted = sketchToWorld(sketch, point[0], point[1], 1);
        close([lifted[0] - tip[0], lifted[1] - tip[1], lifted[2] - tip[2]], normal, `${name}: the solid rises along the sketch normal`);
      }
      // The datum axes themselves.
      const upAxes = datumAxesOf(make("datum:yz", {}));
      equal(JSON.stringify([upAxes.u, upAxes.v, upAxes.n]), JSON.stringify([[0, 1, 0], [0, 0, 1], [1, 0, 0]]), "z-up Right plane: X = world Y, Y = world Z, normal = +X (right-handed)");
      const oldAxes = datumAxesOf(make("datum:yz", { convention: "legacy" }));
      equal(JSON.stringify([oldAxes.u, oldAxes.v, oldAxes.n]), JSON.stringify([[0, 0, -1], [0, 1, 0], [1, 0, 0]]), "legacy Right plane: X = world -Z, Y = world +Y");
      // A line along X through (x, 3, 4) crosses a new Right-plane sketch at sketch (3, 4); a legacy one at (-4, 3).
      const zCrossing = linePlaneCrossing(make("datum:yz", {}), [0, 3, 4], [1, 0, 0]);
      assert(zCrossing.ok && Math.abs(zCrossing.value.pointMm[0] - 3) < 1e-9 && Math.abs(zCrossing.value.pointMm[1] - 4) < 1e-9, "z-up pierce at (3, 4)");
      const oldCrossing = linePlaneCrossing(make("datum:yz", { convention: "legacy" }), [0, 3, 4], [1, 0, 0]);
      assert(oldCrossing.ok && Math.abs(oldCrossing.value.pointMm[0] + 4) < 1e-9 && Math.abs(oldCrossing.value.pointMm[1] - 3) < 1e-9, "legacy pierce at (-4, 3)");
      // The status and chip text follow the marker.
      assert(/Sketch X runs along world \+Y, sketch Y along world \+Z/u.test(describeSketchPlane(make("datum:yz", {})).status), "the status line of a new Right-plane sketch");
      assert(/Sketch X runs along world -Z, sketch Y along world \+Y/u.test(describeSketchPlane(make("datum:yz", { convention: "legacy" })).status), "and of a legacy one");
    }
  },
  {
    name: "P22 projecting a body into a new YZ sketch and extruding the outline back lands on the body; the legacy sketch still projects the way it did",
    run: () => {
      // A 40 (X) x 30 (Y) x 10 (Z) box. On the Right plane the side seen along X is Y by Z: 30 x 10 for z-up (sketch X = Y).
      const lo: V3 = [0, 0, 0]; const hi: V3 = [40, 30, 10];
      const corners: V3[] = [];
      for (const x of [lo[0], hi[0]]) for (const y of [lo[1], hi[1]]) for (const z of [lo[2], hi[2]]) corners.push([x, y, z]);
      const positionsMm = corners.flat();
      const faces = [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5]];
      const indices = faces.flatMap(([a, b, c, d]) => [a!, b!, c!, a!, c!, d!]);
      const body = { id: "general-body:box", name: "Box", visible: true, color: "#889", positionsMm, indices } as GeneralSolidBody;
      let serial = 0;
      const newId = (): string => `entity:proj-${(serial += 1)}`;
      for (const [label, convention, extentU, extentV] of [["z-up", undefined, 30, 10], ["legacy", "legacy", 10, 30]] as const) {
        const project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:yz", ...(convention === undefined ? {} : { convention }) });
        const planned = planProjection({ mode: "silhouette", body, sketch: project.sketch, newId });
        assert(planned.ok, `${label}: the silhouette is planned: ${planned.ok ? "" : planned.message}`);
        if (!planned.ok) continue;
        const xs: number[] = []; const ys: number[] = [];
        for (const entity of planned.plan.entities) {
          const points = entity.kind === "line" ? [entity.start, entity.end] : entity.kind === "rectangle" ? [[entity.center[0] - entity.widthMm / 2, entity.center[1] - entity.heightMm / 2], [entity.center[0] + entity.widthMm / 2, entity.center[1] + entity.heightMm / 2]] : [];
          for (const [x, y] of points) { xs.push(x!); ys.push(y!); }
        }
        near(Math.max(...xs) - Math.min(...xs), extentU, 1e-6, `${label}: the silhouette is ${extentU} mm along sketch X`);
        near(Math.max(...ys) - Math.min(...ys), extentV, 1e-6, `${label}: and ${extentV} mm along sketch Y`);
      }
    }
  },
  {
    name: "P22 a sweep along a path drawn on a new YZ sketch (also offset and tilted) has the volume of section times path length",
    run: async () => {
      const cases: readonly { readonly name: string; readonly extra: Record<string, unknown> }[] = [
        { name: "plain", extra: {} }, { name: "offset", extra: { offsetMm: 40 } }, { name: "tilted", extra: { tilt: { axis: "z", angleDeg: -20 } } }
      ];
      for (const testCase of cases) {
        let project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:yz", ...testCase.extra } as never);
        project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [line("p1", [0, 0], [40, 0]), line("p2", [40, 0], [60, 30])], addConstraints: [], label: "Path" });
        project = pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:path", name: "Path" });
        const pathSketch = sketchOf(project, "feature:path");
        const w0 = world(pathSketch.sketch, 0, 0); const w1 = world(pathSketch.sketch, 1, 0);
        const tangent = [w1[0] - w0[0], w1[1] - w0[1], w1[2] - w0[2]];
        const tl = Math.hypot(tangent[0]!, tangent[1]!, tangent[2]!);
        const n = tangent.map((value) => value / tl) as unknown as V3;
        const helper: V3 = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
        const raw: V3 = [n[1] * helper[2] - n[2] * helper[1], n[2] * helper[0] - n[0] * helper[2], n[0] * helper[1] - n[1] * helper[0]];
        const rl = Math.hypot(...raw);
        const u = raw.map((value) => value / rl) as unknown as V3;
        project = pipelineRun(project, { kind: "new-design-sketch", plane: "datum:xy", frame: { originMm: w0, uAxis: u, normal: n } });
        project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [circ("pr", 0, 0, 4)], addConstraints: [], label: "Profile" });
        project = pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:prof", name: "Prof" });
        const profile = sketchOf(project, "feature:prof");
        const feature = solidFeature("sweep", profile, { valueMm: 100, sweepPath: { sketchFeatureId: "feature:path", entityIds: ["entity:p1", "entity:p2"] } });
        const built = await rebuildSolidFeature(feature, profile, "#b9c2c8", sketchLookupOf(designOf(project)));
        const stats = meshStats(solidOf(built));
        const length = 40 + Math.hypot(20, 30);
        const exact = Math.PI * 16 * length;
        assert(Math.abs(stats.volume - exact) / exact < 0.01, `${testCase.name}: the sweep volume ${stats.volume.toFixed(0)} is within 1 percent of ${exact.toFixed(0)}`);
        if (testCase.name === "plain") {
          near(stats.hi[2], 30 + 4 * (20 / Math.hypot(20, 30)), 0.05, "plain: the path rises 30 mm along world Z (sketch Y); the end ring stands square to the last run");
        }
      }
    }
  },
  {
    name: "P22 a sketch started on a +X face of a solid follows the face with the new convention: the boss stands on the face and moves with it",
    run: async () => {
      const base = committedSketch("datum:yz", [rect("base", 0, 0, 40, 40)]);
      const e1 = solidFeature("extrude", base.sketch, { id: "feature:e1", valueMm: 10, bodyId: "general-body:base" });
      const baseBody = solidOf(await rebuildSolidFeature(e1, base.sketch));
      let project = pipelineRun(base.project, { kind: "add-design-solid", feature: e1, body: baseBody });
      const face = planarFacesOfBody(baseBody).find((candidate) => candidate.axis === "x" && candidate.outwardPositive);
      assert(face !== undefined, "the extruded base has a +X face");
      near(face.coordinateMm, 10, 1e-6, "at x = 10");
      project = pipelineRun(project, { kind: "new-design-sketch", plane: "datum:yz", offsetMm: face.coordinateMm, face: faceReferenceOf("general-body:base", face) });
      equal(project.sketch.planeConvention, "z-up", "the face sketch is z-up");
      project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [rect("boss", 0, 0, 10, 10)], addConstraints: [], label: "Boss" });
      project = pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:s2", name: "Boss sketch" });
      const bossSketch = sketchOf(project, "feature:s2");
      const e2: DesignSolidFeature = { id: "feature:e2", name: "Boss", kind: "extrude", suppressed: false, sketchFeatureId: "feature:s2", profileIds: [detectSketchProfiles(bossSketch.sketch)[0]!.id], valueMm: 15, bodyId: "general-body:base", operation: "join" };
      project = pipelineRun(project, { kind: "add-design-solid", feature: e2, body: baseBody });
      project = applyResults(project, await replayAllBodies(project));
      near(meshStats(bodyOf(project, "general-body:base")).hi[0], 25, 0.01, "10 mm base plus a 15 mm boss stands 25 mm along X");
      const taller = { ...featureOf(project, "feature:e1"), valueMm: 20 };
      const rebuilt = solidOf(await rebuildSolidFeature(taller, sketchOf(project, "feature:s1")));
      project = pipelineRun(project, { kind: "update-design-solid", feature: taller, body: rebuilt });
      project = applyResults(project, await replayAllBodies(project));
      near(meshStats(bodyOf(project, "general-body:base")).hi[0], 35, 0.01, "after the base is made 10 mm taller the boss follows the face to x = 35");
      equal(sketchOf(project, "feature:s2").sketch.planeConvention, "z-up", "and the stored boss sketch keeps its convention");
    }
  },
  {
    name: "P22 cancelling a sketch session restores a legacy Right-plane sketch as legacy and a z-up one as z-up",
    run: () => {
      for (const convention of ["legacy", "z-up"] as const) {
        let project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:yz", convention, offsetMm: 5 });
        project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [circ("keep", 0, 0, 3)], addConstraints: [], label: "Circle" });
        const entry = project.sketch;
        project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [circ("extra", 10, 0, 3)], addConstraints: [], label: "More" });
        const cancelled = cancelSketchSession(project, entry);
        assert(cancelled.ok && cancelled.value.kind === "discarded", `${convention}: the session is cancelled`);
        if (!cancelled.ok || cancelled.value.kind !== "discarded") continue;
        equal(cancelled.value.project.sketch.planeConvention, convention === "z-up" ? "z-up" : undefined, `${convention}: the restored sketch keeps its mapping`);
        equal(cancelled.value.project.sketch.entities.length, 1, `${convention}: and its curves`);
        near(cancelled.value.project.sketch.planeOffsetMm ?? 0, 5, 1e-9, `${convention}: and its offset`);
      }
    }
  },
  {
    name: "P22 a project saved before the fix (no marker) opens and rebuilds to identical geometry; its solids and the new-convention solids differ only by the turn",
    run: async () => {
      // A legacy project: a YZ sketch with an L profile, extruded 12 and revolved 360. Round-tripped through the saved text with no marker.
      const built = committedSketch("datum:yz", [line("a", [0, 0], [20, 0]), line("b", [20, 0], [20, 8]), line("c", [20, 8], [5, 8]), line("d", [5, 8], [5, 20]), line("e", [5, 20], [0, 20]), line("f", [0, 20], [0, 0])], { convention: "legacy" });
      const text = serializeWorkbenchProject(built.project);
      assert(!text.includes("planeConvention"), "the saved legacy project has no marker");
      const opened = parseWorkbenchProjectText(text);
      assert(opened.ok, "the legacy project opens");
      if (!opened.ok) return;
      const sketch = designOf(opened.value).features.find((feature): feature is DesignSketchFeature => feature.kind === "sketch")!;
      equal(sketch.sketch.planeConvention, undefined, "and is still unmarked");
      const extrude = meshStats(solidOf(await buildSolid(sketch, "extrude", { valueMm: 12 })));
      // The legacy mapping puts sketch X on world -Z and sketch Y on world +Y: this solid is pinned from the released build.
      near(extrude.lo[0], 0, 1e-6, "legacy extrude x low");
      near(extrude.hi[0], 12, 1e-6, "legacy extrude x high");
      near(extrude.lo[1], 0, 1e-6, "legacy extrude y low");
      near(extrude.hi[1], 20, 1e-6, "legacy extrude y high");
      near(extrude.lo[2], -20, 1e-6, "legacy extrude z low");
      near(extrude.hi[2], 0, 1e-6, "legacy extrude z high");
      const revolve = meshStats(solidOf(await buildSolid(sketch, "revolve", { valueMm: 360 })));
      near(revolve.lo[1], 0, 1e-6, "legacy revolve y low");
      near(revolve.hi[1], 20, 1e-6, "legacy revolve y high (about world Y)");
      near(revolve.hi[0], 20, 0.05, "legacy revolve x");
      // Pinned from the released build (167da52): the same triangles and volumes, to the last digit.
      near(extrude.volume, 2640, 1e-6, "legacy extrude volume is the released build's");
      equal(extrude.triangles, 20, "and its triangle count");
      near(revolve.volume, 10988.340918, 1e-5, "legacy revolve volume is the released build's");
      equal(revolve.triangles, 1200, "and its triangle count");
      // The same drawing on a new sketch is the same solid with the axes renamed.
      const fresher = committedSketch("datum:yz", [line("a", [0, 0], [20, 0]), line("b", [20, 0], [20, 8]), line("c", [20, 8], [5, 8]), line("d", [5, 8], [5, 20]), line("e", [5, 20], [0, 20]), line("f", [0, 20], [0, 0])]);
      const upExtrude = meshStats(solidOf(await buildSolid(fresher.sketch, "extrude", { valueMm: 12 })));
      near(upExtrude.volume, extrude.volume, 1e-6, "same extrude volume");
      near(upExtrude.hi[1], 20, 1e-6, "new: sketch X on world Y");
      near(upExtrude.hi[2], 20, 1e-6, "new: sketch Y on world Z");
      near(upExtrude.lo[2], 0, 1e-6, "new: from z = 0");
    }
  },
  {
    name: "N-08 Horizontal on an exactly vertical line (and Vertical on a horizontal one) is a quarter turn about the joined end, keeping the length, through add-sketch-constraint and apply-sketch-edit",
    run: () => {
      const entityOf = (project: WorkbenchProject, id: string) => project.sketch.entities.find((entity) => entity.id === id);
      const lineAt = (project: WorkbenchProject, id: string): { readonly start: readonly [number, number]; readonly end: readonly [number, number] } => {
        const found = entityOf(project, id);
        assert(found !== undefined && found.kind === "line", `${id} is a line`);
        return found as unknown as { readonly start: readonly [number, number]; readonly end: readonly [number, number] };
      };
      const draw = (entities: readonly ReturnType<typeof line>[], constraints: readonly unknown[] = []): WorkbenchProject =>
        pipelineRun(fresh(), { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: entities, addConstraints: constraints as never, label: "draw" });
      // The re-audit repro: a vertical centerline from (30, -10) to (30, 40).
      const base = draw([line("cl", [30, -10], [30, 40])]);
      const turned = pipelineRun(base, { kind: "add-sketch-constraint", constraint: { id: "constraint:h", kind: "horizontal", entityIds: ["entity:cl"] } });
      let result = lineAt(turned, "entity:cl");
      near(result.start[0], 30, 1e-9, "the start stays");
      near(result.start[1], -10, 1e-9, "where it was");
      near(result.end[0], 80, 1e-9, "the end swings round to the right by the line's 50 mm");
      near(result.end[1], -10, 1e-9, "and level with the start");
      // An exact edit keeps geometry as sent, so it cannot turn a line: it says so and points at add-sketch-constraint (it used to say only "conflicts with a relation").
      const viaEdit = pipelineApply(base, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [{ id: "constraint:h", kind: "horizontal", entityIds: ["entity:cl"] }], label: "Horizontal" });
      assert(!viaEdit.ok && /exactly vertical/u.test(message(viaEdit)) && /quarter turn/u.test(message(viaEdit)) && /add-sketch-constraint/u.test(viaEdit.ok ? "" : viaEdit.diagnostics[0]?.recovery ?? ""), `apply-sketch-edit names the quarter turn and the way: ${message(viaEdit)}`);
      const levelInEdit = pipelineRun(base, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [line("cl", [30, -10], [80, -10])], addEntities: [], addConstraints: [{ id: "constraint:h", kind: "horizontal", entityIds: ["entity:cl"] }], label: "Level" });
      near(lineAt(levelInEdit, "entity:cl").end[0], 80, 1e-9, "while drawing the line level in the same edit works");
      // Vertical on a horizontal line.
      const flat = draw([line("h", [10, 20], [60, 20])]);
      const upright = pipelineRun(flat, { kind: "add-sketch-constraint", constraint: { id: "constraint:v", kind: "vertical", entityIds: ["entity:h"] } });
      result = lineAt(upright, "entity:h");
      near(result.end[0], 10, 1e-9, "Vertical turns a horizontal line about its start");
      near(result.end[1], 70, 1e-9, "50 mm up");
      // A line joined at its end turns about that end: the neighbour does not move.
      const chain = draw([line("a", [0, 0], [40, 0]), line("b", [40, 0], [40, 30])], [{ id: "constraint:j", kind: "coincident", entityIds: ["entity:a", "entity:b"], points: ["end", "start"] }]);
      const joined = pipelineRun(chain, { kind: "add-sketch-constraint", constraint: { id: "constraint:hb", kind: "horizontal", entityIds: ["entity:b"] } });
      result = lineAt(joined, "entity:b");
      near(result.start[0], 40, 1e-9, "the joined start stays");
      near(result.end[0], 70, 1e-9, "the free end swings to 30 mm along");
      near(result.end[1], 0, 1e-9, "level");
      const neighbour = lineAt(joined, "entity:a");
      near(neighbour.end[0], 40, 1e-9, "and the neighbouring line is where it was");
      // When the joined end is the line's end, it is the start that swings.
      const onOrigin = draw([line("o", [0, 40], [0, 0])]);
      const swung = lineAt(pipelineRun(onOrigin, { kind: "add-sketch-constraint", constraint: { id: "constraint:ho", kind: "horizontal", entityIds: ["entity:o"] } }), "entity:o");
      near(swung.end[0], 0, 1e-9, "a line ending on the origin keeps that end");
      near(swung.start[0], -40, 1e-9, "and its start swings out to 40 mm to the left");
      // A length dimension on the line stays met.
      const sized = draw([line("s", [5, 5], [5, 45])], [{ id: "constraint:len", kind: "distance", entityIds: ["entity:s"], valueMm: 40 }]);
      const sizedTurned = lineAt(pipelineRun(sized, { kind: "add-sketch-constraint", constraint: { id: "constraint:hs", kind: "horizontal", entityIds: ["entity:s"] } }), "entity:s");
      near(Math.hypot(sizedTurned.end[0] - sizedTurned.start[0], sizedTurned.end[1] - sizedTurned.start[1]), 40, 1e-6, "a dimensioned 40 mm line is still 40 mm");
      near(sizedTurned.end[1], sizedTurned.start[1], 1e-6, "and level");
      // A line already level is left exactly where it is.
      const level = draw([line("l", [0, 10], [25, 10])]);
      const same = lineAt(pipelineRun(level, { kind: "add-sketch-constraint", constraint: { id: "constraint:hl", kind: "horizontal", entityIds: ["entity:l"] } }), "entity:l");
      equal(JSON.stringify([same.start, same.end]), JSON.stringify([[0, 10], [25, 10]]), "a line that is already level is not touched");
    }
  }
];
