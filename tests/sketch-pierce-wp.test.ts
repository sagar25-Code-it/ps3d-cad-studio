import type { ConstructionAxis, GeneralSolidBody, SketchEntity, SketchPlaneFrame, WorkbenchOperation, WorkbenchProject, WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, constraintFit, createWorkbenchProject, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { refractionAngles } from "../packages/workbench-core/src/sketch-solve-extras.js";
import { solveLiveSketch } from "../packages/workbench-core/src/sketch-solve.js";
import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { frameThroughPoints } from "../packages/workbench-geometry/src/sketch-placement.js";
import {
  axisPierce, bodyEdgePierces, createPierceEdit, linePlaneCrossing, listPierceHits, pierceRefreshEdit, refreshPierceConstraints, resolvePierce, sketchPointToWorld, worldToSketchPoint
} from "../packages/workbench-geometry/src/sketch-pierce.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let serial = 0;
type Vec3 = readonly [number, number, number];
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function apply(project: WorkbenchProject, operation: Op) {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-wp-pierce-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  const result = apply(project, operation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  assert(validateWorkbenchProject(result.value.project).ok, "the resulting project validates");
  return result.value.project;
}

const axisThrough = (id: string, a: Vec3, b: Vec3): ConstructionAxis => ({ id: `axis:${id}`, name: id, visible: true, definition: { kind: "two-points", a, b } });
const withAxis = (project: WorkbenchProject, axis: ConstructionAxis): WorkbenchProject => run(project, { kind: "add-construction-axis", axis });

function box(id: string, min: Vec3, max: Vec3): GeneralSolidBody {
  const [x0, y0, z0] = min;
  const [x1, y1, z1] = max;
  const positionsMm = [x0, y0, z0, x1, y0, z0, x1, y1, z0, x0, y1, z0, x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1];
  const indices = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5];
  return { id: `general-body:${id}`, name: id, visible: true, color: "#8899aa", positionsMm, indices };
}

const onSketch = (plane: "datum:xy" | "datum:xz" | "datum:yz", extra: Partial<Extract<Op, { kind: "set-sketch-plane" }>> = {}): WorkbenchProject =>
  run(createWorkbenchProject("project:test-wp-pierce"), { kind: "set-sketch-plane", plane, ...extra } as Op);

/** The distance from a world point to the infinite line through a and b. */
function distanceToLine(point: Vec3, a: Vec3, b: Vec3): number {
  const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const w: Vec3 = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
  const cross: Vec3 = [d[1] * w[2] - d[2] * w[1], d[2] * w[0] - d[0] * w[2], d[0] * w[1] - d[1] * w[0]];
  return Math.hypot(...cross) / Math.hypot(...d);
}

function hitOf(project: WorkbenchProject, axis: ConstructionAxis) {
  const hit = axisPierce(project.sketch, axis);
  assert(hit.ok, `the axis crosses the plane: ${hit.ok ? "" : hit.message}`);
  return hit.value;
}

const UPRIGHT: readonly [Vec3, Vec3, Vec3] = [[5, 5, 5], [5, 15, 5], [5, 5, 15]];
const SLANTED: readonly [Vec3, Vec3, Vec3] = [[20, 10, 5], [30, 10, 10], [20, 20, 5]];

function frameOf(points: readonly [Vec3, Vec3, Vec3]): SketchPlaneFrame {
  const frame = frameThroughPoints(points);
  if ("error" in frame) throw new Error(frame.error);
  return frame;
}

export const sketchPierceWpTests: readonly TestCase[] = [
  {
    name: "a construction axis pierces each datum sketch plane, at the plane's offset, in the plane's own sketch coordinates",
    run: () => {
      // XY, offset 12: a slanted axis through the origin along (1, 0, 1) is at x = 12 where z = 12.
      const xy = onSketch("datum:xy", { offsetMm: 12 });
      const slanted = axisThrough("slant", [0, 0, 0], [1, 0, 1]);
      const slantHit = hitOf(xy, slanted);
      near(slantHit.pointMm[0], 12, 1e-9, "XY offset 12: u is the world x where the axis reaches z = 12");
      near(slantHit.pointMm[1], 0, 1e-9, "and v the world y");
      near(slantHit.worldMm[2], 12, 1e-9, "the world point is on the offset plane");
      // XZ, offset 6 puts the plane at y = -6; an axis along Y through x = 3, z = 7 crosses it at sketch (3, 7).
      const xz = onSketch("datum:xz", { offsetMm: 6 });
      const alongY = hitOf(xz, axisThrough("y", [3, -10, 7], [3, 10, 7]));
      near(alongY.pointMm[0], 3, 1e-9, "XZ: u is the world x");
      near(alongY.pointMm[1], 7, 1e-9, "XZ: v is the world z");
      near(alongY.worldMm[1], -6, 1e-9, "the XZ plane at offset 6 sits at y = -6");
      // YZ, offset 5: plane x = 5; an axis along X through y = 4, z = 9 gives u = -z = -9, v = y = 4.
      const yz = onSketch("datum:yz", { offsetMm: 5 });
      const alongX = hitOf(yz, axisThrough("x", [-10, 4, 9], [10, 4, 9]));
      near(alongX.pointMm[0], -9, 1e-9, "YZ: u is minus the world z");
      near(alongX.pointMm[1], 4, 1e-9, "YZ: v is the world y");
      for (const [project, axis] of [[xy, slanted], [xz, axisThrough("y", [3, -10, 7], [3, 10, 7])], [yz, axisThrough("x", [-10, 4, 9], [10, 4, 9])]] as const) {
        const hit = hitOf(project, axis);
        const frame = { origin: axis.definition.kind === "two-points" ? axis.definition.a : ([0, 0, 0] as Vec3), end: axis.definition.kind === "two-points" ? axis.definition.b : ([0, 0, 0] as Vec3) };
        near(distanceToLine(hit.worldMm, frame.origin, frame.end), 0, 1e-9, "the world point lies on the axis");
        const back = sketchPointToWorld(project.sketch, hit.pointMm);
        near(back[0], hit.worldMm[0], 1e-9, "a sketch point at the crossing lands on it in the world (x)");
        near(back[1], hit.worldMm[1], 1e-9, "(y)");
        near(back[2], hit.worldMm[2], 1e-9, "(z)");
      }
    }
  },
  {
    name: "a tilted sketch plane (with an offset) is pierced where the tilted plane, not the datum, meets the axis",
    run: () => {
      // Tilt the XY plane 30 degrees about X. An axis along Z through (7, 5) meets it where -sin(30) 5 + cos(30) z = 0, so z = 5 tan(30).
      const tilted = onSketch("datum:xy", { tilt: { axis: "x", angleDeg: 30 } });
      const axis = axisThrough("z", [7, 5, -10], [7, 5, 10]);
      const hit = hitOf(tilted, axis);
      near(hit.worldMm[2], 5 * Math.tan(Math.PI / 6), 1e-9, "the axis meets the tilted plane at z = 5 tan 30");
      near(hit.pointMm[0], 7, 1e-9, "sketch u is the world x, which a turn about X leaves alone");
      near(hit.pointMm[1], 5 / Math.cos(Math.PI / 6), 1e-9, "sketch v is the distance up the slope, 5 / cos 30");
      // With a 4 mm offset (applied before the tilt): -sin(30) 5 + cos(30) z = 4.
      const offset = onSketch("datum:xy", { offsetMm: 4, tilt: { axis: "x", angleDeg: 30 } });
      const offsetHit = hitOf(offset, axis);
      near(offsetHit.worldMm[2], (4 + 2.5) / Math.cos(Math.PI / 6), 1e-9, "z = (4 + 5 sin 30) / cos 30");
      near(offsetHit.pointMm[1], 5 * Math.cos(Math.PI / 6) + offsetHit.worldMm[2] * 0.5, 1e-9, "sketch v follows the slope");
      const placed = sketchPointToWorld(offset.sketch, offsetHit.pointMm);
      near(placed[0], 7, 1e-9, "putting a sketch point at the crossing back into the world returns it (x)");
      near(placed[1], 5, 1e-9, "(y)");
      near(placed[2], offsetHit.worldMm[2], 1e-9, "(z)");
      const round = worldToSketchPoint(offset.sketch, offsetHit.worldMm);
      near(round.heightMm, 0, 1e-9, "the crossing stands on the plane");
      near(round.uv[1], offsetHit.pointMm[1], 1e-9, "and maps back to the same sketch point");
    }
  },
  {
    name: "a three-point sketch plane is pierced at the right sketch coordinates, for an upright and a slanted frame",
    run: () => {
      // Upright plane x = 5 with sketch X along world Y and sketch Y along world Z.
      const upright = onSketch("datum:xy", { frame: frameOf(UPRIGHT) });
      const hit = hitOf(upright, axisThrough("x", [-3, 9, 12], [30, 9, 12]));
      near(hit.worldMm[0], 5, 1e-9, "the axis meets the plane x = 5");
      near(Math.abs(hit.pointMm[0]), 4, 1e-9, "four millimetres along the plane's X from its corner");
      near(Math.abs(hit.pointMm[1]), 7, 1e-9, "and seven along its Y");

      // Slanted plane: choose a point at (3, 4) in the plane's own frame, and an axis through it at an angle to the plane.
      const frame = frameOf(SLANTED);
      const slanted = onSketch("datum:xy", { frame });
      const v: Vec3 = [frame.normal[1] * frame.uAxis[2] - frame.normal[2] * frame.uAxis[1], frame.normal[2] * frame.uAxis[0] - frame.normal[0] * frame.uAxis[2], frame.normal[0] * frame.uAxis[1] - frame.normal[1] * frame.uAxis[0]];
      const target: Vec3 = [0, 1, 2].map((i) => frame.originMm[i]! + 3 * frame.uAxis[i]! + 4 * v[i]!) as unknown as Vec3;
      const through = axisThrough("thru", [target[0] - 6, target[1] + 2, target[2] + 3], [target[0] + 12, target[1] - 4, target[2] - 6]);
      const slantedHit = hitOf(slanted, through);
      near(slantedHit.pointMm[0], 3, 1e-9, "the crossing is at u = 3 in the slanted plane's frame");
      near(slantedHit.pointMm[1], 4, 1e-9, "and v = 4");
      near(slantedHit.worldMm[0], target[0], 1e-9, "at the world point the axis was built through (x)");
      near(slantedHit.worldMm[2], target[2], 1e-9, "(z)");
    }
  },
  {
    name: "an axis parallel to the sketch plane, or lying in it, or one that was deleted, is reported rather than guessed",
    run: () => {
      const project = onSketch("datum:xy", { offsetMm: 5 });
      const parallel = axisPierce(project.sketch, axisThrough("p", [0, 0, 0], [10, 0, 0]));
      assert(!parallel.ok && /parallel/u.test(parallel.message), `a parallel axis never crosses: ${parallel.ok ? "" : parallel.message}`);
      const inPlane = axisPierce(project.sketch, axisThrough("q", [0, 0, 5], [10, 0, 5]));
      assert(!inPlane.ok && /lies in the sketch plane/u.test(inPlane.message), `an axis in the plane crosses everywhere: ${inPlane.ok ? "" : inPlane.message}`);
      const direct = linePlaneCrossing(project.sketch, [0, 0, 0], [0, 0, 0]);
      assert(!direct.ok, "a zero direction is refused");
      const missing = resolvePierce(project, { kind: "axis", axisId: "axis:gone" });
      assert(!missing.ok && /no longer/u.test(missing.message), "a missing axis is named");
    }
  },
  {
    name: "a Pierce point is created through the real operation path: a point entity plus a Pierce constraint that validates, takes two degrees of freedom and survives a JSON round trip",
    run: () => {
      let project = onSketch("datum:xy", { offsetMm: 12 });
      project = withAxis(project, axisThrough("tower", [10, 20, -5], [10, 20, 30]));
      const hits = listPierceHits(project);
      equal(hits.length, 1, "one crossing is on offer");
      near(hits[0]!.pointMm[0], 10, 1e-9, "at x = 10");
      near(hits[0]!.pointMm[1], 20, 1e-9, "and y = 20");
      const free = analyzeWorkbenchSketch(project.sketch).degreesOfFreedom;
      const edit = createPierceEdit(project, hits[0]!, { entityId: "entity:pierce-1", constraintId: "constraint:pierce-1" });
      project = run(project, edit);
      const point = project.sketch.entities.find((entity) => entity.id === "entity:pierce-1");
      assert(point?.kind === "point", "the sketch gained a point");
      near(point.point[0], 10, 1e-9, "at the crossing (x)");
      near(point.point[1], 20, 1e-9, "(y)");
      const constraint = project.sketch.constraints.find((candidate) => candidate.id === "constraint:pierce-1");
      assert(constraint?.kind === "pierce" && constraint.pierce?.kind === "axis" && constraint.pierce.axisId === "axis:tower", "the Pierce constraint names the axis");
      equal(analyzeWorkbenchSketch(project.sketch).degreesOfFreedom, free + 2 - 2, "the point arrives with two degrees of freedom and Pierce takes both");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(project))).ok, "the project survives a JSON round trip");
      equal(constraintFit("pierce", ["point"]).ok, true, "Pierce fits a sketch point");
      equal(constraintFit("pierce", ["line"]).ok, false, "and nothing else");
      const solved = solveLiveSketch(project.sketch);
      assert(solved.ok && solved.unsolved.length === 0, "the live solver leaves Pierce to the geometry layer without calling it unsolved");
      const bad = apply(project, { kind: "add-sketch-constraint", constraint: { id: "constraint:bad-pierce", kind: "pierce", entityIds: ["entity:pierce-1"] } as WorkbenchSketchConstraint });
      assert(!bad.ok, "a Pierce constraint with no axis or edge is rejected by validation");
    }
  },
  {
    name: "a Pierce point follows its axis when the axis moves, and when the sketch plane is moved, offset or tilted",
    run: () => {
      let project = onSketch("datum:xy", { offsetMm: 12 });
      project = withAxis(project, axisThrough("tower", [10, 20, -5], [10, 20, 30]));
      project = run(project, createPierceEdit(project, listPierceHits(project)[0]!, { entityId: "entity:pierce-1", constraintId: "constraint:pierce-1" }));
      equal(pierceRefreshEdit(project), undefined, "a point already on its crossing needs no refresh");

      // Move the sketch plane to offset 20: the axis is vertical so the crossing keeps its sketch coordinates, but tilting it moves it.
      project = run(project, { kind: "set-sketch-plane", plane: "datum:xy", offsetMm: 20 });
      equal(pierceRefreshEdit(project), undefined, "a vertical axis crosses every parallel plane at the same sketch point");
      project = run(project, { kind: "set-sketch-plane", plane: "datum:xy", tilt: { axis: "x", angleDeg: 30 } });
      const refresh = refreshPierceConstraints(project);
      equal(refresh.updates.length, 1, "after tilting the plane the Pierce point is off its crossing");
      const edit = pierceRefreshEdit(project)!;
      project = run(project, edit);
      const point = project.sketch.entities.find((entity) => entity.id === "entity:pierce-1");
      assert(point?.kind === "point", "the point is still there");
      near(point.point[0], 10, 1e-9, "u is unchanged by a tilt about X");
      near(point.point[1], 20 / Math.cos(Math.PI / 6), 1e-9, "v is the distance up the slope, 20 / cos 30");
      const world = sketchPointToWorld(project.sketch, point.point);
      near(distanceToLine(world, [10, 20, -5], [10, 20, 30]), 0, 1e-9, "the point is on the axis in the world");
      equal(pierceRefreshEdit(project), undefined, "and now nothing is stale");
    }
  },
  {
    name: "a body edge pierces the sketch plane at its corner, picked by chain, and the Pierce point follows when the body changes",
    run: () => {
      let project = onSketch("datum:xy", { offsetMm: 4 });
      project = run(project, { kind: "add-general-body", body: box("block", [0, 0, 0], [20, 30, 10]) });
      const crossings = bodyEdgePierces(project.sketch, project.part.generalBodies![0]!);
      assert(crossings.ok, "the edges of the block can be examined");
      if (!crossings.ok) return;
      equal(crossings.value.length, 4, "the four vertical edges cross the plane z = 4");
      const corners = crossings.value.map((hit) => `${hit.pointMm[0]},${hit.pointMm[1]}`).sort().join(" ");
      equal(corners, "0,0 0,30 20,0 20,30", "at the four corners of the block's footprint");
      const hits = listPierceHits(project);
      equal(hits.length, 4, "the list offers all four");
      const chosen = hits.find((hit) => hit.pointMm[0] === 20 && hit.pointMm[1] === 30)!;
      assert(chosen.reference.kind === "body-edge", "a body-edge reference");
      project = run(project, createPierceEdit(project, chosen, { entityId: "entity:corner", constraintId: "constraint:corner" }));

      // Make the block bigger: the same edge now crosses at the new corner, and the point is taken there.
      const grown = box("block", [0, 0, 0], [25, 40, 10]);
      project = { ...project, part: { ...project.part, generalBodies: [{ ...grown, id: project.part.generalBodies![0]!.id }] } };
      const edit = pierceRefreshEdit(project);
      assert(edit !== undefined, "the corner point is stale after the block grew");
      project = run(project, edit);
      const point = project.sketch.entities.find((entity) => entity.id === "entity:corner");
      assert(point?.kind === "point", "the corner point exists");
      near(point.point[0], 25, 1e-9, "it moved to the new corner (x)");
      near(point.point[1], 40, 1e-9, "(y)");

      // Raise the sketch plane above the block: the edge no longer crosses and the point is reported, not moved.
      const above = run(project, { kind: "set-sketch-plane", plane: "datum:xy", offsetMm: 50 });
      const refreshed = refreshPierceConstraints(above);
      equal(refreshed.updates.length, 0, "nothing is moved");
      equal(refreshed.unresolved.length, 1, "the lost crossing is reported");
      assert(/does not cross/u.test(refreshed.unresolved[0]!.message), refreshed.unresolved[0]!.message);
    }
  },
  {
    name: "a body edge pierces a tilted plane at the tilted crossing, found independently of the sketch code",
    run: () => {
      let project = onSketch("datum:xy", { tilt: { axis: "y", angleDeg: 45 } });
      project = run(project, { kind: "add-general-body", body: box("block", [0, 0, -10], [20, 30, 30]) });
      const crossings = bodyEdgePierces(project.sketch, project.part.generalBodies![0]!);
      assert(crossings.ok, "the tilted plane can be crossed with the block");
      if (!crossings.ok) return;
      // Tilt 45 degrees about Y turns the XY plane's normal (0,0,1) to (sin45, 0, cos45): the plane is x sin45 + z cos45 = 0, so z = -x.
      // The vertical edges at x = 0 cross at z = 0, and those at x = 20 would cross at z = -20, outside the block, so only x = 0 edges count.
      const found = crossings.value.map((hit) => hit.worldMm);
      assert(found.length >= 2, `the edges at x = 0 cross the tilted plane (${found.length})`);
      for (const world of found) {
        near(world[0] * Math.sin(Math.PI / 4) + world[2] * Math.cos(Math.PI / 4), 0, 1e-9, "every crossing satisfies the tilted plane's equation");
      }
      for (const hit of crossings.value) {
        const back = sketchPointToWorld(project.sketch, hit.pointMm);
        near(back[0], hit.worldMm[0], 1e-9, "the sketch point maps back to the crossing (x)");
        near(back[2], hit.worldMm[2], 1e-9, "(z)");
      }
      const edges = resolvePierce(project, crossings.value[0]!.reference, crossings.value[0]!.pointMm);
      assert(edges.ok, "the reference resolves again");
    }
  },
  {
    name: "Refraction bends the second line at the interface by Snell's law, keeps its length, and re-bends when the incident line or the index ratio changes",
    run: () => {
      const entities: SketchEntity[] = [
        { id: "entity:inc", kind: "line", start: [-10, 10], end: [0, 0], construction: false },
        { id: "entity:ref", kind: "line", start: [0, 0], end: [3, -14], construction: false },
        { id: "entity:iface", kind: "line", start: [-20, 0], end: [20, 0], construction: false }
      ];
      const base = createWorkbenchProject("project:test-wp-refraction");
      const start: WorkbenchProject = { ...base, sketch: { ...base.sketch, entities, constraints: [] } };
      const constraint = (ratio: number): WorkbenchSketchConstraint => ({ id: "constraint:snell", kind: "refraction", entityIds: ["entity:inc", "entity:ref", "entity:iface"], ratio });
      const project = run(start, { kind: "add-sketch-constraint", constraint: constraint(1.5) });
      const line = (p: WorkbenchProject, id: string) => p.sketch.entities.find((entity) => entity.id === `entity:${id}`) as Extract<SketchEntity, { kind: "line" }>;
      const [incidence, refraction] = refractionAngles(line(project, "inc"), line(project, "ref"), line(project, "iface"));
      near(incidence, 45, 1e-9, "the incident ray is 45 degrees from the normal");
      near(Math.sin((incidence * Math.PI) / 180), 1.5 * Math.sin((refraction * Math.PI) / 180), 1e-9, "sin(incidence) = ratio times sin(refraction)");
      near(refraction, (Math.asin(Math.sin(Math.PI / 4) / 1.5) * 180) / Math.PI, 1e-9, "the refracted angle is 28.1 degrees");
      const refracted = line(project, "ref");
      near(refracted.start[0], 0, 1e-12, "the refracted line leaves the interface point");
      near(Math.hypot(refracted.end[0] - refracted.start[0], refracted.end[1] - refracted.start[1]), Math.hypot(3, 14), 1e-9, "and keeps its length");
      assert(refracted.end[1] < 0, "it continues across the interface");
      assert(refracted.end[0] > 0, "on the same side of the normal as the incident ray's travel");

      // Going into a lower index (ratio 0.9) the ray bends away from the normal instead.
      const low = run(start, { kind: "add-sketch-constraint", constraint: constraint(0.9) });
      const [lowIncidence, lowRefraction] = refractionAngles(line(low, "inc"), line(low, "ref"), line(low, "iface"));
      assert(lowRefraction > lowIncidence, "a ratio below 1 bends away from the normal");
      near(Math.sin((lowIncidence * Math.PI) / 180), 0.9 * Math.sin((lowRefraction * Math.PI) / 180), 1e-9, "and Snell's law holds for it too");
      // Editing the ratio re-bends the same line: delete the constraint and add it again at 2.
      const rebuilt = run(run(project, { kind: "delete-sketch-constraint", constraintId: "constraint:snell" }), { kind: "add-sketch-constraint", constraint: constraint(2) });
      near(refractionAngles(line(rebuilt, "inc"), line(rebuilt, "ref"), line(rebuilt, "iface"))[1], (Math.asin(Math.sin(Math.PI / 4) / 2) * 180) / Math.PI, 1e-9, "a ratio of 2 gives 20.7 degrees");
    }
  },
  {
    name: "Refraction refuses total internal reflection and a ray that runs along the interface, and follows a moved incident line",
    run: () => {
      const entities: SketchEntity[] = [
        { id: "entity:inc", kind: "line", start: [-17.32, 10], end: [0, 0], construction: false },
        { id: "entity:ref", kind: "line", start: [0, 0], end: [8, -8], construction: false },
        { id: "entity:iface", kind: "line", start: [-20, 0], end: [20, 0], construction: false }
      ];
      const base = createWorkbenchProject("project:test-wp-refraction-2");
      const start: WorkbenchProject = { ...base, sketch: { ...base.sketch, entities, constraints: [] } };
      const snell = (ratio: number): WorkbenchSketchConstraint => ({ id: "constraint:snell", kind: "refraction", entityIds: ["entity:inc", "entity:ref", "entity:iface"], ratio });
      const reflected = apply(start, { kind: "add-sketch-constraint", constraint: snell(0.5) });
      assert(!reflected.ok && /Total internal reflection/u.test(reflected.diagnostics[0]?.message ?? ""), "a 60 degree ray into a ratio of 0.5 cannot cross");
      const along = apply({ ...start, sketch: { ...start.sketch, entities: [{ id: "entity:inc", kind: "line", start: [-10, 0], end: [0, 0], construction: false }, ...entities.slice(1)] } }, { kind: "add-sketch-constraint", constraint: snell(1.5) });
      assert(!along.ok, "a ray along the interface is refused");

      const bent = run(start, { kind: "add-sketch-constraint", constraint: snell(1.4) });
      const lineOf = (p: WorkbenchProject, id: string) => p.sketch.entities.find((entity) => entity.id === `entity:${id}`) as Extract<SketchEntity, { kind: "line" }>;
      const before = refractionAngles(lineOf(bent, "inc"), lineOf(bent, "ref"), lineOf(bent, "iface"));
      // Shortening the incident line keeps its start, so its end slides along the same direction and the refraction point moves with it.
      const shorter = run(bent, { kind: "set-sketch-dimension", entityId: "entity:inc", dimension: "length", valueMm: 5 });
      const moved = lineOf(shorter, "inc");
      const refracted = lineOf(shorter, "ref");
      near(refracted.start[0], moved.end[0], 1e-9, "the refracted line follows the incident line's end (x)");
      near(refracted.start[1], moved.end[1], 1e-9, "(y)");
      const after = refractionAngles(moved, refracted, lineOf(shorter, "iface"));
      near(after[0], before[0], 1e-9, "the incidence angle is unchanged by a length edit");
      near(Math.sin((after[0] * Math.PI) / 180), 1.4 * Math.sin((after[1] * Math.PI) / 180), 1e-9, "and Snell's law still holds for the moved ray");
      equal(analyzeWorkbenchSketch(bent.sketch).conflicts.length, 0, "a well-formed refraction raises no conflict");
      equal(constraintFit("refraction", ["line", "line", "line"]).ok, true, "three lines fit");
      equal(constraintFit("refraction", ["line", "line", "circle"]).ok, false, "a circle is not an interface line");
    }
  }
];
