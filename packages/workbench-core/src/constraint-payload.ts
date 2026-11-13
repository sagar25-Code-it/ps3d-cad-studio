import { MODEL_ENVELOPE, type EnvelopeProblem } from "./envelope.js";
import { SKETCH_POINT_REFS, SKETCH_RELATIVE_DISTANCE_NAMES } from "./types.js";
import { MAX_EXPRESSION_LENGTH } from "./expressions.js";
import { isOffsetGroupId } from "./offset-group.js";

/**
 * The shape check of a sketch relation or dimension that arrives as data (add-sketch-constraint, the addConstraints of
 * apply-sketch-edit, an MCP preview). It never throws: a missing or wrongly typed field, a value outside its range or an unknown
 * field comes back as a problem that names the field and the limit. Whether the entities it names exist, and whether the geometry
 * can satisfy it, are the next checks (the project validator and the solver).
 */

const ID_PATTERN = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/u;
const KINDS = ["horizontal", "vertical", "parallel", "perpendicular", "tangent", "collinear", "midpoint", "symmetry", "coincident", "concentric", "equal", "radius", "distance", "fixed", "angle", "arc-length", "perimeter", "smooth", "pierce", "refraction"] as const;
const DIMENSION_NAMES = ["length", "width", "height", "radius", "diameter", "aligned", "horizontal", "vertical", "point-line", "line-line", "offset", "major-radius", "minor-radius"] as const;
const ALLOWED_KEYS = ["id", "kind", "entityIds", "valueMm", "dimension", "suppressed", "points", "valueDeg", "driven", "pierce", "ratio", "expression", "doubled", "name", "offsetGroup", "inside"] as const;
const DRIVABLE = ["radius", "distance", "angle", "arc-length", "perimeter"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && value.length <= 128 && ID_PATTERN.test(value);
}

function shown(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value.length > 40 ? `${value.slice(0, 40)}...` : value);
  if (typeof value === "number") return Number.isInteger(value) ? value.toLocaleString("en-US") : String(Number(value.toPrecision(6)));
  if (value === null) return "null";
  if (Array.isArray(value)) return "a list";
  return typeof value === "object" ? "an object" : String(value);
}

function mm(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : String(Number(value.toPrecision(6)));
}

function problem(message: string, id: unknown): EnvelopeProblem {
  return stableId(id) ? { code: "INVALID_OPERATION", message, entityId: id } : { code: "INVALID_OPERATION", message };
}

function rangeProblem(message: string): EnvelopeProblem {
  return { code: "DEGENERATE_GEOMETRY", message };
}

const KIND_WORD: Readonly<Record<string, string>> = {
  radius: "radius", "arc-length": "arc length", perimeter: "perimeter"
};

export function sketchConstraintPayloadProblem(value: unknown): EnvelopeProblem | undefined {
  if (!isRecord(value)) return { code: "INVALID_OPERATION", message: "A sketch constraint must be an object with an id, a kind and the entityIds it relates." };
  const id = value.id;
  const label = stableId(id) ? `Sketch constraint ${id}` : "A sketch constraint";
  const bad = (message: string): EnvelopeProblem => problem(`${label} ${message}`, id);
  if (!Object.hasOwn(value, "id")) return bad("has no id; give it one in the form constraint:name.");
  if (!stableId(id)) return bad(`has the id ${shown(id)}, which is not a valid stable id. Use lowercase letters, digits and - . _ in the form constraint:name.`);
  const unknownKey = Object.keys(value).find((key) => !(ALLOWED_KEYS as readonly string[]).includes(key));
  if (unknownKey !== undefined) return bad(`carries the unknown field ${JSON.stringify(unknownKey.slice(0, 40))}; the fields are ${ALLOWED_KEYS.join(", ")}.`);
  const kind = value.kind;
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return bad(`has the kind ${shown(kind)}, which is not one of ${KINDS.join(", ")}.`);
  const entityIds = value.entityIds;
  if (!Object.hasOwn(value, "entityIds")) return bad("has no entityIds; list the ids of the curves it relates.");
  if (!Array.isArray(entityIds)) return bad(`needs entityIds to be a list of curve ids, but it is ${shown(entityIds)}.`);
  const maxEntities = kind === "perimeter" ? 64 : kind === "symmetry" || kind === "refraction" ? 3 : 2;
  if (entityIds.length < 1) return bad("needs at least one curve id in entityIds.");
  if (entityIds.length > maxEntities) return bad(`relates ${entityIds.length} curves, but a ${kind} relation takes at most ${maxEntities}.`);
  const badId = entityIds.find((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 128);
  if (entityIds.some((entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 128)) return bad(`lists ${shown(badId)} in entityIds, which is not a curve id.`);

  const has = (key: string): boolean => Object.hasOwn(value, key);
  if (has("suppressed") && typeof value.suppressed !== "boolean") return bad(`needs suppressed to be true or false, but it is ${shown(value.suppressed)}.`);
  if (has("driven") && typeof value.driven !== "boolean") return bad(`needs driven to be true or false, but it is ${shown(value.driven)}.`);
  if (has("name") && !(typeof value.name === "string" && /^d[1-9][0-9]{0,5}$/u.test(value.name))) return bad(`has the name ${shown(value.name)}; a dimension name is d followed by a number, such as d12 (the project gives the names itself).`);
  if (has("doubled")) {
    if (typeof value.doubled !== "boolean") return bad(`needs doubled to be true or false, but it is ${shown(value.doubled)}.`);
    if (kind !== "distance" || (value.dimension !== "point-line" && value.dimension !== "line-line")) return bad("is marked doubled (a diameter across a line), which only a point-line or line-line distance can be.");
  }
  if (has("offsetGroup")) {
    if (!isOffsetGroupId(value.offsetGroup)) return bad(`has the offset group ${shown(value.offsetGroup)}; an offset group is an id in the form offset:name.`);
    if (kind !== "distance") return bad(`is a ${kind} relation, which cannot belong to an offset group; only a distance can.`);
  }
  if (has("inside")) {
    if (typeof value.inside !== "boolean") return bad(`needs inside to be true or false, but it is ${shown(value.inside)}.`);
    if (kind !== "distance" || value.dimension !== "offset") return bad("is marked inside, which only the offset gap between two circles or arcs can be.");
  }
  const driven = value.driven === true;
  if (has("dimension") && (typeof value.dimension !== "string" || !(DIMENSION_NAMES as readonly string[]).includes(value.dimension))) {
    return bad(`has the dimension ${shown(value.dimension)}, which is not one of ${DIMENSION_NAMES.join(", ")}.`);
  }
  if (has("valueMm") && typeof value.valueMm !== "number") return bad(`needs valueMm to be a number, but it is ${shown(value.valueMm)}.`);
  if (has("valueDeg") && typeof value.valueDeg !== "number") return bad(`needs valueDeg to be a number, but it is ${shown(value.valueDeg)}.`);
  if (has("ratio") && typeof value.ratio !== "number") return bad(`needs ratio to be a number, but it is ${shown(value.ratio)}.`);
  if (has("expression") && typeof value.expression !== "string") return bad(`needs expression to be text, but it is ${shown(value.expression)}.`);
  if (has("points")) {
    const points = value.points;
    if (!Array.isArray(points)) return bad(`needs points to be a list of point names, but it is ${shown(points)}.`);
    const unknownPoint = points.find((point) => !(SKETCH_POINT_REFS as readonly unknown[]).includes(point));
    if (points.length < 1 || points.length > entityIds.length || unknownPoint !== undefined) {
      return bad(unknownPoint !== undefined ? `names the point ${shown(unknownPoint)}, which is not one of ${SKETCH_POINT_REFS.join(", ")}.` : `needs between 1 and ${entityIds.length} point names, but has ${points.length}.`);
    }
    if (kind !== "coincident" && kind !== "midpoint" && kind !== "smooth" && kind !== "fixed" && kind !== "distance" && kind !== "horizontal" && kind !== "vertical") return bad(`is a ${kind} relation, which does not name points.`);
    if ((kind === "horizontal" || kind === "vertical") && (points.length !== 2 || entityIds.length !== 2 || points.includes("curve"))) return bad(`is a ${kind} relation between two points, which needs two curves and one point of each in points.`);
  }
  if (has("pierce")) {
    const pierce = value.pierce;
    if (kind !== "pierce") return bad(`is a ${kind} relation, which does not take a pierce reference.`);
    const okAxis = isRecord(pierce) && pierce.kind === "axis" && stableId(pierce.axisId);
    const okEdge = isRecord(pierce) && pierce.kind === "body-edge" && stableId(pierce.bodyId) && typeof pierce.chain === "number" && Number.isInteger(pierce.chain) && pierce.chain >= 0 && pierce.chain <= 100_000;
    if (!okAxis && !okEdge) return bad("needs pierce to be { kind: \"axis\", axisId } or { kind: \"body-edge\", bodyId, chain }.");
  }
  if (kind === "pierce" && !has("pierce")) return bad("is a pierce relation, which needs a pierce reference ({ kind: \"axis\", axisId } or { kind: \"body-edge\", bodyId, chain }).");
  if (kind === "pierce" && entityIds.length !== 1) return bad("is a pierce relation, which takes exactly one curve.");
  if (kind === "refraction" && entityIds.length !== 3) return bad("is a refraction, which takes three lines: the incident line, the refracted line and the interface.");
  if (kind === "refraction" && !has("ratio")) return bad("is a refraction, which needs the index ratio in ratio.");
  if (has("ratio")) {
    if (kind !== "refraction") return bad(`is a ${kind} relation, which does not take a ratio.`);
    const ratio = value.ratio as number;
    if (!Number.isFinite(ratio) || ratio < 0.05 || ratio > 20) return rangeProblem(`${label} has the index ratio ${shown(ratio)}; a refraction ratio must be between 0.05 and 20.`);
  }
  if (kind === "smooth" && (!has("points") || entityIds.length !== 2)) return bad("is a smooth joint, which needs two curves and the end of each in points.");
  if (kind === "smooth" && has("points") && (value.points as readonly unknown[]).some((point) => point !== "start" && point !== "end")) return bad("is a smooth joint, whose points must be start or end of each curve.");
  if (has("dimension") && !has("valueMm") && !driven) return bad("names a dimension but carries no valueMm.");
  if (driven) {
    if (!DRIVABLE.includes(kind)) return bad(`is a ${kind} relation, which cannot be a reference (driven) dimension.`);
    if (has("valueMm") || has("valueDeg")) return bad("is a reference (driven) dimension, which is measured and carries no value of its own.");
  }
  if (has("expression")) {
    if (!(has("valueMm") || has("valueDeg"))) return bad("has an expression but no value; an expression only drives a dimension.");
    const expression = value.expression as string;
    if (expression.length < 1 || expression.length > MAX_EXPRESSION_LENGTH) return bad(`needs an expression of 1 to ${MAX_EXPRESSION_LENGTH} characters.`);
  }

  if (kind === "angle") {
    if (entityIds.length > 2) return bad("is an angle, which is measured between one or two lines.");
    if (has("valueMm")) return bad("is an angle, which takes valueDeg (degrees), not valueMm.");
    if (has("valueDeg")) {
      const degrees = value.valueDeg as number;
      if (!Number.isFinite(degrees)) return rangeProblem(`${label} has the angle ${shown(degrees)}, which is not a finite number.`);
      if (degrees < 0 || degrees >= 360) {
        const wrapped = ((degrees % 360) + 360) % 360;
        return rangeProblem(`${label} has the angle ${shown(degrees)} degrees, outside the supported range of 0 up to (not including) 360. ${Number.isFinite(wrapped) ? `${shown(wrapped)} degrees is the same direction.` : ""}`.trim());
      }
    }
  } else if (has("valueDeg")) {
    return bad(`is a ${kind} relation, which does not take valueDeg; only an angle does.`);
  }

  if (has("valueMm")) {
    const number = value.valueMm as number;
    if (!Number.isFinite(number)) return rangeProblem(`${label} has the value ${shown(number)}, which is not a finite number.`);
    const word = KIND_WORD[kind] ?? (typeof value.dimension === "string" ? (value.dimension === "aligned" ? "distance" : value.dimension.replace("-", " ")) : "distance");
    const relative = kind === "distance" && (SKETCH_RELATIVE_DISTANCE_NAMES as readonly unknown[]).includes(value.dimension);
    const lowest = relative ? 0 : MODEL_ENVELOPE.minGeometryMm;
    const highest = kind === "arc-length" || kind === "perimeter" ? MODEL_ENVELOPE.maxSketchLongMm : kind === "radius" ? MODEL_ENVELOPE.maxSketchRadiusMm * (value.dimension === "diameter" ? 2 : 1) : MODEL_ENVELOPE.maxSketchSizeMm;
    if (number < lowest || number > highest) {
      if (number <= 0 && !relative) return rangeProblem(`${label} has the ${word} ${mm(number)} mm; a ${word} must be positive (at least ${MODEL_ENVELOPE.minGeometryMm} mm).`);
      return rangeProblem(`${label} has the ${word} ${mm(number)} mm, ${number < lowest ? `below the smallest supported size of ${mm(lowest)} mm` : `above the largest supported size of ${mm(highest)} mm`}; use a value from ${mm(lowest)} to ${mm(highest)} mm.`);
    }
  }
  return undefined;
}
