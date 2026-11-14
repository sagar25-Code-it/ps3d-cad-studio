import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { analyseModelRows, groupModelParameterRows, modelParameterRowsOf, modelValueEditsOf } from "../apps/studio-web/src/parameter-rows.js";
import { ChangeParametersDialog } from "../apps/studio-web/src/ui/ChangeParametersDialog.js";
import { applyWorkbenchOperation, createWorkbenchProject, designOf, modelValueRowsOf, parameterNameProblem, previewDimensionExpression, validateWorkbenchProject, type DesignSketchFeature, type DesignSolidFeature, type WorkbenchOperation, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { body, param, volume } from "./design-parameters.test.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** HS-08 and HS-22: model parameters in the Change Parameters table, edited in place with the user parameters in one change; log, ln and exp. */

let serial = 0;
const attempt = (project: WorkbenchProject, operation: Record<string, unknown> & { readonly kind: string }) => {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-model-${serial}`, expectedRevision: project.revision } as unknown as WorkbenchOperation);
};
const run = (project: WorkbenchProject, operation: Record<string, unknown> & { readonly kind: string }): WorkbenchProject => {
  const result = attempt(project, operation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
};
const refusal = (project: WorkbenchProject, operation: Record<string, unknown> & { readonly kind: string }): string => {
  const result = attempt(project, operation);
  assert(!result.ok, `${operation.kind} is refused`);
  return result.diagnostics[0]?.message ?? "";
};

const BODY = "general-body:plate";
const extrudeStep: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 10, bodyId: BODY };

/** A 60 x 40 plate whose width and height are dimensions of its sketch (d1, d2), extruded 10 mm, built through the real replay. */
async function dimensionedPlate(): Promise<WorkbenchProject> {
  let project = run(createWorkbenchProject("project:test-model-values"), { kind: "new-design-sketch", plane: "datum:xy" });
  project = run(project, { kind: "add-sketch-entity", entity: { id: "entity:outline", kind: "rectangle", center: [0, 0], widthMm: 60, heightMm: 40, rotationDeg: 0, construction: false } });
  project = run(project, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "width", valueMm: 60 });
  project = run(project, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "height", valueMm: 40 });
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const staged: WorkbenchProject = { ...project, design: { ...designOf(project), features: [...designOf(project).features, extrudeStep], rollbackIndex: 2 } };
  const first = (await replayAllBodies(staged)).find((result) => result.body !== undefined);
  assert(first?.body !== undefined, "the plate builds");
  return run(project, { kind: "add-design-solid", feature: extrudeStep, body: first.body });
}

const sketchOf = (project: WorkbenchProject): DesignSketchFeature => designOf(project).features.find((feature): feature is DesignSketchFeature => feature.kind === "sketch")!;
const rectangleWidth = (project: WorkbenchProject): number => { const entity = sketchOf(project).sketch.entities.find((candidate) => candidate.id === "entity:outline"); return entity?.kind === "rectangle" ? entity.widthMm : Number.NaN; };
const distanceOf = (project: WorkbenchProject): number => (designOf(project).features.find((feature) => feature.id === "feature:extrude-1") as DesignSolidFeature).valueMm;
const widthDimension = (project: WorkbenchProject) => sketchOf(project).sketch.constraints.find((constraint) => constraint.kind === "distance" && constraint.dimension === "width")!;

export const modelParameterTests: readonly TestCase[] = [
  {
    name: "The model parameters list every step number and every driving sketch dimension, grouped by step, with the unit and the current text",
    run: async () => {
      const project = await dimensionedPlate();
      const rows = modelValueRowsOf(project);
      const sketchRows = rows.filter((row) => row.groupKind === "sketch");
      const stepRows = rows.filter((row) => row.groupKind === "step");
      equal(sketchRows.map((row) => row.name).join(","), "d1,d2", "the two dimensions of Sketch 1 by their own names");
      assert(sketchRows.every((row) => row.group === "Sketch 1" && row.unit === "mm"), "grouped under the sketch, in mm");
      equal(sketchRows.map((row) => row.value).join(","), "60,40", "with their values");
      equal(stepRows.map((row) => `${row.group}/${row.name}`).join(","), "Extrude 1/Distance", "the extrude's distance is a row");
      equal(stepRows[0]!.text, "10", "unbound, it shows its number");
      const grouped = groupModelParameterRows(modelParameterRowsOf(project));
      equal(grouped.map((group) => group.group).join(","), "Sketch 1,Extrude 1", "in timeline order, one group per step");
      equal(modelValueEditsOf(modelParameterRowsOf(project)).length, 0, "an untouched table sends no edit");
    }
  },
  {
    name: "A step number typed in the table is set, or bound when it is an expression, in the same change as the parameters, and follows a later parameter change",
    run: async () => {
      let project = await dimensionedPlate();
      const before = project.revision;
      // One Apply: a new parameter and the extrude distance bound to it.
      project = run(project, { kind: "set-design-parameters", parameters: [param("plate_t", "14")], modelValues: [{ ownerId: "feature:extrude-1", fieldId: "distance", text: "plate_t" }] });
      equal(project.revision, before + 1, "the table is one change, so one Undo step");
      equal(distanceOf(project), 14, "the distance took the parameter's value");
      equal((designOf(project).features.find((feature) => feature.id === "feature:extrude-1") as DesignSolidFeature).expressions?.["distance"], "plate_t", "and stays bound to it");
      project = run(project, { kind: "set-design-parameters", parameters: [param("plate_t", "20")] });
      equal(distanceOf(project), 20, "a later parameter change moves it");
      // A plain number typed over the expression unbinds the field.
      project = run(project, { kind: "set-design-parameters", parameters: [param("plate_t", "20")], modelValues: [{ ownerId: "feature:extrude-1", fieldId: "distance", text: "7" }] });
      equal(distanceOf(project), 7, "a plain number sets the value");
      equal((designOf(project).features.find((feature) => feature.id === "feature:extrude-1") as DesignSolidFeature).expressions, undefined, "and unbinds it");
      const rebuiltResults = await replayAllBodies(project);
      const rebuilt = run(project, { kind: "regenerate-design", results: rebuiltResults });
      near(volume(rebuilt), 60 * 40 * 7, 60 * 40 * 7 * 0.01, "the rebuilt solid is 7 mm thick");
      assert(validateWorkbenchProject(JSON.parse(JSON.stringify(rebuilt))).ok, "it saves and loads");
    }
  },
  {
    name: "A sketch dimension typed in the table moves the sketch and the solid built on it; as an expression it follows its parameter",
    run: async () => {
      let project = await dimensionedPlate();
      const width = widthDimension(project);
      project = run(project, { kind: "set-design-parameters", parameters: [], modelValues: [{ ownerId: "feature:sketch-1", fieldId: width.id, text: "80" }] });
      equal(rectangleWidth(project), 80, "the timeline sketch's rectangle is 80 wide now");
      equal(widthDimension(project).valueMm, 80, "and the dimension holds 80");
      let rebuilt = run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });
      near(volume(rebuilt), 80 * 40 * 10, 80 * 40 * 10 * 0.01, "the extrude built on it follows");
      project = run(project, { kind: "set-design-parameters", parameters: [param("plate_w", "70")], modelValues: [{ ownerId: "feature:sketch-1", fieldId: width.id, text: "plate_w" }] });
      equal(rectangleWidth(project), 70, "an expression sets the width from the parameter");
      equal(widthDimension(project).expression, "plate_w", "and the dimension keeps the expression");
      project = run(project, { kind: "set-design-parameters", parameters: [param("plate_w", "90")] });
      equal(rectangleWidth(project), 90, "a parameter change moves the sketch");
      rebuilt = run(project, { kind: "regenerate-design", results: await replayAllBodies(project) });
      near(volume(rebuilt), 90 * 40 * 10, 90 * 40 * 10 * 0.01, "and the solid");
      assert(body(rebuilt).positionsMm.length > 0, "the body is still there");
    }
  },
  {
    name: "A model value that does not work refuses the whole change with the reason and leaves the project as it was",
    run: async () => {
      const project = await dimensionedPlate();
      const width = widthDimension(project);
      const unknown = refusal(project, { kind: "set-design-parameters", parameters: [param("a", "1")], modelValues: [{ ownerId: "feature:extrude-1", fieldId: "distance", text: "nothing_here * 2" }] });
      assert(unknown.includes("nothing_here"), `an unknown name is named: ${unknown}`);
      assert(refusal(project, { kind: "set-design-parameters", parameters: [], modelValues: [{ ownerId: "feature:extrude-1", fieldId: "distance", text: "0" }] }).includes("Distance"), "a distance of zero is refused by the step's own limits");
      assert(refusal(project, { kind: "set-design-parameters", parameters: [], modelValues: [{ ownerId: "feature:sketch-1", fieldId: width.id, text: "5 +" }] }).length > 0, "a half-typed expression is refused");
      assert(refusal(project, { kind: "set-design-parameters", parameters: [], modelValues: [{ ownerId: "feature:extrude-1", fieldId: "nope", text: "3" }] }).includes("nope"), "a field the step does not have is refused");
      assert(refusal(project, { kind: "set-design-parameters", parameters: [], modelValues: [{ ownerId: "feature:gone", fieldId: "distance", text: "3" }] }).includes("feature:gone"), "a step that is not there is refused");
      assert(refusal(project, { kind: "set-design-parameters", parameters: [], modelValues: [{ ownerId: "feature:sketch-1", fieldId: width.id, text: "d9 * 2" }] }).length > 0, "a dimension name that does not exist is refused");
      equal(rectangleWidth(project), 60, "nothing changed");
    }
  },
  {
    name: "The table reports each changed model row live (value or reason) and sends only the rows that changed",
    run: async () => {
      const project = await dimensionedPlate();
      const rows = modelParameterRowsOf(project);
      const distance = rows.find((row) => row.name === "Distance")!;
      const edited = rows.map((row) => row.key === distance.key ? { ...row, typed: "2 * 6" } : row.name === "d1" ? { ...row, typed: "oops(" } : row);
      const report = analyseModelRows(project, edited);
      equal(report[distance.key]?.valueText, "12 mm", "a changed row shows what it gives");
      assert((report[rows.find((row) => row.name === "d1")!.key]?.problem ?? "").length > 0, "a broken one shows why");
      equal(Object.keys(report).length, 2, "an unchanged row has no report");
      const edits = modelValueEditsOf(edited);
      equal(edits.map((edit) => edit.text).sort().join("|"), "2 * 6|oops(", "only the changed rows are sent");
    }
  },
  {
    name: "The Change Parameters dialog shows the model parameters by step and offers Apply (stays open) beside OK",
    run: async () => {
      const project = await dimensionedPlate();
      const html = renderToStaticMarkup(createElement(ChangeParametersDialog, { open: true, project, busy: false, onApply: () => Promise.resolve(undefined), onClose: () => undefined }));
      assert(html.includes("Model parameters") && html.includes("Sketch 1") && html.includes("Extrude 1"), "the section lists the steps by name");
      assert(html.includes('aria-label="Expression of Extrude 1 Distance"') && html.includes('aria-label="Expression of Sketch 1 d1"'), "each number has an editable expression cell");
      assert(/>Apply<\/button>/u.test(html) && />OK<\/button>/u.test(html) || html.includes("OK</button>"), "Apply and OK are both there");
      assert(!html.includes("Apply and rebuild"), "the old single button is replaced");
    }
  },
  {
    name: "log (base 10), ln and exp are functions of plain numbers, refuse bad input, and stay free as parameter names",
    run: async () => {
      const project = await dimensionedPlate();
      const value = (text: string): string => { const preview = previewDimensionExpression(project, text); return preview.ok ? preview.text : `refused: ${preview.message}`; };
      equal(value("10 mm * log(100)"), "20 mm", "log is the base-10 logarithm");
      equal(value("1 mm * ln(exp(3))"), "3 mm", "ln undoes exp");
      equal(value("2 mm * exp(0)"), "2 mm", "exp of zero is one");
      assert(value("log(0) * 1 mm").startsWith("refused:"), "log of zero is refused");
      assert(value("ln(-2) * 1 mm").startsWith("refused:"), "ln of a negative is refused");
      assert(value("log(5 mm) * 1 mm").includes("plain number"), "log of a length is refused with the reason");
      assert(value("exp(1000) * 1 mm").startsWith("refused:"), "an overflow is refused");
      assert(parameterNameProblem("exp") === undefined && parameterNameProblem("log") === undefined, "a file that uses exp or log as a parameter name still loads");
      assert(parameterNameProblem("sqrt") !== undefined, "the older function names stay reserved");
    }
  },
];
