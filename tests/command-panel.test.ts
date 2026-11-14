import type { DesignSketchFeature, DesignSolidFeature, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, EDGE_BLEND_MAX_GROUPS, validateWorkbenchProject, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { describePickedEdge, pickableEdges, type PickableEdge } from "../packages/workbench-geometry/src/index.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { facesOfBody } from "../apps/studio-web/src/edge-blend-step.js";
import { applyParameterValues, parameterValuesOf } from "../apps/studio-web/src/feature-parameters.js";
import {
  openCommandPanel, openCommandPanelForEdit, panelAddFace, panelClearSelection, panelDraft, panelEdgeGroups,
  panelFields, panelSelectionRow, panelSetHolePoint, panelToggleEdge, panelWithValue, type CommandPanelState, type PanelEdgeSet
} from "../apps/studio-web/src/command-panel.js";
import { assert, near, type TestCase } from "./test-kit.js";
import { isClosedAndOriented } from "./relief-pick-hole-drag.test.js";

/**
 * PT-06 / PT-11 / PT-12: the shared modeless command panel. Fillet and Chamfer collect several edge runs into one
 * edge-blend step, Shell takes its open faces and thickness, Hole takes a face point, a free diameter and a type that can
 * be changed later — and Edit Feature reopens the same panel filled. The commit path runs the typed values through
 * `applyParameterValues`, the same parser and validator the edit dialog uses.
 */

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-panel-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value.project;
}

const BODY = "general-body:panel-block";
const rectangle = (width: number, height: number): SketchEntity => ({ id: "entity:outline", kind: "rectangle", center: [0, 0], widthMm: width, heightMm: height, rotationDeg: 0, construction: false });
const volumeOf = (body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => solidMetrics(body.positionsMm, body.indices).volumeMm3;
const bodyOf = (project: WorkbenchProject) => project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;

async function blockProject(): Promise<{ project: WorkbenchProject; sketch: DesignSketchFeature }> {
  let project = createWorkbenchProject(`project:test-panel-${serial += 1}`);
  project = { ...project, sketch: { ...project.sketch, entities: [rectangle(60, 40)], constraints: [] } };
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const sketch = designOf(project).features[0] as DesignSketchFeature;
  const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 20, bodyId: BODY };
  const built = await rebuildSolidFeature(extrude, sketch);
  assert(built.ok, `the block builds: ${built.ok ? "" : built.message}`);
  if (!built.ok) throw new Error("unreachable");
  project = run(project, { kind: "add-design-solid", feature: extrude, body: built.body });
  return { project, sketch };
}

async function addAndReplay(project: WorkbenchProject, feature: DesignSolidFeature): Promise<WorkbenchProject> {
  const added = run(project, { kind: "add-design-solid", feature, body: bodyOf(project) });
  const results = await replayAllBodies(added);
  const failed = results.find((result) => result.featureId === feature.id && result.message !== undefined);
  assert(failed === undefined, `the ${feature.id} step replays: ${failed?.message ?? ""}`);
  return run(added, { kind: "regenerate-design", results });
}

/** Simulates a viewport click on an edge chain: the chain's segments become one panel edge set, as App.handlePanelPick builds it. */
function edgePickOf(project: WorkbenchProject, chainOrdinal: number): PanelEdgeSet {
  const body = bodyOf(project);
  const edges = pickableEdges({ positionsMm: body.positionsMm, indices: body.indices }, 5, { includeConcave: true });
  assert(typeof edges !== "string", typeof edges === "string" ? edges : "");
  if (typeof edges === "string") throw new Error("unreachable");
  const chains = [...new Set(edges.map((edge) => edge.chain))];
  const chain = chains[chainOrdinal]!;
  const chainEdges: readonly PickableEdge[] = edges.filter((edge) => edge.chain === chain);
  return {
    bodyId: body.id, chain, group: describePickedEdge(chainEdges, facesOfBody(body)),
    segments: chainEdges.map((edge) => [edge.a, edge.b] as const), summary: "an edge"
  };
}

export const commandPanelTests: readonly TestCase[] = [
  {
    name: "Fillet takes several edge runs in one feature: two picked chains become one edge-blend step whose both runs cut material, and it survives a reload",
    run: async () => {
      const { project: base, sketch } = await blockProject();
      const solid = volumeOf(bodyOf(base));
      let state = openCommandPanel("fillet");
      state = panelToggleEdge(state, edgePickOf(base, 0), "Block");
      state = panelToggleEdge(state, edgePickOf(base, 1), "Block");
      assert(state.edges.length === 2 && state.bodyId === BODY, "two picked chains are two edge sets on one body");
      assert(panelSelectionRow(state).status.startsWith("2 edge runs"), `the selection row says what is picked: ${panelSelectionRow(state).status}`);
      state = panelWithValue(state, "size", "2");
      const draft = panelDraft(state, { sketchFeatureId: sketch.id });
      assert(draft.ok, draft.ok ? "" : draft.message);
      if (!draft.ok) return;
      const applied = applyParameterValues(draft.feature, state.values, base);
      assert(applied.ok, applied.ok ? "" : applied.message);
      if (!applied.ok) return;
      const feature = applied.feature;
      assert(feature.kind === "edge-blend" && feature.blendType === "fillet" && feature.blendEdges!.length === 2 && feature.valueMm === 2, "one step holds both runs and the typed radius");
      assert(validSolidFeaturePayload(feature), "the step passes the saved-project validator");
      const project = await addAndReplay(base, feature);
      const body = bodyOf(project);
      assert(isClosedAndOriented(body.indices), "the filleted block is closed");
      // Two R2 fillets along 40 mm edges each remove about (4 − π) r² / 4 · length ≈ 34 mm³.
      const removed = solid - volumeOf(body);
      near(removed, 2 * (4 - Math.PI) / 4 * 4 * 40, removed * 0.4, `both runs removed material: ${removed.toFixed(1)} mm³`);
      const saved = validateWorkbenchProject(JSON.parse(JSON.stringify(project)));
      assert(saved.ok, "the project with the two-run step round-trips");
    }
  },
  {
    name: "The panel's edge set behaves like Fusion's: a second click on a run removes it, a pick on another body restarts the set, and the set is capped",
    run: async () => {
      const { project } = await blockProject();
      let state = openCommandPanel("chamfer");
      const pick = edgePickOf(project, 0);
      state = panelToggleEdge(state, pick, "Block");
      state = panelToggleEdge(state, pick, "Block");
      assert(state.edges.length === 0, "clicking the same run again removes it");
      state = panelToggleEdge(state, pick, "Block");
      const otherBody: PanelEdgeSet = { ...edgePickOf(project, 1), bodyId: "general-body:other" };
      state = panelToggleEdge(state, otherBody, "Other");
      assert(state.edges.length === 1 && state.edges[0]!.bodyId === "general-body:other", "a pick on another body restarts the set there");
      assert(state.error !== undefined, "the restart is said out loud");
      let crowded = openCommandPanel("fillet");
      for (let index = 0; index < EDGE_BLEND_MAX_GROUPS; index += 1) crowded = panelToggleEdge(crowded, { ...pick, chain: index + 1000 }, "Block");
      const over = panelToggleEdge(crowded, { ...pick, chain: 5000 }, "Block");
      assert(over.edges.length === EDGE_BLEND_MAX_GROUPS && over.error !== undefined, "the set is capped with a reason, nothing is dropped silently");
      const cleared = panelClearSelection(over);
      assert(cleared.edges.length === 0, "the clear button empties the row");
    }
  },
  {
    name: "Edit Feature reopens the same panel filled: the stored runs are kept without a re-pick, the size takes a new value, and an old one-run record keeps loading",
    run: async () => {
      const { project: base, sketch } = await blockProject();
      // An old record the earlier one-edge flow wrote: one run, radius 2.
      const oneRun: DesignSolidFeature = {
        id: "feature:edge-blend-legacy", name: "Fillet R 2 mm", kind: "edge-blend", suppressed: false,
        sketchFeatureId: sketch.id, profileIds: [], valueMm: 2, bodyId: BODY, operation: "direct-edit",
        blendType: "fillet", blendEdges: [edgePickOf(base, 2).group]
      };
      const project = await addAndReplay(base, oneRun);
      const edited = openCommandPanelForEdit(designOf(project).features.find((candidate) => candidate.id === oneRun.id) as DesignSolidFeature, "Block");
      assert(edited !== undefined && edited.command === "fillet" && edited.mode === "edit", "double-clicking the step opens the fillet panel in edit mode");
      if (edited === undefined) return;
      assert(edited.values["size"] === "2", `the panel opens filled with the stored radius: ${edited.values["size"]}`);
      assert(panelSelectionRow(edited).status.includes("1 stored edge run"), "the stored run shows in the selection row");
      const resized = panelWithValue(edited, "size", "4");
      assert(panelEdgeGroups(resized).length === 1, "without a re-pick the stored run is kept");
      const draft = panelDraft(resized, { sketchFeatureId: sketch.id, existing: oneRun });
      assert(draft.ok, draft.ok ? "" : draft.message);
      if (!draft.ok) return;
      const applied = applyParameterValues(draft.feature, resized.values, project);
      assert(applied.ok, applied.ok ? "" : applied.message);
      if (!applied.ok) return;
      assert(applied.feature.id === oneRun.id && applied.feature.valueMm === 4 && applied.feature.blendEdges!.length === 1, "the edit keeps the step's identity and runs, with the new radius");
      assert(/R 4/.test(applied.feature.name), `the step's name follows the new size: ${applied.feature.name}`);
    }
  },
  {
    name: "Chamfer's fields cover two distances and distance-and-angle, through the same validator as the edit dialog",
    run: async () => {
      const { project, sketch } = await blockProject();
      let state = openCommandPanel("chamfer");
      state = panelToggleEdge(state, edgePickOf(project, 0), "Block");
      state = panelWithValue(state, "size", "5");
      state = panelWithValue(state, "second", "2");
      const draft = panelDraft(state, { sketchFeatureId: sketch.id });
      assert(draft.ok, draft.ok ? "" : draft.message);
      if (!draft.ok) return;
      const twoDistances = applyParameterValues(draft.feature, state.values, project);
      assert(twoDistances.ok && twoDistances.feature.blendSecondSizeMm === 2 && twoDistances.feature.valueMm === 5, "a 5 × 2 chamfer stores both distances");
      const angled = applyParameterValues(draft.feature, { ...state.values, second: "0", angle: "30" }, project);
      assert(angled.ok && angled.feature.blendAngleDeg === 30 && angled.feature.blendSecondSizeMm === undefined, "a 5 @ 30° chamfer stores the angle instead");
      const refused = applyParameterValues(draft.feature, { ...state.values, size: "-3" }, project);
      assert(!refused.ok, "a negative distance is refused with a message, not committed");
    }
  },
  {
    name: "Shell runs through the panel: picked open faces and a typed thickness become one timeline step, and edit reopens it filled",
    run: async () => {
      const { project: base, sketch } = await blockProject();
      const solid = volumeOf(bodyOf(base));
      let state = openCommandPanel("shell");
      state = { ...panelAddFace(state, { ref: { pointMm: [0, 0, 20], normalMm: [0, 0, 1] }, summary: "top" }), bodyId: BODY, bodyName: "Block" };
      assert(panelSelectionRow(state).status === "1 selected", "the picked face shows in the selection row");
      state = panelWithValue(state, "wall", "2");
      const draft = panelDraft(state, { sketchFeatureId: sketch.id });
      assert(draft.ok, draft.ok ? "" : draft.message);
      if (!draft.ok) return;
      const applied = applyParameterValues(draft.feature, state.values, base);
      assert(applied.ok, applied.ok ? "" : applied.message);
      if (!applied.ok) return;
      const feature = applied.feature;
      assert(feature.kind === "shell" && feature.bodyEdit?.kind === "shell" && feature.bodyEdit.thicknessMm === 2 && feature.bodyEdit.openFaces.length === 1, "the step records the wall and the open face");
      assert(feature.name.startsWith("Shell · "), `the step names itself: ${feature.name}`);
      const project = await addAndReplay(base, feature);
      const hollowed = volumeOf(bodyOf(project));
      assert(hollowed < solid * 0.45, `the block is hollowed out: ${hollowed.toFixed(0)} of ${solid.toFixed(0)} mm³ left`);
      const edited = openCommandPanelForEdit(designOf(project).features.find((candidate) => candidate.id === feature.id) as DesignSolidFeature, "Block");
      assert(edited !== undefined && edited.command === "shell" && edited.values["wall"] === "2" && edited.faces.length === 1, "edit reopens the shell panel with the wall and the stored face");
    }
  },
  {
    name: "Hole runs through the panel: a face point, a free diameter and a type; the type can be changed at edit, which the old dialog refused",
    run: async () => {
      const { project: base, sketch } = await blockProject();
      const solid = volumeOf(bodyOf(base));
      let state = openCommandPanel("hole");
      state = panelSetHolePoint(state, [10, 5, 20], [0, 0, 1], BODY, "Block");
      assert(state.values["position"] === "10, 5, 20", "the picked point fills the position field");
      state = panelWithValue(state, "style", "counterbore");
      assert(state.values["counterDiameter"] !== undefined, "choosing counterbore seeds its pocket fields so none starts empty");
      state = panelWithValue(state, "diameter", "5.5");
      const draft = panelDraft(state, { sketchFeatureId: sketch.id });
      assert(draft.ok, draft.ok ? "" : draft.message);
      if (!draft.ok) return;
      const applied = applyParameterValues(draft.feature, state.values, base);
      assert(applied.ok, applied.ok ? "" : applied.message);
      if (!applied.ok) return;
      const feature = applied.feature;
      assert(feature.kind === "hole" && feature.holeStyle === "counterbore" && feature.holeDiameterMm === 5.5 && feature.holeCounterDiameterMm === 11, "a Ø 5.5 counterbore at the picked point — not a fastener table entry");
      const project = await addAndReplay(base, feature);
      const removed = solid - volumeOf(bodyOf(project));
      // The Ø 5.5 bore through 20 mm plus the Ø 11 pocket ring (outside the bore) over its 4 mm depth.
      const bore = Math.PI * 2.75 * 2.75 * 20 + Math.PI * (5.5 * 5.5 - 2.75 * 2.75) * 4;
      near(removed, bore, bore * 0.1, `the bore and its pocket are cut: ${removed.toFixed(1)} mm³`);

      // PT-12: the type is editable later. The old edit dialog changed numbers only; the panel swaps the style and its fields.
      const stored = designOf(project).features.find((candidate) => candidate.id === feature.id) as DesignSolidFeature;
      const edited = openCommandPanelForEdit(stored, "Block");
      assert(edited !== undefined && edited.values["style"] === "counterbore" && edited.holePoint !== undefined, "edit reopens the hole panel with its type and point");
      if (edited === undefined) return;
      const switched = panelWithValue(edited, "style", "countersink");
      const redraft = panelDraft(switched, { sketchFeatureId: sketch.id, existing: stored });
      assert(redraft.ok, redraft.ok ? "" : redraft.message);
      if (!redraft.ok) return;
      const reapplied = applyParameterValues(redraft.feature, switched.values, project);
      assert(reapplied.ok, reapplied.ok ? "" : reapplied.message);
      if (!reapplied.ok) return;
      assert(reapplied.feature.holeStyle === "countersink" && reapplied.feature.holeSinkDiameterMm === 12 && reapplied.feature.holeCounterDiameterMm === undefined, "the type change swaps the style fields and drops the old ones");
      assert(validSolidFeaturePayload(reapplied.feature), "the switched hole passes the validator");
    }
  },
  {
    name: "The panel refuses an empty commit with a reason, and its fields read back the same ids the edit dialog uses",
    run: async () => {
      const { sketch } = await blockProject();
      const empty = panelDraft(openCommandPanel("fillet"), { sketchFeatureId: sketch.id });
      assert(!empty.ok && /Pick in the 3D view/.test(empty.ok ? "" : empty.message), "a fillet with nothing picked refuses with a reason");
      const noPoint = panelDraft({ ...openCommandPanel("hole"), bodyId: BODY }, { sketchFeatureId: sketch.id });
      assert(!noPoint.ok && /face where the hole/.test(noPoint.ok ? "" : noPoint.message), "a hole with no start point refuses with a reason");
      // The field ids match the edit dialog's, so a stored step's values drop straight into the panel.
      const feature: DesignSolidFeature = {
        id: "feature:edge-blend-x", name: "Chamfer 3 mm", kind: "edge-blend", suppressed: false,
        sketchFeatureId: sketch.id, profileIds: [], valueMm: 3, bodyId: BODY, operation: "direct-edit",
        blendType: "chamfer", blendEdges: [{ segments: [[[0, 0, 0], [1, 0, 0]]] }]
      };
      const panel = openCommandPanelForEdit(feature, undefined);
      assert(panel !== undefined, "a chamfer step opens the chamfer panel");
      if (panel === undefined) return;
      const dialogValues = parameterValuesOf(feature);
      for (const field of panelFields(panel)) {
        assert(panel.values[field.id] !== undefined, `the panel has a value for its own field ${field.id}`);
        if (dialogValues[field.id] !== undefined) assert(panel.values[field.id] === dialogValues[field.id], `${field.id} matches the edit dialog's value`);
      }
    }
  }
];
