import type { DesignSketchFeature, DesignSolidFeature, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, validateWorkbenchProject, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { METRIC_FASTENERS } from "../packages/workbench-geometry/src/index.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { applyParameterValues } from "../apps/studio-web/src/feature-parameters.js";
import { openCommandPanel, panelDraft, panelFields, panelSetHolePoint, panelWithValue, type CommandPanelState } from "../apps/studio-web/src/command-panel.js";
import { assert, near, type TestCase } from "./test-kit.js";

/**
 * PT-16: the M-series fastener table is back for timeline bodies, as a size preset inside the Hole panel. Choosing M3 to
 * M10 fills the clearance diameter, the counterbore pocket, the countersink head, and for a tapped hole the tap-drill
 * diameter with the ISO coarse pitch — the numbers the user otherwise types from memory. The free typed values stay the
 * primary path, and a hand-typed size puts the select back to "custom" so it never claims a size the numbers left.
 */

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-fastener-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value.project;
}

const BODY = "general-body:fastener-plate";
const rectangle = (width: number, height: number): SketchEntity => ({ id: "entity:outline", kind: "rectangle", center: [0, 0], widthMm: width, heightMm: height, rotationDeg: 0, construction: false });
const volumeOf = (body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => solidMetrics(body.positionsMm, body.indices).volumeMm3;
const bodyOf = (project: WorkbenchProject) => project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;

async function plateProject(): Promise<{ project: WorkbenchProject; sketch: DesignSketchFeature }> {
  let project = createWorkbenchProject(`project:test-fastener-${serial += 1}`);
  project = { ...project, sketch: { ...project.sketch, entities: [rectangle(60, 40)], constraints: [] } };
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const sketch = designOf(project).features[0] as DesignSketchFeature;
  const extrude: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: sketch.id, profileIds: [], valueMm: 20, bodyId: BODY };
  const built = await rebuildSolidFeature(extrude, sketch);
  assert(built.ok, `the plate builds: ${built.ok ? "" : built.message}`);
  if (!built.ok) throw new Error("unreachable");
  project = run(project, { kind: "add-design-solid", feature: extrude, body: built.body });
  return { project, sketch };
}

/** The committed feature a panel state produces, through the same draft + parser path App.commitCommandPanel uses. */
function featureOf(state: CommandPanelState, sketch: DesignSketchFeature, project: WorkbenchProject): DesignSolidFeature {
  const draft = panelDraft(state, { sketchFeatureId: sketch.id });
  assert(draft.ok, draft.ok ? "" : draft.message);
  if (!draft.ok) throw new Error("unreachable");
  const applied = applyParameterValues(draft.feature, state.values, project);
  assert(applied.ok, applied.ok ? "" : applied.message);
  if (!applied.ok) throw new Error("unreachable");
  return applied.feature;
}

export const holeFastenerPresetTests: readonly TestCase[] = [
  {
    name: "The Hole panel offers every M-series size beside the free values, and choosing one fills the fields of the current type",
    run: () => {
      let state = openCommandPanel("hole");
      const fastenerField = panelFields(state).find((field) => field.id === "fastener");
      assert(fastenerField !== undefined && fastenerField.kind === "select", "the panel has a fastener-size select");
      const options = (fastenerField?.options ?? []).map((option) => option.value);
      assert(options[0] === "custom", "free typed sizes stay the first choice");
      for (const size of Object.keys(METRIC_FASTENERS)) assert(options.includes(size), `${size} is offered`);
      assert(state.values["fastener"] === "custom", "the panel opens on custom sizes, as before this round");
      // M6 clearance: Ø 6.6 replaces the generic 6 without touching the depth.
      state = panelWithValue(state, "fastener", "M6");
      assert(state.values["diameter"] === "6.6", `M6 fills the clearance diameter: ${state.values["diameter"]}`);
      assert(state.values["depth"] === "0", "the through-everything depth is left alone");
      // Switching to counterbore with M6 chosen fills the socket-head pocket from the table, not the generic defaults.
      state = panelWithValue(state, "style", "counterbore");
      assert(state.values["counterDiameter"] === "11" && state.values["counterDepth"] === "6.5", `the M6 pocket comes from the table: Ø ${state.values["counterDiameter"]} × ${state.values["counterDepth"]}`);
      // Countersink: head diameter and the 90° included angle.
      state = panelWithValue(state, "style", "countersink");
      assert(state.values["sinkDiameter"] === "12.6" && state.values["sinkAngle"] === "90", `the M6 countersink comes from the table: Ø ${state.values["sinkDiameter"]} @ ${state.values["sinkAngle"]}°`);
      // A hand-typed diameter means custom again; the select never claims a size the numbers no longer match.
      state = panelWithValue(state, "diameter", "7");
      assert(state.values["fastener"] === "custom", "typing a size by hand puts the fastener select back to custom");
      assert(state.values["sinkDiameter"] === "12.6", "the other seeded numbers stay as typed values the user can edit");
    }
  },
  {
    name: "A tapped M-size fills the tap-drill diameter, the ISO coarse pitch and the nominal crest — M6 gives the numbers the finding says users had to know",
    run: () => {
      let state = openCommandPanel("hole");
      state = panelWithValue(state, "thread", "modelled");
      state = panelWithValue(state, "fastener", "M6");
      near(Number(state.values["diameter"]), 4.92, 0.001, `the M6 tap-drill (minor) diameter is filled: ${state.values["diameter"]}`);
      assert(state.values["threadPitch"] === "1", `the M6 coarse pitch is filled: ${state.values["threadPitch"]}`);
      // M8 shows the table scales: pitch 1.25, minor 8 − 1.0825 × 1.25.
      state = panelWithValue(state, "fastener", "M8");
      assert(state.values["threadPitch"] === "1.25", `the M8 coarse pitch is filled: ${state.values["threadPitch"]}`);
      near(Number(state.values["diameter"]), 6.65, 0.001, `the M8 tap-drill diameter is filled: ${state.values["diameter"]}`);
    }
  },
  {
    name: "An M6 counterbore from the preset commits as a timeline step on an extruded plate: the table geometry is cut, and the project round-trips",
    run: async () => {
      const { project: base, sketch } = await plateProject();
      const solid = volumeOf(bodyOf(base));
      let state = openCommandPanel("hole");
      state = panelSetHolePoint(state, [10, 5, 20], [0, 0, 1], BODY, "Plate");
      state = panelWithValue(state, "style", "counterbore");
      state = panelWithValue(state, "fastener", "M6");
      const feature = featureOf(state, sketch, base);
      assert(feature.kind === "hole" && feature.holeStyle === "counterbore" && feature.holeDiameterMm === 6.6 && feature.holeCounterDiameterMm === 11 && feature.holeCounterDepthMm === 6.5, "the step stores the M6 table numbers");
      assert(validSolidFeaturePayload(feature), "the step passes the saved-project validator");
      const added = run(base, { kind: "add-design-solid", feature, body: bodyOf(base) });
      const results = await replayAllBodies(added);
      const failed = results.find((result) => result.featureId === feature.id && result.message !== undefined);
      assert(failed === undefined, `the hole replays: ${failed?.message ?? ""}`);
      const project = run(added, { kind: "regenerate-design", results });
      const removed = solid - volumeOf(bodyOf(project));
      // The Ø 6.6 bore through 20 mm plus the Ø 11 pocket ring outside it over its 6.5 mm depth.
      const bore = Math.PI * 3.3 * 3.3 * 20 + Math.PI * (5.5 * 5.5 - 3.3 * 3.3) * 6.5;
      near(removed, bore, bore * 0.1, `the M6 counterbore is cut: ${removed.toFixed(1)} mm³`);
      const saved = validateWorkbenchProject(JSON.parse(JSON.stringify(project)));
      assert(saved.ok, "the project with the preset hole round-trips through save and load");
    }
  },
  {
    name: "A tapped M8 from the preset stores a thread whose crest is the nominal size, through the same parser the edit dialog uses",
    run: async () => {
      const { project: base, sketch } = await plateProject();
      let state = openCommandPanel("hole");
      state = panelSetHolePoint(state, [0, 0, 20], [0, 0, 1], BODY, "Plate");
      state = panelWithValue(state, "thread", "modelled");
      state = panelWithValue(state, "fastener", "M8");
      const feature = featureOf(state, sketch, base);
      assert(feature.kind === "hole" && feature.holeThread !== undefined, "the step stores a thread");
      near(feature.holeDiameterMm ?? 0, 6.65, 0.001, `the hole itself is the tap-drill diameter: ${feature.holeDiameterMm}`);
      assert(feature.holeThread?.pitchMm === 1.25, `the stored pitch is the M8 coarse pitch: ${feature.holeThread?.pitchMm}`);
      assert(feature.holeThread?.majorDiameterMm === 8, `the thread crest lands on the nominal 8 mm: ${feature.holeThread?.majorDiameterMm}`);
      assert(validSolidFeaturePayload(feature), "the tapped step passes the saved-project validator");
    }
  }
];
