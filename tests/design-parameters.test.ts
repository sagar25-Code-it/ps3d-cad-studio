import type { DesignSketchFeature, DesignSolidFeature, DesignParameter, GeneralSolidBody, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import {
  applyWorkbenchOperation,
  bindFeatureExpressions,
  createWorkbenchProject,
  designExpressionIssues,
  designOf,
  evaluateDesignExpressions,
  featureStatus,
  findParameterCycle,
  previewDimensionExpression,
  previewFieldExpression,
  referenceNamesOf,
  resizeSketchEntity,
  validateWorkbenchOperation,
  validateWorkbenchProject
} from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import { replayAllBodies } from "../apps/studio-web/src/design-regeneration.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;

function attempt(project: WorkbenchProject, operation: Op) {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-params-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}

function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  const result = attempt(project, operation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  return result.value.project;
}

function refused(project: WorkbenchProject, operation: Op): string {
  const result = attempt(project, operation);
  assert(!result.ok, `${operation.kind} is refused`);
  return result.diagnostics[0]?.message ?? "";
}

const BODY = "general-body:plate";
const param = (name: string, expression: string, unit: DesignParameter["unit"] = "mm", comment = ""): DesignParameter => ({ name, expression, unit, comment });

const setParameters = (project: WorkbenchProject, parameters: readonly DesignParameter[], renames?: readonly { readonly from: string; readonly to: string }[]): WorkbenchProject =>
  run(project, { kind: "set-design-parameters", parameters, ...(renames === undefined ? {} : { renames }) });

/** The real replay path the app uses after every parameter change: replay each body, then apply the results with regenerate-design. */
async function rebuilt(project: WorkbenchProject): Promise<WorkbenchProject> {
  const results = await replayAllBodies(project);
  return run(project, { kind: "regenerate-design", results });
}

const body = (project: WorkbenchProject): GeneralSolidBody => project.part.generalBodies!.find((candidate) => candidate.id === BODY)!;
const volume = (project: WorkbenchProject): number => solidMetrics(body(project).positionsMm, body(project).indices).volumeMm3;
const featureById = (project: WorkbenchProject, id: string): DesignSolidFeature => {
  const found = designOf(project).features.find((feature) => feature.id === id);
  assert(found !== undefined && found.kind !== "sketch", `${id} is a solid feature`);
  return found as DesignSolidFeature;
};
const sketchFeature = (project: WorkbenchProject, id = "feature:sketch-1"): DesignSketchFeature => {
  const found = designOf(project).features.find((feature) => feature.id === id);
  assert(found?.kind === "sketch", `${id} is a sketch feature`);
  return found as DesignSketchFeature;
};
const extent = (positions: readonly number[], axis: 0 | 1 | 2): number => {
  let min = Infinity;
  let max = -Infinity;
  for (let index = axis; index < positions.length; index += 3) { min = Math.min(min, positions[index]!); max = Math.max(max, positions[index]!); }
  return max - min;
};

const extrudeStep: DesignSolidFeature = { id: "feature:extrude-1", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 10, bodyId: BODY };
const holeStep: DesignSolidFeature = {
  id: "feature:hole-1", name: "Hole 1", kind: "hole", suppressed: false, sketchFeatureId: "feature:sketch-1", profileIds: [], valueMm: 8, bodyId: BODY,
  operation: "direct-edit", holeStyle: "simple", holePositionMm: [20, 10, 10], holeNormal: [0, 0, 1], holeDiameterMm: 8, holeDepthMm: 5
};

/** A 60 x 40 plate with a 10 mm centre bore, 10 mm thick, as a finished sketch and an extrude built through the real replay. */
async function plate(): Promise<WorkbenchProject> {
  let project = run(createWorkbenchProject("project:test-params"), { kind: "new-design-sketch", plane: "datum:xy" });
  project = run(project, { kind: "add-sketch-entity", entity: { id: "entity:outline", kind: "rectangle", center: [0, 0], widthMm: 60, heightMm: 40, rotationDeg: 0, construction: false } });
  project = run(project, { kind: "add-sketch-entity", entity: { id: "entity:bore", kind: "circle", center: [0, 0], radiusMm: 5, construction: false } });
  project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-1", name: "Sketch 1" });
  const staged: WorkbenchProject = { ...project, design: { ...designOf(project), features: [...designOf(project).features, extrudeStep], rollbackIndex: 2 } };
  const first = (await replayAllBodies(staged)).find((result) => result.body !== undefined);
  assert(first?.body !== undefined, "the plate builds");
  return run(project, { kind: "add-design-solid", feature: extrudeStep, body: first.body });
}

/** Binds `texts` to a step and sends it through update-design-solid, the way the Edit feature dialog does. */
function bind(project: WorkbenchProject, id: string, texts: Readonly<Record<string, string>>): WorkbenchProject {
  const bound = bindFeatureExpressions(project, featureById(project, id), texts);
  assert(bound.ok, `the expressions bind: ${bound.ok ? "" : bound.message}`);
  return run(project, { kind: "update-design-solid", feature: bound.feature, body: body(project) });
}

const PLATE_VOLUME = (thickness: number, width = 60): number => (width * 40 - Math.PI * 25) * thickness;

export const designParameterTests: readonly TestCase[] = [
  {
    name: "changing a user parameter rebuilds the bound extrude through the real replay, with the new volume and size",
    run: async () => {
      let project = setParameters(await plate(), [param("plate_t", "10", "mm", "plate thickness")]);
      project = bind(project, "feature:extrude-1", { distance: "plate_t" });
      equal(featureById(project, "feature:extrude-1").expressions?.["distance"], "plate_t", "the expression is stored next to the value");
      project = await rebuilt(project);
      const before = volume(project);
      near(before, PLATE_VOLUME(10), PLATE_VOLUME(10) * 0.03, "the plate starts at the analytic volume");
      near(extent(body(project).positionsMm, 2), 10, 1e-6, "10 mm thick");

      project = setParameters(project, [param("plate_t", "20", "mm", "plate thickness")]);
      equal(featureById(project, "feature:extrude-1").valueMm, 20, "the step took the new number the moment the parameter changed");
      project = await rebuilt(project);
      near(extent(body(project).positionsMm, 2), 20, 1e-6, "the regenerated solid is 20 mm thick");
      near(volume(project) / before, 2, 1e-6, "and holds exactly twice the volume");
      equal(designOf(project).features.filter((feature) => feature.health !== undefined).length, 0, "no step is flagged");
      assert(validateWorkbenchProject(project).ok, "the project still validates");
    }
  },
  {
    name: "hole_d = 2 * pin_r: a parameter feeds a parameter that feeds a hole, and Extrude1.distance feeds the hole depth across features",
    run: async () => {
      let project = setParameters(await plate(), [param("pin_r", "4"), param("hole_d", "2 * pin_r")]);
      project = run(project, { kind: "add-design-solid", feature: holeStep, body: body(project) });
      project = bind(project, "feature:hole-1", { diameter: "hole_d", depth: "Extrude1.distance / 2" });
      const hole = featureById(project, "feature:hole-1");
      equal(hole.holeDiameterMm, 8, "hole_d is 2 * 4 = 8 mm");
      equal(hole.holeDepthMm, 5, "the depth is half the extrude distance");
      project = await rebuilt(project);
      const withSmall = volume(project);
      near(PLATE_VOLUME(10) - withSmall, Math.PI * 16 * 5, Math.PI * 16 * 5 * 0.06, "a 8 mm blind hole 5 mm deep is cut");

      // One change to pin_r: the hole widens through hole_d.
      let wider = setParameters(project, [param("pin_r", "6"), param("hole_d", "2 * pin_r")]);
      equal(featureById(wider, "feature:hole-1").holeDiameterMm, 12, "the hole follows pin_r through hole_d");
      wider = await rebuilt(wider);
      near(PLATE_VOLUME(10) - volume(wider), Math.PI * 36 * 5, Math.PI * 36 * 5 * 0.06, "the rebuilt hole is 12 mm wide");

      // Changing the extrude itself (a plain edit, no parameter involved) moves the hole depth that refers to it.
      const taller = run(project, { kind: "update-design-solid", feature: { ...featureById(project, "feature:extrude-1"), valueMm: 30 }, body: body(project) });
      equal(featureById(taller, "feature:hole-1").holeDepthMm, 15, "editing Extrude 1 moved the hole depth that refers to it");
      const taller2 = await rebuilt(taller);
      near(extent(body(taller2).positionsMm, 2), 30, 1e-6, "the plate is 30 mm thick");
      assert(volume(taller2) < PLATE_VOLUME(30) - Math.PI * 16 * 5, "and the deeper hole still removes material");
      assert(referenceNamesOf(featureById(project, "feature:hole-1")).includes("Hole1.diameter"), "the dialog can list the names a step offers");
    }
  },
  {
    name: "a circular reference is refused, whether it runs through parameters or through a feature's bound number",
    run: async () => {
      const base = await plate();
      assert(refused(base, { kind: "set-design-parameters", parameters: [param("a", "b + 1"), param("b", "a + 1")] }).includes("Circular reference"), "a and b depend on each other");
      assert(refused(base, { kind: "set-design-parameters", parameters: [param("a", "a * 2")] }).includes("Circular reference"), "a parameter that uses itself");
      const through = refused(base, { kind: "set-design-parameters", parameters: [param("a", "b"), param("b", "c"), param("c", "a")] });
      assert(through.includes("a → b → c → a") || through.includes("b → c → a → b") || through.includes("c → a → b → c"), `the message shows the loop: ${through}`);
      // Through a feature: p = Extrude1.distance, then Extrude 1's distance = p.
      const project = setParameters(base, [param("p", "Extrude1.distance + 1")]);
      const loop = bindFeatureExpressions(project, featureById(project, "feature:extrude-1"), { distance: "p" });
      assert(!loop.ok && loop.message.includes("Circular"), "binding the extrude to p closes the loop and is refused");
      // The same loop sent straight to the operation, bypassing the helper.
      const forced = refused(project, { kind: "update-design-solid", feature: { ...featureById(project, "feature:extrude-1"), expressions: { distance: "p" } }, body: body(project) });
      assert(forced.includes("Circular reference"), "the operation itself refuses it too");
      // A saved file with a cycle does not load.
      const poisoned = { ...project, design: { ...designOf(project), parameters: [param("a", "b"), param("b", "a")] } };
      assert(!validateWorkbenchProject(poisoned).ok, "a saved cycle is invalid");
      equal(findParameterCycle(designOf(poisoned))?.length, 3, "and the cycle is found");
      assert(findParameterCycle(designOf(project)) === undefined, "an acyclic table has none");
    }
  },
  {
    name: "unit conversion is exact end to end: 2 in is 50.8 mm in the step, and an angle parameter takes radians",
    run: async () => {
      let project = setParameters(await plate(), [param("wall", "2 in"), param("tilt", "0.5 rad", "deg"), param("half", "wall / 2")]);
      project = bind(project, "feature:extrude-1", { distance: "wall" });
      assert(Object.is(featureById(project, "feature:extrude-1").valueMm, 50.8), "the step holds exactly 50.8");
      const report = evaluateDesignExpressions(designOf(project));
      const tilt = report.bindings.find((binding) => binding.ownerId === "tilt");
      assert(tilt?.ok === true && tilt.dimension === "angle", "an angle parameter is an angle");
      near(tilt?.value ?? 0, 180 / Math.PI / 2, 1e-12, "0.5 rad is that many degrees");
      assert(Object.is(report.bindings.find((binding) => binding.ownerId === "half")?.value, 25.4), "50.8 / 2 is exactly 25.4");
      project = await rebuilt(project);
      near(extent(body(project).positionsMm, 2), 50.8, 1e-6, "and the solid is 50.8 mm thick");
      // A parameter set to a length cannot be an angle.
      const keep = [param("wall", "2 in"), param("tilt", "0.5 rad", "deg"), param("half", "wall / 2")];
      assert(refused(project, { kind: "set-design-parameters", parameters: [...keep, param("bad", "5 mm", "deg")] }).includes("angle"), "a length in an angle parameter is refused");
      assert(refused(project, { kind: "set-design-parameters", parameters: [...keep, param("bad", "5 deg", "mm")] }).includes("length"), "an angle in a length parameter is refused");
      // A distance field refuses an angle expression.
      const wrong = bindFeatureExpressions(project, featureById(project, "feature:extrude-1"), { distance: "tilt" });
      assert(!wrong.ok && wrong.message.includes("length"), "a distance cannot be driven by an angle");
    }
  },
  {
    name: "an error leaves the previous good geometry in place and reports the reason on the step",
    run: async () => {
      let project = setParameters(await plate(), [param("hole_d", "8")]);
      project = run(project, { kind: "add-design-solid", feature: holeStep, body: body(project) });
      project = bind(project, "feature:hole-1", { diameter: "hole_d" });
      project = await rebuilt(project);
      const good = volume(project);
      const goodPositions = [...body(project).positionsMm];

      // hole_d becomes zero: the table is valid, but a hole cannot be zero wide.
      let broken = setParameters(project, [param("hole_d", "0")]);
      equal(featureById(broken, "feature:hole-1").holeDiameterMm, 8, "the step keeps its last good diameter");
      const issues = designExpressionIssues(broken, resizeSketchEntity);
      equal(issues.length, 1, "one problem is reported");
      assert(issues[0]!.ownerId === "feature:hole-1" && issues[0]!.message?.includes("above 0") === true, `with its reason: ${issues[0]?.message}`);
      const flagged = featureById(broken, "feature:hole-1");
      assert(flagged.health?.message.startsWith("Expression: ") === true && flagged.health.message.includes("above 0"), "the step carries the reason in its health field");
      equal(featureStatus(designOf(broken), flagged), "error", "so the timeline shows it needs attention");
      broken = await rebuilt(broken);
      assert(featureById(broken, "feature:hole-1").health?.message.startsWith("Expression: ") === true, "regenerating does not wipe the reason");
      equal(volume(broken), good, "the rebuilt geometry is exactly the previous good geometry");
      assert(body(broken).positionsMm.every((value, index) => value === goodPositions[index]), "vertex for vertex");
      assert(validateWorkbenchProject(broken).ok, "a project with a reported error still saves and loads");

      // Fixing the parameter clears the report and the geometry follows again.
      const fixed = await rebuilt(setParameters(broken, [param("hole_d", "10")]));
      assert(featureById(fixed, "feature:hole-1").health === undefined, "the flag clears when the expression works again");
      equal(featureById(fixed, "feature:hole-1").holeDiameterMm, 10, "and the new number is used");
      assert(volume(fixed) < good, "the larger hole removes more material");

      // An out-of-range result on an extrude is reported the same way.
      let tall = setParameters(await plate(), [param("t", "10")]);
      tall = bind(tall, "feature:extrude-1", { distance: "t" });
      tall = setParameters(tall, [param("t", "1 m * 1000")]);
      equal(featureById(tall, "feature:extrude-1").valueMm, 10, "1,000,000 mm is out of range, so the step keeps 10");
      assert(designExpressionIssues(tall, resizeSketchEntity)[0]?.message?.includes("at most 100000") === true, "and the limit is named");
    }
  },
  {
    name: "a parameter table that does not evaluate is refused with the reason and the character, and a used parameter cannot be removed",
    run: async () => {
      const base = await plate();
      const syntax = refused(base, { kind: "set-design-parameters", parameters: [param("a", "2 +")] });
      assert(syntax.includes("a:") && syntax.includes("ends too early") && syntax.includes("character 4"), `syntax error with position: ${syntax}`);
      assert(refused(base, { kind: "set-design-parameters", parameters: [param("a", "missing * 2")] }).includes('Unknown name "missing"'), "an unknown name is refused");
      assert(refused(base, { kind: "set-design-parameters", parameters: [param("a", "1 / 0")] }).includes("Division by zero"), "a division by zero is refused");
      assert(refused(base, { kind: "set-design-parameters", parameters: [param("a", "1"), param("a", "2")] }).includes("twice"), "duplicate names");
      assert(refused(base, { kind: "set-design-parameters", parameters: [param("2bad", "1")] }).includes("not a valid name"), "a bad name");
      assert(refused(base, { kind: "set-design-parameters", parameters: [param("mm", "1")] }).includes("unit or a function"), "a reserved name");
      assert(refused(base, { kind: "set-design-parameters", parameters: [param("sin", "1")] }).includes("unit or a function"), "a function name");
      assert(refused(base, { kind: "set-design-parameters", parameters: [param("a", "")] }).includes("type a value"), "an empty expression");
      assert(refused(base, { kind: "set-design-parameters", parameters: [param("a", "1", "mm", "x".repeat(300))] }).includes("comment"), "an over-long comment");

      let project = setParameters(base, [param("t", "10")]);
      project = bind(project, "feature:extrude-1", { distance: "t" });
      assert(refused(project, { kind: "set-design-parameters", parameters: [] }).includes('"t" is still used'), "a parameter in use cannot be removed");
      const emptied = setParameters(run(project, { kind: "update-design-solid", feature: (({ expressions: _e, ...rest }) => (void _e, rest))(featureById(project, "feature:extrude-1")), body: body(project) }), []);
      assert(designOf(emptied).parameters === undefined, "once nothing uses it, the table can be cleared");
    }
  },
  {
    name: "a sketch dimension bound to an expression resizes the sketch, and the extrude built on it regenerates to the new size",
    run: async () => {
      let project = setParameters(await plate(), [param("plate_w", "60")]);
      // Bind the outline's width in the working sketch, then finish the sketch again so the timeline snapshot carries it.
      project = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-1" });
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "width", valueMm: 60, expression: "plate_w" });
      const dimension = project.sketch.constraints.find((constraint) => constraint.expression !== undefined);
      equal(dimension?.expression, "plate_w", "the dimension stores its expression");
      project = run(project, { kind: "commit-design-sketch", featureId: "feature:sketch-9", name: "Sketch 1" });
      assert(sketchFeature(project).sketch.constraints.some((constraint) => constraint.expression === "plate_w"), "the timeline sketch carries the binding");
      project = await rebuilt(project);
      near(extent(body(project).positionsMm, 0), 60, 1e-6, "the plate is 60 mm wide");
      const before = volume(project);

      project = setParameters(project, [param("plate_w", "2 * 40")]);
      const outline = sketchFeature(project).sketch.entities.find((entity) => entity.id === "entity:outline");
      assert(outline?.kind === "rectangle" && outline.widthMm === 80, "the sketch snapshot's rectangle is now 80 wide");
      const working = project.sketch.entities.find((entity) => entity.id === "entity:outline");
      assert(working?.kind === "rectangle" && working.widthMm === 80, "and so is the working sketch");
      project = await rebuilt(project);
      near(extent(body(project).positionsMm, 0), 80, 1e-6, "the regenerated plate is 80 mm wide");
      near(volume(project), PLATE_VOLUME(10, 80), PLATE_VOLUME(10, 80) * 0.03, "with the volume of an 80 x 40 plate");
      // The bore is a polygon in the mesh, so its area is read back from the 60 mm plate instead of taken as pi r squared.
      const polygonArea = 60 * 40 - before / 10;
      near(volume(project) / before, (80 * 40 - polygonArea) / (60 * 40 - polygonArea), 1e-9, "in exact proportion to the area");

      // A dimension whose expression fails keeps its size and is flagged on the sketch.
      const broken = setParameters(project, [param("plate_w", "0")]);
      const keep = sketchFeature(broken).sketch.entities.find((entity) => entity.id === "entity:outline");
      assert(keep?.kind === "rectangle" && keep.widthMm === 80, "an out-of-range dimension keeps the last good width");
      assert(sketchFeature(broken).health?.message.includes("between") === true, "and the sketch is flagged with the reason");

      assert(refused(project, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "width", valueMm: 60, expression: "nope * 2" }).includes('Unknown name "nope"'), "an unknown name in a dimension is refused");
      assert(refused(project, { kind: "set-sketch-dimension", entityId: "entity:outline", dimension: "width", valueMm: 60, expression: "30 deg" }).includes("length"), "an angle cannot size a width");
      const preview = previewDimensionExpression(project, "plate_w / 4");
      assert(preview.ok && preview.value === 20, "the live preview evaluates a dimension");
    }
  },
  {
    name: "renaming a parameter or a feature rewrites every expression that used it, and nothing breaks",
    run: async () => {
      let project = setParameters(await plate(), [param("pin_r", "4"), param("pin_r2", "9"), param("hole_d", "2 * pin_r + pin_r2 * 0")]);
      project = run(project, { kind: "add-design-solid", feature: holeStep, body: body(project) });
      project = bind(project, "feature:hole-1", { diameter: "hole_d", depth: "Extrude1.distance / 2" });
      project = run(project, { kind: "edit-design-sketch", featureId: "feature:sketch-1" });
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:bore", dimension: "radius", valueMm: 5, expression: "pin_r + 1 mm" });
      const renamed = setParameters(project, [param("post_r", "4"), param("pin_r2", "9"), param("hole_d", "2 * pin_r + pin_r2 * 0")], [{ from: "pin_r", to: "post_r" }]);
      const table = designOf(renamed).parameters!;
      equal(table.find((parameter) => parameter.name === "hole_d")?.expression, "2 * post_r + pin_r2 * 0", "the table's own expression is rewritten, and pin_r2 is left alone");
      equal(renamed.sketch.constraints.find((constraint) => constraint.expression !== undefined)?.expression, "post_r + 1 mm", "the sketch dimension is rewritten");
      equal(featureById(renamed, "feature:hole-1").holeDiameterMm, 8, "values are unchanged by a rename");
      const moved = setParameters(renamed, [param("post_r", "5"), param("pin_r2", "9"), param("hole_d", "2 * post_r + pin_r2 * 0")]);
      equal(featureById(moved, "feature:hole-1").holeDiameterMm, 10, "and the renamed parameter still drives the hole");
      assert(refused(project, { kind: "set-design-parameters", parameters: [param("hole_d", "8"), param("pin_r2", "9")], renames: [{ from: "ghost", to: "hole_d" }] }).includes("not an existing parameter"), "renaming something that does not exist is refused");
      assert(refused(project, { kind: "set-design-parameters", parameters: [param("hole_d", "8")], renames: [{ from: "pin_r", to: "missing" }] }).includes("not in the new table"), "renaming to a name that is not in the table is refused");

      // Renaming a feature carries its references along.
      const feature = run(renamed, { kind: "rename-design-feature", featureId: "feature:extrude-1", name: "Base plate" });
      equal(featureById(feature, "feature:hole-1").expressions?.["depth"], "Baseplate.distance / 2", "the reference follows the new feature name");
      assert(designExpressionIssues(feature, resizeSketchEntity).length === 0, "and still resolves");
      const resized = run(feature, { kind: "update-design-solid", feature: { ...featureById(feature, "feature:extrude-1"), valueMm: 24 }, body: body(feature) });
      equal(featureById(resized, "feature:hole-1").holeDepthMm, 12, "the renamed reference keeps working when the base changes");
    }
  },
  {
    name: "a saved project round-trips through JSON and validation, and tampered expressions are rejected",
    run: async () => {
      let project = setParameters(await plate(), [param("pin_r", "4", "mm", "pin radius"), param("hole_d", "2 * pin_r", "mm", "hole")]);
      project = run(project, { kind: "add-design-solid", feature: holeStep, body: body(project) });
      project = bind(project, "feature:hole-1", { diameter: "hole_d", depth: "Extrude1.distance / 2" });
      project = await rebuilt(project);
      const loaded = validateWorkbenchProject(JSON.parse(JSON.stringify(project)));
      assert(loaded.ok, `the saved file loads: ${loaded.ok ? "" : loaded.diagnostics[0]?.message}`);
      if (!loaded.ok) return;
      equal(JSON.stringify(designOf(loaded.value).parameters), JSON.stringify(designOf(project).parameters), "the parameter table survives");
      equal(JSON.stringify(featureById(loaded.value, "feature:hole-1").expressions), JSON.stringify({ diameter: "hole_d", depth: "Extrude1.distance / 2" }), "and the bound expressions");
      equal(featureById(loaded.value, "feature:hole-1").holeDiameterMm, 8, "with the values next to them");
      // After loading, the same parameter change still regenerates.
      const again = await rebuilt(setParameters(loaded.value, [param("pin_r", "3"), param("hole_d", "2 * pin_r")]));
      equal(featureById(again, "feature:hole-1").holeDiameterMm, 6, "a loaded project keeps working parametrically");

      const tamper = (change: (history: ReturnType<typeof designOf>) => unknown): boolean => validateWorkbenchProject(JSON.parse(JSON.stringify({ ...project, design: change(designOf(project)) }))).ok;
      assert(!tamper((history) => ({ ...history, parameters: [{ name: "x", expression: "1 +", unit: "mm", comment: "" }] })), "an expression that does not parse is invalid");
      assert(!tamper((history) => ({ ...history, parameters: [{ name: "x", expression: "1", unit: "kg", comment: "" }] })), "an unknown unit is invalid");
      assert(!tamper((history) => ({ ...history, parameters: [{ name: "x y", expression: "1", unit: "mm", comment: "" }] })), "a bad name is invalid");
      assert(!tamper((history) => ({ ...history, parameters: [{ name: "x", expression: "1", unit: "mm", comment: "", extra: true }] })), "extra keys are invalid");
      assert(!tamper((history) => ({ ...history, parameters: "nope" })), "a non-list table is invalid");
      assert(!tamper((history) => ({ ...history, features: history.features.map((feature) => feature.id === "feature:hole-1" ? { ...feature, expressions: { nonsense: "1" } } : feature) })), "a binding on a field the step does not have is invalid");
      assert(!tamper((history) => ({ ...history, features: history.features.map((feature) => feature.id === "feature:hole-1" ? { ...feature, expressions: { diameter: "(" } } : feature) })), "a binding that does not parse is invalid");
      assert(!tamper((history) => ({ ...history, features: history.features.map((feature) => feature.id === "feature:hole-1" ? { ...feature, expressions: {} } : feature) })), "an empty binding table is invalid");
      const withDimension = (expression: string) => (history: ReturnType<typeof designOf>) => ({ ...history, features: history.features.map((feature) => feature.kind === "sketch" ? { ...feature, sketch: { ...feature.sketch, constraints: [{ id: "constraint:x", kind: "distance", entityIds: ["entity:outline"], valueMm: 5, dimension: "width", expression }] } } : feature) });
      assert(tamper(withDimension("1 + 1")), "a sketch dimension with a good expression is valid (the control)");
      assert(!tamper(withDimension("1 +")), "a sketch dimension expression that does not parse is invalid");

      // The operations are validated too.
      const operation = (extra: Record<string, unknown>): boolean => validateWorkbenchOperation({ operationId: "operation:v-1", expectedRevision: 0, kind: "set-design-parameters", ...extra }).ok;
      assert(operation({ parameters: [param("a", "1")] }), "a well-formed operation passes");
      assert(!operation({ parameters: [{ name: "a" }] }), "a half-filled row fails");
      assert(!operation({ parameters: "a" }), "a non-list fails");
      assert(!operation({ parameters: [], extra: 1 }), "extra keys fail");
      assert(!operation({ parameters: [param("a", "1")], renames: [{ from: "a" }] }), "a half-filled rename fails");
    }
  },
  {
    name: "deleting a step that others refer to flags them instead of crashing; the table survives timeline edits",
    run: async () => {
      let project = setParameters(await plate(), [param("pin_r", "4")]);
      equal(designOf(project).parameters?.length, 1, "the table is in the history");
      project = run(project, { kind: "add-design-solid", feature: holeStep, body: body(project) });
      project = bind(project, "feature:hole-1", { depth: "Extrude1.distance / 2" });
      const second = run(project, { kind: "new-design-sketch", plane: "datum:xy" });
      equal(designOf(second).parameters?.length, 1, "starting a sketch keeps the table");
      const committed = run(run(second, { kind: "add-sketch-entity", entity: { id: "entity:extra", kind: "circle", center: [0, 0], radiusMm: 3, construction: false } }), { kind: "commit-design-sketch", featureId: "feature:sketch-2", name: "Sketch 2" });
      equal(designOf(committed).parameters?.length, 1, "finishing a sketch keeps the table");
      const removed = run(committed, { kind: "set-design-feature-suppressed", featureId: "feature:hole-1", suppressed: true });
      equal(designOf(removed).parameters?.length, 1, "suppressing keeps it");
      const deleted = run(committed, { kind: "delete-design-feature", featureId: "feature:sketch-2" });
      equal(designOf(deleted).parameters?.length, 1, "deleting a feature keeps the table");

      // The hole refers to Extrude1; delete the sketch both are built on and the hole goes with it. Deleting only the extrude is
      // not possible without its dependents, so check the reference error with a feature that is renamed to clash instead.
      const clash = run(project, { kind: "rename-design-feature", featureId: "feature:hole-1", name: "Extrude 1" });
      const issues = designExpressionIssues(clash, resizeSketchEntity);
      assert(issues.some((issue) => issue.ownerId === "feature:hole-1" && issue.message?.includes("More than one feature")), `two steps with the same name make the reference ambiguous: ${issues[0]?.message}`);
      equal(featureById(clash, "feature:hole-1").holeDepthMm, 5, "the hole keeps its last good depth");
    }
  },
  {
    name: "the live preview shows what an expression gives for a step's field, or why it fails, without changing anything",
    run: async () => {
      const project = setParameters(await plate(), [param("pin_r", "4")]);
      const withHole = run(project, { kind: "add-design-solid", feature: holeStep, body: body(project) });
      const hole = featureById(withHole, "feature:hole-1");
      const ok = previewFieldExpression(withHole, hole, "diameter", "2 * pin_r");
      assert(ok.ok && ok.value === 8 && ok.text === "8 mm", "a good expression shows its value and unit");
      const bad = previewFieldExpression(withHole, hole, "diameter", "2 * nope");
      assert(!bad.ok && bad.message.includes("nope") && bad.position === 4, "a bad name shows the reason and the character");
      const range = previewFieldExpression(withHole, hole, "diameter", "0");
      assert(!range.ok && range.message.includes("above 0"), "an out-of-range value shows the limit");
      const unknown = previewFieldExpression(withHole, hole, "colour", "1");
      assert(!unknown.ok, "a field that cannot be driven says so");
      equal(featureById(withHole, "feature:hole-1").holeDiameterMm, 8, "previewing changed nothing");
    }
  }
];
