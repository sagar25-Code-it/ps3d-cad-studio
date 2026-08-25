import {
  WORKBENCH_APPLICATION_VERSION,
  WORKBENCH_FORMAT,
  WORKBENCH_SCHEMA_VERSION,
  type WorkbenchProject
} from "./types.js";
import { createElectricalTemplate } from "./templates.js";
import { createVehicleTemplate } from "./vehicle.js";

export function createWorkbenchProject(projectId: string): WorkbenchProject {
  return {
    format: WORKBENCH_FORMAT,
    schemaVersion: WORKBENCH_SCHEMA_VERSION,
    applicationVersion: WORKBENCH_APPLICATION_VERSION,
    id: projectId,
    name: "PS3D Fixture Study",
    revision: 0,
    unit: "mm",
    activeWorkspace: "part",
    sketch: {
      id: "sketch:primary-profile",
      name: "Mounting profile",
      plane: "datum:xy",
      gridMm: 5,
      snapToleranceMm: 0.75,
      entities: [
        { id: "entity:mounting-outline", kind: "rectangle", center: [0, 0], widthMm: 60, heightMm: 40, rotationDeg: 0, construction: false },
        { id: "entity:centered-bore-profile", kind: "circle", center: [0, 0], radiusMm: 5, construction: false },
        { id: "entity:left-mount", kind: "circle", center: [-27, 0], radiusMm: 4, construction: false },
        { id: "entity:right-mount", kind: "circle", center: [27, 0], radiusMm: 4, construction: false },
        { id: "entity:center-guide", kind: "line", start: [-40, 0], end: [40, 0], construction: true }
      ],
      constraints: [
        { id: "constraint:outline-fixed", kind: "fixed", entityIds: ["entity:mounting-outline"] },
        { id: "constraint:centered-bore-fixed", kind: "fixed", entityIds: ["entity:centered-bore-profile"] },
        { id: "constraint:left-fixed", kind: "fixed", entityIds: ["entity:left-mount"] },
        { id: "constraint:right-fixed", kind: "fixed", entityIds: ["entity:right-mount"] },
        { id: "constraint:mounts-equal", kind: "equal", entityIds: ["entity:left-mount", "entity:right-mount"] },
        { id: "constraint:guide-horizontal", kind: "horizontal", entityIds: ["entity:center-guide"] },
        { id: "constraint:guide-fixed", kind: "fixed", entityIds: ["entity:center-guide"] }
      ]
    },
    part: {
      id: "part:mounting-plate",
      name: "Centered-bore plate",
      widthMm: 60,
      heightMm: 40,
      thicknessMm: 10,
      holeDiameterMm: 10,
      edgeTreatmentMm: 1.5,
      patternCount: 3,
      revolveAngleDeg: 270,
      previewBodies: []
    },
    assembly: {
      id: "assembly:fixture-demo",
      name: "Locator fixture",
      explodeMm: 18,
      template: "custom",
      nominalEnvelopeMm: [70, 48, 34],
      designStatus: "editable-preview",
      safetyNotes: ["LOCAL FIXTURE PREVIEW — VERIFY MATERIALS, LOADS, FITS, FASTENERS, AND MANUFACTURING REQUIREMENTS."],
      components: [
        component("component:base", "Base plate", "plate", true, "#1d8dc5", [0, 0, 0], [70, 48, 8], [0, 0, -0.25]),
        component("component:spacer-left", "Left spacer", "spacer", false, "#f1a744", [-22, 0, 11], [12, 12, 14], [-0.35, 0, 0.45]),
        component("component:spacer-right", "Right spacer", "spacer", false, "#f1a744", [22, 0, 11], [12, 12, 14], [0.35, 0, 0.45]),
        component("component:pin", "Locator pin", "pin", false, "#65d8d0", [0, 0, 16], [9, 9, 28], [0, 0, 0.72]),
        component("component:cap", "Retaining cap", "cap", false, "#b9c9d8", [0, 0, 31], [18, 18, 6], [0, 0, 1])
      ],
      mates: [
        { id: "mate:base-fixed", name: "Base grounded", kind: "fixed", componentIds: ["component:base"], status: "satisfied" },
        { id: "mate:pin-axis", name: "Pin aligned to base Z", kind: "aligned-axis", componentIds: ["component:base", "component:pin"], axis: "z", status: "satisfied" },
        { id: "mate:cap-axis", name: "Cap aligned to pin", kind: "aligned-axis", componentIds: ["component:pin", "component:cap"], axis: "z", status: "satisfied" },
        { id: "mate:spacers-plane", name: "Spacers seated", kind: "coincident-origin", componentIds: ["component:spacer-left", "component:spacer-right"], status: "satisfied" }
      ]
    },
    surface: {
      id: "surface:primary",
      name: "Canopy study",
      mode: "bezier",
      widthMm: 100,
      depthMm: 72,
      crownMm: 22,
      twistDeg: 12,
      uSegments: 20,
      vSegments: 16
    },
    drawing: {
      id: "drawing:main-sheet",
      title: "CENTERED BORE PLATE",
      sheet: "A3",
      projection: "third-angle",
      scale: 1,
      showDimensions: true,
      notes: "AUTO-DRAFT - ENGINEER REVIEW REQUIRED BEFORE MANUFACTURE",
      viewPreset: "automatic-4-view",
      displayStyle: "visible-hidden-edges",
      showSectionView: true,
      draftingStandard: "ASME",
      showGdt: true,
      datumScheme: "plate-3-2-1",
      gdtPositionToleranceMm: 0.2,
      gdtFlatnessToleranceMm: 0.1,
      gdtPerpendicularityToleranceMm: 0.1,
      generalToleranceLinearMm: 0.2,
      generalToleranceAngularDeg: 0.5
    },
    electrical: createElectricalTemplate("bess-single-line"),
    vehicle: createVehicleTemplate("ice-road-motorcycle"),
    audit: []
  };
}

function component(
  id: string,
  name: string,
  shape: "plate" | "spacer" | "pin" | "cap",
  grounded: boolean,
  color: string,
  translationMm: readonly [number, number, number],
  sizeMm: readonly [number, number, number],
  explosionDirection: readonly [number, number, number]
): WorkbenchProject["assembly"]["components"][number] {
  return { id, name, shape, grounded, visible: true, color, translationMm, rotationDeg: [0, 0, 0], sizeMm, explosionDirection };
}
