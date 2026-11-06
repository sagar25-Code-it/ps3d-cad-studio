import type { SketchConstraintKind, SketchEntity } from "./types.js";

export type SketchEntityKind = SketchEntity["kind"];

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

/**
 * The single rule table for which entity kinds each geometric relation can act on, in the order they were picked.
 * The live solver, the degree-of-freedom analysis and the Constrain buttons all read it, so a button is enabled
 * exactly when the solver will actually enforce the relation, and the analysis never reports a "conflict" for a
 * pair the solver is happy with (or the reverse).
 */
export function constraintFit(kind: SketchConstraintKind, kinds: readonly (SketchEntityKind | undefined)[]): ConstraintFit {
  if (kinds.some((entry) => entry === undefined)) return no("A referenced entity no longer exists.");
  const [first, second, third] = kinds;
  switch (kind) {
    case "fixed":
      return kinds.length >= 1 ? FITS : no("Fix needs at least one curve.");
    case "radius":
      return kinds.length === 1 && radial(first) ? FITS : no("A radius dimension applies to one circle or arc.");
    case "distance":
      return kinds.length === 1 && (first === "line" || first === "rectangle") ? FITS : no("A distance dimension applies to one line or rectangle.");
    default:
      break;
  }
  if (kinds.some((entry) => entry === "rectangle")) return no("Rectangles are rigid in the solver; only Fixed and their own width and height apply.");
  switch (kind) {
    case "horizontal":
    case "vertical":
      return kinds.length === 1 && first === "line" ? FITS : no(`${kind === "horizontal" ? "Horizontal" : "Vertical"} applies to one line.`);
    case "parallel":
    case "perpendicular":
    case "collinear":
      return kinds.length === 2 && first === "line" && second === "line" ? FITS : no(`${kind[0]!.toUpperCase()}${kind.slice(1)} needs two lines.`);
    case "concentric":
      return kinds.length === 2 && radial(first) && radial(second) ? FITS : no("Concentric needs two circles or arcs.");
    case "equal":
      return kinds.length === 2 && ((first === "line" && second === "line") || (radial(first) && radial(second))) ? FITS : no("Equal needs two lines, or two circles or arcs.");
    case "tangent":
      return kinds.length === 2 && ((first === "line" && radial(second)) || (second === "line" && radial(first)) || (radial(first) && radial(second)))
        ? FITS
        : no("Tangent solves a line against a circle or arc, or two circles or arcs.");
    case "symmetry":
      if (kinds.length < 3) return no("Symmetric needs two entities and an axis line (select the axis last).");
      if (kinds.length > 3 || third !== "line") return no("Symmetric needs an axis line as the last selection.");
      return (first === "line" && second === "line") || (first === "circle" && second === "circle")
        ? FITS
        : no("Symmetric solves two lines or two circles about a line axis; arcs and mixed pairs are recorded only.");
    case "coincident":
    case "midpoint":
      return no(`${kind[0]!.toUpperCase()}${kind.slice(1)} needs endpoint selection, which the sketch records but does not solve yet.`);
    default:
      return no("This relation is not supported.");
  }
}
