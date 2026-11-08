import { designOf, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyParameterValues, applyPlainSize, parameterFieldsOf, parameterValuesOf } from "../apps/studio-web/src/feature-parameters.js";
import { halvedExpression, unhalvedExpression } from "../apps/studio-web/src/dimension-expression.js";
import { analyseParameterRows, boundValuesOf, nextParameterName, parameterOperationOf, parameterRowsOf, type ParameterRow } from "../apps/studio-web/src/parameter-rows.js";
import { buildWorkbenchMenus, type WorkbenchMenuActions } from "../apps/studio-web/src/ui/menu-model.js";
import { body, featureById, holeStep, param, plate, rebuilt, run, volume } from "./design-parameters.test.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

const row = (key: string, name: string, expression: string, unit: ParameterRow["unit"] = "mm", originalName?: string): ParameterRow =>
  ({ key, name, expression, unit, comment: "", ...(originalName === undefined ? {} : { originalName }) });

/** What the Change Parameters dialog does on Apply: build the operation from the rows, apply it, replay every body. */
async function applyRows(project: WorkbenchProject, rows: readonly ParameterRow[]): Promise<WorkbenchProject> {
  const operation = parameterOperationOf(rows);
  return rebuilt(run(project, { kind: "set-design-parameters", parameters: operation.parameters, renames: operation.renames }));
}

export const parameterDialogTests: readonly TestCase[] = [
  {
    name: "the Change Parameters table reports each row live: value, errors with the character, duplicates, cycles, and what uses a parameter",
    run: async () => {
      let project = await plate();
      project = run(project, { kind: "set-design-parameters", parameters: [param("pin_r", "4"), param("hole_d", "2 * pin_r")] });
      project = run(project, { kind: "add-design-solid", feature: holeStep, body: body(project) });
      const bound = applyParameterValues(featureById(project, "feature:hole-1"), { ...parameterValuesOf(featureById(project, "feature:hole-1")), diameter: "hole_d" }, project);
      assert(bound.ok, `the hole binds through the dialog's own path: ${bound.ok ? "" : bound.message}`);
      if (!bound.ok) return;
      project = run(project, { kind: "update-design-solid", feature: bound.feature, body: body(project) });

      const rows = parameterRowsOf(project);
      equal(rows.length, 2, "the dialog opens with the project's rows");
      let report = analyseParameterRows(project, rows);
      assert(report.ready, "an untouched table is ready");
      equal(report.rows[rows[1]!.key]?.valueText, "8 mm", "a row shows what its expression gives");
      assert(report.rows[rows[0]!.key]?.usedBy.some((label) => label.includes("hole_d")) === true, "pin_r is used by hole_d");
      assert(report.rows[rows[1]!.key]?.usedBy.some((label) => label.includes("Hole 1")) === true, "hole_d is used by the hole");

      report = analyseParameterRows(project, [rows[0]!, { ...rows[1]!, expression: "2 * pin_x" }]);
      assert(!report.ready, "a broken expression blocks Apply");
      const unknown = report.rows[rows[1]!.key]?.expressionProblem ?? "";
      assert(unknown.includes("pin_x") && unknown.includes("character 5"), `with the reason and the character: ${unknown}`);

      report = analyseParameterRows(project, [rows[0]!, { ...rows[1]!, expression: "2 *" }]);
      assert((report.rows[rows[1]!.key]?.expressionProblem ?? "").includes("ends too early"), "a syntax error is shown on its row");

      report = analyseParameterRows(project, [rows[0]!, { ...rows[1]!, name: "pin_r" }]);
      assert(!report.ready && report.rows[rows[0]!.key]?.nameProblem?.includes("used twice") === true && report.rows[rows[1]!.key]?.nameProblem?.includes("used twice") === true, "a duplicate name is marked on both rows");

      report = analyseParameterRows(project, [{ ...rows[0]!, expression: "hole_d" }, rows[1]!]);
      assert(!report.ready && (report.tableProblem ?? "").includes("Circular reference"), "pin_r = hole_d closes a loop and says so");

      report = analyseParameterRows(project, [rows[1]!]);
      assert(!report.ready && (report.tableProblem ?? "").includes("still used"), "removing a parameter that something uses is blocked");

      report = analyseParameterRows(project, [{ ...rows[0]!, name: "post_r" }, rows[1]!]);
      assert(report.ready, "a rename is fine because every expression is rewritten");
      equal(report.rows[rows[1]!.key]?.valueText, "8 mm", "and hole_d still evaluates through the renamed parameter");

      report = analyseParameterRows(project, [...rows, row("new-0", "bad name", "1")]);
      assert(report.rows["new-0"]?.nameProblem?.includes("not a valid name") === true, "a new row with a bad name is flagged");
      equal(nextParameterName(rows), "param1", "a new row gets a free name");
      equal(nextParameterName([row("a", "param1", "1")]), "param2", "and not one already taken");
      const listed = boundValuesOf(project);
      assert(listed.some((entry) => entry.label.includes("Hole 1") && entry.expression === "hole_d" && entry.valueText === "8 mm"), "the bound-values list shows the hole's expression and value");
    }
  },
  {
    name: "applying edited rows through the dialog's operation rebuilds the model: a changed value, a rename and an added parameter",
    run: async () => {
      let project = await plate();
      project = await applyRows(project, [row("new-0", "pin_r", "4"), row("new-1", "hole_d", "2 * pin_r")]);
      equal(designOf(project).parameters?.length, 2, "the table was created from empty");
      project = run(project, { kind: "add-design-solid", feature: holeStep, body: body(project) });
      const bound = applyParameterValues(featureById(project, "feature:hole-1"), { ...parameterValuesOf(featureById(project, "feature:hole-1")), diameter: "hole_d" }, project);
      assert(bound.ok, "binds");
      if (!bound.ok) return;
      project = await rebuilt(run(project, { kind: "update-design-solid", feature: bound.feature, body: body(project) }));
      const small = volume(project);

      // Edit: rename pin_r to post_r, widen it, and add a clearance parameter.
      const rows = parameterRowsOf(project);
      const edited = [{ ...rows[0]!, name: "post_r", expression: "6" }, rows[1]!, row("new-2", "clearance", "0.5")];
      assert(analyseParameterRows(project, edited).ready, "the edited table is ready");
      const operation = parameterOperationOf(edited);
      equal(JSON.stringify(operation.renames), JSON.stringify([{ from: "pin_r", to: "post_r" }]), "the rename is carried by the operation");
      project = await applyRows(project, edited);
      equal(featureById(project, "feature:hole-1").holeDiameterMm, 12, "the hole widened through the renamed parameter");
      equal(designOf(project).parameters?.find((parameter) => parameter.name === "hole_d")?.expression, "2 * post_r", "hole_d now reads post_r");
      assert(volume(project) < small, "the rebuilt solid lost more material to the wider hole");
      near(volume(project), small - (Math.PI * 36 - Math.PI * 16) * 5, Math.PI * 20 * 5 * 0.12, "by about the extra hole volume");
    }
  },
  {
    name: "the Edit feature dialog accepts an expression in a number field, binds it, shows it again, and a typed number unbinds it",
    run: async () => {
      let project = await plate();
      project = run(project, { kind: "set-design-parameters", parameters: [param("pin_r", "4")] });
      project = run(project, { kind: "add-design-solid", feature: holeStep, body: body(project) });
      const hole = featureById(project, "feature:hole-1");

      const bound = applyParameterValues(hole, { ...parameterValuesOf(hole), diameter: "2 * pin_r + 1 mm", depth: "Extrude1.distance / 4" }, project);
      assert(bound.ok, `expressions are accepted: ${bound.ok ? "" : bound.message}`);
      if (!bound.ok) return;
      equal(bound.feature.holeDiameterMm, 9, "the field took the evaluated value");
      equal(bound.feature.holeDepthMm, 2.5, "including a reference to another step");
      equal(JSON.stringify(bound.feature.expressions), JSON.stringify({ diameter: "2 * pin_r + 1 mm", depth: "Extrude1.distance / 4" }), "and stored the expressions");
      equal(parameterValuesOf(bound.feature)["diameter"], "2 * pin_r + 1 mm", "the dialog shows the expression again, not the number");
      assert(!applyParameterValues(hole, { ...parameterValuesOf(hole), diameter: "2 * pin_r" }).ok, "without a project only plain numbers are accepted, as before");

      const unbound = applyParameterValues(bound.feature, { ...parameterValuesOf(bound.feature), diameter: "7" }, project);
      assert(unbound.ok, "a plain number is still accepted");
      if (!unbound.ok) return;
      equal(unbound.feature.holeDiameterMm, 7, "it sets the number");
      equal(JSON.stringify(unbound.feature.expressions), JSON.stringify({ depth: "Extrude1.distance / 4" }), "and unbinds only that field");
      const allPlain = applyParameterValues(unbound.feature, { ...parameterValuesOf(unbound.feature), depth: "3" }, project);
      assert(allPlain.ok && allPlain.feature.expressions === undefined, "with every field plain the step carries no expressions at all");

      const wrongName = applyParameterValues(hole, { ...parameterValuesOf(hole), diameter: "2 * nope" }, project);
      assert(!wrongName.ok && wrongName.message.startsWith("Hole diameter:") && wrongName.message.includes("nope") && wrongName.message.includes("character 5"), `a bad name names the field and the character: ${wrongName.ok ? "" : wrongName.message}`);
      assert(!wrongName.ok && wrongName.fieldId === "diameter", "and the field");
      const wrongRange = applyParameterValues(hole, { ...parameterValuesOf(hole), diameter: "pin_r - 4" }, project);
      assert(!wrongRange.ok && wrongRange.message.includes("above 0"), "an out-of-range result is refused with the limit");
      const wrongUnit = applyParameterValues(hole, { ...parameterValuesOf(hole), diameter: "30 deg" }, project);
      assert(!wrongUnit.ok && wrongUnit.message.includes("length"), "an angle in a length field is refused");
      const angleField = applyParameterValues({ ...hole, holeStyle: "countersink", holeSinkDiameterMm: 12, holeSinkAngleDeg: 90 }, { ...parameterValuesOf({ ...hole, holeStyle: "countersink", holeSinkDiameterMm: 12, holeSinkAngleDeg: 90 }), sinkAngle: "1.5 rad + 4 deg" }, project);
      assert(angleField.ok && Math.abs((angleField.feature.holeSinkAngleDeg ?? 0) - (1.5 * 180 / Math.PI + 4)) < 1e-9, "an angle field takes radians and degrees");
      const vectorField = applyParameterValues(hole, { ...parameterValuesOf(hole), position: "20, pin_r, 10" }, project);
      assert(!vectorField.ok, "a position vector cannot hold an expression; it stays three plain numbers");
      assert(parameterFieldsOf(hole)?.some((field) => field.id === "diameter") === true, "the field ids the dialog uses are the ones an expression binds");

      // End to end: send the bound step through the operation and rebuild.
      const sent = await rebuilt(run(project, { kind: "update-design-solid", feature: bound.feature, body: body(project) }));
      assert(volume(sent) < volume(project) - 120, "the rebuilt solid has the bound hole cut out of it");
      const changed = await rebuilt(run(sent, { kind: "set-design-parameters", parameters: [param("pin_r", "5")] }));
      equal(featureById(changed, "feature:hole-1").holeDiameterMm, 11, "changing pin_r moves the hole the dialog bound");
      assert(volume(changed) < volume(sent), "and the rebuilt solid has lost more material");
    }
  },
  {
    name: "an extrude's own size form binds an expression, keeps its direction, refuses bad text, and a typed number unbinds it",
    run: async () => {
      const project = run(await plate(), { kind: "set-design-parameters", parameters: [param("t", "12")] });
      const extrude = featureById(project, "feature:extrude-1");
      const bound = applyPlainSize(extrude, { text: "t * 2", direction: "symmetric", throughAll: false }, project);
      assert(bound.ok, `an expression is accepted: ${bound.ok ? "" : bound.message}`);
      if (!bound.ok) return;
      equal(bound.feature.valueMm, 24, "the distance took the evaluated value");
      equal(bound.feature.direction, "symmetric", "and the direction was kept");
      equal(JSON.stringify(bound.feature.expressions), JSON.stringify({ distance: "t * 2" }), "the distance is bound");
      const sent = await rebuilt(run(project, { kind: "update-design-solid", feature: bound.feature, body: body(project) }));
      near(volume(sent) / volume(project), 2.4, 1e-6, "the rebuilt plate is 2.4 times the 10 mm plate");
      const moved = await rebuilt(run(sent, { kind: "set-design-parameters", parameters: [param("t", "20")] }));
      equal(featureById(moved, "feature:extrude-1").valueMm, 40, "changing t re-sizes the extrude");
      near(volume(moved) / volume(project), 4, 1e-6, "and the solid");

      const syntax = applyPlainSize(extrude, { text: "t *", direction: "one-side", throughAll: false }, project);
      assert(!syntax.ok && syntax.message.includes("ends too early") && syntax.message.includes("character 4"), `a syntax error is explained: ${syntax.ok ? "" : syntax.message}`);
      const unknown = applyPlainSize(extrude, { text: "abc", direction: "one-side", throughAll: false }, project);
      assert(!unknown.ok && unknown.message.includes('Unknown name "abc"'), "an unknown name is explained");
      const negative = applyPlainSize(extrude, { text: "-3", direction: "one-side", throughAll: false }, project);
      assert(!negative.ok && negative.message.includes("greater than zero"), "a plain negative number keeps its old message");
      const tooBig = applyPlainSize(extrude, { text: "t * 100000", direction: "one-side", throughAll: false }, project);
      assert(!tooBig.ok && tooBig.message.includes("at most 100000"), "an expression over the limit says so");

      const unbound = applyPlainSize(bound.feature, { text: "30", direction: "one-side", throughAll: false }, project);
      assert(unbound.ok && unbound.feature.expressions === undefined && unbound.feature.valueMm === 30 && unbound.feature.direction === undefined, "a typed number sets the size, drops the binding and the one-side direction");
      const through = applyPlainSize({ ...extrude, operation: "cut" }, { text: "ignored", direction: "one-side", throughAll: true }, project);
      assert(through.ok && through.feature.extent === "through-all", "a through-all cut ignores the typed text");

      const revolve = { ...extrude, id: "feature:revolve-x", kind: "revolve" as const };
      const turned = applyPlainSize(revolve, { text: "1.5 rad", direction: "one-side", throughAll: false }, project);
      assert(turned.ok && Math.abs(turned.feature.valueMm - 1.5 * 180 / Math.PI) < 1e-9, "a revolve angle takes radians");
      const wrong = applyPlainSize(revolve, { text: "5 mm", direction: "one-side", throughAll: false }, project);
      assert(!wrong.ok && wrong.message.includes("angle"), "a length is refused as an angle");
      const over = applyPlainSize(revolve, { text: "400", direction: "one-side", throughAll: false }, project);
      assert(!over.ok && over.message.includes("0 and 360"), "a plain angle over 360 keeps its old message");
    }
  },
  {
    name: "a circle's diameter expression is stored as its radius and read back without the wrapper; Modify > Change parameters is wired",
    run: () => {
      equal(halvedExpression("  2 * pin_r "), "(2 * pin_r) / 2", "the radius for a typed diameter");
      equal(unhalvedExpression("(2 * pin_r) / 2"), "2 * pin_r", "and back");
      equal(unhalvedExpression("pin_r + 1"), "(pin_r + 1) * 2", "a radius expression typed elsewhere shows as the diameter it gives");
      const calls: string[] = [];
      const record = (name: string) => () => { calls.push(name); };
      const actions: WorkbenchMenuActions = {
        onUndo: record("undo"), onRedo: record("redo"), onCommandPalette: record("palette"), onNewSketch: record("sketch"), onCreateSolidFromSketch: record("solid"),
        onCreatePrimitive: record("primitive"), onCombine: record("combine"), onInsertToAssembly: record("insert"), onMasterCart: record("cart"), onRenderStudio: record("render"),
        onEditSelectedFeature: record("edit"), onChangeParameters: record("parameters"), onToggleSuppressSelected: record("suppress"), onDeleteSelected: record("delete"),
        onMoveSelectedBody: record("move"), onResizeSelectedBody: record("resize"), onModifyGeneralBody: record("modify"), onFit: record("fit"), onHome: record("home"),
        onToggleGrid: record("grid"), onWorkspace: record("workspace"), onDesignHealth: record("health"), onMeasure: record("measure"), onExchange: record("exchange"),
        onAccess: record("access"), onConnectAi: record("connect"), onExportStl: record("stl"), onPlateJson: record("json"), onLearning: record("learning"), onShortcuts: record("shortcuts")
      };
      const menus = buildWorkbenchMenus({ workspace: "part", masterCartOpen: false, renderStudioOpen: false, working: false, gridVisible: true, canUndo: false, canRedo: false, generalBodyCount: 0, previewBodySelected: false, generalBodySelected: false, selectionDeletable: false }, actions);
      const item = menus.find((menu) => menu.id === "modify")?.items.find((entry) => entry.id === "modify.parameters");
      assert(item !== undefined && item.disabled !== true, "Modify has an enabled Change parameters item with nothing selected");
      item?.action();
      equal(calls.join(","), "parameters", "and it opens the dialog");
    }
  }
];
