import type { Vec3 } from "./types.js";

/**
 * Timeline steps that reshape a body that already exists by pointing at its faces: a general Shell, a Draft on chosen
 * faces, Offset region, Replace face, a Rib / Web joined to the body, a Wrap onto a cylinder and a Flex.
 *
 * A face is named by where it was picked (a point on it and the direction it looks), not by a face index, because the
 * kernel is a tessellator and indices change whenever the base is edited. When the timeline is replayed the face is found
 * again as the flat region of the current mesh that looks the same way and lies nearest that point.
 */
export interface FaceRef {
  readonly pointMm: Vec3;
  readonly normalMm: Vec3;
}

export interface PlaneRef {
  readonly pointMm: Vec3;
  readonly normalMm: Vec3;
}

export type BodyEditSpec =
  | {
      readonly kind: "shell";
      readonly thicknessMm: number;
      /** Which way the wall grows from the original surface: into the body, out of it, or half each way. */
      readonly side: "inside" | "outside" | "both";
      /** The faces left open. Empty hollows the body into a closed cavity. */
      readonly openFaces: readonly FaceRef[];
    }
  | {
      readonly kind: "draft";
      /** Lean of each chosen face from the pull direction, in degrees; positive narrows the body along the pull direction. */
      readonly angleDeg: number;
      readonly pullDirection: Vec3;
      /** A point on the neutral plane (the plane through it, square to the pull direction, stays put). */
      readonly neutralPointMm: Vec3;
      readonly faces: readonly FaceRef[];
    }
  | {
      readonly kind: "offset-region";
      /** Signed distance along each face's outward direction. */
      readonly distanceMm: number;
      readonly faces: readonly FaceRef[];
    }
  | {
      readonly kind: "replace-face";
      readonly faces: readonly FaceRef[];
      /** Either another face of the body or a plane; the replaced faces move onto its plane. */
      readonly toFace?: FaceRef;
      readonly toPlane?: PlaneRef;
    }
  | {
      readonly kind: "web";
      readonly thicknessMm: number;
      readonly direction: "symmetric" | "one-side";
      /** Which side of the open profile the web grows towards; absent picks the side that meets the body. */
      readonly flip?: boolean;
      /** The curves of the sketch (lines, arcs, splines) the web is built along. */
      readonly entityIds: readonly string[];
      /** Whether the ends of the profile are lengthened until they meet the body. */
      readonly extendToBody: boolean;
    }
  | {
      readonly kind: "wrap";
      readonly mode: "emboss" | "deboss";
      readonly heightMm: number;
      /** The cylindrical face the profile is wrapped onto, named by where it was picked. */
      readonly face: FaceRef;
    }
  | {
      readonly kind: "flex";
      readonly mode: "bend" | "twist";
      readonly angleDeg: number;
      readonly axisPointMm: Vec3;
      readonly axisDirectionMm: Vec3;
      /** Bend: the direction the bend runs along (square to the axis). Absent takes the body's longest direction square to the axis. */
      readonly lengthDirectionMm?: Vec3;
      /** Bend: how long the curved zone is, from the axis point. Absent bends over the rest of the body. */
      readonly zoneLengthMm?: number;
    };

/** The feature kinds that carry a `bodyEdit`. A shell or draft carries one only when it edits an existing body. */
export const BODY_EDIT_KINDS = ["shell", "draft", "offset-region", "replace-face", "web", "wrap", "flex"] as const;

/** Kinds that exist only as body edits (a shell or draft can also be a sketch-driven solid). */
export const BODY_EDIT_ONLY_KINDS = ["offset-region", "replace-face", "web", "wrap", "flex"] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finite = (value: unknown, max = 1_000_000): value is number => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= max;
const positive = (value: unknown, max: number): value is number => finite(value, max) && value > 0;
const triple = (value: unknown, nonZero: boolean): value is Vec3 => Array.isArray(value) && value.length === 3 && value.every((entry) => finite(entry)) && (!nonZero || value.some((entry) => entry !== 0));
const keysAre = (value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean =>
  required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
const faceRef = (value: unknown): value is FaceRef => isRecord(value) && keysAre(value, ["pointMm", "normalMm"], []) && triple(value.pointMm, false) && triple(value.normalMm, true);
const faceList = (value: unknown, minimum: number): value is readonly FaceRef[] => Array.isArray(value) && value.length >= minimum && value.length <= 64 && value.every(faceRef);

/** Whether `value` is a well-formed body-edit payload for a feature of kind `featureKind`. */
export function validBodyEdit(value: unknown, featureKind: string): value is BodyEditSpec {
  if (!isRecord(value) || value.kind !== featureKind) return false;
  switch (value.kind) {
    case "shell":
      return keysAre(value, ["kind", "thicknessMm", "side", "openFaces"], []) && positive(value.thicknessMm, 10_000)
        && ["inside", "outside", "both"].includes(String(value.side)) && faceList(value.openFaces, 0);
    case "draft":
      return keysAre(value, ["kind", "angleDeg", "pullDirection", "neutralPointMm", "faces"], [])
        && finite(value.angleDeg, 45) && value.angleDeg !== 0 && triple(value.pullDirection, true) && triple(value.neutralPointMm, false) && faceList(value.faces, 1);
    case "offset-region":
      return keysAre(value, ["kind", "distanceMm", "faces"], []) && finite(value.distanceMm, 100_000) && value.distanceMm !== 0 && faceList(value.faces, 1);
    case "replace-face": {
      if (!keysAre(value, ["kind", "faces"], ["toFace", "toPlane"]) || !faceList(value.faces, 1)) return false;
      const hasFace = Object.hasOwn(value, "toFace");
      const hasPlane = Object.hasOwn(value, "toPlane");
      if (hasFace === hasPlane) return false;
      return hasFace ? faceRef(value.toFace) : faceRef(value.toPlane);
    }
    case "web":
      return keysAre(value, ["kind", "thicknessMm", "direction", "entityIds", "extendToBody"], ["flip"]) && positive(value.thicknessMm, 10_000)
        && ["symmetric", "one-side"].includes(String(value.direction)) && typeof value.extendToBody === "boolean"
        && (!Object.hasOwn(value, "flip") || typeof value.flip === "boolean")
        && Array.isArray(value.entityIds) && value.entityIds.length >= 1 && value.entityIds.length <= 64
        && value.entityIds.every((id) => typeof id === "string" && id.length >= 1 && id.length <= 160);
    case "wrap":
      return keysAre(value, ["kind", "mode", "heightMm", "face"], []) && ["emboss", "deboss"].includes(String(value.mode)) && positive(value.heightMm, 10_000) && faceRef(value.face);
    case "flex":
      return keysAre(value, ["kind", "mode", "angleDeg", "axisPointMm", "axisDirectionMm"], ["lengthDirectionMm", "zoneLengthMm"])
        && ["bend", "twist"].includes(String(value.mode)) && finite(value.angleDeg, 360) && value.angleDeg !== 0
        && (value.mode === "twist" || Math.abs(value.angleDeg) <= 180)
        && triple(value.axisPointMm, false) && triple(value.axisDirectionMm, true)
        && (!Object.hasOwn(value, "lengthDirectionMm") || (value.mode === "bend" && triple(value.lengthDirectionMm, true)))
        && (!Object.hasOwn(value, "zoneLengthMm") || (positive(value.zoneLengthMm, 100_000)));
    default:
      return false;
  }
}

const trim = (value: number): string => String(Number(value.toFixed(3)));
const faces = (count: number): string => `${count} face${count === 1 ? "" : "s"}`;

/** One line saying what a body-edit step does, for the model browser and the solid inspector. */
export function describeBodyEdit(spec: BodyEditSpec): string {
  switch (spec.kind) {
    case "shell":
      return `${trim(spec.thicknessMm)} mm wall ${spec.side} · ${spec.openFaces.length === 0 ? "closed cavity" : `${faces(spec.openFaces.length)} open`}`;
    case "draft":
      return `${trim(spec.angleDeg)}° draft on ${faces(spec.faces.length)} · pull ${spec.pullDirection.map(trim).join(", ")}`;
    case "offset-region":
      return `${spec.distanceMm > 0 ? "+" : ""}${trim(spec.distanceMm)} mm on ${faces(spec.faces.length)}`;
    case "replace-face":
      return `${faces(spec.faces.length)} moved onto ${spec.toFace !== undefined ? "another face" : "a plane"}`;
    case "web":
      return `${trim(spec.thicknessMm)} mm ${spec.entityIds.length === 1 ? "rib" : "web"} · ${spec.direction}${spec.extendToBody ? " · to body" : ""}`;
    case "wrap":
      return `${spec.mode} ${trim(spec.heightMm)} mm onto a cylinder`;
    case "flex":
      return `${spec.mode} ${trim(spec.angleDeg)}° about (${spec.axisDirectionMm.map(trim).join(", ")})`;
  }
}
