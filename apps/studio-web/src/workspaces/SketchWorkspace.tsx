import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SOLVABLE_POINT_REFS, SPLINE_MAX_FIT_POINTS, constraintFit, planeWorldCoordinate, type DesignExtentTarget, type GeneralSolidBody, type ConstraintFit, type SketchDatumPlane, type SketchDimensionName, type SketchEntity, type SketchConstraintKind, type SketchPointRef, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../../../packages/workbench-core/src/index.js";
import {
  analyzeWorkbenchSketch,
  buildLineRectangle,
  buildSketchEntity,
  detectSketchProfiles,
  explainNoProfiles,
  matchProfileRef,
  profileInBox,
  resolveProfileRegion,
  isLineRectangleTool,
  isShapeTool,
  profileOutlineMm,
  requiredSketchPoints,
  selectConnectedSketchEntities,
  selectTangentSketchEntities,
  sampleSplineToBound,
  sketchBounds,
  sketchChainBranchCount,
  sketchToolLabel,
  type SketchProfile,
  type SketchTool
} from "../../../../packages/workbench-sketch/src/index.js";
import { gridSteps, sketchToScreen } from "../../../../packages/workbench-sketch/src/camera.js";
import { buildFitSpline, tangentFromDegrees } from "../../../../packages/workbench-sketch/src/spline-fit.js";
import { advanceArcSweepTrack, arcSweepDirection, startArcSweepTrack, type ArcSweepTrack } from "../../../../packages/workbench-sketch/src/arc-sweep.js";
import { mergeTyped, typedIntentConstraints } from "../../../../packages/workbench-sketch/src/typed-intent.js";
import { dynamicFieldsFor, measureFromCursor, parseDynamicNumber, type DynamicFieldId, type DynamicValues } from "../../../../packages/workbench-sketch/src/dynamic-input.js";
import { fieldErrorsFor, plainEvaluator, resolveDynamicEntry, type EvaluateText } from "../../../../packages/workbench-sketch/src/dynamic-entry.js";
import { DEFAULT_SNAP_ASSIST, anchorFor, assistedInference, type SnapAssistSettings, type SnapModifiers } from "../../../../packages/workbench-sketch/src/snap-assist.js";
import { entitiesUnderPoint, nextInCycle, sameCandidates, type SelectOtherCandidate } from "../../../../packages/workbench-sketch/src/select-other.js";
import { firstClickPrompt, nextClickPrompt } from "../../../../packages/workbench-sketch/src/tool-prompts.js";
import { sketchCurvatureCombs } from "../../../../packages/workbench-sketch/src/curvature-comb.js";
import { constraintsOnEntities, extendAt, nearestEntityId, powerTrim, trimAt, type SketchEditPlan } from "../../../../packages/workbench-sketch/src/edit-tools.js";
import { cornerByClick } from "../../../../packages/workbench-sketch/src/corner-tools.js";
import { deleteCurveHeal, jogLine, splitAt } from "../../../../packages/workbench-sketch/src/split-jog.js";
import { mirrorImages, withDynamicMirror } from "../../../../packages/workbench-sketch/src/dynamic-mirror.js";
import { copySketchSelection, cutSketchSelection, nextPasteNumber, parseClipboard, pasteSketchClipboard, readSketchClipboard, serializeClipboard, storeSketchClipboard, type SketchClipboard } from "../../../../packages/workbench-sketch/src/sketch-clipboard.js";
import { keyLabelForCommand, sketchHotkeyHelp, type SketchCommandId, type SketchHotkeyAction } from "../../../../packages/workbench-sketch/src/hotkeys.js";
import { DRAW_CONSTRUCTION_OFF_MESSAGE, drawConstructionOnMessage, entityForDrawMode, planForDrawMode } from "../../../../packages/workbench-sketch/src/draw-construction.js";
import { findTextObject, planSketchText, planSketchTextEdit, textSpecFromFields } from "../../../../packages/workbench-sketch/src/sketch-text.js";
import type { DesignSketchFeature, SketchTextObject, WorkbenchResult } from "../../../../packages/workbench-core/src/index.js";
import { isSketchDatumEntityId, usesZUpPlane } from "../../../../packages/workbench-core/src/index.js";
import { SketchExportPanel, SketchImportPanel, SketchUnderlayPanel, type UnderlayPickState } from "./sketch/SketchExchangePanel.js";
import { SketchPatternPanel } from "./sketch/SketchPatternPanel.js";
import { useDimensionOffsets } from "./sketch/useDimensionOffsets.js";
import { MEASURE_CONTEXT, effectiveSolidResult, modalModeEnded, type ModalContext } from "../../../../packages/workbench-sketch/src/sketch-modes.js";
import { circleDimensionFacts, fixesBlockingDimension } from "../../../../packages/workbench-sketch/src/dimension-edit-model.js";
import { isEllipseRadiusConstraint, isPointDistanceConstraint } from "../../../../packages/workbench-sketch/src/point-distance-layout.js";
import { convertLengthField, parseLengthField } from "../../../../packages/workbench-sketch/src/edit-fields.js";
import { defaultLengthText, gridStepsForUnit, lengthTextFromDisplay, lengthTextToDisplay } from "../../../../packages/workbench-sketch/src/unit-defaults.js";
import { WORKING_PATH_SKETCH, chainFromCurve, describePath, pathCurvesOf, pathSketchChoices, pathSketchOf } from "../sweep-path-ui.js";
import { UnderlayLayer } from "./sketch/UnderlayLayer.js";
import { describeReferenceLayer, isReferenceId, sketchWithReference, type SketchReferenceLayer } from "../sketch-reference.js";
import { INFERENCE_LABELS, inferSketchPoint, type InferenceResult } from "../../../../packages/workbench-sketch/src/inference.js";
import { profileSnapRelations, shapeSnapRelations } from "../../../../packages/workbench-sketch/src/shape-snap-relations.js";
import { typedShapeIntent } from "../../../../packages/workbench-sketch/src/typed-shape-intent.js";
import { inferTypedPoint } from "../../../../packages/workbench-sketch/src/typed-inference.js";
import { autoConstraintsFor, bornConstraintsFor, dropConstraintFor, inheritedTangentDirection, tangentArcPoints, type PlacedPointInference } from "../../../../packages/workbench-sketch/src/auto-constraints.js";
import { dragSketchHandle, grabHandlesOf, type DragHandle, type SketchGrabHandle } from "../../../../packages/workbench-sketch/src/drag.js";
import { arrowHead, dimensionLayout } from "../../../../packages/workbench-sketch/src/dimension-layout.js";
import { POLYGON_DEFAULT_SIDES, POLYGON_MAX_SIDES, POLYGON_MIN_SIDES, POLYGON_MODES, buildSlot, buildSlotOverall, type SketchShape } from "../../../../packages/workbench-sketch/src/shapes.js";
import { ORIGIN_RELATION_POINT, relationPointsOf, type RelationPoint } from "../../../../packages/workbench-sketch/src/relation-points.js";
import { placePointDistance, resolveDimensionPair, type DimensionPairResult, type DimensionPick, type PairDimension, type PointPairPlacement } from "../../../../packages/workbench-sketch/src/dimension-pick.js";
import { dimensionOverConstraint } from "../../../../packages/workbench-sketch/src/dimension-overconstraint.js";
import { chainSelectionFor } from "../../../../packages/workbench-sketch/src/chain-select.js";
import { CONSTRAINT_TOOL_INFO, constraintToolStep, isConstraintToolKind, type ConstraintToolKind, type ConstraintToolPick } from "../../../../packages/workbench-sketch/src/constraint-tool.js";
import { POLYGON_MODE_LABELS, buildPolygonByMode, parsePolygonMode, polygonCentreRelations } from "../../../../packages/workbench-sketch/src/polygon-modes.js";
import { buildControlPointSpline, buildCurveTool, isFixedCurveTool } from "../../../../packages/workbench-sketch/src/curve-tools.js";
import { extendProfileChain, startProfileChain, type ProfileChain } from "../../../../packages/workbench-sketch/src/blend-profile.js";
import { DEFAULT_CURVE_OPTION_FIELDS, SketchCurveOptionsPanel, curveOptionsFromFields } from "./SketchCurveOptions.js";
import { createBlockLibrary, makeSketchBlock } from "../../../../packages/workbench-sketch/src/sketch-blocks.js";
import { entitiesInSelectionBox, selectionBoxMode, selectionRect, type SketchSelectionBoxMode } from "../../../../packages/workbench-sketch/src/selection.js";
import { DEFAULT_CORNER_PARAMS, DEFAULT_JOG_PARAMS, SKETCH_EDIT_TOOL_LABELS, SketchEditPanel, SketchRelationList, isClickEditTool, parseDecimal, type CornerParams, type JogParams, type SketchEditToolId, type StretchWindowRect } from "./SketchEditPanel.js";
import { SketchRepairPanel } from "./SketchRepairPanel.js";
import { ReachOptions } from "./ReachOptions.js";
import { DEFAULT_REACH, buildReach, isReachTarget, validReach, type ReachSettings } from "../reach-settings.js";
import { SketchGrid } from "./sketch/SketchGrid.js";
import { ConstraintExtras, ExtraDimensionMarks, type ConstraintExtrasBridge, type SetDimensionRequest } from "./sketch/ConstraintExtras.js";
import { angleDimensionLayout, type DimensionLayout } from "../../../../packages/workbench-sketch/src/dimension-layout.js";
import { angleBetweenLinesDeg, arcShape, entityLengthMm, measureDimensionConstraint } from "../../../../packages/workbench-core/src/sketch-measure.js";
import { useSketchCamera } from "./sketch/useSketchCamera.js";
import { useSketchHotkeys } from "./sketch/useSketchHotkeys.js";
import { ConstraintDisplayPanel, ConstraintGlyphLayer, ConstraintRecordList } from "./sketch/ConstraintGlyphs.js";
import { DimensionEditor } from "./sketch/DimensionEditor.js";
import { DimensionMarks } from "./sketch/DimensionMarks.js";
import { SplineHandles } from "./sketch/SplineHandles.js";
import { MeasureOverlay } from "./sketch/MeasureOverlay.js";
import { usePersistedState } from "./sketch/usePersistedState.js";
import { DEFAULT_CONSTRAINT_DISPLAY, constraintKindsPresent, constraintRows, constraintsToDraw, describeConstraint, entityOrdinalLabels, layoutConstraintGlyphs, parseConstraintDisplay, redundantConstraintIds, type ConstraintDisplaySettings } from "../../../../packages/workbench-sketch/src/constraint-glyph-layout.js";
import { DEFAULT_DIMENSION_DISPLAY, clampPrecision, dimensionEditText, dimensionNormal, dragDimensionOffset, formatLengthLabel, isRepositionable, parseDimensionDisplay, parseDimensionOffsets, sameDimensionValue, serializeDimensionOffsets, stackDimensionLabels, type DimensionDisplaySettings, type DimensionOffsets } from "../../../../packages/workbench-sketch/src/dimension-display.js";
import { EMPTY_LINE_CHAIN, extendLineChain, keepResolvableConstraints, lineChainSegments, profileChainStillValid, reconcileLineChain, startLineChain, type LineChainState } from "../../../../packages/workbench-sketch/src/line-chain.js";
import { constrainEachPlan, constructionSelectionPlan, deleteSelectionPlan, fixSelectionPlan, selectionIsFixed, sketchSelectionTotal, unfixSelectionPlan, visibilitySelectionPlan, type SelectionActionResult } from "../../../../packages/workbench-sketch/src/selection-actions.js";
import { insertSplineFitPoint, nearestPointOnSpline, removeSplineFitPoint } from "../../../../packages/workbench-sketch/src/spline-edit.js";
import { canvasHitSizes, describeEntityForAccessibility, focusAfter, resolveCanvasKey } from "../../../../packages/workbench-sketch/src/canvas-keyboard.js";
import { selectionExtents, zoomWindowExtents } from "../../../../packages/workbench-sketch/src/camera-zoom.js";
import { EMPTY_MEASURE, addMeasurePick, describeMeasurement, pickMeasureTarget, type MeasureState } from "../../../../packages/workbench-sketch/src/sketch-measure-tool.js";
import { MAX_SPLINE_FIT_POINTS } from "../../../../packages/workbench-core/src/spline-limits.js";
import { loadStoredSnapAssist, storeSnapAssist, useSketchKeymap } from "./sketch/useSketchKeymap.js";
import { useModifierKeys } from "./sketch/useModifierKeys.js";
import { SketchInputPalette } from "./sketch/SketchInputPalette.js";
import { SelectOtherPopup } from "./sketch/SelectOtherPopup.js";
import { ShortcutEditorDialog } from "./sketch/ShortcutEditorDialog.js";
import { sketchEntityNames } from "../../../../packages/workbench-core/src/sketch-names.js";
import { useSketchPref } from "./sketch/useSketchPref.js";
import type { DisplayUnit } from "../../../../packages/model-schema/src/index.js";
import { formatLength, formatLengthWithUnit, setDimensionLabelUnit, unitWord, type SketchLengthUnit } from "../../../../packages/workbench-sketch/src/sketch-units.js";
import { conventionOf, describeSketchPlane, sketchAxesInWorld } from "../sketch-plane-ui.js";
import { DEFAULT_PALETTE_LAYOUT } from "./sketch/sketch-prefs.js";
import {
  type NavigationMode,
  type SelectionFilter,
  type ViewOrientation,
  type ViewportViewState,
  type ViewProjection
} from "../../../../packages/viewport-three/src/index.js";
import { unhalvedExpression } from "../dimension-expression.js";
import { SketchUnitContext, sketchLength, useSketchUnit } from "./sketch-unit.js";
import { describeSketchAxes } from "../sketch-world.js";
import { SectionPropertiesPanel } from "./SectionPropertiesPanel.js";
import type { LengthUnit, RevolveAxisRef } from "../../../../packages/workbench-core/src/index.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";
import { CommandIcon } from "../ui/CommandIcon.js";
import { ViewportChrome } from "../ui/ViewportChrome.js";
import { PointDistanceField } from "./sketch/SolverRelations.js";
import { DimensionField, EntityDimensions } from "./sketch/EntityDimensionFields.js";
import { CentreMarker, snapPickedCentre, useCentrePickState } from "./sketch/CentrePick.js";
import { TrimHighlight } from "./sketch/TrimHighlight.js";
import { sameTrimPreview, trimHoverPreview, type TrimPreview } from "../../../../packages/workbench-sketch/src/trim-preview.js";
import { ORIGIN_DIMENSION_POINT as ORIGIN_POINT, allDimensionPoints, dimensionHandles, defaultDimensionPoints, resolveDirectSketchDimension, solverPointRef, type DirectSketchDimension, type SketchDimensionPoint } from "./sketch/dimension-points.js";
import { applyOf, circleDiameterApply, type DimensionApply } from "./sketch/dimension-requests.js";
import { dimensionAllowsZero, readDimensionText } from "../../../../packages/workbench-sketch/src/dimension-text.js";

type DrivingDimension = "length" | "width" | "height" | "radius" | "angle" | "arc-length" | "perimeter";
type PlaneKey = "xy" | "xz" | "yz";

/** The inline dimension editor: which dimension it edits, where it opens, and the stored value it started from. */
interface DimensionEditState {
  readonly entityId: string;
  readonly dimension: DrivingDimension;
  readonly anchor: Vec2;
  readonly label: string;
  readonly secondEntityId?: string;
  /** The value the editor started from, in millimetres (degrees for an angle; a circle's diameter), so Enter without typing changes nothing. */
  readonly storedValue: number | undefined;
  /** True when the dimension was already a reference one when the editor opened. */
  readonly wasReference: boolean;
  /** A circle whose stored dimension is a Diameter: the stored value is the diameter itself, so it is written back as one. */
  readonly diameterConstraint?: boolean;
  /** A dimension with its own solver name: a distance between points, to a line or between lines, or an ellipse's major or minor radius. */
  readonly named?: { readonly dimension: SketchDimensionName; readonly points?: readonly SketchPointRef[] };
  /** The expression the dimension was bound to when the editor opened (shown as the text), so Enter on it changes nothing. */
  readonly boundExpression?: string;
}

/** How each datum plane maps the sketch's horizontal and vertical directions onto the world axes (see general-modeling.ts placeOnPlane). */
const PLANE_INFO: Readonly<Record<PlaneKey, { readonly name: string; readonly horizontal: "x" | "y" | "z"; readonly vertical: "y" | "z"; readonly horizontalLabel: string; readonly verticalLabel: string }>> = {
  xy: { name: "Top (XY)", horizontal: "x", vertical: "y", horizontalLabel: "X", verticalLabel: "Y" },
  xz: { name: "Front (XZ)", horizontal: "x", vertical: "z", horizontalLabel: "X", verticalLabel: "Z" },
  yz: { name: "Right (YZ)", horizontal: "z", vertical: "y", horizontalLabel: "−Z", verticalLabel: "Y" }
};

/** The Right (YZ) plane of a Z-up sketch: horizontal along world +Y, vertical along +Z (plane-convention.ts). Older sketches keep PLANE_INFO.yz. */
const PLANE_INFO_YZ_ZUP: (typeof PLANE_INFO)["yz"] = { name: "Right (YZ)", horizontal: "y", vertical: "z", horizontalLabel: "Y", verticalLabel: "Z" };

/** The relations that are picked point by point on the canvas, offered in the inspector. */
const POINT_RELATION_TOOLS: readonly { readonly tool: ConstraintToolKind; readonly label: string; readonly title: string }[] = [
  { tool: "coincident", label: "Coincident", title: "Join two points, or put a point on a curve: pick one, then the point that should move onto it." },
  { tool: "midpoint", label: "Midpoint", title: "Put a point at the middle of a line: pick the point, then the line." },
  { tool: "horizontal", label: "Level points", title: "Horizontal between two points: pick the point that stays, then the point to put level with it. A click on a line makes the line level." },
  { tool: "vertical", label: "Stack points", title: "Vertical between two points: pick the point that stays, then the point to put straight above or below it. A click on a line makes the line upright." }
];

function planeKeyOf(plane: SketchDatumPlane): PlaneKey {
  return plane === "datum:xz" ? "xz" : plane === "datum:yz" ? "yz" : "xy";
}

/** Reach, in screen pixels, of snapping, picking and "click the last point again to finish". */
const SNAP_PIXELS = 9;
const PICK_PIXELS = 10;

interface SketchWorkspaceProps {
  /** The unit lengths are shown and typed in; the sketch itself is always in millimetres. Absent means millimetres. */
  readonly displayUnit?: LengthUnit;
  readonly projectId: string;
  readonly sketch: WorkbenchSketch;
  readonly tool: SketchTool;
  readonly dimensionMode: boolean;
  readonly cancelVersion: number;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onAddEntity: (entity: SketchEntity) => void;
  readonly onDeleteEntity: (id: string) => void;
  readonly onAddConstraint: (constraint: WorkbenchSketchConstraint) => void;
  readonly onDeleteConstraint: (id: string) => void;
  /** With `extra.expression`, the dimension is bound to it (`plate_w / 2`) and `valueMm` is only a placeholder the project replaces. */
  readonly onSetDimension: SetDimensionRequest;
  /** The project-side hooks the Pierce section needs (crossings, and keeping Pierce points on them). */
  readonly constraintExtras: ConstraintExtrasBridge;
  readonly onToggleConstruction: (entityId: string) => void;
  readonly onToggleVisibility: (entityId: string) => void;
  readonly viewportState: ViewportViewState;
  readonly onNavigationMode: (mode: NavigationMode) => void;
  readonly onSelectionFilter: (filter: SelectionFilter) => void;
  readonly onOrientation: (orientation: Exclude<ViewOrientation, "custom">) => void;
  readonly onViewAngles: (azimuthDeg: number, elevationDeg: number) => void;
  readonly onProjection: (projection: ViewProjection) => void;
  readonly onGrid: (visible: boolean) => void;
  readonly onAxes: (visible: boolean) => void;
  /** Increases whenever the app asks the sketch to fit (menu, ribbon or palette Fit). */
  readonly fitSerial: number;
  readonly onContextMenu: (clientX: number, clientY: number, selectionId: string | null) => void;
  readonly onMessage: (message: string) => void;
  readonly optionsRevealRequest: number;
  /** The finished sketches of the timeline: a sweep path may come from one of them (another plane). */
  readonly finishedSketches?: readonly DesignSketchFeature[];
  /** The model behind the sketch: edges of the visible solids and curves of the other sketches, in this sketch's coordinates. Shown dimmed, snapped to, never stored. */
  readonly reference?: SketchReferenceLayer;
  /** The timeline id of the sketch being edited, when it was opened from the timeline (it is then not offered as a separate path sketch). */
  readonly workingTimelineId?: string | null;
  readonly onCreateSolid: (
    profileIds: readonly string[],
    plane: PlaneKey,
    operation: "extrude" | "revolve" | "sweep" | "loft" | "edge-fillet" | "edge-chamfer" | "shell" | "draft" | "helix" | "thread" | "rib" | "dome" | "sheet-base" | "sheet-flange" | "sheet-hem",
    valueMm: number,
    edge?: { readonly kind: "chamfer" | "fillet"; readonly sizeMm: number },
    direction?: "one-side" | "symmetric" | "flipped" | "two-side",
    target?: { readonly mode: "join" | "cut"; readonly bodyId: string; readonly extent?: "through-all" },
    advancedParams?: {
      readonly revolveAxis?: RevolveAxisRef;
      readonly secondValueMm?: number;
      readonly extent?: "to-face" | "to-body" | "to-vertex" | "to-first" | "to-last";
      readonly extentTarget?: DesignExtentTarget;
      readonly thinWallMm?: number;
      readonly thinSide?: "inside" | "outside" | "center";
      readonly sweepDirectionMm?: readonly [number, number, number];
      readonly sweepPathEntityId?: string;
      /** A chained path: the sketch it comes from (WORKING_PATH_SKETCH for the one being drawn) and its curves. */
      readonly sweepPathSource?: { readonly sketchId: string; readonly entityIds: readonly string[] };
      readonly sweepTwistDeg?: number;
      readonly sweepFrameTransport?: boolean;
      readonly loftTopScale?: number;
      readonly loftSecondaryProfileIds?: readonly string[];
      readonly loftContinuity?: "position" | "tangent" | "curvature";
      readonly loftRailEntityId?: string;
      readonly loftTangencyWeight?: number;
      readonly shellThicknessMm?: number;
      readonly shellOpenFace?: "top" | "bottom" | "none";
      readonly draftAngleDeg?: number;
      readonly draftNeutralFace?: "top" | "bottom";
      readonly helixRadiusMm?: number;
      readonly helixPitchMm?: number;
      readonly helixTurns?: number;
      readonly helixHandedness?: "right" | "left";
      readonly threadPitchMm?: number;
      readonly threadTurns?: number;
      readonly threadDepthMm?: number;
      readonly threadHandedness?: "right" | "left";
      readonly ribThicknessMm?: number;
      readonly ribDirection?: "symmetric" | "one-side";
      readonly domeHeightMm?: number;
      readonly sheetThicknessMm?: number;
      readonly sheetBendRadiusMm?: number;
      readonly flangeLengthMm?: number;
      readonly flangeAngleDeg?: number;
      readonly hemStyle?: "closed" | "open";
    }
  ) => void;
  /** The solids a join or cut can modify. */
  readonly solidBodies: readonly { readonly id: string; readonly name: string }[];
  /** The same solids with their shapes, for the faces and vertices a "to" extent can reach. */
  readonly targetBodies: readonly GeneralSolidBody[];
  readonly onChangePlane: () => void;
  /** Changes the document's display unit (the Units choice in the palette); `displayUnit` above says what it is now. */
  readonly onDisplayUnit: (unit: DisplayUnit) => void;
  readonly editTool: SketchEditToolId | null;
  readonly showMovable: boolean;
  readonly checkOpen: boolean;
  /** A one-shot ribbon command (Fix Curve, Relax Relations or Relax Dimensions); a new serial triggers it once. */
  readonly request: { readonly command: "fix-curve" | "relax-relations" | "relax-dimensions" | `constraint:${ConstraintToolKind}`; readonly serial: number } | null;
  /** The Project key (P): project the edges of a body onto the sketch plane, as the ribbon's Project button does. */
  readonly onProjectBody?: () => void;
  /** Told which constraint tool is active (or none), so the ribbon can show it pressed. */
  readonly onConstraintToolChange?: (tool: ConstraintToolKind | null) => void;
  readonly onApplyEdit: (plan: SketchEditPlan) => boolean | void;
  readonly onSetSuppressed: (constraintIds: readonly string[], suppressed: boolean) => boolean | void;
  readonly onCloseEditTool: () => void;
  readonly onCloseCheck: () => void;
  readonly onActivateTool: (tool: SketchTool) => void;
  readonly onActivateDimension: () => void;
  readonly onExitDimension: () => void;
  readonly onActivateEditTool: (tool: SketchEditToolId) => void;
  /** OK click in the viewport Confirmation Corner: commit the sketch to the timeline and return to Design. */
  readonly onFinishSketch: () => void;
  /** Cancel click in the viewport Confirmation Corner: discard this session's sketch edits and leave the sketch workspace. */
  readonly onCancelSketch: () => void;
  /** Evaluates typed text (units, expressions, parameter names) for the dynamic input; without it only numbers, units and functions work. */
  readonly evaluateText?: EvaluateText;
  /** Reports how many curves, profiles and relations are selected on the canvas, for the status bar. */
  readonly onSelectionCount?: (count: number) => void;
}

/** A press on a curve or one of its handles that may turn into a drag. */
interface DragGesture {
  readonly pointerId: number;
  readonly entityId: string;
  readonly handle: DragHandle;
  readonly startClient: readonly [number, number];
  readonly startMm: Vec2;
  /** The sketch as it was when the press began; every drag step is computed from it. */
  readonly base: WorkbenchSketch;
  moved: boolean;
}

interface DragPreview {
  readonly entities: readonly SketchEntity[];
  readonly movedIds: readonly string[];
}

interface BoxGesture {
  readonly pointerId: number;
  readonly startClient: readonly [number, number];
  readonly startMm: Vec2;
  readonly additive: boolean;
  /** The shaded profile under the pointer when the press began: it is selected on release, but only if the press did not turn into a box drag. */
  readonly profileId: string | undefined;
  dragging: boolean;
}

const NO_FINISHED_SKETCHES: readonly DesignSketchFeature[] = [];

export function SketchWorkspace(props: SketchWorkspaceProps): React.JSX.Element {
  const [pending, setPending] = useState<readonly Vec2[]>([]);
  const [cursor, setCursor] = useState<Vec2>([0, 0]);
  const [inference, setInference] = useState<InferenceResult | undefined>(undefined);
  // Relations drawn with a shape (Coincident at snapped ends, Horizontal on a level guide...) and the snap each placed point had.
  const [autoConstrain, setAutoConstrain] = useSketchPref("autoConstrain", true);
  const [drawAsConstruction, setDrawAsConstruction] = useState(false);
  // Placed text being re-edited (double-click a text curve), and the two points picked to calibrate the picture underlay.
  const [textEditId, setTextEditId] = useState<string | null>(null);
  const [underlayPick, setUnderlayPick] = useState<UnderlayPickState>({ active: false, points: [] });
  const [pendingInference, setPendingInference] = useState<readonly PlacedPointInference[]>([]);
  // A constraint tool: the relation is chosen first, then its points and curves are picked on the canvas. It stays on until Esc.
  const [pickRelation, setPickRelation] = useState<ConstraintToolKind | null>(null);
  // Rotate, Scale and a circular Pattern: the centre can be clicked on the canvas (the panels hold the fields, this holds the pick).
  const centrePick = useCentrePickState(String(props.editTool));
  // Trim: what a click on the curve under the pointer would remove, drawn as a highlight (see trim-preview.ts).
  const [trimHover, setTrimHover] = useState<TrimPreview | undefined>(undefined);
  const lastTrimPick = useRef<Vec2 | undefined>(undefined);
  useEffect(() => { if (props.editTool !== "trim") { setTrimHover(undefined); lastTrimPick.current = undefined; } }, [props.editTool]);
  useEffect(() => { lastTrimPick.current = undefined; }, [props.sketch]);
  useEffect(() => { if (centrePick.picking) props.onMessage("Click the centre on the canvas; it snaps to endpoints, centres and the origin (hold Ctrl to place it freely). Esc cancels."); }, [centrePick.picking]); // eslint-disable-line react-hooks/exhaustive-deps
  const [toolPicks, setToolPicks] = useState<readonly ConstraintToolPick[]>([]);
  useEffect(() => { props.onConstraintToolChange?.(pickRelation); }, [pickRelation]); // eslint-disable-line react-hooks/exhaustive-deps
  // The in-place value editor for a driving dimension (opened from Sketch Dimension, or by clicking a dimension's text).
  const [dimensionEdit, setDimensionEdit] = useState<DimensionEditState | undefined>(undefined);
  const [dimensionText, setDimensionText] = useState("");
  const [polygonSides, setPolygonSides] = useSketchPref("polygonSides", String(POLYGON_DEFAULT_SIDES));
  const [polygonModeText, setPolygonMode] = useSketchPref("polygonMode", "inscribed");
  const polygonMode = parsePolygonMode(polygonModeText);
  // The editor's Reference checkbox: a reference dimension is measured and never moves the geometry.
  const [dimensionReference, setDimensionReference] = useState(false);
  // The extra curve tools (rounded rectangle, conics, blend, profile, text ...): their palette numbers, and the Profile chain being drawn.
  const [curveFields, setCurveFields] = useSketchPref("curveFields", DEFAULT_CURVE_OPTION_FIELDS);
  const profileChain = useRef<ProfileChain | undefined>(undefined);
  const profileStartSnap = useRef<PlacedPointInference | undefined>(undefined);
  // Reusable sketch blocks live in the browser (not in the project file); a blocked or missing localStorage just keeps them in memory.
  const [blockLibrary] = useState(() => createBlockLibrary((() => { try { return window.localStorage; } catch { return undefined; } })()));
  const [blockNames, setBlockNames] = useState<readonly string[]>(() => blockLibrary.list().map((block) => block.name));
  // Typed input: fields the user has typed into are locked; the others keep following the pointer.
  const [fieldText, setFieldText] = useState<Partial<Record<DynamicFieldId, string>>>({});
  const [dynamicFocused, setDynamicFocused] = useState(false);
  const [frozenAt, setFrozenAt] = useState<Vec2 | undefined>(undefined);
  const [focusRequest, setFocusRequest] = useState<{ readonly id: DynamicFieldId; readonly serial: number } | undefined>(undefined);
  const fieldRefs = useRef<Partial<Record<DynamicFieldId, HTMLInputElement | null>>>({});
  const focusSerial = useRef(0);
  // The first point of the line chain being drawn and how many segments it has, so a line that ends where it began closes the loop.
  const lineChain = useRef<LineChainState>(EMPTY_LINE_CHAIN);
  // Relations picked on the canvas (glyphs and dimension labels), and the one under the pointer.
  const [selectedConstraintIds, setSelectedConstraintIds] = useState<readonly string[]>([]);
  const [hoverConstraintId, setHoverConstraintId] = useState<string | null>(null);
  // How relations and dimensions are shown. These are per-viewer display choices, remembered in this browser.
  const [constraintDisplay, setConstraintDisplay] = usePersistedState<ConstraintDisplaySettings>("ps3d.sketch.constraintDisplay", DEFAULT_CONSTRAINT_DISPLAY, parseConstraintDisplay, JSON.stringify);
  const [storedDimensionDisplay, setDimensionDisplay] = usePersistedState<DimensionDisplaySettings>("ps3d.sketch.dimensionDisplay", DEFAULT_DIMENSION_DISPLAY, parseDimensionDisplay, JSON.stringify);
  // The unit is the document's (the Units choice in the palette), so every dimension label and editor agrees; the decimals and the "show unit" choice are per-browser display settings.
  const dimensionDisplay: DimensionDisplaySettings = { ...storedDimensionDisplay, unit: props.displayUnit ?? "mm" };
  // Where dimension labels were dragged to: per project and sketch, and forgotten for dimensions that are gone.
  const liveConstraintIds = useMemo(() => new Set(props.sketch.constraints.map((constraint) => constraint.id)), [props.sketch.constraints]);
  const [dimensionOffsets, setDimensionOffsets] = useDimensionOffsets(props.projectId, props.sketch.id, liveConstraintIds);
  const dimensionDrag = useRef<{ readonly pointerId: number; readonly constraintId: string; readonly startMm: Vec2; readonly startClient: readonly [number, number]; readonly startOffsetPx: number; readonly layoutAt: (offsetPx: number) => DimensionLayout | undefined; moved: boolean } | undefined>(undefined);
  const [dimensionDragOffset, setDimensionDragOffset] = useState<{ readonly constraintId: string; readonly offsetPx: number } | undefined>(undefined);
  // Keyboard access to the canvas, spline fit-point work, zoom window and the Measure tool.
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [activeFit, setActiveFit] = useState<{ readonly entityId: string; readonly index: number } | undefined>(undefined);
  const [zoomWindowMode, setZoomWindowMode] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
  const [measureState, setMeasureState] = useState<MeasureState>(EMPTY_MEASURE);
  // The tool, edit tool and dimension mode that were active when Zoom window or Measure began. Zoom window and Measure take the canvas clicks, so
  // changing any of them ends the mode instead of leaving a banner up that swallows the next click.
  const modalContext = useRef<ModalContext | undefined>(undefined);
  useEffect(() => {
    const started = modalContext.current;
    if (!zoomWindowMode && !measureMode) return;
    if (!modalModeEnded(started, { tool: props.tool, editTool: props.editTool, dimensionMode: props.dimensionMode })) return;
    modalContext.current = undefined;
    setZoomWindowMode(false);
    setMeasureMode(false);
    setMeasureState(EMPTY_MEASURE);
    setSelectionBox(undefined);
  }, [props.tool, props.editTool, props.dimensionMode, zoomWindowMode, measureMode]);
  const [coarsePointer] = useState(() => { try { return window.matchMedia("(pointer: coarse)").matches; } catch { return false; } });
  const hitSizes = canvasHitSizes(coarsePointer);
  /** Centerpoint arc: how far the pointer has travelled round the centre since the start click, which fixes the arc's direction (it may pass 180 degrees). */
  const arcTrack = useRef<ArcSweepTrack | undefined>(undefined);
  /** Dynamic-input fields typed so far in the shape being drawn, so the finished shape can keep them as dimensions and relations. */
  const typedTrail = useRef<DynamicValues>({});
  const arcBuildOptions = (): { readonly sweepDirection?: 1 | -1 } => {
    const direction = props.tool === "arc-center" ? arcSweepDirection(arcTrack.current) : undefined;
    return direction === undefined ? {} : { sweepDirection: direction };
  };
  const [pointerInside, setPointerInside] = useState(false);
  const [selectionIds, setSelectionIds] = useState<readonly string[]>(props.selectedId === null ? [] : [props.selectedId]);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [selectionBox, setSelectionBox] = useState<{ readonly start: Vec2; readonly end: Vec2 } | undefined>(undefined);
  /** The Stretch tool's window: drawn by dragging on empty canvas, or typed in the tool's panel; both show the same rectangle. */
  const [stretchWindow, setStretchWindowState] = useState<StretchWindowRect | undefined>(undefined);
  const setStretchWindow = useCallback((next: StretchWindowRect | undefined): void => {
    setStretchWindowState((current) => (current !== undefined && next !== undefined && current.x1 === next.x1 && current.y1 === next.y1 && current.x2 === next.x2 && current.y2 === next.y2) || (current === undefined && next === undefined) ? current : next);
  }, []);
  /** Jog values typed in the Jog panel, read when a line is clicked. */
  const [jogParams, setJogParams] = useSketchPref<JogParams>("jogParams", { offset: defaultLengthText(Number(DEFAULT_JOG_PARAMS.offset), props.displayUnit ?? "mm"), width: defaultLengthText(Number(DEFAULT_JOG_PARAMS.width), props.displayUnit ?? "mm") });
  /** Fillet and chamfer values typed in their panel, read when a vertex is clicked. */
  const [cornerParams, setCornerParams] = useState<CornerParams>(() => ({ radius: defaultLengthText(Number(DEFAULT_CORNER_PARAMS.radius), props.displayUnit ?? "mm"), bevel: defaultLengthText(Number(DEFAULT_CORNER_PARAMS.bevel), props.displayUnit ?? "mm") }));
  /** The ghost of what the open edit tool would do for the values typed now. */
  const [editPreview, setEditPreview] = useState<readonly SketchEntity[]>([]);
  /** Power Trim: the path a press-and-drag has swept so far while the Trim tool is active. */
  const trimSweep = useRef<{ readonly pointerId: number; readonly startClient: readonly [number, number]; readonly path: Vec2[] } | undefined>(undefined);
  /** Dynamic Mirror: the line new curves are mirrored about, or null when off. It outlives the edit panel so drawing tools can use it. */
  const [dynamicMirrorAxis, setDynamicMirrorAxis] = useSketchPref<string | null>("dynamicMirrorAxis", null, { durable: false });
  const [dimensionPoints, setDimensionPoints] = useState<readonly SketchDimensionPoint[]>([]);
  // Sketch Dimension with two picks: the first thing picked, and two picked points waiting for the click that places their dimension.
  const [dimensionFirst, setDimensionFirst] = useState<DimensionPick | undefined>(undefined);
  const [dimensionPlacement, setDimensionPlacement] = useState<PointPairPlacement | undefined>(undefined);
  // Snapping aids (snap on/off, snap step, polar tracking, ortho) live in the browser; Ctrl and Shift held on the keyboard override them while down.
  const [assist, setAssist] = useState<SnapAssistSettings>(() => { try { return loadStoredSnapAssist(); } catch { return DEFAULT_SNAP_ASSIST; } });
  const updateAssist = (patch: Partial<SnapAssistSettings>): void => { const next = { ...assist, ...patch }; setAssist(next); storeSnapAssist(next); };
  const snapEnabled = assist.snap;
  const setSnapEnabled = (snap: boolean): void => updateAssist({ snap });
  const sketchKeymap = useSketchKeymap();
  /** " (Q)" for a command that has a key now, "" when it has none: tooltips follow the shortcut editor instead of advertising the default key. */
  const keyHint = (id: SketchCommandId): string => {
    const key = keyLabelForCommand(id, sketchKeymap);
    return key === undefined ? "" : ` (${key})`;
  };
  const heldKeys = useModifierKeys(props.tool !== "select");
  const [shortcutEditorOpen, setShortcutEditorOpen] = useState(false);
  // Typed-input problems found when Enter was pressed (the unreadable-text errors are derived live from what is typed).
  const [commitErrors, setCommitErrors] = useState<Partial<Record<DynamicFieldId, string>>>({});
  const typedNotes = useRef<readonly string[]>([]);
  const lastRaw = useRef<Vec2 | undefined>(undefined);
  const lastPlaced = useRef<Vec2 | undefined>(undefined);
  // Select Other: the curves under the pointer while Select is active, and the list popup opened by Alt-click or Tab.
  const [hoverStack, setHoverStack] = useState<readonly SelectOtherCandidate[]>([]);
  const [selectOther, setSelectOther] = useState<{ readonly candidates: readonly SelectOtherCandidate[]; readonly at: readonly [number, number] } | undefined>(undefined);
  const [solidOp, setSolidOp] = useSketchPref<"extrude" | "revolve" | "sweep" | "loft" | "edge-fillet" | "edge-chamfer" | "shell" | "draft" | "helix" | "thread" | "rib" | "dome" | "sheet-base" | "sheet-flange" | "sheet-hem">("solidOp", "extrude");
  const [solidValue, setSolidValue] = useSketchPref("solidValue", "10");
  const [sweepDx, setSweepDx] = useSketchPref("sweepDx", "0");
  const [sweepDy, setSweepDy] = useSketchPref("sweepDy", "0");
  const [sweepDz, setSweepDz] = useSketchPref("sweepDz", "1");
  const [sweepMode, setSweepMode] = useSketchPref<"direction" | "path">("sweepMode", "direction");
  const [sweepPathSketch, setSweepPathSketch] = useSketchPref<string>("sweepPathSketch", WORKING_PATH_SKETCH, { durable: false });
  const [sweepPathIds, setSweepPathIds] = useSketchPref<readonly string[]>("sweepPathIds", [], { durable: false });
  const [loftTopScale, setLoftTopScale] = useSketchPref("loftTopScale", "0.7");
  const [loftMode, setLoftMode] = useSketchPref<"scaled" | "two-profile">("loftMode", "scaled");
  const [loftContinuity, setLoftContinuity] = useSketchPref<"position" | "tangent" | "curvature">("loftContinuity", "position");
  const [loftRailEntityId, setLoftRailEntityId] = useSketchPref<string>("loftRailEntityId", "", { durable: false });
  const [loftTangencyWeight, setLoftTangencyWeight] = useSketchPref("loftTangencyWeight", "1");
  const [sweepTwist, setSweepTwist] = useSketchPref("sweepTwist", "0");
  const [sweepFrameTransport, setSweepFrameTransport] = useSketchPref("sweepFrameTransport", false);
  const [helixRadius, setHelixRadius] = useSketchPref("helixRadius", "20");
  const [helixPitch, setHelixPitch] = useSketchPref("helixPitch", "5");
  const [helixTurns, setHelixTurns] = useSketchPref("helixTurns", "4");
  const [helixHandedness, setHelixHandedness] = useSketchPref<"right" | "left">("helixHandedness", "right");
  const [threadPitch, setThreadPitch] = useSketchPref("threadPitch", "2");
  const [threadTurns, setThreadTurns] = useSketchPref("threadTurns", "8");
  const [threadDepth, setThreadDepth] = useSketchPref("threadDepth", "10");
  const [threadHandedness, setThreadHandedness] = useSketchPref<"right" | "left">("threadHandedness", "right");
  const [ribThickness, setRibThickness] = useSketchPref("ribThickness", "2");
  const [domeHeight, setDomeHeight] = useSketchPref("domeHeight", "8");
  const [sheetThickness, setSheetThickness] = useSketchPref("sheetThickness", "2");
  const [sheetBendRadius, setSheetBendRadius] = useSketchPref("sheetBendRadius", "2");
  const [flangeLength, setFlangeLength] = useSketchPref("flangeLength", "20");
  const [flangeAngle, setFlangeAngle] = useSketchPref("flangeAngle", "90");
  const [hemStyle, setHemStyle] = useSketchPref<"closed" | "open">("hemStyle", "closed");
  const [modifierEdgeSize, setModifierEdgeSize] = useSketchPref("modifierEdgeSize", "1");
  const [shellThickness, setShellThickness] = useSketchPref("shellThickness", "2");
  const [shellOpenFace, setShellOpenFace] = useSketchPref<"top" | "bottom" | "none">("shellOpenFace", "top");
  const [draftAngle, setDraftAngle] = useSketchPref("draftAngle", "5");
  const [draftNeutralFace, setDraftNeutralFace] = useSketchPref<"top" | "bottom">("draftNeutralFace", "bottom");
  const [storedReach, setReach] = useSketchPref<ReachSettings>("reach", DEFAULT_REACH);
  // Join and Cut only mean something with a solid to change, for an extrude or revolve. The choice is remembered for the session and project only (a Cut
  // remembered across projects left Create solid disabled in a new project with nothing to cut from) and reads as New body whenever it cannot apply.
  const [storedResult, setSolidResult] = useSketchPref<"new-body" | "join" | "cut">(`solidResult:${props.projectId}`, "new-body", { durable: false });
  const solidResult = effectiveSolidResult(storedResult, props.solidBodies.length, solidOp);
  // A remembered "to" extent reads as a distance in a project with no solid to reach (the height field stays usable).
  const reach = solidOp === "extrude" || solidOp === "revolve" ? validReach(storedReach, solidOp, props.targetBodies.length, solidResult === "cut" && props.solidBodies.length > 0) : storedReach;
  const resultProject = useRef(props.projectId);
  useEffect(() => {
    if (resultProject.current !== props.projectId) { resultProject.current = props.projectId; setSolidResult("new-body"); }
  }, [props.projectId]);
  useEffect(() => {
    if (storedResult !== "new-body" && solidResult === "new-body") setSolidResult("new-body");
  }, [storedResult, solidResult]);
  const [solidTarget, setSolidTarget] = useSketchPref("solidTarget", "", { durable: false });
  // A join or cut acts on the picked solid, else the selected one, else the newest.
  const effectiveTarget = props.solidBodies.some((body) => body.id === solidTarget) ? solidTarget
    : props.solidBodies.some((body) => body.id === props.selectedId) ? props.selectedId ?? ""
      : props.solidBodies.at(-1)?.id ?? "";
  const modifying = solidResult !== "new-body" && props.solidBodies.length > 0 && effectiveTarget !== "";
  // Through all applies to an extruded cut: the cutter is stretched across the solid when the timeline rebuilds.
  const cutThroughAll = modifying && solidResult === "cut" && solidOp === "extrude" && reach.extent === "through-all";
  // A "to" extent measures its own distance or angle from the target, so the typed value is not used.
  const reachesTarget = (solidOp === "extrude" || solidOp === "revolve") && isReachTarget(reach.extent) && !cutThroughAll;
  const [edgeKind, setEdgeKind] = useSketchPref<"none" | "chamfer" | "fillet">("edgeKind", "none");
  const [edgeSize, setEdgeSize] = useSketchPref("edgeSize", "2");
  const [showProfiles, setShowProfiles] = useSketchPref("showProfiles", true);
  // The model and the other sketches behind this one (see sketch-reference.ts): shown dimmed and used as snap targets only.
  const [showReference, setShowReference] = useSketchPref("showReference", true);
  const referenceShown = showReference && props.reference !== undefined && props.reference.entities.length > 0;
  const snapSketch = useMemo(() => sketchWithReference(props.sketch, props.reference, showReference), [props.sketch, props.reference, showReference]);
  const [showDimensions, setShowDimensions] = useSketchPref("showDimensions", true);
  const [showConstraints, setShowConstraints] = useSketchPref("showConstraints", true);
  const [showComb, setShowComb] = useSketchPref("showComb", false);
  const [combScale, setCombScale] = useSketchPref("combScale", 1);
  // The palette is docked beside the canvas by default (it no longer covers drawing area); it can float or fold up, and the choice is remembered.
  const [paletteLayout, setPaletteLayout] = useSketchPref("paletteLayout", DEFAULT_PALETTE_LAYOUT);
  const planeDescription = describeSketchPlane(props.sketch);
  const unit: SketchLengthUnit = props.displayUnit ?? "mm";
  lengthUnit = unit;
  setDimensionLabelUnit(unit);
  /** A millimetre value as the text the dimension editor starts with, in the display unit. */
  const lengthText = (valueMm: number): string => formatLength(valueMm, unit);
  // The Jog and Fillet / Chamfer values are typed text in the display unit and read by the canvas: switching the document unit converts them,
  // so "3" typed in millimetres does not silently become 3 inches.
  const previousUnit = useRef<SketchLengthUnit>(unit);
  useEffect(() => {
    const before = previousUnit.current;
    if (before === unit) return;
    previousUnit.current = unit;
    // A value still at the starting default moves to the starting default of the new unit (2 mm to 1/16 in); anything typed is converted as it is.
    const moved = (current: string, defaultMm: string): string => (parseLengthField(current, before) === Number(defaultMm) ? defaultLengthText(Number(defaultMm), unit) : convertLengthField(current, before, unit));
    setJogParams((current) => ({ offset: moved(current.offset, DEFAULT_JOG_PARAMS.offset), width: moved(current.width, DEFAULT_JOG_PARAMS.width) }));
    setCornerParams((current) => ({ radius: moved(current.radius, DEFAULT_CORNER_PARAMS.radius), bevel: moved(current.bevel, DEFAULT_CORNER_PARAMS.bevel) }));
  }, [unit]);
  const [selectedProfileIds, setSelectedProfileIds] = useState<readonly string[]>([]);
  // What a revolve turns about: "" is the sketch Y axis, "x" the sketch X axis, otherwise the ID of a line of this sketch (a centerline or construction line).
  const [revolveAxisChoice, setRevolveAxisChoice] = useState("");
  const boxGesture = useRef<BoxGesture | undefined>(undefined);
  // Direct manipulation: the gesture, and the live (uncommitted) result shown while it runs.
  const dragGesture = useRef<DragGesture | undefined>(undefined);
  const dragLatest = useRef<{ readonly preview: DragPreview; readonly snap: InferenceResult | undefined } | undefined>(undefined);
  const dragMessage = useRef("");
  const [dragLive, setDragLive] = useState<DragPreview | undefined>(undefined);
  const paletteRef = useRef<HTMLDivElement>(null);
  // Seed with the current request so a fresh mount (this panel remounts on every workspace switch)
  // is a no-op; only an actual increment while mounted — i.e. a real Options click — reveals the palette.
  const handledOptionsRevealRef = useRef(props.optionsRevealRequest);
  useEffect(() => {
    if (props.optionsRevealRequest === handledOptionsRevealRef.current) return undefined;
    handledOptionsRevealRef.current = props.optionsRevealRequest;
    if (props.optionsRevealRequest === 0) return undefined;
    setPaletteLayout((current) => (current.collapsed ? { ...current, collapsed: false } : current));
    const palette = paletteRef.current;
    if (palette === null) return undefined;
    palette.scrollIntoView({ behavior: "smooth", block: "nearest" });
    palette.classList.add("palette-reveal");
    const timer = window.setTimeout(() => palette.classList.remove("palette-reveal"), 1200);
    return () => window.clearTimeout(timer);
  }, [props.optionsRevealRequest]);

  const plane = planeKeyOf(props.sketch.plane);
  const planeInfo = plane === "yz" && usesZUpPlane(props.sketch) ? PLANE_INFO_YZ_ZUP : PLANE_INFO[plane];
  const planeWhere = planeWorldCoordinate(props.sketch.plane, props.sketch.planeOffsetMm ?? 0);
  const planePlacement = props.sketch.planeFrame !== undefined ? "plane through three points"
    : planeWhere.valueMm === 0 ? `${planeInfo.name} plane` : `${planeInfo.name} plane at ${planeWhere.axisName} = ${Number(planeWhere.valueMm.toFixed(3))} mm`;
  // While a curve is being dragged the canvas, the analysis and the profiles follow the live result; nothing is committed until release.
  const workingSketch = useMemo<WorkbenchSketch>(() => dragLive === undefined ? props.sketch : { ...props.sketch, entities: dragLive.entities }, [props.sketch, dragLive]);
  const visibleEntities = useMemo(() => workingSketch.entities.filter((entity) => entity.visible !== false), [workingSketch.entities]);
  const visibleSketch = useMemo<WorkbenchSketch>(() => ({
    ...workingSketch,
    entities: visibleEntities,
    constraints: workingSketch.constraints.filter((constraint) => constraint.entityIds.every((id) => visibleEntities.some((entity) => entity.id === id)))
  }), [workingSketch, visibleEntities]);
  const analysis = useMemo(() => analyzeWorkbenchSketch(workingSketch), [workingSketch]);
  const profiles = useMemo(() => detectSketchProfiles(visibleSketch), [visibleSketch]);
  /** Why there is nothing to extrude: the open ends, gaps and missing curves, named. */
  const noProfileReasons = useMemo(() => (profiles.length === 0 ? explainNoProfiles(visibleSketch) : []), [profiles, visibleSketch]);
  /** A region is stored by its reference (id plus signature), which finds it again after the sketch is edited. */
  const refsOf = (ids: readonly string[]): readonly string[] => ids.map((id) => profiles.find((profile) => profile.id === id)?.ref ?? id);
  /** What the current selection would build, so the panel can warn before the solid is made. */
  const regionWarnings = useMemo(() => {
    if (profiles.length === 0) return [] as readonly string[];
    const ids = selectedProfileIds.map((id) => profiles.find((profile) => profile.id === id)?.ref ?? id);
    const region = resolveProfileRegion(profiles, ids, { includeIslands: true });
    return region.ok ? region.value.warnings : [region.diagnostics[0]?.message ?? "These regions cannot be built together."];
  }, [profiles, selectedProfileIds]);
  const fitExtents = useMemo(() => {
    // Fit frames the sketch together with the model shown behind it, so a new sketch on a face opens looking at that face.
    const framed = referenceShown ? [...visibleEntities, ...(props.reference?.entities ?? [])] : visibleEntities;
    if (framed.length === 0) return undefined;
    const bounds = sketchBounds(framed);
    return { min: bounds.min, max: bounds.max };
  }, [visibleEntities, referenceShown, props.reference]);
  const camera = useSketchCamera(fitExtents, `${props.projectId}:${props.sketch.plane}`, props.fitSerial);
  const px = camera.mmPerPx;
  const grid = gridStepsForUnit(props.sketch.gridMm, px, props.displayUnit ?? "mm");
  // Friendly names for tooltips, chips and messages (derived from sketch order; see workbench-core/sketch-names.ts).
  const entityNames = useMemo(() => sketchEntityNames(workingSketch.entities), [workingSketch.entities]);
  const selectedEntity = workingSketch.entities.find((entity) => entity.id === selectionIds.at(-1));
  const selectedEntities = selectionIds.map((id) => workingSketch.entities.find((entity) => entity.id === id)).filter((entity): entity is SketchEntity => entity !== undefined);
  const selectedConstraints = props.sketch.constraints.filter((constraint) => constraint.entityIds.some((id) => selectionIds.includes(id)));
  const dimensionHandleEntities = useMemo(() => [
    ...visibleEntities.filter((entity) => !selectionIds.includes(entity.id)),
    ...visibleEntities.filter((entity) => selectionIds.includes(entity.id))
  ], [selectionIds, visibleEntities]);
  const directDimension = useMemo(() => resolveDirectSketchDimension(dimensionPoints), [dimensionPoints]);
  const directDrivingEntity = directDimension?.driving === undefined ? undefined : props.sketch.entities.find((entity) => entity.id === directDimension.driving!.entityId);
  // Driving dimensions are drawn as real dimensions (extension lines, arrows, editable text); curves without one keep a quiet reference value.
  const drivingDimensions = useMemo(() => visibleSketch.constraints.flatMap((constraint) => {
    if ((constraint.kind !== "distance" && constraint.kind !== "radius") || constraint.valueMm === undefined || constraint.entityIds.length !== 1) return [];
    const named = constraint.dimension ?? (constraint.kind === "radius" ? "radius" : undefined);
    // A diameter dimension is drawn as the circle's Ø: the mark takes the radius.
    const dimension: DrivingDimension | undefined = named === "length" || named === "width" || named === "height" || named === "radius" ? named : named === "diameter" ? "radius" : undefined;
    const entity = visibleEntities.find((candidate) => candidate.id === constraint.entityIds[0]);
    if (dimension === undefined || entity === undefined) return [];
    return [{ constraint, entity, dimension }];
  }), [visibleSketch.constraints, visibleEntities]);
  const dimensionedIds = useMemo(() => new Set(drivingDimensions.map((view) => view.entity.id)), [drivingDimensions]);
  const dimensionModeWasActive = useRef(false);
  // The Sketch palette's spline end directions (blank = free): they become the tangents a fit-point spline leaves and arrives with.
  const splineTangents = useMemo(() => {
    const parse = (text: string): Vec2 | undefined => text.trim() === "" ? undefined : tangentFromDegrees(Number(text));
    const start = parse(curveFields.splineStartAngle);
    const end = parse(curveFields.splineEndAngle);
    return start === undefined && end === undefined ? undefined : { start, end };
  }, [curveFields.splineStartAngle, curveFields.splineEndAngle]);
  const previewEntity = useMemo(() => {
    if (props.tool === "profile") {
      const chain = profileChain.current;
      if (chain === undefined || pending.length === 0) return undefined;
      const step = extendProfileChain(chain, cursor, curveFields.profileMode, PICK_PIXELS * px, { entity: () => "entity:tool-preview", constraint: () => "constraint:tool-preview" });
      return step.ok ? step.value.entity : { id: "entity:tool-preview", kind: "line" as const, start: chain.tail, end: cursor, construction: false } satisfies SketchEntity;
    }
    if (props.tool === "spline-control") return undefined;
    if (props.tool === "spline") {
      if (pending.length < 1) return undefined;
      const rough = { id: "entity:tool-preview", kind: "spline" as const, fitPoints: [...pending, cursor], construction: false } satisfies SketchEntity;
      if (pending.length < 1 || (curveFields.splineMode === "uniform" && splineTangents === undefined)) return rough;
      const shaped = buildFitSpline([...pending, cursor], curveFields.splineMode, "entity:tool-preview", splineTangents ?? {});
      return shaped.ok ? shaped.value : rough;
    }
    if (props.tool === "select") return undefined;
    const required = requiredSketchPoints(props.tool);
    if (isShapeTool(props.tool)) {
      return pending.length >= 1 && pending.length < required - 1
        ? { id: "entity:tool-preview", kind: "line" as const, start: pending[pending.length - 1]!, end: cursor, construction: false } satisfies SketchEntity
        : undefined;
    }
    if (pending.length === required - 1) {
      const preview = buildSketchEntity(props.tool, [...pending, cursor], "entity:tool-preview", arcBuildOptions());
      return preview.ok ? preview.value : undefined;
    }
    // Before the last point of a three-point tool, show the first edge as a rubber band so the next click is predictable.
    if (pending.length >= 1 && pending.length < required - 1) {
      return { id: "entity:tool-preview", kind: "line" as const, start: pending[pending.length - 1]!, end: cursor, construction: false } satisfies SketchEntity;
    }
    return undefined;
  }, [cursor, pending, props.tool, curveFields.profileMode, curveFields.splineMode, splineTangents]);
  const navigationPan = props.tool === "select" && props.viewportState.navigationMode === "pan";
  /** A whole polygon or slot is built from the points placed so far plus the cursor, so it can be previewed and then placed. */
  const buildShape = (tool: Exclude<SketchTool, "select">, points: readonly Vec2[]): WorkbenchResult<SketchShape> => {
    const ids = { entity: (): string => `entity:user-${crypto.randomUUID()}`, constraint: (): string => `constraint:user-${crypto.randomUUID()}` };
    if (isFixedCurveTool(tool)) {
      const options = curveOptionsFromFields(curveFields, { entities: props.sketch.entities, centerlineReachMm: Math.max(1000, camera.camera.widthMm * 3 + Math.hypot(camera.camera.centerMm[0], camera.camera.centerMm[1])), pickReachMm: Math.max(props.sketch.snapToleranceMm, PICK_PIXELS * px), block: blockLibrary.get(curveFields.blockChoice) });
      return buildCurveTool(tool, points, options, ids);
    }
    if (isLineRectangleTool(tool)) return buildLineRectangle(tool, points, ids);
    if (tool === "polygon") return buildPolygonByMode(points[0]!, points[1]!, Math.round(Number(polygonSides)), polygonMode, ids);
    if (tool === "slot-straight") return buildSlotOverall(points[0]!, points[1]!, points[2]!, ids);
    return buildSlot(points[0]!, points[1]!, points[2]!, ids);
  };
  const previewShape = useMemo<SketchShape | undefined>(() => {
    if (props.tool === "spline-control") {
      if (pending.length < 2) return pending.length === 1 ? { entities: [{ id: "entity:tool-preview", kind: "line", start: pending[0]!, end: cursor, construction: false }], constraints: [] } : undefined;
      let counter = 0;
      const built = buildControlPointSpline([...pending, cursor], false, true, { entity: () => `entity:tool-preview-${counter += 1}`, constraint: () => "constraint:tool-preview" });
      return built.ok ? built.value : undefined;
    }
    if (!isShapeTool(props.tool) || pending.length !== requiredSketchPoints(props.tool) - 1) return undefined;
    const built = buildShape(props.tool, [...pending, cursor]);
    return built.ok ? built.value : undefined;
  }, [props.tool, pending, cursor, polygonSides, polygonMode, curveFields, props.sketch.entities]);
  const dynamicMirrorEntity = useMemo(() => {
    const axis = props.sketch.entities.find((entity) => entity.id === dynamicMirrorAxis);
    return axis?.kind === "line" ? axis : undefined;
  }, [props.sketch.entities, dynamicMirrorAxis]);
  useEffect(() => {
    if (dynamicMirrorAxis !== null && dynamicMirrorEntity === undefined) { setDynamicMirrorAxis(null); props.onMessage("Dynamic mirror stopped: its mirror line is gone."); }
  }, [dynamicMirrorAxis, dynamicMirrorEntity]);
  // Remembered picks that name geometry (sweep path, loft rail) are dropped quietly when the sketch they pointed into is gone.
  useEffect(() => {
    const present = (id: string): boolean => id === "" || props.sketch.entities.some((entity) => entity.id === id);
    if (!present(loftRailEntityId)) setLoftRailEntityId("");
  }, [props.sketch.entities, loftRailEntityId]);
  // The sweep path: a sketch (this one, or a finished one on another plane) and the chain of its curves. A choice that no longer exists reads as this sketch.
  const finishedSketches = props.finishedSketches ?? NO_FINISHED_SKETCHES;
  const pathChoices = useMemo(() => pathSketchChoices(finishedSketches, props.sketch, props.workingTimelineId ?? null), [finishedSketches, props.sketch, props.workingTimelineId]);
  const pathSketchId = pathChoices.some((choice) => choice.id === sweepPathSketch) ? sweepPathSketch : WORKING_PATH_SKETCH;
  const pathSketch = pathSketchOf(pathSketchId, finishedSketches, props.sketch) ?? props.sketch;
  const pathCurves = useMemo(() => pathCurvesOf(pathSketch), [pathSketch]);
  const pathIds = useMemo(() => sweepPathIds.filter((id) => pathCurves.some((curve) => curve.id === id)), [sweepPathIds, pathCurves]);
  const pathReport = useMemo(() => describePath(pathSketch, pathIds, pathChoices.find((choice) => choice.id === pathSketchId)?.name), [pathSketch, pathIds, pathChoices, pathSketchId]);
  const mirrorGhosts = useMemo(
    () => (dynamicMirrorEntity === undefined ? [] : mirrorImages(dynamicMirrorEntity, [...(previewEntity === undefined ? [] : [previewEntity]), ...(previewShape?.entities ?? [])])),
    [dynamicMirrorEntity, previewEntity, previewShape]
  );
  /** Applies a drawing edit; with Dynamic Mirror on, the mirror images of what was drawn go in the same edit. */
  const applyDrawn = (drawnPlan: SketchEditPlan): boolean | void => {
    const plan = planForDrawMode(drawnPlan, drawAsConstruction);
    if (dynamicMirrorAxis === null) return props.onApplyEdit(plan);
    const outcome = withDynamicMirror({ sketch: props.sketch, newId: (prefix) => `${prefix}:user-${crypto.randomUUID()}` }, dynamicMirrorAxis, plan);
    if (outcome.mirrored > 0) props.onMessage(`Mirrored ${outcome.mirrored} curve${outcome.mirrored === 1 ? "" : "s"} about ${sketchEntityNames(props.sketch.entities).get(dynamicMirrorAxis) ?? "the axis"}${outcome.withoutRelations ? " (as exact copies; the solver would not take the symmetry relations)" : ""}.`);
    return props.onApplyEdit(outcome.plan);
  };
  const addDrawn = (entity: SketchEntity): void => {
    if (dynamicMirrorAxis === null) { props.onAddEntity(entityForDrawMode(entity, drawAsConstruction)); return; }
    applyDrawn({ label: `Added ${entity.kind}`, removeEntityIds: [], updateEntities: [], addEntities: [entity], addConstraints: [] });
  };
  const newConstraintId = (): string => `constraint:user-${crypto.randomUUID()}`;
  const entityLabels = useMemo(() => entityOrdinalLabels(props.sketch.entities), [props.sketch.entities]);
  const redundantIds = useMemo(() => redundantConstraintIds(workingSketch.constraints, analysis), [workingSketch.constraints, analysis]);
  const constraintTitles = useMemo(() => new Map(props.sketch.constraints.map((constraint) => [constraint.id, describeConstraint(constraint, entityLabels)] as const)), [props.sketch.constraints, entityLabels]);
  const glyphs = useMemo(() => layoutConstraintGlyphs(
    constraintsToDraw(visibleSketch.constraints, showConstraints ? constraintDisplay : { ...constraintDisplay, level: "none" }, { selectedEntityIds: selectionIds, hoveredEntityId: hoverId, selectedConstraintIds, hoveredConstraintId: hoverConstraintId, alwaysShowIds: redundantIds }),
    visibleEntities,
    { mmPerPx: px, redundant: redundantIds, ...(coarsePointer ? { radiusPx: hitSizes.glyphPx } : {}) }
  ), [visibleSketch.constraints, visibleEntities, showConstraints, constraintDisplay, selectionIds, hoverId, selectedConstraintIds, hoverConstraintId, redundantIds, px, coarsePointer, hitSizes.glyphPx]);
  // The curves a hovered or selected relation relates light up.
  const relatedIds = useMemo(() => {
    const focus = hoverConstraintId !== null ? [hoverConstraintId] : selectedConstraintIds;
    return new Set(props.sketch.constraints.filter((constraint) => focus.includes(constraint.id)).flatMap((constraint) => constraint.entityIds));
  }, [props.sketch.constraints, hoverConstraintId, selectedConstraintIds]);
  const recordRows = useMemo(() => constraintRows(props.sketch.constraints, entityLabels), [props.sketch.constraints, entityLabels]);
  const constraintKinds = useMemo(() => constraintKindsPresent(props.sketch.constraints), [props.sketch.constraints]);
  // Driving dimensions: stacked so labels never overlap, at the stand-off the person dragged them to.
  const dimensionViews = useMemo(() => {
    const requests = drivingDimensions.map((view) => {
      const id = view.constraint.id;
      return {
        id,
        layoutAt: (offsetPx: number) => dimensionLayout(view.entity, view.dimension, view.constraint.dimension === "diameter" ? (view.constraint.valueMm ?? 0) / 2 : view.constraint.valueMm ?? 0, px, { offsetPx, format: (value) => formatLengthLabel(value, dimensionDisplay) }),
        userOffsetPx: dimensionDragOffset?.constraintId === id ? dimensionDragOffset.offsetPx : dimensionOffsets[id]
      };
    });
    return stackDimensionLabels(requests, px).flatMap((entry) => {
      const view = drivingDimensions.find((candidate) => candidate.constraint.id === entry.id);
      const request = requests.find((candidate) => candidate.id === entry.id);
      return view === undefined || request === undefined ? [] : [{ ...entry, view, layoutAt: request.layoutAt }];
    });
  }, [drivingDimensions, px, dimensionDisplay, dimensionOffsets, dimensionDragOffset]);
  const selectionTotal = sketchSelectionTotal({ curves: selectionIds.length, profiles: selectedProfileIds.length, constraints: selectedConstraintIds.length });
  useEffect(() => { props.onSelectionCount?.(selectionTotal); }, [selectionTotal]);
  // Relations that no longer exist cannot stay selected.
  useEffect(() => {
    setSelectedConstraintIds((current) => current.every((id) => props.sketch.constraints.some((constraint) => constraint.id === id)) ? current : current.filter((id) => props.sketch.constraints.some((constraint) => constraint.id === id)));
    setHoverConstraintId((current) => current !== null && props.sketch.constraints.some((constraint) => constraint.id === current) ? current : null);
  }, [props.sketch.constraints]);
  useEffect(() => {
    setActiveFit((current) => {
      if (current === undefined) return current;
      const spline = props.sketch.entities.find((entity) => entity.id === current.entityId);
      return spline?.kind === "spline" && current.index < spline.fitPoints.length ? current : undefined;
    });
  }, [props.sketch.entities]);
  const editContext = () => ({ sketch: props.sketch, newId: (prefix: "entity" | "constraint"): string => `${prefix}:user-${crypto.randomUUID()}` });
  /** Puts the clipboard on the system clipboard as text too, so it can be pasted into another window; failure is harmless. */
  const shareClipboardText = (clipboard: SketchClipboard): void => {
    void Promise.resolve(globalThis.navigator?.clipboard?.writeText(serializeClipboard(clipboard))).catch(() => undefined);
  };
  /** Places new text at the click, or re-draws the text being edited (at the click, or where it was when `anchor` is absent). */
  const placeText = (anchor?: Vec2): void => {
    const spec = textSpecFromFields({ text: curveFields.text, height: curveFields.textHeight, widthFactor: curveFields.textWidth, spacing: curveFields.textSpacing, align: curveFields.textAlign, rotation: curveFields.textRotation, construction: drawAsConstruction });
    if (!spec.ok) { props.onMessage(spec.diagnostics[0]?.message ?? "Check the text settings."); return; }
    const editing = textEditId;
    const plan = editing === null ? planSketchText(editContext(), anchor ?? [0, 0], spec.value) : planSketchTextEdit(editContext(), props.sketch, editing, spec.value, anchor);
    if (!plan.ok) { props.onMessage(plan.diagnostics[0]?.message ?? "The text was rejected."); return; }
    const accepted = editing === null ? applyDrawn(plan.value) : props.onApplyEdit(plan.value);
    if (accepted === false) return;
    setPending([]);
    if (editing !== null) setTextEditId(null);
    props.onMessage(editing === null ? `Added the text "${spec.value.text}". Double-click it later to edit it.` : `Edited the text "${spec.value.text}".`);
  };
  const startTextEdit = (text: SketchTextObject): void => {
    setCurveFields((current) => ({ ...current, text: text.text, textHeight: String(text.heightMm), textWidth: String(text.widthFactor), textSpacing: String(text.spacing), textRotation: String(text.rotationDeg), textAlign: text.align }));
    setTextEditId(text.id);
    props.onActivateTool("text");
    props.onMessage(`Editing the text "${text.text}": change it in the Sketch palette and press Apply to the text, or click the sketch to move it there.`);
  };
  /** Double-click on a placed text re-opens it for editing. */
  const handleTextDoubleClick = (event: React.MouseEvent<SVGSVGElement>): void => {
    const id = (event.target as Element).closest<SVGElement>("[data-selection-id]")?.dataset["selectionId"];
    const text = id === undefined ? undefined : findTextObject(props.sketch, id);
    if (text === undefined) return;
    event.preventDefault();
    startTextEdit(text);
  };
  const copySelection = (cut: boolean): void => {
    if (cut) {
      const result = cutSketchSelection(editContext(), selectionIds, props.sketch.name);
      if (!result.ok) { props.onMessage(result.diagnostics[0]?.message ?? "Nothing to cut."); return; }
      if (props.onApplyEdit(result.value.plan) === false) return;
      storeSketchClipboard(result.value.clipboard);
      shareClipboardText(result.value.clipboard);
      setSelectionIds([]);
      props.onSelect(null);
      props.onMessage(`Cut ${result.value.clipboard.entities.length} curve${result.value.clipboard.entities.length === 1 ? "" : "s"} with ${result.value.clipboard.constraints.length} relation${result.value.clipboard.constraints.length === 1 ? "" : "s"}. Ctrl+V pastes them, here or in another sketch.`);
      return;
    }
    const result = copySketchSelection(props.sketch, selectionIds, props.sketch.name);
    if (!result.ok) { props.onMessage(result.diagnostics[0]?.message ?? "Nothing to copy."); return; }
    storeSketchClipboard(result.value);
    shareClipboardText(result.value);
    props.onMessage(`Copied ${result.value.entities.length} curve${result.value.entities.length === 1 ? "" : "s"} with ${result.value.constraints.length} relation${result.value.constraints.length === 1 ? "" : "s"}${result.value.leftBehind > 0 ? ` (${result.value.leftBehind} relation${result.value.leftBehind === 1 ? "" : "s"} to other curves left behind)` : ""}. Ctrl+V pastes them, here or in another sketch.`);
  };
  const pasteFrom = (clipboard: SketchClipboard): void => {
    const result = pasteSketchClipboard(editContext(), clipboard, { pasteNumber: nextPasteNumber() });
    if (!result.ok) { props.onMessage(result.diagnostics[0]?.message ?? "The paste was rejected."); return; }
    if (props.onApplyEdit(result.value) === false) return;
    setSelectionIds(result.value.addEntities.map((entity) => entity.id));
    props.onSelect(result.value.addEntities.at(-1)?.id ?? null);
  };
  const pasteClipboard = (): void => {
    const stored = readSketchClipboard();
    if (stored !== undefined) { pasteFrom(stored); return; }
    // Nothing copied in this session: the system clipboard may hold sketch curves copied from another window.
    const reader = globalThis.navigator?.clipboard?.readText;
    if (reader === undefined) { props.onMessage("The sketch clipboard is empty. Select curves and press Ctrl+C first."); return; }
    void globalThis.navigator.clipboard.readText().then((text) => {
      const parsed = parseClipboard(text);
      if (!parsed.ok) { props.onMessage(`The sketch clipboard cannot be pasted: ${parsed.diagnostics[0]?.message ?? "it does not hold sketch curves."} Select curves and press Ctrl+C first.`); return; }
      storeSketchClipboard(parsed.value);
      pasteFrom(parsed.value);
    }).catch(() => props.onMessage("The sketch clipboard is empty. Select curves and press Ctrl+C first."));
  };

  useEffect(() => {
    dragGesture.current = undefined;
    dragLatest.current = undefined;
    setDragLive(undefined);
  }, [props.sketch, props.tool, props.cancelVersion]);
  useEffect(() => setPending([]), [props.tool, props.cancelVersion]);
  useEffect(() => {
    if (pending.length === 0) { lineChain.current = EMPTY_LINE_CHAIN; profileChain.current = undefined; arcTrack.current = undefined; typedTrail.current = {}; setPendingInference([]); }
  }, [pending.length]);
  // Undo (or any edit that removes the newest line) walks a line chain back to the previous vertex, so the next segment starts there and
  // joins the surviving line instead of floating at a vertex that no longer exists. A Profile chain whose last segment is gone restarts.
  useEffect(() => {
    if (props.tool === "line" && lineChain.current.start !== undefined) {
      const result = reconcileLineChain(lineChain.current, props.sketch.entities);
      if (!result.changed) return;
      lineChain.current = result.chain;
      setPending(result.pending);
      setPendingInference(result.tailInference === undefined ? [] : [result.tailInference]);
      props.onMessage(`Stepped the line chain back to the previous point (${lineChainSegments(result.chain)} segment${lineChainSegments(result.chain) === 1 ? "" : "s"} left). Keep clicking to continue from there.`);
    } else if (props.tool === "profile" && profileChain.current !== undefined && !profileChainStillValid(profileChain.current, props.sketch.entities)) {
      profileChain.current = undefined;
      setPending([]);
      props.onMessage("The profile's last segment was removed, so the profile chain stopped. Click to start a new one.");
    }
  }, [props.sketch.entities]);
  // Starting a drawing tool, Sketch Dimension or an edit tool ends relation picking; switching to Select (which picking itself does) does not.
  useEffect(() => {
    if (props.tool !== "select" || props.dimensionMode || props.editTool !== null) { setPickRelation(null); setToolPicks([]); }
  }, [props.tool, props.dimensionMode, props.editTool]);
  useEffect(() => { setFieldText({}); }, [props.tool, props.cancelVersion, pending.length]);
  // A new tool says what its first click means, and that the point can be typed instead.
  useEffect(() => {
    if (props.tool === "select" || pending.length > 0) return;
    const prompt = firstClickPrompt(props.tool);
    if (prompt !== undefined) props.onMessage(`${sketchToolLabel(props.tool)}: click ${prompt}, or type its X and Y and press Enter.`);
  }, [props.tool]);
  // Text editing belongs to the Text tool; leaving it, or the picture panel, drops what was half done.
  useEffect(() => { if (props.tool !== "text") setTextEditId(null); }, [props.tool]);
  useEffect(() => { if (props.editTool !== "underlay") setUnderlayPick({ active: false, points: [] }); }, [props.editTool]);
  useEffect(() => { if (textEditId !== null && !(props.sketch.texts ?? []).some((text) => text.id === textEditId)) setTextEditId(null); }, [props.sketch.texts, textEditId]);
  useEffect(() => {
    if (focusRequest === undefined) return;
    const element = fieldRefs.current[focusRequest.id];
    if (element === null || element === undefined) return;
    element.focus();
    if (fieldText[focusRequest.id] === undefined) element.select();
    else element.setSelectionRange(element.value.length, element.value.length);
  }, [focusRequest]);
  useEffect(() => {
    if (props.dimensionMode && !dimensionModeWasActive.current) setDimensionPoints(selectedEntity === undefined || selectedEntity.visible === false ? [] : defaultDimensionPoints(selectedEntity));
    if (!props.dimensionMode) { setDimensionPoints([]); setDimensionFirst(undefined); setDimensionPlacement(undefined); }
    dimensionModeWasActive.current = props.dimensionMode;
  }, [props.dimensionMode]);
  useEffect(() => {
    if (props.selectedId === null || props.selectedId.startsWith("profile:")) setSelectionIds([]);
    else setSelectionIds((current) => current.includes(props.selectedId!) ? current : [props.selectedId!]);
    if (props.selectedId?.startsWith("profile:") === true && profiles.some((profile) => profile.id === props.selectedId)) setSelectedProfileIds([props.selectedId]);
  }, [profiles, props.selectedId]);
  // A profile id carries the outline's signature, so dragging a corner renames the region; the selection follows it instead of being dropped.
  useEffect(() => setSelectedProfileIds((current) => {
    const next = [...new Set(current.flatMap((id) => { const match = matchProfileRef(id, profiles); return match === undefined ? [] : [match.profile.id]; }))];
    return next.length === current.length && next.every((id, index) => id === current[index]) ? current : next;
  }), [profiles]);
  useEffect(() => {
    const currentHandles = allDimensionPoints(visibleEntities);
    setDimensionPoints((current) => current.flatMap((point) => currentHandles.find((candidate) => candidate.id === point.id) ?? []));
  }, [visibleEntities]);
  // Entities that were deleted or hidden can no longer be selected or hovered.
  useEffect(() => {
    setSelectionIds((current) => current.filter((id) => visibleEntities.some((entity) => entity.id === id)));
    setHoverId((current) => current !== null && visibleEntities.some((entity) => entity.id === current) ? current : null);
  }, [visibleEntities]);

  const assistedAt = (point: Vec2, modifiers: SnapModifiers): InferenceResult => assistedInference({
    tool: props.tool,
    pointer: point,
    sketch: snapSketch,
    toleranceMm: SNAP_PIXELS * px,
    gridMm: grid.minorMm,
    anchor: anchorFor(props.tool, pending),
    placedCount: pending.length,
    settings: assist,
    modifiers
  });
  // Holding or releasing Ctrl / Shift re-evaluates the preview at once, without waiting for the pointer to move.
  useEffect(() => {
    const raw = lastRaw.current;
    if (raw === undefined || props.tool === "select" || !pointerInside) return;
    const result = assistedAt(raw, heldKeys);
    setCursor(result.point);
    setInference(result);
  }, [heldKeys, assist]);
  const updateHoverStack = (point: Vec2): void => {
    const next = entitiesUnderPoint(props.sketch, point, PICK_PIXELS * px);
    setHoverStack((current) => sameCandidates(current, next) ? current : next);
  };

  /** Recomputes the Trim highlight for the pointer, skipping tiny moves so a busy sketch stays smooth. */
  const updateTrimHover = (point: Vec2): void => {
    const last = lastTrimPick.current;
    if (last !== undefined && Math.hypot(point[0] - last[0], point[1] - last[1]) < 1.5 * px) return;
    lastTrimPick.current = point;
    const next = trimHoverPreview(editContext(), point, PICK_PIXELS * px);
    setTrimHover((current) => (sameTrimPreview(current, next) ? current : next));
  };

  const pointer = (event: React.PointerEvent<SVGSVGElement>, commit: boolean): void => {
    const point = camera.toSketch(event.clientX, event.clientY);
    if (!commit && props.editTool === "trim" && props.tool === "select" && trimSweep.current === undefined) updateTrimHover(point);
    // Placing tools infer from the sketch (endpoints, centres, midpoints, intersections, alignment...). A line or spline also
    // infers from the last point it placed, which enables perpendicular, tangent and level/plumb hints.
    const placing = props.tool !== "select";
    lastRaw.current = point;
    // Every tool aligns with its last point; polar tracking, the ortho lock, Ctrl (no snapping) and Shift (constrain) apply on top (see snap-assist.ts).
    const result: InferenceResult = placing
      ? assistedAt(point, { ctrl: event.ctrlKey || event.metaKey, shift: event.shiftKey })
      : { point, snapped: false, guides: [] };
    if (!placing && !commit) updateHoverStack(point);
    const snapped = { point: result.point, snapped: result.snapped, label: result.primary === undefined ? "" : `${INFERENCE_LABELS[result.primary.kind].toLowerCase()}${isReferenceId(result.primary.entityId) ? " of the model behind the sketch, not tied to it" : ""}` };
    setCursor(snapped.point);
    if (props.tool === "arc-center" && pending.length === 2) arcTrack.current = advanceArcSweepTrack(arcTrack.current ?? startArcSweepTrack(pending[0]!, pending[1]!), pending[0]!, snapped.point);
    setInference(placing ? result : undefined);
    if (!commit) return;
    if (underlayPick.active && props.editTool === "underlay") {
      const next = [...underlayPick.points, point];
      setUnderlayPick({ active: next.length < 2, points: next });
      props.onMessage(next.length < 2 ? "Picture: first point set. Click the second point on the picture." : "Picture: both points set. Type their real distance and press Calibrate scale.");
      return;
    }
    if (isClickEditTool(props.editTool) && props.tool === "select") {
      const target = nearestEntityId(props.sketch, point, PICK_PIXELS * px);
      if (target === undefined) { props.onMessage(`${SKETCH_EDIT_TOOL_LABELS[props.editTool]}: click directly on a curve.`); return; }
      const context = { sketch: props.sketch, newId: (prefix: "entity" | "constraint"): string => `${prefix}:user-${crypto.randomUUID()}` };
      const result = props.editTool === "trim" ? trimAt(context, target, point)
        : props.editTool === "extend" ? extendAt(context, target, point)
        : props.editTool === "split" ? splitAt(context, target, point, { snapMm: PICK_PIXELS * px })
        : props.editTool === "delete-curve" ? deleteCurveHeal(context, target)
        : jogLine(context, target, point, { offsetMm: parseLengthField(jogParams.offset, unit), widthMm: parseLengthField(jogParams.width, unit) });
      if (!result.ok) { props.onMessage(result.diagnostics[0]?.message ?? "The sketch edit was rejected."); return; }
      props.onApplyEdit(result.value);
      setSelectionIds([]);
      return;
    }
    if (props.tool === "spline-control") {
      // Control points: clicking the first one again closes the loop, clicking the last one again (or Enter) ends an open curve.
      const first = pending[0];
      const last = pending.at(-1);
      if (pending.length >= 3 && first !== undefined && Math.hypot(snapped.point[0] - first[0], snapped.point[1] - first[1]) <= PICK_PIXELS * px) { finishControlSpline(pending, true); return; }
      const gap = last === undefined ? Infinity : Math.hypot(snapped.point[0] - last[0], snapped.point[1] - last[1]);
      if (pending.length >= 3 && gap <= PICK_PIXELS * px) { finishControlSpline(pending, false); return; }
      if (gap < 0.05) return;
      const next = [...pending, snapped.point];
      setPending(next);
      props.onMessage(`Control-point spline: point ${next.length} accepted.${next.length >= 3 ? " Click the first point to close it, click the last point again or press Enter to finish." : ""}`);
      return;
    }
    if (props.tool === "spline") {
      const last = pending.at(-1);
      const gap = last === undefined ? Infinity : Math.hypot(snapped.point[0] - last[0], snapped.point[1] - last[1]);
      if (pending.length >= 2 && gap <= PICK_PIXELS * px) { finishSpline(pending); return; }
      if (gap < 0.01) return;
      if (pending.length >= SPLINE_MAX_FIT_POINTS) { props.onMessage(`A spline takes at most ${SPLINE_MAX_FIT_POINTS} fit points. Click the last point again or press Enter to finish.`); return; }
      const next = [...pending, snapped.point];
      setPending(next);
      props.onMessage(`Fit-point spline: point ${next.length} accepted.${next.length >= 2 ? " Click the last point again or press Enter to finish (two points make a straight spline)." : ""}`);
      return;
    }
    if (props.tool === "select") {
      // Shift-click on empty canvas keeps the selection; a plain click clears it.
      if (event.shiftKey || event.ctrlKey || event.metaKey) return;
      // Two points are picked in Sketch Dimension: this click places their dimension and opens its value.
      if (props.dimensionMode && dimensionPlacement !== undefined) { placeDimensionAt(point); return; }
      setSelectionIds([]);
      setSelectedProfileIds([]);
      setSelectedConstraintIds([]);
      setActiveFit(undefined);
      if (props.dimensionMode) { setDimensionPoints([]); setDimensionFirst(undefined); }
      props.onSelect(null);
      return;
    }
    placePoint(snapped.point, snapped.snapped ? snapped.label : "", result);
  };

  /** Places one point of the active tool: a click, or Enter on typed values. A finished shape is added to the sketch. */
  const placePoint = (point: Vec2, label: string, found?: InferenceResult, typed?: DynamicValues): void => {
    if (props.tool === "select" || props.tool === "spline" || props.tool === "spline-control") return;
    setFieldText({});
    if (typed !== undefined) typedTrail.current = mergeTyped(typedTrail.current, typed);
    lastPlaced.current = point;
    // What typed input did that the user may not expect (a negative size flipped, an angle wrapped) is appended to the status line once.
    const say = (message: string): void => { const notes = typedNotes.current; typedNotes.current = []; props.onMessage(notes.length === 0 ? message : `${message} ${notes.join(" ")}`); };
    if (props.tool === "profile") { placeProfilePoint(point, found); return; }
    const points = [...pending, point];
    const previous = pending.at(-1);
    const placed: readonly PlacedPointInference[] = [
      ...pending.map((earlier, index): PlacedPointInference => pendingInference[index] ?? { point: earlier }),
      { point, ...(found?.primary === undefined ? {} : { primary: found.primary }), ...(found === undefined ? {} : { guides: found.guides }), ...(previous === undefined ? {} : { anchor: previous }) }
    ];
    if (points.length === 1 && props.tool === "line") lineChain.current = startLineChain(point, placed[0]);
    if (props.tool === "arc-center" && points.length === 2) arcTrack.current = startArcSweepTrack(points[0]!, points[1]!);
    // A tangent arc that starts on the end of a line or arc leaves it along its tangent: the direction click is not asked for.
    if (props.tool === "arc-tangent" && points.length === 1) {
      const inherited = inheritedTangentDirection(placed[0]!, props.sketch);
      if (inherited !== undefined) {
        const reach = Math.max(1, 20 * px);
        const direction: Vec2 = [point[0] + inherited.direction[0] * reach, point[1] + inherited.direction[1] * reach];
        setPending([point, direction]);
        setPendingInference([placed[0]!, { point: direction }]);
        say(`Tangent arc: it leaves the curve along its tangent. Next: the end of the arc.`);
        return;
      }
    }
    if (points.length < requiredSketchPoints(props.tool)) {
      setPending(points);
      setPendingInference(placed);
      const nextPrompt = nextClickPrompt(props.tool, points.length);
      say(`${sketchToolLabel(props.tool)}: point ${points.length} accepted${label === "" ? "" : ` (${label})`}.${nextPrompt === undefined ? "" : ` Next: ${nextPrompt}.`}`);
      return;
    }
    if (props.tool === "text") { placeText(point); return; }
    if (isShapeTool(props.tool)) {
      const shape = buildShape(props.tool, points);
      if (!shape.ok) {
        props.onMessage(`${shape.diagnostics[0]?.message ?? "The shape was rejected."} Place the last point somewhere else, or press Esc to start over.`);
        return;
      }
      // A polygon whose centre was snapped to the origin or to other geometry is located by it.
      const centreRelations = autoConstrain && props.tool === "polygon" ? keepResolvableConstraints(polygonCentreRelations(shape.value, polygonMode, placed, props.sketch, () => `constraint:auto-${crypto.randomUUID()}`), props.sketch.entities.map((entity) => entity.id), shape.value.entities.map((entity) => entity.id)).kept : [];
      // Every other click that was snapped to geometry joins the matching point of the shape, and a size that was typed is kept as its dimension.
      const newShapeId = (): string => `constraint:auto-${crypto.randomUUID()}`;
      const snapRelations = autoConstrain ? keepResolvableConstraints(shapeSnapRelations({ tool: props.tool, shape: shape.value, placed, sketch: props.sketch, newId: newShapeId, ...(props.tool === "polygon" && polygonMode !== "edge" ? { skip: new Set([0]) } : {}) }), props.sketch.entities.map((entity) => entity.id), shape.value.entities.map((entity) => entity.id)).kept : [];
      const typedShapeRelations = typedShapeIntent({ tool: props.tool, shape: shape.value, typed: typedTrail.current, newId: newShapeId });
      typedTrail.current = {};
      const extraRelations = [...centreRelations, ...snapRelations, ...typedShapeRelations];
      const shapeRelations = [...shape.value.constraints, ...extraRelations];
      const shapeLabel = `Added ${sketchToolLabel(props.tool).toLowerCase()} (${shape.value.entities.length} curves, ${shapeRelations.length} relations)`;
      let accepted = applyDrawn({ label: shapeLabel, removeEntityIds: [], updateEntities: [], addEntities: shape.value.entities, addConstraints: shapeRelations });
      // If the solver refuses the snap or typed-size relations, the shape itself is still drawn with the relations that make it what it is.
      if (accepted === false && extraRelations.length > 0) accepted = applyDrawn({ label: shapeLabel, removeEntityIds: [], updateEntities: [], addEntities: shape.value.entities, addConstraints: shape.value.constraints });
      if (accepted === false) return;
      setPending([]);
      say(`Added ${sketchToolLabel(props.tool).toLowerCase()} with ${shape.value.entities.length} curve${shape.value.entities.length === 1 ? "" : "s"} and ${shape.value.constraints.length} relation${shape.value.constraints.length === 1 ? "" : "s"}.`);
      return;
    }
    if (props.tool === "arc-center" && typed?.sweep !== undefined && typed.sweep !== 0) {
      // A typed sweep names its own way round (positive is counter-clockwise), so it does not depend on where the pointer happened to travel.
      arcTrack.current = { angle: Math.atan2(point[1] - points[0]![1], point[0] - points[0]![0]), sweepRad: (typed.sweep * Math.PI) / 180 };
    } else if (props.tool === "arc-center" && arcTrack.current !== undefined) arcTrack.current = advanceArcSweepTrack(arcTrack.current, points[0]!, point);
    const built = buildSketchEntity(props.tool, props.tool === "arc-tangent" ? tangentArcPoints(points, placed, props.sketch) : points, `entity:user-${crypto.randomUUID()}`, arcBuildOptions());
    if (!built.ok) {
      // Keep the points already placed so one bad click does not throw the whole gesture away.
      props.onMessage(`${built.diagnostics[0]?.message ?? "Sketch entity rejected."} Place the last point somewhere else, or press Esc to start over.`);
      return;
    }
    // A shape whose points snapped to other geometry is added together with the relations that implies, in one undoable edit.
    // Never send a relation that names a curve that is not there (an undone chain end, say): the project would refuse the whole edit.
    const snappedRelations = autoConstrain ? keepResolvableConstraints(autoConstraintsFor({ tool: props.tool, entity: built.value, placed, sketch: props.sketch, newId: () => `constraint:auto-${crypto.randomUUID()}` }), props.sketch.entities.map((entity) => entity.id), [built.value.id]).kept : [];
    // A value the user typed is design intent: it becomes a driving dimension, and a typed 0 or 90 degrees becomes Horizontal or Vertical.
    const typedRelations = typedIntentConstraints({ tool: props.tool, entity: built.value, typed: typedTrail.current, newId: () => `constraint:typed-${crypto.randomUUID()}` })
      .filter((relation) => !snappedRelations.some((existing) => existing.kind === relation.kind && relation.dimension === undefined));
    typedTrail.current = {};
    // What the shape is born with whether or not it snapped to anything: a corner-to-corner or centre rectangle is level.
    const ownRelations = bornConstraintsFor({ tool: props.tool, entity: built.value, newId: () => `constraint:own-${crypto.randomUUID()}` });
    let relations = [...ownRelations, ...snappedRelations, ...typedRelations];
    let accepted: boolean | void = undefined;
    if (relations.length > 0) {
      accepted = applyDrawn({ label: `Added ${sketchToolLabel(props.tool)} with ${relations.length} relation${relations.length === 1 ? "" : "s"}`, removeEntityIds: [], updateEntities: [], addEntities: [built.value], addConstraints: relations });
    }
    // If the solver refused the snap or typed relations, the shape keeps the relations it is born with.
    if (accepted === false && ownRelations.length > 0 && relations.length > ownRelations.length) {
      relations = [...ownRelations];
      accepted = applyDrawn({ label: `Added ${sketchToolLabel(props.tool)} with ${relations.length} relation${relations.length === 1 ? "" : "s"}`, removeEntityIds: [], updateEntities: [], addEntities: [built.value], addConstraints: relations });
    }
    // If the solver refused the relations, the shape itself is still drawn.
    if (relations.length === 0 || accepted === false) addDrawn(built.value);
    const relationNote = relations.length > 0 && accepted !== false ? ` with ${relations.length} automatic relation${relations.length === 1 ? "" : "s"} (${[...new Set(relations.map((relation) => relation.kind))].join(", ")})` : "";
    if (props.tool === "line") {
      // A line carries on from where it ended, like a polyline, until Esc. Ending on the first point closes the loop.
      const segments = lineChainSegments(lineChain.current) + 1;
      const start = lineChain.current.start;
      if (segments >= 3 && start !== undefined && Math.hypot(point[0] - start[0], point[1] - start[1]) < 1e-6) {
        setPending([]);
        say(`Closed the loop after ${segments} lines. The shape is now a closed profile.`);
        return;
      }
      lineChain.current = extendLineChain(lineChain.current, built.value.id);
      setPending([point]);
      // The next segment starts where this one ended, so it is joined to it automatically.
      setPendingInference([{ point, primary: { kind: "endpoint", point, entityId: built.value.id, selector: "end", distanceMm: 0 } }]);
      say(`Added line ${segments}${relationNote}. Keep clicking to continue the chain, click the first point to close it, or press Esc to stop.`);
      return;
    }
    setPending([]);
    say(`Added ${sketchToolLabel(props.tool).toLowerCase()}${relationNote}.`);
  };

  const dynamicFields = useMemo(() => dynamicFieldsFor(props.tool, pending.length, polygonMode), [props.tool, pending.length, polygonMode]);
  const liveValues = useMemo(() => measureFromCursor(props.tool, pending, cursor, props.tool === "arc-center" ? arcTrack.current : undefined), [props.tool, pending, cursor]);
  const setField = (id: DynamicFieldId, value: string): void => setFieldText((current) => {
    const { [id]: _previous, ...rest } = current;
    return value === "" ? rest : { ...rest, [id]: value };
  });
  const requestFieldFocus = (id: DynamicFieldId): void => { focusSerial.current += 1; setFocusRequest({ id, serial: focusSerial.current }); };
  const evaluateTyped = props.evaluateText ?? plainEvaluator;
  // Text the parser cannot read is marked on its field while it is typed; Enter refuses it (it used to place the cursor's value instead).
  const liveFieldErrors = useMemo(() => fieldErrorsFor(dynamicFields, fieldText, evaluateTyped, unit), [dynamicFields, fieldText, props.evaluateText, unit]);
  const fieldErrors = { ...commitErrors, ...liveFieldErrors };
  useEffect(() => { setCommitErrors({}); }, [fieldText, props.tool, pending.length]);
  /** Places the typed point. Returns false (and keeps the typed text and the focus) when the input was refused. */
  const commitDynamicInput = (): boolean => {
    const result = resolveDynamicEntry({ tool: props.tool, placed: pending, cursor, fields: dynamicFields, texts: fieldText, evaluate: evaluateTyped, unit, ...(lastPlaced.current === undefined ? {} : { lastPoint: lastPlaced.current }) });
    if (!result.ok) {
      setCommitErrors(result.errors);
      props.onMessage(`${result.message} Nothing was placed.`);
      return false;
    }
    setDynamicFocused(false);
    typedNotes.current = result.notes;
    // The guides of a typed 0 / 90 / 180 / 270 degree angle make the same Horizontal / Vertical relation a snapped point does.
    // A typed point that lands on an endpoint, a centre, the origin or a curve is joined to it, exactly as a clicked one is.
    const found: InferenceResult = inferTypedPoint(result.point, props.sketch, anchorFor(props.tool, pending), result.guides);
    if (props.tool === "spline" || props.tool === "spline-control") {
      const next = [...pending, result.point];
      if (props.tool === "spline" && next.length > SPLINE_MAX_FIT_POINTS) { props.onMessage(`A spline takes at most ${SPLINE_MAX_FIT_POINTS} fit points. Press Enter to finish.`); return false; }
      lastPlaced.current = result.point;
      setPending(next);
      setFieldText({});
      props.onMessage(`${sketchToolLabel(props.tool)}: point ${next.length} accepted (typed).${next.length >= 2 ? " Press Enter to finish." : ""}${result.notes.length === 0 ? "" : ` ${result.notes.join(" ")}`}`);
      typedNotes.current = [];
      return true;
    }
    placePoint(found.point, "typed", found, result.typed);
    return true;
  };

  const finishSpline = (points: readonly Vec2[]): void => {
    const built = buildFitSpline(points, curveFields.splineMode, `entity:user-${crypto.randomUUID()}`, splineTangents ?? {});
    if (!built.ok) { props.onMessage(built.diagnostics[0]?.message ?? "The spline was rejected."); setPending([]); return; }
    addDrawn(built.value);
    setPending([]);
    props.onMessage(`Added a fit-point spline through ${points.length} points.`);
  };

  const finishControlSpline = (controls: readonly Vec2[], closed: boolean): void => {
    const ids = { entity: (): string => `entity:user-${crypto.randomUUID()}`, constraint: (): string => `constraint:user-${crypto.randomUUID()}` };
    const built = buildControlPointSpline(controls, closed, curveFields.keepPolygon, ids);
    if (!built.ok) { props.onMessage(built.diagnostics[0]?.message ?? "The spline was rejected."); setPending([]); return; }
    const accepted = props.onApplyEdit(planForDrawMode({ label: `Added control-point spline (${controls.length} control points${closed ? ", closed" : ""})`, removeEntityIds: [], updateEntities: [], addEntities: built.value.entities, addConstraints: built.value.constraints }, drawAsConstruction));
    if (accepted === false) return;
    setPending([]);
    props.onMessage(`Added ${closed ? "closed " : ""}control-point spline from ${controls.length} control points${closed ? " as two splines that meet at two points, so it bounds a profile" : ""}.`);
  };

  const saveSelectionAsBlock = (name: string): void => {
    const made = makeSketchBlock(name, selectedEntities, props.sketch.constraints);
    if (!made.ok) { props.onMessage(made.diagnostics[0]?.message ?? "The block could not be saved."); return; }
    blockLibrary.save(made.value);
    setBlockNames(blockLibrary.list().map((block) => block.name));
    setCurveFields((current) => ({ ...current, blockChoice: made.value.name }));
    props.onMessage(`Saved block "${made.value.name}" with ${made.value.entities.length} curve${made.value.entities.length === 1 ? "" : "s"} and ${made.value.constraints.length} relation${made.value.constraints.length === 1 ? "" : "s"}. Click in the sketch to insert it.`);
  };

  /** One click of the Profile tool: the first click starts the chain, each later click adds a line or a tangent arc; ending on the start closes the loop. */
  const placeProfilePoint = (point: Vec2, found?: InferenceResult): void => {
    const chain = profileChain.current;
    const snapOf = (at: Vec2): PlacedPointInference | undefined => found?.primary === undefined ? undefined : { point: at, primary: found.primary, guides: found.guides };
    if (chain === undefined) {
      profileChain.current = startProfileChain(point);
      profileStartSnap.current = snapOf(point);
      setPending([point]);
      props.onMessage("Profile: start placed. Click the next point; pick Tangent arc in the Sketch palette to curve into it, click the start again to close, Esc to stop.");
      return;
    }
    const ids = { entity: (): string => `entity:user-${crypto.randomUUID()}`, constraint: (): string => `constraint:user-${crypto.randomUUID()}` };
    const step = extendProfileChain(chain, point, curveFields.profileMode, PICK_PIXELS * px, ids);
    if (!step.ok) { props.onMessage(`${step.diagnostics[0]?.message ?? "The segment was rejected."} Place the point somewhere else, or press Esc to stop.`); return; }
    const { chain: next, closed } = step.value;
    const entity = entityForDrawMode(step.value.entity, drawAsConstruction);
    // The start of the first segment and the end of any segment that were snapped to other geometry are joined to it, like any drawn curve's.
    const snapPlaced = [chain.segments === 0 ? profileStartSnap.current : undefined, closed ? undefined : snapOf(next.tail)].filter((entry): entry is PlacedPointInference => entry !== undefined);
    const snapRelations = autoConstrain && snapPlaced.length > 0
      ? keepResolvableConstraints(profileSnapRelations({ entity, placed: snapPlaced, own: step.value.constraints, sketch: props.sketch, newId: () => `constraint:auto-${crypto.randomUUID()}` }), props.sketch.entities.map((existing) => existing.id), [entity.id]).kept
      : [];
    const constraints = [...step.value.constraints, ...snapRelations];
    let accepted: boolean | void = undefined;
    if (constraints.length > 0) accepted = props.onApplyEdit({ label: `Added profile ${entity.kind} ${next.segments}`, removeEntityIds: [], updateEntities: [], addEntities: [entity], addConstraints: constraints });
    // If the solver refused the snap relations, the segment is drawn with the joints that hold the outline together.
    if (accepted === false && snapRelations.length > 0 && step.value.constraints.length > 0) accepted = props.onApplyEdit({ label: `Added profile ${entity.kind} ${next.segments}`, removeEntityIds: [], updateEntities: [], addEntities: [entity], addConstraints: step.value.constraints });
    // If the solver refused the relations altogether, the segment itself is still drawn.
    if (constraints.length === 0 || accepted === false) props.onAddEntity(entity);
    if (closed) {
      profileChain.current = undefined;
      setPending([]);
      props.onMessage(`Closed the profile after ${next.segments} segments. It is now a closed profile.`);
      return;
    }
    profileChain.current = next;
    setPending([next.tail]);
    props.onMessage(`Added profile ${entity.kind} ${next.segments}. Keep clicking, click the start to close it, or press Esc to stop.`);
  };

  // A dimension on a curve that is Fixed would contradict the Fix. Instead of failing with a solver conflict, offer the one-click way out:
  // relax the Fix and apply the value in the same step.
  const [relaxPrompt, setRelaxPrompt] = useState<{ readonly names: string; readonly apply: () => void } | undefined>(undefined);
  // A new dimension that the sketch already decides, or that contradicts it, is offered as a reference dimension instead of being refused.
  const [overPrompt, setOverPrompt] = useState<{ readonly message: string; readonly apply: () => void } | undefined>(undefined);
  useEffect(() => { setRelaxPrompt(undefined); setOverPrompt(undefined); }, [props.sketch]);
  const setDimension: SetDimensionRequest = (entityId, dimension, valueMm, extra) => {
    setOverPrompt(undefined);
    if (extra?.driven !== true) {
      const involved = [entityId, ...(extra?.secondEntityId === undefined ? [] : [extra.secondEntityId])];
      const blocking = fixesBlockingDimension(props.sketch, involved);
      if (blocking.length > 0) {
        const names = involved.filter((id) => !isSketchDatumEntityId(id)).map((id) => entityNames.get(id) ?? "this curve").join(" and ");
        setRelaxPrompt({ names, apply: () => { props.onSetSuppressed(blocking.map((fix) => fix.id), true); props.onSetDimension(entityId, dimension, valueMm, extra); } });
        props.onMessage(`${names} ${involved.length > 1 ? "are" : "is"} Fixed, so a dimension on ${involved.length > 1 ? "them" : "it"} would contradict the Fix. Press "Relax the Fix and apply" to let ${involved.length > 1 ? "them" : "it"} move, or Cancel.`);
        return;
      }
    }
    setRelaxPrompt(undefined);
    const over = dimensionOverConstraint(props.sketch, { entityId, dimension, valueMm, secondEntityId: extra?.secondEntityId, points: extra?.points, expression: extra?.expression, driven: extra?.driven });
    if (over !== undefined) {
      const { expression: _unused, ...rest } = extra ?? {};
      setOverPrompt({ message: over.reason, apply: () => props.onSetDimension(entityId, dimension, valueMm, { ...rest, driven: true }) });
      props.onMessage(`${over.message} Press "Add as a reference dimension" to show the value without driving the sketch, or Cancel.`);
      return;
    }
    props.onSetDimension(entityId, dimension, valueMm, extra);
  };
  /** A field's request (a value, or a parameter expression) sent through the same path as the canvas editor. */
  const applyDimension = (entityId: string, apply: DimensionApply): void => setDimension(entityId, apply.dimension, apply.valueMm, apply.expression === undefined ? undefined : { expression: apply.expression });

  /** Opens the value editor at a curve's dimension (or at the click): the length of a line, the diameter of a circle, the width or height of a rectangle. */
  const openDimensionEditor = (entity: SketchEntity, requested: DrivingDimension, anchorOverride?: Vec2): void => {
    // An arc is dimensioned by its radius (its length is in the inspector) and an ellipse by its perimeter (its axes are in the inspector).
    const dimension: DrivingDimension = entity.kind === "arc" ? "radius" : entity.kind === "ellipse" ? "perimeter" : requested;
    const arcRadius = entity.kind === "arc" ? arcShape(entity.start, entity.mid, entity.end)?.radiusMm : undefined;
    const current = entity.kind === "line" ? Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1])
      : entity.kind === "circle" ? entity.radiusMm * 2
        : entity.kind === "rectangle" ? (dimension === "height" ? entity.heightMm : entity.widthMm)
          : entity.kind === "arc" ? arcRadius
            : entity.kind === "ellipse" ? entityLengthMm(entity) : undefined;
    if (current === undefined) { props.onMessage("Only lines, circles, rectangles, arcs and ellipses take a driving dimension here; splines are reference only (see Angle, arc length, perimeter)."); return; }
    const matches = (constraint: WorkbenchSketchConstraint): boolean => constraint.entityIds.length === 1 && constraint.entityIds[0] === entity.id
      && (dimension === "arc-length" ? constraint.kind === "arc-length" : dimension === "perimeter" ? constraint.kind === "perimeter" : constraint.dimension === dimension || (constraint.kind === "radius" && dimension === "radius"));
    const driving = props.sketch.constraints.find((constraint) => matches(constraint) && constraint.valueMm !== undefined && constraint.driven !== true);
    const wasReference = driving === undefined && props.sketch.constraints.some((constraint) => matches(constraint) && constraint.driven === true);
    // A circle is edited as a diameter. Its stored dimension is a Radius (the value is the radius) or a Diameter (the value is the diameter).
    const circleFacts = entity.kind === "circle" ? circleDimensionFacts(props.sketch, entity) : undefined;
    const shown = driving?.valueMm === undefined ? current : (circleFacts !== undefined ? circleFacts.diameterMm : driving.valueMm);
    const layout = dimensionLayout(entity, dimension, entity.kind === "circle" ? shown / 2 : shown, px);
    const next: DimensionEditState = {
      ...(circleFacts?.diameterConstraint === true ? { diameterConstraint: true } : {}),
      entityId: entity.id,
      dimension,
      anchor: anchorOverride ?? layout?.textAt ?? entityAnchor(entity),
      label: dimension === "arc-length" ? "Arc length" : dimension === "perimeter" ? "Perimeter" : entity.kind === "arc" ? "Radius" : entity.kind === "circle" ? "Diameter" : dimension === "width" ? "Width" : dimension === "height" ? "Height" : "Length",
      storedValue: driving === undefined ? undefined : shown,
      wasReference,
      ...(driving?.expression === undefined ? {} : { boundExpression: entity.kind === "circle" && driving.dimension !== "diameter" ? unhalvedExpression(driving.expression) : driving.expression })
    };
    // Opened after the press has finished: the browser moves focus off the editor on mouse-down, which would close it again at once.
    window.setTimeout(() => {
      setDimensionEdit(next);
      setDimensionReference(wasReference);
      // A dimension bound to an expression shows the expression, so it can be edited as text; a circle shows its diameter.
      const bound = driving?.expression === undefined ? undefined : entity.kind === "circle" && driving.dimension !== "diameter" ? unhalvedExpression(driving.expression) : driving.expression;
      setDimensionText(bound ?? dimensionEditText(shown, dimensionDisplay));
    }, 0);
  };

  /** Opens the value editor for an existing angle, arc-length or perimeter dimension (or a reference length, width, height or radius), from a double-click on its text. */
  const openExtraDimensionEditor = (constraint: WorkbenchSketchConstraint, anchor: Vec2): void => {
    const reference = constraint.driven === true;
    const plain: readonly string[] = ["length", "width", "height", "radius"];
    // A distance between points, to a line or between lines, and an ellipse's radii, are edited under their own solver names.
    const named = isPointDistanceConstraint(constraint) || isEllipseRadiusConstraint(constraint) ? constraint.dimension : undefined;
    if (named !== undefined && constraint.dimension !== undefined) {
      const measuredNamed = reference ? measureDimensionConstraint(props.sketch, constraint) : constraint.valueMm;
      if (measuredNamed === undefined) return;
      const labels: Readonly<Record<string, string>> = { aligned: "Distance", horizontal: "Horizontal distance", vertical: "Vertical distance", "point-line": "Distance to the line", "line-line": "Distance between the lines", "major-radius": "Major radius", "minor-radius": "Minor radius" };
      const edit: DimensionEditState = {
        entityId: constraint.entityIds[0]!, dimension: "length", anchor, label: labels[constraint.dimension] ?? "Distance", storedValue: reference ? undefined : measuredNamed, wasReference: reference,
        ...(constraint.entityIds[1] === undefined ? {} : { secondEntityId: constraint.entityIds[1] }),
        named: { dimension: constraint.dimension, ...(constraint.points === undefined ? {} : { points: constraint.points }) },
        ...(reference || constraint.expression === undefined ? {} : { boundExpression: constraint.expression })
      };
      window.setTimeout(() => { setDimensionEdit(edit); setDimensionReference(reference); setDimensionText(!reference && constraint.expression !== undefined ? constraint.expression : dimensionEditText(measuredNamed, dimensionDisplay)); }, 0);
      return;
    }
    const name: DrivingDimension = constraint.kind === "angle" ? "angle" : constraint.kind === "arc-length" ? "arc-length" : constraint.kind === "perimeter" ? "perimeter" : constraint.kind === "radius" ? "radius" : constraint.dimension === "width" ? "width" : constraint.dimension === "height" ? "height" : "length";
    const measured = reference ? measureDimensionConstraint(props.sketch, constraint) : undefined;
    const value = reference ? measured : constraint.kind === "angle" ? constraint.valueDeg : constraint.valueMm;
    if (value === undefined) return;
    const owner = props.sketch.entities.find((entity) => entity.id === constraint.entityIds[0]);
    const diameter = owner?.kind === "circle" && name === "radius";
    // A Diameter dimension already stores (and a reference diameter already measures) the diameter; only a radius is doubled.
    const alreadyDiameter = constraint.dimension === "diameter";
    const shown = diameter && !alreadyDiameter ? value * 2 : value;
    const label = name === "angle" ? "Angle (degrees)" : name === "arc-length" ? "Arc length" : name === "perimeter" ? "Perimeter" : diameter ? "Diameter" : name === "width" ? "Width" : name === "height" ? "Height" : name === "radius" ? "Radius" : "Length";
    // A dimension bound to a parameter shows its expression (a circle's as the diameter), so it can be edited as text.
    const boundText = reference || constraint.expression === undefined ? undefined : diameter && !alreadyDiameter ? unhalvedExpression(constraint.expression) : constraint.expression;
    const next: DimensionEditState = { entityId: constraint.entityIds[0]!, dimension: name, anchor, label, storedValue: reference ? undefined : shown, wasReference: reference, ...(alreadyDiameter && diameter ? { diameterConstraint: true } : {}), ...(constraint.entityIds[1] === undefined ? {} : { secondEntityId: constraint.entityIds[1] }), ...(boundText === undefined ? {} : { boundExpression: boundText }) };
    window.setTimeout(() => {
      setDimensionEdit(next);
      setDimensionReference(reference);
      setDimensionText(boundText ?? (name === "angle" ? String(Number(shown.toPrecision(12))) : dimensionEditText(shown, dimensionDisplay)));
    }, 0);
  };

  /** Opens the value editor for a dimension between two picks (a distance or an angle), at the place given. */
  const openPairDimension = (found: PairDimension, anchor: Vec2): void => {
    setDimensionFirst(undefined);
    setDimensionPlacement(undefined);
    const driving = found.existing !== undefined && !found.existing.reference ? found.existing : undefined;
    const reference = found.existing?.reference === true;
    const shown = driving?.value ?? found.measured;
    const bound = driving?.expression === undefined ? {} : { boundExpression: driving.expression };
    const edit: DimensionEditState = found.dimension === "angle"
      ? { entityId: found.entityId, secondEntityId: found.secondEntityId, dimension: "angle", anchor, label: found.label, storedValue: driving?.value, wasReference: reference, ...bound }
      : { entityId: found.entityId, secondEntityId: found.secondEntityId, dimension: "length", anchor, label: found.label, storedValue: driving?.value, wasReference: reference, named: { dimension: found.dimension, ...(found.points === undefined ? {} : { points: found.points }) }, ...bound };
    setSelectionIds([found.entityId, found.secondEntityId].filter((entityId) => !isSketchDatumEntityId(entityId)));
    setSelectedProfileIds([]);
    // Opened after the press has finished, like the one-curve editor.
    window.setTimeout(() => {
      setDimensionEdit(edit);
      setDimensionReference(reference);
      setDimensionText(driving?.expression ?? (found.dimension === "angle" ? String(Number(shown.toPrecision(12))) : dimensionEditText(shown, dimensionDisplay)));
    }, 0);
    props.onMessage(`${found.label}${found.existing === undefined ? "" : " (already dimensioned)"}: type the value and press Enter. Esc closes the editor.`);
  };
  /** The click that places a dimension between two picked points: where it lands chooses straight, horizontal or vertical. */
  const placeDimensionAt = (at: Vec2): void => {
    const placement = dimensionPlacement;
    if (placement === undefined) return;
    const found = placePointDistance(props.sketch, placement, at);
    setDimensionPlacement(undefined);
    if (typeof found === "string") { props.onMessage(found); return; }
    openPairDimension(found, at);
  };
  /** Acts on what two picks resolve to. False when they make no dimension, so the second pick starts over as a first pick. */
  const takeDimensionPair = (pair: DimensionPairResult, anchor: Vec2): boolean => {
    if (pair.status === "none") { props.onMessage(pair.message); return false; }
    if (pair.status === "ready") { openPairDimension(pair.dimension, anchor); return true; }
    setDimensionFirst(undefined);
    setDimensionEdit(undefined);
    setDimensionPlacement(pair.placement);
    setSelectionIds([pair.placement.entityId, pair.placement.secondEntityId].filter((entityId) => !isSketchDatumEntityId(entityId)));
    setSelectedProfileIds([]);
    // The two points are shown picked, with the line between them, while the dimension waits to be placed.
    const ends = [[pair.placement.entityId, pair.placement.points[0]], [pair.placement.secondEntityId, pair.placement.points[1]]] as const;
    setDimensionPoints(ends.flatMap(([entityId, ref]) => [...dimensionHandleEntities.flatMap(dimensionHandles), ORIGIN_POINT].filter((candidate) => candidate.entityId === entityId && solverPointRef(candidate) === ref).slice(0, 1)));
    props.onMessage(pair.prompt);
    return true;
  };

  const commitDimensionEdit = (): void => {
    const edit = dimensionEdit;
    if (edit === undefined) return;
    setDimensionFirst(undefined);
    const entity = props.sketch.entities.find((candidate) => candidate.id === edit.entityId);
    const second = edit.secondEntityId === undefined ? undefined : { secondEntityId: edit.secondEntityId };
    const pointsOf = edit.named?.points === undefined ? {} : { points: edit.named.points };
    // Reference: the dimension is measured and never moves the geometry.
    if (dimensionReference) {
      if (edit.wasReference) { props.onMessage("This is already a reference dimension. Untick Reference to make it drive the geometry."); setDimensionEdit(undefined); return; }
      setDimension(edit.entityId, edit.named?.dimension ?? edit.dimension, 1, { driven: true, ...(second ?? {}), ...pointsOf });
      setDimensionEdit(undefined);
      return;
    }
    // Every kind of dimension takes a number (with a unit if wanted) or a parameter expression such as plate_w / 4, which binds it.
    const angle = edit.dimension === "angle" && edit.named === undefined;
    const name = edit.named?.dimension ?? edit.dimension;
    const read = readDimensionText(dimensionText, { unit: props.displayUnit ?? "mm", subject: edit.label.toLowerCase(), ...(angle ? { angle: true } : {}), ...(dimensionAllowsZero(name) ? { zeroAllowed: true } : {}) });
    if (read.kind === "invalid") { props.onMessage(read.message); return; }
    // Enter without typing changes nothing: the editor starts from the exact stored value (or the bound expression), so there is nothing to re-drive.
    if (!edit.wasReference) {
      if (read.kind === "expression" && edit.boundExpression !== undefined && read.expression === edit.boundExpression) { props.onMessage("The dimension is already bound to that expression; nothing changed."); setDimensionEdit(undefined); return; }
      if (read.kind === "value" && edit.boundExpression === undefined && edit.storedValue !== undefined && sameDimensionValue(read.value, edit.storedValue)) { props.onMessage("The dimension already has that value; nothing changed."); setDimensionEdit(undefined); return; }
    }
    if (edit.named !== undefined) {
      const request = applyOf(edit.named.dimension, read);
      setDimension(edit.entityId, request.dimension, request.valueMm, { ...(second ?? {}), ...pointsOf, ...(request.expression === undefined ? {} : { expression: request.expression }) });
      setDimensionEdit(undefined);
      return;
    }
    // A circle is dimensioned by its diameter on the canvas; the model stores the radius, or the diameter when that is the dimension it holds.
    const request = entity?.kind === "circle" && edit.dimension === "radius" ? circleDiameterApply(read, edit.diameterConstraint === true) : applyOf(edit.dimension, read);
    setDimension(edit.entityId, request.dimension, request.valueMm, { ...(second ?? {}), ...(request.expression === undefined ? {} : { expression: request.expression }) });
    setDimensionEdit(undefined);
  };

  /**
   * One pick for the active constraint tool: a curve that was clicked, or one of the blue point squares. The pure step function decides
   * whether the relation is complete; a complete one is added and the tool stays on for the next.
   */
  const takeToolPick = (next: ConstraintToolPick): void => {
    if (pickRelation === null) return;
    const step = constraintToolStep(pickRelation, toolPicks, next);
    setToolPicks(step.picks);
    if (step.status === "refused") { props.onMessage(step.message); return; }
    if (step.status === "ready") props.onAddConstraint({ id: `constraint:user-${crypto.randomUUID()}`, ...step.constraint });
    props.onMessage(step.prompt);
  };
  const pickRelationPoint = (picked: RelationPoint): void => {
    takeToolPick({ entityId: picked.entityId, kind: isSketchDatumEntityId(picked.entityId) ? "origin" : props.sketch.entities.find((entity) => entity.id === picked.entityId)?.kind ?? "point", ref: picked.ref, label: picked.label });
  };

  /** Starts a constraint tool, or ends it when it is the one that is already on (a second press of its button or key). */
  const toggleConstraintTool = (relation: ConstraintToolKind): void => {
    if (pickRelation !== relation) { startPickRelation(relation); return; }
    setPickRelation(null);
    setToolPicks([]);
    props.onMessage(`${CONSTRAINT_TOOL_INFO[relation].label} finished.`);
  };
  const startPickRelation = (relation: ConstraintToolKind): void => {
    // A constraint tool reads the canvas clicks itself: it ends Sketch Dimension, an edit tool and a drawing tool.
    if (props.dimensionMode) props.onExitDimension();
    if (props.editTool !== null) props.onCloseEditTool();
    if (props.tool !== "select") props.onActivateTool("select");
    setPickRelation(relation);
    setToolPicks([]);
    props.onMessage(`${CONSTRAINT_TOOL_INFO[relation].label}: ${CONSTRAINT_TOOL_INFO[relation].prompt} Esc finishes.`);
  };

  const selectEntity = (id: string, additive: boolean): void => {
    if (pickRelation !== null) {
      const entity = props.sketch.entities.find((candidate) => candidate.id === id);
      if (entity !== undefined) takeToolPick({ entityId: id, kind: entity.kind, label: entityNames.get(id) ?? entity.kind });
      return;
    }
    if (!additive) setSelectedConstraintIds([]);
    if (activeFit !== undefined && activeFit.entityId !== id) setActiveFit(undefined);
    if (props.dimensionMode && !additive) {
      // The click that places a two-point dimension may land on a curve.
      if (dimensionPlacement !== undefined) { placeDimensionAt(cursor); return; }
      // A second curve after a first: the distance or the angle between the two.
      if (dimensionFirst !== undefined && dimensionFirst.entityId !== id && takeDimensionPair(resolveDimensionPair(props.sketch, dimensionFirst, { entityId: id }), cursor)) return;
    }
    if (props.viewportState.selectionFilter === "profile") {
      const profile = profiles.find((candidate) => candidate.entityIds.includes(id));
      if (profile !== undefined) selectProfile(profile, additive);
      else props.onMessage("This curve does not bound a closed profile yet. Close the outline (Sketch Checking lists every open end), or pick another curve.");
      return;
    }
    const intentIds = props.viewportState.selectionFilter === "connected"
      ? selectConnectedSketchEntities(props.sketch, id)
      : props.viewportState.selectionFilter === "tangent"
        ? selectTangentSketchEntities(props.sketch, id)
        : [id];
    if (intentIds.length > 1) {
      const next = additive ? [...new Set([...selectionIds, ...intentIds])] : intentIds;
      setSelectionIds(next);
      setSelectedProfileIds([]);
      props.onSelect(id);
      const branchCount = sketchChainBranchCount(props.sketch, intentIds);
      props.onMessage(`${props.viewportState.selectionFilter === "tangent" ? "Tangent" : "Connected"} intent selected ${intentIds.length} curves${branchCount > 0 ? ` across ${branchCount} branch endpoint(s); review the highlighted chain` : ""}.`);
      return;
    }
    if (!additive) {
      setSelectionIds([id]);
      setSelectedProfileIds([]);
      props.onSelect(id);
      if (props.dimensionMode) {
        const entity = props.sketch.entities.find((candidate) => candidate.id === id);
        setDimensionFirst(entity === undefined ? undefined : { entityId: id });
        setDimensionPoints(entity === undefined || entity.visible === false ? [] : defaultDimensionPoints(entity));
        if (entity?.kind === "rectangle") {
          // Width or height, whichever edge the click was nearer to, measured in the rectangle's own frame.
          const radians = (entity.rotationDeg * Math.PI) / 180;
          const dx = cursor[0] - entity.center[0];
          const dy = cursor[1] - entity.center[1];
          const localX = dx * Math.cos(radians) + dy * Math.sin(radians);
          const localY = -dx * Math.sin(radians) + dy * Math.cos(radians);
          openDimensionEditor(entity, Math.abs(Math.abs(localY) - entity.heightMm / 2) <= Math.abs(Math.abs(localX) - entity.widthMm / 2) ? "width" : "height", cursor);
        } else if (entity !== undefined) {
          openDimensionEditor(entity, entity.kind === "circle" ? "radius" : "length", cursor);
        }
        props.onMessage("Type the value and press Enter, or click a second curve or point for the distance or the angle between the two. Esc closes the editor.");
      }
      return;
    }
    // Keep a generous selection for Offset, Mirror and Pattern; pair and triple relations use the last two or three picked.
    const nextSelection = selectionIds.includes(id) ? selectionIds.filter((entry) => entry !== id) : [...selectionIds, id].slice(-60);
    setSelectionIds(nextSelection);
    if (props.dimensionMode) {
      // Two lines picked in Sketch Dimension: dimension the angle between them.
      const [firstLine, secondLine] = nextSelection.slice(-2).map((entryId) => props.sketch.entities.find((candidate) => candidate.id === entryId));
      if (firstLine?.kind === "line" && secondLine?.kind === "line") {
        const existing = props.sketch.constraints.find((constraint) => constraint.kind === "angle" && constraint.driven !== true && constraint.entityIds[0] === firstLine.id && constraint.entityIds[1] === secondLine.id);
        const shown = existing?.valueDeg ?? angleBetweenLinesDeg(firstLine, secondLine);
        const layout = angleDimensionLayout(firstLine, secondLine, shown, px);
        const next: DimensionEditState = { entityId: firstLine.id, secondEntityId: secondLine.id, dimension: "angle", anchor: layout?.textAt ?? entityAnchor(firstLine), label: "Angle (degrees)", storedValue: existing?.valueDeg, wasReference: false };
        window.setTimeout(() => { setDimensionEdit(next); setDimensionReference(false); setDimensionText(String(Number(shown.toPrecision(12)))); }, 0);
        props.onMessage("Type the angle in degrees from the first line to the second and press Enter.");
        return;
      }
    }
    props.onMessage("Multi-selection updated. Pair relations use the last two entities picked; Symmetric uses the last three, axis last.");
  };

  const selectDimensionPoint = (point: SketchDimensionPoint): void => {
    if (dimensionPlacement !== undefined) { placeDimensionAt(point.point); return; }
    // A point after a clicked curve: the distance between the two (to the line, or between the point and the curve's centre).
    const pickedRef = solverPointRef(point);
    if (dimensionFirst !== undefined && dimensionFirst.ref === undefined && dimensionFirst.entityId !== point.entityId && pickedRef !== undefined
      && takeDimensionPair(resolveDimensionPair(props.sketch, dimensionFirst, { entityId: point.entityId, ref: pickedRef }), point.point)) return;
    setDimensionFirst(undefined);
    if (!isSketchDatumEntityId(point.entityId)) {
      setSelectionIds([point.entityId]);
      setSelectedProfileIds([]);
      props.onSelect(point.entityId);
    }
    const next = dimensionPoints.some((candidate) => candidate.id === point.id)
      ? dimensionPoints.filter((candidate) => candidate.id !== point.id)
      : dimensionPoints.length < 2 ? [...dimensionPoints, point] : [point];
    setDimensionPoints(next);
    const resolved = next.length === 2 ? resolveDirectSketchDimension(next) : undefined;
    // Two points of the solver's curves: the next click places the distance between them and opens its value on the canvas.
    if (resolved !== undefined && resolved.driving === undefined && resolved.between !== undefined) {
      const pair = resolveDimensionPair(props.sketch, { entityId: resolved.between.entityId, ref: resolved.between.points[0] }, { entityId: resolved.between.secondEntityId, ref: resolved.between.points[1] });
      if (pair.status === "place") {
        setDimensionPlacement(pair.placement);
        props.onMessage(`${next[0]!.label} to ${next[1]!.label}: ${pair.prompt.charAt(0).toLowerCase()}${pair.prompt.slice(1)}`);
        return;
      }
    }
    const target = resolved?.driving === undefined ? undefined : props.sketch.entities.find((entity) => entity.id === resolved.driving!.entityId);
    if (resolved !== undefined && target !== undefined) {
      openDimensionEditor(target, resolved.driving!.dimension, [(resolved.first.point[0] + resolved.second.point[0]) / 2, (resolved.first.point[1] + resolved.second.point[1]) / 2]);
      props.onMessage(`${resolved.label}: type the value and press Enter.`);
      return;
    }
    props.onMessage(next.length === 0
      ? "Definition point cleared. Pick a point to start a dimension."
      : next.length === 1
        ? `${next[0]!.label} selected. Pick a second definition point.`
        : resolved === undefined
          ? "Point-to-point dimension selected."
          : `Reference distance ${formatLengthLabel(resolved.valueMm, dimensionDisplay)} (ΔX ${formatLengthLabel(resolved.delta[0], dimensionDisplay)}, ΔY ${formatLengthLabel(resolved.delta[1], dimensionDisplay)}). A driving distance between two different curves needs the two-curve dimension; this is measured only.`);
  };

  const selectProfile = (profile: SketchProfile, additive: boolean): void => {
    setSelectionIds([]);
    const next = additive
      ? selectedProfileIds.includes(profile.id) ? selectedProfileIds.filter((id) => id !== profile.id) : [...selectedProfileIds, profile.id]
      : [profile.id];
    setSelectedProfileIds(next);
    if (!additive) props.onSelect(profile.id);
    props.onMessage(`${next.length} closed sketch profile${next.length === 1 ? "" : "s"} selected for a feature.`);
  };

  const constrain = (kind: SketchConstraintKind): void => {
    if (selectedEntities.length === 0) return;
    const pairKinds: readonly SketchConstraintKind[] = ["parallel", "perpendicular", "tangent", "collinear", "coincident", "concentric", "equal", "midpoint", "symmetry"];
    // Symmetric takes two entities and the axis line last; every other pair relation takes the last two selected.
    const needed = kind === "symmetry" ? 3 : 2;
    const entityIds = pairKinds.includes(kind) ? selectionIds.slice(-needed) : [selectedEntities.at(-1)!.id];
    if (pairKinds.includes(kind) && entityIds.length !== needed) {
      props.onMessage(kind === "symmetry" ? "Symmetric needs three entities: the two to mirror, then the axis line last. Shift-click to add them." : `${kind} needs two entities. Shift-click the second entity.`);
      return;
    }
    props.onAddConstraint({ id: `constraint:user-${crypto.randomUUID()}`, kind, entityIds });
  };

  // Pair relations act on the last two entities picked and Symmetric on the last three, so a larger selection (for Offset or Pattern) does not disable them.
  // Every Constrain button asks the same rule table the live solver and the analysis use, so a button is enabled exactly when the relation will be enforced.
  const lastTwo = selectedEntities.length >= 2 ? selectedEntities.slice(-2) : [];
  const lastThree = selectedEntities.length >= 3 ? selectedEntities.slice(-3) : [];
  const fitOne = (kind: SketchConstraintKind): ConstraintFit => selectedEntities.length === 1 ? constraintFit(kind, [selectedEntities[0]!.kind]) : { ok: false, reason: "Select exactly one curve." };
  const fitTwo = (kind: SketchConstraintKind): ConstraintFit => lastTwo.length === 2 ? constraintFit(kind, lastTwo.map((entity) => entity.kind)) : { ok: false, reason: "Select two curves; Shift-click the second." };
  const fitThree = (): ConstraintFit => lastThree.length === 3 ? constraintFit("symmetry", lastThree.map((entity) => entity.kind)) : { ok: false, reason: "Select the two curves to mirror, then the axis line last." };
  const fixedIds = selectedEntity === undefined ? [] : props.sketch.constraints.filter((constraint) => constraint.kind === "fixed" && constraint.suppressed !== true && constraint.entityIds.includes(selectedEntity.id)).map((constraint) => constraint.id);
  // Horizontal and Vertical apply to every selected line; the other one-curve actions apply to the whole selection too.
  const fitEach = (kind: "horizontal" | "vertical"): ConstraintFit => selectedEntities.some((entity) => constraintFit(kind, [entity.kind]).ok) ? { ok: true } as ConstraintFit : { ok: false, reason: selectedEntities.length === 0 ? "Select one or more lines." : "None of the selected curves is a line." };
  const horizontalFit = fitEach("horizontal");
  const verticalFit = fitEach("vertical");
  const selectionFixed = selectionIsFixed(props.sketch, selectionIds);
  const selectionCount = selectionIds.length;
  const scopeSuffix = selectionCount > 1 ? ` (${selectionCount})` : "";
  const parallelFit = fitTwo("parallel");
  const perpendicularFit = fitTwo("perpendicular");
  const collinearFit = fitTwo("collinear");
  const concentricFit = fitTwo("concentric");
  const equalFit = fitTwo("equal");
  const tangentFit = fitTwo("tangent");
  const symmetricFit = fitThree();
  const hint = (fit: ConstraintFit, enabled: string): string => fit.ok ? enabled : fit.reason;
  const movableIds = useMemo(() => new Set(Object.entries(analysis.entityFreedom).filter(([, freedom]) => freedom > 0).map(([id]) => id)), [analysis.entityFreedom]);

  // Ribbon one-shot commands act on the current selection. A fresh mount only records the serial, so a workspace switch never replays one.
  const handledRequestRef = useRef(props.request?.serial ?? 0);
  useEffect(() => {
    const request = props.request;
    if (request === null || request.serial === handledRequestRef.current) return;
    handledRequestRef.current = request.serial;
    if (request.command.startsWith("constraint:")) {
      const relation = request.command.slice("constraint:".length);
      if (isConstraintToolKind(relation)) toggleConstraintTool(relation);
      return;
    }
    if (selectionIds.length === 0) { props.onMessage("Select one or more curves first."); return; }
    if (request.command === "fix-curve") { runSelectionAction(fixSelectionPlan(props.sketch, selectedEntities, newConstraintId)); return; }
    const family = request.command === "relax-relations" ? "relations" : "dimensions";
    const active = constraintsOnEntities(props.sketch, selectionIds, family, false);
    const relaxed = constraintsOnEntities(props.sketch, selectionIds, family, true);
    if (active.length > 0) props.onSetSuppressed(active, true);
    else if (relaxed.length > 0) props.onSetSuppressed(relaxed, false);
    else props.onMessage(`The selection has no ${family === "relations" ? "geometric relations" : "driving dimensions"} to relax or restore.`);
  }, [props.request]);

  /** Select Other: picks the next curve among the ones under the pointer, and shows the list so any of them can be picked directly. */
  const cycleSelectOther = (candidates: readonly SelectOtherCandidate[], fromKeyboard: boolean, canvasAt?: readonly [number, number]): void => {
    if (candidates.length === 0) { props.onMessage("No curve under the pointer. Move onto a curve and try again; Alt-click cycles curves that overlap."); return; }
    const current = selectionIds.length === 1 ? selectionIds[0] : undefined;
    const next = nextInCycle(candidates, current);
    if (next === undefined) return;
    // The list opens next to the pointer (Alt-click) or the cursor (Tab), kept inside the canvas.
    const screen = canvasAt ?? sketchToScreen(cursor, { left: 0, top: 0, width: camera.size.width, height: camera.size.height }, camera.camera);
    const at: readonly [number, number] = [Math.max(8, Math.min(screen[0] + 14, camera.size.width - 240)), Math.max(8, Math.min(screen[1] + 14, camera.size.height - 40 - candidates.length * 28))];
    setSelectionIds([next]);
    setSelectedProfileIds([]);
    props.onSelect(next);
    setSelectOther({ candidates, at });
    const label = candidates.find((candidate) => candidate.id === next)?.label ?? next;
    props.onMessage(`Select other: ${label} (${candidates.findIndex((candidate) => candidate.id === next) + 1} of ${candidates.length} under the pointer). ${fromKeyboard ? "Tab" : "Alt-click"} again for the next.`);
  };

  /** Every inspector button, ribbon command and hotkey that edits the selection goes through here, so they all act on the whole selection. */
  const runSelectionAction = (result: SelectionActionResult): boolean => {
    if (!result.ok) { props.onMessage(result.message); return false; }
    return props.onApplyEdit(result.plan) !== false;
  };
  const removeActiveFitPoint = (): boolean => {
    if (activeFit === undefined) return false;
    const spline = props.sketch.entities.find((entity) => entity.id === activeFit.entityId);
    if (spline?.kind !== "spline") return false;
    const edited = removeSplineFitPoint(spline, activeFit.index);
    if (!edited.ok) { props.onMessage(edited.message); return true; }
    if (props.onApplyEdit({ label: `Removed spline point ${activeFit.index + 1}`, removeEntityIds: [], updateEntities: [edited.entity], addEntities: [], addConstraints: [] }) !== false) setActiveFit({ entityId: spline.id, index: edited.index });
    return true;
  };
  const deleteSelectedConstraints = (ids: readonly string[]): void => {
    const present = ids.filter((id) => props.sketch.constraints.some((constraint) => constraint.id === id));
    if (present.length === 0) return;
    // One undo step for the lot: a single edit that removes the relations by ID.
    const accepted = props.onApplyEdit({ label: `Deleted ${present.length} relation${present.length === 1 ? "" : "s"}`, removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], removeConstraintIds: present });
    if (accepted !== false) setSelectedConstraintIds((current) => current.filter((id) => !present.includes(id)));
  };
  const selectConstraint = (id: string, additive: boolean): void => {
    setSelectedConstraintIds((current) => additive ? (current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id]) : [id]);
    if (!additive) { setSelectionIds([]); setSelectedProfileIds([]); props.onSelect(null); }
    const constraint = props.sketch.constraints.find((candidate) => candidate.id === id);
    if (constraint !== undefined) props.onMessage(`${describeConstraint(constraint, entityLabels)} selected. Press Delete to remove it.`);
  };
  const frameSelection = (): void => {
    const extents = selectionExtents(visibleEntities, selectionIds);
    if (extents === undefined) { props.onMessage("Select one or more curves first, then zoom to them."); return; }
    camera.frame(extents);
    props.onMessage(`Zoomed to ${selectionIds.length} selected curve${selectionIds.length === 1 ? "" : "s"}.`);
  };
  /** Ends Zoom window or Measure, if either is on. */
  const endModalModes = (): boolean => {
    if (!zoomWindowMode && !measureMode) return false;
    modalContext.current = undefined;
    setZoomWindowMode(false);
    setMeasureMode(false);
    setMeasureState(EMPTY_MEASURE);
    setSelectionBox(undefined);
    boxGesture.current = undefined;
    return true;
  };
  const startZoomWindow = (): void => {
    setMeasureMode(false);
    modalContext.current = { tool: props.tool, editTool: props.editTool, dimensionMode: props.dimensionMode };
    setZoomWindowMode(true);
    props.onMessage("Zoom window: drag a rectangle on the canvas. Esc cancels.");
  };
  const startMeasure = (): void => {
    setZoomWindowMode(false);
    setMeasureState(EMPTY_MEASURE);
    // Measure reads the canvas clicks itself: a drawing tool, an edit tool or Sketch Dimension must not also act on them.
    modalContext.current = MEASURE_CONTEXT;
    setMeasureMode(true);
    if (props.editTool !== null) props.onCloseEditTool();
    if (props.dimensionMode) props.onExitDimension();
    if (props.tool !== "select") props.onActivateTool("select");
    props.onMessage("Measure: click two points for a distance, or two lines for an angle. Nothing is added to the sketch. Esc finishes.");
  };

  const handleHotkey = (action: SketchHotkeyAction): void => {
    // Escape (and V) end Zoom window or Measure first, whatever else Escape would back out of next.
    if ((zoomWindowMode || measureMode) && (action.kind === "cancel-points" || action.kind === "exit-pick" || action.kind === "exit-dimension" || action.kind === "select-tool" || action.kind === "clear-selection")) {
      endModalModes();
      props.onMessage("Zoom window or Measure finished. Pick a tool, or click a curve to select it.");
      return;
    }
    switch (action.kind) {
      case "tool": props.onActivateTool(action.tool); return;
      case "dimension": props.onActivateDimension(); return;
      case "edit-tool": props.onActivateEditTool(action.tool); return;
      case "constraint-tool": toggleConstraintTool(action.tool); return;
      case "project":
        if (props.onProjectBody === undefined) props.onMessage("Project is on the ribbon: Project, body edges.");
        else props.onProjectBody();
        return;
      case "fit": camera.fit(); props.onMessage("Fitted the sketch to the window."); return;
      case "pan-mode": props.onNavigationMode("pan"); return;
      case "select-tool":
        props.onActivateTool("select");
        if (props.viewportState.navigationMode !== "select") props.onNavigationMode("select");
        return;
      case "cancel-points": setPending([]); props.onMessage("Cancelled the points placed so far."); return;
      case "undo-point": setPending((current) => current.slice(0, -1)); return;
      case "cancel-drag":
        dragGesture.current = undefined;
        dragLatest.current = undefined;
        setDragLive(undefined);
        setInference(undefined);
        props.onMessage("Move cancelled; the curve is back where it was.");
        return;
      case "exit-pick":
        if (centrePick.picking) { centrePick.cancel(); props.onMessage("Centre picking cancelled. Type the centre, or press Pick on canvas to try again."); return; }
        setPickRelation(null); setToolPicks([]); props.onMessage(pickRelation === null ? "Relation picking cancelled." : `${CONSTRAINT_TOOL_INFO[pickRelation].label} finished.`); return;
      case "exit-dimension": props.onExitDimension(); return;
      case "exit-edit-tool":
        // Esc also ends the zoom window and the Measure tool, which behave like edit tools.
        if (endModalModes()) { props.onMessage("Zoom window or Measure finished. Pick a tool, or click a curve to select it."); return; }
        props.onCloseEditTool();
        return;
      case "clear-selection":
        setSelectOther(undefined);
        setSelectionIds([]);
        setSelectedProfileIds([]);
        setSelectedConstraintIds([]);
        setActiveFit(undefined);
        props.onSelect(null);
        return;
      case "delete-selection":
        if (selectionIds.length === 0) return;
        // With a spline fit point picked, Delete removes that point; otherwise it removes the selected curves.
        if (selectionIds.length === 1 && activeFit?.entityId === selectionIds[0] && removeActiveFitPoint()) return;
        if (runSelectionAction(deleteSelectionPlan(props.sketch, selectionIds))) { setSelectionIds([]); props.onSelect(null); }
        return;
      case "toggle-draw-construction":
        setDrawAsConstruction(!drawAsConstruction);
        props.onMessage(drawAsConstruction ? DRAW_CONSTRUCTION_OFF_MESSAGE : drawConstructionOnMessage(keyLabelForCommand("toggle-draw-construction", sketchKeymap) ?? keyLabelForCommand("toggle-construction", sketchKeymap)));
        return;
      case "delete-constraints": deleteSelectedConstraints(selectedConstraintIds); return;
      case "zoom-window": startZoomWindow(); return;
      case "zoom-selection": frameSelection(); return;
      case "measure": if (measureMode) { setMeasureMode(false); setMeasureState(EMPTY_MEASURE); props.onMessage("Measure finished."); } else startMeasure(); return;
      case "toggle-construction": runSelectionAction(constructionSelectionPlan(selectedEntities)); return;
      case "finish":
        if (props.tool === "spline-control") { if (pending.length >= 3) finishControlSpline(pending, false); return; }
        if (props.tool === "profile") { profileChain.current = undefined; setPending([]); props.onMessage("Profile finished."); return; }
        if (pending.length >= 2) finishSpline(pending);
        return;
      case "type-value": {
        const first = dynamicFields[0];
        if (first === undefined) return;
        setField(first.id, action.key === "," ? "." : action.key);
        requestFieldFocus(first.id);
        return;
      }
      case "focus-dynamic": {
        const target = action.backwards ? dynamicFields.at(-1) : dynamicFields[0];
        if (target !== undefined) requestFieldFocus(target.id);
        return;
      }
      case "commit-dynamic": void commitDynamicInput(); return;
      case "select-other": cycleSelectOther(hoverStack, true); return;
      case "toggle-snap": updateAssist({ snap: !assist.snap }); props.onMessage(`Snap ${assist.snap ? "off" : "on"}.`); return;
      case "toggle-ortho": updateAssist({ ortho: !assist.ortho }); props.onMessage(`Ortho lock ${assist.ortho ? "off" : "on"}.`); return;
      case "toggle-polar": updateAssist({ polar: !assist.polar }); props.onMessage(assist.polar ? "Polar tracking off." : `Polar tracking on (${assist.polarIncrementDeg}° steps).`); return;
      case "end-chain": setPending([]); props.onMessage("Line chain ended. The segments already placed are kept."); return;
      case "copy": copySelection(false); return;
      case "cut": copySelection(true); return;
      case "paste": pasteClipboard(); return;
      case "select-all": {
        const ids = visibleEntities.map((entity) => entity.id);
        setSelectionIds(ids);
        setSelectedProfileIds([]);
        props.onSelect(ids.at(-1) ?? null);
        props.onMessage(`Selected all ${ids.length} visible curve${ids.length === 1 ? "" : "s"}.`);
        return;
      }
    }
  };
  useSketchHotkeys({
    enabled: true,
    context: { tool: props.tool, pendingPoints: pending.length, selectionCount: selectionIds.length + selectedProfileIds.length + selectedConstraintIds.length, curveSelectionCount: selectionIds.length, constraintSelectionCount: selectedConstraintIds.length, dimensionMode: props.dimensionMode, editToolActive: props.editTool !== null || zoomWindowMode || measureMode, pickingRelation: pickRelation !== null || centrePick.picking, dragging: dragLive !== undefined || (dragGesture.current?.moved ?? false), dynamicFieldCount: dynamicFields.length, dynamicTyped: Object.keys(fieldText).length > 0, overlapUnderCursor: hoverStack.length },
    onAction: handleHotkey
  });

  const finishSelectionBox = (gesture: BoxGesture, endMm: Vec2): void => {
    const rect = selectionRect(gesture.startMm, endMm);
    const mode: SketchSelectionBoxMode = selectionBoxMode(gesture.startMm, endMm);
    if (props.viewportState.selectionFilter === "profile") {
      const picked = profiles.filter((profile) => profileInBox(profile, rect, mode)).map((profile) => profile.id);
      const next = gesture.additive ? [...new Set([...selectedProfileIds, ...picked])] : picked;
      setSelectionIds([]);
      setSelectedProfileIds(next);
      props.onMessage(`${mode === "window" ? "Window" : "Crossing"} selected ${picked.length} closed profile${picked.length === 1 ? "" : "s"}.`);
      return;
    }
    const picked = entitiesInSelectionBox(visibleEntities, rect, mode);
    const next = gesture.additive ? [...new Set([...selectionIds, ...picked])] : picked;
    setSelectionIds(next);
    setSelectedProfileIds([]);
    props.onSelect(next.at(-1) ?? null);
    props.onMessage(picked.length === 0
      ? `${mode === "window" ? "Window" : "Crossing"} selection found no curves. ${mode === "window" ? "Drag right to left to also take curves the box touches." : ""}`.trim()
      : `${mode === "window" ? "Window" : "Crossing"} selected ${picked.length} curve${picked.length === 1 ? "" : "s"}${gesture.additive ? " (added to the selection)" : ""}.`);
  };

  /** A press on a curve (body) or one of its grab handles: remember it; it becomes a drag once the pointer has moved a few pixels. */
  const beginDrag = (event: React.PointerEvent, entityId: string, handle: DragHandle): void => {
    if (event.button !== 0 || event.shiftKey || event.ctrlKey || event.metaKey) return;
    const svg = (event.currentTarget as Element).closest("svg");
    svg?.setPointerCapture(event.pointerId);
    dragGesture.current = {
      pointerId: event.pointerId,
      entityId,
      handle,
      startClient: [event.clientX, event.clientY],
      startMm: camera.toSketch(event.clientX, event.clientY),
      base: props.sketch,
      moved: false
    };
    dragMessage.current = "";
  };

  /** Curves that share a joint with this one move with it, so they are not snap targets for it. */
  const jointNeighbours = (id: string): readonly string[] => props.sketch.constraints
    .filter((constraint) => (constraint.kind === "coincident" || constraint.kind === "midpoint") && constraint.suppressed !== true && constraint.entityIds.includes(id))
    .flatMap((constraint) => constraint.entityIds);

  const updateDrag = (event: React.PointerEvent<SVGSVGElement>, gesture: DragGesture): void => {
    const raw = camera.toSketch(event.clientX, event.clientY);
    // Points snap to other geometry while they are dragged; moving a whole curve follows the pointer exactly.
    // Holding Ctrl while dragging a point switches snapping off, and the palette's snap step replaces the grid step.
    const snapping = snapEnabled && !(event.ctrlKey || event.metaKey) && gesture.handle.kind !== "body";
    const snap: InferenceResult | undefined = snapping
      ? inferSketchPoint(raw, sketchWithReference(gesture.base, props.reference, showReference), { toleranceMm: SNAP_PIXELS * px, gridMm: assist.snapStepMm ?? grid.minorMm, excludeEntityIds: [gesture.entityId, ...jointNeighbours(gesture.entityId)] })
      : undefined;
    const target = snap?.point ?? raw;
    setCursor(target);
    setInference(snap);
    const result = dragSketchHandle(gesture.base, gesture.entityId, gesture.handle, gesture.startMm, target, dragLatest.current?.preview.entities);
    if (!result.ok) {
      if (dragMessage.current !== result.message) { dragMessage.current = result.message; props.onMessage(result.message); }
      return;
    }
    dragMessage.current = "";
    const preview: DragPreview = { entities: result.entities, movedIds: result.movedIds };
    dragLatest.current = { preview, snap };
    setDragLive(preview);
  };

  /** Releasing a drag commits it as one undoable edit, plus the joint it earned if it was dropped on other geometry. */
  const commitDrag = (gesture: DragGesture): void => {
    const latest = dragLatest.current;
    dragLatest.current = undefined;
    setDragLive(undefined);
    setInference(undefined);
    if (latest === undefined) return;
    const before = new Map(gesture.base.entities.map((entity) => [entity.id, entity]));
    const changed = latest.preview.entities.filter((entity) => before.get(entity.id) !== entity);
    if (changed.length === 0) return;
    const dragged = latest.preview.entities.find((entity) => entity.id === gesture.entityId);
    const ref = gesture.handle.kind === "point" ? gesture.handle.ref : undefined;
    const joint = autoConstrain && dragged !== undefined && ref !== undefined
      ? dropConstraintFor({ entity: dragged, ref, primary: latest.snap?.primary, sketch: gesture.base, newId: () => `constraint:auto-${crypto.randomUUID()}` })
      : undefined;
    const name = dragged === undefined ? "curve" : dragged.kind;
    props.onApplyEdit({
      label: `Moved ${name}${changed.length > 1 ? ` and ${changed.length - 1} joined curve${changed.length > 2 ? "s" : ""}` : ""}${joint === undefined ? "" : ` and joined it (${joint.kind})`}`,
      removeEntityIds: [],
      updateEntities: changed,
      addEntities: [],
      addConstraints: joint === undefined ? [] : [joint]
    });
  };

  /** A canvas point for a picked centre: snapped to the nearest endpoint, centre, midpoint, intersection or the origin (Ctrl turns snapping off). */
  const snapCentrePoint = (point: Vec2, ctrl: boolean): Vec2 => snapPickedCentre({ sketch: props.sketch, point, toleranceMm: SNAP_PIXELS * px, gridMm: grid.minorMm, settings: assist, ctrl });

  const handleCanvasPointerDownCapture = (event: React.PointerEvent<SVGSVGElement>): void => {
    // Panning wins over everything underneath the pointer, including curves, so a middle or Space drag never selects.
    const wantsPan = event.button === 1 || (event.button === 0 && (camera.spaceHeld || navigationPan));
    // Picking a centre: the click is the centre, wherever it lands (it snaps to endpoints, centres and the origin), not a selection.
    if (!wantsPan && event.button === 0 && centrePick.picking) {
      event.stopPropagation();
      event.preventDefault();
      const point = snapCentrePoint(camera.toSketch(event.clientX, event.clientY), event.ctrlKey || event.metaKey);
      centrePick.deliver(point);
      props.onMessage(`Centre set to ${fmtNum(point[0])}, ${fmtNum(point[1])} ${unit}. Apply to use it, or click Pick on canvas to choose again.`);
      return;
    }
    // Alt-click on curves that overlap cycles through them (Select Other) instead of taking the top one.
    if (!wantsPan && event.button === 0 && event.altKey && props.tool === "select" && !props.dimensionMode && pickRelation === null && !isClickEditTool(props.editTool)) {
      event.stopPropagation();
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      cycleSelectOther(entitiesUnderPoint(props.sketch, camera.toSketch(event.clientX, event.clientY), PICK_PIXELS * px), false, [event.clientX - box.left, event.clientY - box.top]);
      return;
    }
    if (!wantsPan) return;
    event.stopPropagation();
    camera.beginPan(event);
  };

  const handleCanvasPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    setSelectOther(undefined);
    if (pickRelation !== null) return;
    if (zoomWindowMode) {
      // Zoom window: the next drag on the canvas draws the rectangle to zoom to.
      event.currentTarget.setPointerCapture(event.pointerId);
      boxGesture.current = { pointerId: event.pointerId, startClient: [event.clientX, event.clientY], startMm: camera.toSketch(event.clientX, event.clientY), additive: false, profileId: undefined, dragging: false };
      return;
    }
    if (measureMode) { measureClick(camera.toSketch(event.clientX, event.clientY)); return; }
    const selecting = props.tool === "select" && !isClickEditTool(props.editTool) && !props.dimensionMode;
    if (selecting) {
      event.currentTarget.setPointerCapture(event.pointerId);
      boxGesture.current = {
        pointerId: event.pointerId,
        startClient: [event.clientX, event.clientY],
        startMm: camera.toSketch(event.clientX, event.clientY),
        additive: event.shiftKey || event.ctrlKey || event.metaKey,
        profileId: (event.target as Element).closest<SVGElement>("[data-profile-id]")?.dataset["profileId"],
        dragging: false
      };
      return;
    }
    if (props.editTool === "trim" && props.tool === "select" && !props.dimensionMode) {
      // Press, drag across curves and release cuts them all (Power Trim); a press that never moves is an ordinary click-trim on release.
      event.currentTarget.setPointerCapture(event.pointerId);
      trimSweep.current = { pointerId: event.pointerId, startClient: [event.clientX, event.clientY], path: [camera.toSketch(event.clientX, event.clientY)] };
      return;
    }
    pointer(event, true);
  };

  const handleCanvasPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (camera.movePan(event)) return;
    if (centrePick.picking) { centrePick.setHover(snapCentrePoint(camera.toSketch(event.clientX, event.clientY), event.ctrlKey || event.metaKey)); return; }
    const labelDrag = dimensionDrag.current;
    if (labelDrag !== undefined && labelDrag.pointerId === event.pointerId) {
      // Dragging a dimension label moves its dimension line; the pointer is only captured once the press has become a drag, so a plain click or double-click still reaches the label.
      if (!labelDrag.moved) {
        if (Math.hypot(event.clientX - labelDrag.startClient[0], event.clientY - labelDrag.startClient[1]) < 4) return;
        labelDrag.moved = true;
        event.currentTarget.setPointerCapture(event.pointerId);
      }
      const layout = labelDrag.layoutAt(labelDrag.startOffsetPx);
      if (layout !== undefined) setDimensionDragOffset({ constraintId: labelDrag.constraintId, offsetPx: dragDimensionOffset(layout, labelDrag.startOffsetPx, labelDrag.startMm, camera.toSketch(event.clientX, event.clientY), px) });
      return;
    }
    const grab = dragGesture.current;
    if (grab !== undefined && grab.pointerId === event.pointerId) {
      if (!grab.moved && Math.hypot(event.clientX - grab.startClient[0], event.clientY - grab.startClient[1]) < 4) return;
      grab.moved = true;
      updateDrag(event, grab);
      return;
    }
    const gesture = boxGesture.current;
    if (gesture !== undefined && gesture.pointerId === event.pointerId) {
      if (!gesture.dragging && Math.hypot(event.clientX - gesture.startClient[0], event.clientY - gesture.startClient[1]) > 4) gesture.dragging = true;
      if (gesture.dragging) setSelectionBox({ start: gesture.startMm, end: camera.toSketch(event.clientX, event.clientY) });
      return;
    }
    const sweep = trimSweep.current;
    if (sweep !== undefined && sweep.pointerId === event.pointerId && sweep.path.length < 400) sweep.path.push(camera.toSketch(event.clientX, event.clientY));
    pointer(event, false);
  };

  const finishCanvasDrag = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (camera.endPan(event)) return;
    const sweep = trimSweep.current;
    if (sweep !== undefined && sweep.pointerId === event.pointerId) {
      trimSweep.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (event.type === "pointercancel") return;
      if (Math.hypot(event.clientX - sweep.startClient[0], event.clientY - sweep.startClient[1]) < 8) { pointer(event, true); return; }
      const swept = powerTrim(editContext(), sweep.path);
      if (!swept.ok) { props.onMessage(swept.diagnostics[0]?.message ?? "The sweep could not trim anything."); return; }
      props.onApplyEdit(swept.value);
      setSelectionIds([]);
      return;
    }
    const labelDrag = dimensionDrag.current;
    if (labelDrag !== undefined && labelDrag.pointerId === event.pointerId) {
      dimensionDrag.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      const dragged = dimensionDragOffset;
      setDimensionDragOffset(undefined);
      if (labelDrag.moved && event.type !== "pointercancel" && dragged !== undefined && dragged.constraintId === labelDrag.constraintId) {
        setDimensionOffsets((current) => ({ ...current, [labelDrag.constraintId]: dragged.offsetPx }));
        props.onMessage("Moved the dimension. Its position is remembered in this browser; it is not part of the model.");
      }
      return;
    }
    const grab = dragGesture.current;
    if (grab !== undefined && grab.pointerId === event.pointerId) {
      dragGesture.current = undefined;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      if (grab.moved && event.type !== "pointercancel") commitDrag(grab);
      else { dragLatest.current = undefined; setDragLive(undefined); }
      return;
    }
    const gesture = boxGesture.current;
    if (gesture === undefined || gesture.pointerId !== event.pointerId) return;
    boxGesture.current = undefined;
    setSelectionBox(undefined);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    if (event.type === "pointercancel") return;
    if (zoomWindowMode) {
      const extents = gesture.dragging ? zoomWindowExtents(gesture.startMm, camera.toSketch(event.clientX, event.clientY), px) : undefined;
      if (extents === undefined) { props.onMessage("Drag a rectangle to zoom to it, or press Esc to cancel."); return; }
      camera.frame(extents);
      modalContext.current = undefined;
      setZoomWindowMode(false);
      props.onMessage("Zoomed to the window.");
      return;
    }
    if (gesture.dragging && props.editTool === "stretch") {
      // With Stretch active a drag on empty canvas sets the window instead of selecting.
      const end = camera.toSketch(event.clientX, event.clientY);
      const round = (value: number): number => Number(value.toFixed(3));
      setStretchWindow({ x1: round(Math.min(gesture.startMm[0], end[0])), y1: round(Math.min(gesture.startMm[1], end[1])), x2: round(Math.max(gesture.startMm[0], end[0])), y2: round(Math.max(gesture.startMm[1], end[1])) });
      props.onMessage("Stretch window set. Select the entities, enter the distance, then Apply.");
      return;
    }
    if (gesture.dragging) { finishSelectionBox(gesture, camera.toSketch(event.clientX, event.clientY)); return; }
    // A press that never moved is a click: on a shaded profile it selects the profile, anywhere else it clears the selection.
    const profile = gesture.profileId === undefined || underlayPick.active ? undefined : profiles.find((candidate) => candidate.id === gesture.profileId);
    if (profile !== undefined) selectProfile(profile, gesture.additive);
    else if ((props.editTool === "fillet" || props.editTool === "chamfer") && props.tool === "select" && selectionIds.length === 0) {
      // With nothing selected, a click on a vertex where two curves meet rounds or cuts that corner at once.
      const click = camera.toSketch(event.clientX, event.clientY);
      const size = parseLengthField(props.editTool === "fillet" ? cornerParams.radius : cornerParams.bevel, unit);
      const done = cornerByClick(editContext(), click, PICK_PIXELS * px, props.editTool === "fillet" ? { kind: "fillet", radiusMm: size, dimension: true } : { kind: "chamfer", firstMm: size, secondMm: size });
      if (done.ok) { props.onApplyEdit(done.value); setSelectionIds([]); }
      else if (Number.isFinite(size) && !/Click on a vertex/u.test(done.diagnostics[0]?.message ?? "")) props.onMessage(done.diagnostics[0]?.message ?? "That corner could not be changed.");
      else pointer(event, true);
    } else pointer(event, true);
  };

  /** One click of the Measure tool: the first pick is remembered, the second gives the distance or the angle. Nothing is added to the sketch. */
  const measureClick = (point: Vec2): void => {
    const first = measureState.result === undefined ? measureState.picks[0] : undefined;
    const target = pickMeasureTarget(props.sketch, point, hitSizes.pickPx * px, first?.kind === "line" ? "line" : "any");
    if (target === undefined) { props.onMessage("Click on a line to measure its angle to the first line."); return; }
    const next = addMeasurePick(measureState, target);
    setMeasureState(next);
    props.onMessage(next.result !== undefined ? `${describeMeasurement(next.result)}. Click again to measure something else; Esc finishes.` : `${target.kind === "line" ? "Line" : `Point (${target.label})`} picked. Pick a second point for a distance, or a second line for an angle.`);
  };

  /** Double-click on a placed text re-opens it for editing; on the selected spline it adds a fit point where the curve is; on any other curve it selects the connected chain. */
  const handleCanvasDoubleClick = (event: React.MouseEvent<SVGSVGElement>): void => {
    handleTextDoubleClick(event);
    if (event.defaultPrevented || !interactive || props.dimensionMode) return;
    const at = camera.toSketch(event.clientX, event.clientY);
    const target = selectionIds.length === 1 ? visibleEntities.find((entity) => entity.id === selectionIds[0]) : undefined;
    if (target?.kind !== "spline") {
      // On any other curve: select the whole connected chain (Shift adds it to the selection).
      const hitId = (event.target as Element).closest<SVGElement>("[data-selection-id]")?.dataset["selectionId"];
      const hit = hitId === undefined || pickRelation !== null || props.editTool !== null ? undefined : visibleEntities.find((entity) => entity.id === hitId);
      const chain = hit === undefined || hit.kind === "spline" ? undefined : chainSelectionFor(props.sketch, hit.id, selectionIds, event.shiftKey);
      if (hit === undefined || chain === undefined) return;
      event.preventDefault();
      setSelectionIds(chain.ids);
      setSelectedProfileIds([]);
      setSelectedConstraintIds([]);
      props.onSelect(hit.id);
      props.onMessage(chain.message);
      return;
    }
    const onCurve = nearestPointOnSpline(target, at);
    if (onCurve === undefined || onCurve.distanceMm > hitSizes.pickPx * 1.5 * px) return;
    // A double-click on an existing fit point is on its handle, not a request for a new point.
    if (target.fitPoints.some((point) => Math.hypot(point[0] - at[0], point[1] - at[1]) < hitSizes.grabHitPx * px)) return;
    const edited = insertSplineFitPoint(target, at);
    if (!edited.ok) { props.onMessage(edited.message); return; }
    if (props.onApplyEdit({ label: `Added spline point ${edited.index + 1}`, removeEntityIds: [], updateEntities: [edited.entity], addEntities: [], addConstraints: [] }) !== false) {
      setActiveFit({ entityId: target.id, index: edited.index });
      props.onMessage(`Added fit point ${edited.index + 1} (${edited.entity.fitPoints.length} of ${MAX_SPLINE_FIT_POINTS} possible). Drag it, or drag its tangent handle; Delete removes it.`);
    }
  };

  /** Keys pressed while the canvas itself has the focus: walk through the curves and select them without a mouse. */
  const handleCanvasKeyDown = (event: React.KeyboardEvent<SVGSVGElement>): void => {
    if (event.target !== event.currentTarget) return;
    const action = resolveCanvasKey({ key: event.key, ctrl: event.ctrlKey, meta: event.metaKey, alt: event.altKey, shift: event.shiftKey });
    if (action === undefined || (action.kind === "select-focused" && focusedId === null)) return;
    event.preventDefault();
    event.stopPropagation();
    if (action.kind === "select-focused") {
      if (focusedId !== null) { selectEntity(focusedId, action.additive); announceFocus(focusedId, true); }
      return;
    }
    const next = focusAfter(visibleEntities, focusedId, action);
    setFocusedId(next);
    if (next !== null) announceFocus(next, selectionIds.includes(next));
  };
  const announceFocus = (id: string, selected: boolean): void => {
    const index = visibleEntities.findIndex((entity) => entity.id === id);
    const entity = visibleEntities[index];
    if (entity === undefined) return;
    setAnnouncement(describeEntityForAccessibility(entity, entityLabels.get(id) ?? entity.kind, index + 1, visibleEntities.length, selected));
  };

  const interactive = props.tool === "select" && props.viewportState.navigationMode !== "pan" && !camera.spaceHeld && !isClickEditTool(props.editTool) && !underlayPick.active;
  const box = camera.viewBox;
  const canvasClasses = [
    "sketch-canvas",
    showProfiles ? "show-profiles" : "hide-profiles",
    camera.panning ? "panning" : camera.spaceHeld || navigationPan ? "pan-ready" : "",
    dragLive !== undefined ? "dragging" : "",
    zoomWindowMode ? "zoom-window" : "",
    measureMode ? "measuring" : ""
  ].filter(Boolean).join(" ");
  const pressDimension = (entry: (typeof dimensionViews)[number], event: React.PointerEvent, additive: boolean): void => {
    selectConstraint(entry.id, additive);
    if (!interactive || additive || event.button !== 0 || !isRepositionable(entry.layout)) return;
    dimensionDrag.current = { pointerId: event.pointerId, constraintId: entry.id, startMm: camera.toSketch(event.clientX, event.clientY), startClient: [event.clientX, event.clientY], startOffsetPx: entry.offsetPx, layoutAt: entry.layoutAt, moved: false };
  };
  /** A press on the text of a distance between things (or another extra dimension): selects it and, once the pointer moves, drags its dimension line. */
  const pressExtraDimension = (constraintId: string, event: React.PointerEvent, layoutAt: (offsetPx: number) => DimensionLayout | undefined, offsetPx: number, additive: boolean): void => {
    selectConstraint(constraintId, additive);
    if (!interactive || additive || event.button !== 0) return;
    dimensionDrag.current = { pointerId: event.pointerId, constraintId, startMm: camera.toSketch(event.clientX, event.clientY), startClient: [event.clientX, event.clientY], startOffsetPx: offsetPx, layoutAt, moved: false };
  };
  const activeSpline = activeFit === undefined ? undefined : visibleEntities.find((entity) => entity.id === activeFit.entityId);
  const curvatureCombs = showComb ? sketchCurvatureCombs(visibleEntities, 60 * px * combScale) : [];

  return <SketchUnitContext.Provider value={props.displayUnit ?? "mm"}>
    <section className={`workspace-canvas sketch-stage${paletteLayout.dock === "docked" && !paletteLayout.collapsed ? " palette-docked" : ""}`} aria-label={`Interactive ${planeInfo.name} sketch`}>
      <button className="sketch-plane-chip canvas" onClick={props.onChangePlane} title="Change the plane this sketch is on" aria-label={`${planeDescription.chip}. Change plane`}><span className="sketch-plane-chip-text"><small>Sketch plane</small><strong>{[planeDescription.name, ...planeDescription.details].join(" · ")}</strong></span><em>Change</em></button>
      <svg
        ref={camera.svgRef}
        className={canvasClasses}
        data-sketch-canvas={plane}
        viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="application"
        aria-roledescription="sketch canvas"
        tabIndex={0}
        aria-describedby="sketch-canvas-help"
        aria-label={`${planeInfo.name} sketch with ${props.sketch.entities.length} entities and ${analysis.degreesOfFreedom} estimated degrees of freedom`}
        onKeyDown={handleCanvasKeyDown}
        onPointerDownCapture={handleCanvasPointerDownCapture}
        onPointerMove={handleCanvasPointerMove}
        onPointerDown={handleCanvasPointerDown}
        onDoubleClick={handleCanvasDoubleClick}
        onPointerUp={finishCanvasDrag}
        onPointerCancel={finishCanvasDrag}
        onPointerEnter={() => setPointerInside(true)}
        onPointerLeave={() => { setPointerInside(false); setHoverId(null); setInference(undefined); setTrimHover(undefined); lastTrimPick.current = undefined; }}
        onMouseDown={(event) => { if (event.button === 1) event.preventDefault(); }}
        onAuxClick={(event) => event.preventDefault()}
        onContextMenu={(event) => {
          event.preventDefault();
          const hit = (event.target as Element).closest<SVGElement>("[data-selection-id]")?.dataset["selectionId"] ?? null;
          if (hit !== null) props.onSelect(hit);
          props.onContextMenu(event.clientX, event.clientY, hit);
        }}
      >
        <SketchGrid
          viewBox={box}
          mmPerPx={px}
          minorMm={grid.minorMm}
          majorMm={grid.majorMm}
          showGrid={props.viewportState.gridVisible}
          horizontalAxis={planeInfo.horizontal}
          verticalAxis={planeInfo.vertical}
          horizontalLabel={planeInfo.horizontalLabel}
          verticalLabel={planeInfo.verticalLabel}
        />
        {props.sketch.underlay !== undefined && <UnderlayLayer underlay={props.sketch.underlay} />}
        {referenceShown && <g className="sketch-reference-layer" pointerEvents="none" aria-hidden="true">{props.reference?.entities.map((entity) => <SketchEntityShape key={entity.id} entity={entity} px={px} selected={false} hovered={false} reference />)}</g>}
        {showProfiles && profiles.map((profile) => <SketchProfileShape key={profile.id} profile={profile} selected={selectedProfileIds.includes(profile.id)} {...(interactive ? { onSelect: (additive: boolean) => selectProfile(profile, additive) } : {})} />)}
        {visibleEntities.map((entity) => <SketchEntityShape key={entity.id} entity={entity} name={entityNames.get(entity.id)} px={px} selected={selectionIds.includes(entity.id)} hovered={hoverId === entity.id} related={relatedIds.has(entity.id)} focused={focusedId === entity.id} handleRadiusPx={hitSizes.grabHandlePx} hitRadiusPx={hitSizes.grabHitPx} movable={props.showMovable && movableIds.has(entity.id)} constrained={analysis.entityFreedom[entity.id] === 0} {...(interactive ? { onSelect: (additive: boolean) => selectEntity(entity.id, additive), onHover: (inside: boolean) => setHoverId(inside ? entity.id : null), onGrab: (event: React.PointerEvent, handle: DragHandle) => beginDrag(event, entity.id, handle), onHandlePick: (handle: SketchGrabHandle) => setActiveFit(handle.handle.kind === "fit" ? { entityId: entity.id, index: handle.handle.index } : undefined), handles: grabHandlesOf(entity) } : {})} />)}
        {interactive && activeSpline?.kind === "spline" && activeFit !== undefined && selectionIds.includes(activeSpline.id) && <SplineHandles spline={activeSpline} activeIndex={activeFit.index} px={px} handleRadiusPx={hitSizes.grabHandlePx} hitRadiusPx={hitSizes.grabHitPx} canRemove={activeSpline.fitPoints.length > 3} onGrab={(event, handle) => beginDrag(event, activeSpline.id, handle)} onRemove={() => { removeActiveFitPoint(); }} />}
        {curvatureCombs.map(({ entityId, comb }) => <g key={`comb:${entityId}`} className="curvature-comb" data-comb-entity={entityId} pointerEvents="none" fill="none" stroke="#d9480f" strokeWidth={px}>
          {comb.teeth.map((tooth, index) => <line key={index} x1={tooth.base[0]} y1={-tooth.base[1]} x2={tooth.tip[0]} y2={-tooth.tip[1]} strokeOpacity={0.7} />)}
          <polyline points={comb.envelope.map((point) => `${point[0]},${-point[1]}`).join(" ")} strokeWidth={1.4 * px} />
        </g>)}
        {previewEntity !== undefined && <SketchEntityShape entity={previewEntity} px={px} selected={false} hovered={false} preview />}
        {previewShape?.entities.map((entity) => <SketchEntityShape key={entity.id} entity={entity} px={px} selected={false} hovered={false} preview />)}
        {mirrorGhosts.map((entity) => <SketchEntityShape key={entity.id} entity={entity} px={px} selected={false} hovered={false} preview />)}
        {props.editTool !== null && editPreview.map((entity) => <SketchEntityShape key={`edit-preview-${entity.id}`} entity={entity} px={px} selected={false} hovered={false} preview />)}
        {showDimensions && dimensionViews.map((entry) => <DimensionMarks key={entry.id} constraintId={entry.id} entityId={entry.view.entity.id} layout={entry.layout} px={px} relaxed={entry.view.constraint.suppressed === true} selected={selectedConstraintIds.includes(entry.id)} interactive={interactive} repositionable={isRepositionable(entry.layout)} title={constraintTitles.get(entry.id) ?? "Dimension"} onPress={(event, additive) => pressDimension(entry, event, additive)} onEdit={() => openDimensionEditor(entry.view.entity, entry.view.dimension)} onSelect={() => selectConstraint(entry.id, false)} />)}
        {showDimensions && <ExtraDimensionMarks sketch={visibleSketch} px={px} selectedIds={selectedConstraintIds} offsets={dimensionDragOffset === undefined ? dimensionOffsets : { ...dimensionOffsets, [dimensionDragOffset.constraintId]: dimensionDragOffset.offsetPx }} format={(value) => formatLengthLabel(value, dimensionDisplay)} {...(interactive ? { onEdit: openExtraDimensionEditor, onSelect: selectConstraint, onLabelPress: pressExtraDimension } : {})} />}
        {pending.map((point, index) => <circle key={index} cx={point[0]} cy={-point[1]} r={4 * px} className="pending-point" />)}
        {props.editTool === "trim" && <TrimHighlight preview={trimHover} px={px} />}
        <CentreMarker centre={centrePick.centre} hover={centrePick.picking ? centrePick.hover : undefined} px={px} />
        {underlayPick.points.length > 0 && props.editTool === "underlay" && <g className="underlay-pick" pointerEvents="none" stroke="#d9480f" strokeWidth={1.5 * px} fill="none">
          {underlayPick.points.length === 2 && <line x1={underlayPick.points[0]![0]} y1={-underlayPick.points[0]![1]} x2={underlayPick.points[1]![0]} y2={-underlayPick.points[1]![1]} strokeDasharray={`${6 * px} ${4 * px}`} />}
          {underlayPick.points.map((point, index) => <g key={index}><circle cx={point[0]} cy={-point[1]} r={5 * px} /><line x1={point[0] - 9 * px} y1={-point[1]} x2={point[0] + 9 * px} y2={-point[1]} /><line x1={point[0]} y1={-point[1] - 9 * px} x2={point[0]} y2={-point[1] + 9 * px} /></g>)}
        </g>}
        {props.tool !== "select" && pointerInside && !camera.panning && inference !== undefined && <InferenceMarks inference={inference} px={px} />}
        {props.tool !== "select" && pointerInside && !camera.panning && <circle cx={cursor[0]} cy={-cursor[1]} r={3.5 * px} className="cursor-point" />}
        {showDimensions && visibleEntities.filter((entity) => !dimensionedIds.has(entity.id)).map((entity) => <SketchDimensionGlyph key={`dimension:${entity.id}`} entity={entity} px={px} label={(value) => formatLengthLabel(value, dimensionDisplay)} />)}
        <ConstraintGlyphLayer glyphs={glyphs} px={px} selectedIds={selectedConstraintIds} hoveredId={hoverConstraintId} interactive={interactive} titles={constraintTitles} onHover={setHoverConstraintId} onSelect={selectConstraint} />
        {measureMode && <MeasureOverlay state={measureState} px={px} />}
        {pickRelation !== null && CONSTRAINT_TOOL_INFO[pickRelation].takesPoints && [...visibleEntities.flatMap(relationPointsOf), ...(pickRelation === "fixed" ? [] : [ORIGIN_RELATION_POINT])].map((handle) => <rect
          key={handle.id}
          className={`relation-point${toolPicks.some((pick) => pick.entityId === handle.entityId && pick.ref === handle.ref) ? " selected" : ""}`}
          data-relation-point={handle.id}
          x={handle.point[0] - hitSizes.relationPointPx * px}
          y={-handle.point[1] - hitSizes.relationPointPx * px}
          width={2 * hitSizes.relationPointPx * px}
          height={2 * hitSizes.relationPointPx * px}
          role="button"
          tabIndex={0}
          aria-pressed={toolPicks.some((pick) => pick.entityId === handle.entityId && pick.ref === handle.ref)}
          aria-label={`${handle.label} (relation point)`}
          onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); pickRelationPoint(handle); }}
          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); pickRelationPoint(handle); } }}
        />)}
        {props.dimensionMode && <>
          {[...dimensionHandleEntities.flatMap(dimensionHandles), ORIGIN_POINT].map((point) => <circle key={point.id} className={`dimension-point ${dimensionPoints.some((candidate) => candidate.id === point.id) ? "selected" : ""}`} data-dimension-point={point.id} cx={point.point[0]} cy={-point.point[1]} r={hitSizes.dimensionPointPx * px} role="button" tabIndex={0} aria-pressed={dimensionPoints.some((candidate) => candidate.id === point.id)} aria-label={`${point.label} dimension point`} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); selectDimensionPoint(point); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); selectDimensionPoint(point); } }} />)}
          {directDimension !== undefined && <DirectDimensionPreview dimension={directDimension} px={px} />}
        </>}
        {selectionBox !== undefined && <rect
          className={`selection-box ${zoomWindowMode ? "zoom-draw" : props.editTool === "stretch" ? "stretch-draw" : selectionBoxMode(selectionBox.start, selectionBox.end)}`}
          x={Math.min(selectionBox.start[0], selectionBox.end[0])}
          y={-Math.max(selectionBox.start[1], selectionBox.end[1])}
          width={Math.abs(selectionBox.end[0] - selectionBox.start[0])}
          height={Math.abs(selectionBox.end[1] - selectionBox.start[1])}
          pointerEvents="none"
        />}
        {props.editTool === "stretch" && stretchWindow !== undefined && <rect
          className="stretch-window"
          data-stretch-window=""
          x={Math.min(stretchWindow.x1, stretchWindow.x2)}
          y={-Math.max(stretchWindow.y1, stretchWindow.y2)}
          width={Math.abs(stretchWindow.x2 - stretchWindow.x1)}
          height={Math.abs(stretchWindow.y2 - stretchWindow.y1)}
          pointerEvents="none"
        />}
      </svg>

      {dimensionEdit !== undefined && <DimensionEditor
        label={dimensionEdit.label}
        unitLabel={dimensionEdit.dimension === "angle" ? "°" : dimensionDisplay.unit}
        reference={dimensionReference}
        onReferenceChange={setDimensionReference}
        unitName={dimensionEdit.dimension === "angle" ? "degrees" : unitWord(unit)}
        text={dimensionText}
        position={(() => {
          const at = sketchToScreen(dimensionEdit.anchor, { left: 0, top: 0, width: camera.size.width, height: camera.size.height }, camera.camera);
          return [Math.max(8, Math.min(at[0] - 70, camera.size.width - 190)), Math.max(8, Math.min(at[1] - 62, camera.size.height - 70))] as const;
        })()}
        onChange={setDimensionText}
        onCommit={commitDimensionEdit}
        onCancel={(reason) => { setDimensionEdit(undefined); if (reason === "escape") setDimensionFirst(undefined); }}
      />}
      {dynamicFields.length > 0 && (pointerInside || dynamicFocused || Object.keys(fieldText).length > 0) && !camera.panning && <DynamicInputBox
        unit={unit}
        fields={dynamicFields}
        live={liveValues}
        text={fieldText}
        errors={fieldErrors}
        position={(() => {
          const anchor = dynamicFocused && frozenAt !== undefined ? frozenAt : cursor;
          const at = sketchToScreen(anchor, { left: 0, top: 0, width: camera.size.width, height: camera.size.height }, camera.camera);
          return [Math.max(8, Math.min(at[0] + 20, camera.size.width - 210)), Math.max(8, Math.min(at[1] + 20, camera.size.height - 96))] as const;
        })()}
        setRef={(id, element) => { fieldRefs.current[id] = element; }}
        onChange={setField}
        onFocus={(id) => { setFrozenAt(cursor); setDynamicFocused(true); if (fieldText[id] === undefined) fieldRefs.current[id]?.select(); }}
        onBlur={() => setDynamicFocused(false)}
        onCommit={commitDynamicInput}
        onCancel={() => { setFieldText({}); setDynamicFocused(false); }}
        onTab={(id, backwards) => {
          const index = dynamicFields.findIndex((field) => field.id === id);
          const next = dynamicFields[(index + (backwards ? dynamicFields.length - 1 : 1)) % dynamicFields.length];
          if (next !== undefined) requestFieldFocus(next.id);
        }}
      />}

      <div id="sketch-canvas-help" className="sketch-sr-only">Sketch canvas. Use the arrow keys to move between curves, Enter or Space to select the focused curve, Shift plus Enter to add it to the selection, Delete to remove the selection, and Escape to step back.</div>
      <div className="sketch-sr-only" role="status" aria-live="polite">{announcement}</div>
      {zoomWindowMode && <div className="dimension-mode-banner"><CommandIcon name="view" /><span><strong>Zoom window</strong>Drag a rectangle on the canvas. Esc cancels.</span></div>}
      {measureMode && <div className="dimension-mode-banner"><CommandIcon name="dimension" /><span><strong>Measure</strong>{measureState.result !== undefined ? describeMeasurement(measureState.result) : measureState.picks.length === 1 ? "Pick a second point for a distance, or a second line for an angle." : "Click a point, or a line. Nothing is added to the sketch. Esc finishes."}</span></div>}
      {props.dimensionMode && <div className="dimension-mode-banner"><CommandIcon name="dimension" /><span><strong>Sketch Dimension</strong>{dimensionPlacement !== undefined
        ? "Click to place the dimension: above or below the two points for horizontal, beside them for vertical, elsewhere for straight."
        : dimensionFirst !== undefined
          ? "Type the value, or click a second curve or point for the distance or angle between the two."
          : "Click a curve for its size, then a second curve or point for a distance or an angle. Esc to finish."}</span></div>}
      {pickRelation !== null && <div className="dimension-mode-banner constraint-tool-banner" role="status"><CommandIcon name={pickRelation === "symmetry" ? "mirror" : pickRelation} /><span><strong>{CONSTRAINT_TOOL_INFO[pickRelation].label}</strong>{toolPicks.length === 0 ? CONSTRAINT_TOOL_INFO[pickRelation].prompt : `${toolPicks.map((pick) => pick.label).join(", ")} picked. Pick the next one.`} Esc to finish.</span></div>}
      {relaxPrompt !== undefined && <div className="dimension-mode-banner relax-fix-prompt" role="alert">
        <span><strong>{relaxPrompt.names} {relaxPrompt.names.includes(" and ") ? "are" : "is"} Fixed</strong>A Fixed curve cannot change size. Relax the Fix and apply the value in one step?</span>
        <button type="button" className="primary" onClick={() => { const run = relaxPrompt.apply; setRelaxPrompt(undefined); run(); }}>Relax the Fix and apply</button>
        <button type="button" onClick={() => setRelaxPrompt(undefined)}>Cancel</button>
      </div>}
      {overPrompt !== undefined && <div className="dimension-mode-banner relax-fix-prompt over-constraint-prompt" role="alert">
        <span><strong>This dimension would over-constrain the sketch</strong>{overPrompt.message} Add it as a reference dimension instead? A reference dimension shows the value and never drives the geometry.</span>
        <button type="button" className="primary" onClick={() => { const run = overPrompt.apply; setOverPrompt(undefined); run(); }}>Add as a reference dimension</button>
        <button type="button" onClick={() => { setOverPrompt(undefined); props.onMessage("Dimension cancelled; nothing was added."); }}>Cancel</button>
      </div>}

      {selectOther !== undefined && props.tool === "select" && <SelectOtherPopup
        candidates={selectOther.candidates}
        selectedId={selectionIds.length === 1 ? selectionIds[0]! : null}
        position={selectOther.at}
        onPick={(id) => { setSelectionIds([id]); setSelectedProfileIds([]); props.onSelect(id); }}
        onClose={() => setSelectOther(undefined)}
      />}
      <ShortcutEditorDialog open={shortcutEditorOpen} onClose={() => setShortcutEditorOpen(false)} />

      <ViewportChrome workspace="sketch" state={props.viewportState} measurePoints={[]} onNavigationMode={props.onNavigationMode} onSelectionFilter={props.onSelectionFilter} onOrientation={props.onOrientation} onViewAngles={props.onViewAngles} onProjection={props.onProjection} onGrid={props.onGrid} onAxes={props.onAxes} onShadingMode={() => undefined} onBodyColor={() => undefined} onBackgroundTone={() => undefined} onFit={camera.fit} onHome={camera.fit} onClearMeasure={() => undefined} />

      <div className={`sketch-palette ${paletteLayout.dock}${paletteLayout.collapsed ? " collapsed" : ""}`} ref={paletteRef} aria-label="Sketch palette">
        <header><div><span>SKETCH</span><strong>Palette</strong></div><div className="palette-header-actions">
          <button onClick={props.onChangePlane} title="Move this sketch to another plane"><CommandIcon name="view" />Plane</button>
          <button onClick={() => setPaletteLayout((current) => ({ ...current, dock: current.dock === "docked" ? "floating" : "docked" }))} title={paletteLayout.dock === "docked" ? "Float the palette over the canvas" : "Dock the palette beside the canvas"} aria-label={paletteLayout.dock === "docked" ? "Float the palette" : "Dock the palette"}>{paletteLayout.dock === "docked" ? "Float" : "Dock"}</button>
          <button onClick={() => setPaletteLayout((current) => ({ ...current, collapsed: !current.collapsed }))} aria-expanded={!paletteLayout.collapsed} title={paletteLayout.collapsed ? "Expand the palette" : "Fold the palette up"} aria-label={paletteLayout.collapsed ? "Expand the palette" : "Fold the palette up"}>{paletteLayout.collapsed ? "+" : "−"}</button>
        </div></header>
        <label className="palette-select"><span>Units</span><select aria-label="Sketch display units" value={props.displayUnit} onChange={(event) => props.onDisplayUnit(event.target.value === "in" ? "in" : "mm")}><option value="mm">Millimetres</option><option value="in">Inches</option></select></label>

        {!paletteLayout.collapsed && <>
        <PaletteToggle label="Sketch grid" active={props.viewportState.gridVisible} onToggle={props.onGrid} />
        <PaletteToggle label={`Snap${keyLabelForCommand("toggle-snap", sketchKeymap) === undefined ? "" : ` (${keyLabelForCommand("toggle-snap", sketchKeymap)})`}`} active={snapEnabled} onToggle={setSnapEnabled} />
        <SketchInputPalette settings={assist} gridMm={grid.minorMm} unit={unit} onChange={updateAssist} onOpenShortcuts={() => setShortcutEditorOpen(true)} />
        <PaletteToggle label="Auto-constrain" active={autoConstrain} onToggle={setAutoConstrain} />
        <PaletteToggle label={`Draw as construction${keyHint("toggle-draw-construction")}`} active={drawAsConstruction} onToggle={(next) => { setDrawAsConstruction(next); props.onMessage(next ? drawConstructionOnMessage(keyLabelForCommand("toggle-draw-construction", sketchKeymap)) : DRAW_CONSTRUCTION_OFF_MESSAGE); }} />
        {props.tool === "polygon" && <label className="palette-number"><span>Polygon sides</span><input type="number" min={POLYGON_MIN_SIDES} max={POLYGON_MAX_SIDES} step={1} value={polygonSides} aria-label="Number of polygon sides" onChange={(event) => setPolygonSides(event.target.value)} /></label>}
        {props.tool === "polygon" && <label className="palette-number"><span>Polygon size by</span><select value={polygonMode} aria-label="How the polygon is sized" title="Inscribed: centre, then a corner. Circumscribed: centre, then the middle of a side. Edge: the two ends of one side." onChange={(event) => setPolygonMode(parsePolygonMode(event.target.value))}>{POLYGON_MODES.map((mode) => <option key={mode} value={mode}>{POLYGON_MODE_LABELS[mode]}</option>)}</select></label>}
        <SketchCurveOptionsPanel unit={unit} tool={props.tool} fields={curveFields} onChange={setCurveFields} blockNames={blockNames} selectedCount={selectedEntities.length} onSaveBlock={saveSelectionAsBlock} textEdit={textEditId === null ? undefined : { onApply: () => placeText(), onCancel: () => { setTextEditId(null); props.onMessage("Text editing cancelled."); } }} />
        {props.tool === "select" && selectedEntity !== undefined && findTextObject(props.sketch, selectedEntity.id) !== undefined && <button className="palette-action" title="Re-open this text (or double-click it)" onClick={() => startTextEdit(findTextObject(props.sketch, selectedEntity.id)!)}><CommandIcon name="edit" />Edit text</button>}
        <PaletteToggle label="Profiles" active={showProfiles} onToggle={setShowProfiles} />
        <PaletteToggle label="Dimensions" active={showDimensions} onToggle={setShowDimensions} />
        <PaletteToggle label="Model behind sketch" active={showReference} onToggle={setShowReference} />
        {showReference && <small className="palette-reference-note">{describeReferenceLayer(props.reference)} Reference only: the pointer snaps to it, nothing is tied to it (use Project for that), and the view stays straight at the sketch plane.</small>}
        <PaletteToggle label="Constraints" active={showConstraints} onToggle={setShowConstraints} />
        {showConstraints && <ConstraintDisplayPanel settings={constraintDisplay} present={constraintKinds} onChange={setConstraintDisplay} />}
        {showDimensions && <details className="palette-dimension-display">
          <summary>Dimension display</summary>
          <label className="palette-number"><span>Decimals</span><input type="number" min={0} max={6} step={1} aria-label="Dimension decimals" value={dimensionDisplay.precision} onChange={(event) => setDimensionDisplay((current) => ({ ...current, precision: clampPrecision(Number(event.target.value)) }))} /></label>
          <PaletteToggle label="Show unit" active={dimensionDisplay.showUnit} onToggle={(showUnit) => setDimensionDisplay((current) => ({ ...current, showUnit }))} />
          <small>Display only: the model keeps millimetres. Drag a dimension's text to move it; it is remembered in this browser.</small>
        </details>}
        <div className="palette-view-tools" role="group" aria-label="View and measure">
          <button type="button" className={zoomWindowMode ? "active" : ""} aria-pressed={zoomWindowMode} title={`Zoom window${keyHint("zoom-window")}: drag a rectangle to zoom to it`} onClick={() => zoomWindowMode ? setZoomWindowMode(false) : startZoomWindow()}><CommandIcon name="view" />Zoom window</button>
          <button type="button" title={`Zoom to the selected curves${keyHint("zoom-selection")}`} disabled={selectionIds.length === 0} onClick={frameSelection}><CommandIcon name="view" />Zoom selection</button>
          <button type="button" className={measureMode ? "active" : ""} aria-pressed={measureMode} title={`Measure${keyHint("measure")}: two points for a distance, two lines for an angle. Nothing is added to the sketch.`} onClick={() => { if (measureMode) { setMeasureMode(false); setMeasureState(EMPTY_MEASURE); } else startMeasure(); }}><CommandIcon name="dimension" />Measure</button>
        </div>
        <PaletteToggle label="Curvature comb" active={showComb} onToggle={setShowComb} />
        {showComb && <label><span>Comb scale</span><input type="range" aria-label="Curvature comb scale" min={0.2} max={3} step={0.1} value={combScale} onChange={(event) => setCombScale(Number(event.target.value))} /></label>}
        <button className="palette-action" disabled={selectedEntities.length === 0} onClick={() => { runSelectionAction(constructionSelectionPlan(selectedEntities)); }}><CommandIcon name={selectedEntities.length > 0 && selectedEntities.every((entity) => entity.construction) ? "rectangle" : "construction"} />{selectedEntities.length > 0 && selectedEntities.every((entity) => entity.construction) ? "Profile geometry" : "Construction"}{selectedEntities.length > 1 ? ` (${selectedEntities.length})` : ""}</button>
        <div className="sketch-make-solid" aria-label="Create a solid from a profile">
          <span className="make-solid-title">Create solid</span>
          <div className="make-solid-row">
            <select aria-label="Operation" value={solidOp} onChange={(event) => { const next = event.target.value as "extrude" | "revolve" | "sweep" | "loft" | "edge-fillet" | "edge-chamfer" | "shell" | "draft" | "helix" | "thread" | "rib" | "dome" | "sheet-base" | "sheet-flange" | "sheet-hem"; setSolidOp(next); setSolidValue(next === "revolve" ? "360" : next === "helix" ? "20" : "20"); }}>
              <option value="extrude">Extrude</option>
              <option value="revolve">Revolve</option>
              <option value="sweep">Sweep (linear)</option>
              <option value="loft">Loft (scaled top)</option>
              <option value="edge-fillet">Fillet extrude</option>
              <option value="edge-chamfer">Chamfer extrude</option>
              <option value="shell">Shell (hollow)</option>
              <option value="draft">Draft (tapered)</option>
              <option value="helix">Helix / Coil</option>
              <option value="thread">Thread (helical ridge)</option>
              <option value="rib">Rib (thin wall)</option>
              <option value="dome">Dome (capped)</option>
              <option value="sheet-base">Sheet metal: base plate</option>
              <option value="sheet-flange">Sheet metal: flange</option>
              <option value="sheet-hem">Sheet metal: hem</option>
            </select>
            <input aria-label={solidOp === "revolve" ? "Angle in degrees" : solidOp === "sweep" ? `Sweep distance in ${unitWord(unit)}` : `Height in ${unitWord(unit)}`} type="number" min={solidOp === "revolve" ? 1 : unit === "in" ? 0.005 : 0.1} max={solidOp === "revolve" ? 360 : undefined} step={solidOp === "revolve" ? 5 : unit === "in" ? 0.125 : 1} value={solidOp === "revolve" ? solidValue : lengthTextToDisplay(solidValue, unit)} disabled={cutThroughAll || reachesTarget} onChange={(event) => setSolidValue(solidOp === "revolve" ? event.target.value : lengthTextFromDisplay(event.target.value, unit))} />
            <small>{solidOp === "revolve" ? "°" : unit}</small>
          </div>
          <small className="make-solid-plane">On the {planePlacement}</small>
          <div className="make-solid-row" aria-label="Result of the feature">
            <select aria-label="Result" value={solidResult} onChange={(event) => setSolidResult(event.target.value as "new-body" | "join" | "cut")}>
              <option value="new-body">New body</option>
              <option value="join" disabled={props.solidBodies.length === 0}>Join to a solid</option>
              <option value="cut" disabled={props.solidBodies.length === 0}>Cut from a solid</option>
            </select>
          </div>
          {solidResult !== "new-body" && <div className="make-solid-row" aria-label="Solid to change">
            {props.solidBodies.length === 0
              ? <small>Make a solid first, then join or cut with another sketch.</small>
              : <select aria-label="Solid to change" value={effectiveTarget} onChange={(event) => setSolidTarget(event.target.value)}>
                {props.solidBodies.map((body) => <option key={body.id} value={body.id}>{body.name}</option>)}
              </select>}
          </div>}
          {solidOp === "revolve" && <div className="make-solid-row" aria-label="Revolve axis">
            <small>Axis</small>
            <select aria-label="Revolve axis" value={props.sketch.entities.some((entity) => entity.id === revolveAxisChoice) || revolveAxisChoice === "x" ? revolveAxisChoice : ""} onChange={(event) => setRevolveAxisChoice(event.target.value)}>
              <option value="">Sketch Y axis ({sketchAxesInWorld(props.sketch.plane, conventionOf(props.sketch)).y})</option>
              <option value="x">Sketch X axis ({sketchAxesInWorld(props.sketch.plane, conventionOf(props.sketch)).x})</option>
              {props.sketch.entities.filter((entity) => entity.kind === "line").map((entity, index) => <option key={entity.id} value={entity.id}>{entityNames.get(entity.id) ?? `Line ${index + 1}`}{entity.construction ? " (construction)" : ""}</option>)}
            </select>
            <small>{describeSketchAxes(props.sketch)}</small>
          </div>}
          {(solidOp === "extrude" || solidOp === "revolve") && <ReachOptions operation={solidOp} settings={reach} onChange={setReach} bodies={props.targetBodies} selectedId={props.selectedId} cutting={solidResult === "cut" && props.solidBodies.length > 0} />}
          {solidOp === "sweep" && <div className="make-solid-row" aria-label="Sweep mode">
            <select aria-label="Sweep mode" value={sweepMode} onChange={(event) => setSweepMode(event.target.value as "direction" | "path")}>
              <option value="direction">Linear direction</option>
              <option value="path">Along a sketch path</option>
            </select>
          </div>}
          {solidOp === "sweep" && sweepMode === "direction" && <div className="make-solid-row" aria-label="Sweep direction">
            <small>Direction (world)</small>
            <input aria-label="Sweep direction X" type="number" step={0.1} value={sweepDx} onChange={(event) => setSweepDx(event.target.value)} />
            <input aria-label="Sweep direction Y" type="number" step={0.1} value={sweepDy} onChange={(event) => setSweepDy(event.target.value)} />
            <input aria-label="Sweep direction Z" type="number" step={0.1} value={sweepDz} onChange={(event) => setSweepDz(event.target.value)} />
          </div>}
          {solidOp === "sweep" && sweepMode === "path" && <div className="make-solid-row" aria-label="Sweep path sketch">
            <small>Path sketch</small>
            <select aria-label="Sweep path sketch" value={pathSketchId} onChange={(event) => { setSweepPathSketch(event.target.value); setSweepPathIds([]); }}>
              {pathChoices.map((choice) => <option key={choice.id} value={choice.id}>{choice.name} ({choice.curves} curve{choice.curves === 1 ? "" : "s"})</option>)}
            </select>
          </div>}
          {solidOp === "sweep" && sweepMode === "path" && <div className="make-solid-row sweep-path-curves" aria-label="Sweep path curves">
            <small>Path curves</small>
            {pathCurves.length === 0
              ? <small>This sketch has no lines, arcs or splines to follow.</small>
              : pathCurves.map((curve) => <label key={curve.id} className="check-row"><input type="checkbox" aria-label={`Path curve ${curve.label}`} checked={pathIds.includes(curve.id)} onChange={(event) => setSweepPathIds(event.target.checked ? [...pathIds, curve.id] : pathIds.filter((id) => id !== curve.id))} /> {curve.label}</label>)}
            <button type="button" className="palette-action" aria-label="Chain the connected curves of the path" disabled={pathCurves.length === 0 || (pathIds.length === 0 && !(pathSketchId === WORKING_PATH_SKETCH && selectedEntity !== undefined && pathCurves.some((curve) => curve.id === selectedEntity.id)))} title="Adds every curve that continues the checked one end to end" onClick={() => {
              const seed = pathIds[0] ?? (pathSketchId === WORKING_PATH_SKETCH ? selectedEntity?.id : undefined);
              if (seed !== undefined) setSweepPathIds(chainFromCurve(pathSketch, seed));
            }}>Chain connected curves</button>
            <small className={pathReport.ok ? "" : "profile-help"}>{pathReport.ok ? `${pathReport.curves} curve${pathReport.curves === 1 ? "" : "s"}, ${lengthText(pathReport.lengthMm)} ${unit} along the path` : pathReport.message}</small>
          </div>}
          {solidOp === "loft" && <div className="make-solid-row" aria-label="Loft mode">
            <select aria-label="Loft mode" value={loftMode} onChange={(event) => setLoftMode(event.target.value as "scaled" | "two-profile")}>
              <option value="scaled">Scaled top</option>
              <option value="two-profile">Two profiles</option>
            </select>
          </div>}
          {solidOp === "loft" && loftMode === "scaled" && <div className="make-solid-row" aria-label="Loft top scale">
            <small>Top scale</small>
            <input aria-label="Loft top scale" type="number" min={0.05} max={20} step={0.1} value={loftTopScale} onChange={(event) => setLoftTopScale(event.target.value)} />
          </div>}
          {solidOp === "loft" && loftMode === "two-profile" && <div className="make-solid-row" aria-label="Loft continuity">
            <select aria-label="Loft continuity" value={loftContinuity} onChange={(event) => setLoftContinuity(event.target.value as "position" | "tangent" | "curvature")}>
              <option value="position">G0 · Position</option>
              <option value="tangent">G1 · Tangent</option>
              <option value="curvature">G2 · Curvature</option>
            </select>
            <small>Pick two profiles: first is the base, second is the top. Mismatched vertex counts are resampled.</small>
          </div>}
          {solidOp === "loft" && loftMode === "two-profile" && <div className="make-solid-row" aria-label="Loft rail">
            <small>Rail</small>
            <select aria-label="Loft rail entity" value={loftRailEntityId} onChange={(event) => setLoftRailEntityId(event.target.value)}>
              <option value="">(none — straight interpolation)</option>
              {props.sketch.entities.filter((entity) => (entity.kind === "line" || entity.kind === "arc" || entity.kind === "spline") && entity.visible !== false).map((entity) => <option key={entity.id} value={entity.id}>{entity.kind} · {entity.id.slice(-8)}</option>)}
            </select>
          </div>}
          {solidOp === "sweep" && <div className="make-solid-row" aria-label="Sweep twist">
            <small>Twist</small>
            <input aria-label="Sweep twist in degrees" type="number" min={-3600} max={3600} step={5} value={sweepTwist} onChange={(event) => setSweepTwist(event.target.value)} />
            <small>°</small>
          </div>}
          {solidOp === "sweep" && sweepMode === "path" && <div className="make-solid-row" aria-label="Sweep frame transport">
            <label>
              <input aria-label="Sweep frame transport (perpendicular to tangent)" type="checkbox" checked={sweepFrameTransport} onChange={(event) => setSweepFrameTransport(event.target.checked)} />
              <small> ⟂ tangent (Frenet transport)</small>
            </label>
          </div>}
          {solidOp === "loft" && loftMode === "two-profile" && loftContinuity !== "position" && <div className="make-solid-row" aria-label="Loft tangency weight">
            <small>Tangency</small>
            <input aria-label="Loft tangency weight" type="number" min={0} max={2} step={0.1} value={loftTangencyWeight} onChange={(event) => setLoftTangencyWeight(event.target.value)} />
            <small>0 → linear · 1 → full G1/G2 · 2 → punchy</small>
          </div>}
          {(solidOp === "edge-fillet" || solidOp === "edge-chamfer") && <div className="make-solid-row" aria-label="Edge treatment size">
            <small>{solidOp === "edge-fillet" ? "Radius" : "Distance"}</small>
            <input aria-label={solidOp === "edge-fillet" ? "Fillet radius in millimetres" : "Chamfer distance in millimetres"} type="number" min={0.1} step={0.5} value={modifierEdgeSize} onChange={(event) => setModifierEdgeSize(event.target.value)} />
            <small>mm</small>
          </div>}
          {solidOp === "shell" && <div className="make-solid-row" aria-label="Shell parameters">
            <small>Wall</small>
            <input aria-label="Shell wall thickness in millimetres" type="number" min={0.1} step={0.5} value={shellThickness} onChange={(event) => setShellThickness(event.target.value)} />
            <select aria-label="Shell open face" value={shellOpenFace} onChange={(event) => setShellOpenFace(event.target.value as "top" | "bottom" | "none")}>
              <option value="top">Open top</option>
              <option value="bottom">Open bottom</option>
              <option value="none">Fully closed</option>
            </select>
          </div>}
          {solidOp === "thread" && <div className="make-solid-row" aria-label="Thread parameters">
            <small>Pitch</small>
            <input aria-label="Thread pitch in millimetres" type="number" min={0.1} step={0.5} value={threadPitch} onChange={(event) => setThreadPitch(event.target.value)} />
            <small>mm · turns</small>
            <input aria-label="Thread turns" type="number" min={0.5} max={100} step={0.5} value={threadTurns} onChange={(event) => setThreadTurns(event.target.value)} />
            <small>· depth</small>
            <input aria-label="Thread depth in millimetres" type="number" min={0.1} step={0.5} value={threadDepth} onChange={(event) => setThreadDepth(event.target.value)} />
            <select aria-label="Thread handedness" value={threadHandedness} onChange={(event) => setThreadHandedness(event.target.value === "left" ? "left" : "right")}>
              <option value="right">Right-handed</option>
              <option value="left">Left-handed</option>
            </select>
          </div>}
          {(solidOp === "sheet-base" || solidOp === "sheet-flange" || solidOp === "sheet-hem") && <div className="make-solid-row" aria-label="Sheet metal parameters">
            <small>Thickness</small>
            <input aria-label="Sheet thickness in millimetres" type="number" min={0.1} step={0.1} value={sheetThickness} onChange={(event) => setSheetThickness(event.target.value)} />
            {solidOp !== "sheet-base" && <>
              <small>mm · bend R</small>
              <input aria-label="Sheet bend radius in millimetres" type="number" min={0} step={0.5} value={sheetBendRadius} onChange={(event) => setSheetBendRadius(event.target.value)} />
              <small>mm · flange</small>
              <input aria-label="Flange length in millimetres" type="number" min={0.5} step={1} value={flangeLength} onChange={(event) => setFlangeLength(event.target.value)} />
            </>}
            {solidOp === "sheet-flange" && <>
              <small>mm · angle</small>
              <input aria-label="Flange bend angle in degrees" type="number" min={1} max={180} step={5} value={flangeAngle} onChange={(event) => setFlangeAngle(event.target.value)} />
              <small>°</small>
            </>}
            {solidOp === "sheet-hem" && <select aria-label="Hem style" value={hemStyle} onChange={(event) => setHemStyle(event.target.value === "open" ? "open" : "closed")}>
              <option value="closed">Closed hem</option>
              <option value="open">Open hem</option>
            </select>}
            {solidOp !== "sheet-base" && <small>Profile X-extent = flat leg · height field = strip width</small>}
          </div>}
          {solidOp === "rib" && <div className="make-solid-row" aria-label="Rib parameters">
            <small>Thickness</small>
            <input aria-label="Rib thickness in millimetres" type="number" min={0.1} step={0.5} value={ribThickness} onChange={(event) => setRibThickness(event.target.value)} />
            <small>mm</small>
          </div>}
          {solidOp === "dome" && <div className="make-solid-row" aria-label="Dome parameters">
            <small>Dome height</small>
            <input aria-label="Dome height in millimetres" type="number" step={0.5} value={domeHeight} onChange={(event) => setDomeHeight(event.target.value)} />
            <small>mm (negative dips inward)</small>
          </div>}
          {solidOp === "helix" && <div className="make-solid-row" aria-label="Helix parameters">
            <small>Radius</small>
            <input aria-label="Helix coil radius in millimetres" type="number" min={0.1} step={0.5} value={helixRadius} onChange={(event) => setHelixRadius(event.target.value)} />
            <small>mm · pitch</small>
            <input aria-label="Helix pitch in millimetres" type="number" min={0.1} step={0.5} value={helixPitch} onChange={(event) => setHelixPitch(event.target.value)} />
            <small>mm · turns</small>
            <input aria-label="Helix turns" type="number" min={0.1} max={100} step={0.5} value={helixTurns} onChange={(event) => setHelixTurns(event.target.value)} />
            <select aria-label="Helix handedness" value={helixHandedness} onChange={(event) => setHelixHandedness(event.target.value === "left" ? "left" : "right")}>
              <option value="right">Right-handed</option>
              <option value="left">Left-handed</option>
            </select>
          </div>}
          {solidOp === "draft" && <div className="make-solid-row" aria-label="Draft parameters">
            <small>Angle</small>
            <input aria-label="Draft angle in degrees" type="number" min={0.5} max={75} step={0.5} value={draftAngle} onChange={(event) => setDraftAngle(event.target.value)} />
            <select aria-label="Draft neutral face" value={draftNeutralFace} onChange={(event) => setDraftNeutralFace(event.target.value as "top" | "bottom")}>
              <option value="bottom">Bottom neutral</option>
              <option value="top">Top neutral</option>
            </select>
          </div>}
          {solidOp === "extrude" && <div className="make-solid-row" aria-label="Edge treatment">
            <select aria-label="Edge treatment" value={edgeKind} onChange={(event) => setEdgeKind(event.target.value as "none" | "chamfer" | "fillet")}>
              <option value="none">Edges: sharp</option>
              <option value="chamfer">Edges: chamfer</option>
              <option value="fillet">Edges: fillet</option>
            </select>
            {edgeKind !== "none" && <>
              <input aria-label={edgeKind === "chamfer" ? "Chamfer distance in millimetres" : "Fillet radius in millimetres"} type="number" min={0.1} step={0.5} value={edgeSize} onChange={(event) => setEdgeSize(event.target.value)} />
              <small>mm</small>
            </>}
          </div>}
          <button className="palette-action primary" title={profiles.length === 0 ? `No closed region to build from. ${noProfileReasons.join(" ")} Validate Sketch lists every open end and gap.` : undefined} disabled={profiles.length === 0 || (solidResult !== "new-body" && !modifying) || (solidOp !== "extrude" && solidOp !== "revolve" && solidResult !== "new-body")} onClick={() => {
            const reachResult = solidOp === "extrude" || solidOp === "revolve" ? buildReach(solidOp, reach, Number(solidValue), props.targetBodies, props.selectedId) : undefined;
            if (reachResult !== undefined && !reachResult.ok) { props.onMessage(reachResult.message); return; }
            const sweepTwistValue = Number(sweepTwist);
            const loftTangencyWeightValue = Number(loftTangencyWeight);
            if (solidOp === "sweep" && sweepMode === "path" && !pathReport.ok) { props.onMessage(pathReport.message); return; }
            const advanced = solidOp === "sweep"
              ? {
                ...(sweepMode === "path"
                  ? { sweepPathSource: { sketchId: pathSketchId, entityIds: pathIds }, ...(sweepFrameTransport ? { sweepFrameTransport: true } : {}) }
                  : { sweepDirectionMm: [Number(sweepDx), Number(sweepDy), Number(sweepDz)] as const }),
                ...(Number.isFinite(sweepTwistValue) && sweepTwistValue !== 0 ? { sweepTwistDeg: sweepTwistValue } : {})
              }
              : solidOp === "loft"
                ? (loftMode === "two-profile" && selectedProfileIds.length >= 2
                  ? { loftSecondaryProfileIds: refsOf(selectedProfileIds.slice(1)), loftContinuity, ...(loftRailEntityId !== "" ? { loftRailEntityId } : {}), ...(loftContinuity !== "position" && Number.isFinite(loftTangencyWeightValue) && loftTangencyWeightValue !== 1 ? { loftTangencyWeight: loftTangencyWeightValue } : {}) }
                  : { loftTopScale: Number(loftTopScale) })
                : solidOp === "shell"
                  ? { shellThicknessMm: Number(shellThickness), shellOpenFace }
                  : solidOp === "draft"
                    ? { draftAngleDeg: Number(draftAngle), draftNeutralFace }
                    : solidOp === "helix"
                      ? { helixRadiusMm: Number(helixRadius), helixPitchMm: Number(helixPitch), helixTurns: Number(helixTurns), helixHandedness }
                      : solidOp === "thread"
                        ? { threadPitchMm: Number(threadPitch), threadTurns: Number(threadTurns), threadDepthMm: Number(threadDepth), threadHandedness }
                        : solidOp === "rib"
                          ? { ribThicknessMm: Number(ribThickness) }
                          : solidOp === "dome"
                            ? { domeHeightMm: Number(domeHeight) }
                            : solidOp === "sheet-base"
                              ? { sheetThicknessMm: Number(sheetThickness) }
                              : solidOp === "sheet-flange"
                                ? { sheetThicknessMm: Number(sheetThickness), sheetBendRadiusMm: Number(sheetBendRadius), flangeLengthMm: Number(flangeLength), flangeAngleDeg: Number(flangeAngle) }
                                : solidOp === "sheet-hem"
                                  ? { sheetThicknessMm: Number(sheetThickness), sheetBendRadiusMm: Number(sheetBendRadius), flangeLengthMm: Number(flangeLength), hemStyle }
                                  : reachResult?.ok === true ? reachResult.params : undefined;
            const revolveAxis = solidOp === "revolve" && revolveAxisChoice !== ""
              ? (revolveAxisChoice === "x" ? { kind: "sketch-axis" as const, axis: "x" as const } : { kind: "sketch-line" as const, entityId: revolveAxisChoice })
              : undefined;
            const effectiveProfileIds = refsOf(solidOp === "loft" && loftMode === "two-profile" && selectedProfileIds.length >= 2
              ? selectedProfileIds.slice(0, 1)
              : selectedProfileIds);
            const edgeForOp = solidOp === "edge-fillet"
              ? { kind: "fillet" as const, sizeMm: Number(modifierEdgeSize) }
              : solidOp === "edge-chamfer"
                ? { kind: "chamfer" as const, sizeMm: Number(modifierEdgeSize) }
                : solidOp === "extrude" && edgeKind !== "none"
                  ? { kind: edgeKind, sizeMm: Number(edgeSize) }
                  : undefined;
            props.onCreateSolid(
              effectiveProfileIds,
              plane,
              solidOp,
              cutThroughAll && !(Number(solidValue) > 0) ? 1 : Number(solidValue),
              edgeForOp,
              reachResult?.ok === true ? reachResult.direction : undefined,
              modifying ? { mode: solidResult, bodyId: effectiveTarget, ...(cutThroughAll ? { extent: "through-all" as const } : {}) } : undefined,
              revolveAxis === undefined ? advanced : { ...(advanced ?? {}), revolveAxis }
            );
          }}><CommandIcon name={solidResult === "cut" ? "subtract" : solidResult === "join" ? "unite" : "box"} />{solidResult === "cut" ? "Cut solid" : solidResult === "join" ? "Join solid" : "Create solid"}</button>
          {profiles.length === 0 && <small className="make-solid-hint make-solid-reason" role="status">No closed region yet. {noProfileReasons.join(" ")} Open Validate Sketch for every open end and gap.</small>}
          {solidOp === "extrude" && profiles.length > 0 && <small className="make-solid-hint">{selectedProfileIds.length === 0 ? "Nothing selected: the outermost outline is used and outlines inside it become holes. Click regions to choose exactly which (Shift-click adds more, and several separate regions extrude together)." : selectedProfileIds.length === 1 ? "Only the clicked region is used. Shift-click the region inside a hole to fill it, or other separate regions to extrude them together." : `${selectedProfileIds.length} regions selected: touching regions merge, separate ones extrude together.`}</small>}
          {regionWarnings.map((warning) => <small key={warning} className="make-solid-hint make-solid-warning" role="status">{warning}</small>)}
        </div>
        <details className="palette-shortcuts">
          <summary>Shortcuts</summary>
          <dl>{sketchHotkeyHelp(sketchKeymap).map((entry, index) => <div key={`${index}:${entry.keys}`}><dt>{entry.keys}</dt><dd>{entry.action}</dd></div>)}</dl>
        </details>
        </>}
      </div>

      <div className="canvas-hud"><span>{planePlacement} · {planeInfo.horizontalLabel} → · {planeInfo.verticalLabel} ↑</span><span>{props.dimensionMode ? "Dimension" : sketchToolLabel(props.tool)}</span><span>Grid {props.viewportState.gridVisible ? fmtLen(grid.minorMm) : "off"}</span><span>Snap {snapEnabled ? `${SNAP_PIXELS} px` : "off"}</span><span>{pointerInside ? `${planeInfo.horizontalLabel} ${formatLength(cursor[0], unit)}  ${planeInfo.verticalLabel} ${fmtLen(cursor[1])}` : "Cursor outside the sketch"}</span><span>{visibleEntities.length}/{props.sketch.entities.length} entities visible</span><strong>{analysis.classification.replace("-", " ")}</strong></div>
      <div className="confirmation-corner" role="group" aria-label="Sketch confirmation corner">
        <small>Sketch</small>
        <button type="button" onClick={props.onCancelSketch} title="Discard the changes made in this sketch session and return to Design. Ctrl+Z brings them back."><CommandIcon name="cancel" />Cancel</button>
        <button type="button" className="primary" onClick={props.onFinishSketch} title="Finish the sketch and commit it to the timeline."><CommandIcon name="save" />OK</button>
      </div>
    </section>

    <aside className="inspector-panel" aria-label="Sketch inspector">
      <div className="inspector-title"><div><p>Sketch intelligence</p><h2>{props.sketch.name}</h2></div><CapabilityBadge level="preview" /></div>
      <section className={`solver-card ${analysis.classification}`}>
        <span className="solver-number">{analysis.degreesOfFreedom}</span>
        <div><strong>{analysis.classification === "fully-constrained" ? "Fully constrained" : analysis.classification === "conflict" ? "Constraint conflict" : "Degrees of freedom"}</strong><small>{analysis.appliedConstraints} constraints enforced, rank {analysis.rank}{analysis.redundant.length > 0 ? `, ${analysis.redundant.length} redundant` : ""}</small></div>
      </section>
      {analysis.conflicts.length > 0 && <div className="inline-warning">{analysis.conflicts[0]}</div>}
      {analysis.redundant.length > 0 && analysis.conflicts.length === 0 && <div className="inline-warning" title={analysis.redundant.map((set) => set.message).join(" ")}>{analysis.redundant[0]!.message}</div>}

      {dynamicMirrorEntity !== undefined && props.editTool !== "dynamic-mirror" && <div className="inline-warning movable-note" role="status" aria-label="Dynamic mirror active">
        Dynamic mirror is on: what you draw is mirrored about {entityNames.get(dynamicMirrorEntity.id) ?? "the axis"}. <button className="palette-action" onClick={() => { setDynamicMirrorAxis(null); props.onMessage("Dynamic mirror stopped."); }}><CommandIcon name="cancel" />Stop</button>
      </div>}
      {props.editTool === "pattern" && <SketchPatternPanel key={`pattern-${unit}`} unit={unit} centrePick={centrePick.bridge} sketch={props.sketch} selectionIds={selectionIds} onApply={props.onApplyEdit} onMessage={props.onMessage} onClose={props.onCloseEditTool} onPreview={setEditPreview} />}
      {props.editTool === "import-drawing" && <SketchImportPanel sketch={props.sketch} onApply={props.onApplyEdit} onMessage={props.onMessage} onClose={props.onCloseEditTool} />}
      {props.editTool === "export-drawing" && <SketchExportPanel sketch={props.sketch} onApply={props.onApplyEdit} onMessage={props.onMessage} onClose={props.onCloseEditTool} />}
      {props.editTool === "underlay" && <SketchUnderlayPanel sketch={props.sketch} pick={underlayPick} onPickStart={() => { setUnderlayPick({ active: true, points: [] }); props.onMessage("Picture: click the first point on the picture."); }} onPickCancel={() => setUnderlayPick({ active: false, points: [] })} onApply={props.onApplyEdit} onMessage={props.onMessage} onClose={props.onCloseEditTool} />}
      {props.editTool !== null && props.editTool !== "pattern" && props.editTool !== "import-drawing" && props.editTool !== "export-drawing" && props.editTool !== "underlay" && <SketchEditPanel key={`${props.editTool}-${unit}`} unit={unit} centrePick={centrePick.bridge} tool={props.editTool} sketch={props.sketch} selectionIds={selectionIds} stretchWindow={stretchWindow} onStretchWindow={setStretchWindow} onApply={(plan) => { props.onApplyEdit(plan); }} onMessage={props.onMessage} onClose={props.onCloseEditTool} jog={jogParams} onJog={setJogParams} corner={cornerParams} onCorner={setCornerParams} onPreview={setEditPreview} dynamicMirrorAxis={dynamicMirrorAxis} onDynamicMirror={(axisId) => { setDynamicMirrorAxis(axisId); props.onMessage(axisId === null ? "Dynamic mirror stopped." : `Dynamic mirror on: pick a drawing tool; everything you draw is mirrored about ${axisId.replace(/^entity:/u, "")}.`); }} />}
      {props.checkOpen && <SketchRepairPanel sketch={props.sketch} onApplyEdit={props.onApplyEdit} onSetSuppressed={props.onSetSuppressed} onSelect={(ids) => { setSelectionIds(ids); props.onSelect(ids.at(-1) ?? null); }} onMessage={props.onMessage} onClose={props.onCloseCheck} />}
      {props.showMovable && <div className="inline-warning movable-note">{movableIds.size === 0 ? "Show Movable: every entity is fully constrained." : `Show Movable: ${movableIds.size} entit${movableIds.size === 1 ? "y has" : "ies have"} estimated degrees of freedom (amber).`}</div>}
      <section className="inspector-section point-relations"><header><strong>Point relations</strong><span>{pickRelation === null ? "pick points" : CONSTRAINT_TOOL_INFO[pickRelation].label}</span></header>
        <div className="constraint-buttons">
          {POINT_RELATION_TOOLS.map((entry) => <button key={entry.tool} className={pickRelation === entry.tool ? "active" : ""} aria-pressed={pickRelation === entry.tool} title={entry.title} onClick={() => toggleConstraintTool(entry.tool)}><CommandIcon name={entry.tool} />{entry.label}</button>)}
        </div>
        {pickRelation !== null && <p className="profile-help" role="status">{toolPicks.length === 0 ? CONSTRAINT_TOOL_INFO[pickRelation].prompt : `${toolPicks.map((pick) => pick.label).join(", ")} picked. Pick the next one on the canvas.`} The tool stays on for the next relation; Esc finishes.</p>}
      </section>

      <section className="inspector-section"><header><strong>Selection controller</strong><span>{selectionIds.length} selected</span></header>
        {selectedEntity === undefined ? <p className="empty-copy">Select an entity, or drag a box: left to right takes what the box fully encloses, right to left takes anything it touches. Shift adds to the selection.</p> : <>
          <dl className="compact-facts"><div><dt>Primary</dt><dd>{selectedEntity.kind}</dd></div><div><dt>Freedom</dt><dd>{analysis.entityFreedom[selectedEntity.id] ?? 0}</dd></div><div><dt>Stable ID</dt><dd>{shortId(selectedEntity.id)}</dd></div><div><dt>Constraints</dt><dd>{selectedConstraints.length}</dd></div></dl>
          <div className="selection-chips">{selectedEntities.map((entity, index) => <span key={entity.id}><b>{index + 1}</b>{entityNames.get(entity.id) ?? entity.kind}</span>)}</div>
          <div className="constraint-buttons">
            <button disabled={!horizontalFit.ok} title={hint(horizontalFit, "Make every selected line horizontal.")} onClick={() => { runSelectionAction(constrainEachPlan(props.sketch, "horizontal", selectedEntities, newConstraintId)); }}><CommandIcon name="horizontal" />Horizontal{scopeSuffix}</button>
            <button disabled={!verticalFit.ok} title={hint(verticalFit, "Make every selected line vertical.")} onClick={() => { runSelectionAction(constrainEachPlan(props.sketch, "vertical", selectedEntities, newConstraintId)); }}><CommandIcon name="vertical" />Vertical{scopeSuffix}</button>
            <button disabled={!parallelFit.ok} title={hint(parallelFit, "Make two lines parallel.")} onClick={() => constrain("parallel")}><CommandIcon name="parallel" />Parallel</button>
            <button disabled={!perpendicularFit.ok} title={hint(perpendicularFit, "Make two lines perpendicular.")} onClick={() => constrain("perpendicular")}><CommandIcon name="perpendicular" />Perpendicular</button>
            <button disabled={!collinearFit.ok} title={hint(collinearFit, "Put two lines on one line.")} onClick={() => constrain("collinear")}><CommandIcon name="collinear" />Collinear</button>
            <button disabled={!concentricFit.ok} title={hint(concentricFit, "Give two circles or arcs one centre.")} onClick={() => constrain("concentric")}><CommandIcon name="concentric" />Concentric</button>
            <button disabled={!equalFit.ok} title={hint(equalFit, "Make two lines equal in length, or two circles or arcs equal in radius.")} onClick={() => constrain("equal")}><CommandIcon name="equal" />Equal</button>
            <button disabled={!tangentFit.ok} title={hint(tangentFit, "Line and circle/arc, or two circles/arcs. The second selection is adjusted.")} onClick={() => constrain("tangent")}><CommandIcon name="tangent" />Tangent</button>
            <button disabled={!symmetricFit.ok} title={hint(symmetricFit, "Select two lines or two circles, then the axis line last. The second is mirrored onto the first.")} onClick={() => constrain("symmetry")}><CommandIcon name="mirror" />Symmetric</button>
            {!selectionFixed
              ? <button title="Fix every selected curve in place." onClick={() => { runSelectionAction(fixSelectionPlan(props.sketch, selectedEntities, newConstraintId)); }}><CommandIcon name="fixed" />Fix{selectionCount > 1 ? ` selection (${selectionCount})` : " curve"}</button>
              : <button title="Remove the Fixed relation from every selected curve so they can move again." onClick={() => { runSelectionAction(unfixSelectionPlan(props.sketch, selectionIds)); }}><CommandIcon name="unfixed" />Unfix{selectionCount > 1 ? ` selection (${selectionCount})` : " curve"}</button>}
            <button title={`Turn every selected curve into construction geometry, or back${keyHint("toggle-construction")}.`} onClick={() => { runSelectionAction(constructionSelectionPlan(selectedEntities)); }}><CommandIcon name={selectedEntities.every((entity) => entity.construction) ? "rectangle" : "construction"} />{selectedEntities.every((entity) => entity.construction) ? "Profile" : "Construction"}{scopeSuffix}</button>
            <button title="Hide every selected curve." onClick={() => { runSelectionAction(visibilitySelectionPlan(selectedEntities)); }}><CommandIcon name="eye-off" />Hide{selectionCount > 1 ? ` selection (${selectionCount})` : " curve"}</button>
            <button className="danger" title="Delete every selected curve (Delete)." onClick={() => { if (runSelectionAction(deleteSelectionPlan(props.sketch, selectionIds))) { setSelectionIds([]); props.onSelect(null); } }}><CommandIcon name="trash" />Delete{selectionCount > 1 ? ` selection (${selectionCount})` : " curve"}</button>
          </div>
        </>}
      </section>

      {props.dimensionMode && <section className="inspector-section direct-dimension-controller"><header><strong>Direct sketch dimension</strong><span>{dimensionPoints.length}/2 points</span></header>
        {dimensionPoints.length === 0 && <p className="empty-copy">Click a line, rectangle, or circle for its own size. Click a second curve for the distance or the angle between the two, or pick any two blue definition points and click to place their distance.</p>}
        {dimensionPoints.length === 1 && <div className="dimension-pick-state"><b>1</b><span>{dimensionPoints[0]!.label}</span><small>Pick the second point.</small></div>}
        {directDimension !== undefined && <>
          <dl className="compact-facts"><div><dt>Selection</dt><dd>{directDimension.first.label} → {directDimension.second.label}</dd></div><div><dt>Distance</dt><dd>{fmtLen(directDimension.valueMm)}</dd></div><div><dt>ΔX</dt><dd>{fmtLen(directDimension.delta[0])}</dd></div><div><dt>ΔY</dt><dd>{fmtLen(directDimension.delta[1])}</dd></div></dl>
          {directDimension.driving === undefined && directDimension.between !== undefined
            ? <PointDistanceField key={directDimension.first.id + directDimension.second.id} sketch={props.sketch} between={directDimension.between} measured={directDimension.valueMm} delta={directDimension.delta} onSetDimension={setDimension} onMessage={props.onMessage} />
            : directDimension.driving === undefined
            ? <div className="inline-warning">This is a reference measurement: the solver cannot move one of these points (a rectangle's edge middle, a circle's rim). Pick line or arc ends, centres, rectangle corners, points or the sketch origin to drive a distance.</div>
            : directDrivingEntity === undefined ? null
            : <DimensionField label={directDimension.label} dimension={directDimension.driving.dimension} entity={directDrivingEntity} sketch={props.sketch} value={directDimension.valueMm} onApply={(apply) => applyDimension(directDimension.driving!.entityId, apply)} onMessage={props.onMessage} />}
        </>}
      </section>}

      {!props.dimensionMode && <ConstraintExtras sketch={props.sketch} selected={selectedEntities} bridge={props.constraintExtras} onSetDimension={setDimension} onAddConstraint={props.onAddConstraint} onApplyEdit={props.onApplyEdit} onMessage={props.onMessage} />}
      <SketchRelationList constraints={selectedConstraints} entities={props.sketch.entities} onSetSuppressed={(ids, suppressed) => { props.onSetSuppressed(ids, suppressed); }} />
      {!props.dimensionMode && selectedEntity !== undefined && <section className="inspector-section dimension-controller"><header><strong>Driving dimensions</strong><span>{unit}</span></header><EntityDimensions entity={selectedEntity} sketch={props.sketch} onApply={(apply) => applyDimension(selectedEntity.id, apply)} onMessage={props.onMessage} /></section>}

      <section className="inspector-section profile-controller"><header><strong>Closed profiles</strong><span>{profiles.length} found</span></header>
        <p className="profile-help">Profile selects a shaded region; Curve, Connected and Tangent intents use the shared top selection controller. Use Create solid in the palette to extrude or revolve the selected profiles into a new body.</p>
        <SectionPropertiesPanel profiles={profiles} selectedProfileIds={selectedProfileIds} />
        <div className="profile-list">{profiles.map((profile, index) => <button key={profile.id} className={selectedProfileIds.includes(profile.id) ? "selected" : ""} onClick={(event) => selectProfile(profile, event.shiftKey || event.ctrlKey || event.metaKey)}><span><b>P{index + 1}</b>{profileLabel(profile)}</span><small>{format(profile.areaMm2)} mm²</small></button>)}</div>
      </section>

      <section className="inspector-section constraint-records"><header><strong>Constraint records</strong><span>{props.sketch.constraints.length}{redundantIds.size > 0 ? ` · ${redundantIds.size} redundant` : ""}</span></header>
        <ConstraintRecordList rows={recordRows} selectedIds={selectedConstraintIds} redundantIds={redundantIds} onHover={setHoverConstraintId} onSelect={selectConstraint} onDelete={deleteSelectedConstraints} onToggleRelaxed={(id, relaxed) => { props.onSetSuppressed([id], relaxed); }} />
      </section>
      <div className="scope-note"><strong>How the sketch is solved</strong><p>One simultaneous solver holds every relation and dimension on lines, arcs, circles, ellipses, rectangles and points at once and moves as little as it can; a Fixed curve never moves. Degrees of freedom come from the rank of the equations, so a relation the others already imply is listed as redundant, and relations that cannot all hold are refused with their names. Splines follow their own rules (Smooth, tangent handles), and a relation marked recorded, not solved, is kept but not enforced.</p></div>
    </aside>
  </SketchUnitContext.Provider>;
}

/** The editable length, angle, width, height or radius next to the cursor while a shape is being placed. */
export function DynamicInputBox(props: {
  /** The document's unit: lengths and coordinates are shown and read in it (a bare 2 is two inches in an inch document). */
  readonly unit: SketchLengthUnit;
  readonly fields: readonly { readonly id: DynamicFieldId; readonly label: string; readonly unit: string; readonly kind?: "length" | "angle" | "coordinate" }[];
  readonly live: DynamicValues;
  readonly text: Partial<Record<DynamicFieldId, string>>;
  /** A message per field whose text cannot be used; the field is marked and the point is not placed. */
  readonly errors: Partial<Record<DynamicFieldId, string>>;
  readonly position: readonly [number, number];
  readonly setRef: (id: DynamicFieldId, element: HTMLInputElement | null) => void;
  readonly onChange: (id: DynamicFieldId, value: string) => void;
  readonly onFocus: (id: DynamicFieldId) => void;
  readonly onBlur: () => void;
  readonly onCommit: () => boolean;
  readonly onCancel: () => void;
  readonly onTab: (id: DynamicFieldId, backwards: boolean) => void;
}): React.JSX.Element {
  const isAngle = (id: DynamicFieldId): boolean => props.fields.find((field) => field.id === id)?.kind === "angle";
  const show = (id: DynamicFieldId): string => {
    const typed = props.text[id];
    if (typed !== undefined) return typed;
    const live = props.live[id];
    if (live === undefined) return "";
    return isAngle(id) ? String(Number(live.toFixed(2))) : formatLength(live, props.unit, props.unit === "in" ? 4 : 2);
  };
  const unitOf = (field: { readonly id: DynamicFieldId; readonly unit: string; readonly kind?: string }): string => (field.kind === "angle" ? field.unit : props.unit);
  return <div className="dynamic-input" style={{ left: props.position[0], top: props.position[1] }} role="group" aria-label="Typed input">
    {props.fields.map((field) => <label key={field.id} className={props.errors[field.id] !== undefined ? "invalid" : props.text[field.id] === undefined ? "" : "locked"}>
      <span>{field.label}</span>
      <input
        ref={(element) => props.setRef(field.id, element)}
        inputMode="text"
        autoComplete="off"
        spellCheck={false}
        aria-invalid={props.errors[field.id] !== undefined}
        aria-label={`${field.label} in ${field.kind === "angle" ? field.unit : unitWord(props.unit)}`}
        value={show(field.id)}
        onFocus={() => props.onFocus(field.id)}
        onBlur={props.onBlur}
        onChange={(event) => props.onChange(field.id, event.target.value)}
        onKeyDown={(event) => {
          // After placing, give the keyboard back to the canvas so Esc, tool letters and Delete work again.
          if (event.key === "Enter") { event.preventDefault(); if (props.onCommit()) event.currentTarget.blur(); }
          else if (event.key === "Tab") { event.preventDefault(); props.onTab(field.id, event.shiftKey); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onCancel(); event.currentTarget.blur(); }
        }}
      />
      <small>{unitOf(field)}</small>
    </label>)}
    {props.fields.map((field) => props.errors[field.id] === undefined ? null : <em key={`error-${field.id}`} className="dynamic-error" role="alert">{field.label}: {props.errors[field.id]}</em>)}
    <em>Type a value or 12 mm, 0.5 in, 2*name · Tab next · Enter place · #x,y or @dx,dy</em>
  </div>;
}

/** The glyph, label and alignment guides for what the pointer is snapped to. All sizes are in screen pixels. */
function InferenceMarks({ inference, px }: { readonly inference: InferenceResult; readonly px: number }): React.JSX.Element {
  const primary = inference.primary;
  const s = 6 * px;
  const x = inference.point[0];
  const y = -inference.point[1];
  const glyph = (): React.JSX.Element | null => {
    if (primary === undefined) return null;
    switch (primary.kind) {
      case "endpoint": return <rect x={x - s} y={y - s} width={2 * s} height={2 * s} />;
      case "midpoint": return <path d={`M ${x} ${y - s * 1.1} L ${x + s * 1.1} ${y + s * 0.8} L ${x - s * 1.1} ${y + s * 0.8} Z`} />;
      case "center": return <><circle cx={x} cy={y} r={s} /><circle cx={x} cy={y} r={1.2 * px} className="dot" /></>;
      case "origin": return <><circle cx={x} cy={y} r={s} /><path d={`M ${x - s * 1.5} ${y} H ${x + s * 1.5} M ${x} ${y - s * 1.5} V ${y + s * 1.5}`} /></>;
      case "quadrant": return <path d={`M ${x} ${y - s * 1.2} L ${x + s * 1.2} ${y} L ${x} ${y + s * 1.2} L ${x - s * 1.2} ${y} Z`} />;
      case "intersection": return <path d={`M ${x - s} ${y - s} L ${x + s} ${y + s} M ${x - s} ${y + s} L ${x + s} ${y - s}`} />;
      case "on-curve": return <><circle cx={x} cy={y} r={s * 0.8} /><circle cx={x} cy={y} r={1.2 * px} className="dot" /></>;
      case "perpendicular": return <path d={`M ${x - s} ${y + s} V ${y - s * 0.2} H ${x + s} M ${x - s} ${y + s} H ${x + s}`} />;
      case "tangent": return <><circle cx={x} cy={y - s * 0.6} r={s * 0.6} /><path d={`M ${x - s * 1.3} ${y + s * 0.6} H ${x + s * 1.3}`} /></>;
      case "parallel": return <path d={`M ${x - s} ${y + s * 0.2} L ${x + s * 0.2} ${y - s} M ${x - s * 0.2} ${y + s} L ${x + s} ${y - s * 0.2}`} />;
      case "equal": return <path d={`M ${x - s} ${y - s * 0.4} H ${x + s} M ${x - s} ${y + s * 0.4} H ${x + s}`} />;
      case "collinear": return <><path d={`M ${x - s * 1.4} ${y} H ${x + s * 1.4}`} /><circle cx={x} cy={y} r={1.4 * px} className="dot" /></>;
      case "grid": return <path d={`M ${x - s * 0.7} ${y} H ${x + s * 0.7} M ${x} ${y - s * 0.7} V ${y + s * 0.7}`} />;
      default: return null;
    }
  };
  return <g className="inference-marks" pointerEvents="none">
    {inference.guides.map((guide, index) => <line key={index} className="inference-guide" x1={guide.from[0]} y1={-guide.from[1]} x2={guide.to[0]} y2={-guide.to[1]} />)}
    {primary !== undefined && primary.kind !== "grid" && <g className="inference-glyph">{glyph()}</g>}
    {((primary !== undefined && primary.kind !== "grid") || inference.note !== undefined) && <text className="inference-label" x={x + 11 * px} y={y - 9 * px} style={{ fontSize: 11.5 * px, strokeWidth: 3 * px }}>{inference.note ?? (primary === undefined ? "" : INFERENCE_LABELS[primary.kind])}</text>}
  </g>;
}

function PaletteToggle({ label, active, onToggle }: { readonly label: string; readonly active: boolean; readonly onToggle: (active: boolean) => void }): React.JSX.Element {
  return <label><span>{label}</span><input type="checkbox" checked={active} onChange={(event) => onToggle(event.target.checked)} /></label>;
}

function DirectDimensionPreview({ dimension, px }: { readonly dimension: DirectSketchDimension; readonly px: number }): React.JSX.Element {
  const unit = useSketchUnit();
  const x = (dimension.first.point[0] + dimension.second.point[0]) / 2;
  const y = -(dimension.first.point[1] + dimension.second.point[1]) / 2 - 8 * px;
  return <g className={`direct-dimension-preview ${dimension.driving === undefined ? "reference" : "driving"}`} pointerEvents="none">
    <line x1={dimension.first.point[0]} y1={-dimension.first.point[1]} x2={dimension.second.point[0]} y2={-dimension.second.point[1]} />
    <text x={x} y={y} style={{ fontSize: 12 * px, strokeWidth: 3 * px }}>{sketchLength(dimension.valueMm, unit)}</text>
  </g>;
}

function SketchEntityShape({ entity, name, px, selected, hovered, related = false, focused = false, handleRadiusPx = 5, hitRadiusPx = 10, onSelect, onHover, onGrab, onHandlePick, handles, preview = false, reference = false, movable = false, constrained = false }: { readonly entity: SketchEntity; /** "Line 3": shown as the tooltip. */ readonly name?: string | undefined; readonly px: number; readonly selected: boolean; readonly hovered: boolean; readonly related?: boolean; readonly focused?: boolean; readonly handleRadiusPx?: number; readonly hitRadiusPx?: number; readonly onSelect?: (additive: boolean) => void; readonly onHover?: (inside: boolean) => void; readonly onGrab?: (event: React.PointerEvent, handle: DragHandle) => void; readonly onHandlePick?: (handle: SketchGrabHandle) => void; readonly handles?: readonly SketchGrabHandle[]; readonly preview?: boolean; /** A curve of the model behind the sketch: dimmed, takes no pointer input and has no selection id. */ readonly reference?: boolean; readonly movable?: boolean; readonly constrained?: boolean }): React.JSX.Element {
  // Fully constrained curves are drawn in a neutral tone and under-constrained ones in the working colour, so what can still move is visible at a glance.
  const className = `sketch-entity ${entity.construction ? "construction" : ""} ${selected ? "selected" : ""} ${hovered && !selected ? "hover" : ""} ${related ? "related" : ""} ${focused ? "kb-focus" : ""} ${preview ? "tool-preview" : ""} ${movable && !selected ? "movable" : ""} ${constrained && !preview && entity.kind !== "point" ? "constrained" : ""}`;
  const geometry = (cls: string, hit: boolean): React.JSX.Element => {
    if (entity.kind === "line") return <line className={cls} x1={entity.start[0]} y1={-entity.start[1]} x2={entity.end[0]} y2={-entity.end[1]} />;
    if (entity.kind === "rectangle") return <rect className={cls} x={entity.center[0] - entity.widthMm / 2} y={-entity.center[1] - entity.heightMm / 2} width={entity.widthMm} height={entity.heightMm} transform={`rotate(${-entity.rotationDeg} ${entity.center[0]} ${-entity.center[1]})`} />;
    if (entity.kind === "circle") return <circle className={cls} cx={entity.center[0]} cy={-entity.center[1]} r={entity.radiusMm} />;
    if (entity.kind === "ellipse") return <ellipse className={cls} cx={entity.center[0]} cy={-entity.center[1]} rx={entity.majorRadiusMm} ry={entity.minorRadiusMm} transform={`rotate(${-entity.rotationDeg} ${entity.center[0]} ${-entity.center[1]})`} />;
    if (entity.kind === "point") return <circle className={`${cls} sketch-point`} cx={entity.point[0]} cy={-entity.point[1]} r={(hit ? 9 : 3.5) * px} />;
    if (entity.kind === "spline") return <path className={cls} d={sampleSplineToBound(entity.fitPoints).map((point, index) => `${index === 0 ? "M" : "L"} ${point[0]} ${-point[1]}`).join(" ")} />;
    return <path className={cls} d={arcPathData(entity.start, entity.mid, entity.end)} />;
  };
  if (reference) return <g data-reference-id={entity.id}>{geometry("sketch-entity reference", false)}</g>;
  if (preview || onSelect === undefined) return <g data-selection-id={entity.id}>{geometry(className, false)}</g>;
  return <g
    className="sketch-entity-group"
    data-selection-id={entity.id}
    onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); onSelect(event.shiftKey || event.ctrlKey || event.metaKey); onGrab?.(event, { kind: "body" }); }}
    onPointerEnter={() => onHover?.(true)}
    onPointerLeave={() => onHover?.(false)}
  >
    {name !== undefined && <title>{name}</title>}
    {geometry("sketch-hit", true)}
    {geometry(className, false)}
    {(selected || hovered) && handles?.map((handle) => <g key={handle.id}>
      <circle className="grab-hit" cx={handle.point[0]} cy={-handle.point[1]} r={hitRadiusPx * px} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); onSelect(false); onHandlePick?.(handle); onGrab?.(event, handle.handle); }} />
      <circle
        className={`grab-handle ${handle.handle.kind}`}
        data-grab-handle={handle.id}
        cx={handle.point[0]}
        cy={-handle.point[1]}
        r={handleRadiusPx * px}
        role="button"
        aria-label={`Drag ${handle.label}`}
        onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); onSelect(false); onHandlePick?.(handle); onGrab?.(event, handle.handle); }}
      />
    </g>)}
  </g>;
}

function arcPathData(start: Vec2, mid: Vec2, end: Vec2): string {
  // Work in screen space (the canvas plots sketch points as (x, -y)).
  const s: Vec2 = [start[0], -start[1]];
  const m: Vec2 = [mid[0], -mid[1]];
  const e: Vec2 = [end[0], -end[1]];
  const circle = sketchCircumcircle(s, m, e);
  if (circle === undefined) return `M ${s[0]} ${s[1]} Q ${m[0]} ${m[1]} ${e[0]} ${e[1]}`;
  const twoPi = Math.PI * 2;
  const mod = (value: number): number => ((value % twoPi) + twoPi) % twoPi;
  const angle = (p: Vec2): number => Math.atan2(p[1] - circle.center[1], p[0] - circle.center[0]);
  const base = angle(s);
  const spanToEnd = mod(angle(e) - base);
  const spanToMid = mod(angle(m) - base);
  // sweep-flag 1 traverses increasing angle in SVG user space; pick the direction that passes through mid.
  const sweepFlag = spanToMid <= spanToEnd ? 1 : 0;
  const span = sweepFlag === 1 ? spanToEnd : twoPi - spanToEnd;
  const largeArc = span > Math.PI ? 1 : 0;
  return `M ${s[0]} ${s[1]} A ${format(circle.radiusMm)} ${format(circle.radiusMm)} 0 ${largeArc} ${sweepFlag} ${e[0]} ${e[1]}`;
}

function sketchCircumcircle(a: Vec2, b: Vec2, c: Vec2): { readonly center: Vec2; readonly radiusMm: number } | undefined {
  const determinant = 2 * (a[0] * (b[1] - c[1]) + b[0] * (c[1] - a[1]) + c[0] * (a[1] - b[1]));
  if (Math.abs(determinant) < 1e-9) return undefined;
  const a2 = a[0] ** 2 + a[1] ** 2;
  const b2 = b[0] ** 2 + b[1] ** 2;
  const c2 = c[0] ** 2 + c[1] ** 2;
  const center: Vec2 = [
    (a2 * (b[1] - c[1]) + b2 * (c[1] - a[1]) + c2 * (a[1] - b[1])) / determinant,
    (a2 * (c[0] - b[0]) + b2 * (a[0] - c[0]) + c2 * (b[0] - a[0])) / determinant
  ];
  return { center, radiusMm: Math.hypot(center[0] - a[0], center[1] - a[1]) };
}

function SketchProfileShape({ profile, selected, onSelect }: { readonly profile: SketchProfile; readonly selected: boolean; readonly onSelect?: (additive: boolean) => void }): React.JSX.Element {
  // A profile never handles the press itself: the canvas decides on release whether it was a click (select the profile)
  // or the start of a box drag, so dragging from inside a shaded region still draws a selection box.
  const common = {
    className: `sketch-profile ${selected ? "selected" : ""}`,
    "data-selection-id": profile.id,
    ...(onSelect === undefined ? {} : { "data-profile-id": profile.id }),
    style: onSelect === undefined ? { pointerEvents: "none" as const } : undefined,
    "aria-label": `${profileLabel(profile)} closed profile`
  };
  if (profile.holes !== undefined && profile.holes.length > 0) {
    // A region with islands in it is drawn with the islands cut out, so a click in a hole falls through to the region inside it.
    const ring = (points: readonly Vec2[]): string => `${points.map((point, index) => `${index === 0 ? "M" : "L"} ${point[0]} ${-point[1]}`).join(" ")} Z`;
    return <path {...common} fillRule="evenodd" d={[profileOutlineMm(profile.boundary), ...profile.holes.map((hole) => profileOutlineMm(hole.boundary))].map(ring).join(" ")} />;
  }
  if (profile.boundary.kind === "rectangle") return <rect {...common} x={profile.boundary.center[0] - profile.boundary.widthMm / 2} y={-profile.boundary.center[1] - profile.boundary.heightMm / 2} width={profile.boundary.widthMm} height={profile.boundary.heightMm} transform={`rotate(${-profile.boundary.rotationDeg} ${profile.boundary.center[0]} ${-profile.boundary.center[1]})`} />;
  if (profile.boundary.kind === "circle") return <circle {...common} cx={profile.boundary.center[0]} cy={-profile.boundary.center[1]} r={profile.boundary.radiusMm} />;
  if (profile.boundary.kind === "ellipse") return <ellipse {...common} cx={profile.boundary.center[0]} cy={-profile.boundary.center[1]} rx={profile.boundary.majorRadiusMm} ry={profile.boundary.minorRadiusMm} transform={`rotate(${-profile.boundary.rotationDeg} ${profile.boundary.center[0]} ${-profile.boundary.center[1]})`} />;
  const path = profile.boundary.points.map((point, index) => `${index === 0 ? "M" : "L"} ${point[0]} ${-point[1]}`).join(" ");
  return <path {...common} d={`${path} Z`} />;
}

function SketchDimensionGlyph({ entity, px, label }: { readonly entity: SketchEntity; readonly px: number; readonly label: (valueMm: number) => string }): React.JSX.Element {
  const style = { fontSize: 12 * px, strokeWidth: 3 * px };
  if (entity.kind === "line") {
    const x = (entity.start[0] + entity.end[0]) / 2;
    const y = -(entity.start[1] + entity.end[1]) / 2 - 8 * px;
    return <text x={x} y={y} style={style} className="sketch-dimension-glyph">{label(Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]))}</text>;
  }
  if (entity.kind === "rectangle") return <><text x={entity.center[0]} y={-entity.center[1] + entity.heightMm / 2 + 16 * px} style={style} className="sketch-dimension-glyph">{label(entity.widthMm)}</text><text x={entity.center[0] + entity.widthMm / 2 + 12 * px} y={-entity.center[1]} style={style} className="sketch-dimension-glyph vertical">{label(entity.heightMm)}</text></>;
  if (entity.kind === "circle") return <text x={entity.center[0] + entity.radiusMm * 0.35} y={-entity.center[1] - 8 * px} style={style} className="sketch-dimension-glyph">R {label(entity.radiusMm)}</text>;
  return <></>;
}

function entityAnchor(entity: SketchEntity): Vec2 {
  if (entity.kind === "line") return [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2];
  if (entity.kind === "rectangle" || entity.kind === "circle" || entity.kind === "ellipse") return entity.center;
  if (entity.kind === "point") return entity.point;
  if (entity.kind === "spline") return entity.fitPoints[Math.floor(entity.fitPoints.length / 2)]!;
  return entity.mid;
}

function profileLabel(profile: SketchProfile): string {
  const holes = profile.holes?.length ?? 0;
  const base = profile.boundary.kind === "rectangle" ? "Rectangle region" : profile.boundary.kind === "circle" ? "Circle region" : profile.boundary.kind === "ellipse" ? "Ellipse region" : profile.boundary.kind === "curve-loop" ? "Closed curve loop" : "Closed line loop";
  return holes === 0 ? base : `${base} with ${holes} hole${holes === 1 ? "" : "s"}`;
}

function shortId(id: string): string {
  return id.length < 28 ? id : `${id.slice(0, 18)}…${id.slice(-7)}`;
}

function format(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** The display unit of the workspace being rendered. SketchWorkspace sets it on every render before its children draw; the helpers below read it. */
let lengthUnit: SketchLengthUnit = "mm";
/** A length in millimetres as text with the display unit: "12.7 mm" or "0.5 in". */
function fmtLen(valueMm: number): string {
  return formatLengthWithUnit(valueMm, lengthUnit);
}
/** The same without the symbol, for the reference values drawn on the canvas. */
function fmtNum(valueMm: number): string {
  return formatLength(valueMm, lengthUnit);
}
