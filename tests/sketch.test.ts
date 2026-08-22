import { analyzeBracketSketch, validateDocumentSketch } from "../packages/sketch-kernel/src/index.js";
import { createBracketDocument } from "../packages/model-schema/src/index.js";
import { assert, equal, type TestCase } from "./test-kit.js";

export const sketchTests: readonly TestCase[] = [
  {
    name: "canonical rectangle and centered circle are fully constrained",
    run: () => {
      const result = validateDocumentSketch(createBracketDocument("document:test-sketch"));
      assert(result.ok, "canonical sketch should validate");
      equal(result.value.classification, "fully-constrained", "status should be fully constrained");
      equal(result.value.degreesOfFreedom, 0, "fully constrained sketch should report zero DOF");
      assert((result.value.profile?.netAreaSquareMeters ?? 0) > 0, "profile should have positive net area");
    }
  },
  {
    name: "missing circle center coordinate reports underconstraint",
    run: () => {
      const result = analyzeBracketSketch({
        rectangleId: "entity:test-rectangle",
        circleId: "entity:test-circle",
        widthMeters: 0.06,
        heightMeters: 0.04,
        holeDiameterMeters: 0.01,
        rectangleCenterMeters: [0, 0],
        circleCenterMeters: [null, 0],
        rectangleClosed: true
      });
      assert(result.ok, "underconstrained sketch is a valid diagnostic state");
      equal(result.value.classification, "underconstrained", "classification should expose missing constraint");
      equal(result.value.degreesOfFreedom, 1, "one missing coordinate should be one DOF");
      equal(result.value.diagnostics[0]?.code, "UNDERCONSTRAINED", "diagnostic should be typed");
    }
  },
  {
    name: "off-center circle conflicts with the centered constraint",
    run: () => {
      const result = analyzeBracketSketch({
        rectangleId: "entity:test-rectangle",
        circleId: "entity:test-circle",
        widthMeters: 0.06,
        heightMeters: 0.04,
        holeDiameterMeters: 0.01,
        rectangleCenterMeters: [0, 0],
        circleCenterMeters: [0.001, 0],
        rectangleClosed: true
      });
      assert(!result.ok, "off-center circle should fail the bounded centered constraint");
      equal(result.diagnostics[0]?.code, "CONSTRAINT_CONFLICT", "conflict should identify its type");
    }
  },
  {
    name: "oversized bore fails without automatic profile repair",
    run: () => {
      const result = analyzeBracketSketch({
        rectangleId: "entity:test-rectangle",
        circleId: "entity:test-circle",
        widthMeters: 0.06,
        heightMeters: 0.04,
        holeDiameterMeters: 0.039,
        rectangleCenterMeters: [0, 0],
        circleCenterMeters: [0, 0],
        rectangleClosed: true
      });
      assert(!result.ok, "insufficient wall should fail");
      equal(result.diagnostics[0]?.code, "DEGENERATE_GEOMETRY", "thin wall failure should be typed");
    }
  }
];
