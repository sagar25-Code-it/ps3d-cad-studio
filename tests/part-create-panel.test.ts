import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DesignParameter, SketchEntity, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createBlankWorkbenchProject, designOf } from "../packages/workbench-core/src/index.js";
import { solidMetrics } from "../packages/workbench-core/src/solid-metrics.js";
import type { ViewportViewState } from "../packages/viewport-three/src/index.js";
import { rebuildSolidFeature } from "../apps/studio-web/src/design-regeneration.js";
import {
  createSketchChoices, directionOptions, effectiveOperation, initialPartCreateState, openPartCreate, operationOptions, parseCreateValue, partCreateFields,
  partCreateReduce, partCreateReopenPlan, planPartCreate, probeTouchingIds, profileIdsToStore, profileSelectionRow, resolveTargetId, touchKey, valueToNotify,
  type CreateBodyChoice, type PartCreateState
} from "../apps/studio-web/src/part-create-panel.js";
import { PartCreatePanel } from "../apps/studio-web/src/ui/PartCreatePanel.js";
import { ViewportChrome, chromeNavigation } from "../apps/studio-web/src/ui/ViewportChrome.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * The Extrude / Revolve command panel (replaces the browser prompts): which sketch opens, which profiles are ticked, how a
 * size is read (numbers, units, expressions, parameter names), which operation and solid it defaults to, what the commit
 * asks the builder for, and what the panel markup carries. The pure functions are driven directly; the markup is rendered
 * on the server. The panel's behaviour in a running window is listed as not verified in the report.
 */

let serial = 0;
type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { ...operation, operationId: `operation:test-create-panel-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
  assert(result.ok, `${operation.kind} is accepted: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
  if (!result.ok) throw new Error("unreachable");
  return result.value.project;
}

const rectangle = (id: string, cx: number, width: number, height: number): SketchEntity => ({ id, kind: "rectangle", center: [cx, 0], widthMm: width, heightMm: height, rotationDeg: 0, construction: false });
const circle = (id: string, cx: number, radius: number): SketchEntity => ({ id, kind: "circle", center: [cx, 0], radiusMm: radius, construction: false });

/** Finishes a sketch into the timeline of a blank design, the way Finish Sketch does. */
function finishSketch(project: WorkbenchProject, featureId: string, name: string, entities: readonly SketchEntity[]): WorkbenchProject {
  let next: WorkbenchProject = { ...project, sketch: { ...project.sketch, entities: [...entities], constraints: [] } };
  next = run(next, { kind: "commit-design-sketch", featureId, name });
  return run(next, { kind: "new-design-sketch", plane: "datum:xy" });
}

/** A blank design with "Plan" (a 20 x 20 square and a disc, two separate profiles) and "Pad" (one 30 x 30 square at the origin). */
function twoSketchProject(): WorkbenchProject {
  let project = createBlankWorkbenchProject("project:test-create-panel");
  project = finishSketch(project, "feature:sketch-plan", "Plan", [rectangle("entity:square", -30, 20, 20), circle("entity:disc", 30, 5)]);
  project = finishSketch(project, "feature:sketch-pad", "Pad", [rectangle("entity:pad", 0, 30, 30)]);
  return project;
}

const state = (project: WorkbenchProject, kind: "extrude" | "revolve", sketchId = "feature:sketch-pad"): PartCreateState => {
  const opened = openPartCreate(kind, designOf(project), { preferredSketchId: sketchId });
  assert(opened.ok, "the panel opens");
  if (!opened.ok) throw new Error("unreachable");
  return opened.state;
};

const BODIES: readonly CreateBodyChoice[] = [{ id: "general-body:one", name: "Body 1" }, { id: "general-body:two", name: "Body 2" }];
const volumeOf = (positionsMm: readonly number[], indices: readonly number[]): number => solidMetrics(positionsMm, indices).volumeMm3;

export const partCreatePanelTests: readonly TestCase[] = [
  {
    name: "Opening the panel: the asked-for sketch, else the selected one, else the newest with a closed profile; a sketch that cannot be used is refused by name and none is a message",
    run: () => {
      const project = twoSketchProject();
      const history = designOf(project);
      const choices = createSketchChoices(history);
      assert(choices.length === 2 && choices[0]!.name === "Pad" && choices[1]!.name === "Plan", "finished sketches with closed profiles, newest first");
      assert(choices[1]!.profiles.length === 2 && choices[1]!.profiles[0]!.label.startsWith("Profile 1 · ") && choices[1]!.profiles[0]!.label.includes("mm²"), "each profile is named with its area");
      const asked = openPartCreate("extrude", history, { preferredSketchId: "feature:sketch-plan" });
      assert(asked.ok && asked.state.sketchId === "feature:sketch-plan", "right-click on a sketch row asks for that sketch");
      const selected = openPartCreate("revolve", history, { selectedSketchId: "feature:sketch-plan" });
      assert(selected.ok && selected.state.sketchId === "feature:sketch-plan" && selected.state.kind === "revolve" && selected.state.value === "360", "the selected sketch opens; a revolve starts at a full turn");
      const newest = openPartCreate("extrude", history, {});
      assert(newest.ok && newest.state.sketchId === "feature:sketch-pad" && newest.state.value === "10", "otherwise the newest, shown in the panel's Sketch row, not chosen out of sight");
      assert(newest.ok && newest.state.profileIds.length === 1, "every profile of the sketch starts ticked (the old 'all' default)");

      const blank = openPartCreate("extrude", designOf(createBlankWorkbenchProject("project:test-create-empty")), {});
      assert(!blank.ok && blank.message.startsWith("Extrude: finish a sketch"), "no finished sketch gives the old message");

      // A sketch after the rollback marker has profiles but cannot feed a new step: it is named, not silently swapped for another.
      const rolled = run(project, { kind: "set-design-rollback", index: 1 });
      const refused = openPartCreate("extrude", designOf(rolled), { preferredSketchId: "feature:sketch-pad" });
      assert(!refused.ok && refused.message.includes("Pad") && refused.message.includes("rollback marker"), "a sketch past the rollback marker is refused by name");
      const rolledChoices = createSketchChoices(designOf(rolled));
      assert(rolledChoices.length === 1 && rolledChoices[0]!.name === "Plan", "only the sketches before the marker are offered");
    }
  },
  {
    name: "Profile row: ticking, All and clear, the status text, and what a step stores (every profile is the empty list, a subset its ids, none is refused)",
    run: () => {
      const project = twoSketchProject();
      const sketches = createSketchChoices(designOf(project));
      const plan = sketches.find((choice) => choice.id === "feature:sketch-plan")!;
      let current = state(project, "extrude", "feature:sketch-plan");
      assert(profileSelectionRow(current, plan).status.startsWith("Plan · all 2 profiles · "), "all ticked reads as all");
      assert(JSON.stringify(profileIdsToStore(current.profileIds, plan)) === "[]", "all profiles store the empty list");
      current = partCreateReduce(current, { type: "toggle-profile", id: plan.profiles[0]!.id }, sketches);
      assert(JSON.stringify(current.profileIds) === JSON.stringify([plan.profiles[1]!.id]), "unticking leaves the other one");
      assert(profileSelectionRow(current, plan).status.startsWith("Plan · 1 of 2 profiles · "), "the row says how many of how many");
      assert(JSON.stringify(profileIdsToStore(current.profileIds, plan)) === JSON.stringify([plan.profiles[1]!.id]), "a subset stores its ids");
      current = partCreateReduce(current, { type: "toggle-profile", id: plan.profiles[0]!.id }, sketches);
      assert(JSON.stringify(current.profileIds) === JSON.stringify(plan.profiles.map((profile) => profile.id)), "ticking again keeps the detector's order");
      current = partCreateReduce(current, { type: "no-profiles" }, sketches);
      assert(current.profileIds.length === 0 && profileIdsToStore(current.profileIds, plan) === undefined, "none is refused, never a silent first profile");
      assert(profileSelectionRow(current, plan).status.includes("tick at least one profile") && !profileSelectionRow(current, plan).clearable, "an empty row says what to do");
      current = partCreateReduce(current, { type: "all-profiles" }, sketches);
      assert(current.profileIds.length === 2, "All ticks every profile");
      const other = partCreateReduce(current, { type: "sketch", id: "feature:sketch-pad" }, sketches);
      assert(other.sketchId === "feature:sketch-pad" && other.profileIds.length === 1, "choosing another sketch ticks its profiles");
      assert(partCreateReduce(current, { type: "sketch", id: "feature:nothing" }, sketches).sketchId === current.sketchId, "an unknown sketch changes nothing");
    }
  },
  {
    name: "Size field: numbers, units, arithmetic and parameter names resolve as the on-view field did; expressions stay bound; bad text says why; a revolve stops at a full turn",
    run: () => {
      let project = twoSketchProject();
      project = run(project, { kind: "set-design-parameters", parameters: [{ name: "plate_h", expression: "12", unit: "mm", comment: "" } satisfies DesignParameter] });
      const plain = parseCreateValue(project, "extrude", "value", "7.5");
      assert(plain.ok && plain.value === 7.5 && !plain.bound, "a plain number is not an expression");
      const unit = parseCreateValue(project, "extrude", "value", "1/2 in");
      assert(unit.ok && Math.abs(unit.value - 12.7) < 1e-9 && !unit.bound, "units and arithmetic");
      const named = parseCreateValue(project, "extrude", "value", "plate_h / 2");
      assert(named.ok && named.value === 6 && named.bound && named.text === "plate_h / 2", "a parameter name resolves and the step stays bound to the text");
      assert(parseCreateValue(project, "extrude", "second", "plate_h / 2").ok && !(parseCreateValue(project, "extrude", "second", "plate_h / 2") as { bound: boolean }).bound, "the second side is stored as a plain number");
      for (const bad of ["", "abc", "0", "-3", "5 deg"]) assert(!parseCreateValue(project, "extrude", "value", bad).ok, `"${bad}" is refused for a distance`);
      const empty = parseCreateValue(project, "extrude", "value", "");
      assert(!empty.ok && empty.message.length > 0, "an empty field says to type a value");
      const turn = parseCreateValue(project, "revolve", "value", "90 deg");
      assert(turn.ok && turn.value === 90, "an angle takes degrees");
      const full = parseCreateValue(project, "revolve", "value", "360");
      assert(full.ok, "a full turn is allowed");
      const past = parseCreateValue(project, "revolve", "value", "361");
      assert(!past.ok && past.message.includes("360"), "more than a full turn is refused");
      // onValueChange: told when the resolved size changes, silent while the text does not read, and not repeated.
      assert(valueToNotify(undefined, plain) === 7.5, "the first resolved size is announced");
      assert(valueToNotify(7.5, plain) === undefined, "the same size is not announced again");
      assert(valueToNotify(7.5, empty) === undefined, "text that does not resolve announces nothing");
      assert(valueToNotify(7.5, unit) === 12.7, "a changed size is announced");
    }
  },
  {
    name: "Direction and second side: the options follow the record, a second field appears only for Two sides, and a revolve's untouched full turn is split rather than refused",
    run: () => {
      const project = twoSketchProject();
      const sketches = createSketchChoices(designOf(project));
      const extrude = state(project, "extrude");
      assert(directionOptions("extrude").map((option) => option.value).join() === "one-side,symmetric,two-side,flipped", "One side, Symmetric, Two sides, and the flipped one side");
      assert(partCreateFields(extrude).length === 1 && partCreateFields(extrude)[0]!.label === "Distance" && partCreateFields(extrude)[0]!.unit === "mm", "one Distance row");
      const two = partCreateReduce(extrude, { type: "direction", direction: "two-side" }, sketches);
      assert(partCreateFields(two).map((field) => field.label).join() === "Distance,Second distance", "Two sides adds the second distance");
      const revolve = state(project, "revolve");
      assert(partCreateFields(revolve)[0]!.label === "Angle" && partCreateFields(revolve)[0]!.unit === "°", "a revolve asks for an Angle");
      const split = partCreateReduce(revolve, { type: "direction", direction: "two-side" }, sketches);
      assert(split.value === "90" && split.second === "90", "the untouched 360 becomes 90 and 90 for two sides");
      const typed = partCreateReduce(partCreateReduce(revolve, { type: "value", text: "120" }, sketches), { type: "direction", direction: "two-side" }, sketches);
      assert(typed.value === "120", "a value the user typed is left alone");
      const over = planPartCreate({ ...typed, second: "300" }, { project, selectedId: null });
      assert(!over.ok && over.message.includes("360"), "two sides that turn past a full turn are refused with the reason");
    }
  },
  {
    name: "Operation and solid: New body with no solid; Join by default only when the result touches one that can take it; never a silent first body",
    run: () => {
      const project = twoSketchProject();
      const base = state(project, "extrude");
      assert(effectiveOperation(base, [], null) === "new", "with no solid the operation is New body");
      assert(operationOptions(0).map((option) => option.value).join() === "new" && operationOptions(2).map((option) => option.value).join() === "new,join,cut,intersect", "Join, Cut and Intersect are offered only with a solid to work on");
      assert(effectiveOperation(base, BODIES, null) === "new", "solids exist but none is touched or selected: New body");
      const touching = { ...base, touchingIds: ["general-body:one"] };
      assert(resolveTargetId(touching, BODIES, null) === "general-body:one" && effectiveOperation(touching, BODIES, null) === "join", "touching exactly one solid defaults to Join on it");
      const touchingTwo = { ...base, touchingIds: ["general-body:one", "general-body:two"] };
      assert(resolveTargetId(touchingTwo, BODIES, null) === undefined && effectiveOperation(touchingTwo, BODIES, null) === "new", "touching two solids and picking none chooses nothing for the user");
      assert(resolveTargetId(touchingTwo, BODIES, "general-body:two") === "general-body:two", "the selected solid is the target");
      assert(resolveTargetId({ ...touchingTwo, targetId: "general-body:one" }, BODIES, "general-body:two") === "general-body:one", "the panel's own choice beats the selection");
      assert(effectiveOperation({ ...touching, operation: "cut" }, BODIES, null) === "cut", "a chosen operation always wins over the default");
      assert(effectiveOperation({ ...touching, operation: "new" }, BODIES, null) === "new", "New body can be chosen against the proposal");
    }
  },
  {
    name: "Commit plan: every old refusal is a message under the panel, and a good panel becomes one request with the stored profile ids, size, expression, direction and target",
    run: async () => {
      let project = twoSketchProject();
      project = run(project, { kind: "set-design-parameters", parameters: [{ name: "plate_h", expression: "12", unit: "mm", comment: "" } satisfies DesignParameter] });
      const sketches = createSketchChoices(designOf(project));
      const plan = sketches.find((choice) => choice.id === "feature:sketch-plan")!;
      const base = state(project, "extrude", "feature:sketch-plan");

      const noProfile = planPartCreate({ ...base, profileIds: [] }, { project, selectedId: null });
      assert(!noProfile.ok && noProfile.message.includes("tick at least one profile"), "no profile ticked");
      const bad = planPartCreate({ ...base, value: "abc" }, { project, selectedId: null });
      assert(!bad.ok && bad.message.startsWith("Distance: "), "a size that does not read names the field");
      const gone = planPartCreate({ ...base, sketchId: "feature:vanished" }, { project, selectedId: null });
      assert(!gone.ok && gone.message.includes("not available any more"), "a sketch that vanished (undo) is named");

      const ok = planPartCreate({ ...base, value: "plate_h / 2", direction: "symmetric" }, { project, selectedId: null });
      assert(ok.ok, "a good panel plans");
      if (!ok.ok) return;
      equal(ok.request.value, 6, "the resolved size");
      equal(ok.request.valueExpression, "plate_h / 2", "the expression stays bound");
      equal(ok.request.direction, "symmetric", "the direction");
      equal(ok.request.operation, "new", "no solid: New body");
      assert(ok.request.target === undefined && JSON.stringify(ok.request.profileIds) === "[]", "no target; every profile stores the empty list");
      const subset = planPartCreate({ ...base, profileIds: [plan.profiles[1]!.id] }, { project, selectedId: null });
      assert(subset.ok && JSON.stringify(subset.request.profileIds) === JSON.stringify([plan.profiles[1]!.id]), "a ticked subset is stored by id");

      // With a solid in the design: Join needs a solid chosen, and names it.
      const body = { id: "general-body:one", name: "Body 1", visible: true, positionsMm: [0, 0, 0, 1, 0, 0, 0, 1, 0], indices: [0, 1, 2], color: "#aaaaaa" };
      const withBody: WorkbenchProject = { ...project, part: { ...project.part, generalBodies: [body, { ...body, id: "general-body:two", name: "Body 2" }] } } as WorkbenchProject;
      const noTarget = planPartCreate({ ...base, operation: "join" }, { project: withBody, selectedId: null });
      assert(!noTarget.ok && noTarget.message.includes("choose the solid to join") && noTarget.message.includes("Body 1, Body 2"), "Join with no solid chosen lists the solids");
      const named = planPartCreate({ ...base, operation: "cut", targetId: "general-body:two" }, { project: withBody, selectedId: null });
      assert(named.ok && named.request.target?.mode === "cut" && named.request.target.bodyId === "general-body:two" && named.request.targetName === "Body 2", "the chosen solid is the target");
      const byTouch = planPartCreate(base, { project: withBody, selectedId: null, touchingIds: ["general-body:one"] });
      assert(byTouch.ok && byTouch.request.operation === "join" && byTouch.request.target?.bodyId === "general-body:one", "a fresh touch test makes Join the default");
      const bySelected = planPartCreate({ ...base, operation: "intersect" }, { project: withBody, selectedId: "general-body:one" });
      assert(bySelected.ok && bySelected.request.target?.mode === "intersect" && bySelected.request.target.bodyId === "general-body:one", "the selected solid is the target of an intersect");
    }
  },
  {
    name: "A request builds the same step the palette stores: symmetric and two-side extrudes and a revolve rebuild to the expected volumes from the request's own fields",
    run: async () => {
      const project = twoSketchProject();
      const sketchFeature = designOf(project).features.find((feature) => feature.id === "feature:sketch-pad")!;
      assert(sketchFeature.kind === "sketch", "the pad sketch is in the timeline");
      if (sketchFeature.kind !== "sketch") return;
      const base = state(project, "extrude");
      for (const [direction, second, expectedHeight] of [["one-side", "", 10], ["symmetric", "", 10], ["two-side", "4", 14]] as const) {
        const planned = planPartCreate({ ...base, direction, second: second === "" ? base.second : second }, { project, selectedId: null });
        assert(planned.ok, `${direction} plans`);
        if (!planned.ok) return;
        const request = planned.request;
        const built = await rebuildSolidFeature({
          id: "feature:extrude-check", name: "Extrude check", kind: "extrude", suppressed: false, sketchFeatureId: request.sketchId, profileIds: request.profileIds, valueMm: request.value, bodyId: "general-body:check",
          ...(request.direction === "one-side" ? {} : { direction: request.direction }), ...(request.secondValueMm === undefined ? {} : { secondValueMm: request.secondValueMm })
        }, sketchFeature);
        assert(built.ok, `${direction} builds: ${built.ok ? "" : built.message}`);
        if (!built.ok) return;
        near(volumeOf(built.body.positionsMm, built.body.indices), 30 * 30 * expectedHeight, 30 * 30 * expectedHeight * 0.001, `${direction} gives a 30 x 30 x ${expectedHeight} block`);
      }
      const turn = state(project, "revolve", "feature:sketch-plan");
      const planned = planPartCreate({ ...turn, profileIds: [turn.profileIds[1]!], value: "180" }, { project, selectedId: null });
      assert(planned.ok && planned.request.value === 180, "a half turn of the disc plans");
    }
  },
  {
    name: "The touch test builds the result once and names the visible solids it meets (and none when it misses or there is no solid)",
    run: async () => {
      let project = twoSketchProject();
      assert((await probeTouchingIds(state(project, "extrude"), project)).length === 0, "no solid, nothing touched");
      const padSketch = designOf(project).features.find((feature) => feature.id === "feature:sketch-pad")!;
      if (padSketch.kind !== "sketch") throw new Error("unreachable");
      const built = await rebuildSolidFeature({ id: "feature:extrude-pad", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: padSketch.id, profileIds: [], valueMm: 10, bodyId: "general-body:pad" }, padSketch);
      assert(built.ok, "the pad builds");
      if (!built.ok) return;
      project = run(project, { kind: "add-design-solid", feature: { id: "feature:extrude-pad", name: "Extrude 1", kind: "extrude", suppressed: false, sketchFeatureId: padSketch.id, profileIds: [], valueMm: 10, bodyId: "general-body:pad" }, body: built.body });
      const onPad = await probeTouchingIds(state(project, "extrude", "feature:sketch-pad"), project);
      assert(onPad.length === 1 && onPad[0] === "general-body:pad", "the same footprint meets the pad");
      const away = await probeTouchingIds({ ...state(project, "extrude", "feature:sketch-plan"), profileIds: [createSketchChoices(designOf(project)).find((choice) => choice.id === "feature:sketch-plan")!.profiles[1]!.id] }, project);
      assert(away.length === 0, "the disc 30 mm to the side does not meet the 30 mm pad");
      assert(touchKey(state(project, "extrude")) !== touchKey({ ...state(project, "extrude"), value: "11" }), "the key changes with the size, so the test re-runs");
    }
  },
  {
    name: "Panel markup: the shared command-panel frame with Profile, Distance or Angle, Direction and Operation rows, OK and Cancel, and no browser prompt",
    run: () => {
      const project = twoSketchProject();
      const sketches = createSketchChoices(designOf(project));
      const render = (current: PartCreateState, bodies: readonly CreateBodyChoice[] = [], busy = false, shown = sketches): string => renderToStaticMarkup(createElement(PartCreatePanel, {
        state: current, sketches: shown, bodies, selectedId: null, busy,
        parse: (text, field) => parseCreateValue(project, current.kind, field, text), onAction: () => undefined, onCommit: () => undefined, onCancel: () => undefined
      }));
      const html = render(state(project, "extrude", "feature:sketch-plan"));
      assert(html.includes('class="command-panel"') && html.includes('role="form"') && html.includes('aria-label="Extrude"'), "the shared frame, named Extrude");
      assert(html.includes('aria-label="Sketch"') && html.includes("<option") && html.includes(">Plan<") && html.includes(">Pad<"), "several sketches give a Sketch choice");
      assert(html.includes("command-panel-selection") && html.includes("Plan · all 2 profiles"), "the Profile row shows what is picked");
      assert(html.includes('type="checkbox"') && html.includes("Profile 1 · ") && html.includes("Profile 2 · ") && html.includes("mm²"), "the check list names each profile with its area");
      assert(html.includes("Distance (mm)") && html.includes('value="10"'), "the Distance row holds the default");
      assert(html.includes("Direction") && html.includes("Symmetric (half each way)") && html.includes("Two sides"), "the Direction row");
      assert(html.includes("Operation: New body (there is no solid yet to join or cut)") && !html.includes('aria-label="Operation"'), "with no solid the operation is stated, not offered");
      assert(html.includes("command-panel-ok") && html.includes(">OK<") && html.includes(">Cancel<") && html.includes("Enter commits · Esc cancels"), "OK, Cancel and the key line");
      assert(!html.includes("prompt(") && !html.includes("command-panel-error"), "no browser prompt and no error at the start");

      const revolve = render(state(project, "revolve"), [], false, sketches.filter((choice) => choice.id === "feature:sketch-pad"));
      assert(revolve.includes("Angle (°)") && revolve.includes('value="360"') && revolve.includes('aria-label="Revolve"'), "a revolve asks for an Angle, default 360");
      assert(!revolve.includes('aria-label="Sketch"'), "one sketch needs no choice; the Profile row names it");

      const twoSides = render({ ...state(project, "extrude"), direction: "two-side" });
      assert(twoSides.includes("Second distance (mm)"), "Two sides shows the second distance");

      const withBodies = render({ ...state(project, "extrude"), touchingIds: ["general-body:one"] }, BODIES);
      assert(withBodies.includes('aria-label="Operation"') && /<option value="join" selected="">/u.test(withBodies), "touching a solid selects Join in the Operation row");
      assert(withBodies.includes('aria-label="Solid to modify"') && withBodies.includes("Body 1 (touched)") && withBodies.includes("The result touches Body 1."), "the solid is named and the touch is explained");
      const asNew = render({ ...state(project, "extrude"), operation: "new" }, BODIES);
      assert(!asNew.includes('aria-label="Solid to modify"'), "New body has no solid row");

      const failing = render({ ...state(project, "extrude"), value: "abc", error: "Extrude: tick at least one profile of Pad." });
      assert(failing.includes('role="alert"') && failing.includes("tick at least one profile of Pad") && failing.includes("command-panel-error"), "an error shows under the rows");
      const live = render({ ...state(project, "extrude"), value: "1/2 in" });
      assert(live.includes("= 12.7 mm"), "a unit or expression shows what it resolves to");
      assert(render(state(project, "extrude"), [], true).includes("disabled=\"\""), "OK is disabled while a build runs");
    }
  },
  {
    name: "Starting the same command again keeps the panel; another one replaces it and says so",
    run: () => {
      const project = twoSketchProject();
      const open = state(project, "extrude");
      const same = partCreateReopenPlan(open, "extrude");
      assert(same.kind === "keep" && same.message.startsWith("Extrude is already running"), "E again keeps the picks");
      const other = partCreateReopenPlan(open, "revolve");
      assert(other.kind === "replace" && other.note === "Extrude cancelled — nothing changed. ", "Revolve replaces Extrude out loud");
      const fresh = partCreateReopenPlan(null, "revolve");
      assert(fresh.kind === "replace" && fresh.note === "", "nothing open: nothing to say");
      assert(initialPartCreateState("extrude", createSketchChoices(designOf(project))[0]!).error === undefined, "a new panel starts without an error");
    }
  },
  {
    name: "The Measure card stays closed while a command panel picks in the view, and the bar shows Select, not Measure",
    run: () => {
      assert(chromeNavigation("measure", true).shown === "select" && !chromeNavigation("measure", true).measureCard, "panel picking uses the measure mode underneath but is not Measure");
      assert(chromeNavigation("measure", false).shown === "measure" && chromeNavigation("measure", false).measureCard, "the Measure command still opens its card");
      assert(chromeNavigation("orbit", true).shown === "orbit" && !chromeNavigation("orbit", true).measureCard, "other modes are untouched");
      const view: ViewportViewState = { orientation: "isometric", projection: "perspective", navigationMode: "measure", selectionFilter: "auto", shadingMode: "shaded-edges", bodyColor: "#aeb3b8", backgroundTone: "dark-gray", gridVisible: true, axesVisible: true, azimuthDeg: -45, elevationDeg: 35.3 };
      const render = (panelPicking: boolean): string => renderToStaticMarkup(createElement(ViewportChrome, {
        workspace: "part", state: view, measurePoints: [], panelPicking,
        onNavigationMode: () => undefined, onSelectionFilter: () => undefined, onOrientation: () => undefined, onViewAngles: () => undefined, onProjection: () => undefined, onGrid: () => undefined,
        onAxes: () => undefined, onShadingMode: () => undefined, onBodyColor: () => undefined, onBackgroundTone: () => undefined, onFit: () => undefined, onHome: () => undefined, onClearMeasure: () => undefined
      }));
      assert(!render(true).includes("measure-panel"), "no Measure card beside a command panel");
      assert(render(false).includes("measure-panel"), "the Measure command shows its card");
    }
  }
];
