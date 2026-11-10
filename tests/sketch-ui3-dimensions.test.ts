import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyWorkbenchOperation,
  createWorkbenchProject,
  previewSketchDimensionExpression,
  type SketchDimensionName,
  type SketchEntity,
  type WorkbenchOperation,
  type WorkbenchProject,
  type WorkbenchSketch
} from "../packages/workbench-core/src/index.js";
import { circleDimensionFacts } from "../packages/workbench-sketch/src/dimension-edit-model.js";
import { dimensionAllowsZero, readDimensionText } from "../packages/workbench-sketch/src/dimension-text.js";
import { readSketchLength, SketchUnitContext } from "../apps/studio-web/src/workspaces/sketch-unit.js";
import { applyOf, boundExpressionOf, circleDiameterApply, circleRadiusApply, type AcceptedDimensionRead, type DimensionApply } from "../apps/studio-web/src/workspaces/sketch/dimension-requests.js";
import { SketchWorkspace } from "../apps/studio-web/src/workspaces/SketchWorkspace.js";
import { EntityDimensions } from "../apps/studio-web/src/workspaces/sketch/EntityDimensionFields.js";
import { SolverRelations } from "../apps/studio-web/src/workspaces/sketch/SolverRelations.js";
import { ConstraintExtras } from "../apps/studio-web/src/workspaces/sketch/ConstraintExtras.js";
import { DimensionEditor } from "../apps/studio-web/src/workspaces/sketch/DimensionEditor.js";
import { ORIGIN_DIMENSION_POINT, allDimensionPoints, defaultDimensionPoints, dimensionHandles, resolveDirectSketchDimension, solverPointRef } from "../apps/studio-web/src/workspaces/sketch/dimension-points.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

/** Wave 3 (ui3): dimensions bound to parameters from every field, the circle's diameter and radius agreeing, and the Sketch Dimension points. */

type Op = WorkbenchOperation extends infer T ? T extends { readonly kind: infer K } ? Omit<T, "operationId" | "expectedRevision"> & { readonly kind: K } : never : never;
let serial = 0;
function attempt(project: WorkbenchProject, operation: Op) {
  serial += 1;
  return applyWorkbenchOperation(project, { ...operation, operationId: `operation:ui3-dim-${serial}`, expectedRevision: project.revision } as WorkbenchOperation);
}
function run(project: WorkbenchProject, operation: Op): WorkbenchProject {
  const result = attempt(project, operation);
  if (!result.ok) throw new Error(`${operation.kind} refused: ${result.diagnostics[0]?.message}`);
  return result.value.project;
}
const noop = (): undefined => undefined;
const circle = (id: string, center: [number, number], radiusMm = 4): SketchEntity => ({ id, kind: "circle", center, radiusMm, construction: false });
const line = (id: string, start: [number, number], end: [number, number]): SketchEntity => ({ id, kind: "line", start, end, construction: false });

function emptyProject(entities: readonly SketchEntity[], parameters: readonly { name: string; expression: string; unit: "mm" | "deg" | "" }[] = []): WorkbenchProject {
  let project = createWorkbenchProject("project:ui3-dim");
  project = { ...project, sketch: { ...project.sketch, entities, constraints: [] } };
  if (parameters.length > 0) project = run(project, { kind: "set-design-parameters", parameters: parameters.map((parameter) => ({ ...parameter, comment: "" })), renames: [] });
  return project;
}

/**
 * What the sketch workspace does with text typed into a dimension field: read it, and for an expression ask the project to check it
 * (the same call App.setSketchDimension makes) before the dimension is set with the expression.
 */
function typeIntoField(project: WorkbenchProject, text: string, entityId: string, dimension: SketchDimensionName, extra: { readonly secondEntityId?: string; readonly points?: readonly ("self" | "start" | "end" | "center" | "mid" | "curve")[] } = {}): WorkbenchProject {
  const read = readDimensionText(text, { unit: "mm", ...(dimension === "angle" ? { angle: true } : {}), ...(dimensionAllowsZero(dimension) ? { zeroAllowed: true } : {}) });
  assert(read.kind !== "invalid", `${dimension}: "${text}" is accepted (${read.kind === "invalid" ? read.message : ""})`);
  const request = applyOf(dimension, read as AcceptedDimensionRead);
  if (request.expression === undefined) return run(project, { kind: "set-sketch-dimension", entityId, dimension, valueMm: request.valueMm, ...extra });
  const preview = previewSketchDimensionExpression(project, dimension, request.expression);
  assert(preview.ok, `${dimension}: "${text}" evaluates (${preview.ok ? "" : preview.message})`);
  return run(project, { kind: "set-sketch-dimension", entityId, dimension, valueMm: preview.ok ? preview.value : request.valueMm, expression: request.expression, ...extra });
}

const constraintOf = (project: WorkbenchProject, dimension: string) => project.sketch.constraints.find((constraint) => constraint.dimension === dimension || (dimension === "angle" && constraint.kind === "angle") || (dimension === "arc-length" && constraint.kind === "arc-length"));

export const sketchUi3DimensionTests: readonly TestCase[] = [
  {
    name: "Re-audit UX R2-3: a parameter name or expression typed into a dimension field is read as an expression, not refused as a length (the old length reader said Unknown name)",
    run: () => {
      // The reader the old fields used cannot see parameters; the shared dimension reader separates a number from an expression.
      const old = readSketchLength("plate_w/2", "mm");
      assert(!old.ok, "a plain length reader cannot know plate_w");
      const text = readDimensionText("plate_w/2", { unit: "mm" });
      equal(text.kind, "expression", "plate_w/2 is an expression");
      equal(text.kind === "expression" ? text.expression : "", "plate_w/2", "and keeps the text as typed");
      const plain = readDimensionText("1/2 in", { unit: "mm" });
      equal(plain.kind, "value", "1/2 in is a value");
      near(plain.kind === "value" ? plain.value : 0, 12.7, 1e-9, "of 12.7 mm");
      const bare = readDimensionText("5", { unit: "in" });
      near(bare.kind === "value" ? bare.value : 0, 127, 1e-9, "a bare number takes the display unit");
      const angle = readDimensionText("45°", { unit: "mm", angle: true });
      equal(angle.kind === "value" ? angle.value : -1, 45, "an angle is degrees");
      equal(readDimensionText("turn / 2", { unit: "mm", angle: true }).kind, "expression", "an angle can follow a parameter");
      equal(readDimensionText("400", { unit: "mm", angle: true }).kind, "invalid", "an angle of 400 is refused with a message");
      equal(readDimensionText("0", { unit: "mm" }).kind, "invalid", "a size of zero is refused");
      equal(readDimensionText("0", { unit: "mm", zeroAllowed: true }).kind, "value", "a distance of zero is allowed");
      equal(readDimensionText("-3", { unit: "mm", zeroAllowed: true }).kind, "invalid", "a negative distance is refused");
      equal(readDimensionText("   ", { unit: "mm" }).kind, "invalid", "an empty field is refused");
      const empty = readDimensionText("", { unit: "mm" });
      assert(empty.kind === "invalid" && empty.message.includes("parameter"), "and the message says a parameter name is welcome");
      assert(dimensionAllowsZero("horizontal") && dimensionAllowsZero("point-line") && !dimensionAllowsZero("major-radius") && !dimensionAllowsZero("diameter"), "only distances may be zero");
    }
  },
  {
    name: "Re-audit UX R2-3: hole position, point-to-line, line-to-line, ellipse radii, angle, arc length and diameter are bound from the field, stored, and follow the parameter when it changes",
    run: () => {
      let project = emptyProject([
        circle("entity:c1", [20, 10]),
        line("entity:l1", [0, 40], [30, 40]),
        line("entity:l2", [0, 60], [30, 70]),
        { id: "entity:el", kind: "ellipse", center: [80, 20], majorRadiusMm: 12, minorRadiusMm: 6, rotationDeg: 0, construction: false },
        { id: "entity:ar", kind: "arc", start: [0, 100], mid: [10, 110], end: [20, 100], construction: false }
      ], [{ name: "plate_w", expression: "80 mm", unit: "mm" }, { name: "turn", expression: "30", unit: "deg" }]);
      const typed: readonly (readonly [string, string, SketchDimensionName, Parameters<typeof typeIntoField>[4], (value: number) => number])[] = [
        ["hole position from the origin", "plate_w/4", "horizontal", { secondEntityId: "entity:c1", points: ["self", "center"] }, (w) => w / 4],
        ["circle centre to a line", "plate_w/8", "point-line", { secondEntityId: "entity:l1", points: ["center", "self"] }, (w) => w / 8],
        ["line to line", "plate_w/5", "line-line", { secondEntityId: "entity:l2" }, (w) => w / 5],
        ["ellipse major radius", "plate_w/5", "major-radius", {}, (w) => w / 5],
        ["ellipse minor radius", "plate_w/10", "minor-radius", {}, (w) => w / 10],
        ["arc length", "plate_w/3", "arc-length", {}, (w) => w / 3],
        ["circle diameter", "plate_w/16", "diameter", {}, (w) => w / 16]
      ];
      const targets: Readonly<Record<string, string>> = { horizontal: "sketch:origin", "point-line": "entity:c1", "line-line": "entity:l1", "major-radius": "entity:el", "minor-radius": "entity:el", "arc-length": "entity:ar", diameter: "entity:c1" };
      for (const [what, text, dimension, extra, expected] of typed) {
        project = typeIntoField(project, text, targets[dimension]!, dimension, extra);
        const stored = project.sketch.constraints.find((constraint) => constraint.expression === text && (constraint.dimension === dimension || constraint.kind === dimension));
        assert(stored !== undefined, `${what}: the expression is stored on the dimension`);
        near(stored.valueMm ?? Number.NaN, expected(80), 1e-6, `${what}: the dimension holds the value the expression gives`);
      }
      // The angle between two lines follows a parameter in degrees.
      project = typeIntoField(project, "turn", "entity:l1", "angle", { secondEntityId: "entity:l2" });
      const angleDimension = project.sketch.constraints.find((constraint) => constraint.kind === "angle");
      equal(angleDimension?.expression, "turn", "the angle is bound to turn");
      near(angleDimension?.valueDeg ?? Number.NaN, 30, 1e-6, "at 30 degrees");
      // Changing the parameter moves every bound dimension.
      const changed = run(project, { kind: "set-design-parameters", parameters: [{ name: "plate_w", expression: "120 mm", unit: "mm", comment: "" }, { name: "turn", expression: "45", unit: "deg", comment: "" }], renames: [] });
      for (const [what, text, dimension, , expected] of typed) {
        const stored = changed.sketch.constraints.find((constraint) => constraint.expression === text && (constraint.dimension === dimension || constraint.kind === dimension));
        near(stored?.valueMm ?? Number.NaN, expected(120), 1e-6, `${what}: follows plate_w when it becomes 120`);
      }
      near(changed.sketch.constraints.find((constraint) => constraint.kind === "angle")?.valueDeg ?? Number.NaN, 45, 1e-6, "the angle follows turn");
      const hole = changed.sketch.entities.find((entity) => entity.id === "entity:c1");
      assert(hole?.kind === "circle" && Math.abs(hole.center[0] - 30) < 1e-6, "and the hole itself moved to plate_w / 4 = 30 mm from the origin");
    }
  },
  {
    name: "Re-audit UX R2-3: the expression check is kind-aware (a distance may be 0, an angle must be an angle) and names the way out when a parameter is missing",
    run: () => {
      const project = emptyProject([circle("entity:c1", [20, 10])], [{ name: "plate_w", expression: "80 mm", unit: "mm" }, { name: "turn", expression: "30", unit: "deg" }]);
      const zero = previewSketchDimensionExpression(project, "horizontal", "plate_w - plate_w");
      assert(zero.ok && zero.value === 0, "a horizontal distance of 0 evaluates");
      const size = previewSketchDimensionExpression(project, "diameter", "plate_w - plate_w");
      assert(!size.ok, "a diameter of 0 does not");
      const angle = previewSketchDimensionExpression(project, "angle", "turn * 2");
      assert(angle.ok && Math.abs(angle.value - 60) < 1e-9 && angle.text.endsWith("°"), "an angle expression gives degrees");
      const wrong = previewSketchDimensionExpression(project, "angle", "plate_w");
      assert(!wrong.ok && wrong.message.includes("angle"), `a length is not an angle (${!wrong.ok ? wrong.message : ""})`);
      const wrongLength = previewSketchDimensionExpression(project, "aligned", "turn + 5 deg");
      assert(!wrongLength.ok && wrongLength.message.includes("length"), "an angle is not a length");
      const missing = previewSketchDimensionExpression(project, "horizontal", "plate_x / 2");
      assert(!missing.ok && missing.message.includes("plate_x") && /Add that parameter|Parameters/u.test(missing.message), `a missing parameter says how to add it (${!missing.ok ? missing.message : ""})`);
    }
  },
  {
    name: "Re-audit UX R2-3: the inspector fields (Distance, size, point distance, angle) take a parameter, show the bound expression, and the canvas editor is a text field with a hint that says so",
    run: () => {
      let project = emptyProject([circle("entity:c1", [20, 10]), line("entity:l1", [0, 40], [30, 40]), line("entity:l2", [0, 60], [30, 70])], [{ name: "plate_w", expression: "80 mm", unit: "mm" }]);
      project = typeIntoField(project, "plate_w/4", "sketch:origin", "horizontal", { secondEntityId: "entity:c1", points: ["self", "center"] });
      project = typeIntoField(project, "plate_w/16", "entity:c1", "diameter");
      const c1 = project.sketch.entities.find((entity) => entity.id === "entity:c1")!;
      const bridge = { revision: 0, pierceHits: () => [], pierceRefresh: () => undefined, pierceUnresolved: () => [] };
      const wrap = (child: React.ReactNode): string => renderToStaticMarkup(createElement(SketchUnitContext.Provider, { value: "mm" }, child));
      // The origin-to-hole distance selected as one curve: the Distance field shows the expression and takes text.
      const relations = wrap(createElement(SolverRelations, { sketch: project.sketch, selected: [c1], onSetDimension: noop, onAddConstraint: noop, onMessage: noop }));
      assert(relations.includes("Bound to a parameter: plate_w/4"), "the Distance field shows the expression the position is bound to");
      assert(relations.includes('value="plate_w/4"'), "and starts from it, so it can be edited as text");
      assert(relations.includes("Bound to a parameter: plate_w/16"), "the Diameter size field of the same hole is bound too");
      assert(!/inputMode="decimal"/u.test(relations), "no inspector field is a number-pad-only input, which could not take a name");
      const extras = wrap(createElement(ConstraintExtras, { sketch: project.sketch, selected: [project.sketch.entities[1]!, project.sketch.entities[2]!], bridge, onSetDimension: noop, onAddConstraint: noop, onApplyEdit: noop, onMessage: noop }));
      assert(extras.includes("Angle between the last two lines") && extras.includes('inputMode="text"'), "the angle field is a text field");
      const entityFields = wrap(createElement(EntityDimensions, { entity: c1, sketch: project.sketch, onApply: noop, onMessage: noop }));
      assert(entityFields.includes("Bound to a parameter: plate_w/16"), "the circle's Diameter in Driving dimensions shows its expression");
      // The canvas editor.
      const editor = renderToStaticMarkup(createElement(DimensionEditor, { label: "Diameter", text: "plate_w/16", unitLabel: "mm", position: [0, 0], onChange: noop, onCommit: noop, onCancel: noop }));
      assert(editor.includes('inputMode="text"') && !editor.includes('inputMode="decimal"'), "the editor input is a text field (a decimal keypad has no letters)");
      assert(editor.includes("parameter") && editor.includes("aria-describedby"), "the hint names parameters and is linked to the input");
      assert(boundExpressionOf(project.sketch, { entityId: "sketch:origin", dimension: "horizontal", secondEntityId: "entity:c1", points: ["self", "center"] }) === "plate_w/4", "the bound expression is read back from the sketch");
    }
  },
  {
    name: "Re-audit UX R2-11: the inspector Radius field of a hole sized as a Diameter on the canvas edits that Diameter (no contradiction, no second dimension), and the Diameter field of a Radius-sized hole edits the Radius",
    run: () => {
      // Hole sized as a Diameter 10 (what the canvas editor writes for a Diameter dimension).
      let project = emptyProject([circle("entity:hole", [20, 25], 5)]);
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:hole", dimension: "diameter", valueMm: 10 });
      const facts = circleDimensionFacts(project.sketch, project.sketch.entities[0] as Extract<SketchEntity, { kind: "circle" }>);
      assert(facts.diameterConstraint, "the hole carries a Diameter dimension");
      // Radius 6 typed in the inspector: before the fix this was sent as a Radius dimension and refused as a contradiction.
      const radius = circleRadiusApply({ kind: "value", value: 6 }, facts.diameterConstraint);
      equal(radius.dimension, "diameter", "the Radius field writes the hole's own Diameter dimension");
      equal(radius.valueMm, 12, "as twice the radius");
      const after = run(project, { kind: "set-sketch-dimension", entityId: "entity:hole", dimension: radius.dimension, valueMm: radius.valueMm });
      const hole = after.sketch.entities[0]!;
      assert(hole.kind === "circle" && Math.abs(hole.radiusMm - 6) < 1e-9, "the hole is now radius 6");
      equal(after.sketch.constraints.filter((constraint) => constraint.kind === "radius").length, 1, "and still carries one size dimension");
      // The old request (a Radius dimension on a hole that has a Diameter) is what the audit saw refused.
      const refused = attempt(project, { kind: "set-sketch-dimension", entityId: "entity:hole", dimension: "radius", valueMm: 6 });
      assert(!refused.ok, "writing a Radius next to a Diameter is refused by the solver, which is why the field must pick the right name");
      // The Diameter field of a hole sized as a Radius writes a Radius of half the diameter.
      let radial = emptyProject([circle("entity:hole", [0, 0], 5)]);
      radial = run(radial, { kind: "set-sketch-dimension", entityId: "entity:hole", dimension: "radius", valueMm: 5 });
      const radialFacts = circleDimensionFacts(radial.sketch, radial.sketch.entities[0] as Extract<SketchEntity, { kind: "circle" }>);
      const diameter = circleDiameterApply({ kind: "value", value: 14 }, radialFacts.diameterConstraint);
      equal(diameter.dimension, "radius", "a Radius-sized hole takes the typed diameter as a radius");
      equal(diameter.valueMm, 7, "of half");
      const radialAfter = run(radial, { kind: "set-sketch-dimension", entityId: "entity:hole", dimension: diameter.dimension, valueMm: diameter.valueMm });
      assert(radialAfter.sketch.entities[0]!.kind === "circle" && Math.abs((radialAfter.sketch.entities[0] as { radiusMm: number }).radiusMm - 7) < 1e-9, "the hole follows");
      // Expressions follow the same rule.
      const bound: DimensionApply = circleRadiusApply({ kind: "expression", expression: "r_pin" }, true);
      equal(bound.dimension, "diameter", "a radius expression on a Diameter hole binds the Diameter");
      assert(bound.expression !== undefined && bound.expression.includes("r_pin") && bound.expression.includes("2"), `as twice the radius (${bound.expression})`);
      // The rendered inspector offers both fields for a circle, with the diameter first.
      const markup = renderToStaticMarkup(createElement(SketchUnitContext.Provider, { value: "mm" }, createElement(EntityDimensions, { entity: hole, sketch: after.sketch, onApply: noop, onMessage: noop })));
      assert(markup.indexOf("Diameter in millimeters") > 0 && markup.indexOf("Radius in millimeters") > markup.indexOf("Diameter in millimeters"), "the inspector lists the Diameter field, then the Radius field, both editable");
      assert(markup.includes('value="12"') && markup.includes('value="6"'), "showing 12 and 6");
      // The Diameter in the other inspector section (Position and relations) follows the same rule.
      const relations = renderToStaticMarkup(createElement(SolverRelations, { sketch: project.sketch, selected: [project.sketch.entities[0]!], onSetDimension: noop, onAddConstraint: noop, onMessage: noop }));
      assert(relations.includes("Diameter"), "the Position and relations section sizes the same hole by its diameter");
    }
  },
  {
    name: "Re-audit UX R2-4: Sketch Dimension offers rectangle corners and centre (and the sketch origin), so a hole-to-plate-corner distance drives the geometry instead of being measure-only",
    run: () => {
      const rectangle: SketchEntity = { id: "entity:plate", kind: "rectangle", center: [50, 25], widthMm: 100, heightMm: 50, rotationDeg: 0, construction: false };
      const hole = circle("entity:hole", [10, 10], 3);
      const handles = dimensionHandles(rectangle);
      const names = handles.map((handle) => handle.handle);
      for (const wanted of ["corner-0", "corner-1", "corner-2", "corner-3", "center", "left", "right", "top", "bottom"]) assert(names.includes(wanted as never), `the rectangle offers ${wanted}`);
      const corner0 = handles.find((handle) => handle.handle === "corner-0")!;
      near(corner0.point[0], 0, 1e-9, "corner 1 is the lower left x");
      near(corner0.point[1], 0, 1e-9, "and y");
      const corner2 = handles.find((handle) => handle.handle === "corner-2")!;
      near(corner2.point[0], 100, 1e-9, "corner 3 is the upper right x");
      equal(solverPointRef(corner0), "corner-0", "a corner is a point the solver can move");
      equal(solverPointRef(handles.find((handle) => handle.handle === "left")!), undefined, "an edge middle still is not");
      // Hole centre to the plate corner: a real driving distance.
      const holeCentre = dimensionHandles(hole).find((handle) => handle.handle === "center")!;
      const resolved = resolveDirectSketchDimension([corner0, holeCentre]);
      assert(resolved?.between !== undefined && resolved.driving === undefined, "corner to hole centre is a distance between two solver points");
      equal(resolved?.between?.points.join(","), "corner-0,center", "with the solver's own names");
      let project = emptyProject([rectangle, hole]);
      project = run(project, { kind: "set-sketch-dimension", entityId: "entity:plate", secondEntityId: "entity:hole", dimension: "horizontal", valueMm: 12, points: resolved!.between!.points });
      const moved = project.sketch.entities.find((entity) => entity.id === "entity:hole");
      assert(moved?.kind === "circle", "the hole is still there");
      // The solver holds the distance by moving one of the two shapes; their relative offset is what was asked for.
      const plate = project.sketch.entities.find((entity) => entity.id === "entity:plate");
      assert(plate?.kind === "rectangle", "and so is the plate");
      near(moved.center[0] - (plate.center[0] - plate.widthMm / 2), 12, 1e-6, "the hole sits 12 mm from the plate's left edge");
      // The width and height are still reachable from two corners of one rectangle.
      const corner1 = handles.find((handle) => handle.handle === "corner-1")!;
      const width = resolveDirectSketchDimension([corner0, corner1]);
      equal(width?.driving?.dimension, "width", "two bottom corners are the width");
      const corner3 = handles.find((handle) => handle.handle === "corner-3")!;
      equal(resolveDirectSketchDimension([corner0, corner3])?.driving?.dimension, "height", "and the left corners are the height");
      const diagonal = resolveDirectSketchDimension([corner0, corner2]);
      assert(diagonal?.driving === undefined && diagonal?.between !== undefined, "a diagonal is a distance between two corners");
      // The origin is always on offer, and a hole can be dimensioned from it.
      const points = allDimensionPoints([rectangle, hole]);
      assert(points.some((point) => point.id === ORIGIN_DIMENSION_POINT.id), "the sketch origin is a dimension point");
      const fromOrigin = resolveDirectSketchDimension([ORIGIN_DIMENSION_POINT, holeCentre]);
      equal(fromOrigin?.between?.entityId, "sketch:origin", "a hole can be dimensioned from the origin");
      equal(fromOrigin?.between?.points.join(","), "self,center", "as the origin's own point and the hole centre");
      const originProject = run(emptyProject([hole]), { kind: "set-sketch-dimension", entityId: "sketch:origin", secondEntityId: "entity:hole", dimension: "horizontal", valueMm: 25, points: fromOrigin!.between!.points });
      near((originProject.sketch.entities[0] as unknown as { center: [number, number] }).center[0], 25, 1e-6, "which puts it 25 mm from the origin");
      assert(resolveDirectSketchDimension([ORIGIN_DIMENSION_POINT, ORIGIN_DIMENSION_POINT]) === undefined, "the origin cannot be dimensioned to itself");
      assert(defaultDimensionPoints(rectangle).length === 2, "selecting a rectangle first still starts with its width");
      // A rotated rectangle's corners turn with it.
      const turned = dimensionHandles({ ...rectangle, rotationDeg: 90 } as SketchEntity).find((handle) => handle.handle === "corner-1")!;
      near(turned.point[0], 75, 1e-9, "a quarter turn moves corner 2 to the right of the centre line");
    }
  },
  {
    name: "Re-audit UX R2-4: the rendered dimension tool puts every definition point, including the origin and the rectangle corners, in the tab order and operable from the keyboard",
    run: () => {
      const rectangle: SketchEntity = { id: "entity:plate", kind: "rectangle", center: [50, 25], widthMm: 100, heightMm: 50, rotationDeg: 0, construction: false };
      const project = emptyProject([rectangle, circle("entity:hole", [10, 10], 3)]);
      const markup = renderWorkspaceMarkup(project, { dimensionMode: true });
      const points = [...markup.matchAll(/<circle[^>]*data-dimension-point="([^"]+)"[^>]*>/gu)];
      assert(points.length >= 10, `the dimension points are drawn (${points.length})`);
      for (const match of points) {
        assert(/tabindex="0"/iu.test(match[0]) && /role="button"/u.test(match[0]), `${match[1]} is focusable and a button`);
        assert(/aria-label="[^"]*dimension point"/u.test(match[0]), `${match[1]} has a name`);
      }
      assert(markup.includes("Rectangle corner 1 dimension point") && markup.includes("Sketch origin dimension point") && markup.includes("Rectangle centre dimension point"), "the corners, the centre and the origin are named");
    }
  }
];

/** The Sketch workspace rendered on the server with the given props over a project's sketch. */
export function renderWorkspaceMarkup(project: WorkbenchProject, patch: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    projectId: project.id, sketch: project.sketch as WorkbenchSketch, constraintExtras: { revision: 0, pierceHits: () => [], pierceRefresh: () => undefined, pierceUnresolved: () => [] }, tool: "select", dimensionMode: false, cancelVersion: 0, selectedId: null,
    targetBodies: [], solidBodies: [], displayUnit: "mm", editTool: null, showMovable: false, checkOpen: false, request: null, fitSerial: 0, optionsRevealRequest: 0,
    viewportState: { navigationMode: "select", selectionFilter: "any", gridVisible: true, axesVisible: true, orientation: "top", projection: "orthographic", shadingMode: "shaded", bodyColor: "steel", backgroundTone: "light", azimuthDeg: 0, elevationDeg: 0 }
  };
  const props = new Proxy({ ...base, ...patch }, { get: (target, key) => (key in target ? target[key as string] : typeof key === "string" && key.startsWith("on") ? noop : undefined), has: () => true });
  return renderToStaticMarkup(createElement(SketchWorkspace, props as never));
}
