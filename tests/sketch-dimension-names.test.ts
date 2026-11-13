import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { designOf, evaluateTextInDesign, nameSketchDimensions, parseWorkbenchProjectText, serializeWorkbenchProject, type SketchEntity, type WorkbenchProject, type WorkbenchSketchConstraint } from "../packages/workbench-core/src/index.js";
import { insertAtSelection } from "../packages/workbench-sketch/src/dimension-text.js";
import { DimensionEditor } from "../apps/studio-web/src/workspaces/sketch/DimensionEditor.js";
import { fresh, line, message, pipelineApply, pipelineRun } from "./pipeline-kit.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/**
 * Every driving dimension has a name (d1, d2 ...). Another dimension's value can be an expression that uses it and then follows it.
 */

/** Three separate level lines, each pinned at its start, the first two with a length dimension typed as they were drawn. */
function threeLines(): WorkbenchProject {
  const project = pipelineRun(fresh(), { kind: "new-design-sketch", plane: "datum:xy" });
  const pin = (id: string): WorkbenchSketchConstraint[] => [
    { id: `constraint:fix-${id}`, kind: "fixed", entityIds: [`entity:${id}`], points: ["start"] },
    { id: `constraint:level-${id}`, kind: "horizontal", entityIds: [`entity:${id}`] }
  ];
  return pipelineRun(project, {
    kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], label: "Lines",
    addEntities: [line("a", [0, 0], [80, 0]), line("b", [0, 20], [50, 20]), line("c", [0, 40], [30, 40])],
    addConstraints: [
      ...pin("a"), ...pin("b"), ...pin("c"),
      { id: "constraint:len-a", kind: "distance", entityIds: ["entity:a"], valueMm: 80, dimension: "length" },
      { id: "constraint:len-b", kind: "distance", entityIds: ["entity:b"], valueMm: 50, dimension: "length" }
    ]
  });
}

const dim = (project: WorkbenchProject, id: string): WorkbenchSketchConstraint => {
  const found = project.sketch.constraints.find((constraint) => constraint.id === id);
  assert(found !== undefined, `${id} is stored`);
  return found;
};
const lengthOf = (project: WorkbenchProject, id: string): number => {
  const entity = project.sketch.entities.find((candidate): candidate is Extract<SketchEntity, { kind: "line" }> => candidate.id === id && candidate.kind === "line");
  assert(entity !== undefined, `${id} is a line`);
  return Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]);
};
const lengthDimension = (project: WorkbenchProject, entityId: string): WorkbenchSketchConstraint => {
  const found = project.sketch.constraints.find((constraint) => constraint.kind === "distance" && constraint.dimension === "length" && constraint.entityIds[0] === entityId);
  assert(found !== undefined, `${entityId} has a length dimension`);
  return found;
};

export const sketchDimensionNameTests: readonly TestCase[] = [
  {
    name: "Dimension names: every driving dimension drawn or set gets d1, d2 ... in order; relations and reference dimensions get none",
    run: () => {
      let project = threeLines();
      equal(dim(project, "constraint:len-a").name, "d1", "the first dimension is d1");
      equal(dim(project, "constraint:len-b").name, "d2", "the second is d2");
      assert(project.sketch.constraints.filter((constraint) => constraint.kind !== "distance").every((constraint) => constraint.name === undefined), "a relation has no name");
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:c", dimension: "length", valueMm: 30 });
      equal(lengthDimension(project, "entity:c").name, "d3", "a dimension set with the D tool is named next");
      // Changing a value keeps the name; making it a reference drops it; a new dimension never takes a number that is still referred to.
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 90 });
      equal(dim(project, "constraint:len-a").name, "d1", "the name survives a change of value");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(project));
      assert(reloaded.ok && reloaded.value.sketch.constraints.find((constraint) => constraint.id === "constraint:len-b")?.name === "d2", "names are saved and loaded");
      const reference = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:c", dimension: "length", valueMm: 1, driven: true });
      equal(lengthDimension(reference, "entity:c").name, undefined, "a reference dimension has no name");
      // A sketch saved before names existed loads as it is and is named by its first edit.
      const old = { ...project.sketch, constraints: project.sketch.constraints.map(({ name: _name, ...rest }) => rest) };
      const named = nameSketchDimensions(old, old, designOf(project));
      equal(named.constraints.filter((constraint) => constraint.name !== undefined).map((constraint) => constraint.name).join(","), "d1,d2,d3", "an unnamed sketch is named in order");
      equal(nameSketchDimensions(named, named, designOf(project)), named, "and naming again changes nothing");
    }
  },
  {
    name: "A dimension typed as d1 / 2 follows d1: changing d1 re-drives it, through a chain, in the same step",
    run: () => {
      let project = threeLines();
      const bound = evaluateTextInDesign(designOf(project), "d1 / 2", project.sketch);
      assert(bound.ok && bound.quantity.value === 40 && bound.quantity.length === 1, "d1 / 2 reads as 40 mm");
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:b", dimension: "length", valueMm: 1, expression: "d1 / 2" });
      equal(dim(project, "constraint:len-b").expression, "d1 / 2", "the expression is kept on the dimension");
      near(lengthOf(project, "entity:b"), 40, 1e-6, "line b is 40 long");
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:c", dimension: "length", valueMm: 1, expression: "d2 + 5" });
      near(lengthOf(project, "entity:c"), 45, 1e-6, "line c is d2 + 5 = 45");
      const before = project.revision;
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 100 });
      equal(project.revision, before + 1, "one step");
      near(lengthOf(project, "entity:a"), 100, 1e-6, "d1 is 100");
      near(lengthOf(project, "entity:b"), 50, 1e-6, "d2 followed to 50");
      near(lengthOf(project, "entity:c"), 55, 1e-6, "and d3 followed d2 to 55");
      equal(dim(project, "constraint:len-b").valueMm, 50, "the stored value is the evaluated one");
      const reloaded = parseWorkbenchProjectText(serializeWorkbenchProject(project));
      assert(reloaded.ok && reloaded.value.sketch.constraints.find((constraint) => constraint.id === "constraint:len-b")?.expression === "d1 / 2", "the binding survives save and reload");
    }
  },
  {
    name: "Dimension names in expressions: a circle of references and an unknown name are refused with the reason; a finished sketch's dimension can be used",
    run: () => {
      let project = threeLines();
      project = pipelineRun(project, { kind: "set-sketch-dimension", entityId: "entity:b", dimension: "length", valueMm: 1, expression: "d1 / 2" });
      const circular = pipelineApply(project, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 1, expression: "d2 * 2" });
      assert(!circular.ok && /Circular reference/u.test(message(circular)), `d1 cannot depend on d2 while d2 depends on d1 (${message(circular)})`);
      const self = pipelineApply(project, { kind: "set-sketch-dimension", entityId: "entity:a", dimension: "length", valueMm: 1, expression: "d1 + 1" });
      assert(!self.ok && /Circular reference/u.test(message(self)), "nor on itself");
      const unknown = evaluateTextInDesign(designOf(project), "d99 + 1", project.sketch);
      assert(!unknown.ok && /No dimension is called "d99"/u.test(unknown.message), "an unknown dimension name is named in the message");
      // Deleting d1 does not leave d2 pointing at nothing: d2 keeps its 40 as a plain number, and the sketch can still be edited.
      const removal = pipelineApply(project, { kind: "delete-sketch-constraint", constraintId: "constraint:len-a" });
      assert(removal.ok, "the dimension can be deleted");
      if (!removal.ok) return;
      assert(/d2 used the name of a dimension that is gone/u.test(removal.value.summary), `the status says what happened to d2 (${removal.value.summary})`);
      const deleted = removal.value.project;
      equal(dim(deleted, "constraint:len-b").expression, undefined, "d2 is no longer bound");
      equal(dim(deleted, "constraint:len-b").valueMm, 40, "and keeps its value");
      const next = pipelineRun(deleted, { kind: "set-sketch-dimension", entityId: "entity:c", dimension: "length", valueMm: 30 });
      equal(lengthDimension(next, "entity:c").name, "d3", "a new dimension is named next and the edit is accepted");
      // After Finish Sketch the dimensions of that sketch can be used in the next one.
      let design = pipelineRun(project, { kind: "commit-design-sketch", featureId: "feature:s1", name: "Sketch 1" });
      design = pipelineRun(design, { kind: "new-design-sketch", plane: "datum:xy", offsetMm: 5 });
      design = pipelineRun(design, { kind: "apply-sketch-edit", removeEntityIds: [], updateEntities: [], addEntities: [line("z", [0, 0], [10, 0])], addConstraints: [{ id: "constraint:fix-z", kind: "fixed", entityIds: ["entity:z"], points: ["start"] }, { id: "constraint:level-z", kind: "horizontal", entityIds: ["entity:z"] }], label: "Line" });
      design = pipelineRun(design, { kind: "set-sketch-dimension", entityId: "entity:z", dimension: "length", valueMm: 1, expression: "d1 + 5" });
      near(lengthOf(design, "entity:z"), 85, 1e-6, "the new sketch's line is the first sketch's d1 + 5");
      equal(lengthDimension(design, "entity:z").name, "d3", "and its own dimension continues the numbering of the design");
    }
  },
  {
    name: "Dimension editor: clicking another dimension writes its name where the selection is, and the hint says so",
    run: () => {
      equal(insertAtSelection("40", 0, 2, "d1").text, "d1", "with the whole value selected the name replaces it");
      const inside = insertAtSelection("2 * ", 4, 4, "d3");
      equal(`${inside.text}|${inside.caret}`, "2 * d3|6", "at the caret it goes in there and the caret follows");
      equal(insertAtSelection("5 + ", null, null, "d2").text, "5 + d2", "with no known caret it is added at the end");
      equal(insertAtSelection("abc", 9, 2, "x").text, "abcx", "a selection outside the text is clamped");
      const noop = (): void => undefined;
      const html = renderToStaticMarkup(createElement(DimensionEditor, { label: "Length · d2", text: "d1 / 2", unitLabel: "mm", position: [10, 10], onChange: noop, onCommit: noop, onCancel: noop }));
      assert(html.includes("another dimension&#x27;s name such as d1") && html.includes("click that dimension to insert it"), "the editor's hint offers dimension names and the click");
      assert(html.includes("d2"), "and the label carries the dimension's own name");
    }
  },
];
