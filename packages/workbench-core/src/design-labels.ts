import { describeBodyEdit } from "./body-edit.js";
import { isFeatureActive, modifiesBody } from "./design.js";
import { describePattern } from "./pattern.js";
import { edgeBlendSummary } from "./edge-blend.js";
import { planeWorldCoordinate } from "./planar-faces.js";
import type { DesignFeature, DesignHistory, DesignSolidFeature } from "./types.js";

/** How a timeline step stands right now, in the order that decides what the user sees first. */
export type DesignFeatureStatus = "error" | "suppressed" | "rolled-back" | "inactive" | "active";

const DIRECTION: Readonly<Record<NonNullable<DesignSolidFeature["direction"]>, string>> = {
  "one-side": "one side",
  symmetric: "symmetric",
  flipped: "flipped",
  "two-side": "two sides"
};

const EXTENT_TEXT: Readonly<Record<string, string>> = {
  "to-face": "to face",
  "to-body": "to object",
  "to-vertex": "to vertex",
  "to-first": "to first face",
  "to-last": "to last face"
};

function sweptAmount(feature: DesignSolidFeature, unit: string): string {
  const reached = feature.extent === undefined ? undefined : EXTENT_TEXT[feature.extent];
  if (reached !== undefined) return `${reached} (${trimNumber(feature.valueMm)}${unit} when picked)`;
  if (feature.direction === "two-side") return `${trimNumber(feature.valueMm)}${unit} + ${trimNumber(feature.secondValueMm ?? 0)}${unit} two sides`;
  const side = feature.direction === undefined || feature.direction === "one-side" ? "" : ` ${DIRECTION[feature.direction]}`;
  return `${trimNumber(feature.valueMm)}${unit}${side}`;
}

/** The timeline step that owns a body, if any. A body made by Combine, or saved before the timeline existed, has none. */
export function featureOfBody(history: DesignHistory, bodyId: string): DesignSolidFeature | undefined {
  for (const feature of history.features) {
    if (feature.kind !== "sketch" && feature.bodyId === bodyId) return feature;
  }
  return undefined;
}

export function sketchPlaneName(plane: string): string {
  return plane === "datum:xz" ? "XZ" : plane === "datum:yz" ? "YZ" : "XY";
}

function trimNumber(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** One line saying what a step is, used by the model browser and the solid inspector. */
export function describeFeature(history: DesignHistory, feature: DesignFeature): string {
  if (feature.kind === "sketch") {
    const curves = feature.sketch.entities.filter((entity) => !entity.construction).length;
    const where = planeWorldCoordinate(feature.sketch.plane, feature.sketch.planeOffsetMm ?? 0);
    const offset = where.valueMm === 0 ? "" : ` at ${where.axisName} = ${trimNumber(where.valueMm)} mm`;
    const tilt = feature.sketch.planeTilt === undefined ? "" : `, tilted ${trimNumber(feature.sketch.planeTilt.angleDeg)}° about ${feature.sketch.planeTilt.axis.toUpperCase()}`;
    if (feature.sketch.planeFrame !== undefined) return `Plane through 3 points · ${curves} ${curves === 1 ? "curve" : "curves"}`;
    return `${sketchPlaneName(feature.sketch.plane)} plane${offset}${tilt} · ${curves} ${curves === 1 ? "curve" : "curves"}`;
  }
  if (feature.kind === "pattern" && feature.pattern !== undefined) {
    const pattern = feature.pattern;
    const repeated = (pattern.featureIds ?? []).map((id) => history.features.find((candidate) => candidate.id === id)?.name ?? "a deleted step");
    return `${describePattern(pattern)}${repeated.length === 0 ? "" : ` · ${repeated.join(", ")}`}${pattern.copyIndex === undefined ? "" : ` · copy ${pattern.copyIndex}`}`;
  }
  if (feature.bodyEdit !== undefined) return describeBodyEdit(feature.bodyEdit);
  const source = history.features.find((candidate) => candidate.id === feature.sketchFeatureId);
  const amount = feature.extent === "through-all" ? "through all"
    : feature.kind === "extrude"
      ? sweptAmount(feature, " mm")
      : feature.kind === "revolve"
        ? `${sweptAmount(feature, "°")}${feature.thinWallMm === undefined ? "" : ` · thin ${trimNumber(feature.thinWallMm)} mm ${feature.thinSide ?? "inside"}`}`
        : feature.kind === "sweep"
          ? `${trimNumber(feature.valueMm)} mm sweep`
          : feature.kind === "loft"
            ? `${trimNumber(feature.valueMm)} mm loft · top ${trimNumber(feature.loftTopScale ?? 1)}×`
            : feature.kind === "edge-blend"
              ? edgeBlendSummary(feature)
              : feature.kind === "edge-fillet"
              ? `${trimNumber(feature.valueMm)} mm · fillet ${trimNumber(feature.edge?.sizeMm ?? 0)} mm`
              : feature.kind === "edge-chamfer"
                ? `${trimNumber(feature.valueMm)} mm · chamfer ${trimNumber(feature.edge?.sizeMm ?? 0)} mm`
                : feature.kind === "shell"
                  ? `${trimNumber(feature.valueMm)} mm · wall ${trimNumber(feature.shellThicknessMm ?? 0)} mm${feature.shellOpenFace === "none" ? "" : ` · ${feature.shellOpenFace ?? "top"} open`}`
                  : feature.kind === "sheet-jog"
                    ? `${trimNumber(feature.jogOffsetMm ?? 0)} mm step at ${trimNumber(feature.jogAngleDeg ?? 0)}° · ${trimNumber(feature.jogPositionMm ?? 0)} mm from edge ${feature.jogEdgeIndex ?? 0}`
                    : feature.kind === "sheet-edge-flange"
                      ? `${trimNumber(feature.flangeAngleDeg ?? 0)}° flange, ${trimNumber(feature.flangeLengthMm ?? 0)} mm · ${feature.flangeMiterEdges === undefined ? `edge ${feature.flangeEdgeIndex ?? 0}` : `mitred along edges ${[feature.flangeEdgeIndex ?? 0, ...feature.flangeMiterEdges].join(", ")}`}`
                      : feature.kind === "sheet-lofted-bend"
                        ? `${trimNumber(Math.abs(feature.valueMm))} mm lofted bend · ${trimNumber(feature.sheetThicknessMm ?? 0)} mm sheet`
                        : `${trimNumber(feature.valueMm)} mm · ${trimNumber(feature.draftAngleDeg ?? 0)}° draft · ${feature.draftNeutralFace ?? "bottom"} neutral`;
  const verb = !modifiesBody(feature) ? "" : feature.operation === "cut" ? "Cut " : feature.operation === "join" ? "Join " : "";
  return `${verb}${amount} · from ${source === undefined ? "a deleted sketch" : source.name}`;
}

/** Begins a health message that is a note about a step that was applied (see isHealthNote), as opposed to the reason it could not be. */
export const HEALTH_NOTE_PREFIX = "Note: ";

/** Whether a feature's health message is a note: the step was applied, and the message says something about the solid it made. */
export function isHealthNote(message: string | undefined): boolean {
  return message?.startsWith(HEALTH_NOTE_PREFIX) === true;
}

export function featureStatus(history: DesignHistory, feature: DesignFeature): DesignFeatureStatus {
  if (feature.health !== undefined) return "error";
  if (feature.suppressed) return "suppressed";
  const index = history.features.findIndex((candidate) => candidate.id === feature.id);
  if (index < 0 || index >= history.rollbackIndex) return "rolled-back";
  return isFeatureActive(history, feature.id) ? "active" : "inactive";
}

const STATUS_TEXT: Readonly<Record<DesignFeatureStatus, string>> = {
  error: "needs attention",
  suppressed: "suppressed",
  "rolled-back": "rolled back",
  inactive: "off (its sketch is suppressed)",
  active: ""
};

/** Words for a status, or an empty string for a step that is simply on. */
export function featureStatusText(status: DesignFeatureStatus): string {
  return STATUS_TEXT[status];
}
