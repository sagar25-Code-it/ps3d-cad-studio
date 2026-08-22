import {
  fail,
  parameterByKey,
  type CadDocument,
  type Diagnostic,
  type Result
} from "../../model-schema/src/index.js";

export interface BracketSketchInput {
  readonly rectangleId: string;
  readonly circleId: string;
  readonly widthMeters: number | null;
  readonly heightMeters: number | null;
  readonly holeDiameterMeters: number | null;
  readonly rectangleCenterMeters: readonly [number | null, number | null];
  readonly circleCenterMeters: readonly [number | null, number | null];
  readonly rectangleClosed: boolean;
}

export interface SketchAnalysis {
  readonly classification: "underconstrained" | "fully-constrained" | "conflicting";
  readonly degreesOfFreedom: number;
  readonly diagnostics: readonly Diagnostic[];
  readonly profile?: {
    readonly outerAreaSquareMeters: number;
    readonly holeAreaSquareMeters: number;
    readonly netAreaSquareMeters: number;
    readonly outerLoop: readonly (readonly [number, number])[];
    readonly circle: { readonly center: readonly [number, number]; readonly radiusMeters: number };
  };
}

const CENTER_TOLERANCE_METERS = 1e-10;
const MIN_WALL_METERS = 0.001;

export function analyzeBracketSketch(input: BracketSketchInput): Result<SketchAnalysis> {
  if (!input.rectangleClosed) {
    return fail("OPEN_PROFILE", "The rectangle boundary is open.", [input.rectangleId], "Close all four rectangle edges before regeneration.");
  }

  const scalars = [input.widthMeters, input.heightMeters, input.holeDiameterMeters, ...input.rectangleCenterMeters, ...input.circleCenterMeters];
  if (scalars.some((value) => value !== null && !Number.isFinite(value))) {
    return fail("INVALID_NUMBER", "The sketch contains a non-finite coordinate or dimension.", [input.rectangleId, input.circleId], "Enter finite dimensions and coordinates.");
  }

  const degreesOfFreedom = scalars.filter((value) => value === null).length;
  if (degreesOfFreedom > 0) {
    const diagnostic: Diagnostic = {
      code: "UNDERCONSTRAINED",
      severity: "warning",
      message: `${degreesOfFreedom} sketch degree${degreesOfFreedom === 1 ? "" : "s"} of freedom remain.`,
      relatedIds: [input.rectangleId, input.circleId],
      recovery: "Supply the missing center coordinates or driving dimensions."
    };
    return { ok: true, value: { classification: "underconstrained", degreesOfFreedom, diagnostics: [diagnostic] } };
  }

  const width = input.widthMeters as number;
  const height = input.heightMeters as number;
  const diameter = input.holeDiameterMeters as number;
  if (width <= 0 || height <= 0 || diameter <= 0) {
    return fail("DEGENERATE_GEOMETRY", "Every bracket dimension must be positive.", [input.rectangleId, input.circleId], "Increase the zero or negative dimension.");
  }

  const centers = [...input.rectangleCenterMeters, ...input.circleCenterMeters] as number[];
  if (centers.some((value) => Math.abs(value) > CENTER_TOLERANCE_METERS)) {
    return fail(
      "CONSTRAINT_CONFLICT",
      "The rectangle and circle must share the sketch origin in this bounded profile.",
      ["constraint:rectangle-centered", "constraint:bore-centered"],
      "Restore both entity centers to (0, 0)."
    );
  }

  const wall = (Math.min(width, height) - diameter) / 2;
  if (wall < MIN_WALL_METERS) {
    return fail(
      "DEGENERATE_GEOMETRY",
      "The centered bore leaves less than the 1 mm Phase 0 wall allowance.",
      [input.rectangleId, input.circleId],
      "Reduce the bore diameter or enlarge the plate."
    );
  }

  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const radius = diameter / 2;
  const outerArea = width * height;
  const holeArea = Math.PI * radius * radius;
  return {
    ok: true,
    value: {
      classification: "fully-constrained",
      degreesOfFreedom: 0,
      diagnostics: [],
      profile: {
        outerAreaSquareMeters: outerArea,
        holeAreaSquareMeters: holeArea,
        netAreaSquareMeters: outerArea - holeArea,
        outerLoop: [
          [-halfWidth, -halfHeight],
          [halfWidth, -halfHeight],
          [halfWidth, halfHeight],
          [-halfWidth, halfHeight]
        ],
        circle: { center: [0, 0], radiusMeters: radius }
      }
    }
  };
}

export function validateDocumentSketch(document: CadDocument): Result<SketchAnalysis> {
  const sketch = document.sketches[0];
  const rectangle = sketch.entities[0];
  const circle = sketch.entities[1];
  return analyzeBracketSketch({
    rectangleId: rectangle.id,
    circleId: circle.id,
    widthMeters: parameterByKey(document, "width").valueMeters,
    heightMeters: parameterByKey(document, "height").valueMeters,
    holeDiameterMeters: parameterByKey(document, "holeDiameter").valueMeters,
    rectangleCenterMeters: rectangle.centerMeters,
    circleCenterMeters: circle.centerMeters,
    rectangleClosed: rectangle.closed
  });
}
