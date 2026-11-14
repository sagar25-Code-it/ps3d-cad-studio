import { bindTypedSize } from "../apps/studio-web/src/feature-parameters.js";
import { answerOnViewText } from "../apps/studio-web/src/ui/on-view-input.js";
import { designOf, previewFieldExpression, validateWorkbenchProject, type DesignSolidFeature, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyOp, refusedOp, tetra } from "./history-kit.js";
import { committedSketch, rect } from "./pipeline-kit.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** HS-07: a size typed when a step is created may be a parameter name or a formula, and the new step stays bound to it. */

const fresh = (): WorkbenchProject => {
  const { project } = committedSketch("datum:xy", [rect("plate", 0, 0, 60, 40)], { featureId: "feature:s1" });
  return applyOp(project, { kind: "set-design-parameters", parameters: [{ name: "plate_h", expression: "30", unit: "mm", comment: "" }, { name: "turn", expression: "90", unit: "deg", comment: "" }] });
};

const extrude = (extra: Partial<DesignSolidFeature> = {}): DesignSolidFeature => ({ id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:s1", profileIds: [], valueMm: 10, bodyId: "general-body:one", ...extra });

export const typedSizeBindingTests: readonly TestCase[] = [
  {
    name: "A plain size stays a plain number; a parameter name or formula binds the new Extrude to it and takes its value",
    run: () => {
      const project = fresh();
      const plain = bindTypedSize(project, extrude(), "12,5");
      assert(plain.ok && plain.feature.expressions === undefined && plain.feature.valueMm === 10, "a plain number is left to the caller and binds nothing");
      const named = bindTypedSize(project, extrude(), "plate_h");
      assert(named.ok, "the parameter name is accepted");
      equal(named.ok && named.feature.valueMm, 30, "the size is the parameter's value");
      equal(named.ok && named.feature.expressions?.["distance"], "plate_h", "and the step keeps the text as the expression of its distance");
      const formula = bindTypedSize(project, extrude(), "plate_h / 2 + 1 mm");
      equal(formula.ok && formula.feature.valueMm, 16, "a formula is evaluated with its units");
      const revolve = bindTypedSize(project, extrude({ kind: "revolve", name: "Revolve 1", valueMm: 360 }), "turn * 2");
      equal(revolve.ok && revolve.feature.valueMm, 180, "a revolve binds its angle");
      assert(revolve.ok && revolve.feature.expressions?.["angle"] === "turn * 2", "under the name of its angle field");
    }
  },
  {
    name: "A size that does not evaluate is refused with the evaluator's reason, and nothing is changed",
    run: () => {
      const project = fresh();
      const unknown = bindTypedSize(project, extrude(), "missing_name * 2");
      assert(!unknown.ok && unknown.message.includes("missing_name"), `an unknown name is named: ${unknown.ok ? "" : unknown.message}`);
      const tooBig = bindTypedSize(project, extrude(), "plate_h * 100000");
      assert(!tooBig.ok, "a size outside what the step supports is refused");
      const notStep = bindTypedSize(project, extrude({ kind: "sweep", name: "Sweep 1" }), "plate_h");
      assert(!notStep.ok, "a kind with no bound size takes a plain number here");
    }
  },
  {
    name: "The bound step is added to the timeline, follows a parameter change, and survives save and reload",
    run: () => {
      const project = fresh();
      const bound = bindTypedSize(project, extrude(), "plate_h");
      assert(bound.ok, "bound");
      const added = applyOp(project, { kind: "add-design-solid", feature: bound.feature, body: tetra("general-body:one") });
      const stepOf = (candidate: WorkbenchProject): DesignSolidFeature => designOf(candidate).features.find((feature): feature is DesignSolidFeature => feature.id === "feature:extrude-1")!;
      equal(stepOf(added).valueMm, 30, "the step starts at the parameter's value");
      const changed = applyOp(added, { kind: "set-design-parameters", parameters: [{ name: "plate_h", expression: "45", unit: "mm", comment: "" }, { name: "turn", expression: "90", unit: "deg", comment: "" }] });
      equal(stepOf(changed).valueMm, 45, "changing the parameter once moves the step");
      const reloaded = validateWorkbenchProject(JSON.parse(JSON.stringify(changed)));
      assert(reloaded.ok, "the saved project loads");
      equal(stepOf(reloaded.ok ? reloaded.value : changed).expressions?.["distance"], "plate_h", "the binding is saved with the step");
      // An expression the project cannot evaluate is refused when the step is added, not stored.
      const message = refusedOp(project, { kind: "add-design-solid", feature: extrude({ expressions: { distance: "nope + 1" } }), body: tetra("general-body:one") });
      assert(message.length > 0, "a step bound to an unknown name is refused");
    }
  },
  {
    name: "The on-view field reads its own arithmetic and units first and asks the design only for names, saying when an expression was needed",
    run: () => {
      const project = fresh();
      const probe = extrude();
      const request = {
        quantity: "length" as const,
        resolve: (text: string) => { const preview = previewFieldExpression(project, probe, "distance", text); return preview.ok ? { ok: true as const, value: preview.value } : { ok: false as const, message: preview.message }; }
      };
      const plain = answerOnViewText(request, "1/2 in");
      assert(plain.ok && Math.abs(plain.value - 12.7) < 1e-9 && !plain.bound, "arithmetic with a unit is the field's own and binds nothing");
      const named = answerOnViewText(request, "plate_h");
      assert(named.ok && named.value === 30 && named.bound, "a parameter name is resolved by the design and flagged as an expression");
      const dotted = answerOnViewText(request, "Extrude1.distance");
      assert(dotted.ok === false || dotted.bound, "a step's own number is left to the design too");
      const unknown = answerOnViewText(request, "nothing_here");
      assert(!unknown.ok && unknown.message.length > 0 && !unknown.bound, "an unknown name is refused with a message");
      assert(!answerOnViewText({ quantity: "length" }, "plate_h").ok, "without a resolver a name is refused as before");
    }
  },
];
