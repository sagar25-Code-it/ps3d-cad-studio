import type { DesignSketchFeature, DesignSolidFeature, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, bindFeatureExpressions, createWorkbenchProject, designOf, validFeatureExpressions, validSolidFeaturePayload } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { describePickedEdge, pickableEdges } from "../packages/workbench-geometry/src/index.js";
import { rebuildSolidFeature, replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { facesOfBody } from "../apps/studio-web/src/edge-blend-step.js";
import { applyParameterValues } from "../apps/studio-web/src/feature-parameters.js";
import { openCommandPanel, panelDraft, panelToggleEdge, panelWithValue } from "../apps/studio-web/src/command-panel.js";
import { param } from "./design-parameters.test.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * PT-13: numeric feature fields accept parameter names and expressions through the existing dimension-expression code.
 * Fillet / chamfer sizes (edge-blend) and the face-picked body edits (general shell, draft, offset region, web, wrap) are
 * now bindable, so an expression typed at creation in the command panel, or at edit, follows the parameter table; the
 * general Shell's wall no longer falls through to a property the step does not carry.
 */

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-bindx-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value.project;
}

const BODY = "general-body:bindx-block";
const rectangle = (width: number, height: number): SketchEntity => ({ id: "entity:outline", kind: "rectangle", center: [0, 0], widthMm: width, heightMm: height, rotationDeg: 0, construction: false });
const volumeOf = (body: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number => solidMetrics(body.positionsMm, body.indices).volumeMm3;
const bodyOf = (project: WorkbenchProject) => project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;
const featureById = (project: WorkbenchProject, id: string): DesignSolidFeature => designOf(project).features.find((candidate) => candidate.id === id) as DesignSolidFeature;

async function blockProject(): Promise<{ project: WorkbenchProject; sketch: DesignSketchFeature }> {
  let project = createWorkbenchProject(`project:test-bindx-${serial += 1}`);
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

const rebuilt = async (project: WorkbenchProject): Promise<WorkbenchProject> => run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });

export const featureBindingExtrasTests: readonly TestCase[] = [
  {
    name: "A fillet radius typed as an expression in the command panel binds to the parameter and follows a parameter change through the rebuild",
    run: async () => {
      const { project: base, sketch } = await blockProject();
      const withParam = run(base, { kind: "set-design-parameters", parameters: [param("bead", "2")] });
      const body = bodyOf(withParam);
      const edges = pickableEdges({ positionsMm: body.positionsMm, indices: body.indices }, 5, { includeConcave: true });
      assert(typeof edges !== "string", typeof edges === "string" ? edges : "");
      if (typeof edges === "string") return;
      const chain = edges.filter((edge) => edge.chain === edges[0]!.chain);
      let state = openCommandPanel("fillet");
      state = panelToggleEdge(state, { bodyId: BODY, chain: edges[0]!.chain, group: describePickedEdge(chain, facesOfBody(body)), segments: chain.map((edge) => [edge.a, edge.b] as const), summary: "an edge" }, "Block");
      state = panelWithValue(state, "size", "bead * 2");
      const draft = panelDraft(state, { sketchFeatureId: sketch.id });
      assert(draft.ok, draft.ok ? "" : draft.message);
      if (!draft.ok) return;
      const applied = applyParameterValues({ ...draft.feature, id: "feature:fillet-expr" }, state.values, withParam);
      assert(applied.ok, applied.ok ? "" : applied.message);
      if (!applied.ok) return;
      equal(applied.feature.valueMm, 4, "bead * 2 evaluates to 4 mm now");
      equal(applied.feature.expressions?.["size"], "bead * 2", "the expression is stored on the step");
      assert(validSolidFeaturePayload(applied.feature), "the bound step passes the validator");
      assert(validFeatureExpressions("edge-blend", applied.feature.expressions), "edge-blend sizes are known bindable fields");
      let project = run(withParam, { kind: "add-design-solid", feature: applied.feature, body });
      project = await rebuilt(project);
      const before = volumeOf(bodyOf(project));
      project = run(project, { kind: "set-design-parameters", parameters: [param("bead", "3")] });
      project = await rebuilt(project);
      equal(featureById(project, "feature:fillet-expr").valueMm, 6, "bead = 3 drives the radius to 6 mm");
      assert(volumeOf(bodyOf(project)) < before, "the bigger fillet removed more material after the parameter change");
    }
  },
  {
    name: "The general Shell's wall binds to a parameter (it used to be refused because the binding wrote a property the step does not carry)",
    run: async () => {
      const { project: base, sketch } = await blockProject();
      const withParam = run(base, { kind: "set-design-parameters", parameters: [param("wall_p", "2")] });
      const shell: DesignSolidFeature = {
        id: "feature:shell-bound", name: "Shell · 1 mm wall inside · 1 face open", kind: "shell", suppressed: false,
        sketchFeatureId: sketch.id, profileIds: [], valueMm: 1, bodyId: BODY, operation: "direct-edit",
        bodyEdit: { kind: "shell", thicknessMm: 1, side: "inside", openFaces: [{ pointMm: [0, 0, 20], normalMm: [0, 0, 1] }] }
      };
      const bound = bindFeatureExpressions(withParam, shell, { wall: "wall_p + 1" });
      assert(bound.ok, `the wall expression binds: ${bound.ok ? "" : bound.message}`);
      if (!bound.ok) return;
      assert(bound.feature.bodyEdit?.kind === "shell" && bound.feature.bodyEdit.thicknessMm === 3, `the wall lands in the step's own spec: ${JSON.stringify(bound.feature.bodyEdit)}`);
      assert(validSolidFeaturePayload(bound.feature), "the bound shell passes the validator (this is the case that used to be refused)");
      let project = run(withParam, { kind: "add-design-solid", feature: bound.feature, body: bodyOf(withParam) });
      project = await rebuilt(project);
      const walls3 = volumeOf(bodyOf(project));
      project = run(project, { kind: "set-design-parameters", parameters: [param("wall_p", "4")] });
      project = await rebuilt(project);
      const walls5 = volumeOf(bodyOf(project));
      assert(featureById(project, "feature:shell-bound").bodyEdit?.kind === "shell" && (featureById(project, "feature:shell-bound").bodyEdit as { thicknessMm: number }).thicknessMm === 5, "wall_p = 4 drives the wall to 5 mm");
      assert(walls5 > walls3, `thicker walls leave more material: ${walls3.toFixed(0)} → ${walls5.toFixed(0)} mm³`);
      near(walls3, 60 * 40 * 20 - 54 * 34 * 17, walls3 * 0.05, "a 3 mm open-top shell leaves the expected material");
    }
  },
  {
    name: "A chamfer's second distance and a draft's body-edit angle are bindable, and a zero-size expression is refused with the field named",
    run: async () => {
      const { project, sketch } = await blockProject();
      const withParam = run(project, { kind: "set-design-parameters", parameters: [param("step_w", "2"), param("tilt_p", "3", "deg")] });
      const chamfer: DesignSolidFeature = {
        id: "feature:chamfer-bound", name: "Chamfer 5 mm", kind: "edge-blend", suppressed: false,
        sketchFeatureId: sketch.id, profileIds: [], valueMm: 5, bodyId: BODY, operation: "direct-edit",
        blendType: "chamfer", blendEdges: [{ segments: [[[0, 0, 0], [1, 0, 0]]] }]
      };
      const second = bindFeatureExpressions(withParam, chamfer, { second: "step_w" });
      assert(second.ok && second.feature.blendSecondSizeMm === 2, "the chamfer's second distance binds");
      const zero = bindFeatureExpressions(withParam, chamfer, { size: "step_w - 2" });
      assert(!zero.ok && /Size/.test(zero.ok ? "" : zero.message), `a zero size is refused naming the field: ${zero.ok ? "" : zero.message}`);
      const draft: DesignSolidFeature = {
        id: "feature:draft-bound", name: "Draft · 3° about Z", kind: "draft", suppressed: false,
        sketchFeatureId: sketch.id, profileIds: [], valueMm: 3, bodyId: BODY, operation: "direct-edit",
        bodyEdit: { kind: "draft", angleDeg: 3, pullDirection: [0, 0, 1], neutralPointMm: [0, 0, 0], faces: [{ pointMm: [30, 0, 10], normalMm: [1, 0, 0] }] }
      };
      const leaned = bindFeatureExpressions(withParam, draft, { angle: "tilt_p + 1" });
      assert(leaned.ok, `the draft angle binds: ${leaned.ok ? "" : leaned.message}`);
      if (!leaned.ok) return;
      assert(leaned.feature.bodyEdit?.kind === "draft" && leaned.feature.bodyEdit.angleDeg === 4, "the general draft's angle binds into its spec");
    }
  }
];
