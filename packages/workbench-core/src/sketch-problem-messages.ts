import { ENVELOPE_LIMITS } from "./envelope-limits.js";
import { SKETCH_DATUM_PLANES } from "./types.js";

/**
 * Names the first thing wrong with a sketch placement or a stored sketch, so a refusal says which field and which limit instead of one
 * shared sentence for every plane problem and "the primary sketch is invalid or exceeds its limits" for every sketch problem.
 * The validators decide whether a value is valid; these only explain a value they already refused.
 */

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const AXES = ["x", "y", "z"];

/** The shape a plane placement payload takes, for the messages. */
const PLACEMENT_HINT = "Place a sketch on datum:xy, datum:xz or datum:yz, optionally with an offset (offsetMm) or a tilt ({ axis, angleDeg }), or on datum:xy with a frame, or on a solid face.";

export function sketchPlacementProblem(input: Record<string, unknown>, commonKeys: readonly string[]): string {
  const allowed = [...commonKeys, "plane", "offsetMm", "tilt", "frame", "face", "convention"];
  if (Object.hasOwn(input, "convention") && input["convention"] !== "z-up" && input["convention"] !== "legacy") return `The plane convention "${String(input["convention"]).slice(0, 20)}" is not "z-up" or "legacy".`;
  const stray = Object.keys(input).filter((key) => !allowed.includes(key));
  if (stray.length > 0) return `The sketch placement has an unknown field "${stray[0]!}". ${PLACEMENT_HINT}`;
  if (!(SKETCH_DATUM_PLANES as readonly unknown[]).includes(input["plane"])) return `The sketch plane "${String(input["plane"])}" is not one of datum:xy, datum:xz or datum:yz.`;
  const offset = input["offsetMm"];
  if (Object.hasOwn(input, "offsetMm") && !isFiniteNumber(offset)) return "The plane offset must be a finite number of millimetres.";
  if (isFiniteNumber(offset) && Math.abs(offset) > ENVELOPE_LIMITS.maxPlaneOffsetMm) return `The plane offset ${offset} mm is beyond the limit: a sketch plane may sit at most ${ENVELOPE_LIMITS.maxPlaneOffsetMm} mm from its datum.`;
  const tilt = input["tilt"];
  if (Object.hasOwn(input, "tilt")) {
    if (!isRecord(tilt)) return "The plane tilt must be { axis: \"x\" | \"y\" | \"z\", angleDeg }.";
    if (!AXES.includes(String(tilt["axis"]))) return `The tilt axis "${String(tilt["axis"])}" is not x, y or z.`;
    if (!isFiniteNumber(tilt["angleDeg"])) return "The tilt angle must be a finite number of degrees.";
    if (tilt["angleDeg"] === 0) return "A tilt of 0 degrees is no tilt: leave the tilt out.";
    if (Math.abs(tilt["angleDeg"]) > 180) return `The tilt angle ${tilt["angleDeg"]} degrees is beyond the limit of 180 degrees either way.`;
    if (Object.keys(tilt).some((key) => key !== "axis" && key !== "angleDeg")) return "The plane tilt takes only an axis and an angle.";
  }
  if (Object.hasOwn(input, "frame")) {
    const frame = input["frame"];
    if (input["plane"] !== "datum:xy") return "A frame is only available on datum:xy; for another datum use an offset or a tilt.";
    if (Object.hasOwn(input, "offsetMm") || Object.hasOwn(input, "tilt") || Object.hasOwn(input, "face")) return "A frame replaces the offset and the tilt: send a frame on its own.";
    if (!isRecord(frame)) return "The plane frame must be { originMm, uAxis, normal }.";
    const triple = (candidate: unknown, limit: number): boolean => Array.isArray(candidate) && candidate.length === 3 && candidate.every((part) => isFiniteNumber(part) && Math.abs(part) <= limit);
    if (!triple(frame["originMm"], ENVELOPE_LIMITS.maxPlaneOffsetMm)) return `The frame origin must be three finite numbers within ${ENVELOPE_LIMITS.maxPlaneOffsetMm} mm.`;
    if (!triple(frame["uAxis"], 1.000001) || !triple(frame["normal"], 1.000001)) return "The frame axes must each be three numbers of a unit vector.";
    const u = frame["uAxis"] as readonly number[];
    const n = frame["normal"] as readonly number[];
    if (Math.abs(Math.hypot(u[0]!, u[1]!, u[2]!) - 1) >= 1e-6) return "The frame's u axis must have length 1.";
    if (Math.abs(Math.hypot(n[0]!, n[1]!, n[2]!) - 1) >= 1e-6) return "The frame's normal must have length 1.";
    return "The frame's u axis and normal must be perpendicular (their dot product must be 0).";
  }
  if (Object.hasOwn(input, "face")) return Object.hasOwn(input, "tilt") ? "A sketch on a face follows the face: send no tilt with it." : "The face reference is incomplete: it needs the body, the face key, its role, axis, direction, coordinate and area.";
  return PLACEMENT_HINT;
}

/** Why a stored sketch was refused, ahead of its curves (which have their own, specific messages). */
export function sketchShapeProblem(value: unknown, limits: { readonly maxEntities: number; readonly maxConstraints: number }): string {
  if (!isRecord(value)) return "The primary sketch must be an object.";
  const required = ["id", "name", "plane", "gridMm", "snapToleranceMm", "entities", "constraints"];
  const optional = ["planeOffsetMm", "planeTilt", "planeFrame", "planeFace", "planeConvention", "planeRef", "texts", "patterns", "underlay", "projections"];
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (missing.length > 0) return `The primary sketch is missing "${missing[0]!}".`;
  const stray = Object.keys(value).filter((key) => !required.includes(key) && !optional.includes(key));
  if (stray.length > 0) return `The primary sketch has an unknown field "${stray[0]!}".`;
  if (value["id"] !== "sketch:primary-profile") return `The primary sketch must have the id "sketch:primary-profile", not "${String(value["id"]).slice(0, 60)}".`;
  if (!(SKETCH_DATUM_PLANES as readonly unknown[]).includes(value["plane"])) return `The primary sketch plane "${String(value["plane"]).slice(0, 40)}" is not one of datum:xy, datum:xz or datum:yz.`;
  if (typeof value["name"] !== "string" || value["name"].trim() === "" || value["name"].length > 120) return "The primary sketch name must be 1 to 120 characters.";
  const offset = value["planeOffsetMm"];
  if (Object.hasOwn(value, "planeOffsetMm") && !(isFiniteNumber(offset) && Math.abs(offset) <= ENVELOPE_LIMITS.maxPlaneOffsetMm)) return `The primary sketch plane offset must be a number within ${ENVELOPE_LIMITS.maxPlaneOffsetMm} mm.`;
  const grid = value["gridMm"];
  if (!(isFiniteNumber(grid) && grid >= 0.1 && grid <= 100)) return `The sketch grid ${String(grid)} mm is outside 0.1 to 100 mm.`;
  const snap = value["snapToleranceMm"];
  if (!(isFiniteNumber(snap) && snap >= 0.01 && snap <= 10)) return `The sketch snap tolerance ${String(snap)} mm is outside 0.01 to 10 mm.`;
  if (!Array.isArray(value["entities"])) return "The sketch entities must be a list.";
  if (value["entities"].length > limits.maxEntities) return `The sketch has ${value["entities"].length} entities; a sketch holds at most ${limits.maxEntities}. Delete curves you no longer need, or split the drawing across sketches.`;
  if (!Array.isArray(value["constraints"])) return "The sketch constraints must be a list.";
  if (value["constraints"].length > limits.maxConstraints) return `The sketch has ${value["constraints"].length} relations and dimensions; a sketch holds at most ${limits.maxConstraints}. Delete relations that are no longer needed.`;
  return "The sketch's plane placement (tilt, frame or face) is invalid: a tilt needs an x, y or z axis and a non-zero angle up to 180 degrees; a frame needs unit, perpendicular axes on datum:xy with no offset or tilt; a face reference cannot be combined with a tilt or a frame.";
}
