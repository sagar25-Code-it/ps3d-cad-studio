import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { applyWorkbenchOperation, offsetGroupFollowerIds, parseWorkbenchProjectText, serializeWorkbenchProject, validateWorkbenchProject, type SketchEntity, type WorkbenchProject, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { analyzeLiveSketch } from "../packages/workbench-core/src/sketch-analysis.js";
import { arcShape, measureDimensionConstraint } from "../packages/workbench-core/src/sketch-measure.js";
import { offsetEntities } from "../packages/workbench-sketch/src/edit-tools.js";
import { buildSlot } from "../packages/workbench-sketch/src/shapes.js";
import { pointDistanceLayout } from "../packages/workbench-sketch/src/point-distance-layout.js";
import { ExtraDimensionMarks } from "../apps/studio-web/src/workspaces/sketch/ConstraintExtras.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { applyOk, circle, con, ctx, line, problems, projectWith } from "./edit-test-kit.js";

/**
 * An Offset stays tied to its source. A copy of a circle or arc keeps the gap to its source (not only the shared centre), and all the
 * distances of one Offset are one dimension: one is shown, and setting it moves the whole copy.
 */

let serial = 0;
function setDimension(project: WorkbenchProject, request: { readonly entityId: string; readonly dimension: string; readonly valueMm: number; readonly secondEntityId?: string }): WorkbenchProject {
  serial += 1;
  const result = applyWorkbenchOperation(project, { kind: "set-sketch-dimension", operationId: `operation:offset-assoc-${serial}`, expectedRevision: project.revision, ...request } as never);
  if (!result.ok) throw new Error(`set-sketch-dimension refused: ${result.diagnostics[0]?.message}`);
  return result.value.project;
}

const radiusOf = (project: WorkbenchProject, id: string): number => {
  const entity = project.sketch.entities.find((candidate) => candidate.id === id);
  if (entity?.kind === "circle") return entity.radiusMm;
  assert(entity?.kind === "arc", `${id} is a circle or an arc`);
  return arcShape(entity.start, entity.mid, entity.end)!.radiusMm;
};

const offsetsOf = (project: WorkbenchProject): readonly WorkbenchSketchConstraint[] =>
  project.sketch.constraints.filter((constraint) => constraint.kind === "distance" && (constraint.dimension === "offset" || constraint.offsetGroup !== undefined));

/** How far each copy is from its source: the perpendicular distance for two lines, the difference of the radii for two arcs. */
function gapsOf(project: WorkbenchProject, pairs: readonly (readonly [string, string])[]): readonly number[] {
  return pairs.map(([sourceId, copyId]) => {
    const source = project.sketch.entities.find((entity) => entity.id === sourceId);
    const kind = source?.kind === "line" ? "line-line" : "offset";
    return measureDimensionConstraint(project.sketch, { id: "constraint:probe", kind: "distance", entityIds: [sourceId, copyId], dimension: kind, driven: true }) ?? NaN;
  });
}

function slotIds(): { readonly entity: () => string; readonly constraint: () => string } {
  let entities = 0;
  let constraints = 0;
  return { entity: () => `entity:slot-${entities += 1}`, constraint: () => `constraint:slot-${constraints += 1}` };
}

/** A slot between (0, 0) and (30, 0), 12 mm wide, held level with one cap centre on the origin, with its cap radius dimensioned. */
function slotProject(): { readonly project: WorkbenchProject; readonly sources: readonly SketchEntity[] } {
  const built = buildSlot([0, 0], [30, 0], [15, 6], slotIds());
  assert(built.ok, "the slot builds");
  const sources = built.value.entities.filter((entity) => !entity.construction);
  const firstArc = sources.find((entity) => entity.kind === "arc")!;
  const project = projectWith(built.value.entities, [...built.value.constraints, { id: "constraint:cap-radius", kind: "radius", entityIds: [firstArc.id], valueMm: 6, dimension: "radius" }]);
  return { project, sources };
}

export const sketchOffsetAssociativeTests: readonly TestCase[] = [
  {
    name: "Offset of a circle keeps one editable gap to its source: resizing the source carries the copy, and the gap can be set afterwards",
    run: () => {
      const base = projectWith([circle("c", [5, 5], 10)], [con("dia", "radius", ["c"], { valueMm: 20, dimension: "diameter" })]);
      const offset = applyOk(base, offsetEntities(ctx(base), ["entity:c"], 3));
      const copy = offset.sketch.entities.find((entity) => entity.id !== "entity:c")!;
      near(radiusOf(offset, copy.id), 13, 1e-9, "the copy is 3 mm outside the circle");
      const gaps = offsetsOf(offset);
      equal(gaps.length, 1, "one offset dimension was made");
      equal(gaps[0]!.dimension, "offset", "it is the gap between the two circles");
      equal(gaps[0]!.valueMm, 3, "and holds the 3 mm that was asked for");
      assert(offset.sketch.constraints.some((constraint) => constraint.kind === "concentric"), "the copy shares the centre of its source");
      equal(problems(offset).length, 0, `the sketch is sound: ${problems(offset).join("; ")}`);
      equal(analyzeLiveSketch(offset.sketch).redundant.length, 0, "nothing is over-defined");

      // The source grows from a 20 mm to a 30 mm diameter: the copy keeps its 3 mm gap (it stayed at 13 mm before).
      const resized = setDimension(offset, { entityId: "entity:c", dimension: "diameter", valueMm: 30 });
      near(radiusOf(resized, "entity:c"), 15, 1e-6, "the source has its new size");
      near(radiusOf(resized, copy.id), 18, 1e-6, "and the copy followed it");

      // The gap itself is edited: the copy moves, the source does not.
      const widened = setDimension(resized, { entityId: "entity:c", secondEntityId: copy.id, dimension: "offset", valueMm: 5 });
      near(radiusOf(widened, "entity:c"), 15, 1e-6, "the source stayed as it was");
      near(radiusOf(widened, copy.id), 20, 1e-6, "the copy is now 5 mm out");
      equal(widened.revision, resized.revision + 1, "one edit, one step to undo");

      // Save and reload: the dimension and the geometry come back.
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(widened));
      assert(reloaded.ok, "the project reloads");
      equal(offsetsOf(reloaded.value)[0]?.valueMm, 5, "with the 5 mm offset");
      near(radiusOf(reloaded.value, copy.id), 20, 1e-9, "and the copy where it was");
      const again = setDimension(reloaded.value, { entityId: "entity:c", dimension: "diameter", valueMm: 40 });
      near(radiusOf(again, copy.id), 25, 1e-6, "and still follows its source after the reload");
    }
  },
  {
    name: "An inward offset of a circle stays inside it when its value is changed",
    run: () => {
      const base = projectWith([circle("c", [0, 0], 10)]);
      const offset = applyOk(base, offsetEntities(ctx(base), ["entity:c"], -3));
      const copy = offset.sketch.entities.find((entity) => entity.id !== "entity:c")!;
      near(radiusOf(offset, copy.id), 7, 1e-9, "the copy is 3 mm inside");
      equal(offsetsOf(offset)[0]!.valueMm, 3, "the gap is stored as a positive distance");
      equal(offsetsOf(offset)[0]!.inside, true, "marked as inside its source");
      const dimensioned: WorkbenchProject = { ...offset, sketch: { ...offset.sketch, constraints: [...offset.sketch.constraints, con("r", "radius", ["c"], { valueMm: 10, dimension: "radius" })] } };
      const shrunk = setDimension(dimensioned, { entityId: "entity:c", dimension: "radius", valueMm: 5 });
      near(radiusOf(shrunk, copy.id), 2, 1e-6, "and stays inside when the source shrinks past the size the copy had");
      const closer = setDimension(offset, { entityId: "entity:c", secondEntityId: copy.id, dimension: "offset", valueMm: 4 });
      near(radiusOf(closer, copy.id), 6, 1e-6, "4 mm puts it 4 mm inside, not outside");
      near(radiusOf(closer, "entity:c"), 10, 1e-6, "the source did not move");
    }
  },
  {
    name: "Offset of a slot is one dimension: every piece shares its group, one is shown, and setting it moves the whole copy",
    run: () => {
      const { project: base, sources } = slotProject();
      const offset = applyOk(base, offsetEntities(ctx(base), sources.map((entity) => entity.id), 2, { chain: "connected" }));
      const made = offset.sketch.entities.filter((entity) => !base.sketch.entities.some((candidate) => candidate.id === entity.id));
      equal(made.length, 4, "two lines and two arcs were made");
      // Each source curve with its copy, read from the Parallel and Concentric relations the offset made.
      const pairs = offset.sketch.constraints.filter((constraint) => (constraint.kind === "parallel" || constraint.kind === "concentric") && made.some((entity) => entity.id === constraint.entityIds[1])).map((constraint) => [constraint.entityIds[0]!, constraint.entityIds[1]!] as const);
      const group = offsetsOf(offset);
      assert(group.length >= 1, "the copy holds its distance to its source");
      equal(new Set(group.map((constraint) => constraint.offsetGroup)).size, 1, "every distance of the offset shares one group");
      assert(group[0]!.offsetGroup !== undefined, "and the group has an id");
      equal(offsetGroupFollowerIds(offset.sketch.constraints).size, group.length - 1, "all but the one that is shown follow it");
      equal(problems(offset).length, 0, `the sketch is sound: ${problems(offset).join("; ")}`);
      equal(analyzeLiveSketch(offset.sketch).conflicting.length, 0, "nothing conflicts");
      equal(analyzeLiveSketch(offset.sketch).redundant.length, 0, "nothing is over-defined");
      equal(analyzeLiveSketch(offset.sketch).degreesOfFreedom, analyzeLiveSketch(base.sketch).degreesOfFreedom, "the copy adds no freedom: it is fully held by its source");

      // The canvas draws one dimension for the offset, not four.
      const svg = renderToStaticMarkup(createElement("svg", null, createElement(ExtraDimensionMarks, { sketch: offset.sketch, px: 0.5, onEdit: () => undefined })));
      const shown = group.filter((constraint) => svg.includes(`data-dimension-constraint="${constraint.id}"`));
      equal(shown.length, 1, "one offset dimension is on the canvas");

      // Setting the shown one moves every piece of the copy to 4 mm; the source slot stays where it was.
      const leader = shown[0]!;
      const widened = setDimension(offset, { entityId: leader.entityIds[0]!, secondEntityId: leader.entityIds[1]!, dimension: leader.dimension!, valueMm: 4 });
      for (const constraint of offsetsOf(widened)) equal(constraint.valueMm, 4, "every distance of the group took the new value");
      for (const gap of gapsOf(widened, pairs)) near(gap, 4, 1e-5, "every piece of the copy is 4 mm from its source");
      for (const source of sources) equal(JSON.stringify(widened.sketch.entities.find((entity) => entity.id === source.id)), JSON.stringify(source), "the source curve did not move");
      equal(problems(widened).length, 0, `the copy is still closed and solved: ${problems(widened).join("; ")}`);
      equal(widened.revision, offset.revision + 1, "one edit, one step to undo");

      // The slot gets wider (cap radius 6 to 8): the copy follows, still 4 mm out all round.
      const capId = sources.find((entity) => entity.kind === "arc")!.id;
      const fatter = setDimension(widened, { entityId: capId, dimension: "radius", valueMm: 8 });
      for (const gap of gapsOf(fatter, pairs)) near(gap, 4, 1e-5, "the copy kept its distance to the resized slot");
      near(radiusOf(fatter, pairs.find((pair) => pair[0] === capId)![1]), 12, 1e-5, "the copy's cap is the 8 mm cap plus 4 mm");

      // Save and reload keeps the group; deleting one member leaves the rest working.
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(fatter));
      assert(reloaded.ok, "the project reloads");
      equal(new Set(offsetsOf(reloaded.value).map((constraint) => constraint.offsetGroup)).size, 1, "with its offset group");
      const fewer: WorkbenchProject = { ...reloaded.value, sketch: { ...reloaded.value.sketch, constraints: reloaded.value.sketch.constraints.filter((constraint) => constraint.id !== leader.id) } };
      equal(offsetGroupFollowerIds(fewer.sketch.constraints).size, Math.max(0, group.length - 2), "the next member is shown when the first is deleted");
    }
  },
  {
    name: "Offset corners closed with an added round carry no offset dimension, and an offset saved before this change loads and behaves as it did",
    run: () => {
      const corner = projectWith([line("a", [0, 0], [40, 0]), line("b", [40, 0], [40, 30])], [con("j", "coincident", ["a", "b"], { points: ["end", "start"] })]);
      const rounded = applyOk(corner, offsetEntities(ctx(corner), ["entity:a", "entity:b"], 5, { corner: "round", chain: "connected", sidePoint: [50, -10] }));
      assert(rounded.sketch.entities.some((entity) => entity.kind === "arc"), "the outside corner was closed with a round");
      equal(offsetsOf(rounded).length, 0, "so this copy is not driven by an offset dimension (the round has no source curve)");

      // What an offset circle looked like before: Concentric only. It still loads, and the copy still does not follow.
      const old = projectWith([circle("c", [0, 0], 10), circle("o", [0, 0], 13)], [con("cc", "concentric", ["c", "o"]), con("r", "radius", ["c"], { valueMm: 10, dimension: "radius" })]);
      const checked = validateWorkbenchProject(JSON.parse(JSON.stringify(old)) as unknown);
      assert(checked.ok, "the older sketch is valid");
      const grown = setDimension(old, { entityId: "entity:c", dimension: "radius", valueMm: 12 });
      near(radiusOf(grown, "entity:o"), 13, 1e-9, "the old copy keeps its own size, as before");

      // The new fields are checked: a malformed group id, or a group on something that is not a distance, is refused.
      const withGroup = (constraint: WorkbenchSketchConstraint): boolean => validateWorkbenchProject(JSON.parse(JSON.stringify({ ...old, sketch: { ...old.sketch, constraints: [constraint] } })) as unknown).ok;
      assert(withGroup({ id: "constraint:g", kind: "distance", entityIds: ["entity:c", "entity:o"], valueMm: 3, dimension: "offset", offsetGroup: "offset:a1" }), "a well-formed offset distance is accepted");
      assert(!withGroup({ id: "constraint:g", kind: "distance", entityIds: ["entity:c", "entity:o"], valueMm: 3, dimension: "offset", offsetGroup: "Not An Id" }), "a malformed group id is refused");
      assert(!withGroup({ id: "constraint:g", kind: "concentric", entityIds: ["entity:c", "entity:o"], offsetGroup: "offset:a1" }), "a group on a relation that is not a distance is refused");
      const onLines = projectWith([line("a", [0, 0], [10, 0]), line("b", [0, 5], [10, 5])]);
      const refused = applyWorkbenchOperation(onLines, { kind: "set-sketch-dimension", operationId: "operation:offset-assoc-lines", expectedRevision: onLines.revision, entityId: "entity:a", secondEntityId: "entity:b", dimension: "offset", valueMm: 5 } as never);
      assert(!refused.ok && /two circles or arcs/u.test(refused.diagnostics[0]?.message ?? ""), "an offset gap between two lines is refused with the reason");
    }
  },
  {
    name: "The offset dimension is drawn across the gap between the curve and its copy",
    run: () => {
      const sketch = { entities: [circle("c", [0, 0], 10), circle("o", [0, 0], 13)] };
      const layout = pointDistanceLayout(sketch, { id: "constraint:gap", kind: "distance", entityIds: ["entity:c", "entity:o"], valueMm: 3, dimension: "offset" }, 3, 0.5);
      assert(layout !== undefined, "the dimension has a layout");
      equal(layout.label, "3", "its text is the gap");
      const span = Math.hypot(layout.dimensionLine.to[0] - layout.dimensionLine.from[0], layout.dimensionLine.to[1] - layout.dimensionLine.from[1]);
      near(span, 3, 1e-9, "the dimension line is as long as the gap");
      equal(layout.arrows.length, 2, "with an arrow at each curve");
    }
  }
];
