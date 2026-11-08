import type { DesignExtentTarget, GeneralSolidBody } from "../../../packages/workbench-core/src/index.js";
import { facePlaneOf, pickableVertices } from "../../../packages/workbench-geometry/src/index.js";

/**
 * How far an extrude or revolve reaches, as the create-solid palette lets the user set it: a direction (one side, both sides, flipped, two
 * different distances), an extent (a distance, through all, or a "to" target) and, for a revolve, a thin wall. `buildReach` turns the
 * settings into the arguments of the create-solid call, or says what is missing.
 */
export type ReachDirection = "one-side" | "symmetric" | "flipped" | "two-side";
export type ReachExtent = "distance" | "through-all" | "to-face" | "to-body" | "to-vertex" | "to-first" | "to-last";

export interface ReachSettings {
  readonly direction: ReachDirection;
  /** The second side's distance (extrude) or angle (revolve), as typed. */
  readonly second: string;
  readonly extent: ReachExtent;
  /** The body a "to" extent reaches; empty means the selected one, else the newest. */
  readonly targetBodyId: string;
  readonly faceRole: string;
  /** Index into `vertexChoices` of the target body, as text. */
  readonly vertexIndex: string;
  readonly thin: boolean;
  readonly thinWall: string;
  readonly thinSide: "inside" | "outside" | "center";
}

export const DEFAULT_REACH: ReachSettings = { direction: "one-side", second: "10", extent: "distance", targetBodyId: "", faceRole: "", vertexIndex: "0", thin: false, thinWall: "2", thinSide: "inside" };

/** The extents an operation offers. Through all is for an extruded cut only. */
export function extentChoices(operation: "extrude" | "revolve", cutting: boolean): readonly { readonly value: ReachExtent; readonly label: string }[] {
  if (operation === "revolve") return [{ value: "distance", label: "Angle" }, { value: "to-first", label: "To first face" }, { value: "to-last", label: "To last face" }];
  return [
    { value: "distance", label: "Distance" },
    ...(cutting ? [{ value: "through-all" as const, label: "Through all" }] : []),
    { value: "to-face", label: "To face" },
    { value: "to-body", label: "To object" },
    { value: "to-vertex", label: "To vertex" }
  ];
}

export function isReachTarget(extent: ReachExtent): boolean {
  return extent === "to-face" || extent === "to-body" || extent === "to-vertex" || extent === "to-first" || extent === "to-last";
}

/** The body a "to" extent reaches: the one chosen, else the selected one, else the newest. */
export function reachBodyOf(bodies: readonly GeneralSolidBody[], chosenId: string, selectedId: string | null): GeneralSolidBody | undefined {
  return bodies.find((body) => body.id === chosenId) ?? bodies.find((body) => body.id === selectedId) ?? bodies.at(-1);
}

const AXES = ["X", "Y", "Z"] as const;

export interface FaceChoice { readonly role: string; readonly label: string; readonly planar: boolean }

/** The named faces of a body, each described by where it lies, so a face can be chosen without a 3D pick. */
export function faceChoices(body: GeneralSolidBody): readonly FaceChoice[] {
  if (body.brep === undefined) return [];
  const mesh = { positionsMm: body.positionsMm, indices: body.indices, faceTriangles: body.brep.faceTriangles };
  return body.brep.faces.map((face, index) => {
    const plane = facePlaneOf(mesh, index);
    const name = face.role.replace(/^(target|tool)\./, "").replace(/^face\./, "");
    if (plane === undefined || !plane.planar) return { role: face.role, label: `${name} · curved`, planar: false };
    const axis = [0, 1, 2].find((candidate) => Math.abs(plane.normal[candidate]!) > 0.999);
    if (axis === undefined) return { role: face.role, label: `${name} · flat, slanted`, planar: true };
    const facing = plane.normal[axis]! > 0 ? "+" : "-";
    return { role: face.role, label: `${name} · flat, faces ${facing}${AXES[axis]}, ${AXES[axis]!.toLowerCase()} = ${plane.pointMm[axis]!.toFixed(2)} mm`, planar: true };
  });
}

export interface VertexChoice { readonly index: number; readonly label: string; readonly pointMm: readonly [number, number, number] }

/** The corner vertices of a body (the ones a click could pick), in a steady order. */
export function vertexChoices(body: GeneralSolidBody): readonly VertexChoice[] {
  const corners = pickableVertices({ positionsMm: body.positionsMm, indices: body.indices });
  if (typeof corners === "string") return [];
  return [...corners]
    .sort((a, b) => a.pointMm[2] - b.pointMm[2] || a.pointMm[1] - b.pointMm[1] || a.pointMm[0] - b.pointMm[0])
    .slice(0, 200)
    .map((corner, index) => ({ index, label: `(${corner.pointMm.map((value) => value.toFixed(2)).join(", ")}) mm`, pointMm: corner.pointMm }));
}

export interface ReachArguments {
  readonly direction: ReachDirection;
  readonly params: {
    readonly secondValueMm?: number;
    readonly extent?: "to-face" | "to-body" | "to-vertex" | "to-first" | "to-last";
    readonly extentTarget?: DesignExtentTarget;
    readonly thinWallMm?: number;
    readonly thinSide?: "inside" | "outside" | "center";
  };
}

export type ReachResult = ({ readonly ok: true } & ReachArguments) | { readonly ok: false; readonly message: string };

/** Turns the palette settings into the direction and extra parameters of an extrude or revolve, or says what is wrong. */
export function buildReach(operation: "extrude" | "revolve", settings: ReachSettings, valueMm: number, bodies: readonly GeneralSolidBody[], selectedId: string | null): ReachResult {
  const unit = operation === "revolve" ? "angle" : "distance";
  // An extent left over from the other operation (or Through all on a join) counts as a plain distance.
  const extent: ReachExtent = extentChoices(operation, false).some((choice) => choice.value === settings.extent) ? settings.extent : "distance";
  const reaching = isReachTarget(extent);
  const direction = reaching && settings.direction === "symmetric" ? "one-side" : settings.direction;
  const params: { secondValueMm?: number; extent?: "to-face" | "to-body" | "to-vertex" | "to-first" | "to-last"; extentTarget?: DesignExtentTarget; thinWallMm?: number; thinSide?: "inside" | "outside" | "center" } = {};
  if (direction === "two-side") {
    const second = Number(settings.second);
    if (!Number.isFinite(second) || second <= 0) return { ok: false, message: `Enter a second ${unit} greater than zero for the other side.` };
    if (operation === "revolve" && valueMm + second > 360) return { ok: false, message: "The two angles add up to more than a full turn. Use smaller angles." };
    params.secondValueMm = second;
  }
  if (operation === "revolve" && settings.thin) {
    const wall = Number(settings.thinWall);
    if (!Number.isFinite(wall) || wall <= 0) return { ok: false, message: "Enter a thin-wall thickness greater than zero." };
    params.thinWallMm = wall;
    params.thinSide = settings.thinSide;
  }
  if (reaching && extent !== "distance" && extent !== "through-all") {
    const wantsRevolve = extent === "to-first" || extent === "to-last";
    const body = reachBodyOf(bodies, settings.targetBodyId, selectedId);
    if (body === undefined) return { ok: false, message: "Make a solid first; there is nothing to reach to." };
    params.extent = extent;
    if (extent === "to-body") {
      params.extentTarget = { kind: "body", bodyId: body.id };
    } else if (extent === "to-vertex") {
      const corner = vertexChoices(body)[Number(settings.vertexIndex)];
      if (corner === undefined) return { ok: false, message: `${body.name} has no corner vertex to extrude to.` };
      params.extentTarget = { kind: "vertex", bodyId: body.id, pointMm: corner.pointMm };
    } else {
      const choices = faceChoices(body);
      const choice = choices.find((candidate) => candidate.role === settings.faceRole) ?? choices.find((candidate) => candidate.planar || !wantsRevolve);
      if (choice === undefined) return { ok: false, message: `${body.name} has no named face to reach. Rebuild it with Extrude first.` };
      if (wantsRevolve && !choice.planar) return { ok: false, message: "A revolve can run to a flat face. Pick a flat face." };
      const index = body.brep?.faces.findIndex((face) => face.role === choice.role) ?? -1;
      const plane = facePlaneOf({ positionsMm: body.positionsMm, indices: body.indices, ...(body.brep === undefined ? {} : { faceTriangles: body.brep.faceTriangles }) }, index);
      params.extentTarget = { kind: "face", bodyId: body.id, faceRole: choice.role, ...(plane === undefined || !plane.planar ? {} : { pointMm: plane.pointMm, normal: plane.normal }) };
    }
  }
  return { ok: true, direction, params };
}
