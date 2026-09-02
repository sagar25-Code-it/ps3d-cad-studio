import assert from "node:assert/strict";
import test from "node:test";
import {
  asConstructionGeometry,
  asProjectedGeometry,
  beginDragSolveSession,
  cancelDragSolveSession,
  commitDragSolveSession,
  createArcGeometry,
  createCircleGeometry,
  createEllipseGeometry,
  createLineGeometry,
  createPointGeometry,
  createRegularPolygonGeometry,
  createSlotGeometry,
  createSplineGeometry,
  executeSketchEdit,
  evaluateSketchExpression,
  solveAnalyticSketch,
  updateDragSolveSession,
  validateParametricSketch,
  type LineGeometry,
  type ParametricSketchDocument
} from "../src/index.js";

test("solves horizontal line length deterministically from a parameter expression", () => {
  const document = baseDocument({
    parameters: { width: 16 },
    geometry: [line("line:1", [0, 0], [3, 4])],
    constraints: [{ id: "constraint:horizontal", kind: "horizontal", line: { entityId: "line:1", selector: "curve" }, suppressed: false }],
    dimensions: [{
      id: "dimension:length",
      kind: "length",
      target: { entityId: "line:1", selector: "curve" },
      unit: "mm",
      mode: "driving",
      suppressed: false,
      value: { value: 1, expression: "width / 2 + 2" }
    }]
  });
  const first = solveAnalyticSketch({ document, mode: "regenerate" });
  const second = solveAnalyticSketch({ document, mode: "regenerate" });
  assert.equal(first.status, "solved");
  assert.deepEqual(first.document.geometry[0], line("line:1", [0, 0], [10, 0]));
  assert.equal(first.measurements[0]?.value, 10);
  assert.equal(first.deterministicFingerprint, second.deterministicFingerprint);
  assert.deepEqual(first.appliedConstraintIds, ["constraint:horizontal"]);
  assert.deepEqual(first.appliedDimensionIds, ["dimension:length"]);
});

test("driving diameter changes a circle while driven diameter only measures", () => {
  const driving = baseDocument({
    geometry: [{ id: "circle:1", kind: "circle", center: [4, 5], radiusMm: 3, construction: false, suppressed: false }],
    dimensions: [{ id: "dimension:diameter", kind: "diameter", target: { entityId: "circle:1", selector: "radius" }, unit: "mm", mode: "driving", suppressed: false, value: { value: 14 } }]
  });
  const driven = baseDocument({
    geometry: driving.geometry,
    dimensions: [{ id: "dimension:diameter", kind: "diameter", target: { entityId: "circle:1", selector: "radius" }, unit: "mm", mode: "driven", suppressed: false, value: { value: 999 } }]
  });
  const drivingResult = solveAnalyticSketch({ document: driving, mode: "regenerate" });
  const drivenResult = solveAnalyticSketch({ document: driven, mode: "regenerate" });
  assert.equal(drivingResult.document.geometry[0]?.kind, "circle");
  if (drivingResult.document.geometry[0]?.kind === "circle") assert.equal(drivingResult.document.geometry[0].radiusMm, 7);
  assert.equal(drivenResult.document.geometry[0]?.kind, "circle");
  if (drivenResult.document.geometry[0]?.kind === "circle") assert.equal(drivenResult.document.geometry[0].radiusMm, 3);
  assert.equal(drivenResult.measurements[0]?.value, 6);
  assert.deepEqual(drivenResult.appliedDimensionIds, []);
});

test("reports tangent as explicitly unsupported instead of silently applying it", () => {
  const document = baseDocument({
    geometry: [line("line:1", [0, 0], [10, 0]), { id: "circle:1", kind: "circle", center: [5, 5], radiusMm: 2, construction: false, suppressed: false }],
    constraints: [{ id: "constraint:tangent", kind: "tangent", first: { entityId: "line:1", selector: "curve" }, second: { entityId: "circle:1", selector: "curve" }, suppressed: false }]
  });
  const result = solveAnalyticSketch({ document, mode: "regenerate" });
  assert.equal(result.status, "partial");
  assert.equal(result.diagnostics[0]?.code, "UNSUPPORTED_CONSTRAINT");
  assert.equal(result.diagnostics[0]?.unsupported, true);
  assert.deepEqual(result.appliedConstraintIds, []);
  assert.deepEqual(result.document.geometry, document.geometry);
});

test("rejects dangling geometry references", () => {
  const document = baseDocument({
    geometry: [line("line:1", [0, 0], [10, 0])],
    constraints: [{ id: "constraint:horizontal", kind: "horizontal", line: { entityId: "line:missing", selector: "curve" }, suppressed: false }]
  });
  const result = solveAnalyticSketch({ document, mode: "regenerate" });
  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "MISSING_REFERENCE"), true);
});

test("drag sessions update a free point and preserve immutable base state", () => {
  const document = baseDocument({ geometry: [{ id: "point:1", kind: "point", point: [0, 0], construction: false, suppressed: false }] });
  const started = beginDragSolveSession(document, { entityId: "point:1", selector: "point" }, "drag:1");
  const updated = updateDragSolveSession(started, [12, -4]);
  const updatedAgain = updateDragSolveSession(updated, [18, 6]);
  const committed = commitDragSolveSession(updatedAgain);
  assert.equal(updated.updateSequence, 1);
  assert.deepEqual(document.geometry[0], { id: "point:1", kind: "point", point: [0, 0], construction: false, suppressed: false });
  assert.deepEqual(updated.latestResult.document.geometry[0], { id: "point:1", kind: "point", point: [12, -4], construction: false, suppressed: false });
  assert.equal(updated.latestResult.document.revision, document.revision);
  assert.equal(updatedAgain.latestResult.document.revision, document.revision);
  assert.equal(committed.state, "committed");
  assert.equal(committed.latestResult.document.revision, document.revision + 1);
  assert.deepEqual(committed.latestResult.document.geometry[0], { id: "point:1", kind: "point", point: [18, 6], construction: false, suppressed: false });

  const cancelled = cancelDragSolveSession(updatedAgain);
  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.latestResult.document.revision, document.revision);
  assert.deepEqual(cancelled.latestResult.document.geometry, document.geometry);
});

test("offset applies to a line and trim remains explicitly unsupported", () => {
  const document = baseDocument({ geometry: [line("line:1", [0, 0], [10, 0])] });
  const offset = executeSketchEdit(document, {
    kind: "offset",
    requestId: "edit:offset",
    entityIds: ["line:1"],
    resultEntityIds: ["line:2"],
    distanceMm: 3,
    side: "left",
    associative: false
  });
  assert.equal(offset.status, "applied");
  assert.deepEqual(offset.document.geometry[1], line("line:2", [0, 3], [10, 3]));
  const associative = executeSketchEdit(document, {
    kind: "offset",
    requestId: "edit:associative-offset",
    entityIds: ["line:1"],
    resultEntityIds: ["line:3"],
    distanceMm: 2,
    side: "right",
    associative: true
  });
  assert.equal(associative.status, "unsupported");
  assert.deepEqual(associative.document, document);
  const trim = executeSketchEdit(document, { kind: "trim", requestId: "edit:trim", entityId: "line:1", pickPointMm: [5, 0], boundaryEntityIds: [] });
  assert.equal(trim.status, "unsupported");
  assert.equal(trim.diagnostics[0]?.code, "UNSUPPORTED_OPERATION");
  assert.equal(trim.diagnostics[0]?.unsupported, true);
});

test("independent offsets detach projected-source identity", () => {
  const projectedLine = asProjectedGeometry(
    createLineGeometry("line:projected", [0, 0], [10, 0]),
    { documentId: "document:source", topologyId: "edge:line", revision: 3, associative: false }
  );
  const projectedCircle = asProjectedGeometry(
    createCircleGeometry("circle:projected", [4, 4], 5),
    { documentId: "document:source", topologyId: "edge:circle", revision: 3, associative: false }
  );
  const document = baseDocument({ geometry: [projectedLine, projectedCircle] });
  const result = executeSketchEdit(document, {
    kind: "offset",
    requestId: "edit:detached-offset",
    entityIds: [projectedLine.id, projectedCircle.id],
    resultEntityIds: ["line:offset", "circle:offset"],
    distanceMm: 2,
    side: "left",
    associative: false
  });

  assert.equal(result.status, "applied");
  assert.equal(result.document.geometry[2]?.source, undefined);
  assert.equal(result.document.geometry[3]?.source, undefined);
});

test("factories persist advanced, construction, and associative projected entity schemas", () => {
  const projected = asProjectedGeometry(
    asConstructionGeometry(createLineGeometry("line:projected", [0, 0], [12, 0])),
    { documentId: "document:source", topologyId: "edge:42", revision: 7, associative: true }
  );
  const document = baseDocument({
    geometry: [
      createPointGeometry("point:1", [1, 2]),
      projected,
      createCircleGeometry("circle:1", [4, 4], 2),
      createArcGeometry("arc:1", [0, 0], 5, 0, Math.PI / 2),
      createEllipseGeometry("ellipse:1", [2, 3], [8, 0], 0.5),
      createRegularPolygonGeometry("polygon:1", [0, 0], [5, 0], 6),
      createSlotGeometry("slot:1", [-4, 0], [4, 0], 3),
      createSplineGeometry("spline:1", 2, [[0, 0], [3, 4], [8, 0]], [0, 0, 0, 1, 1, 1], false)
    ]
  });
  const validation = validateParametricSketch(document);
  assert.equal(validation.valid, true);
  assert.equal(projected.construction, true);
  assert.deepEqual(projected.source, { documentId: "document:source", topologyId: "edge:42", revision: 7, associative: true });
  assert.deepEqual(document.geometry.map((geometry) => geometry.kind), ["point", "line", "circle", "arc", "ellipse", "polygon", "slot", "spline"]);
});

test("runtime validation rejects malformed projected identity, arc sweep, and spline knots", () => {
  const document = baseDocument({
    geometry: [
      {
        id: "arc:bad",
        kind: "arc",
        center: [0, 0],
        radiusMm: 2,
        startAngleRad: 0,
        endAngleRad: Math.PI * 2,
        construction: false,
        suppressed: false,
        source: { documentId: "", topologyId: "edge:1", revision: -1, associative: true }
      },
      {
        id: "spline:bad",
        kind: "spline",
        degree: 2,
        controlPoints: [[0, 0], [1, 1], [2, 0]],
        knots: [0, 0, 1, 0, 1, 1],
        closed: false,
        construction: false,
        suppressed: false
      }
    ]
  });
  const validation = validateParametricSketch(document);
  assert.equal(validation.valid, false);
  assert.equal(validation.diagnostics.some((diagnostic) => diagnostic.code === "INVALID_REFERENCE" && diagnostic.relatedIds.includes("arc:bad")), true);
  assert.equal(validation.diagnostics.filter((diagnostic) => diagnostic.code === "DEGENERATE_GEOMETRY").length, 2);
});

test("solves qualified concentric and equal-radius relations across circles and arcs", () => {
  const document = baseDocument({
    geometry: [
      createCircleGeometry("circle:1", [2, 3], 6),
      createArcGeometry("arc:1", [20, -4], 2, 0, Math.PI)
    ],
    constraints: [
      { id: "constraint:concentric", kind: "concentric", first: { entityId: "circle:1", selector: "center" }, second: { entityId: "arc:1", selector: "center" }, suppressed: false },
      { id: "constraint:equal", kind: "equal", first: { entityId: "circle:1", selector: "radius" }, second: { entityId: "arc:1", selector: "radius" }, suppressed: false }
    ]
  });
  const result = solveAnalyticSketch({ document, mode: "regenerate" });
  assert.equal(result.status, "solved");
  const arc = result.document.geometry.find((geometry) => geometry.id === "arc:1");
  assert.equal(arc?.kind, "arc");
  if (arc?.kind === "arc") {
    assert.deepEqual(arc.center, [2, 3]);
    assert.equal(arc.radiusMm, 6);
  }
  assert.deepEqual(result.appliedConstraintIds, ["constraint:concentric", "constraint:equal"]);
});

test("solves qualified parallel, perpendicular, midpoint, and coincidence relations", () => {
  const document = baseDocument({
    geometry: [
      createLineGeometry("line:reference", [0, 0], [10, 0]),
      createLineGeometry("line:parallel", [0, 4], [2, 7]),
      createLineGeometry("line:perpendicular", [5, 5], [9, 8]),
      createPointGeometry("point:mid", [99, 99]),
      createPointGeometry("point:coincident", [-5, -5])
    ],
    constraints: [
      { id: "constraint:fix-reference", kind: "fix", target: { entityId: "line:reference", selector: "self" }, suppressed: false },
      { id: "constraint:parallel", kind: "parallel", first: { entityId: "line:reference", selector: "curve" }, second: { entityId: "line:parallel", selector: "curve" }, suppressed: false },
      { id: "constraint:perpendicular", kind: "perpendicular", first: { entityId: "line:reference", selector: "curve" }, second: { entityId: "line:perpendicular", selector: "curve" }, suppressed: false },
      { id: "constraint:midpoint", kind: "midpoint", point: { entityId: "point:mid", selector: "point" }, line: { entityId: "line:reference", selector: "curve" }, suppressed: false },
      { id: "constraint:coincident", kind: "coincident", first: { entityId: "point:coincident", selector: "point" }, second: { entityId: "line:reference", selector: "start" }, suppressed: false }
    ]
  });
  const result = solveAnalyticSketch({ document, mode: "regenerate" });
  assert.equal(result.status, "solved");
  const parallel = result.document.geometry.find((geometry) => geometry.id === "line:parallel");
  const perpendicular = result.document.geometry.find((geometry) => geometry.id === "line:perpendicular");
  const midpoint = result.document.geometry.find((geometry) => geometry.id === "point:mid");
  const coincident = result.document.geometry.find((geometry) => geometry.id === "point:coincident");
  if (parallel?.kind === "line") assert.equal(parallel.start[1], parallel.end[1]);
  if (perpendicular?.kind === "line") assert.equal(Math.abs(perpendicular.start[0] - perpendicular.end[0]) < 1e-10, true);
  if (midpoint?.kind === "point") assert.deepEqual(midpoint.point, [5, 0]);
  if (coincident?.kind === "point") assert.deepEqual(coincident.point, [0, 0]);
});

test("driving linear dimensions move the free side when the second reference is fixed", () => {
  const document = baseDocument({
    geometry: [createPointGeometry("point:first", [3, 2]), createPointGeometry("point:second", [10, 2])],
    constraints: [{ id: "constraint:fix-second", kind: "fix", target: { entityId: "point:second", selector: "point" }, suppressed: false }],
    dimensions: [{
      id: "dimension:linear",
      kind: "linear",
      first: { entityId: "point:first", selector: "point" },
      second: { entityId: "point:second", selector: "point" },
      orientation: "horizontal",
      unit: "mm",
      mode: "driving",
      suppressed: false,
      value: { value: 4 }
    }]
  });
  const result = solveAnalyticSketch({ document, mode: "regenerate" });
  assert.equal(result.status, "solved");
  assert.deepEqual(result.document.geometry[0], createPointGeometry("point:first", [6, 2]));
  assert.deepEqual(result.document.geometry[1], createPointGeometry("point:second", [10, 2]));
});

test("driving angular dimensions rotate around a fixed second-line endpoint", () => {
  const document = baseDocument({
    geometry: [
      createLineGeometry("line:base", [0, 0], [10, 0]),
      createLineGeometry("line:moving", [5, 5], [10, 5])
    ],
    constraints: [{ id: "constraint:fix-end", kind: "fix", target: { entityId: "line:moving", selector: "end" }, suppressed: false }],
    dimensions: [{
      id: "dimension:angle",
      kind: "angle",
      first: { entityId: "line:base", selector: "curve" },
      second: { entityId: "line:moving", selector: "curve" },
      unit: "rad",
      mode: "driving",
      suppressed: false,
      value: { value: Math.PI / 2 }
    }]
  });
  const result = solveAnalyticSketch({ document, mode: "regenerate" });
  assert.equal(result.status, "solved");
  const moving = result.document.geometry.find((geometry) => geometry.id === "line:moving");
  if (moving?.kind === "line") {
    assert.deepEqual(moving.end, [10, 5]);
    assert.equal(Math.abs(moving.start[0] - 10) < 1e-10, true);
    assert.equal(Math.abs(moving.start[1]) < 1e-10, true);
  }
});

test("parameter edits rebuild driving expressions and constrained drag remains on-axis", () => {
  const initial = baseDocument({
    parameters: { width: 12, allowance: 2 },
    geometry: [createLineGeometry("line:1", [0, 0], [4, 0])],
    constraints: [{ id: "constraint:horizontal", kind: "horizontal", line: { entityId: "line:1", selector: "curve" }, suppressed: false }],
    dimensions: [{ id: "dimension:length", kind: "length", target: { entityId: "line:1", selector: "curve" }, unit: "mm", mode: "driving", suppressed: false, value: { value: 1, expression: "width + allowance * 2" } }]
  });
  const first = solveAnalyticSketch({ document: initial, mode: "regenerate" });
  assert.equal(first.measurements[0]?.value, 16);
  const edited = { ...first.document, parameters: { width: 20, allowance: 2 } };
  const second = solveAnalyticSketch({ document: edited, mode: "regenerate" });
  assert.equal(second.measurements[0]?.value, 24);

  const free = baseDocument({
    geometry: [createLineGeometry("line:drag", [0, 0], [5, 0])],
    constraints: [{ id: "constraint:horizontal", kind: "horizontal", line: { entityId: "line:drag", selector: "curve" }, suppressed: false }]
  });
  const session = beginDragSolveSession(free, { entityId: "line:drag", selector: "end" }, "drag:horizontal");
  const dragged = updateDragSolveSession(session, [9, 7]);
  const moved = dragged.latestResult.document.geometry[0];
  if (moved?.kind === "line") assert.deepEqual(moved.end, [9, 0]);
});

test("fixed drag and contradictory fixed geometry return conflict diagnostics and DOF state", () => {
  const fixedPoint = baseDocument({
    geometry: [createPointGeometry("point:fixed", [0, 0])],
    constraints: [{ id: "constraint:fix", kind: "fix", target: { entityId: "point:fixed", selector: "point" }, suppressed: false }]
  });
  const validated = solveAnalyticSketch({ document: fixedPoint, mode: "validate" });
  assert.equal(validated.dof.classification, "fully-constrained");
  assert.deepEqual(validated.appliedConstraintIds, []);
  const dragged = solveAnalyticSketch({ document: fixedPoint, mode: "drag", dragTarget: { reference: { entityId: "point:fixed", selector: "point" }, positionMm: [5, 5] } });
  assert.equal(dragged.status, "failed");
  assert.equal(dragged.diagnostics.some((diagnostic) => diagnostic.code === "DRAG_CONFLICT"), true);
  assert.equal(dragged.dof.classification, "over-constrained");
  assert.deepEqual(dragged.document.geometry, fixedPoint.geometry);

  const fixedLine = baseDocument({
    geometry: [createLineGeometry("line:fixed", [0, 0], [4, 3])],
    constraints: [
      { id: "constraint:fix-start", kind: "fix", target: { entityId: "line:fixed", selector: "start" }, suppressed: false },
      { id: "constraint:fix-end", kind: "fix", target: { entityId: "line:fixed", selector: "end" }, suppressed: false },
      { id: "constraint:horizontal", kind: "horizontal", line: { entityId: "line:fixed", selector: "curve" }, suppressed: false }
    ]
  });
  const conflict = solveAnalyticSketch({ document: fixedLine, mode: "regenerate" });
  assert.equal(conflict.status, "failed");
  assert.equal(conflict.diagnostics.some((diagnostic) => diagnostic.code === "CONSTRAINT_CONFLICT"), true);
  assert.equal(conflict.dof.classification, "over-constrained");
});

test("associative projected geometry is read-only and point-on-curve coincidence stays explicitly unsupported", () => {
  const projectedLine = asProjectedGeometry(
    createLineGeometry("line:projected", [0, 0], [10, 0]),
    { documentId: "document:source", topologyId: "edge:1", revision: 2, associative: true }
  );
  const dimensioned = baseDocument({
    geometry: [projectedLine],
    dimensions: [{ id: "dimension:length", kind: "length", target: { entityId: projectedLine.id, selector: "curve" }, unit: "mm", mode: "driving", suppressed: false, value: { value: 20 } }]
  });
  const projectedResult = solveAnalyticSketch({ document: dimensioned, mode: "regenerate" });
  assert.equal(projectedResult.status, "failed");
  assert.equal(projectedResult.diagnostics.some((diagnostic) => diagnostic.code === "DIMENSION_CONFLICT"), true);
  assert.deepEqual(projectedResult.document.geometry, dimensioned.geometry);

  const nonlinear = baseDocument({
    geometry: [createPointGeometry("point:1", [1, 1]), createCircleGeometry("circle:1", [0, 0], 4)],
    constraints: [{ id: "constraint:point-on-curve", kind: "coincident", first: { entityId: "point:1", selector: "point" }, second: { entityId: "circle:1", selector: "curve" }, suppressed: false }]
  });
  const nonlinearResult = solveAnalyticSketch({ document: nonlinear, mode: "regenerate" });
  assert.equal(nonlinearResult.status, "partial");
  assert.equal(nonlinearResult.diagnostics.some((diagnostic) => diagnostic.code === "UNSUPPORTED_CONSTRAINT" && diagnostic.unsupported), true);
  assert.deepEqual(nonlinearResult.document.geometry, nonlinear.geometry);
});

test("expression parser applies unary signs at the correct precedence", () => {
  assert.deepEqual(evaluateSketchExpression("2 * -3", {}, "expression:1"), { ok: true, value: -6 });
  assert.deepEqual(evaluateSketchExpression("-(2 + 3) * --2", {}, "expression:2"), { ok: true, value: -10 });
  assert.deepEqual(evaluateSketchExpression("2 * +3", {}, "expression:3"), { ok: true, value: 6 });
});

test("validate mode rejects stored geometry that does not satisfy an active constraint", () => {
  const document = baseDocument({
    geometry: [line("line:tilted", [0, 0], [8, 3])],
    constraints: [{ id: "constraint:horizontal", kind: "horizontal", line: { entityId: "line:tilted", selector: "curve" }, suppressed: false }]
  });
  const result = solveAnalyticSketch({ document, mode: "validate" });
  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "CONSTRAINT_CONFLICT"), true);
  assert.deepEqual(result.document.geometry, document.geometry);
});

test("runtime validation rejects a non-orthonormal or left-handed sketch plane", () => {
  const scaled = baseDocument({
    plane: { kind: "principal", referenceId: "origin:xy", originMm: [0, 0, 0], xAxis: [2, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, 1] }
  });
  const leftHanded = baseDocument({
    plane: { kind: "principal", referenceId: "origin:xy", originMm: [0, 0, 0], xAxis: [1, 0, 0], yAxis: [0, 1, 0], normal: [0, 0, -1] }
  });
  assert.equal(validateParametricSketch(scaled).valid, false);
  assert.equal(validateParametricSketch(leftHanded).valid, false);
});

test("midpoint relations translate defining points without collapsing their entity in either operand order", () => {
  const document = baseDocument({
    geometry: [createPointGeometry("point:target", [10, 10]), line("line:moving", [0, 0], [4, 0])],
    constraints: [
      { id: "constraint:fix-target", kind: "fix", target: { entityId: "point:target", selector: "point" }, suppressed: false },
      {
        id: "constraint:coincident-midpoint",
        kind: "coincident",
        first: { entityId: "point:target", selector: "point" },
        second: { entityId: "line:moving", selector: "midpoint" },
        suppressed: false
      }
    ]
  });
  const result = solveAnalyticSketch({ document, mode: "regenerate" });
  assert.equal(result.status, "solved");
  const moved = result.document.geometry.find((geometry) => geometry.id === "line:moving");
  if (moved?.kind === "line") {
    assert.deepEqual(moved.start, [8, 10]);
    assert.deepEqual(moved.end, [12, 10]);
  }

  const reversed = baseDocument({
    ...document,
    constraints: document.constraints.map((constraint) => constraint.kind === "coincident"
      ? { ...constraint, first: constraint.second, second: constraint.first }
      : constraint)
  });
  const reversedResult = solveAnalyticSketch({ document: reversed, mode: "regenerate" });
  assert.equal(reversedResult.status, "solved");
  assert.deepEqual(reversedResult.document.geometry, result.document.geometry);
});

test("coinciding distinct defining points of one entity is rejected without mutation", () => {
  const document = baseDocument({
    geometry: [line("line:protected", [0, 0], [10, 0])],
    constraints: [{
      id: "constraint:self-collapse",
      kind: "coincident",
      first: { entityId: "line:protected", selector: "start" },
      second: { entityId: "line:protected", selector: "end" },
      suppressed: false
    }]
  });
  const result = solveAnalyticSketch({ document, mode: "regenerate" });
  assert.equal(result.status, "failed");
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "CONSTRAINT_CONFLICT"), true);
  assert.deepEqual(result.document.geometry, document.geometry);
});

test("edit operations reject an invalid source document before creating geometry", () => {
  const invalid = baseDocument({ geometry: [line("line:degenerate", [0, 0], [0, 0])] });
  const result = executeSketchEdit(invalid, {
    kind: "offset",
    requestId: "edit:invalid-source",
    entityIds: ["line:degenerate"],
    resultEntityIds: ["line:result"],
    distanceMm: 2,
    side: "left",
    associative: false
  });
  assert.equal(result.status, "rejected");
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.code === "DEGENERATE_GEOMETRY"), true);
  assert.deepEqual(result.document, invalid);
});

function line(id: string, start: readonly [number, number], end: readonly [number, number]): LineGeometry {
  return { id, kind: "line", start, end, construction: false, suppressed: false };
}

function baseDocument(overrides: Partial<ParametricSketchDocument> = {}): ParametricSketchDocument {
  return {
    schemaVersion: "1.0",
    id: "sketch:test",
    revision: 0,
    plane: {
      kind: "principal",
      referenceId: "origin:xy",
      originMm: [0, 0, 0],
      xAxis: [1, 0, 0],
      yAxis: [0, 1, 0],
      normal: [0, 0, 1]
    },
    parameters: {},
    geometry: [],
    constraints: [],
    dimensions: [],
    ...overrides
  };
}
