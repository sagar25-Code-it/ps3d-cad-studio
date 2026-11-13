import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SKETCH_ORIGIN_ID, createWorkbenchProject, type SketchEntity, type WorkbenchProject, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { analyzeWorkbenchSketch } from "../packages/workbench-sketch/src/index.js";
import { CONSTRAINT_TOOLS, CONSTRAINT_TOOL_INFO, constraintToolStep, isConstraintToolKind, type ConstraintToolKind, type ConstraintToolPick, type ConstraintToolStep } from "../packages/workbench-sketch/src/constraint-tool.js";
import { DEFAULT_SKETCH_KEYMAP, SKETCH_KEYMAP_COMMANDS, keymapConflicts, rebindKey, resolveSketchHotkey, type SketchHotkeyContext } from "../packages/workbench-sketch/src/hotkeys.js";
import { searchableCommands } from "../apps/studio-web/src/ui/sketch-tool-commands.js";
import { WorkbenchRibbon } from "../apps/studio-web/src/ui/WorkbenchRibbon.js";
import { circ, fresh, line, pipelineRun } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * The constraint tools: pick the relation (ribbon, key or command search), then pick the geometry on the canvas. The tool stays on
 * for the next relation until Esc. The picking is decided by constraintToolStep; the relation it builds goes through add-sketch-constraint.
 */

const curve = (id: string, kind: SketchEntity["kind"], label: string): ConstraintToolPick => ({ entityId: `entity:${id}`, kind, label });
const point = (id: string, kind: SketchEntity["kind"], ref: NonNullable<ConstraintToolPick["ref"]>, label: string): ConstraintToolPick => ({ entityId: `entity:${id}`, kind, ref, label });

/** Feeds picks to a tool one after another, as the canvas does, and returns the last step. */
function run(tool: ConstraintToolKind, picks: readonly ConstraintToolPick[]): ConstraintToolStep {
  let held: readonly ConstraintToolPick[] = [];
  let step: ConstraintToolStep | undefined;
  for (const pick of picks) {
    step = constraintToolStep(tool, held, pick);
    held = step.picks;
  }
  if (step === undefined) throw new Error("no picks");
  return step;
}

const made = (step: ConstraintToolStep): string => (step.status === "ready" ? `${step.constraint.kind}:${step.constraint.entityIds.join("+")}${step.constraint.points === undefined ? "" : `@${step.constraint.points.join("+")}`}` : step.status);

function sketchOf(entities: readonly SketchEntity[]): WorkbenchProject {
  const project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
  return pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: entities, addConstraints: [], label: "Draw" });
}

let serial = 0;
function add(project: WorkbenchProject, step: ConstraintToolStep): WorkbenchProject {
  assert(step.status === "ready", `the picks make a relation: ${step.status === "refused" ? step.message : step.status}`);
  if (step.status !== "ready") return project;
  serial += 1;
  return pipelineRun(project, { kind: "add-sketch-constraint", constraint: { id: `constraint:tool-${serial}`, ...step.constraint } as WorkbenchSketchConstraint });
}

const context: SketchHotkeyContext = { tool: "select", pendingPoints: 0, selectionCount: 0, curveSelectionCount: 0, dimensionMode: false, editToolActive: false, pickingRelation: false, dragging: false, dynamicFieldCount: 0 };
const noop = (): undefined => undefined;

export const sketchConstraintToolTests: readonly TestCase[] = [
  {
    name: "Constraint tools: two curve picks make a pair relation in pick order; a first pick that can never fit is refused at once with the rule",
    run: () => {
      equal(made(run("parallel", [curve("a", "line", "Line 1"), curve("b", "line", "Line 2")])), "parallel:entity:a+entity:b", "Parallel");
      equal(made(run("perpendicular", [curve("b", "line", "Line 2"), curve("a", "line", "Line 1")])), "perpendicular:entity:b+entity:a", "Perpendicular keeps the order picked");
      equal(made(run("collinear", [curve("a", "line", "Line 1"), curve("b", "line", "Line 2")])), "collinear:entity:a+entity:b", "Collinear");
      equal(made(run("tangent", [curve("a", "line", "Line 1"), curve("c", "circle", "Circle 1")])), "tangent:entity:a+entity:c", "Tangent line to circle");
      equal(made(run("concentric", [curve("c", "circle", "Circle 1"), curve("d", "arc", "Arc 1")])), "concentric:entity:c+entity:d", "Concentric");
      equal(made(run("equal", [curve("c", "circle", "Circle 1"), curve("d", "arc", "Arc 1")])), "equal:entity:c+entity:d", "Equal radii");
      const wrongFirst = constraintToolStep("parallel", [], curve("c", "circle", "Circle 1"));
      assert(wrongFirst.status === "refused" && /two lines/u.test(wrongFirst.message) && wrongFirst.picks.length === 0, "a circle cannot start Parallel");
      const wrongSecond = run("equal", [curve("a", "line", "Line 1"), curve("c", "circle", "Circle 1")]);
      assert(wrongSecond.status === "refused" && wrongSecond.picks.length === 1 && wrongSecond.picks[0]!.entityId === "entity:a", "a wrong second pick is refused and the first pick is kept");
      const first = constraintToolStep("tangent", [], curve("a", "line", "Line 1"));
      assert(first.status === "more" && /curve that should touch it/u.test(first.prompt), "the prompt asks for the second pick");
      const cleared = constraintToolStep("tangent", first.picks, curve("a", "line", "Line 1"));
      assert(cleared.status === "more" && cleared.picks.length === 0, "picking the same curve again takes it back");
      const done = run("parallel", [curve("a", "line", "Line 1"), curve("b", "line", "Line 2")]);
      assert(done.status === "ready" && done.picks.length === 0 && /still on/u.test(done.prompt), "after a relation the tool is still on, with no picks");
    }
  },
  {
    name: "Constraint tools: Coincident joins points or puts a point on a curve, Midpoint takes a point and a line in either order, Fix takes a curve or a point, Symmetric takes the axis last",
    run: () => {
      equal(made(run("coincident", [point("a", "line", "end", "Line 1 end"), point("b", "line", "start", "Line 2 start")])), "coincident:entity:a+entity:b@end+start", "two points: the second moves onto the first");
      equal(made(run("coincident", [point("a", "line", "end", "Line 1 end"), curve("c", "circle", "Circle 1")])), "coincident:entity:a+entity:c@end+curve", "a point, then a curve: point on curve");
      equal(made(run("coincident", [curve("b", "line", "Line 2"), point("c", "circle", "center", "Circle 1 center")])), "coincident:entity:b+entity:c@curve+center", "a curve, then a point");
      assert(run("coincident", [curve("a", "line", "Line 1"), curve("b", "line", "Line 2")]).status === "refused", "two curves are not a Coincident");
      assert(run("coincident", [point("a", "line", "start", "Line 1 start"), point("a", "line", "end", "Line 1 end")]).status === "refused", "two points of one shape would collapse it");
      const origin: ConstraintToolPick = { entityId: SKETCH_ORIGIN_ID, kind: "origin", ref: "self", label: "Sketch origin" };
      equal(made(run("coincident", [origin, point("c", "circle", "center", "Circle 1 center")])), `coincident:${SKETCH_ORIGIN_ID}+entity:c@self+center`, "the origin is a point to join to");
      assert(run("coincident", [point("a", "line", "end", "Line 1 end"), curve("s", "spline", "Spline 1")]).status === "refused", "a point cannot be put on a spline");

      equal(made(run("midpoint", [point("c", "circle", "center", "Circle 1 center"), curve("a", "line", "Line 1")])), "midpoint:entity:c+entity:a@center", "point, then line");
      equal(made(run("midpoint", [curve("a", "line", "Line 1"), point("c", "circle", "center", "Circle 1 center")])), "midpoint:entity:c+entity:a@center", "line, then point: the same relation");
      const swapped = run("midpoint", [point("c", "circle", "center", "Circle 1 center"), point("b", "line", "end", "Line 2 end")]);
      assert(swapped.status === "more" && swapped.picks.length === 1 && swapped.picks[0]!.entityId === "entity:b", "a second point replaces the first");
      assert(run("midpoint", [point("a", "line", "end", "Line 1 end"), curve("a", "line", "Line 1")]).status === "refused", "a line's own end cannot be its middle");
      assert(constraintToolStep("midpoint", [], curve("c", "circle", "Circle 1")).status === "refused", "Midpoint does not start with a circle");

      equal(made(run("fixed", [curve("a", "line", "Line 1")])), "fixed:entity:a", "Fix a curve with one click");
      equal(made(run("fixed", [point("a", "line", "end", "Line 1 end")])), "fixed:entity:a@end", "or one of its points");
      assert(run("fixed", [origin]).status === "refused", "the origin is already fixed");

      equal(made(run("symmetry", [curve("a", "line", "Line 1"), curve("b", "line", "Line 2"), curve("x", "line", "Line 3")])), "symmetry:entity:a+entity:b+entity:x", "two curves, then the axis");
      assert(run("symmetry", [curve("a", "line", "Line 1"), curve("b", "line", "Line 2"), curve("c", "circle", "Circle 1")]).status === "refused", "the axis must be a line");
      assert(run("symmetry", [curve("a", "line", "Line 1"), curve("c", "circle", "Circle 1"), curve("x", "line", "Line 3")]).status === "refused", "the two curves must be of the same kind");
      assert(CONSTRAINT_TOOLS.every((tool) => isConstraintToolKind(tool) && CONSTRAINT_TOOL_INFO[tool].prompt.length > 20) && !isConstraintToolKind("distance"), "every tool has a prompt; a dimension is not a constraint tool");
    }
  },
  {
    name: "Constraint tools: the relations the picks build are solved by the sketch, one after another without leaving the tool",
    run: () => {
      let project = sketchOf([line("a", [0, 0], [40, 0]), line("b", [0, 20], [38, 26]), circ("c", 70, 30, 8), line("t", [50, 10], [90, 12])]);
      const before = analyzeWorkbenchSketch(project.sketch).degreesOfFreedom;
      // Parallel, used twice in a row: b to a, then t to a.
      project = add(project, run("parallel", [curve("a", "line", "Line 1"), curve("b", "line", "Line 2")]));
      project = add(project, run("parallel", [curve("a", "line", "Line 1"), curve("t", "line", "Line 3")]));
      const b = project.sketch.entities.find((entity) => entity.id === "entity:b");
      const t = project.sketch.entities.find((entity) => entity.id === "entity:t");
      assert(b?.kind === "line" && t?.kind === "line", "lines");
      near(b.end[1] - b.start[1], 0, 1e-6, "Line 2 is parallel to Line 1");
      near(t.end[1] - t.start[1], 0, 1e-6, "and so is Line 3");
      // Tangent: the circle moves to touch Line 3.
      project = add(project, run("tangent", [curve("t", "line", "Line 3"), curve("c", "circle", "Circle 1")]));
      const circle = project.sketch.entities.find((entity) => entity.id === "entity:c");
      const touched = project.sketch.entities.find((entity) => entity.id === "entity:t");
      assert(circle?.kind === "circle" && touched?.kind === "line", "circle and line");
      near(Math.abs(circle.center[1] - touched.start[1]), circle.radiusMm, 1e-6, "the circle touches the line");
      // Coincident, point on curve: the end of Line 2 is put on Line 1's line.
      project = add(project, run("coincident", [curve("a", "line", "Line 1"), point("b", "line", "start", "Line 2 start")]));
      const moved = project.sketch.entities.find((entity) => entity.id === "entity:b");
      const base = project.sketch.entities.find((entity) => entity.id === "entity:a");
      assert(moved?.kind === "line" && base?.kind === "line", "lines");
      const off = (base.end[0] - base.start[0]) * (moved.start[1] - base.start[1]) - (base.end[1] - base.start[1]) * (moved.start[0] - base.start[0]);
      near(off / Math.hypot(base.end[0] - base.start[0], base.end[1] - base.start[1]), 0, 1e-6, "the start of Line 2 lies on Line 1");
      const after = analyzeWorkbenchSketch(project.sketch);
      equal(after.conflicts.length, 0, "nothing conflicts");
      assert(after.degreesOfFreedom < before, `the relations took freedom away (${before} to ${after.degreesOfFreedom})`);
    }
  },
  {
    name: "Constraint tools: each has a keymap command with no default key, can be given one, and Esc ends the tool",
    run: () => {
      const commands = SKETCH_KEYMAP_COMMANDS.filter((info) => info.group === "Constrain");
      equal(commands.map((info) => info.id).join(), CONSTRAINT_TOOLS.map((tool) => `constraint:${tool}`).join(), "one command per tool, in the ribbon's order");
      assert(commands.every((info) => info.defaultKey === undefined), "none takes a key by default");
      equal(keymapConflicts(DEFAULT_SKETCH_KEYMAP.keys).length, 0, "the default keymap still has no conflicts");
      const bound = rebindKey(DEFAULT_SKETCH_KEYMAP, "constraint:parallel", "J");
      assert(bound.ok, "Parallel can be given J");
      if (!bound.ok) return;
      const action = resolveSketchHotkey({ key: "j", ctrl: false, meta: false, alt: false, shift: false }, context, bound.keymap);
      equal(JSON.stringify(action), JSON.stringify({ kind: "constraint-tool", tool: "parallel" }), "J starts the Parallel tool");
      equal(resolveSketchHotkey({ key: "j", ctrl: false, meta: false, alt: false, shift: false }, context), undefined, "without the binding J does nothing");
      equal(resolveSketchHotkey({ key: "Escape", ctrl: false, meta: false, alt: false, shift: false }, { ...context, pickingRelation: true, selectionCount: 2 })?.kind, "exit-pick", "Esc ends the constraint tool before it clears the selection");
      const search = searchableCommands(bound.keymap);
      const parallel = search.find((record) => record.id === "command:sketch-constraint-parallel");
      assert(parallel !== undefined && parallel.name === "Parallel constraint" && parallel.shortcut === "J", "the command search finds the tool and shows its key");
      equal(JSON.stringify(parallel.action), JSON.stringify({ kind: "sketch-command", command: "constraint:parallel" }), "and runs it through the sketch command path");
      equal(search.filter((record) => record.id.startsWith("command:sketch-constraint-")).length, 12, "all twelve are searchable");
      assert(searchableCommands().find((record) => record.id === "command:sketch-constraint-tangent")?.shortcut === undefined, "no key is shown for a tool that has none");
    }
  },
  {
    name: "Constraint tools: the ribbon has a Constraints group whose active tool shows pressed, and the canvas names the active tool and what to pick",
    run: () => {
      const project = { ...createWorkbenchProject("project:constraint-ribbon"), activeWorkspace: "sketch" as const };
      const base = { project, masterCartOpen: false, displayUnit: "mm", sketchTool: "select", sketchDimensionMode: false, sketchEditTool: null, sketchShowMovable: false, sketchCheckOpen: false, sketchProjectReference: false, selectedId: null, assemblyExplodeMaxMm: 0, sketchConstraintTool: "parallel" };
      const props = new Proxy(base as Record<string, unknown>, { get: (target, key) => (key in target ? target[key as string] : typeof key === "string" && key.startsWith("on") ? noop : undefined), has: () => true });
      const html = renderToStaticMarkup(createElement(WorkbenchRibbon, props as never));
      const group = /<div class="ribbon-group" role="group" aria-label="Constraints">(.*?)<small>Constraints<\/small>/u.exec(html)?.[1] ?? "";
      assert(group.length > 0, "the Constraints group is on the sketch ribbon");
      for (const tool of CONSTRAINT_TOOLS) assert(group.includes(`<strong>${CONSTRAINT_TOOL_INFO[tool].label}</strong>`), `${CONSTRAINT_TOOL_INFO[tool].label} is in the group`);
      equal(group.split('aria-pressed="true"').length - 1, 1, "exactly one tool shows pressed");
      assert(/aria-pressed="true"[^>]*title="Parallel/u.test(group), "and it is Parallel");
      const workspace = readFileSync(new URL("../../apps/studio-web/src/workspaces/SketchWorkspace.tsx", import.meta.url), "utf8");
      assert(workspace.includes("constraint-tool-banner") && workspace.includes('case "constraint-tool": toggleConstraintTool(action.tool); return;'), "the canvas shows the active tool and the key starts it");
      assert(workspace.includes('if (request.command.startsWith("constraint:"))') && workspace.includes("props.onConstraintToolChange?.(pickRelation)"), "the ribbon request starts the tool and the ribbon is told which tool is on");
      const css = readFileSync(new URL("../../apps/studio-web/src/styles/sketch-canvas-ux.css", import.meta.url), "utf8");
      assert(css.includes(".dimension-mode-banner span { font-size: max(0.48rem, 12px);"), "the mode banner text is at least 12 px");
    }
  },
];
