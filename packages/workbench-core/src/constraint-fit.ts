import type { SketchConstraintKind, SketchDimensionName, SketchEntity, SketchPointRef } from "./types.js";

/** The kinds of thing a constraint can name: every entity kind, plus the fixed sketch origin and the two axes. */
export type SketchEntityKind = SketchEntity["kind"] | "origin" | "axis";

export interface ConstraintFit {
  readonly ok: boolean;
  /** Why the relation cannot be enforced; empty when it can. */
  readonly reason: string;
}

const FITS: ConstraintFit = { ok: true, reason: "" };

function no(reason: string): ConstraintFit {
  return { ok: false, reason };
}

const radial = (kind: SketchEntityKind | undefined): boolean => kind === "circle" || kind === "arc";
const lineLike = (kind: SketchEntityKind | undefined): boolean => kind === "line" || kind === "axis";
const centred = (kind: SketchEntityKind | undefined): boolean => kind === "circle" || kind === "arc" || kind === "ellipse" || kind === "rectangle";

/** The defining points the live solver can read and move, per entity kind. Spline points are recorded only. */
export const SOLVABLE_POINT_REFS: Readonly<Record<SketchEntityKind, readonly SketchPointRef[]>> = {
  line: ["start", "end", "mid"],
  circle: ["center"],
  ellipse: ["center"],
  arc: ["center", "start", "end", "mid"],
  point: ["self"],
  rectangle: ["center", "corner-0", "corner-1", "corner-2", "corner-3"],
  spline: [],
  origin: ["self"],
  axis: []
};

/** The curves a point can be put on (the `curve` point reference). */
const CURVE_KINDS: readonly SketchEntityKind[] = ["line", "circle", "arc", "ellipse", "axis"];

function whyNotPoint(kind: SketchEntityKind, ref: SketchPointRef): string {
  if (kind === "spline") return "Splines cannot be joined at a point yet.";
  if (kind === "ellipse") return "Ellipses can be joined at their centre only; axis ends cannot be joined yet.";
  if (kind === "axis") return "An axis is a line, not a point; put a point on it instead.";
  if (kind === "rectangle") return "A rectangle has a centre and four corners (corner-0 to corner-3) to join.";
  return `A ${kind} has no ${ref} point to join.`;
}

function pointOk(kind: SketchEntityKind, ref: SketchPointRef | undefined): ConstraintFit {
  if (ref === undefined) return no("Pick the point on each curve.");
  return SOLVABLE_POINT_REFS[kind].includes(ref) ? FITS : no(whyNotPoint(kind, ref));
}

function pointFit(kind: "coincident" | "midpoint", kinds: readonly (SketchEntityKind | undefined)[], points: readonly SketchPointRef[] | undefined): ConstraintFit {
  if (points === undefined) return no(`${kind === "coincident" ? "Coincident" : "Midpoint"} needs the points to join; pick them on the canvas.`);
  if (kind === "coincident") {
    if (kinds.length !== 2 || points.length !== 2) return no("Coincident joins exactly two points.");
    const [firstKind, secondKind] = kinds as readonly [SketchEntityKind, SketchEntityKind];
    const [firstRef, secondRef] = points as readonly [SketchPointRef, SketchPointRef];
    if (firstKind === "origin" && secondKind === "origin") return no("The origin cannot be joined to itself.");
    const onCurve = firstRef === "curve" || secondRef === "curve";
    if (onCurve) {
      if (firstRef === "curve" && secondRef === "curve") return no("Point on curve needs one point and one curve.");
      const curveKind = firstRef === "curve" ? firstKind : secondKind;
      const pointKind = firstRef === "curve" ? secondKind : firstKind;
      const pointRef = firstRef === "curve" ? secondRef : firstRef;
      if (!CURVE_KINDS.includes(curveKind)) return no(`A point cannot be put on a ${curveKind} yet; choose a line, circle, arc, ellipse or an axis.`);
      return pointOk(pointKind, pointRef);
    }
    for (let index = 0; index < 2; index += 1) {
      const fit = pointOk(kinds[index]!, points[index]!);
      if (!fit.ok) return fit;
    }
    return FITS;
  }
  if (kinds.length !== 2 || points.length < 1) return no("Midpoint needs a point and a line.");
  if (kinds[1] !== "line") return no("Midpoint needs a line to sit at the middle of.");
  return pointOk(kinds[0]!, points[0]);
}

export interface ConstraintFitOptions {
  readonly driven?: boolean;
  /** For a radius or distance constraint: which dimension it is (a diameter, a point-to-point distance, an ellipse axis...). */
  readonly dimension?: SketchDimensionName;
}

/**
 * The single rule table for which entity kinds each geometric relation can act on, in the order they were picked.
 * The live solver, the degree-of-freedom analysis, the operation that adds a constraint and the Constrain buttons all read it, so a
 * button is enabled exactly when the solver will actually enforce the relation, a meaningless relation (a horizontal circle, a radius
 * on a line) is refused with the reason, and the analysis never reports a "conflict" for a pair the solver is happy with.
 * Point-level relations (Coincident, Midpoint, point-level Fixed, point distances) also take the defining point each entity contributes.
 */
export function constraintFit(kind: SketchConstraintKind, kinds: readonly (SketchEntityKind | undefined)[], points?: readonly SketchPointRef[], options: ConstraintFitOptions = {}): ConstraintFit {
  if (kinds.some((entry) => entry === undefined)) return no("A referenced entity no longer exists.");
  const [first, second, third] = kinds;
  switch (kind) {
    case "fixed": {
      if (kinds.length < 1) return no("Fix needs at least one curve.");
      if (kinds.some((entry) => entry === "origin" || entry === "axis")) return no("The origin and the axes are already fixed.");
      // Fixing one defining point (an end, a centre, a corner) instead of the whole curve.
      if (points !== undefined) {
        for (let index = 0; index < kinds.length; index += 1) {
          const ref = points[index];
          if (ref === undefined) continue;
          const fit = pointOk(kinds[index]!, ref);
          if (!fit.ok) return fit;
        }
      }
      return FITS;
    }
    case "radius": {
      const dimension = options.dimension ?? "radius";
      if (dimension === "major-radius" || dimension === "minor-radius") return kinds.length === 1 && first === "ellipse" ? FITS : no("A major or minor radius dimension applies to one ellipse.");
      if (dimension !== "radius" && dimension !== "diameter") return no("This is not a radius dimension.");
      return kinds.length === 1 && radial(first) ? FITS : no(`A ${dimension} dimension applies to one circle or arc${first === "ellipse" ? " (an ellipse takes a major or minor radius)" : ""}.`);
    }
    case "distance":
      return distanceFit(kinds as readonly SketchEntityKind[], points, options.dimension);
    case "coincident":
    case "midpoint":
      return pointFit(kind, kinds, points);
    case "angle":
      if (kinds.length === 1) return first === "ellipse" ? FITS : no("An angle dimension applies to two lines, or to one ellipse (the turn of its major axis).");
      if (kinds.length === 2 && lineLike(first) && lineLike(second)) return first === "axis" && second === "axis" ? no("An angle needs at least one line.") : FITS;
      return no("An angle dimension applies to two lines, or to one ellipse (the turn of its major axis).");
    case "arc-length":
      if (kinds.length !== 1) return no("An arc length dimension applies to one curve.");
      if (options.driven === true) return first === "arc" || first === "line" || first === "spline" ? FITS : no("A reference arc length measures an arc, a line or a spline.");
      return first === "arc" ? FITS : no("A driving arc length applies to an arc; a line takes a length dimension.");
    case "perimeter":
      if (options.driven === true) return kinds.length >= 1 && kinds.every((entry) => entry !== "point" && entry !== "origin" && entry !== "axis") ? FITS : no("A reference perimeter measures curves, not points.");
      return kinds.length === 1 && (first === "circle" || first === "rectangle" || first === "ellipse") ? FITS : no("A driving perimeter applies to one circle, rectangle or ellipse.");
    case "smooth": {
      if (kinds.length !== 2) return no("Smooth joins the end of a spline to one other curve.");
      if (first !== "spline" && second !== "spline") return no("Smooth needs a spline at one of the two curves.");
      const continuing = (entry: SketchEntityKind | undefined): boolean => entry === "line" || entry === "arc" || entry === "spline";
      if (!continuing(first) || !continuing(second)) return no("Smooth joins a spline to a line, an arc or another spline.");
      if (points === undefined || points.length !== 2 || points.some((ref) => ref !== "start" && ref !== "end")) return no("Smooth needs the end (start or end) of each curve that meets; pick them on the canvas.");
      return FITS;
    }
    case "pierce":
      return kinds.length === 1 && first === "point" ? FITS : no("Pierce puts one sketch point where an axis or edge crosses the sketch plane.");
    case "horizontal":
    case "vertical":
      // Two points level with each other (Horizontal) or one above the other (Vertical); the origin can be one of them.
      if (kinds.length === 2) return levelPointsFit(kind, kinds as readonly SketchEntityKind[], points);
      break;
    case "refraction":
      return kinds.length === 3 && kinds.every((entry) => entry === "line") ? FITS : no("Refraction needs the incident line, the refracted line and the interface line.");
    default:
      break;
  }
  if (kinds.some((entry) => entry === "origin")) return no("The origin is a point; only Coincident, Midpoint and point distances can name it.");
  if (kinds.some((entry) => entry === "axis") && kind !== "parallel" && kind !== "perpendicular" && kind !== "collinear" && kind !== "tangent" && kind !== "symmetry") {
    return no("An axis can be used by Parallel, Perpendicular, Collinear, Tangent, Symmetric, Coincident (point on axis) and angle dimensions.");
  }
  switch (kind) {
    case "horizontal":
    case "vertical":
      return kinds.length === 1 && (first === "line" || first === "rectangle") ? FITS : no(`${kind === "horizontal" ? "Horizontal" : "Vertical"} applies to one line or rectangle, or to two points.`);
    case "parallel":
    case "perpendicular":
    case "collinear":
      if (kinds.length === 2 && lineLike(first) && lineLike(second)) return first === "axis" && second === "axis" ? no(`${kind[0]!.toUpperCase()}${kind.slice(1)} needs at least one line.`) : FITS;
      return no(`${kind[0]!.toUpperCase()}${kind.slice(1)} needs two lines.`);
    case "concentric":
      return kinds.length === 2 && centred(first) && centred(second) ? FITS : no("Concentric needs two circles, arcs, ellipses or rectangles.");
    case "equal":
      return kinds.length === 2 && ((first === "line" && second === "line") || (radial(first) && radial(second)) || (first === "ellipse" && second === "ellipse") || (first === "rectangle" && second === "rectangle"))
        ? FITS
        : no("Equal needs two lines, two circles or arcs, two ellipses or two rectangles.");
    case "tangent":
      return kinds.length === 2 && ((lineLike(first) && radial(second)) || (lineLike(second) && radial(first)) || (radial(first) && radial(second)))
        ? FITS
        : no("Tangent solves a line against a circle or arc, or two circles or arcs.");
    case "symmetry":
      if (kinds.length < 3) return no("Symmetric needs two entities and an axis line (select the axis last).");
      if (kinds.length > 3 || !lineLike(third)) return no("Symmetric needs an axis line as the last selection.");
      return first === second && (first === "line" || first === "circle" || first === "point" || first === "arc" || first === "rectangle" || first === "ellipse" || first === "spline")
        ? FITS
        : no("Symmetric solves two curves of the same kind (lines, circles, arcs, rectangles, ellipses, splines or points) about a line axis; mixed pairs are not supported.");
    default:
      return no("This relation is not supported.");
  }
}

function levelPointsFit(kind: "horizontal" | "vertical", kinds: readonly SketchEntityKind[], points: readonly SketchPointRef[] | undefined): ConstraintFit {
  const name = kind === "horizontal" ? "Horizontal" : "Vertical";
  if (points === undefined || points.length !== 2) return no(`${name} between two curves needs a point on each; pick the two points on the canvas.`);
  if (kinds[0] === "origin" && kinds[1] === "origin") return no("The origin cannot be lined up with itself.");
  for (let index = 0; index < 2; index += 1) {
    const fit = pointOk(kinds[index]!, points[index]);
    if (!fit.ok) return fit;
  }
  return FITS;
}

function distanceFit(kinds: readonly SketchEntityKind[], points: readonly SketchPointRef[] | undefined, dimension: SketchDimensionName | undefined): ConstraintFit {
  const [first, second] = kinds;
  const relative = dimension === "aligned" || dimension === "horizontal" || dimension === "vertical" || dimension === "point-line" || dimension === "line-line" || dimension === "offset";
  if (!relative) {
    if (dimension === "width" || dimension === "height") return kinds.length === 1 && first === "rectangle" ? FITS : no(`A ${dimension} dimension applies to one rectangle.`);
    if (dimension === "length") return kinds.length === 1 && first === "line" ? FITS : no("A length dimension applies to one line.");
    if (kinds.length === 1) return first === "line" || first === "rectangle" ? FITS : no("A distance dimension applies to one line or rectangle.");
    // Two entities without a named kind: a distance between two points.
    return distanceFit(kinds, points, "aligned");
  }
  if (kinds.length !== 2) return no("This distance is measured between two things.");
  if (dimension === "offset") {
    const round = (kind: SketchEntityKind | undefined): boolean => kind === "circle" || kind === "arc";
    return round(first) && round(second) ? FITS : no("An offset between curves needs two circles or arcs (two lines take a line-to-line distance).");
  }
  if (dimension === "line-line") {
    if (!lineLike(first) || !lineLike(second)) return no("A line-to-line distance needs two lines.");
    return first === "axis" && second === "axis" ? no("Pick at least one real line.") : FITS;
  }
  if (dimension === "point-line") {
    if (!lineLike(second)) return no("A point-to-line distance needs a line (or an axis) as its second pick.");
    if (points === undefined || points.length < 1) return no("Pick the point whose distance to the line is measured.");
    return pointOk(first!, points[0]);
  }
  if (points === undefined || points.length !== 2) return no("A distance between points needs a point on each of two curves; pick them on the canvas.");
  if (first === "origin" && second === "origin") return no("The distance from the origin to itself is zero.");
  for (let index = 0; index < 2; index += 1) {
    const fit = pointOk(kinds[index]!, points[index]);
    if (!fit.ok) return fit;
  }
  return FITS;
}
