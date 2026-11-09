import type { GeneralSolidBody, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, isFormBody, isSurfaceBody, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { boundaryLoops, surfaceArea } from "../packages/workbench-geometry/src/surface-build.js";
import { cageIsClosed, cageFaceNormal, type SubdCage } from "../packages/workbench-geometry/src/subd.js";
import {
  formBodyOf, planBoundaryPatch, planCreateForm, planEditForm, planExtendSurface, planFinishForm, planLoftSurface, planRuledSurface, planStitch, planTrimSurface, sketchCurvesOf,
  type Planned, type SurfaceIntent
} from "../apps/studio-web/src/surface-workflow.js";
import { formCagePrimitives, runSurfaceAction, withFormCages, withSurfaceBodies, type SurfaceAction } from "../apps/studio-web/src/surface-actions.js";
import { selectionMetrics } from "../apps/studio-web/src/selection-metrics.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op | SurfaceIntent): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-surface-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}
function apply(project: WorkbenchProject, plan: Planned): WorkbenchProject {
  assert(plan.ok, `planned: ${plan.ok ? "" : (plan as { message: string }).message}`);
  return plan.operations.reduce<WorkbenchProject>((current, operation) => run(current, operation), project);
}
function sketchWith(project: WorkbenchProject, plane: "datum:xy" | "datum:xz" | "datum:yz", offsetMm: number, entities: readonly SketchEntity[], featureId: string): WorkbenchProject {
  let next = run(project, { kind: "new-design-sketch", plane, ...(plane === "datum:yz" ? { convention: "legacy" as const } : {}), ...(offsetMm === 0 ? {} : { offsetMm }) });
  for (const entity of entities) next = run(next, { kind: "add-sketch-entity", entity });
  return run(next, { kind: "commit-design-sketch", featureId, name: featureId.split(":")[1]! });
}
const circle = (id: string, radius: number): SketchEntity => ({ id, kind: "circle", center: [0, 0], radiusMm: radius, construction: false });
const bodyById = (project: WorkbenchProject, id: string): GeneralSolidBody => (project.part.generalBodies ?? []).find((body) => body.id === id)!;
const volumeOf = (body: GeneralSolidBody): number => solidMetrics(body.positionsMm, body.indices).volumeMm3;
const roundTrip = (project: WorkbenchProject): WorkbenchProject => JSON.parse(JSON.stringify(project)) as WorkbenchProject;
const isClosedAndOriented = (indices: readonly number[]): boolean => {
  const directed = new Map<string, number>();
  for (let i = 0; i + 2 < indices.length; i += 3) for (let k = 0; k < 3; k += 1) { const key = `${indices[i + k]}>${indices[i + (k + 1) % 3]}`; directed.set(key, (directed.get(key) ?? 0) + 1); }
  for (const [key, count] of directed) { const [a, b] = key.split(">"); if (count !== 1 || directed.get(`${b}>${a}`) !== 1) return false; }
  return directed.size > 0;
};

export const surfaceWorkflowTests: readonly TestCase[] = [
  {
    name: "the timeline's sketch curves are offered as 3D curves on their own planes, offsets included; construction and hidden geometry is left out",
    run: () => {
      let project = createWorkbenchProject("project:test-surface-curves");
      project = sketchWith(project, "datum:xy", 20, [circle("entity:c1", 10), { id: "entity:hidden", kind: "line", start: [0, 0], end: [5, 5], construction: true }], "feature:sk-top");
      project = sketchWith(project, "datum:xz", 3, [{ id: "entity:l1", kind: "line", start: [0, 0], end: [10, 5], construction: false }], "feature:sk-front");
      project = sketchWith(project, "datum:yz", 0, [{ id: "entity:l2", kind: "line", start: [2, 0], end: [2, 8], construction: false }], "feature:sk-side");
      const curves = sketchCurvesOf(project);
      equal(curves.length, 3, "a circle and two lines (the construction line is not offered)");
      const ring = curves.find((curve) => curve.label.includes("circle"))!;
      assert(ring.closed && ring.pointsMm.length === 73 && ring.pointsMm.every((p) => Math.abs(p[2] - 20) < 1e-9), "the circle is closed and sits 20 mm up the XY normal");
      near(Math.hypot(ring.pointsMm[10]![0], ring.pointsMm[10]![1]), 10, 1e-9, "at its radius");
      const front = curves.find((curve) => curve.sketchFeatureId === "feature:sk-front")!;
      near(front.pointsMm[1]![0], 10, 1e-9, "XZ plane: u is x");
      near(front.pointsMm[1]![2], 5, 1e-9, "XZ plane: v is z");
      near(front.pointsMm[1]![1], -3, 1e-9, "and the 3 mm offset runs along that plane's normal (-y)");
      const side = curves.find((curve) => curve.sketchFeatureId === "feature:sk-side")!;
      near(side.pointsMm[1]![1], 8, 1e-9, "YZ plane: v is y");
      near(side.pointsMm[1]![2], -2, 1e-9, "YZ plane: u runs along -z");
    }
  },
  {
    name: "ruled walls and patch caps built from sketch circles, stitched through real operations, make one closed solid of the prism's volume; the surfaces are consumed and the project round-trips",
    run: () => {
      let project = createWorkbenchProject("project:test-surface-stitch");
      project = sketchWith(project, "datum:xy", 0, [circle("entity:bottom", 10)], "feature:sk-bottom");
      project = sketchWith(project, "datum:xy", 20, [circle("entity:top", 10)], "feature:sk-top");
      const [bottom, top] = ["feature:sk-bottom", "feature:sk-top"].map((id) => sketchCurvesOf(project).find((curve) => curve.sketchFeatureId === id)!);
      project = apply(project, planRuledSurface(project, bottom!.pointsMm, top!.pointsMm, { samples: 73, rows: 6 }));
      project = apply(project, planBoundaryPatch(project, [bottom!.pointsMm], { samplesPerEdge: 73, targetEdgeMm: 3 }));
      project = apply(project, planBoundaryPatch(project, [top!.pointsMm], { samplesPerEdge: 73, targetEdgeMm: 3 }));
      const surfaces = (project.part.generalBodies ?? []).filter(isSurfaceBody);
      equal(surfaces.length, 3, "three surface bodies");
      assert(surfaces.every((body) => (body.feature?.valueMm ?? 0) > 100), "each records its area");
      assert(validateWorkbenchProject(project).ok, "a project holding open surfaces validates");
      equal(boundaryLoops({ positionsMm: surfaces[0]!.positionsMm, indices: surfaces[0]!.indices }).length, 1, "the wall is open at both ends and along its seam: one edge loop until it is stitched");
      const wall = surfaces[0]!;
      near(surfaceArea({ positionsMm: wall.positionsMm, indices: wall.indices }), 72 * 2 * 10 * Math.sin(Math.PI / 72) * 20, 0.01, "the wall's area is the 72-sided prism's");

      const partial = planStitch(project, surfaces.slice(0, 2).map((body) => body.id));
      assert(!partial.ok && partial.message.includes("do not close up"), "a wall and one cap leave an open edge, which is reported");
      const before = (project.part.generalBodies ?? []).length;
      project = apply(project, planStitch(project, surfaces.map((body) => body.id)));
      equal((project.part.generalBodies ?? []).length, before - 2, "the other two surfaces were removed");
      const solid = bodyById(project, surfaces[0]!.id);
      equal(solid.feature?.operation, "stitched-solid", "the first surface became the stitched solid");
      assert(!isSurfaceBody(solid) && isClosedAndOriented(solid.indices), "it is a closed, consistently wound mesh");
      const metrics = solidMetrics(solid.positionsMm, solid.indices);
      assert(metrics.outward, "pointing outward");
      near(metrics.volumeMm3, 0.5 * 72 * 100 * Math.sin((Math.PI * 2) / 72) * 20, 1, "with the 72-sided prism's volume");
      near(solid.feature?.valueMm ?? 0, metrics.volumeMm3, 0.01, "recorded on the body");
      const loaded = roundTrip(project);
      assert(validateWorkbenchProject(loaded).ok, "the saved and reloaded project validates");
      near(volumeOf(bodyById(loaded, solid.id)), metrics.volumeMm3, 1e-6, "and holds the same solid");
    }
  },
  {
    name: "extend and trim go through modify-general-body: an extended surface grows, a trimmed one keeps the inside of a sketch curve, and neither works on a solid",
    run: () => {
      let project = createWorkbenchProject("project:test-surface-edit");
      project = sketchWith(project, "datum:xy", 0, [{ id: "entity:a", kind: "line", start: [0, 0], end: [40, 0], construction: false }, circle("entity:ring", 8)], "feature:sk-a");
      project = sketchWith(project, "datum:xy", 0, [{ id: "entity:b", kind: "line", start: [0, 30], end: [40, 30], construction: false }], "feature:sk-b");
      const curves = sketchCurvesOf(project);
      const lineA = curves.find((curve) => curve.id.endsWith("entity:a"))!;
      const lineB = curves.find((curve) => curve.id.endsWith("entity:b"))!;
      project = apply(project, planRuledSurface(project, lineA.pointsMm, lineB.pointsMm, { samples: 21, rows: 10 }));
      const id = "general-body:ruled-1";
      near(bodyById(project, id).feature?.valueMm ?? 0, 1200, 1e-6, "a 40 x 30 ruled sheet");
      const extended = apply(project, planExtendSurface(project, id, { distanceMm: 10, nearPointMm: [40, 15, 0], windowMm: 14.9 }));
      assert((bodyById(extended, id).feature?.valueMm ?? 0) > 1200 + 10 * 20, `the sheet grew past its edge (${bodyById(extended, id).feature?.valueMm} mm2)`);
      near(Math.max(...bodyById(extended, id).positionsMm.filter((_, i) => i % 3 === 0)), 50, 1e-6, "by 10 mm");
      assert(validateWorkbenchProject(extended).ok, "the extended project validates");

      const ring = curves.find((curve) => curve.id.endsWith("entity:ring"))!;
      const shifted = ring.pointsMm.map((p) => [p[0] + 20, p[1] + 15, p[2]] as const);
      const polygonArea = 0.5 * 72 * 64 * Math.sin((Math.PI * 2) / 72);
      const trimmed = apply(project, planTrimSurface(project, id, { kind: "loop", loopMm: shifted, directionMm: [0, 0, 1], keep: "inside" }));
      near(bodyById(trimmed, id).feature?.valueMm ?? 0, polygonArea, 0.02, "trimming to the circle keeps its disc");
      const halved = apply(project, planTrimSurface(project, id, { kind: "plane", pointMm: [10, 0, 0], normalMm: [1, 0, 0], keep: "negative" }));
      near(bodyById(halved, id).feature?.valueMm ?? 0, 10 * 30, 1e-6, "a plane at x = 10 keeps a 10 x 30 strip");
      assert(validateWorkbenchProject(halved).ok && validateWorkbenchProject(trimmed).ok, "all of them validate");

      const loft = apply(project, planLoftSurface(project, [lineA.pointsMm, [[0, 15, 12], [40, 15, 12]], lineB.pointsMm], { samples: 9, rows: 4 }));
      assert((loft.part.generalBodies ?? []).some((body) => body.id === "general-body:loft-1"), "a three-curve loft is added too");

      // A solid is not a surface.
      const formed = apply(project, planCreateForm(project, { kind: "box", widthMm: 10, depthMm: 10, heightMm: 10 }));
      const solidPlan = planExtendSurface(formed, "general-body:form-1", { distanceMm: 2 });
      assert(!solidPlan.ok && solidPlan.message.includes("not a surface"), "extend refuses a form");
      assert(!planTrimSurface(project, "general-body:nope", { kind: "plane", pointMm: [0, 0, 0], normalMm: [1, 0, 0], keep: "positive" }).ok, "a missing body is reported");
      assert(!planStitch(project, []).ok && !planStitch(formed, ["general-body:form-1"]).ok, "stitch needs surfaces");
    }
  },
  {
    name: "a SubD form is created, edited through its cage (move, extrude, edge loop, levels), finished into a solid, and survives save and reload; an open form is not finished",
    run: () => {
      let project = createWorkbenchProject("project:test-form");
      project = apply(project, planCreateForm(project, { kind: "box", widthMm: 20, depthMm: 20, heightMm: 20 }, 3));
      const id = "general-body:form-1";
      let form = bodyById(project, id);
      assert(isFormBody(form) && form.feature?.operation === "subd-form" && form.subd?.faces.length === 6, "a box form with a six-face cage");
      assert(isClosedAndOriented(form.indices) && form.positionsMm.length / 3 > 300, "subdivided to a smooth, closed mesh");
      const rounded = volumeOf(form);
      assert(rounded > 0 && rounded < 8000 * 0.5, `the smooth form (${rounded.toFixed(0)} mm3) is rounder than its 8000 mm3 cage`);

      project = apply(project, planEditForm(project, id, { kind: "move", vertexIds: [4, 5, 6, 7], deltaMm: [0, 0, 10] }));
      form = bodyById(project, id);
      assert(Math.max(...form.positionsMm.filter((_, i) => i % 3 === 2)) > 14, "moving the top vertices lifted the form");
      assert(volumeOf(form) > rounded * 1.3, "and it holds more");

      const cage: SubdCage = { verticesMm: form.subd!.verticesMm, faces: form.subd!.faces };
      const topFace = cage.faces.findIndex((_, face) => cageFaceNormal(cage, face)[2] > 0.99);
      const beforeFaces = form.subd!.faces.length;
      project = apply(project, planEditForm(project, id, { kind: "extrude", faceIds: [topFace], distanceMm: 12, insetMm: 3 }));
      form = bodyById(project, id);
      equal(form.subd!.faces.length, beforeFaces + 4, "extruding a face added its four sides");
      project = apply(project, planEditForm(project, id, { kind: "edge-loop", a: 0, b: 4, ratio: 0.3 }));
      form = bodyById(project, id);
      assert(form.subd!.faces.length > beforeFaces + 4, "an edge loop added faces");
      assert(cageIsClosed({ verticesMm: form.subd!.verticesMm, faces: form.subd!.faces }), "the cage is still closed");
      project = apply(project, planEditForm(project, id, { kind: "levels", levels: 2 }));
      equal(bodyById(project, id).subd!.levels, 2, "the subdivision level changed");
      assert(bodyById(project, id).positionsMm.length < form.positionsMm.length, "and the mesh is lighter");
      assert(validateWorkbenchProject(project).ok, "the project with a form validates");
      const loaded = roundTrip(project);
      assert(validateWorkbenchProject(loaded).ok && bodyById(loaded, id).subd?.faces.length === bodyById(project, id).subd?.faces.length, "a saved form keeps its cage");

      assert(!planEditForm(project, id, { kind: "move", vertexIds: [999], deltaMm: [1, 0, 0] }).ok, "an edit that names a missing vertex is refused");
      assert(!planEditForm(project, id, { kind: "extrude", faceIds: [], distanceMm: 5 }).ok, "an empty extrusion is refused");
      assert(!planEditForm(project, id, { kind: "levels", levels: 9 }).ok, "too many levels are refused");

      const sketchless = apply(createWorkbenchProject("project:test-form-open"), planCreateForm(createWorkbenchProject("project:test-form-open"), { kind: "plane", widthMm: 30, depthMm: 30, columns: 3, rows: 3 }, 2));
      const refused = planFinishForm(sketchless, "general-body:form-1");
      assert(!refused.ok && refused.message.includes("open"), "an open form cannot be finished into a solid");

      const volumeBefore = volumeOf(bodyById(project, id));
      project = apply(project, planFinishForm(project, id));
      const solid = bodyById(project, id);
      assert(!isFormBody(solid) && solid.feature?.operation === "subd-solid" && solid.subd === undefined, "finishing drops the cage");
      assert(isClosedAndOriented(solid.indices) && solidMetrics(solid.positionsMm, solid.indices).outward, "and leaves a closed outward solid");
      near(volumeOf(solid), volumeBefore, 1e-6, "of the volume the form had");
      assert(!planEditForm(project, id, { kind: "levels", levels: 1 }).ok, "a finished solid is no longer an editable form");
      assert(validateWorkbenchProject(roundTrip(project)).ok, "and still saves and reloads");
    }
  },
  {
    name: "bodies that carry a cage or a surface are validated on every route in: a damaged cage, an unknown modifier or a stray key is refused",
    run: () => {
      const project = createWorkbenchProject("project:test-surface-validation");
      const built = formBodyOf("general-body:form-v", "Form", { verticesMm: [-1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1], faces: [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [2, 3, 7, 6], [1, 2, 6, 5], [3, 0, 4, 7]] }, 1);
      assert(built.ok, "a form builds");
      if (!built.ok) return;
      const good = applyWorkbenchOperation(project, { kind: "add-general-body", body: built.body, operationId: "operation:test-surface-v1", expectedRevision: project.revision } as WorkbenchOperation);
      assert(good.ok, "a well-formed form is accepted");
      const wrongFace = { ...built.body, subd: { ...built.body.subd!, faces: [[0, 1, 99]] } };
      assert(!applyWorkbenchOperation(project, { kind: "add-general-body", body: wrongFace, operationId: "operation:test-surface-v2", expectedRevision: project.revision } as WorkbenchOperation).ok, "a cage face naming a missing vertex is refused");
      const wrongLevels = { ...built.body, subd: { ...built.body.subd!, levels: 9 } };
      assert(!applyWorkbenchOperation(project, { kind: "add-general-body", body: wrongLevels, operationId: "operation:test-surface-v3", expectedRevision: project.revision } as WorkbenchOperation).ok, "subdivision levels above 5 are refused");
      const extra = { ...built.body, subd: { ...built.body.subd!, crease: 1 } };
      assert(!applyWorkbenchOperation(project, { kind: "add-general-body", body: extra, operationId: "operation:test-surface-v4", expectedRevision: project.revision } as unknown as WorkbenchOperation).ok, "a stray key inside the cage is refused");
      if (!good.ok) return;
      const bad = applyWorkbenchOperation(good.value.project, { kind: "modify-general-body", targetBodyId: "general-body:form-v", modifier: "melt", label: "x", body: built.body, operationId: "operation:test-surface-v5", expectedRevision: good.value.project.revision } as unknown as WorkbenchOperation);
      assert(!bad.ok, "an unknown modifier is refused");
      const wrongOperation = { ...built.body, feature: { operation: "teleport" as never, plane: "xy" as const, valueMm: 1 } };
      assert(!applyWorkbenchOperation(project, { kind: "add-general-body", body: wrongOperation, operationId: "operation:test-surface-v6", expectedRevision: project.revision } as WorkbenchOperation).ok, "an unknown body operation is refused");
      // Saved projects go through the same checks.
      const saved = JSON.parse(JSON.stringify(good.value.project)) as WorkbenchProject;
      const damaged = { ...saved, part: { ...saved.part, generalBodies: [{ ...saved.part.generalBodies![0]!, subd: { ...saved.part.generalBodies![0]!.subd!, faces: [[0, 1, 99]] } }] } } as WorkbenchProject;
      assert(!validateWorkbenchProject(damaged).ok, "a saved project with a damaged cage does not load");
    }
  },
  {
    name: "the Surface workspace buttons drive the planners from their prompts: curves picked by number, bad answers reported, cancel does nothing, and surfaces and forms read back with the right metrics and scene",
    run: () => {
      let project = createWorkbenchProject("project:test-surface-actions");
      project = sketchWith(project, "datum:xy", 0, [{ id: "entity:a", kind: "line", start: [0, 0], end: [30, 0], construction: false }], "feature:sk-a");
      project = sketchWith(project, "datum:xy", 0, [{ id: "entity:b", kind: "line", start: [0, 20], end: [30, 20], construction: false }], "feature:sk-b");
      const answers = (...texts: (string | null)[]) => { let at = 0; return (): string | null => texts[at++] ?? null; };
      const act = (action: SurfaceAction, selectedId: string | null, ...texts: (string | null)[]) => { const next = answers(...texts); return runSurfaceAction(action, { project, selectedId, ask: () => next() }); };
      const ruled = act("ruled", null, "1, 2");
      assert("ok" in ruled && ruled.ok, "ruled from curves 1 and 2");
      if ("ok" in ruled && ruled.ok) project = ruled.operations.reduce<WorkbenchProject>((current, operation) => run(current, operation), project);
      const bad = act("ruled", null, "1, 9");
      assert("ok" in bad && !bad.ok && bad.message.includes("1 to 2"), "a curve number that does not exist is reported with the range");
      assert("cancelled" in act("ruled", null, null), "cancelling the prompt does nothing");
      const wrongCount = act("ruled", null, "1");
      assert("ok" in wrongCount && !wrongCount.ok, "ruled needs two curves");
      const surfaceId = "general-body:ruled-1";
      const metrics = selectionMetrics(project, surfaceId);
      assert(metrics !== undefined && metrics.metrics[0]!.includes("Surface (open mesh)") && metrics.metrics[0]!.includes("600"), "a surface reads as an open mesh with its area, not a volume");
      const extend = act("extend", surfaceId, "5");
      assert("ok" in extend && extend.ok, "extend from the selection and a distance");
      assert("ok" in act("extend", surfaceId, "-3") && !(act("extend", surfaceId, "-3") as { ok: boolean }).ok, "a negative distance is reported");
      const trim = act("trim", surfaceId, "plane", "x 10");
      assert("ok" in trim && trim.ok, "trim by a plane at x 10");
      if ("ok" in trim && trim.ok) near(((trim.operations[0] as { body: GeneralSolidBody }).body.feature?.valueMm) ?? 0, 400, 1e-6, "keeps the 20 x 20 side with larger x");
      assert("ok" in act("trim", surfaceId, "plane", "q 10") && !(act("trim", surfaceId, "plane", "q 10") as { ok: boolean }).ok, "an unknown axis is reported");
      const lone = act("trim", null, "plane", "x 10");
      assert("ok" in lone && lone.ok, "with a single surface in the part, Trim uses it even when nothing is selected");
      const stitch = act("stitch", null, "all");
      assert("ok" in stitch && !stitch.ok && stitch.message.includes("do not close up"), "one open sheet cannot be stitched, and the message says so");

      const form = act("form-new", null, "40, 30, 20");
      assert("ok" in form && form.ok, "a box form from three sizes");
      if ("ok" in form && form.ok) project = form.operations.reduce<WorkbenchProject>((current, operation) => run(current, operation), project);
      const formId = "general-body:form-1";
      const formMetrics = selectionMetrics(project, formId);
      assert(formMetrics !== undefined && formMetrics.metrics[0]!.includes("SubD form") && formMetrics.metrics[0]!.includes("8 cage vertices"), "a form reads as a SubD form with its cage size");
      const move = act("form-edit", formId, "move", "4, 5, 6, 7", "0, 0, 8");
      assert("ok" in move && move.ok, "move cage vertices by prompt");
      assert("ok" in act("form-edit", formId, "polish") && !(act("form-edit", formId, "polish") as { ok: boolean }).ok, "an unknown edit is reported");
      const finish = act("form-finish", formId);
      assert("ok" in finish && finish.ok, "finish the selected form");
      assert(formCagePrimitives(project).length === 6, "the cage is drawn as six face loops");
      const scene = { id: "s", kind: "surface" as const, primitives: [], boundsMm: { min: [0, 0, 0] as const, max: [1, 1, 1] as const, size: [1, 1, 1] as const } };
      const surfaceScene = withSurfaceBodies(scene, project);
      equal(surfaceScene.primitives.length, 8, "the Surface scene shows the sheet, the form and its six cage loops");
      assert(surfaceScene.boundsMm.max[0] >= 30, "and its bounds grew to hold them");
      equal(withFormCages({ ...scene, kind: "part" }, project).primitives.length, 6, "the Part scene gets the cage lines");
    }
  }
];
