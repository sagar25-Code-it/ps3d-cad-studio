import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SOLVABLE_POINT_REFS, constraintFit, planeWorldCoordinate, type DesignExtentTarget, type GeneralSolidBody, type ConstraintFit, type SketchDatumPlane, type SketchDimensionName, type SketchEntity, type SketchConstraintKind, type SketchPointRef, type Vec2, type WorkbenchSketch, type WorkbenchSketchConstraint } from "../../../../packages/workbench-core/src/index.js";
import {
  analyzeWorkbenchSketch,
  buildSketchEntity,
  detectSketchProfiles,
  explainNoProfiles,
  profileInBox,
  resolveProfileRegion,
  isShapeTool,
  profileOutlineMm,
  requiredSketchPoints,
  selectConnectedSketchEntities,
  selectTangentSketchEntities,
  sampleSpline,
  sketchBounds,
  sketchChainBranchCount,
  sketchToolLabel,
  type SketchProfile,
  type SketchTool
} from "../../../../packages/workbench-sketch/src/index.js";
import { gridSteps, sketchToScreen } from "../../../../packages/workbench-sketch/src/camera.js";
import { dynamicFieldsFor, measureFromCursor, parseDynamicNumber, pointFromDynamicInput, type DynamicFieldId, type DynamicValues } from "../../../../packages/workbench-sketch/src/dynamic-input.js";
import { sketchCurvatureCombs } from "../../../../packages/workbench-sketch/src/curvature-comb.js";
import { constraintsOnEntities, extendAt, nearestEntityId, trimAt, type SketchEditPlan } from "../../../../packages/workbench-sketch/src/edit-tools.js";
import { deleteCurveHeal, jogLine, splitAt } from "../../../../packages/workbench-sketch/src/split-jog.js";
import { mirrorImages, withDynamicMirror } from "../../../../packages/workbench-sketch/src/dynamic-mirror.js";
import { copySketchSelection, cutSketchSelection, nextPasteNumber, parseClipboard, pasteSketchClipboard, readSketchClipboard, serializeClipboard, storeSketchClipboard, type SketchClipboard } from "../../../../packages/workbench-sketch/src/sketch-clipboard.js";
import { SKETCH_HOTKEY_HELP, type SketchHotkeyAction } from "../../../../packages/workbench-sketch/src/hotkeys.js";
import { INFERENCE_LABELS, inferSketchPoint, type InferenceResult } from "../../../../packages/workbench-sketch/src/inference.js";
import { autoConstraintsFor, dropConstraintFor, type PlacedPointInference } from "../../../../packages/workbench-sketch/src/auto-constraints.js";
import { dragSketchHandle, grabHandlesOf, type DragHandle, type SketchGrabHandle } from "../../../../packages/workbench-sketch/src/drag.js";
import { arrowHead, dimensionLayout } from "../../../../packages/workbench-sketch/src/dimension-layout.js";
import { POLYGON_DEFAULT_SIDES, POLYGON_MAX_SIDES, POLYGON_MIN_SIDES, buildPolygon, buildSlot, buildSlotOverall, type SketchShape } from "../../../../packages/workbench-sketch/src/shapes.js";
import { CURVE_TOOL_PROMPTS, buildControlPointSpline, buildCurveTool, isFixedCurveTool } from "../../../../packages/workbench-sketch/src/curve-tools.js";
import { extendProfileChain, startProfileChain, type ProfileChain } from "../../../../packages/workbench-sketch/src/blend-profile.js";
import { DEFAULT_CURVE_OPTION_FIELDS, SketchCurveOptionsPanel, curveOptionsFromFields } from "./SketchCurveOptions.js";
import { createBlockLibrary, makeSketchBlock } from "../../../../packages/workbench-sketch/src/sketch-blocks.js";
import { entitiesInSelectionBox, selectionBoxMode, selectionRect, type SketchSelectionBoxMode } from "../../../../packages/workbench-sketch/src/selection.js";
import { DEFAULT_JOG_PARAMS, SKETCH_EDIT_TOOL_LABELS, SketchEditPanel, SketchRelationList, isClickEditTool, type JogParams, type SketchEditToolId, type StretchWindowRect } from "./SketchEditPanel.js";
import { SketchRepairPanel } from "./SketchRepairPanel.js";
import { ReachOptions } from "./ReachOptions.js";
import { DEFAULT_REACH, buildReach, isReachTarget, type ReachSettings } from "../reach-settings.js";
import { SketchGrid } from "./sketch/SketchGrid.js";
import { ConstraintExtras, ExtraDimensionMarks, type ConstraintExtrasBridge, type SetDimensionRequest } from "./sketch/ConstraintExtras.js";
import { angleDimensionLayout } from "../../../../packages/workbench-sketch/src/dimension-layout.js";
import { angleBetweenLinesDeg, entityLengthMm } from "../../../../packages/workbench-core/src/sketch-measure.js";
import { useSketchCamera } from "./sketch/useSketchCamera.js";
import { useSketchHotkeys } from "./sketch/useSketchHotkeys.js";
import {
  type NavigationMode,
  type SelectionFilter,
  type ViewOrientation,
  type ViewportViewState,
  type ViewProjection
} from "../../../../packages/viewport-three/src/index.js";
import { halvedExpression, unhalvedExpression } from "../dimension-expression.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";
import { CommandIcon } from "../ui/CommandIcon.js";
import { ViewportChrome } from "../ui/ViewportChrome.js";

type DrivingDimension = SketchDimensionName;
type SketchDimensionHandle = "start" | "mid" | "end" | "left" | "right" | "top" | "bottom" | "center" | "radius";

interface SketchDimensionPoint {
  readonly id: string;
  readonly entityId: string;
  readonly entityKind: SketchEntity["kind"];
  readonly handle: SketchDimensionHandle;
  readonly point: Vec2;
  readonly label: string;
}

interface DirectSketchDimension {
  readonly label: string;
  readonly valueMm: number;
  readonly delta: Vec2;
  readonly first: SketchDimensionPoint;
  readonly second: SketchDimensionPoint;
  readonly driving?: { readonly entityId: string; readonly dimension: DrivingDimension };
}

type PlaneKey = "xy" | "xz" | "yz";

/** A defining point of an entity that Coincident and Midpoint can be anchored to. */
interface RelationPoint {
  readonly id: string;
  readonly entityId: string;
  readonly ref: SketchPointRef;
  readonly point: Vec2;
  readonly label: string;
}

/** The points of an entity the live solver can move, with where they are. Arc ends and rectangle corners are not offered. */
function relationPoints(entity: SketchEntity): readonly RelationPoint[] {
  const make = (ref: SketchPointRef, point: Vec2, label: string): RelationPoint => ({ id: `relation-point:${entity.id}:${ref}`, entityId: entity.id, ref, point, label });
  const offered = SOLVABLE_POINT_REFS[entity.kind];
  const found: RelationPoint[] = [];
  if (entity.kind === "line") {
    if (offered.includes("start")) found.push(make("start", entity.start, "Line start"));
    if (offered.includes("end")) found.push(make("end", entity.end, "Line end"));
    if (offered.includes("mid")) found.push(make("mid", [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2], "Line midpoint"));
  } else if (entity.kind === "circle") {
    found.push(make("center", entity.center, "Circle center"));
  } else if (entity.kind === "ellipse") {
    found.push(make("center", entity.center, "Ellipse center"));
  } else if (entity.kind === "arc") {
    const circle = sketchCircumcircle(entity.start, entity.mid, entity.end);
    if (circle !== undefined) found.push(make("center", circle.center, "Arc center"));
  } else if (entity.kind === "point") {
    found.push(make("self", entity.point, "Sketch point"));
  }
  return found;
}

/** How each datum plane maps the sketch's horizontal and vertical directions onto the world axes (see general-modeling.ts placeOnPlane). */
const PLANE_INFO: Readonly<Record<PlaneKey, { readonly name: string; readonly horizontal: "x" | "z"; readonly vertical: "y" | "z"; readonly horizontalLabel: string; readonly verticalLabel: string }>> = {
  xy: { name: "Top (XY)", horizontal: "x", vertical: "y", horizontalLabel: "X", verticalLabel: "Y" },
  xz: { name: "Front (XZ)", horizontal: "x", vertical: "z", horizontalLabel: "X", verticalLabel: "Z" },
  yz: { name: "Right (YZ)", horizontal: "z", vertical: "y", horizontalLabel: "−Z", verticalLabel: "Y" }
};

function planeKeyOf(plane: SketchDatumPlane): PlaneKey {
  return plane === "datum:xz" ? "xz" : plane === "datum:yz" ? "yz" : "xy";
}

/** Reach, in screen pixels, of snapping, picking and "click the last point again to finish". */
const SNAP_PIXELS = 9;
const PICK_PIXELS = 10;

interface SketchWorkspaceProps {
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
  readonly onCreateSolid: (
    profileIds: readonly string[],
    plane: PlaneKey,
    operation: "extrude" | "revolve" | "sweep" | "loft" | "edge-fillet" | "edge-chamfer" | "shell" | "draft" | "helix" | "thread" | "rib" | "dome" | "sheet-base" | "sheet-flange" | "sheet-hem",
    valueMm: number,
    edge?: { readonly kind: "chamfer" | "fillet"; readonly sizeMm: number },
    direction?: "one-side" | "symmetric" | "flipped" | "two-side",
    target?: { readonly mode: "join" | "cut"; readonly bodyId: string; readonly extent?: "through-all" },
    advancedParams?: {
      readonly secondValueMm?: number;
      readonly extent?: "to-face" | "to-body" | "to-vertex" | "to-first" | "to-last";
      readonly extentTarget?: DesignExtentTarget;
      readonly thinWallMm?: number;
      readonly thinSide?: "inside" | "outside" | "center";
      readonly sweepDirectionMm?: readonly [number, number, number];
      readonly sweepPathEntityId?: string;
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
  readonly editTool: SketchEditToolId | null;
  readonly showMovable: boolean;
  readonly checkOpen: boolean;
  /** A one-shot ribbon command (Fix Curve, Relax Relations or Relax Dimensions); a new serial triggers it once. */
  readonly request: { readonly command: "fix-curve" | "relax-relations" | "relax-dimensions"; readonly serial: number } | null;
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
  /** Cancel click in the viewport Confirmation Corner: drop pending points and leave the sketch workspace. */
  readonly onCancelSketch: () => void;
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

export function SketchWorkspace(props: SketchWorkspaceProps): React.JSX.Element {
  const [pending, setPending] = useState<readonly Vec2[]>([]);
  const [cursor, setCursor] = useState<Vec2>([0, 0]);
  const [inference, setInference] = useState<InferenceResult | undefined>(undefined);
  // Relations drawn with a shape (Coincident at snapped ends, Horizontal on a level guide...) and the snap each placed point had.
  const [autoConstrain, setAutoConstrain] = useState(true);
  const [pendingInference, setPendingInference] = useState<readonly PlacedPointInference[]>([]);
  // Picking the points of a Coincident or Midpoint relation on the canvas.
  const [pickRelation, setPickRelation] = useState<"coincident" | "midpoint" | null>(null);
  const [pickedPoint, setPickedPoint] = useState<RelationPoint | undefined>(undefined);
  // The in-place value editor for a driving dimension (opened from Sketch Dimension, or by clicking a dimension's text).
  const [dimensionEdit, setDimensionEdit] = useState<{ readonly entityId: string; readonly dimension: DrivingDimension; readonly anchor: Vec2; readonly label: string; readonly secondEntityId?: string } | undefined>(undefined);
  const [dimensionText, setDimensionText] = useState("");
  const [polygonSides, setPolygonSides] = useState(String(POLYGON_DEFAULT_SIDES));
  // The extra curve tools (rounded rectangle, conics, blend, profile, text ...): their palette numbers, and the Profile chain being drawn.
  const [curveFields, setCurveFields] = useState(DEFAULT_CURVE_OPTION_FIELDS);
  const profileChain = useRef<ProfileChain | undefined>(undefined);
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
  const chainStart = useRef<Vec2 | undefined>(undefined);
  const chainSegments = useRef(0);
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
  const [jogParams, setJogParams] = useState<JogParams>(DEFAULT_JOG_PARAMS);
  /** Dynamic Mirror: the line new curves are mirrored about, or null when off. It outlives the edit panel so drawing tools can use it. */
  const [dynamicMirrorAxis, setDynamicMirrorAxis] = useState<string | null>(null);
  const [dimensionPoints, setDimensionPoints] = useState<readonly SketchDimensionPoint[]>([]);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [solidOp, setSolidOp] = useState<"extrude" | "revolve" | "sweep" | "loft" | "edge-fillet" | "edge-chamfer" | "shell" | "draft" | "helix" | "thread" | "rib" | "dome" | "sheet-base" | "sheet-flange" | "sheet-hem">("extrude");
  const [solidValue, setSolidValue] = useState("10");
  const [sweepDx, setSweepDx] = useState("0");
  const [sweepDy, setSweepDy] = useState("0");
  const [sweepDz, setSweepDz] = useState("1");
  const [sweepMode, setSweepMode] = useState<"direction" | "path">("direction");
  const [sweepPathEntityId, setSweepPathEntityId] = useState<string>("");
  const [loftTopScale, setLoftTopScale] = useState("0.7");
  const [loftMode, setLoftMode] = useState<"scaled" | "two-profile">("scaled");
  const [loftContinuity, setLoftContinuity] = useState<"position" | "tangent" | "curvature">("position");
  const [loftRailEntityId, setLoftRailEntityId] = useState<string>("");
  const [loftTangencyWeight, setLoftTangencyWeight] = useState("1");
  const [sweepTwist, setSweepTwist] = useState("0");
  const [sweepFrameTransport, setSweepFrameTransport] = useState(false);
  const [helixRadius, setHelixRadius] = useState("20");
  const [helixPitch, setHelixPitch] = useState("5");
  const [helixTurns, setHelixTurns] = useState("4");
  const [helixHandedness, setHelixHandedness] = useState<"right" | "left">("right");
  const [threadPitch, setThreadPitch] = useState("2");
  const [threadTurns, setThreadTurns] = useState("8");
  const [threadDepth, setThreadDepth] = useState("10");
  const [threadHandedness, setThreadHandedness] = useState<"right" | "left">("right");
  const [ribThickness, setRibThickness] = useState("2");
  const [domeHeight, setDomeHeight] = useState("8");
  const [sheetThickness, setSheetThickness] = useState("2");
  const [sheetBendRadius, setSheetBendRadius] = useState("2");
  const [flangeLength, setFlangeLength] = useState("20");
  const [flangeAngle, setFlangeAngle] = useState("90");
  const [hemStyle, setHemStyle] = useState<"closed" | "open">("closed");
  const [modifierEdgeSize, setModifierEdgeSize] = useState("1");
  const [shellThickness, setShellThickness] = useState("2");
  const [shellOpenFace, setShellOpenFace] = useState<"top" | "bottom" | "none">("top");
  const [draftAngle, setDraftAngle] = useState("5");
  const [draftNeutralFace, setDraftNeutralFace] = useState<"top" | "bottom">("bottom");
  const [reach, setReach] = useState<ReachSettings>(DEFAULT_REACH);
  const [solidResult, setSolidResult] = useState<"new-body" | "join" | "cut">("new-body");
  const [solidTarget, setSolidTarget] = useState("");
  // A join or cut acts on the picked solid, else the selected one, else the newest.
  const effectiveTarget = props.solidBodies.some((body) => body.id === solidTarget) ? solidTarget
    : props.solidBodies.some((body) => body.id === props.selectedId) ? props.selectedId ?? ""
      : props.solidBodies.at(-1)?.id ?? "";
  const modifying = solidResult !== "new-body" && props.solidBodies.length > 0 && effectiveTarget !== "";
  // Through all applies to an extruded cut: the cutter is stretched across the solid when the timeline rebuilds.
  const cutThroughAll = modifying && solidResult === "cut" && solidOp === "extrude" && reach.extent === "through-all";
  // A "to" extent measures its own distance or angle from the target, so the typed value is not used.
  const reachesTarget = (solidOp === "extrude" || solidOp === "revolve") && isReachTarget(reach.extent) && !cutThroughAll;
  const [edgeKind, setEdgeKind] = useState<"none" | "chamfer" | "fillet">("none");
  const [edgeSize, setEdgeSize] = useState("2");
  const [showProfiles, setShowProfiles] = useState(true);
  const [showDimensions, setShowDimensions] = useState(true);
  const [showConstraints, setShowConstraints] = useState(true);
  const [showComb, setShowComb] = useState(false);
  const [combScale, setCombScale] = useState(1);
  const [selectedProfileIds, setSelectedProfileIds] = useState<readonly string[]>([]);
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
    const palette = paletteRef.current;
    if (palette === null) return undefined;
    palette.scrollIntoView({ behavior: "smooth", block: "nearest" });
    palette.classList.add("palette-reveal");
    const timer = window.setTimeout(() => palette.classList.remove("palette-reveal"), 1200);
    return () => window.clearTimeout(timer);
  }, [props.optionsRevealRequest]);

  const plane = planeKeyOf(props.sketch.plane);
  const planeInfo = PLANE_INFO[plane];
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
    if (visibleEntities.length === 0) return undefined;
    const bounds = sketchBounds(visibleEntities);
    return { min: bounds.min, max: bounds.max };
  }, [visibleEntities]);
  const camera = useSketchCamera(fitExtents, `${props.projectId}:${props.sketch.plane}`, props.fitSerial);
  const px = camera.mmPerPx;
  const grid = gridSteps(props.sketch.gridMm, px);
  const selectedEntity = workingSketch.entities.find((entity) => entity.id === selectionIds.at(-1));
  const selectedEntities = selectionIds.map((id) => workingSketch.entities.find((entity) => entity.id === id)).filter((entity): entity is SketchEntity => entity !== undefined);
  const selectedConstraints = props.sketch.constraints.filter((constraint) => constraint.entityIds.some((id) => selectionIds.includes(id)));
  const dimensionHandleEntities = useMemo(() => [
    ...visibleEntities.filter((entity) => !selectionIds.includes(entity.id)),
    ...visibleEntities.filter((entity) => selectionIds.includes(entity.id))
  ], [selectionIds, visibleEntities]);
  const directDimension = useMemo(() => resolveDirectSketchDimension(dimensionPoints), [dimensionPoints]);
  // Driving dimensions are drawn as real dimensions (extension lines, arrows, editable text); curves without one keep a quiet reference value.
  const drivingDimensions = useMemo(() => visibleSketch.constraints.flatMap((constraint) => {
    if ((constraint.kind !== "distance" && constraint.kind !== "radius") || constraint.valueMm === undefined || constraint.entityIds.length !== 1) return [];
    const dimension: DrivingDimension | undefined = constraint.dimension ?? (constraint.kind === "radius" ? "radius" : undefined);
    const entity = visibleEntities.find((candidate) => candidate.id === constraint.entityIds[0]);
    if (dimension === undefined || entity === undefined) return [];
    return [{ constraint, entity, dimension }];
  }), [visibleSketch.constraints, visibleEntities]);
  const dimensionedIds = useMemo(() => new Set(drivingDimensions.map((view) => view.entity.id)), [drivingDimensions]);
  const dimensionModeWasActive = useRef(false);
  const previewEntity = useMemo(() => {
    if (props.tool === "profile") {
      const chain = profileChain.current;
      if (chain === undefined || pending.length === 0) return undefined;
      const step = extendProfileChain(chain, cursor, curveFields.profileMode, PICK_PIXELS * px, { entity: () => "entity:tool-preview", constraint: () => "constraint:tool-preview" });
      return step.ok ? step.value.entity : { id: "entity:tool-preview", kind: "line" as const, start: chain.tail, end: cursor, construction: false } satisfies SketchEntity;
    }
    if (props.tool === "spline-control") return undefined;
    if (props.tool === "spline") {
      return pending.length >= 1 ? { id: "entity:tool-preview", kind: "spline" as const, fitPoints: [...pending, cursor], construction: false } satisfies SketchEntity : undefined;
    }
    if (props.tool === "select") return undefined;
    const required = requiredSketchPoints(props.tool);
    if (isShapeTool(props.tool)) {
      return pending.length >= 1 && pending.length < required - 1
        ? { id: "entity:tool-preview", kind: "line" as const, start: pending[pending.length - 1]!, end: cursor, construction: false } satisfies SketchEntity
        : undefined;
    }
    if (pending.length === required - 1) {
      const preview = buildSketchEntity(props.tool, [...pending, cursor], "entity:tool-preview");
      return preview.ok ? preview.value : undefined;
    }
    // Before the last point of a three-point tool, show the first edge as a rubber band so the next click is predictable.
    if (pending.length >= 1 && pending.length < required - 1) {
      return { id: "entity:tool-preview", kind: "line" as const, start: pending[pending.length - 1]!, end: cursor, construction: false } satisfies SketchEntity;
    }
    return undefined;
  }, [cursor, pending, props.tool, curveFields.profileMode]);
  const navigationPan = props.tool === "select" && props.viewportState.navigationMode === "pan";
  /** A whole polygon or slot is built from the points placed so far plus the cursor, so it can be previewed and then placed. */
  const buildShape = (tool: Exclude<SketchTool, "select">, points: readonly Vec2[]): ReturnType<typeof buildPolygon> => {
    const ids = { entity: (): string => `entity:user-${crypto.randomUUID()}`, constraint: (): string => `constraint:user-${crypto.randomUUID()}` };
    if (isFixedCurveTool(tool)) {
      const options = curveOptionsFromFields(curveFields, { entities: props.sketch.entities, centerlineReachMm: Math.max(1000, camera.camera.widthMm * 3 + Math.hypot(camera.camera.centerMm[0], camera.camera.centerMm[1])), pickReachMm: Math.max(props.sketch.snapToleranceMm, PICK_PIXELS * px), block: blockLibrary.get(curveFields.blockChoice) });
      return buildCurveTool(tool, points, options, ids);
    }
    if (tool === "polygon") return buildPolygon(points[0]!, points[1]!, Math.round(Number(polygonSides)), ids);
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
  }, [props.tool, pending, cursor, polygonSides, curveFields, props.sketch.entities]);
  const dynamicMirrorEntity = useMemo(() => {
    const axis = props.sketch.entities.find((entity) => entity.id === dynamicMirrorAxis);
    return axis?.kind === "line" ? axis : undefined;
  }, [props.sketch.entities, dynamicMirrorAxis]);
  useEffect(() => {
    if (dynamicMirrorAxis !== null && dynamicMirrorEntity === undefined) { setDynamicMirrorAxis(null); props.onMessage("Dynamic mirror stopped: its mirror line is gone."); }
  }, [dynamicMirrorAxis, dynamicMirrorEntity]);
  const mirrorGhosts = useMemo(
    () => (dynamicMirrorEntity === undefined ? [] : mirrorImages(dynamicMirrorEntity, [...(previewEntity === undefined ? [] : [previewEntity]), ...(previewShape?.entities ?? [])])),
    [dynamicMirrorEntity, previewEntity, previewShape]
  );
  /** Applies a drawing edit; with Dynamic Mirror on, the mirror images of what was drawn go in the same edit. */
  const applyDrawn = (plan: SketchEditPlan): boolean | void => {
    if (dynamicMirrorAxis === null) return props.onApplyEdit(plan);
    const outcome = withDynamicMirror({ sketch: props.sketch, newId: (prefix) => `${prefix}:user-${crypto.randomUUID()}` }, dynamicMirrorAxis, plan);
    if (outcome.mirrored > 0) props.onMessage(`Mirrored ${outcome.mirrored} curve${outcome.mirrored === 1 ? "" : "s"} about ${dynamicMirrorAxis.replace(/^entity:/u, "")}${outcome.withoutRelations ? " (as exact copies; the solver would not take the symmetry relations)" : ""}.`);
    return props.onApplyEdit(outcome.plan);
  };
  const addDrawn = (entity: SketchEntity): void => {
    if (dynamicMirrorAxis === null) { props.onAddEntity(entity); return; }
    applyDrawn({ label: `Added ${entity.kind}`, removeEntityIds: [], updateEntities: [], addEntities: [entity], addConstraints: [] });
  };
  const editContext = () => ({ sketch: props.sketch, newId: (prefix: "entity" | "constraint"): string => `${prefix}:user-${crypto.randomUUID()}` });
  /** Puts the clipboard on the system clipboard as text too, so it can be pasted into another window; failure is harmless. */
  const shareClipboardText = (clipboard: SketchClipboard): void => {
    void Promise.resolve(globalThis.navigator?.clipboard?.writeText(serializeClipboard(clipboard))).catch(() => undefined);
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
      if (!parsed.ok) { props.onMessage("The sketch clipboard is empty. Select curves and press Ctrl+C first."); return; }
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
    if (pending.length === 0) { chainStart.current = undefined; chainSegments.current = 0; profileChain.current = undefined; setPendingInference([]); }
  }, [pending.length]);
  // Starting a drawing tool, Sketch Dimension or an edit tool ends relation picking; switching to Select (which picking itself does) does not.
  useEffect(() => {
    if (props.tool !== "select" || props.dimensionMode || props.editTool !== null) { setPickRelation(null); setPickedPoint(undefined); }
  }, [props.tool, props.dimensionMode, props.editTool]);
  useEffect(() => { setFieldText({}); }, [props.tool, props.cancelVersion, pending.length]);
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
    if (!props.dimensionMode) setDimensionPoints([]);
    dimensionModeWasActive.current = props.dimensionMode;
  }, [props.dimensionMode]);
  useEffect(() => {
    if (props.selectedId === null || props.selectedId.startsWith("profile:")) setSelectionIds([]);
    else setSelectionIds((current) => current.includes(props.selectedId!) ? current : [props.selectedId!]);
    if (props.selectedId?.startsWith("profile:") === true && profiles.some((profile) => profile.id === props.selectedId)) setSelectedProfileIds([props.selectedId]);
  }, [profiles, props.selectedId]);
  useEffect(() => setSelectedProfileIds((current) => current.filter((id) => profiles.some((profile) => profile.id === id))), [profiles]);
  useEffect(() => {
    const currentHandles = visibleEntities.flatMap(dimensionHandles);
    setDimensionPoints((current) => current.flatMap((point) => currentHandles.find((candidate) => candidate.id === point.id) ?? []));
  }, [visibleEntities]);
  // Entities that were deleted or hidden can no longer be selected or hovered.
  useEffect(() => {
    setSelectionIds((current) => current.filter((id) => visibleEntities.some((entity) => entity.id === id)));
    setHoverId((current) => current !== null && visibleEntities.some((entity) => entity.id === current) ? current : null);
  }, [visibleEntities]);

  const pointer = (event: React.PointerEvent<SVGSVGElement>, commit: boolean): void => {
    const point = camera.toSketch(event.clientX, event.clientY);
    // Placing tools infer from the sketch (endpoints, centres, midpoints, intersections, alignment...). A line or spline also
    // infers from the last point it placed, which enables perpendicular, tangent and level/plumb hints.
    const placing = props.tool !== "select";
    const anchor = (props.tool === "line" || props.tool === "spline" || props.tool === "spline-control" || props.tool === "profile") ? pending.at(-1) : undefined;
    const result: InferenceResult = snapEnabled && placing
      ? inferSketchPoint(point, props.sketch, { toleranceMm: SNAP_PIXELS * px, gridMm: grid.minorMm, ...(anchor === undefined ? {} : { anchor }) })
      : { point, snapped: false, guides: [] };
    const snapped = { point: result.point, snapped: result.snapped, label: result.primary === undefined ? "" : INFERENCE_LABELS[result.primary.kind].toLowerCase() };
    setCursor(snapped.point);
    setInference(placing ? result : undefined);
    if (!commit) return;
    if (isClickEditTool(props.editTool) && props.tool === "select") {
      const target = nearestEntityId(props.sketch, point, PICK_PIXELS * px);
      if (target === undefined) { props.onMessage(`${SKETCH_EDIT_TOOL_LABELS[props.editTool]}: click directly on a curve.`); return; }
      const context = { sketch: props.sketch, newId: (prefix: "entity" | "constraint"): string => `${prefix}:user-${crypto.randomUUID()}` };
      const result = props.editTool === "trim" ? trimAt(context, target, point)
        : props.editTool === "extend" ? extendAt(context, target, point)
        : props.editTool === "split" ? splitAt(context, target, point, { snapMm: PICK_PIXELS * px })
        : props.editTool === "delete-curve" ? deleteCurveHeal(context, target)
        : jogLine(context, target, point, { offsetMm: Number(jogParams.offset), widthMm: Number(jogParams.width) });
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
      if (pending.length >= 3 && gap <= PICK_PIXELS * px) { finishSpline(pending); return; }
      if (gap < 0.01) return;
      if (pending.length >= 24) { props.onMessage("A spline takes at most 24 fit points. Click the last point again or press Enter to finish."); return; }
      const next = [...pending, snapped.point];
      setPending(next);
      props.onMessage(`Fit-point spline: point ${next.length} accepted.${next.length >= 3 ? " Click the last point again or press Enter to finish." : ""}`);
      return;
    }
    if (props.tool === "select") {
      // Shift-click on empty canvas keeps the selection; a plain click clears it.
      if (event.shiftKey || event.ctrlKey || event.metaKey) return;
      setSelectionIds([]);
      setSelectedProfileIds([]);
      if (props.dimensionMode) setDimensionPoints([]);
      props.onSelect(null);
      return;
    }
    placePoint(snapped.point, snapped.snapped ? snapped.label : "", result);
  };

  /** Places one point of the active tool: a click, or Enter on typed values. A finished shape is added to the sketch. */
  const placePoint = (point: Vec2, label: string, found?: InferenceResult): void => {
    if (props.tool === "select" || props.tool === "spline" || props.tool === "spline-control") return;
    setFieldText({});
    if (props.tool === "profile") { placeProfilePoint(point); return; }
    const points = [...pending, point];
    const previous = pending.at(-1);
    const placed: readonly PlacedPointInference[] = [
      ...pending.map((earlier, index): PlacedPointInference => pendingInference[index] ?? { point: earlier }),
      { point, ...(found?.primary === undefined ? {} : { primary: found.primary }), ...(found === undefined ? {} : { guides: found.guides }), ...(previous === undefined ? {} : { anchor: previous }) }
    ];
    if (points.length === 1 && props.tool === "line") { chainStart.current = point; chainSegments.current = 0; }
    if (points.length < requiredSketchPoints(props.tool)) {
      setPending(points);
      setPendingInference(placed);
      const nextPrompt = isFixedCurveTool(props.tool) ? CURVE_TOOL_PROMPTS[props.tool][points.length] : undefined;
      props.onMessage(`${sketchToolLabel(props.tool)}: point ${points.length} accepted${label === "" ? "" : ` (${label})`}.${nextPrompt === undefined ? "" : ` Next: ${nextPrompt}.`}`);
      return;
    }
    if (isShapeTool(props.tool)) {
      const shape = buildShape(props.tool, points);
      if (!shape.ok) {
        props.onMessage(`${shape.diagnostics[0]?.message ?? "The shape was rejected."} Place the last point somewhere else, or press Esc to start over.`);
        return;
      }
      const accepted = applyDrawn({ label: `Added ${sketchToolLabel(props.tool).toLowerCase()} (${shape.value.entities.length} curves, ${shape.value.constraints.length} relations)`, removeEntityIds: [], updateEntities: [], addEntities: shape.value.entities, addConstraints: shape.value.constraints });
      if (accepted === false) return;
      setPending([]);
      props.onMessage(`Added ${sketchToolLabel(props.tool).toLowerCase()} with ${shape.value.entities.length} curve${shape.value.entities.length === 1 ? "" : "s"} and ${shape.value.constraints.length} relation${shape.value.constraints.length === 1 ? "" : "s"}.`);
      return;
    }
    const built = buildSketchEntity(props.tool, points, `entity:user-${crypto.randomUUID()}`);
    if (!built.ok) {
      // Keep the points already placed so one bad click does not throw the whole gesture away.
      props.onMessage(`${built.diagnostics[0]?.message ?? "Sketch entity rejected."} Place the last point somewhere else, or press Esc to start over.`);
      return;
    }
    // A shape whose points snapped to other geometry is added together with the relations that implies, in one undoable edit.
    const relations = autoConstrain ? autoConstraintsFor({ tool: props.tool, entity: built.value, placed, sketch: props.sketch, newId: () => `constraint:auto-${crypto.randomUUID()}` }) : [];
    let accepted: boolean | void = undefined;
    if (relations.length > 0) {
      accepted = applyDrawn({ label: `Added ${sketchToolLabel(props.tool)} with ${relations.length} relation${relations.length === 1 ? "" : "s"}`, removeEntityIds: [], updateEntities: [], addEntities: [built.value], addConstraints: relations });
    }
    // If the solver refused the relations, the shape itself is still drawn.
    if (relations.length === 0 || accepted === false) addDrawn(built.value);
    const relationNote = relations.length > 0 && accepted !== false ? ` with ${relations.length} automatic relation${relations.length === 1 ? "" : "s"} (${[...new Set(relations.map((relation) => relation.kind))].join(", ")})` : "";
    if (props.tool === "line") {
      // A line carries on from where it ended, like a polyline, until Esc. Ending on the first point closes the loop.
      const segments = chainSegments.current + 1;
      const start = chainStart.current;
      if (segments >= 3 && start !== undefined && Math.hypot(point[0] - start[0], point[1] - start[1]) < 1e-6) {
        setPending([]);
        props.onMessage(`Closed the loop after ${segments} lines. The shape is now a closed profile.`);
        return;
      }
      chainSegments.current = segments;
      setPending([point]);
      // The next segment starts where this one ended, so it is joined to it automatically.
      setPendingInference([{ point, primary: { kind: "endpoint", point, entityId: built.value.id, selector: "end", distanceMm: 0 } }]);
      props.onMessage(`Added line ${segments}${relationNote}. Keep clicking to continue the chain, click the first point to close it, or press Esc to stop.`);
      return;
    }
    setPending([]);
    props.onMessage(`Added ${sketchToolLabel(props.tool)}${relationNote} with stable ID ${built.value.id}.`);
  };

  const dynamicFields = useMemo(() => dynamicFieldsFor(props.tool, pending.length), [props.tool, pending.length]);
  const liveValues = useMemo(() => measureFromCursor(props.tool, pending, cursor), [props.tool, pending, cursor]);
  const setField = (id: DynamicFieldId, value: string): void => setFieldText((current) => {
    const { [id]: _previous, ...rest } = current;
    return value === "" ? rest : { ...rest, [id]: value };
  });
  const requestFieldFocus = (id: DynamicFieldId): void => { focusSerial.current += 1; setFocusRequest({ id, serial: focusSerial.current }); };
  const commitDynamicInput = (): void => {
    const typed: DynamicValues = {};
    for (const field of dynamicFields) {
      const text = fieldText[field.id];
      const parsed = text === undefined ? undefined : parseDynamicNumber(text);
      if (parsed !== undefined) typed[field.id] = parsed;
    }
    const target = pointFromDynamicInput(props.tool, pending, cursor, typed);
    if (target === undefined) { props.onMessage("Type a size greater than zero, or click to place the point."); return; }
    setDynamicFocused(false);
    placePoint(target, "typed");
  };

  const finishSpline = (points: readonly Vec2[]): void => {
    const built = buildSketchEntity("spline", points, `entity:user-${crypto.randomUUID()}`);
    if (!built.ok) { props.onMessage(built.diagnostics[0]?.message ?? "The spline was rejected."); setPending([]); return; }
    addDrawn(built.value);
    setPending([]);
    props.onMessage(`Added fit-point spline with ${points.length} points and stable ID ${built.value.id}.`);
  };

  const finishControlSpline = (controls: readonly Vec2[], closed: boolean): void => {
    const ids = { entity: (): string => `entity:user-${crypto.randomUUID()}`, constraint: (): string => `constraint:user-${crypto.randomUUID()}` };
    const built = buildControlPointSpline(controls, closed, curveFields.keepPolygon, ids);
    if (!built.ok) { props.onMessage(built.diagnostics[0]?.message ?? "The spline was rejected."); setPending([]); return; }
    const accepted = props.onApplyEdit({ label: `Added control-point spline (${controls.length} control points${closed ? ", closed" : ""})`, removeEntityIds: [], updateEntities: [], addEntities: built.value.entities, addConstraints: built.value.constraints });
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
  const placeProfilePoint = (point: Vec2): void => {
    const chain = profileChain.current;
    if (chain === undefined) {
      profileChain.current = startProfileChain(point);
      setPending([point]);
      props.onMessage("Profile: start placed. Click the next point; pick Tangent arc in the Sketch palette to curve into it, click the start again to close, Esc to stop.");
      return;
    }
    const ids = { entity: (): string => `entity:user-${crypto.randomUUID()}`, constraint: (): string => `constraint:user-${crypto.randomUUID()}` };
    const step = extendProfileChain(chain, point, curveFields.profileMode, PICK_PIXELS * px, ids);
    if (!step.ok) { props.onMessage(`${step.diagnostics[0]?.message ?? "The segment was rejected."} Place the point somewhere else, or press Esc to stop.`); return; }
    const { entity, constraints, chain: next, closed } = step.value;
    let accepted: boolean | void = undefined;
    if (constraints.length > 0) accepted = props.onApplyEdit({ label: `Added profile ${entity.kind} ${next.segments}`, removeEntityIds: [], updateEntities: [], addEntities: [entity], addConstraints: constraints });
    // If the solver refused the relations, the segment itself is still drawn.
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

  /** Opens the value editor next to a curve's dimension: the length of a line, the diameter of a circle, the width or height of a rectangle. */
  const openDimensionEditor = (entity: SketchEntity, requested: DrivingDimension): void => {
    // An arc is dimensioned by its length and an ellipse by its perimeter.
    const dimension: DrivingDimension = entity.kind === "arc" ? "arc-length" : entity.kind === "ellipse" ? "perimeter" : requested;
    const current = entity.kind === "line" ? Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1])
      : entity.kind === "circle" ? entity.radiusMm * 2
        : entity.kind === "rectangle" ? (dimension === "height" ? entity.heightMm : entity.widthMm)
          : entity.kind === "arc" || entity.kind === "ellipse" ? entityLengthMm(entity) : undefined;
    if (current === undefined) { props.onMessage("Only lines, circles, rectangles, arcs and ellipses take a driving dimension here; splines are reference only (see Angle, arc length, perimeter)."); return; }
    const existing = props.sketch.constraints.find((constraint) => constraint.entityIds.length === 1 && constraint.entityIds[0] === entity.id && constraint.valueMm !== undefined && constraint.driven !== true
      && (dimension === "arc-length" ? constraint.kind === "arc-length" : dimension === "perimeter" ? constraint.kind === "perimeter" : constraint.dimension === dimension));
    const shown = existing?.valueMm === undefined ? current : (entity.kind === "circle" ? existing.valueMm * 2 : existing.valueMm);
    const layout = dimensionLayout(entity, dimension, entity.kind === "circle" ? shown / 2 : shown, px);
    const next = {
      entityId: entity.id,
      dimension,
      anchor: layout?.textAt ?? entityAnchor(entity),
      label: dimension === "arc-length" ? "Arc length" : dimension === "perimeter" ? "Perimeter" : entity.kind === "circle" ? "Diameter" : dimension === "width" ? "Width" : dimension === "height" ? "Height" : "Length"
    };
    // Opened after the press has finished: the browser moves focus off the editor on mouse-down, which would close it again at once.
    window.setTimeout(() => {
      setDimensionEdit(next);
      // A dimension bound to an expression shows the expression, so it can be edited as text; a circle shows its diameter.
      const bound = existing?.expression === undefined ? undefined : entity.kind === "circle" ? unhalvedExpression(existing.expression) : existing.expression;
      setDimensionText(bound ?? String(Number(shown.toFixed(3))));
    }, 0);
  };

  /** Opens the value editor for an existing angle, arc-length or perimeter dimension, from a click on its text. */
  const openExtraDimensionEditor = (constraint: WorkbenchSketchConstraint, anchor: Vec2): void => {
    const name: DrivingDimension = constraint.kind === "angle" ? "angle" : constraint.kind === "arc-length" ? "arc-length" : "perimeter";
    const value = constraint.kind === "angle" ? constraint.valueDeg : constraint.valueMm;
    if (value === undefined) return;
    const next = { entityId: constraint.entityIds[0]!, dimension: name, anchor, label: name === "angle" ? "Angle (degrees)" : name === "arc-length" ? "Arc length" : "Perimeter", ...(constraint.entityIds[1] === undefined ? {} : { secondEntityId: constraint.entityIds[1] }) };
    window.setTimeout(() => { setDimensionEdit(next); setDimensionText(String(Number(value.toFixed(3)))); }, 0);
  };

  const commitDimensionEdit = (): void => {
    const edit = dimensionEdit;
    if (edit === undefined) return;
    const typed = parseDynamicNumber(dimensionText);
    const entity = props.sketch.entities.find((candidate) => candidate.id === edit.entityId);
    // Text that is not a number is an expression (plate_w / 2): the dimension is bound to it. The project checks it and says what is wrong.
    if (typed === undefined && dimensionText.trim() !== "" && dimensionText.trim() !== "-") {
      const text = dimensionText.trim();
      // Only a plain length, width, height or radius can follow an expression; an angle, an arc length and a perimeter take numbers.
      if (!["length", "width", "height", "radius"].includes(edit.dimension)) { props.onMessage(edit.dimension === "angle" ? "Type an angle from 0 up to 360 degrees." : "Type a size greater than zero."); return; }
      props.onSetDimension(edit.entityId, edit.dimension, 1, { expression: entity?.kind === "circle" ? halvedExpression(text) : text });
      setDimensionEdit(undefined);
      return;
    }
    if (typed === undefined || (edit.dimension === "angle" ? typed < 0 || typed >= 360 : typed <= 0)) { props.onMessage(edit.dimension === "angle" ? "Type an angle from 0 up to 360 degrees." : "Type a size greater than zero."); return; }
    // A circle is dimensioned by its diameter on the canvas; the model stores the radius.
    props.onSetDimension(edit.entityId, edit.dimension, entity?.kind === "circle" && edit.dimension === "radius" ? typed / 2 : typed, edit.secondEntityId === undefined ? undefined : { secondEntityId: edit.secondEntityId });
    setDimensionEdit(undefined);
  };

  /** Second step of Midpoint: the line the first point should sit at the middle of. */
  const completeMidpoint = (lineId: string): void => {
    const first = pickedPoint;
    if (first === undefined) return;
    const line = props.sketch.entities.find((entity) => entity.id === lineId);
    if (line === undefined || line.kind !== "line") { props.onMessage("Midpoint needs a line: click the line the point should sit in the middle of."); return; }
    if (line.id === first.entityId) { props.onMessage("A line's own point cannot be the middle of that same line. Click another line."); return; }
    props.onAddConstraint({ id: `constraint:user-${crypto.randomUUID()}`, kind: "midpoint", entityIds: [first.entityId, line.id], points: [first.ref] });
    setPickedPoint(undefined);
    setPickRelation(null);
  };

  /** A click on one of the relation handles: the first pick is remembered, the second completes a Coincident. */
  const pickRelationPoint = (picked: RelationPoint): void => {
    if (pickRelation === null) return;
    const first = pickedPoint;
    if (first === undefined || first.id === picked.id) {
      setPickedPoint(first?.id === picked.id ? undefined : picked);
      props.onMessage(first?.id === picked.id
        ? "Point cleared. Pick a point to start the relation."
        : pickRelation === "coincident" ? `${picked.label} picked. Now pick the point that should move onto it.` : `${picked.label} picked. Now click the line it should sit in the middle of.`);
      return;
    }
    if (pickRelation === "midpoint") {
      setPickedPoint(picked);
      props.onMessage(`${picked.label} picked instead. Now click the line it should sit in the middle of.`);
      return;
    }
    if (picked.entityId === first.entityId) { props.onMessage("Two points of one shape cannot be made coincident: that would collapse it."); return; }
    props.onAddConstraint({ id: `constraint:user-${crypto.randomUUID()}`, kind: "coincident", entityIds: [first.entityId, picked.entityId], points: [first.ref, picked.ref] });
    setPickedPoint(undefined);
    setPickRelation(null);
  };

  const startPickRelation = (relation: "coincident" | "midpoint"): void => {
    if (props.tool !== "select") props.onActivateTool("select");
    setPickRelation(relation);
    setPickedPoint(undefined);
    props.onMessage(relation === "coincident"
      ? "Coincident: pick a point (blue squares), then the point that should move onto it. Esc cancels."
      : "Midpoint: pick a point, then click the line it should sit in the middle of. Esc cancels.");
  };

  const selectEntity = (id: string, additive: boolean): void => {
    if (pickRelation === "midpoint" && pickedPoint !== undefined) { completeMidpoint(id); return; }
    if (pickRelation !== null) return;
    if (props.viewportState.selectionFilter === "profile") {
      const profile = profiles.find((candidate) => candidate.entityIds.includes(id));
      if (profile !== undefined) selectProfile(profile, additive);
      else props.onMessage("This curve does not bound a detected closed profile.");
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
        setDimensionPoints(entity === undefined || entity.visible === false ? [] : defaultDimensionPoints(entity));
        if (entity?.kind === "rectangle") {
          // Width or height, whichever edge the click was nearer to, measured in the rectangle's own frame.
          const radians = (entity.rotationDeg * Math.PI) / 180;
          const dx = cursor[0] - entity.center[0];
          const dy = cursor[1] - entity.center[1];
          const localX = dx * Math.cos(radians) + dy * Math.sin(radians);
          const localY = -dx * Math.sin(radians) + dy * Math.cos(radians);
          openDimensionEditor(entity, Math.abs(Math.abs(localY) - entity.heightMm / 2) <= Math.abs(Math.abs(localX) - entity.widthMm / 2) ? "width" : "height");
        } else if (entity !== undefined) {
          openDimensionEditor(entity, entity.kind === "circle" ? "radius" : "length");
        }
        props.onMessage("Type the value and press Enter. Esc closes the editor; pick two blue points instead for a reference distance.");
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
        const next = { entityId: firstLine.id, secondEntityId: secondLine.id, dimension: "angle" as const, anchor: layout?.textAt ?? entityAnchor(firstLine), label: "Angle (degrees)" };
        window.setTimeout(() => { setDimensionEdit(next); setDimensionText(String(Number(shown.toFixed(3)))); }, 0);
        props.onMessage("Type the angle in degrees from the first line to the second and press Enter.");
        return;
      }
    }
    props.onMessage("Multi-selection updated. Pair relations use the last two entities picked; Symmetric uses the last three, axis last.");
  };

  const selectDimensionPoint = (point: SketchDimensionPoint): void => {
    setSelectionIds([point.entityId]);
    setSelectedProfileIds([]);
    props.onSelect(point.entityId);
    const next = dimensionPoints.some((candidate) => candidate.id === point.id)
      ? dimensionPoints.filter((candidate) => candidate.id !== point.id)
      : dimensionPoints.length < 2 ? [...dimensionPoints, point] : [point];
    setDimensionPoints(next);
    props.onMessage(next.length === 0
      ? "Definition point cleared. Pick a point to start a dimension."
      : next.length === 1
        ? `${next[0]!.label} selected. Pick a second definition point.`
        : "Point-to-point dimension selected; edit it when it maps to a supported driving parameter.");
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
  const horizontalFit = fitOne("horizontal");
  const verticalFit = fitOne("vertical");
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
    if (selectionIds.length === 0) { props.onMessage("Select one or more curves first."); return; }
    if (request.command === "fix-curve") {
      const already = new Set(props.sketch.constraints.filter((constraint) => constraint.kind === "fixed" && constraint.suppressed !== true).flatMap((constraint) => constraint.entityIds));
      const targets = selectedEntities.filter((entity) => !already.has(entity.id));
      if (targets.length === 0) { props.onMessage("The selected curves are already fixed."); return; }
      props.onApplyEdit({
        label: `Fixed ${targets.length} curve${targets.length === 1 ? "" : "s"}`,
        removeEntityIds: [], updateEntities: [], addEntities: [],
        addConstraints: targets.map((entity) => ({ id: `constraint:user-${crypto.randomUUID()}`, kind: "fixed" as const, entityIds: [entity.id] }))
      });
      return;
    }
    const family = request.command === "relax-relations" ? "relations" : "dimensions";
    const active = constraintsOnEntities(props.sketch, selectionIds, family, false);
    const relaxed = constraintsOnEntities(props.sketch, selectionIds, family, true);
    if (active.length > 0) props.onSetSuppressed(active, true);
    else if (relaxed.length > 0) props.onSetSuppressed(relaxed, false);
    else props.onMessage(`The selection has no ${family === "relations" ? "geometric relations" : "driving dimensions"} to relax or restore.`);
  }, [props.request]);

  const handleHotkey = (action: SketchHotkeyAction): void => {
    switch (action.kind) {
      case "tool": props.onActivateTool(action.tool); return;
      case "dimension": props.onActivateDimension(); return;
      case "edit-tool": props.onActivateEditTool(action.tool); return;
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
      case "exit-pick": setPickRelation(null); setPickedPoint(undefined); props.onMessage("Relation picking cancelled."); return;
      case "exit-dimension": props.onExitDimension(); return;
      case "exit-edit-tool": props.onCloseEditTool(); return;
      case "clear-selection":
        setSelectionIds([]);
        setSelectedProfileIds([]);
        props.onSelect(null);
        return;
      case "delete-selection":
        if (selectionIds.length === 0) return;
        props.onApplyEdit({ label: `Deleted ${selectionIds.length} curve${selectionIds.length === 1 ? "" : "s"}`, removeEntityIds: selectionIds, updateEntities: [], addEntities: [], addConstraints: [] });
        setSelectionIds([]);
        props.onSelect(null);
        return;
      case "toggle-construction":
        if (selectedEntities.length === 0) { props.onMessage("Select curves first, then press X to turn them into construction geometry (or back)."); return; }
        props.onApplyEdit({
          label: `Toggled construction on ${selectedEntities.length} curve${selectedEntities.length === 1 ? "" : "s"}`,
          removeEntityIds: [],
          updateEntities: selectedEntities.map((entity) => ({ ...entity, construction: !entity.construction })),
          addEntities: [],
          addConstraints: []
        });
        return;
      case "finish":
        if (props.tool === "spline-control") { if (pending.length >= 3) finishControlSpline(pending, false); return; }
        if (props.tool === "profile") { profileChain.current = undefined; setPending([]); props.onMessage("Profile finished."); return; }
        if (pending.length >= 3) finishSpline(pending);
        return;
      case "type-value": {
        const first = dynamicFields[0];
        if (first === undefined) return;
        setField(first.id, action.key === "," ? "." : action.key);
        requestFieldFocus(first.id);
        return;
      }
      case "focus-dynamic": {
        const first = dynamicFields[0];
        if (first !== undefined) requestFieldFocus(first.id);
        return;
      }
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
    context: { tool: props.tool, pendingPoints: pending.length, selectionCount: selectionIds.length + selectedProfileIds.length, curveSelectionCount: selectionIds.length, dimensionMode: props.dimensionMode, editToolActive: props.editTool !== null, pickingRelation: pickRelation !== null, dragging: dragLive !== undefined || (dragGesture.current?.moved ?? false), dynamicFieldCount: dynamicFields.length },
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
    const snapping = snapEnabled && gesture.handle.kind !== "body";
    const snap: InferenceResult | undefined = snapping
      ? inferSketchPoint(raw, gesture.base, { toleranceMm: SNAP_PIXELS * px, gridMm: grid.minorMm, excludeEntityIds: [gesture.entityId, ...jointNeighbours(gesture.entityId)] })
      : undefined;
    const target = snap?.point ?? raw;
    setCursor(target);
    setInference(snap);
    const result = dragSketchHandle(gesture.base, gesture.entityId, gesture.handle, gesture.startMm, target);
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

  const handleCanvasPointerDownCapture = (event: React.PointerEvent<SVGSVGElement>): void => {
    // Panning wins over everything underneath the pointer, including curves, so a middle or Space drag never selects.
    const wantsPan = event.button === 1 || (event.button === 0 && (camera.spaceHeld || navigationPan));
    if (!wantsPan) return;
    event.stopPropagation();
    camera.beginPan(event);
  };

  const handleCanvasPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0) return;
    if (pickRelation !== null) return;
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
    pointer(event, true);
  };

  const handleCanvasPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (camera.movePan(event)) return;
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
    pointer(event, false);
  };

  const finishCanvasDrag = (event: React.PointerEvent<SVGSVGElement>): void => {
    if (camera.endPan(event)) return;
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
    const profile = gesture.profileId === undefined ? undefined : profiles.find((candidate) => candidate.id === gesture.profileId);
    if (profile !== undefined) selectProfile(profile, gesture.additive);
    else pointer(event, true);
  };

  const interactive = props.tool === "select" && props.viewportState.navigationMode !== "pan" && !camera.spaceHeld && !isClickEditTool(props.editTool);
  const box = camera.viewBox;
  const canvasClasses = [
    "sketch-canvas",
    showProfiles ? "show-profiles" : "hide-profiles",
    camera.panning ? "panning" : camera.spaceHeld || navigationPan ? "pan-ready" : "",
    dragLive !== undefined ? "dragging" : ""
  ].filter(Boolean).join(" ");
  const constraintSlots = new Map<string, number>();
  const curvatureCombs = showComb ? sketchCurvatureCombs(visibleEntities, 60 * px * combScale) : [];

  return <>
    <section className="workspace-canvas sketch-stage" aria-label={`Interactive ${planeInfo.name} sketch`}>
      <svg
        ref={camera.svgRef}
        className={canvasClasses}
        data-sketch-canvas={plane}
        viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`${planeInfo.name} sketch with ${props.sketch.entities.length} entities and ${analysis.degreesOfFreedom} estimated degrees of freedom`}
        onPointerDownCapture={handleCanvasPointerDownCapture}
        onPointerMove={handleCanvasPointerMove}
        onPointerDown={handleCanvasPointerDown}
        onPointerUp={finishCanvasDrag}
        onPointerCancel={finishCanvasDrag}
        onPointerEnter={() => setPointerInside(true)}
        onPointerLeave={() => { setPointerInside(false); setHoverId(null); setInference(undefined); }}
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
        {showProfiles && profiles.map((profile) => <SketchProfileShape key={profile.id} profile={profile} selected={selectedProfileIds.includes(profile.id)} {...(interactive ? { onSelect: (additive: boolean) => selectProfile(profile, additive) } : {})} />)}
        {visibleEntities.map((entity) => <SketchEntityShape key={entity.id} entity={entity} px={px} selected={selectionIds.includes(entity.id)} hovered={hoverId === entity.id} movable={props.showMovable && movableIds.has(entity.id)} constrained={analysis.entityFreedom[entity.id] === 0} {...(interactive ? { onSelect: (additive: boolean) => selectEntity(entity.id, additive), onHover: (inside: boolean) => setHoverId(inside ? entity.id : null), onGrab: (event: React.PointerEvent, handle: DragHandle) => beginDrag(event, entity.id, handle), handles: grabHandlesOf(entity) } : {})} />)}
        {curvatureCombs.map(({ entityId, comb }) => <g key={`comb:${entityId}`} className="curvature-comb" data-comb-entity={entityId} pointerEvents="none" fill="none" stroke="#d9480f" strokeWidth={px}>
          {comb.teeth.map((tooth, index) => <line key={index} x1={tooth.base[0]} y1={-tooth.base[1]} x2={tooth.tip[0]} y2={-tooth.tip[1]} strokeOpacity={0.7} />)}
          <polyline points={comb.envelope.map((point) => `${point[0]},${-point[1]}`).join(" ")} strokeWidth={1.4 * px} />
        </g>)}
        {previewEntity !== undefined && <SketchEntityShape entity={previewEntity} px={px} selected={false} hovered={false} preview />}
        {previewShape?.entities.map((entity) => <SketchEntityShape key={entity.id} entity={entity} px={px} selected={false} hovered={false} preview />)}
        {mirrorGhosts.map((entity) => <SketchEntityShape key={entity.id} entity={entity} px={px} selected={false} hovered={false} preview />)}
        {showDimensions && drivingDimensions.map((view) => <DimensionMarks key={view.constraint.id} entity={view.entity} dimension={view.dimension} valueMm={view.constraint.valueMm ?? 0} relaxed={view.constraint.suppressed === true} px={px} {...(interactive ? { onEdit: () => openDimensionEditor(view.entity, view.dimension) } : {})} />)}
        {showDimensions && <ExtraDimensionMarks sketch={visibleSketch} px={px} {...(interactive ? { onEdit: openExtraDimensionEditor } : {})} />}
        {pending.map((point, index) => <circle key={index} cx={point[0]} cy={-point[1]} r={4 * px} className="pending-point" />)}
        {props.tool !== "select" && pointerInside && !camera.panning && inference !== undefined && <InferenceMarks inference={inference} px={px} />}
        {props.tool !== "select" && pointerInside && !camera.panning && <circle cx={cursor[0]} cy={-cursor[1]} r={3.5 * px} className="cursor-point" />}
        {showDimensions && visibleEntities.filter((entity) => !dimensionedIds.has(entity.id)).map((entity) => <SketchDimensionGlyph key={`dimension:${entity.id}`} entity={entity} px={px} />)}
        {showConstraints && visibleSketch.constraints.map((constraint) => {
          const primary = constraint.entityIds[0] ?? "";
          const slot = constraintSlots.get(primary) ?? 0;
          constraintSlots.set(primary, slot + 1);
          return <ConstraintGlyph key={constraint.id} constraint={constraint} entities={visibleEntities} px={px} slot={slot} />;
        })}
        {pickRelation !== null && visibleEntities.flatMap(relationPoints).map((handle) => <rect
          key={handle.id}
          className={`relation-point${pickedPoint?.id === handle.id ? " selected" : ""}`}
          data-relation-point={handle.id}
          x={handle.point[0] - 6 * px}
          y={-handle.point[1] - 6 * px}
          width={12 * px}
          height={12 * px}
          role="button"
          aria-label={`${handle.label} (relation point)`}
          onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); pickRelationPoint(handle); }}
        />)}
        {props.dimensionMode && <>
          {dimensionHandleEntities.flatMap(dimensionHandles).map((point) => <circle key={point.id} className={`dimension-point ${dimensionPoints.some((candidate) => candidate.id === point.id) ? "selected" : ""}`} data-dimension-point={point.id} cx={point.point[0]} cy={-point.point[1]} r={6 * px} role="button" aria-label={`${point.label} dimension point`} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); selectDimensionPoint(point); }} />)}
          {directDimension !== undefined && <DirectDimensionPreview dimension={directDimension} px={px} />}
        </>}
        {selectionBox !== undefined && <rect
          className={`selection-box ${props.editTool === "stretch" ? "stretch-draw" : selectionBoxMode(selectionBox.start, selectionBox.end)}`}
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
        text={dimensionText}
        position={(() => {
          const at = sketchToScreen(dimensionEdit.anchor, { left: 0, top: 0, width: camera.size.width, height: camera.size.height }, camera.camera);
          return [Math.max(8, Math.min(at[0] - 70, camera.size.width - 190)), Math.max(8, Math.min(at[1] - 62, camera.size.height - 70))] as const;
        })()}
        onChange={setDimensionText}
        onCommit={commitDimensionEdit}
        onCancel={() => setDimensionEdit(undefined)}
      />}
      {dynamicFields.length > 0 && (pointerInside || dynamicFocused) && !camera.panning && <DynamicInputBox
        fields={dynamicFields}
        live={liveValues}
        text={fieldText}
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

      {props.dimensionMode && <div className="dimension-mode-banner"><CommandIcon name="dimension" /><span><strong>Sketch Dimension</strong>Select a curve, or pick two blue definition points. Esc to finish.</span></div>}

      <ViewportChrome workspace="sketch" state={props.viewportState} measurePoints={[]} onNavigationMode={props.onNavigationMode} onSelectionFilter={props.onSelectionFilter} onOrientation={props.onOrientation} onViewAngles={props.onViewAngles} onProjection={props.onProjection} onGrid={props.onGrid} onAxes={props.onAxes} onShadingMode={() => undefined} onBodyColor={() => undefined} onBackgroundTone={() => undefined} onFit={camera.fit} onHome={camera.fit} onClearMeasure={() => undefined} />

      <div className="sketch-palette" ref={paletteRef} aria-label="Sketch palette">
        <header><div><span>SKETCH</span><strong>Palette</strong></div><button onClick={props.onChangePlane} title="Move this sketch to another datum plane"><CommandIcon name="view" />Plane</button></header>
        <PaletteToggle label="Sketch grid" active={props.viewportState.gridVisible} onToggle={props.onGrid} />
        <PaletteToggle label="Snap" active={snapEnabled} onToggle={setSnapEnabled} />
        <PaletteToggle label="Auto-constrain" active={autoConstrain} onToggle={setAutoConstrain} />
        {props.tool === "polygon" && <label className="palette-number"><span>Polygon sides</span><input type="number" min={POLYGON_MIN_SIDES} max={POLYGON_MAX_SIDES} step={1} value={polygonSides} aria-label="Number of polygon sides" onChange={(event) => setPolygonSides(event.target.value)} /></label>}
        <SketchCurveOptionsPanel tool={props.tool} fields={curveFields} onChange={setCurveFields} blockNames={blockNames} selectedCount={selectedEntities.length} onSaveBlock={saveSelectionAsBlock} />
        <PaletteToggle label="Profiles" active={showProfiles} onToggle={setShowProfiles} />
        <PaletteToggle label="Dimensions" active={showDimensions} onToggle={setShowDimensions} />
        <PaletteToggle label="Constraints" active={showConstraints} onToggle={setShowConstraints} />
        <PaletteToggle label="Curvature comb" active={showComb} onToggle={setShowComb} />
        {showComb && <label><span>Comb scale</span><input type="range" aria-label="Curvature comb scale" min={0.2} max={3} step={0.1} value={combScale} onChange={(event) => setCombScale(Number(event.target.value))} /></label>}
        <button className="palette-action" disabled={selectedEntity === undefined} onClick={() => selectedEntity !== undefined && props.onToggleConstruction(selectedEntity.id)}><CommandIcon name={selectedEntity?.construction === true ? "rectangle" : "construction"} />{selectedEntity?.construction === true ? "Profile geometry" : "Construction"}</button>
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
            <input aria-label={solidOp === "revolve" ? "Angle in degrees" : solidOp === "sweep" ? "Sweep distance in millimetres" : "Height in millimetres"} type="number" min={solidOp === "revolve" ? 1 : 0.1} max={solidOp === "revolve" ? 360 : undefined} step={solidOp === "revolve" ? 5 : 1} value={solidValue} disabled={cutThroughAll || reachesTarget} onChange={(event) => setSolidValue(event.target.value)} />
            <small>{solidOp === "revolve" ? "°" : "mm"}</small>
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
          {solidOp === "sweep" && sweepMode === "path" && <div className="make-solid-row" aria-label="Sweep path entity">
            <small>Path</small>
            <select aria-label="Sweep path entity" value={sweepPathEntityId} onChange={(event) => setSweepPathEntityId(event.target.value)}>
              <option value="">(pick a line / arc / spline)</option>
              {props.sketch.entities.filter((entity) => (entity.kind === "line" || entity.kind === "arc" || entity.kind === "spline") && entity.visible !== false).map((entity) => <option key={entity.id} value={entity.id}>{entity.kind} · {entity.id.slice(-8)}</option>)}
            </select>
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
            const advanced = solidOp === "sweep"
              ? {
                ...(sweepMode === "path" && sweepPathEntityId !== ""
                  ? { sweepPathEntityId, ...(sweepFrameTransport ? { sweepFrameTransport: true } : {}) }
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
              advanced
            );
          }}><CommandIcon name={solidResult === "cut" ? "subtract" : solidResult === "join" ? "unite" : "box"} />{solidResult === "cut" ? "Cut solid" : solidResult === "join" ? "Join solid" : "Create solid"}</button>
          {profiles.length === 0 && <small className="make-solid-hint make-solid-reason" role="status">No closed region yet. {noProfileReasons.join(" ")} Open Validate Sketch for every open end and gap.</small>}
          {solidOp === "extrude" && profiles.length > 0 && <small className="make-solid-hint">{selectedProfileIds.length === 0 ? "Nothing selected: the outermost outline is used and outlines inside it become holes. Click regions to choose exactly which (Shift-click adds more, and several separate regions extrude together)." : selectedProfileIds.length === 1 ? "Only the clicked region is used. Shift-click the region inside a hole to fill it, or other separate regions to extrude them together." : `${selectedProfileIds.length} regions selected: touching regions merge, separate ones extrude together.`}</small>}
          {regionWarnings.map((warning) => <small key={warning} className="make-solid-hint make-solid-warning" role="status">{warning}</small>)}
        </div>
        <details className="palette-shortcuts">
          <summary>Shortcuts</summary>
          <dl>{SKETCH_HOTKEY_HELP.map((entry) => <div key={entry.keys}><dt>{entry.keys}</dt><dd>{entry.action}</dd></div>)}</dl>
        </details>
      </div>

      <div className="canvas-hud"><span>{planePlacement} · {planeInfo.horizontalLabel} → · {planeInfo.verticalLabel} ↑</span><span>{props.dimensionMode ? "Dimension" : sketchToolLabel(props.tool)}</span><span>Grid {props.viewportState.gridVisible ? `${format(grid.minorMm)} mm` : "off"}</span><span>Snap {snapEnabled ? `${SNAP_PIXELS} px` : "off"}</span><span>{pointerInside ? `${planeInfo.horizontalLabel} ${format(cursor[0])}  ${planeInfo.verticalLabel} ${format(cursor[1])} mm` : "Cursor outside the sketch"}</span><span>{visibleEntities.length}/{props.sketch.entities.length} entities visible</span><strong>{analysis.classification.replace("-", " ")}</strong></div>
      <div className="confirmation-corner" role="group" aria-label="Sketch confirmation corner">
        <small>Sketch</small>
        <button type="button" onClick={props.onCancelSketch} title="Cancel the sketch and return to Design. Pending points are dropped."><CommandIcon name="cancel" />Cancel</button>
        <button type="button" className="primary" onClick={props.onFinishSketch} title="Finish the sketch and commit it to the timeline."><CommandIcon name="save" />OK</button>
      </div>
    </section>

    <aside className="inspector-panel" aria-label="Sketch inspector">
      <div className="inspector-title"><div><p>Sketch intelligence</p><h2>{props.sketch.name}</h2></div><CapabilityBadge level="preview" /></div>
      <section className={`solver-card ${analysis.classification}`}>
        <span className="solver-number">{analysis.degreesOfFreedom}</span>
        <div><strong>{analysis.classification === "fully-constrained" ? "Fully constrained" : analysis.classification === "conflict" ? "Constraint conflict" : "Degrees of freedom"}</strong><small>{analysis.appliedConstraints} supported constraints evaluated</small></div>
      </section>
      {analysis.conflicts.length > 0 && <div className="inline-warning">{analysis.conflicts[0]}</div>}

      {dynamicMirrorEntity !== undefined && props.editTool !== "dynamic-mirror" && <div className="inline-warning movable-note" role="status" aria-label="Dynamic mirror active">
        Dynamic mirror is on: what you draw is mirrored about {dynamicMirrorEntity.id.replace(/^entity:/u, "")}. <button className="palette-action" onClick={() => { setDynamicMirrorAxis(null); props.onMessage("Dynamic mirror stopped."); }}><CommandIcon name="cancel" />Stop</button>
      </div>}
      {props.editTool !== null && <SketchEditPanel tool={props.editTool} sketch={props.sketch} selectionIds={selectionIds} stretchWindow={stretchWindow} onStretchWindow={setStretchWindow} onApply={(plan) => { props.onApplyEdit(plan); }} onMessage={props.onMessage} onClose={props.onCloseEditTool} jog={jogParams} onJog={setJogParams} dynamicMirrorAxis={dynamicMirrorAxis} onDynamicMirror={(axisId) => { setDynamicMirrorAxis(axisId); props.onMessage(axisId === null ? "Dynamic mirror stopped." : `Dynamic mirror on: pick a drawing tool; everything you draw is mirrored about ${axisId.replace(/^entity:/u, "")}.`); }} />}
      {props.checkOpen && <SketchRepairPanel sketch={props.sketch} onApplyEdit={props.onApplyEdit} onSetSuppressed={props.onSetSuppressed} onSelect={(ids) => { setSelectionIds(ids); props.onSelect(ids.at(-1) ?? null); }} onMessage={props.onMessage} onClose={props.onCloseCheck} />}
      {props.showMovable && <div className="inline-warning movable-note">{movableIds.size === 0 ? "Show Movable: every entity is fully constrained." : `Show Movable: ${movableIds.size} entit${movableIds.size === 1 ? "y has" : "ies have"} estimated degrees of freedom (amber).`}</div>}
      <section className="inspector-section point-relations"><header><strong>Point relations</strong><span>{pickRelation === null ? "pick points" : pickRelation}</span></header>
        <div className="constraint-buttons">
          <button className={pickRelation === "coincident" ? "active" : ""} aria-pressed={pickRelation === "coincident"} title="Join two points: pick one, then the one that should move onto it." onClick={() => pickRelation === "coincident" ? setPickRelation(null) : startPickRelation("coincident")}><CommandIcon name="coincident" />Coincident</button>
          <button className={pickRelation === "midpoint" ? "active" : ""} aria-pressed={pickRelation === "midpoint"} title="Put a point at the middle of a line: pick the point, then the line." onClick={() => pickRelation === "midpoint" ? setPickRelation(null) : startPickRelation("midpoint")}><CommandIcon name="midpoint" />Midpoint</button>
        </div>
        {pickRelation !== null && <p className="profile-help">{pickedPoint === undefined ? "Pick a point on the canvas (blue squares)." : pickRelation === "coincident" ? `${pickedPoint.label} picked. Pick the point that should move onto it.` : `${pickedPoint.label} picked. Click the line it should sit in the middle of.`} Esc cancels.</p>}
      </section>

      <section className="inspector-section"><header><strong>Selection controller</strong><span>{selectionIds.length} selected</span></header>
        {selectedEntity === undefined ? <p className="empty-copy">Select an entity, or drag a box: left to right takes what the box fully encloses, right to left takes anything it touches. Shift adds to the selection.</p> : <>
          <dl className="compact-facts"><div><dt>Primary</dt><dd>{selectedEntity.kind}</dd></div><div><dt>Freedom</dt><dd>{analysis.entityFreedom[selectedEntity.id] ?? 0}</dd></div><div><dt>Stable ID</dt><dd>{shortId(selectedEntity.id)}</dd></div><div><dt>Constraints</dt><dd>{selectedConstraints.length}</dd></div></dl>
          <div className="selection-chips">{selectedEntities.map((entity, index) => <span key={entity.id}><b>{index + 1}</b>{entity.kind}</span>)}</div>
          <div className="constraint-buttons">
            <button disabled={!horizontalFit.ok} title={hint(horizontalFit, "Make the line horizontal.")} onClick={() => constrain("horizontal")}><CommandIcon name="horizontal" />Horizontal</button>
            <button disabled={!verticalFit.ok} title={hint(verticalFit, "Make the line vertical.")} onClick={() => constrain("vertical")}><CommandIcon name="vertical" />Vertical</button>
            <button disabled={!parallelFit.ok} title={hint(parallelFit, "Make two lines parallel.")} onClick={() => constrain("parallel")}><CommandIcon name="parallel" />Parallel</button>
            <button disabled={!perpendicularFit.ok} title={hint(perpendicularFit, "Make two lines perpendicular.")} onClick={() => constrain("perpendicular")}><CommandIcon name="perpendicular" />Perpendicular</button>
            <button disabled={!collinearFit.ok} title={hint(collinearFit, "Put two lines on one line.")} onClick={() => constrain("collinear")}><CommandIcon name="collinear" />Collinear</button>
            <button disabled={!concentricFit.ok} title={hint(concentricFit, "Give two circles or arcs one centre.")} onClick={() => constrain("concentric")}><CommandIcon name="concentric" />Concentric</button>
            <button disabled={!equalFit.ok} title={hint(equalFit, "Make two lines equal in length, or two circles or arcs equal in radius.")} onClick={() => constrain("equal")}><CommandIcon name="equal" />Equal</button>
            <button disabled={!tangentFit.ok} title={hint(tangentFit, "Line and circle/arc, or two circles/arcs. The second selection is adjusted.")} onClick={() => constrain("tangent")}><CommandIcon name="tangent" />Tangent</button>
            <button disabled={!symmetricFit.ok} title={hint(symmetricFit, "Select two lines or two circles, then the axis line last. The second is mirrored onto the first.")} onClick={() => constrain("symmetry")}><CommandIcon name="mirror" />Symmetric</button>
            {fixedIds.length === 0
              ? <button onClick={() => constrain("fixed")}><CommandIcon name="fixed" />Fix primary</button>
              : <button title="Remove the Fixed relation so the curve can move again." onClick={() => fixedIds.forEach((id) => props.onDeleteConstraint(id))}><CommandIcon name="unfixed" />Unfix primary</button>}
            <button onClick={() => props.onToggleConstruction(selectedEntity.id)}><CommandIcon name={selectedEntity.construction ? "rectangle" : "construction"} />{selectedEntity.construction ? "Profile" : "Construction"}</button>
            <button onClick={() => props.onToggleVisibility(selectedEntity.id)}><CommandIcon name={selectedEntity.visible === false ? "eye" : "eye-off"} />{selectedEntity.visible === false ? "Show entity" : "Hide entity"}</button>
            <button className="danger" onClick={() => props.onDeleteEntity(selectedEntity.id)}><CommandIcon name="trash" />Delete primary</button>
          </div>
        </>}
      </section>

      {props.dimensionMode && <section className="inspector-section direct-dimension-controller"><header><strong>Direct sketch dimension</strong><span>{dimensionPoints.length}/2 points</span></header>
        {dimensionPoints.length === 0 && <p className="empty-copy">Click a line, rectangle, or circle for its primary driving dimension, or pick any two blue definition points.</p>}
        {dimensionPoints.length === 1 && <div className="dimension-pick-state"><b>1</b><span>{dimensionPoints[0]!.label}</span><small>Pick the second point.</small></div>}
        {directDimension !== undefined && <>
          <dl className="compact-facts"><div><dt>Selection</dt><dd>{directDimension.first.label} → {directDimension.second.label}</dd></div><div><dt>Distance</dt><dd>{format(directDimension.valueMm)} mm</dd></div><div><dt>ΔX</dt><dd>{format(directDimension.delta[0])} mm</dd></div><div><dt>ΔY</dt><dd>{format(directDimension.delta[1])} mm</dd></div></dl>
          {directDimension.driving === undefined
            ? <div className="inline-warning">This is a reference measurement. Editing arbitrary cross-entity point pairs requires the nonlinear constraint solver.</div>
            : <DimensionField label={directDimension.label} dimension={directDimension.driving.dimension} value={directDimension.valueMm} onApply={(dimension, value) => props.onSetDimension(directDimension.driving!.entityId, dimension, value)} onMessage={props.onMessage} />}
        </>}
      </section>}

      {!props.dimensionMode && <ConstraintExtras sketch={props.sketch} selected={selectedEntities} bridge={props.constraintExtras} onSetDimension={props.onSetDimension} onAddConstraint={props.onAddConstraint} onApplyEdit={props.onApplyEdit} onMessage={props.onMessage} />}
      <SketchRelationList constraints={selectedConstraints} entities={props.sketch.entities} onSetSuppressed={(ids, suppressed) => { props.onSetSuppressed(ids, suppressed); }} />
      {!props.dimensionMode && selectedEntity !== undefined && <section className="inspector-section dimension-controller"><header><strong>Driving dimensions</strong><span>mm</span></header><EntityDimensions entity={selectedEntity} onApply={(dimension, value) => props.onSetDimension(selectedEntity.id, dimension, value)} onMessage={props.onMessage} /></section>}

      <section className="inspector-section profile-controller"><header><strong>Closed profiles</strong><span>{profiles.length} found</span></header>
        <p className="profile-help">Profile selects a shaded region; Curve, Connected and Tangent intents use the shared top selection controller. Use Create solid in the palette to extrude or revolve the selected profiles into a new body.</p>
        <div className="profile-list">{profiles.map((profile, index) => <button key={profile.id} className={selectedProfileIds.includes(profile.id) ? "selected" : ""} onClick={(event) => selectProfile(profile, event.shiftKey || event.ctrlKey || event.metaKey)}><span><b>P{index + 1}</b>{profileLabel(profile)}</span><small>{format(profile.areaMm2)} mm²</small></button>)}</div>
      </section>

      <section className="inspector-section"><header><strong>Constraint records</strong><span>{props.sketch.constraints.length}</span></header>
        <div className="record-list">{props.sketch.constraints.slice(-10).reverse().map((constraint) => <button key={constraint.id} onClick={() => props.onDeleteConstraint(constraint.id)} title="Delete this constraint"><CommandIcon name={constraint.dimension === undefined ? constraint.kind : "dimension"} /><span>{constraint.kind}{constraint.dimension === undefined ? "" : ` · ${constraint.dimension}`}{constraint.driven === true ? " · reference" : ""}{constraint.suppressed === true ? " · relaxed" : ""}</span><small>{constraint.valueDeg !== undefined ? `${format(constraint.valueDeg)}°` : constraint.valueMm === undefined ? shortId(constraint.id) : `${format(constraint.valueMm)} mm`}</small></button>)}</div>
      </section>
      <div className="scope-note"><strong>Preview solver boundary</strong><p>A small analytic solver enforces horizontal, vertical, parallel, perpendicular, collinear, tangent, concentric, equal, symmetric and fixed relations plus radius and length dimensions on lines, circles and arcs; a conflict is refused with the reason. Rectangles are rigid, point-on-curve and endpoint relations are recorded but not solved, and there is no general nonlinear solver. Degrees of freedom are an estimate.</p></div>
    </aside>
  </>;
}

/** A driving dimension drawn like a drawing dimension: extension lines, a dimension line with arrowheads, and editable text. */
function DimensionMarks({ entity, dimension, valueMm, relaxed, px, onEdit }: { readonly entity: SketchEntity; readonly dimension: DrivingDimension; readonly valueMm: number; readonly relaxed: boolean; readonly px: number; readonly onEdit?: () => void }): React.JSX.Element {
  const layout = dimensionLayout(entity, dimension, valueMm, px);
  if (layout === undefined) return <></>;
  const flip = (point: Vec2): string => `${point[0]},${-point[1]}`;
  const textWidth = (layout.label.length * 7.4 + 12) * px;
  return <g className={`driving-dimension${relaxed ? " relaxed" : ""}`} data-dimension-for={entity.id} pointerEvents={onEdit === undefined ? "none" : undefined}>
    {layout.extensionLines.map((segment, index) => <line key={index} x1={segment.from[0]} y1={-segment.from[1]} x2={segment.to[0]} y2={-segment.to[1]} />)}
    <line x1={layout.dimensionLine.from[0]} y1={-layout.dimensionLine.from[1]} x2={layout.dimensionLine.to[0]} y2={-layout.dimensionLine.to[1]} />
    {layout.arrows.map((arrow, index) => <polygon key={index} className="arrow" points={arrowHead(arrow, px).map(flip).join(" ")} />)}
    <rect className="driving-dimension-hit" x={layout.textAt[0] - textWidth / 2} y={-layout.textAt[1] - 11 * px} width={textWidth} height={20 * px} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); onEdit?.(); }} />
    <text className="driving-dimension-text" x={layout.textAt[0]} y={-layout.textAt[1] + 4 * px} style={{ fontSize: 12.5 * px, strokeWidth: 3.5 * px }} pointerEvents="none">{layout.label}</text>
  </g>;
}

/** Type a new value for a driving dimension next to it: Enter applies, Esc closes. */
function DimensionEditor(props: { readonly label: string; readonly text: string; readonly position: readonly [number, number]; readonly onChange: (text: string) => void; readonly onCommit: () => void; readonly onCancel: () => void }): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
  return <div className="dimension-editor" style={{ left: props.position[0], top: props.position[1] }} role="group" aria-label={`Edit ${props.label.toLowerCase()}`}>
    <label><span>{props.label}</span>
      <input
        ref={inputRef}
        inputMode="decimal"
        aria-label={`${props.label} in millimetres`}
        value={props.text}
        onChange={(event) => props.onChange(event.target.value)}
        onBlur={props.onCancel}
        onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); props.onCommit(); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onCancel(); }
        }}
      />
      <small>mm</small>
    </label>
    <em>Enter applies a driving value · Esc closes</em>
  </div>;
}

/** The editable length, angle, width, height or radius next to the cursor while a shape is being placed. */
function DynamicInputBox(props: {
  readonly fields: readonly { readonly id: DynamicFieldId; readonly label: string; readonly unit: string }[];
  readonly live: DynamicValues;
  readonly text: Partial<Record<DynamicFieldId, string>>;
  readonly position: readonly [number, number];
  readonly setRef: (id: DynamicFieldId, element: HTMLInputElement | null) => void;
  readonly onChange: (id: DynamicFieldId, value: string) => void;
  readonly onFocus: (id: DynamicFieldId) => void;
  readonly onBlur: () => void;
  readonly onCommit: () => void;
  readonly onCancel: () => void;
  readonly onTab: (id: DynamicFieldId, backwards: boolean) => void;
}): React.JSX.Element {
  const show = (id: DynamicFieldId): string => {
    const typed = props.text[id];
    if (typed !== undefined) return typed;
    const live = props.live[id];
    return live === undefined ? "" : String(Number(live.toFixed(2)));
  };
  return <div className="dynamic-input" style={{ left: props.position[0], top: props.position[1] }} role="group" aria-label="Typed input">
    {props.fields.map((field) => <label key={field.id} className={props.text[field.id] === undefined ? "" : "locked"}>
      <span>{field.label}</span>
      <input
        ref={(element) => props.setRef(field.id, element)}
        inputMode="decimal"
        aria-label={`${field.label} in ${field.unit}`}
        value={show(field.id)}
        onFocus={() => props.onFocus(field.id)}
        onBlur={props.onBlur}
        onChange={(event) => props.onChange(field.id, event.target.value)}
        onKeyDown={(event) => {
          // After placing, give the keyboard back to the canvas so Esc, tool letters and Delete work again.
          if (event.key === "Enter") { event.preventDefault(); props.onCommit(); event.currentTarget.blur(); }
          else if (event.key === "Tab") { event.preventDefault(); props.onTab(field.id, event.shiftKey); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onCancel(); event.currentTarget.blur(); }
        }}
      />
      <small>{field.unit}</small>
    </label>)}
    <em>Type a value · Tab next · Enter place</em>
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
      case "grid": return <path d={`M ${x - s * 0.7} ${y} H ${x + s * 0.7} M ${x} ${y - s * 0.7} V ${y + s * 0.7}`} />;
      default: return null;
    }
  };
  return <g className="inference-marks" pointerEvents="none">
    {inference.guides.map((guide, index) => <line key={index} className="inference-guide" x1={guide.from[0]} y1={-guide.from[1]} x2={guide.to[0]} y2={-guide.to[1]} />)}
    {primary !== undefined && primary.kind !== "grid" && <g className="inference-glyph">{glyph()}</g>}
    {primary !== undefined && primary.kind !== "grid" && <text className="inference-label" x={x + 11 * px} y={y - 9 * px} style={{ fontSize: 11.5 * px, strokeWidth: 3 * px }}>{INFERENCE_LABELS[primary.kind]}</text>}
  </g>;
}

function PaletteToggle({ label, active, onToggle }: { readonly label: string; readonly active: boolean; readonly onToggle: (active: boolean) => void }): React.JSX.Element {
  return <label><span>{label}</span><input type="checkbox" checked={active} onChange={(event) => onToggle(event.target.checked)} /></label>;
}

function EntityDimensions({ entity, onApply, onMessage }: { readonly entity: SketchEntity; readonly onApply: (dimension: DrivingDimension, value: number) => void; readonly onMessage: (message: string) => void }): React.JSX.Element {
  if (entity.kind === "line") return <DimensionField label="Length" dimension="length" value={Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1])} onApply={onApply} onMessage={onMessage} />;
  if (entity.kind === "rectangle") return <div className="dimension-stack"><DimensionField label="Width" dimension="width" value={entity.widthMm} onApply={onApply} onMessage={onMessage} /><DimensionField label="Height" dimension="height" value={entity.heightMm} onApply={onApply} onMessage={onMessage} /></div>;
  if (entity.kind === "circle") return <><DimensionField label="Radius" dimension="radius" value={entity.radiusMm} onApply={onApply} onMessage={onMessage} /><div className="derived-dimension"><span>Diameter</span><strong>{format(entity.radiusMm * 2)} mm</strong></div></>;
  if (entity.kind === "ellipse") return <div className="dimension-stack"><div className="derived-dimension"><span>Major radius</span><strong>{format(entity.majorRadiusMm)} mm</strong></div><div className="derived-dimension"><span>Minor radius</span><strong>{format(entity.minorRadiusMm)} mm</strong></div></div>;
  return <div className="derived-dimension"><span>{entity.kind === "arc" ? "Three-point arc" : entity.kind === "spline" ? "Fit-point spline" : "Sketch point"}</span><strong>reference only</strong></div>;
}

function DimensionField({ label, dimension, value, onApply, onMessage }: { readonly label: string; readonly dimension: DrivingDimension; readonly value: number; readonly onApply: (dimension: DrivingDimension, value: number) => void; readonly onMessage: (message: string) => void }): React.JSX.Element {
  const [draft, setDraft] = useState(String(Number(value.toFixed(3))));
  useEffect(() => setDraft(String(Number(value.toFixed(3)))), [value]);
  return <form className="dimension-field" onSubmit={(event) => { event.preventDefault(); const trimmed = draft.trim(); const next = Number(trimmed); if (trimmed !== "" && Number.isFinite(next)) onApply(dimension, next); else onMessage?.(`Enter a numeric ${label.toLowerCase()} value in millimeters.`); }}>
    <label><span>{label}</span><div><input aria-label={`${label} in millimeters`} inputMode="decimal" value={draft} onChange={(event) => setDraft(event.target.value)} /><small>mm</small><button type="submit"><CommandIcon name="dimension" />Apply</button></div></label>
  </form>;
}

function dimensionHandles(entity: SketchEntity): readonly SketchDimensionPoint[] {
  const point = (handle: SketchDimensionHandle, value: Vec2, label: string): SketchDimensionPoint => ({ id: `dimension-point:${entity.id}:${handle}`, entityId: entity.id, entityKind: entity.kind, handle, point: value, label });
  if (entity.kind === "line") return [point("start", entity.start, "Line start"), point("end", entity.end, "Line end")];
  if (entity.kind === "rectangle") {
    const radians = entity.rotationDeg * Math.PI / 180;
    const axisX: Vec2 = [Math.cos(radians), Math.sin(radians)];
    const axisY: Vec2 = [-Math.sin(radians), Math.cos(radians)];
    const offset = (axis: Vec2, distance: number): Vec2 => [entity.center[0] + axis[0] * distance, entity.center[1] + axis[1] * distance];
    return [
      point("left", offset(axisX, -entity.widthMm / 2), "Rectangle left midpoint"),
      point("right", offset(axisX, entity.widthMm / 2), "Rectangle right midpoint"),
      point("bottom", offset(axisY, -entity.heightMm / 2), "Rectangle bottom midpoint"),
      point("top", offset(axisY, entity.heightMm / 2), "Rectangle top midpoint")
    ];
  }
  if (entity.kind === "circle") return [point("center", entity.center, "Circle center"), point("radius", [entity.center[0] + entity.radiusMm, entity.center[1]], "Circle radius point")];
  if (entity.kind === "ellipse") {
    const radians = entity.rotationDeg * Math.PI / 180;
    const cos = Math.cos(radians);
    const sin = Math.sin(radians);
    const majorEnd: Vec2 = [entity.center[0] + entity.majorRadiusMm * cos, entity.center[1] + entity.majorRadiusMm * sin];
    const minorEnd: Vec2 = [entity.center[0] - entity.minorRadiusMm * sin, entity.center[1] + entity.minorRadiusMm * cos];
    return [point("center", entity.center, "Ellipse center"), point("right", majorEnd, "Ellipse major-axis end"), point("top", minorEnd, "Ellipse minor-axis end")];
  }
  if (entity.kind === "point") return [point("center", entity.point, "Sketch point")];
  if (entity.kind === "spline") return [point("start", entity.fitPoints[0]!, "Spline start"), point("end", entity.fitPoints[entity.fitPoints.length - 1]!, "Spline end")];
  return [point("start", entity.start, "Arc start"), point("mid", entity.mid, "Arc middle"), point("end", entity.end, "Arc end")];
}

function defaultDimensionPoints(entity: SketchEntity): readonly SketchDimensionPoint[] {
  const handles = dimensionHandles(entity);
  if (entity.kind === "rectangle") return handles.filter((point) => point.handle === "left" || point.handle === "right");
  if (entity.kind === "arc") return handles.filter((point) => point.handle === "start" || point.handle === "end");
  return handles.slice(0, 2);
}

function resolveDirectSketchDimension(points: readonly SketchDimensionPoint[]): DirectSketchDimension | undefined {
  if (points.length !== 2 || points[0]!.id === points[1]!.id) return undefined;
  const [first, second] = points as readonly [SketchDimensionPoint, SketchDimensionPoint];
  const delta: Vec2 = [second.point[0] - first.point[0], second.point[1] - first.point[1]];
  const valueMm = Math.hypot(delta[0], delta[1]);
  let driving: DirectSketchDimension["driving"];
  let label = "Reference distance";
  if (first.entityId === second.entityId) {
    const handles = new Set([first.handle, second.handle]);
    if (first.entityKind === "line" && handles.has("start") && handles.has("end")) { driving = { entityId: first.entityId, dimension: "length" }; label = "Line length"; }
    else if (first.entityKind === "rectangle" && handles.has("left") && handles.has("right")) { driving = { entityId: first.entityId, dimension: "width" }; label = "Rectangle width"; }
    else if (first.entityKind === "rectangle" && handles.has("top") && handles.has("bottom")) { driving = { entityId: first.entityId, dimension: "height" }; label = "Rectangle height"; }
    else if (first.entityKind === "circle" && handles.has("center") && handles.has("radius")) { driving = { entityId: first.entityId, dimension: "radius" }; label = "Circle radius"; }
  }
  return { label, valueMm, delta, first, second, ...(driving === undefined ? {} : { driving }) };
}

function DirectDimensionPreview({ dimension, px }: { readonly dimension: DirectSketchDimension; readonly px: number }): React.JSX.Element {
  const x = (dimension.first.point[0] + dimension.second.point[0]) / 2;
  const y = -(dimension.first.point[1] + dimension.second.point[1]) / 2 - 8 * px;
  return <g className={`direct-dimension-preview ${dimension.driving === undefined ? "reference" : "driving"}`} pointerEvents="none">
    <line x1={dimension.first.point[0]} y1={-dimension.first.point[1]} x2={dimension.second.point[0]} y2={-dimension.second.point[1]} />
    <text x={x} y={y} style={{ fontSize: 12 * px, strokeWidth: 3 * px }}>{format(dimension.valueMm)} mm</text>
  </g>;
}

function SketchEntityShape({ entity, px, selected, hovered, onSelect, onHover, onGrab, handles, preview = false, movable = false, constrained = false }: { readonly entity: SketchEntity; readonly px: number; readonly selected: boolean; readonly hovered: boolean; readonly onSelect?: (additive: boolean) => void; readonly onHover?: (inside: boolean) => void; readonly onGrab?: (event: React.PointerEvent, handle: DragHandle) => void; readonly handles?: readonly SketchGrabHandle[]; readonly preview?: boolean; readonly movable?: boolean; readonly constrained?: boolean }): React.JSX.Element {
  // Fully constrained curves are drawn in a neutral tone and under-constrained ones in the working colour, so what can still move is visible at a glance.
  const className = `sketch-entity ${entity.construction ? "construction" : ""} ${selected ? "selected" : ""} ${hovered && !selected ? "hover" : ""} ${preview ? "tool-preview" : ""} ${movable && !selected ? "movable" : ""} ${constrained && !preview && entity.kind !== "point" ? "constrained" : ""}`;
  const geometry = (cls: string, hit: boolean): React.JSX.Element => {
    if (entity.kind === "line") return <line className={cls} x1={entity.start[0]} y1={-entity.start[1]} x2={entity.end[0]} y2={-entity.end[1]} />;
    if (entity.kind === "rectangle") return <rect className={cls} x={entity.center[0] - entity.widthMm / 2} y={-entity.center[1] - entity.heightMm / 2} width={entity.widthMm} height={entity.heightMm} transform={`rotate(${-entity.rotationDeg} ${entity.center[0]} ${-entity.center[1]})`} />;
    if (entity.kind === "circle") return <circle className={cls} cx={entity.center[0]} cy={-entity.center[1]} r={entity.radiusMm} />;
    if (entity.kind === "ellipse") return <ellipse className={cls} cx={entity.center[0]} cy={-entity.center[1]} rx={entity.majorRadiusMm} ry={entity.minorRadiusMm} transform={`rotate(${-entity.rotationDeg} ${entity.center[0]} ${-entity.center[1]})`} />;
    if (entity.kind === "point") return <circle className={`${cls} sketch-point`} cx={entity.point[0]} cy={-entity.point[1]} r={(hit ? 9 : 3.5) * px} />;
    if (entity.kind === "spline") return <path className={cls} d={sampleSpline(entity.fitPoints).map((point, index) => `${index === 0 ? "M" : "L"} ${point[0]} ${-point[1]}`).join(" ")} />;
    return <path className={cls} d={arcPathData(entity.start, entity.mid, entity.end)} />;
  };
  if (preview || onSelect === undefined) return <g data-selection-id={entity.id}>{geometry(className, false)}</g>;
  return <g
    className="sketch-entity-group"
    data-selection-id={entity.id}
    onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); onSelect(event.shiftKey || event.ctrlKey || event.metaKey); onGrab?.(event, { kind: "body" }); }}
    onPointerEnter={() => onHover?.(true)}
    onPointerLeave={() => onHover?.(false)}
  >
    {geometry("sketch-hit", true)}
    {geometry(className, false)}
    {(selected || hovered) && handles?.map((handle) => <circle
      key={handle.id}
      className={`grab-handle ${handle.handle.kind}`}
      data-grab-handle={handle.id}
      cx={handle.point[0]}
      cy={-handle.point[1]}
      r={5 * px}
      role="button"
      aria-label={`Drag ${handle.label}`}
      onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); onSelect(false); onGrab?.(event, handle.handle); }}
    />)}
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
  if (profile.boundary.kind === "rectangle") return <rect {...common} x={profile.boundary.center[0] - profile.boundary.widthMm / 2} y={-profile.boundary.center[1] - profile.boundary.heightMm / 2} width={profile.boundary.widthMm} height={profile.boundary.heightMm} transform={`rotate(${-profile.boundary.rotationDeg} ${profile.boundary.center[0]} ${-profile.boundary.center[1]})`} />;
  if (profile.boundary.kind === "circle") return <circle {...common} cx={profile.boundary.center[0]} cy={-profile.boundary.center[1]} r={profile.boundary.radiusMm} />;
  if (profile.boundary.kind === "ellipse") return <ellipse {...common} cx={profile.boundary.center[0]} cy={-profile.boundary.center[1]} rx={profile.boundary.majorRadiusMm} ry={profile.boundary.minorRadiusMm} transform={`rotate(${-profile.boundary.rotationDeg} ${profile.boundary.center[0]} ${-profile.boundary.center[1]})`} />;
  const path = profile.boundary.points.map((point, index) => `${index === 0 ? "M" : "L"} ${point[0]} ${-point[1]}`).join(" ");
  return <path {...common} d={`${path} Z`} />;
}

function SketchDimensionGlyph({ entity, px }: { readonly entity: SketchEntity; readonly px: number }): React.JSX.Element {
  const style = { fontSize: 12 * px, strokeWidth: 3 * px };
  if (entity.kind === "line") {
    const x = (entity.start[0] + entity.end[0]) / 2;
    const y = -(entity.start[1] + entity.end[1]) / 2 - 8 * px;
    return <text x={x} y={y} style={style} className="sketch-dimension-glyph">{format(Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]))}</text>;
  }
  if (entity.kind === "rectangle") return <><text x={entity.center[0]} y={-entity.center[1] + entity.heightMm / 2 + 16 * px} style={style} className="sketch-dimension-glyph">{format(entity.widthMm)}</text><text x={entity.center[0] + entity.widthMm / 2 + 12 * px} y={-entity.center[1]} style={style} className="sketch-dimension-glyph vertical">{format(entity.heightMm)}</text></>;
  if (entity.kind === "circle") return <text x={entity.center[0] + entity.radiusMm * 0.35} y={-entity.center[1] - 8 * px} style={style} className="sketch-dimension-glyph">R {format(entity.radiusMm)}</text>;
  return <></>;
}

function ConstraintGlyph({ constraint, entities, px, slot }: { readonly constraint: WorkbenchSketchConstraint; readonly entities: readonly SketchEntity[]; readonly px: number; readonly slot: number }): React.JSX.Element {
  const entity = entities.find((candidate) => candidate.id === constraint.entityIds[0]);
  if (entity === undefined) return <></>;
  // A point-level relation is drawn at the point it joins; every other relation at the middle of its curve.
  const joined = constraint.points?.[0] === undefined ? undefined : relationPoints(entity).find((candidate) => candidate.ref === constraint.points?.[0]);
  const point = constraint.kind === "midpoint" || constraint.kind === "coincident" ? (joined?.point ?? entityAnchor(entity)) : entityAnchor(entity);
  const label = constraint.kind === "horizontal" ? "H" : constraint.kind === "vertical" ? "V" : constraint.kind === "parallel" ? "∥" : constraint.kind === "perpendicular" ? "⊥" : constraint.kind === "fixed" ? "F" : constraint.kind === "concentric" ? "◎" : constraint.kind === "equal" ? "=" : constraint.kind === "coincident" ? "•" : constraint.kind === "midpoint" ? "M" : constraint.kind === "angle" ? "∠" : constraint.kind === "arc-length" ? "⌒" : constraint.kind === "perimeter" ? "P" : constraint.kind === "smooth" ? "G2" : constraint.kind === "pierce" ? "⊙" : constraint.kind === "refraction" ? "n" : constraint.kind.slice(0, 1).toUpperCase();
  // Several relations on one curve fan out sideways instead of stacking on the same spot.
  const x = point[0] + (12 + slot * 19) * px;
  const y = -point[1] - 12 * px;
  return <g className={`constraint-glyph${constraint.suppressed === true ? " relaxed" : ""}`}><circle cx={x} cy={y} r={8 * px} /><text x={x} y={y + 4 * px} style={{ fontSize: 11 * px }}>{label}</text></g>;
}

function entityAnchor(entity: SketchEntity): Vec2 {
  if (entity.kind === "line") return [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2];
  if (entity.kind === "rectangle" || entity.kind === "circle" || entity.kind === "ellipse") return entity.center;
  if (entity.kind === "point") return entity.point;
  if (entity.kind === "spline") return entity.fitPoints[Math.floor(entity.fitPoints.length / 2)]!;
  return entity.mid;
}

function profileLabel(profile: SketchProfile): string {
  return profile.boundary.kind === "rectangle" ? "Rectangle region" : profile.boundary.kind === "circle" ? "Circle region" : profile.boundary.kind === "ellipse" ? "Ellipse region" : profile.boundary.kind === "curve-loop" ? "Closed curve loop" : "Closed line loop";
}

function shortId(id: string): string {
  return id.length < 28 ? id : `${id.slice(0, 18)}…${id.slice(-7)}`;
}

function format(value: number): string {
  return String(Number(value.toFixed(3)));
}
