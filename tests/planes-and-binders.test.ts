import type { ConstructionAxis, ConstructionBinder, ConstructionPlaneDefinition, DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, Vec3, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, validateWorkbenchProject, validSketchPlaneFrame } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { bodyFaces, buildPartPreview, evaluateConstructionPlane, evaluateConstructionPlaneDefinition, faceTargetOf, nearestBodyFace, planeFrameOfFace, resolveBinder, type ConstructionPlaneFrame } from "../packages/workbench-geometry/src/index.js";
import { tessellateExtrude } from "../packages/workbench-geometry/src/tessellate.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function attempt(project: WorkbenchProject, operation: Op): ReturnType<typeof applyWorkbenchOperation> {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-binder-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  const result = attempt(project, operation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const axis = (id: string, a: Vec3, b: Vec3): ConstructionAxis => ({ id: `construction-axis:${id}`, name: id, visible: true, definition: { kind: "two-points", a, b } });

function frameOf(definition: ConstructionPlaneDefinition, project?: WorkbenchProject): ConstructionPlaneFrame {
  const frame = evaluateConstructionPlaneDefinition(definition, project?.part.generalBodies ?? [], project?.part.constructionAxes ?? [], project?.part.constructionBinders ?? []);
  if ("error" in frame) throw new Error(frame.error);
  return frame;
}

const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** Unit axes, u x v = normal, and (optionally) every given point lying on the plane. */
function assertFrame(frame: ConstructionPlaneFrame, through: readonly Vec3[], label: string): void {
  for (const [name, vector] of [["normal", frame.normal], ["u", frame.uAxis], ["v", frame.vAxis]] as const) near(Math.hypot(...vector), 1, 1e-9, `${label}: ${name} is a unit vector`);
  near(dot(frame.uAxis, frame.vAxis), 0, 1e-9, `${label}: u is perpendicular to v`);
  near(dot(frame.normal, frame.uAxis), 0, 1e-9, `${label}: normal is perpendicular to u`);
  const handed = cross(frame.uAxis, frame.vAxis);
  for (let i = 0; i < 3; i += 1) near(handed[i]!, frame.normal[i]!, 1e-9, `${label}: u x v is the normal`);
  for (const point of through) near(dot(sub(point, frame.origin), frame.normal), 0, 1e-6, `${label}: passes through ${point.join(",")}`);
}

function boxBody(id: string, widthMm: number, depthMm: number, heightMm: number): GeneralSolidBody {
  const mesh = tessellateExtrude([[0, 0], [widthMm, 0], [widthMm, depthMm], [0, depthMm]], heightMm, "xy");
  return { id: `general-body:${id}`, name: id, visible: true, color: "#b9c2c8", positionsMm: Array.from(mesh.positionsMm), indices: Array.from(mesh.indices) };
}

function projectWith(bodies: readonly GeneralSolidBody[]): WorkbenchProject {
  const project = createWorkbenchProject("project:planes-binders");
  return { ...project, part: { ...project.part, generalBodies: bodies } };
}

function circle(radius: number, segments: number, from = 0, to = Math.PI * 2): Vec3[] {
  return Array.from({ length: segments + 1 }, (_, index): Vec3 => [radius * Math.cos(from + (to - from) * index / segments), radius * Math.sin(from + (to - from) * index / segments), 0]);
}

export const planesAndBindersTests: readonly TestCase[] = [
  {
    name: "Plane through two edges: parallel edges and crossing edges give an orthonormal plane that contains all four end points",
    run: () => {
      const parallelA: [Vec3, Vec3] = [[0, 0, 0], [10, 0, 0]];
      const parallelB: [Vec3, Vec3] = [[2, 5, 3], [14, 5, 3]];
      const parallel = frameOf({ kind: "through-two-edges", edgeA: { kind: "segment", a: parallelA[0], b: parallelA[1] }, edgeB: { kind: "segment", a: parallelB[0], b: parallelB[1] } });
      assertFrame(parallel, [...parallelA, ...parallelB], "parallel edges");
      near(Math.abs(parallel.normal[0]), 0, 1e-9, "the normal of two X-parallel edges has no X part");
      near(dot(parallel.normal, [0, 5, 3]), 0, 1e-9, "the normal is perpendicular to the offset between the edges, (0,5,3)·n = 0");
      const crossA: [Vec3, Vec3] = [[0, 0, 0], [10, 0, 0]];
      const crossB: [Vec3, Vec3] = [[5, -3, -3], [5, 3, 3]];
      const crossing = frameOf({ kind: "through-two-edges", edgeA: { kind: "segment", a: crossA[0], b: crossA[1] }, edgeB: { kind: "segment", a: crossB[0], b: crossB[1] } });
      assertFrame(crossing, [...crossA, ...crossB], "crossing edges");
      near(Math.abs(crossing.normal[1]), Math.SQRT1_2, 1e-9, "the plane through X and (0,1,1) leans 45 degrees");
      near(crossing.normal[1] * crossing.normal[2], -0.5, 1e-9, "its normal is (0,1,-1)/sqrt 2 up to sign");
      assert(crossing.sizeMm[0] >= 6 && crossing.sizeMm[1] >= 4, "the drawn quad covers the edges");
    }
  },
  {
    name: "Plane through two edges refuses skew edges and edges on one line, and says why",
    run: () => {
      const skew = evaluateConstructionPlaneDefinition({ kind: "through-two-edges", edgeA: { kind: "segment", a: [0, 0, 0], b: [10, 0, 0] }, edgeB: { kind: "segment", a: [5, -3, 4], b: [5, 3, 4] } });
      assert("error" in skew && skew.error.includes("skew"), "skew edges are refused as skew");
      const sameLine = evaluateConstructionPlaneDefinition({ kind: "through-two-edges", edgeA: { kind: "segment", a: [0, 0, 0], b: [10, 0, 0] }, edgeB: { kind: "segment", a: [20, 0, 0], b: [30, 0, 0] } });
      assert("error" in sameLine && sameLine.error.includes("one line"), "collinear edges are refused");
      const missing = evaluateConstructionPlaneDefinition({ kind: "through-two-edges", edgeA: { kind: "axis", axisId: "construction-axis:gone" }, edgeB: { kind: "segment", a: [0, 0, 0], b: [1, 0, 0] } });
      assert("error" in missing && missing.error.includes("axis"), "a missing axis is reported");
    }
  },
  {
    name: "Plane through two construction axes uses the axes' own ends, and a plane through two picked body edges follows the body when it is rebuilt taller",
    run: () => {
      let project = projectWith([boxBody("block", 40, 30, 10)]);
      project = run(project, { kind: "add-construction-axis", axis: axis("one", [0, 0, 20], [40, 0, 20]) });
      project = run(project, { kind: "add-construction-axis", axis: axis("two", [0, 30, 20], [40, 30, 20]) });
      const byAxes = frameOf({ kind: "through-two-edges", edgeA: { kind: "axis", axisId: "construction-axis:one" }, edgeB: { kind: "axis", axisId: "construction-axis:two" } }, project);
      assertFrame(byAxes, [[0, 0, 20], [40, 0, 20], [0, 30, 20], [40, 30, 20]], "two axes");
      near(Math.abs(byAxes.normal[2]), 1, 1e-9, "two parallel axes at z = 20 give the z = 20 plane");
      // Two top edges picked on the box (along X at y = 0 and y = 30, z = 10).
      const definition: ConstructionPlaneDefinition = { kind: "through-two-edges", edgeA: { kind: "body-edge", bodyId: "general-body:block", a: [0, 0, 10], b: [40, 0, 10] }, edgeB: { kind: "body-edge", bodyId: "general-body:block", a: [0, 30, 10], b: [40, 30, 10] } };
      const before = frameOf(definition, project);
      assertFrame(before, [[0, 0, 10], [40, 0, 10], [0, 30, 10], [40, 30, 10]], "box top edges");
      near(Math.abs(before.normal[2]), 1, 1e-9, "the two top edges give the top plane");
      near(before.origin[2], 10, 1e-6, "at z = 10");
      const taller = projectWith([boxBody("block", 40, 30, 14)]);
      const after = frameOf(definition, taller);
      assertFrame(after, [[0, 0, 14], [40, 0, 14], [0, 30, 14], [40, 30, 14]], "after the rebuild");
      near(after.origin[2], 14, 1e-6, "the plane follows the rebuilt body up to z = 14");
      const gone = evaluateConstructionPlaneDefinition(definition, [], [], []);
      assert("error" in gone && gone.error.includes("no longer"), "a deleted body is reported, not drawn from stale numbers");
      const unlike = projectWith([boxBody("block", 10, 10, 10)]);
      assert("error" in evaluateConstructionPlaneDefinition(definition, unlike.part.generalBodies!, [], []), "a body with no edge of that length and direction near it is not guessed at");
    }
  },
  {
    name: "Plane along a path: perpendicular puts the tangent on the normal, at the right place, on an axis and on a sampled circle",
    run: () => {
      const line = frameOf({ kind: "along-path", path: { kind: "polyline", pointsMm: [[0, 0, 0], [30, 0, 0], [30, 40, 0]] }, t: 0.9, orientation: "perpendicular" });
      // Total length 70; 90% is 63 mm: 33 mm up the second leg.
      near(line.origin[0], 30, 1e-9, "origin x on the second leg");
      near(line.origin[1], 33, 1e-9, "origin y 33 mm along the second leg");
      assertFrame(line, [[30, 33, 0]], "polyline");
      assert(line.normal[1] > 0.95 && line.normal[0] > 0, "the tangent there is mostly +Y, still easing round the corner");
      const R = 20;
      const path = circle(R, 720, 0, Math.PI * 1.5);
      for (const t of [0, 0.1, 0.25, 0.5, 1]) {
        const frame = frameOf({ kind: "along-path", path: { kind: "polyline", pointsMm: path }, t, orientation: "perpendicular" });
        const angle = t * Math.PI * 1.5;
        assertFrame(frame, [], `circle t=${t}`);
        near(Math.hypot(frame.origin[0], frame.origin[1]), R, 0.01, `the origin stays on the circle at t=${t}`);
        const exactTangent: Vec3 = [-Math.sin(angle), Math.cos(angle), 0];
        near(Math.abs(dot(frame.normal, exactTangent)), 1, 1e-4, `the plane is perpendicular to the circle at t=${t}`);
        assert(dot(frame.normal, exactTangent) > 0, `the normal runs the way the path runs at t=${t}`);
      }
      const onAxis = frameOf({ kind: "along-path", path: { kind: "axis", axisId: "construction-axis:path" }, t: 0.25, orientation: "perpendicular" }, run(projectWith([]), { kind: "add-construction-axis", axis: axis("path", [0, 0, 0], [0, 0, 80]) }));
      near(onAxis.origin[2], 20, 1e-9, "a quarter of the way up an 80 mm axis");
      near(onAxis.normal[2], 1, 1e-9, "the plane across a vertical axis is horizontal");
      assertFrame(onAxis, [[0, 0, 20]], "axis");
    }
  },
  {
    name: "Plane along a path, tangent: it holds the tangent and the bend, so on a circle in XY it stands up through the circle's centre line; on a straight axis it still holds the tangent",
    run: () => {
      const path = circle(20, 720, 0, Math.PI * 2);
      const frame = frameOf({ kind: "along-path", path: { kind: "polyline", pointsMm: path }, t: 0.25, orientation: "tangent" });
      assertFrame(frame, [], "tangent on a circle");
      const angle = Math.PI / 2;
      const exactTangent: Vec3 = [-Math.sin(angle), Math.cos(angle), 0];
      near(Math.abs(dot(frame.uAxis, exactTangent)), 1, 1e-3, "the plane's U runs along the tangent");
      near(Math.abs(frame.normal[2]), 1, 1e-3, "the circle lies in XY, so the plane holding its tangent and bend is the XY plane itself (normal Z)");
      assert(frame.description.includes("osculating"), "it says it used the bend");
      const straight = frameOf({ kind: "along-path", path: { kind: "polyline", pointsMm: [[0, 0, 0], [50, 0, 0]] }, t: 0.4, orientation: "tangent" });
      assertFrame(straight, [[20, 0, 0]], "tangent on a straight line");
      near(Math.abs(dot(straight.uAxis, [1, 0, 0])), 1, 1e-9, "it still holds the tangent");
      assert(!straight.description.includes("osculating"), "a straight run does not claim a bend");
      assert("error" in evaluateConstructionPlaneDefinition({ kind: "along-path", path: { kind: "polyline", pointsMm: [[1, 1, 1], [1, 1, 1]] }, t: 0.5, orientation: "perpendicular" }), "a path with no length is refused");
      assert("error" in evaluateConstructionPlaneDefinition({ kind: "along-path", path: { kind: "polyline", pointsMm: [[0, 0, 0], [1, 0, 0]] }, t: 1.5, orientation: "perpendicular" }), "t outside 0..1 is refused");
    }
  },
  {
    name: "The new planes go through operations: validated, saved, reloaded, drawn, and refused when malformed or when they point at nothing",
    run: () => {
      let project = projectWith([boxBody("block", 40, 30, 10)]);
      project = run(project, { kind: "add-construction-axis", axis: axis("a", [0, 0, 0], [40, 0, 0]) });
      const twoEdges = { id: "construction-plane:two-edges", name: "Through edges", visible: true, definition: { kind: "through-two-edges", edgeA: { kind: "axis", axisId: "construction-axis:a" }, edgeB: { kind: "segment", a: [0, 9, 4], b: [40, 9, 4] } } } as const;
      const along = { id: "construction-plane:along", name: "Along path", visible: true, definition: { kind: "along-path", path: { kind: "polyline", pointsMm: circle(15, 60, 0, Math.PI), sketchFeatureId: "feature:sketch-1", entityId: "entity:arc-1" }, t: 0.3, orientation: "perpendicular" } } as const;
      project = run(project, { kind: "add-construction-plane", plane: twoEdges });
      project = run(project, { kind: "add-construction-plane", plane: along });
      const reloaded = validateWorkbenchProject(JSON.parse(JSON.stringify(project)));
      assert(reloaded.ok, `the saved project validates again: ${reloaded.ok ? "" : reloaded.diagnostics[0]?.message ?? ""}`);
      if (!reloaded.ok) return;
      equal(reloaded.value.part.construction?.length, 2, "both planes survive the round trip");
      const scene = buildPartPreview(reloaded.value.part);
      for (const plane of [twoEdges, along]) assert(scene.primitives.some((primitive) => primitive.id === `${plane.id}:fill`), `${plane.name} is drawn`);
      const evaluated = evaluateConstructionPlane(reloaded.value.part.construction![0]!, reloaded.value.part.generalBodies ?? [], reloaded.value.part.constructionAxes ?? []);
      assert(!("error" in evaluated), "the reloaded plane evaluates");
      const bad: readonly [string, unknown][] = [
        ["t above 1", { ...along, id: "construction-plane:b1", definition: { ...along.definition, t: 1.2 } }],
        ["unknown orientation", { ...along, id: "construction-plane:b2", definition: { ...along.definition, orientation: "sideways" } }],
        ["a one-point polyline", { ...along, id: "construction-plane:b3", definition: { kind: "along-path", path: { kind: "polyline", pointsMm: [[0, 0, 0]] }, t: 0.5, orientation: "tangent" } }],
        ["a zero-length segment edge", { ...twoEdges, id: "construction-plane:b4", definition: { kind: "through-two-edges", edgeA: { kind: "segment", a: [1, 1, 1], b: [1, 1, 1] }, edgeB: { kind: "segment", a: [0, 0, 0], b: [1, 0, 0] } } }],
        ["a stray key", { ...twoEdges, id: "construction-plane:b5", definition: { ...twoEdges.definition, extra: 1 } }]
      ];
      for (const [why, plane] of bad) assert(!attempt(project, { kind: "add-construction-plane", plane: plane as never }).ok, `${why} is refused`);
      const missingAxis = { ...twoEdges, id: "construction-plane:b6", definition: { kind: "through-two-edges", edgeA: { kind: "axis", axisId: "construction-axis:nope" }, edgeB: { kind: "segment", a: [0, 0, 0], b: [1, 0, 0] } } };
      assert(!attempt(project, { kind: "add-construction-plane", plane: missingAxis as never }).ok, "an edge on an axis that is not in the part is refused");
      const missingBody = { ...twoEdges, id: "construction-plane:b7", definition: { kind: "through-two-edges", edgeA: { kind: "body-edge", bodyId: "general-body:nope", a: [0, 0, 0], b: [1, 0, 0] }, edgeB: { kind: "segment", a: [0, 1, 0], b: [1, 1, 0] } } };
      assert(!attempt(project, { kind: "add-construction-plane", plane: missingBody as never }).ok, "an edge on a body that is not in the part is refused");
    }
  },
  {
    name: "Body, face and edge binders resolve to the right geometry, and a face binder gives an orthonormal sketch frame facing out of the body",
    run: () => {
      const body = boxBody("block", 40, 30, 10);
      const faces = bodyFaces(body);
      equal(faces.length, 6, "a box has six faces");
      const top = nearestBodyFace(body, [20, 15, 10])!;
      near(top.normal[2], 1, 1e-9, "the face under a click on top is the top face");
      near(top.areaMm2, 1200, 1e-6, "its area is 40 x 30");
      const binder: ConstructionBinder = { id: "binder:top", name: "Top face", visible: true, target: faceTargetOf(body, top) };
      const resolved = resolveBinder(binder, [body]);
      assert(!("error" in resolved) && resolved.kind === "face", "the face resolves");
      if ("error" in resolved || resolved.kind !== "face") return;
      assert(resolved.planar && resolved.frame !== undefined, "it is planar with a frame");
      assertFrame(resolved.frame!, [[0, 0, 10], [40, 30, 10]], "face frame");
      near(resolved.frame!.normal[2], 1, 1e-9, "the frame faces out of the body");
      near(resolved.frame!.uAxis[0], 1, 1e-9, "U runs along world X on a top face");
      const sketchFrame = planeFrameOfFace(resolved)!;
      assert(validSketchPlaneFrame(sketchFrame), "the frame is a valid sketch plane frame");
      const bottom = resolveBinder({ id: "binder:bottom", name: "Bottom", visible: true, target: faceTargetOf(body, nearestBodyFace(body, [20, 15, 0])!) }, [body]);
      assert(!("error" in bottom) && bottom.kind === "face" && bottom.normal[2] < -0.99, "the bottom face stays the bottom face");
      const shape = resolveBinder({ id: "binder:shape", name: "Shape", visible: true, target: { kind: "body", bodyId: body.id } }, [body]);
      assert(!("error" in shape) && shape.kind === "body", "the body resolves");
      if (!("error" in shape) && shape.kind === "body") {
        near(shape.volumeMm3, 12000, 1e-6, "its volume");
        near(shape.centroidMm[2], 5, 1e-9, "its centroid");
      }
      const edge = resolveBinder({ id: "binder:edge", name: "Edge", visible: true, target: { kind: "edge", bodyId: body.id, a: [0, 0, 10], b: [40, 0, 10] } }, [body]);
      assert(!("error" in edge) && edge.kind === "edge" && edge.matchedBy === "exact", "the top front edge resolves exactly");
      assert("error" in resolveBinder({ id: "binder:lost", name: "Lost", visible: true, target: { kind: "body", bodyId: "general-body:nope" } }, [body]), "a binder on a missing body says so");
    }
  },
  {
    name: "A face binder re-resolves after the body is rebuilt taller or moved, an edge binder follows its edge, and a removed face is reported",
    run: () => {
      const body = boxBody("block", 40, 30, 10);
      const face: ConstructionBinder = { id: "binder:top", name: "Top face", visible: true, target: faceTargetOf(body, nearestBodyFace(body, [20, 15, 10])!) };
      const edge: ConstructionBinder = { id: "binder:edge", name: "Top edge", visible: true, target: { kind: "edge", bodyId: body.id, a: [0, 0, 10], b: [40, 0, 10] } };
      const taller = boxBody("block", 40, 30, 15);
      const topAfter = resolveBinder(face, [taller]);
      assert(!("error" in topAfter) && topAfter.kind === "face", "the face is found again on the taller body");
      if (!("error" in topAfter) && topAfter.kind === "face") {
        near(topAfter.centroidMm[2], 15, 1e-6, "now at z = 15");
        equal(topAfter.matchedBy, "fingerprint", "a body without named faces is matched by what was recorded about the face");
      }
      const edgeAfter = resolveBinder(edge, [taller]);
      assert(!("error" in edgeAfter) && edgeAfter.kind === "edge", "the edge is found again");
      if (!("error" in edgeAfter) && edgeAfter.kind === "edge") { near(edgeAfter.a[2], 15, 1e-6, "the edge rose with the body"); equal(edgeAfter.matchedBy, "nearest", "and was matched, not found in place"); }
      // A wider, shifted body: the top face is still the face with the +Z normal, close to where it was.
      const shifted = { ...boxBody("block", 44, 30, 10), positionsMm: boxBody("block", 44, 30, 10).positionsMm.map((value, index) => index % 3 === 0 ? value + 3 : value) };
      const wide = resolveBinder(face, [shifted]);
      assert(!("error" in wide) && wide.kind === "face", "the face survives a shift and a small change of area");
      // Without any +Z face the binder cannot keep its meaning.
      const sphereLike = projectBodyWithoutTop();
      assert("error" in resolveBinder(face, [sphereLike]), "when no face resembles the recorded one, the binder reports it instead of guessing");
    }
  },
  {
    name: "A face binder follows a kernel-rebuilt body by its stable face key when the timeline is edited, and a sketch started on it sits on the rebuilt face",
    run: async () => {
      let project = run(createWorkbenchProject("project:binder-replay"), { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
      const sketch = designOf(project).features[0] as DesignSketchFeature;
      const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 10, bodyId: "general-body:base" };
      const built = await rebuildSolidFeature(extrude, sketch);
      assert(built.ok, `the base extrudes: ${built.ok ? "" : built.message}`);
      if (!built.ok) return;
      project = run(project, { kind: "add-design-solid", feature: extrude, body: built.body });
      const body = project.part.generalBodies!.find((candidate) => candidate.id === "general-body:base")!;
      const zTop = solidMetrics(body.positionsMm, body.indices).boundsMm.max[2];
      const topFace = nearestBodyFace(body, [0, 0, zTop].map((value, axis) => axis === 2 ? value : (solidMetrics(body.positionsMm, body.indices).centroidMm[axis]!)) as unknown as Vec3)!;
      near(topFace.normal[2], 1, 1e-6, "the picked face is the top face");
      const binder: ConstructionBinder = { id: "binder:top", name: "Top face", visible: true, target: faceTargetOf(body, topFace) };
      project = run(project, { kind: "add-construction-binder", binder });
      const first = resolveBinder(binder, project.part.generalBodies!);
      assert(!("error" in first) && first.kind === "face", "the face binder resolves on the built body");
      if ("error" in first || first.kind !== "face") return;
      near(first.centroidMm[2], zTop, 1e-6, "at the top of the 10 mm extrusion");
      // Edit the extrusion to 16 mm and replay the timeline.
      const edited: DesignSolidFeature = { ...extrude, valueMm: 16 };
      const rebuilt = await rebuildSolidFeature(edited, sketch);
      assert(rebuilt.ok, "the edited extrusion rebuilds");
      if (!rebuilt.ok) return;
      project = run(project, { kind: "update-design-solid", feature: edited, body: rebuilt.body });
      project = run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });
      const after = resolveBinder(binder, project.part.generalBodies!);
      assert(!("error" in after) && after.kind === "face", `the binder re-resolves after the rebuild: ${"error" in after ? after.error : ""}`);
      if ("error" in after || after.kind !== "face") return;
      near(after.centroidMm[2], zTop + 6, 1e-6, "now 6 mm higher, at the new top");
      near(after.areaMm2, first.areaMm2, 1e-3, "same face, same area");
      if (body.brep !== undefined) equal(after.matchedBy, "key", "a kernel body is matched by its stable face key");
      // Start a sketch on the binder face: the frame is a valid sketch plane and a solid extruded from it sits on the new top.
      const frame = planeFrameOfFace(after)!;
      assert(validSketchPlaneFrame(frame), "the face frame is a valid sketch plane frame");
      let onFace = run(project, { kind: "new-design-sketch", plane: "datum:xy", frame });
      onFace = run(onFace, { kind: "add-sketch-entity", entity: { id: "entity:boss", kind: "circle", center: [0, 0], radiusMm: 5, construction: false } });
      onFace = run(onFace, { kind: "commit-design-sketch", featureId: "feature:sketch-2", name: "Sketch on face" });
      const sketchOnFace = designOf(onFace).features.find((feature) => feature.id === "feature:sketch-2") as DesignSketchFeature;
      equal(sketchOnFace.sketch.planeFrame?.originMm.join(","), frame.originMm.join(","), "the sketch is stored on the face's frame");
      const boss = await rebuildSolidFeature({ ...extrude, id: "feature:boss", name: "Boss", sketchFeatureId: sketchOnFace.id, valueMm: 4, bodyId: "general-body:boss" }, sketchOnFace);
      assert(boss.ok, `a solid builds on the binder face: ${boss.ok ? "" : boss.message}`);
      if (boss.ok) near(solidMetrics(boss.body.positionsMm, boss.body.indices).boundsMm.min[2], after.centroidMm[2], 1e-6, "the new solid starts on the face");
    }
  },
  {
    name: "Binder operations: add, hide, show, delete, validation round trip, drawing, and refusal of binders with no body or a plane that still uses them",
    run: () => {
      const body = boxBody("block", 40, 30, 10);
      let project = projectWith([body]);
      const face: ConstructionBinder = { id: "binder:top", name: "Top face", visible: true, target: faceTargetOf(body, nearestBodyFace(body, [20, 15, 10])!) };
      const edge: ConstructionBinder = { id: "binder:edge", name: "Edge", visible: true, target: { kind: "edge", bodyId: body.id, a: [0, 0, 10], b: [40, 0, 10] } };
      const edge2: ConstructionBinder = { id: "binder:edge2", name: "Edge 2", visible: true, target: { kind: "edge", bodyId: body.id, a: [0, 30, 10], b: [40, 30, 10] } };
      const shape: ConstructionBinder = { id: "binder:shape", name: "Shape", visible: true, target: { kind: "body", bodyId: body.id } };
      for (const binder of [face, edge, edge2, shape]) project = run(project, { kind: "add-construction-binder", binder });
      equal(project.part.constructionBinders?.length, 4, "four binders");
      assert(!attempt(project, { kind: "add-construction-binder", binder: face }).ok, "a duplicate id is refused");
      assert(!attempt(project, { kind: "add-construction-binder", binder: { ...face, id: "binder:orphan", target: { ...face.target, bodyId: "general-body:nope" } as never } }).ok, "a binder on a body that does not exist is refused");
      assert(!attempt(project, { kind: "add-construction-binder", binder: { ...face, id: "binder:badnormal", target: { ...face.target, normal: [0, 0, 2] } as never } }).ok, "a face fingerprint with a non-unit normal is refused");
      const reloaded = validateWorkbenchProject(JSON.parse(JSON.stringify(project)));
      assert(reloaded.ok, `the saved project validates again: ${reloaded.ok ? "" : reloaded.diagnostics[0]?.message ?? ""}`);
      const drawn = buildPartPreview(project.part).primitives.map((primitive) => primitive.id);
      for (const id of ["binder:top", "binder:top:border", "binder:edge", "binder:shape"]) assert(drawn.includes(id), `${id} is drawn`);
      project = run(project, { kind: "toggle-construction-binder-visibility", binderId: "binder:top" });
      assert(!buildPartPreview(project.part).primitives.some((primitive) => primitive.id === "binder:top"), "a hidden binder is not drawn");
      // Two edge binders make a plane; deleting one of them while the plane exists is refused.
      project = run(project, { kind: "add-construction-plane", plane: { id: "construction-plane:from-binders", name: "Plane from binders", visible: true, definition: { kind: "through-two-edges", edgeA: { kind: "binder", binderId: "binder:edge" }, edgeB: { kind: "binder", binderId: "binder:edge2" } } } });
      const frame = evaluateConstructionPlane(project.part.construction![0]!, project.part.generalBodies!, [], project.part.constructionBinders!);
      assert(!("error" in frame), "a plane built on two edge binders evaluates");
      if (!("error" in frame)) { assertFrame(frame, [[0, 0, 10], [40, 30, 10]], "binder plane"); near(Math.abs(frame.normal[2]), 1, 1e-9, "it is the top plane"); }
      assert(!attempt(project, { kind: "delete-construction-binder", binderId: "binder:edge" }).ok, "a binder in use by a plane cannot be deleted");
      assert(!attempt(project, { kind: "add-construction-plane", plane: { id: "construction-plane:orphan", name: "Orphan", visible: true, definition: { kind: "through-two-edges", edgeA: { kind: "binder", binderId: "binder:nope" }, edgeB: { kind: "segment", a: [0, 0, 0], b: [1, 0, 0] } } } }).ok, "a plane on a binder that does not exist is refused");
      project = run(project, { kind: "delete-construction-binder", binderId: "binder:shape" });
      equal(project.part.constructionBinders?.length, 3, "an unused binder deletes");
      assert(!attempt(project, { kind: "delete-construction-binder", binderId: "binder:shape" }).ok, "deleting twice is refused");
    }
  }
];

/** A closed box whose +Z face is gone: a pyramid-ish solid with a sloped top, so no face resembles a flat top. */
function projectBodyWithoutTop(): GeneralSolidBody {
  const positionsMm = [0, 0, 0, 40, 0, 0, 40, 30, 0, 0, 30, 0, 20, 15, 12];
  const indices = [0, 2, 1, 0, 3, 2, 0, 1, 4, 1, 2, 4, 2, 3, 4, 3, 0, 4];
  return { id: "general-body:block", name: "block", visible: true, color: "#b9c2c8", positionsMm, indices };
}
