import { isFeatureActive, modifiesBody } from "./design.js";
import { planeWorldCoordinate } from "./planar-faces.js";
import type { DesignFeature, DesignHistory, DesignSolidFeature } from "./types.js";

/** How a timeline step stands right now, in the order that decides what the user sees first. */
export type DesignFeatureStatus = "error" | "suppressed" | "rolled-back" | "inactive" | "active";

const DIRECTION: Readonly<Record<NonNullable<DesignSolidFeature["direction"]>, string>> = {
  "one-side": "one side",
  symmetric: "symmetric",
  flipped: "flipped"
};

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
    return `${sketchPlaneName(feature.sketch.plane)} plane${offset} · ${curves} ${curves === 1 ? "curve" : "curves"}`;
  }
  const source = history.features.find((candidate) => candidate.id === feature.sketchFeatureId);
  const amount = feature.extent === "through-all" ? "through all"
    : feature.kind === "extrude"
      ? `${trimNumber(feature.valueMm)} mm${feature.direction === undefined || feature.direction === "one-side" ? "" : ` ${DIRECTION[feature.direction]}`}`
      : feature.kind === "revolve"
        ? `${trimNumber(feature.valueMm)}°`
        : feature.kind === "sweep"
          ? `${trimNumber(feature.valueMm)} mm sweep`
          : `${trimNumber(feature.valueMm)} mm loft · top ${trimNumber(feature.loftTopScale ?? 1)}×`;
  const verb = !modifiesBody(feature) ? "" : feature.operation === "cut" ? "Cut " : "Join ";
  return `${verb}${amount} · from ${source === undefined ? "a deleted sketch" : source.name}`;
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
