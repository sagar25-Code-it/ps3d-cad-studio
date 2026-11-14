import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { parseWorkbenchProjectText, serializeWorkbenchProject, type SketchEntity, type WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { buildLineRectangle } from "../packages/workbench-sketch/src/index.js";
import { expandOffsetSelection, offsetEntities, OFFSET_TOOL_CHAIN_DEFAULT } from "../packages/workbench-sketch/src/edit-tools.js";
import { SketchEditPanel } from "../apps/studio-web/src/workspaces/SketchEditPanel.js";
import { fresh, pipelineRun } from "./pipeline-kit.js";
import { applyOk, ctx, line, problems, projectWith } from "./edit-test-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * Offset of a rectangle drawn with the rectangle tool. The tool draws four lines, so a click on one side has to take the whole
 * loop: the Offset tool starts with "everything connected", and the result is one closed rectangle with one distance to edit.
 */

type Line = Extract<SketchEntity, { kind: "line" }>;

/** A 40 x 20 rectangle from (0, 0), drawn as the R tool draws it: four lines and the relations that hold them. */
function drawnRectangle(): { readonly project: WorkbenchProject; readonly sideIds: readonly string[] } {
  let entities = 0;
  let constraints = 0;
  const shape = buildLineRectangle("rectangle", [[0, 0], [40, 20]], { entity: () => `entity:r-${entities += 1}`, constraint: () => `constraint:r-${constraints += 1}` });
  assert(shape.ok, "the rectangle builds");
  let project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
  project = pipelineRun(project, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: shape.value.entities, addConstraints: shape.value.constraints, label: "Rectangle" });
  const sideIds = shape.value.entities.filter((entity) => entity.kind === "line" && !entity.construction).map((entity) => entity.id);
  equal(sideIds.length, 4, "the R rectangle is four lines");
  return { project, sideIds };
}

const addedLines = (before: WorkbenchProject, after: WorkbenchProject): readonly Line[] =>
  after.sketch.entities.filter((entity): entity is Line => entity.kind === "line" && !before.sketch.entities.some((candidate) => candidate.id === entity.id));

/** True when the lines close into one loop: every end meets exactly one other end. */
function closesIntoOneLoop(lines: readonly Line[]): boolean {
  const ends = lines.flatMap((entity) => [entity.start, entity.end]);
  return ends.every((point) => ends.filter((other) => Math.hypot(other[0] - point[0], other[1] - point[1]) < 1e-6).length === 2);
}

const extent = (lines: readonly Line[]): { readonly width: number; readonly height: number } => {
  const xs = lines.flatMap((entity) => [entity.start[0], entity.end[0]]);
  const ys = lines.flatMap((entity) => [entity.start[1], entity.end[1]]);
  return { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
};

export const sketchOffsetChainDefaultTests: readonly TestCase[] = [
  {
    name: "Offset, one side of an R rectangle clicked: the tool's default chain takes the whole loop and makes one closed offset rectangle",
    run: () => {
      const { project, sideIds } = drawnRectangle();
      equal(OFFSET_TOOL_CHAIN_DEFAULT, "connected", "the Offset tool starts with everything connected");
      for (const picked of sideIds) {
        equal(expandOffsetSelection(project.sketch, [picked], OFFSET_TOOL_CHAIN_DEFAULT).length, 4, `a click on ${picked} reaches all four sides`);
        const offset = applyOk(project, offsetEntities(ctx(project), [picked], 2, { chain: OFFSET_TOOL_CHAIN_DEFAULT }));
        const made = addedLines(project, offset);
        equal(made.length, 4, "four lines were made, not one");
        assert(closesIntoOneLoop(made), "and they close into one loop");
        near(extent(made).width, 44, 1e-6, "2 mm outside a 40 mm width is 44");
        near(extent(made).height, 24, 1e-6, "and 24 high");
        equal(problems(offset).length, 0, `the sketch is sound: ${problems(offset).join("; ")}`);
      }
      // What the old default did, and still does when it is chosen: a square corner is not tangent, so the chain stops at once.
      equal(expandOffsetSelection(project.sketch, [sideIds[0]!], "tangent").length, 1, "a tangent chain stops at the square corners");
      equal(addedLines(project, applyOk(project, offsetEntities(ctx(project), [sideIds[0]!], 2, { chain: "tangent" }))).length, 1, "which gives a single parallel line");
    }
  },
  {
    name: "Offset of an R rectangle has one distance to edit: changing it moves all four sides, and it survives save and reload",
    run: () => {
      const { project, sideIds } = drawnRectangle();
      const offset = applyOk(project, offsetEntities(ctx(project), [sideIds[0]!], 2, { chain: OFFSET_TOOL_CHAIN_DEFAULT }));
      const distances = offset.sketch.constraints.filter((constraint) => constraint.kind === "distance" && constraint.offsetGroup !== undefined);
      assert(distances.length >= 1, "the copy holds its distance to the source");
      equal(new Set(distances.map((constraint) => constraint.offsetGroup)).size, 1, "all its distances are one group, shown as one dimension");
      const shown = distances[0]!;
      const wider = pipelineRun(offset, { kind: "set-sketch-dimension", entityId: shown.entityIds[0]!, secondEntityId: shown.entityIds[1]!, dimension: shown.dimension === "offset" ? "offset" : "line-line", valueMm: 5 });
      const made = addedLines(project, wider);
      assert(closesIntoOneLoop(made), "the copy is still one closed loop");
      near(extent(made).width, 50, 1e-5, "5 mm outside a 40 mm width is 50");
      near(extent(made).height, 30, 1e-5, "and 30 high: every side followed the one distance");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(wider));
      assert(reloaded.ok, "the sketch reloads");
      if (!reloaded.ok) return;
      equal(reloaded.value.sketch.constraints.filter((constraint) => constraint.offsetGroup !== undefined).length, distances.length, "with its offset group");
    }
  },
  {
    name: "Offset with everything connected never fails because of a branch: a line leaving a corner of the outline falls back to what was picked",
    run: () => {
      // An L of two lines with a third line leaving their shared corner: three curves meet there, so they are not one chain.
      const base = projectWith([line("a", [0, 0], [40, 0]), line("b", [40, 0], [40, 20]), line("rib", [40, 0], [60, -10])]);
      const result = offsetEntities(ctx(base), ["entity:a"], 2, { chain: "connected" });
      assert(result.ok, `the offset is not refused: ${result.ok ? "" : result.diagnostics[0]?.message ?? ""}`);
      const offset = applyOk(base, result);
      equal(addedLines(base, offset).length, 1, "the picked line alone is offset");
    }
  },
  {
    name: "Offset panel: the Chain option opens on Everything connected and lists it first",
    run: () => {
      const { project, sideIds } = drawnRectangle();
      const noop = (): void => undefined;
      const html = renderToStaticMarkup(createElement(SketchEditPanel, { tool: "offset", sketch: project.sketch, selectionIds: [sideIds[0]!], onApply: noop, onMessage: noop, onClose: noop }));
      const select = /<select aria-label="Offset chain selection">.*?<\/select>/u.exec(html)?.[0] ?? "";
      assert(select !== "", "the chain option is rendered");
      assert(/<option value="connected" selected="">Everything connected<\/option>/u.test(select), `Everything connected is the chosen option: ${select}`);
      assert(select.indexOf("Everything connected") < select.indexOf("Tangent chain"), "and it is listed first");
      assert(html.includes("adds 4 curves"), `the preview line counts the whole loop for one picked side: ${/Apply[^<]*/u.exec(html)?.[0] ?? html.slice(0, 200)}`);
    }
  },
];
