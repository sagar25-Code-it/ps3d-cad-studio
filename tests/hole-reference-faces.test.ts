import type { DesignSketchFeature, DesignSolidFeature, GeneralSolidBody, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, bindFeatureExpressions, createWorkbenchProject, designOf } from "../packages/workbench-core/src/index.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { faceName, faceOutline, holePlacementFor, placementReferences, planarFacesOf, repickedPlacement } from "../apps/studio-web/src/hole-placement.js";
import { openCommandPanelForEdit, panelDraft, panelFields, panelSelectionRow, panelWithValue } from "../apps/studio-web/src/command-panel.js";
import { applyParameterValues } from "../apps/studio-web/src/feature-parameters.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** HS-15 review: the faces a hole is measured from are named, outlined (segments), and can be chosen again; the hole does not move when they are. */

const BODY = "general-body:block";
const HOLE_AT: readonly [number, number, number] = [10, 5, 20];
let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-holerefs-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

const outline: SketchEntity = { id: "entity:outline", kind: "rectangle", center: [0, 0], widthMm: 60, heightMm: 40, rotationDeg: 0, construction: false };
const bodyOf = (project: WorkbenchProject): GeneralSolidBody => project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;
const holeOf = (project: WorkbenchProject): DesignSolidFeature => designOf(project).features.find((feature): feature is DesignSolidFeature => feature.id === "feature:hole-1")!;

async function plateWithHole(): Promise<WorkbenchProject> {
  let project = createWorkbenchProject("project:test-hole-refs");
  project = { ...project, sketch: { ...project.sketch, entities: [outline], constraints: [] } };
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const sketch = designOf(project).features[0] as DesignSketchFeature;
  const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 20, bodyId: BODY };
  const built = await rebuildSolidFeature(extrude, sketch);
  assert(built.ok, "the plate builds");
  if (!built.ok) throw new Error("unreachable");
  project = run(project, { kind: "add-design-solid", feature: extrude, body: built.body });
  const placement = holePlacementFor(bodyOf(project), HOLE_AT, [0, 0, 1])!;
  const hole: DesignSolidFeature = {
    id: "feature:hole-1", name: "Hole 6", kind: "hole", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 6, bodyId: BODY,
    operation: "direct-edit", holeStyle: "simple", holePositionMm: HOLE_AT, holeNormal: [0, 0, 1], holeDiameterMm: 6, holeDepthMm: 0, holePlacement: placement
  };
  const added = run(project, { kind: "add-design-solid", feature: hole, body: bodyOf(project) });
  return run(added, { kind: "regenerate-design", results: await replayAllBodies(added) });
}

const resize = (project: WorkbenchProject, width: number, height: number): WorkbenchProject => {
  let next = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-1" });
  next = run(next, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "width", valueMm: width });
  next = run(next, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "height", valueMm: height });
  return run(next, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
};

/** Where the hole's wall is: the middle of the vertices of the faces the hole step named. */
function wallCentre(body: GeneralSolidBody): readonly [number, number] {
  const brep = body.brep!;
  const wall = new Set(brep.faces.map((face, index) => face.role.includes("feature:hole-1.wall") ? index : -1).filter((index) => index >= 0));
  let x = 0; let y = 0; let count = 0;
  brep.faceTriangles.forEach((face, triangle) => {
    if (!wall.has(face)) return;
    for (let corner = 0; corner < 3; corner += 1) { const base = body.indices[triangle * 3 + corner]! * 3; x += body.positionsMm[base]!; y += body.positionsMm[base + 1]!; count += 1; }
  });
  assert(count > 0, "the hole's wall is in the body");
  return [x / count, y / count];
}

const sideOf = (name: string): string => name.split(" (")[0]!;

export const holeReferenceFaceTests: readonly TestCase[] = [
  {
    name: "Faces are named by the side they look to and where they are; the hole's faces and the faces it could be measured from are listed with their distances",
    run: async () => {
      const project = await plateWithHole();
      const body = bodyOf(project);
      const names = planarFacesOf(body).map(faceName).sort();
      assert(names.includes("Top face (z = 20 mm)") && names.includes("Bottom face (z = 0 mm)") && names.includes("Right face (x = 30 mm)") && names.includes("Left face (x = -30 mm)") && names.includes("Back face (y = 20 mm)") && names.includes("Front face (y = -20 mm)"), `the six faces: ${names.join(" | ")}`);
      equal(faceName({ key: "k", role: "r", normal: [0.7071, 0.7071, 0], offset: 3 }), "Angled face", "a face square to no axis");
      // After the hole the plate's faces carry the target. prefix, and the placement still finds them.
      const refs = placementReferences(holeOf(project).holePlacement!, body)!;
      assert(refs !== undefined, "the references resolve on the holed solid");
      equal(sideOf(refs.start.name), "Top face", "it starts on the top face");
      equal(refs.current.map((choice) => sideOf(choice.name)).join(" + "), "Back face + Right face", "and is measured from the back and the right face");
      equal(refs.current.map((choice) => Number(choice.distanceMm.toFixed(3))).join(","), "15,20", "15 mm and 20 mm inside them");
      equal(refs.choices.map((choice) => `${sideOf(choice.name)} ${Number(choice.distanceMm.toFixed(1))}`).join(", "), "Back face 15, Right face 20, Front face 25, Left face 40", "the four side faces, nearest first, each with the hole's distance");
    }
  },
  {
    name: "A face outline is the closed border of that face, and a face that is not there has none",
    run: async () => {
      const project = await plateWithHole();
      const body = bodyOf(project);
      const refs = placementReferences(holeOf(project).holePlacement!, body)!;
      const right = refs.current[1];
      const segments = faceOutline(body, right);
      assert(segments.length >= 4, `the right face has a border: ${segments.length} segments`);
      assert(segments.every(([a, b]) => Math.abs(a[0] - 30) < 1e-6 && Math.abs(b[0] - 30) < 1e-6), "every segment lies in the plane x = 30");
      const ends = new Map<string, number>();
      for (const [a, b] of segments) for (const end of [a, b]) { const key = end.map((value) => value.toFixed(3)).join(","); ends.set(key, (ends.get(key) ?? 0) + 1); }
      assert([...ends.values()].every((count) => count % 2 === 0), "the border is a closed loop: every corner is met an even number of times");
      equal(faceOutline(body, { faceKey: "face:gone", faceRole: "face.gone" }).length, 0, "a face that is gone has no outline");
    }
  },
  {
    name: "The Hole panel names both faces, offers the others, and choosing one keeps the hole where it is and measures from the new face",
    run: async () => {
      let project = await plateWithHole();
      const hole = holeOf(project);
      const refs = placementReferences(hole.holePlacement!, bodyOf(project))!;
      let state = openCommandPanelForEdit(hole, "Body 1", refs)!;
      const fields = panelFields(state);
      const face = (id: string) => fields.find((field) => field.id === id);
      assert(face("faceA")?.kind === "select" && face("faceB")?.kind === "select", "two selects choose the measuring faces");
      equal(face("faceA")!.options!.length, 4, "each lists the four side faces");
      equal(face("offsetA")!.label, "Distance from the Back face", "the distances say which face they are measured from");
      assert(panelSelectionRow(state).status.includes("measured from the Back face and the Right face"), `the selection row names them: ${panelSelectionRow(state).status}`);
      const front = refs.choices.find((choice) => sideOf(choice.name) === "Front face")!;
      state = panelWithValue(state, "faceA", front.faceKey);
      equal(state.values["offsetA"], "25", "choosing the front face fills its distance: the hole is already 25 mm inside it");
      equal(panelFields(state).find((field) => field.id === "offsetA")!.label, "Distance from the Front face", "and the label follows the choice");
      const draft = panelDraft(state, { sketchFeatureId: hole.sketchFeatureId, existing: hole });
      assert(draft.ok, `the draft is accepted: ${draft.ok ? "" : draft.message}`);
      if (!draft.ok) return;
      const applied = applyParameterValues(draft.feature, state.values, project);
      assert(applied.ok, `the values apply: ${applied.ok ? "" : applied.message}`);
      if (!applied.ok) return;
      equal(applied.feature.holePlacement!.from[0].faceKey, front.faceKey, "the first measuring face is now the front face");
      near(applied.feature.holePlacement!.from[0].distanceMm, 25, 1e-6, "25 mm from it");
      assert(applied.feature.holePlacement!.from[1].faceKey === hole.holePlacement!.from[1].faceKey, "the second face is untouched");
      project = run(project, { kind: "update-design-solid", feature: applied.feature, body: bodyOf(project) });
      project = run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });
      const same = wallCentre(bodyOf(project));
      near(same[0], 10, 0.5, "the hole did not move in x"); near(same[1], 5, 0.5, "or in y");
      // Grow the plate: the hole now follows the front face (y = -20 becomes -30, so the hole is at y = -5), not the back face.
      const grown = resize(project, 90, 60);
      const replayed = run(grown, { kind: "regenerate-design", results: await replayAllBodies(grown) });
      const after = wallCentre(bodyOf(replayed));
      near(after[0], 25, 0.5, "x follows the right face"); near(after[1], -30 + 25, 0.5, "y follows the front face it is now measured from");
    }
  },
  {
    name: "Two measuring faces that are the same, or face the same way, are refused with a reason; a number bound to a parameter is let go with its old face",
    run: async () => {
      const project = await plateWithHole();
      const hole = holeOf(project);
      const refs = placementReferences(hole.holePlacement!, bodyOf(project))!;
      const open = (values: Readonly<Record<string, string>>) => {
        let state = openCommandPanelForEdit(hole, "Body 1", refs)!;
        for (const [field, text] of Object.entries(values)) state = panelWithValue(state, field, text);
        return panelDraft(state, { sketchFeatureId: hole.sketchFeatureId, existing: hole });
      };
      const left = refs.choices.find((choice) => sideOf(choice.name) === "Left face")!;
      const back = refs.choices.find((choice) => sideOf(choice.name) === "Back face")!;
      const parallel = open({ faceA: left.faceKey });
      assert(!parallel.ok && parallel.message.includes("face the same way"), `the left and right faces cannot pin a point together: ${parallel.ok ? "" : parallel.message}`);
      const same = open({ faceB: back.faceKey });
      assert(!same.ok && same.message.includes("Pick two different faces"), `the same face twice: ${same.ok ? "" : same.message}`);
      const direct = repickedPlacement(hole.holePlacement!, refs, { first: left });
      assert(!direct.ok, "the pure rule refuses the same pair");
      // A bound number does not survive the face it was measured from.
      let bound = run(project, { kind: "set-design-parameters", parameters: [{ name: "inset", expression: "15", unit: "mm", comment: "" }] });
      const withBinding = bindFeatureExpressions(bound, holeOf(bound), { offsetA: "inset" });
      assert(withBinding.ok, "offsetA binds to a parameter");
      if (!withBinding.ok) return;
      bound = run(bound, { kind: "update-design-solid", feature: withBinding.feature, body: bodyOf(bound) });
      const boundHole = holeOf(bound);
      const front = refs.choices.find((choice) => sideOf(choice.name) === "Front face")!;
      let state = openCommandPanelForEdit(boundHole, "Body 1", refs)!;
      state = panelWithValue(state, "faceA", front.faceKey);
      const draft = panelDraft(state, { sketchFeatureId: boundHole.sketchFeatureId, existing: boundHole });
      assert(draft.ok && draft.feature.expressions?.["offsetA"] === undefined, "the binding to 'inset' is dropped when the face it measured from is replaced");
    }
  },
  {
    name: "A hole panel without references (a bare-point hole, or one whose faces are gone) shows no face choices and keeps its old labels",
    run: async () => {
      const project = await plateWithHole();
      const hole = holeOf(project);
      const bare = { ...hole } as DesignSolidFeature;
      const { holePlacement: _gone, ...unplaced } = bare;
      void _gone;
      const state = openCommandPanelForEdit(unplaced, "Body 1")!;
      assert(!panelFields(state).some((field) => field.id === "faceA"), "no face selects without a placement");
      const noRefs = openCommandPanelForEdit(hole, "Body 1")!;
      const labels = panelFields(noRefs).filter((field) => field.id.startsWith("offset")).map((field) => field.label);
      equal(labels.join(" | "), "Distance from the first face | Distance from the second face", "the numbered labels remain when the solid cannot name the faces");
      assert(placementReferences({ ...hole.holePlacement!, face: { faceKey: "face:gone", faceRole: "face.gone" } }, bodyOf(project)) === undefined, "a placement whose start face is gone has no references");
    }
  },
];
