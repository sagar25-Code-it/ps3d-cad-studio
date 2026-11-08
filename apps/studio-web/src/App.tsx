import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  createBracketDocument,
  parameterByKey,
  type CadDocument,
  type Diagnostic,
  type DisplayUnit,
  type ParameterKey
} from "../../../packages/model-schema/src/index.js";
import { parameterCommandId } from "../../../packages/commands/src/command-ids.js";
import { parseNativeRevisionText, serializeNativeRevision } from "../../../packages/import-export/src/index.js";
import {
  applyWorkbenchOperation,
  buildMasterCartItem,
  classifyWorkbenchSelection,
  createElectricalComponentInstance,
  createElectromechanicalAssembly,
  createWorkbenchProject,
  defaultElectromechanicalMappings,
  ELECTROMECHANICAL_CATALOG_REVISION,
  axisAlignedPlanarFaces,
  featureOfBody,
  isElectricalSheetPositionAvailable,
  parseWorkbenchProjectText,
  sketchPlaneName,
  preferredElectromechanicalLayout,
  resolveWorkbenchContextCommands,
  validateWorkbenchProject,
  type AssemblyTemplateId,
  type CadCommandRecord,
  baseFeatureOf,
  isFeatureActive,
  designOf,
  type ComponentInstance,
  type DesignFeature,
  type DesignSolidFeature,
  type GeneralSolidBody,
  type ElectricalComponentKind,
  type ElectricalNet,
  type ElectricalNetClass,
  type ElectricalTemplateId,
  type PartPreviewBody,
  type PartPreviewBodyShape,
  type MasterCartConfiguration,
  type MasterCartTemplateId,
  type SketchEntity,
  type VehicleTemplateId,
  type WorkbenchOperation,
  type WorkbenchProject,
  type WorkbenchSelectionKind,
  type SketchPlaneFrame,
  type SketchPlaneTilt,
  type WorkbenchSketchConstraint,
  type Vec3,
  type WorkspaceId
} from "../../../packages/workbench-core/src/index.js";
import { flangeReliefs, frameThroughPoints, flatLayoutDxf, flatLayoutSvg, nearestFrameEdge, nearestPickableEdge, pickableEdges, sharedFlangeEnds, sheetFrameOf, snapToAxis } from "../../../packages/workbench-geometry/src/index.js";
import { assemblyExplodeLimitMm, buildAssemblyPreview, buildPartPreview, buildSurfacePreview, findAssemblyInterference, meshChamfer, meshCounterbore, meshCountersink, meshFillet, meshHole, meshShell, meshTappedHole, METRIC_FASTENERS } from "../../../packages/workbench-geometry/src/index.js";
import { buildVehiclePreview } from "../../../packages/workbench-vehicle/src/index.js";
import { buildDesignHealthReport } from "../../../packages/workbench-health/src/index.js";
import { createDrawingSvg } from "../../../packages/workbench-drawing/src/index.js";
import { createElectricalSchematic } from "../../../packages/workbench-electrical/src/index.js";
import {
  buildInteractive3dPdf,
  buildPdfModelPackage,
  disposeExchangeObject,
  exportExchangeObject,
  exportGlbBytes,
  importReferenceModel,
  inspectExchangeObject,
  type ExchangeExportFormat,
  type ExchangeImportResult,
  type ExchangeUnit
} from "../../../packages/exchange-3d/src/index.js";
import { detectSketchProfiles, resolveProfileRegion, sketchToolLabel, type SketchTool } from "../../../packages/workbench-sketch/src/index.js";
import { combineGeneralBodies, createGeneralSolidBody, type SketchPlane } from "./general-modeling.js";
import { flatPatternForBody, sketchNormal, hasModifiers, planeKeyOf, rebuildDependents, rebuildSolidFeature, replayAllBodies, throughAllOverride } from "./design-regeneration.js";
import { TimelineBar } from "./ui/TimelineBar.js";
import { FeatureEditDialog } from "./ui/FeatureEditDialog.js";
import { CombineDialog, type CombineChoice } from "./ui/CombineDialog.js";
import type { BooleanMode } from "../../../packages/workbench-geometry/src/index.js";
import {
  ThreeViewportAdapter,
  viewAnglesForOrientation,
  type NavigationMode,
  type SelectionFilter,
  type ViewOrientation,
  type ViewportGuideSegment,
  type ViewportMeasurePoint,
  type ViewportBackgroundTone,
  type ViewportViewState,
  type ViewProjection
} from "../../../packages/viewport-three/src/index.js";
import type { ModelSuccessResponse, WorkerResponse } from "../../../packages/worker-protocol/src/index.js";
import { GeometryWorkerClient } from "./worker-client.js";
import { loadWorkbenchProject, saveWorkbenchProject } from "./workbench-store.js";
import { createQualifiedPartDocument } from "./project-worker-sync.js";
import {
  clearCurrentProjectFile,
  clearPsCadCaches,
  commitOpenedProject,
  getPsCadWorkspaceStatus,
  initializePsCadWorkspace,
  listRecentProjects,
  loadCachedWorkbenchProject,
  openProjectWithPicker,
  openRecentProject,
  preparePsCadLocalStorage,
  readProjectFilePayload,
  saveProjectText,
  writeWorkspaceArtifact,
  type ProjectFilePayload,
  type PsCadWorkspaceStatus,
  type RecentProjectEntry
} from "./file-workspace.js";
import { WorkbenchHeader } from "./ui/WorkbenchHeader.js";
import { WorkbenchRibbon } from "./ui/WorkbenchRibbon.js";
import { SaveProjectDialog } from "./ui/SaveProjectDialog.js";
import { NewProjectDialog } from "./ui/NewProjectDialog.js";
import { SketchPlaneDialog, type SketchFaceOption } from "./ui/SketchPlaneDialog.js";
import { buildWorkbenchMenus } from "./ui/menu-model.js";
import { exportFileName, safeFileStem } from "./file-names.js";
import { selectionMetrics } from "./selection-metrics.js";
import { ProjectTree } from "./ui/ProjectTree.js";
import { CommandPalette } from "./ui/CommandPalette.js";
import { ExchangeCenter } from "./ui/ExchangeCenter.js";
import { ViewportChrome } from "./ui/ViewportChrome.js";
import { CameraGestureControl, type CameraCursorState } from "./ui/CameraGestureControl.js";
import { DesignHealthCenter } from "./ui/DesignHealthCenter.js";
import { SmartFaultBrain } from "./ui/SmartFaultBrain.js";
import { WorkbenchContextMenu } from "./ui/WorkbenchContextMenu.js";
import { SketchWorkspace } from "./workspaces/SketchWorkspace.js";
import { SKETCH_EDIT_TOOL_LABELS, type SketchEditToolId } from "./workspaces/SketchEditPanel.js";
import type { SketchEditPlan } from "../../../packages/workbench-sketch/src/edit-tools.js";
import { PartInspector } from "./workspaces/PartInspector.js";
import { ImportedModelInspector } from "./workspaces/ImportedModelInspector.js";
import { AssemblyInspector } from "./workspaces/AssemblyInspector.js";
import { MasterCartWorkspace } from "./workspaces/MasterCartWorkspace.js";
import {
  DEFAULT_RENDER_SETTINGS,
  RenderStudioWorkspace,
  renderResolutionSize,
  type RenderGalleryEntry,
  type RenderStudioSettings
} from "./workspaces/RenderStudioWorkspace.js";
import { SurfaceInspector } from "./workspaces/SurfaceInspector.js";
import { DrawingWorkspace } from "./workspaces/DrawingWorkspace.js";
import { AutomateWorkspace } from "./workspaces/AutomateWorkspace.js";
import { ElectricalWorkspace } from "./workspaces/ElectricalWorkspace.js";
import { VehicleWorkspace } from "./workspaces/VehicleWorkspace.js";
import { PS3D_BRAND } from "./brand.js";

type WithoutEnvelope<T> = T extends unknown ? Omit<T, "operationId" | "expectedRevision"> : never;
type OperationIntent = WithoutEnvelope<WorkbenchOperation>;
type PartParameter = Extract<WorkbenchOperation, { kind: "set-part-parameter" }>["parameter"];
type ReplaceableAssemblyTemplate = Exclude<AssemblyTemplateId, "custom" | "electrical-panel">;
type UiDiagnostic = Pick<Diagnostic, "code" | "message" | "recovery"> | { readonly code: string; readonly message: string; readonly recovery: string };
interface OpenContextMenu { readonly x: number; readonly y: number; readonly selectionId: string | null; readonly selectionKind: WorkbenchSelectionKind; }
interface PreparedQualifiedWorker {
  readonly client: GeometryWorkerClient;
  readonly response: ModelSuccessResponse;
  readonly activate: () => void;
}

const QUALIFIED_PART_KEYS: Readonly<Partial<Record<PartParameter, ParameterKey>>> = {
  widthMm: "width",
  heightMm: "height",
  thicknessMm: "thickness",
  holeDiameterMm: "holeDiameter"
};

const DEFAULT_VIEWPORT_STATE: ViewportViewState = {
  orientation: "isometric",
  projection: "perspective",
  navigationMode: "select",
  selectionFilter: "auto",
  shadingMode: "shaded-edges",
  bodyColor: "#aeb3b8",
  backgroundTone: "dark-gray",
  gridVisible: true,
  axesVisible: true,
  azimuthDeg: -45,
  elevationDeg: 35.3
};

const DEFAULT_FILE_WORKSPACE_STATUS: PsCadWorkspaceStatus = {
  apiSupported: false,
  bound: false,
  permission: "unsupported",
  folderName: "PS CAD Studio",
  persistentStorage: false,
  cacheReady: false,
  usageBytes: 0,
  quotaBytes: 0,
  currentFileName: null
};

const SHORTCUT_GROUPS: readonly { readonly title: string; readonly items: readonly { readonly keys: readonly string[]; readonly label: string }[] }[] = [
  {
    title: "File & history",
    items: [
      { keys: ["S"], label: "Command search (outside dialogs and text fields)" },
      { keys: ["Ctrl", "K"], label: "Open the command palette" },
      { keys: ["Ctrl", "S"], label: "Save" },
      { keys: ["Ctrl", "Shift", "S"], label: "Save as" },
      { keys: ["Ctrl", "O"], label: "Open a project" },
      { keys: ["Ctrl", "N"], label: "New project" },
      { keys: ["Ctrl", "Z"], label: "Undo" },
      { keys: ["Ctrl", "Shift", "Z"], label: "Redo" },
      { keys: ["Ctrl", "P"], label: "Print" }
    ]
  },
  {
    title: "View & navigation (3D / sketch)",
    items: [
      { keys: ["F"], label: "Fit all visible geometry" },
      { keys: ["1"], label: "Front view" },
      { keys: ["2"], label: "Top view" },
      { keys: ["3"], label: "Right view" },
      { keys: ["4"], label: "Isometric view" },
      { keys: ["V"], label: "Select navigation mode" },
      { keys: ["O"], label: "Orbit navigation mode" },
      { keys: ["P"], label: "Pan navigation mode" },
      { keys: ["M"], label: "Measure (not in sketch)" }
    ]
  },
  {
    title: "Panels",
    items: [
      { keys: ["Ctrl", "Shift", "H"], label: "Open Design Health" },
      { keys: ["Esc"], label: "Leave Render Studio / close dialog" },
      { keys: ["?"], label: "Show this shortcut list" }
    ]
  }
];

export function App(): React.JSX.Element {
  const initialDocument = useMemo(() => createBracketDocument(`document:${crypto.randomUUID()}`), []);
  const initialProject = useMemo(() => createWorkbenchProject(`project:${crypto.randomUUID()}`), []);
  const [document, setDocument] = useState<CadDocument>(initialDocument);
  const documentRef = useRef(document);
  const [project, setProject] = useState<WorkbenchProject>(initialProject);
  const projectRef = useRef(project);
  const projectHistoryRef = useRef<WorkbenchProject[]>([initialProject]);
  const projectHistoryIndexRef = useRef(0);
  const [projectUndoDepth, setProjectUndoDepth] = useState(0);
  const [projectRedoDepth, setProjectRedoDepth] = useState(0);
  // Chronological undo/redo timeline across the two lanes (qualified-part worker + broad-project).
  // Each committed edit appends its lane; a single Undo/Redo acts on the most-recent edit regardless
  // of lane, so order — not a fixed worker-first priority — decides what is reverted.
  const laneTimelineRef = useRef<("qualified-part" | "broad-project")[]>([]);
  const laneTimelineIndexRef = useRef(0);
  const [laneTimelineIndex, setLaneTimelineIndex] = useState(0);
  const [laneTimelineLength, setLaneTimelineLength] = useState(0);
  const workerNavigatingRef = useRef(false);
  const prevWorkerUndoDepthRef = useRef(0);
  // Serializes worker-lane history moves: the worker round-trip is async, so a second Undo must not
  // be dispatched (nor the timeline index advanced) until the first resolves.
  const workerHistoryBusyRef = useRef(false);
  const [model, setModel] = useState<ModelSuccessResponse>();
  const modelRef = useRef<ModelSuccessResponse | undefined>(undefined);
  const [status, setStatus] = useState<"starting" | "ready" | "working" | "error">("starting");
  const [statusText, setStatusText] = useState("Starting the isolated geometry engine…");
  const [diagnostic, setDiagnostic] = useState<UiDiagnostic>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedFace, setSelectedFace] = useState<{ readonly bodyId: string; readonly faceIndex: number } | null>(null);
  const [treeRevealRequest, setTreeRevealRequest] = useState(0);
  const [sketchOptionsRevealRequest, setSketchOptionsRevealRequest] = useState(0);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [automateRemoteReveal, setAutomateRemoteReveal] = useState(0);
  // The project revision last written to (or read from) a file; the project is dirty while the live revision differs.
  const savedRevisionRef = useRef(initialProject.revision);
  const [savedRevision, setSavedRevision] = useState(initialProject.revision);
  const markProjectSaved = (revision: number): void => { savedRevisionRef.current = revision; setSavedRevision(revision); };
  const [exchangeOpen, setExchangeOpen] = useState(false);
  const [designHealthOpen, setDesignHealthOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [newDialogOpen, setNewDialogOpen] = useState(false);
  const [sketchPlaneDialogOpen, setSketchPlaneDialogOpen] = useState(false);
  /** "set" moves the working sketch to a plane; "new" finishes it and starts another on the chosen plane. */
  const [sketchPlaneDialogMode, setSketchPlaneDialogMode] = useState<"set" | "new">("set");
  const [featureEdit, setFeatureEdit] = useState<DesignSolidFeature | undefined>(undefined);
  const [sketchFitSerial, setSketchFitSerial] = useState(0);
  const [masterCartOpen, setMasterCartOpen] = useState(false);
  const [renderStudioOpen, setRenderStudioOpen] = useState(false);
  const [renderSettings, setRenderSettings] = useState<RenderStudioSettings>(DEFAULT_RENDER_SETTINGS);
  const [renderGallery, setRenderGallery] = useState<readonly RenderGalleryEntry[]>([]);
  const [renderBusy, setRenderBusy] = useState(false);
  const [saveDialogMode, setSaveDialogMode] = useState<"save-as" | "copy">();
  const [fileWorkspaceStatus, setFileWorkspaceStatus] = useState<PsCadWorkspaceStatus>(DEFAULT_FILE_WORKSPACE_STATUS);
  const [recentProjects, setRecentProjects] = useState<readonly RecentProjectEntry[]>([]);
  const [electromechanicalReviewOpen, setElectromechanicalReviewOpen] = useState(false);
  const [electromechanicalAcknowledged, setElectromechanicalAcknowledged] = useState(false);
  const [pendingAssemblyTemplate, setPendingAssemblyTemplate] = useState<ReplaceableAssemblyTemplate>();
  const [pendingElectricalTemplate, setPendingElectricalTemplate] = useState<ElectricalTemplateId>();
  const [pendingVehicleTemplate, setPendingVehicleTemplate] = useState<VehicleTemplateId>();
  const [exchangeBusy, setExchangeBusy] = useState(false);
  const [exchangeFeedback, setExchangeFeedback] = useState("Ready for a bounded local exchange operation.");
  const [activeImport, setActiveImport] = useState<ExchangeImportResult>();
  const activeImportRef = useRef<ExchangeImportResult | undefined>(undefined);
  const [sketchTool, setSketchTool] = useState<SketchTool>("select");
  const [sketchCancelVersion, setSketchCancelVersion] = useState(0);
  const [combineRequest, setCombineRequest] = useState<{ readonly targetId: string | undefined; readonly mode: BooleanMode } | null>(null);
  const [sketchEditTool, setSketchEditTool] = useState<SketchEditToolId | null>(null);
  const zebraRef = useRef<{ readonly axis: "x" | "y" | "z"; readonly frequency: number } | null>(null);
  const [zebra, setZebraState] = useState<{ readonly axis: "x" | "y" | "z"; readonly frequency: number } | null>(null);
  const [sketchShowMovable, setSketchShowMovable] = useState(false);
  const [sketchCheckOpen, setSketchCheckOpen] = useState(false);
  const [sketchRequest, setSketchRequest] = useState<{ readonly command: "fix-curve" | "relax-relations" | "relax-dimensions"; readonly serial: number } | null>(null);
  const [sketchDimensionMode, setSketchDimensionMode] = useState(false);
  const [viewportState, setViewportState] = useState<ViewportViewState>(DEFAULT_VIEWPORT_STATE);
  const [measurePoints, setMeasurePoints] = useState<readonly ViewportMeasurePoint[]>([]);
  const [assemblyExplodePreviewMm, setAssemblyExplodePreviewMm] = useState<number | null>(null);
  const assemblyExplodeRef = useRef(initialProject.assembly.explodeMm);
  const [contextMenu, setContextMenu] = useState<OpenContextMenu>();
  const clientRef = useRef<GeometryWorkerClient | undefined>(undefined);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraCursorRef = useRef<HTMLDivElement>(null);
  const historyActionRef = useRef<{ undo: () => void; redo: () => void }>({ undo: () => undefined, redo: () => undefined });
  const fitViewportRef = useRef<() => void>(() => undefined);
  const viewportRef = useRef<ThreeViewportAdapter | undefined>(undefined);
  /** Set while a command waits for the user to click something in the viewport; called with the click, or null when cancelled. */
  const pickRef = useRef<((point: ViewportMeasurePoint | null) => void) | null>(null);
  const renderCanvasRef = useRef<HTMLCanvasElement>(null);
  const renderViewportRef = useRef<ThreeViewportAdapter | undefined>(undefined);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const nativeInputRef = useRef<HTMLInputElement>(null);
  const engineeringDialogRef = useRef<HTMLElement>(null);
  const projectTransitionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const projectPersistenceQueueRef = useRef<Promise<void>>(Promise.resolve());

  const assemblyExplodeMaxMm = useMemo(() => assemblyExplodeLimitMm(project.assembly), [project.assembly]);
  const displayedAssembly = useMemo(() => assemblyExplodePreviewMm === null
    ? project.assembly
    : { ...project.assembly, explodeMm: assemblyExplodePreviewMm }, [assemblyExplodePreviewMm, project.assembly]);
  const assemblyExplodePercent = Math.round(Math.min(100, displayedAssembly.explodeMm / assemblyExplodeMaxMm * 100));
  const assemblyScene = useMemo(() => buildAssemblyPreview(displayedAssembly), [displayedAssembly]);
  const partScene = useMemo(() => buildPartPreview(project.part), [project.part]);
  const interferences = useMemo(() => findAssemblyInterference(displayedAssembly), [displayedAssembly]);
  const surfacePreview = useMemo(() => buildSurfacePreview(project.surface), [project.surface]);
  const drawing = useMemo(() => createDrawingSvg(project.part, project.drawing), [project.part, project.drawing]);
  const electrical = useMemo(() => createElectricalSchematic(project.electrical), [project.electrical]);
  const vehiclePreview = useMemo(() => buildVehiclePreview(project.vehicle), [project.vehicle]);
  const designHealth = useMemo(() => buildDesignHealthReport(project), [project]);
  // The planar faces of the shown solids, as sketch planes: the "sketch on a face" choices in the plane dialog.
  /** The part's angle construction planes, offered in the sketch plane dialog as ready-made tilted planes. */
  const anglePlaneOptions = useMemo(() => (project.part.construction ?? []).flatMap((plane) => plane.definition.kind === "angle"
    ? [{ plane: plane.definition.basePlane.replace("datum:", "") as SketchPlane, tilt: { axis: plane.definition.axis, angleDeg: plane.definition.angleDeg }, label: plane.name }]
    : []), [project.part.construction]);
  /** The part's three-point construction planes, offered in the sketch plane dialog as ready-made sketch planes. */
  const framePlaneOptions = useMemo(() => (project.part.construction ?? []).flatMap((plane) => {
    if (plane.definition.kind !== "three-points") return [];
    const frame = frameThroughPoints(plane.definition.points);
    return "error" in frame ? [] : [{ frame, label: plane.name }];
  }), [project.part.construction]);
  const sketchFaceOptions = useMemo(() => {
    const options: SketchFaceOption[] = [];
    for (const body of project.part.generalBodies ?? []) {
      if (!body.visible) continue;
      for (const face of axisAlignedPlanarFaces(body.positionsMm, body.indices, 25).slice(0, 4)) {
        options.push({
          plane: planeKeyOf(face.plane),
          offsetMm: face.offsetMm,
          label: `${body.name} · ${face.axisName} = ${Number(face.coordinateMm.toFixed(3))} mm`,
          hint: `${sketchPlaneName(face.plane)}-parallel face · ${Math.round(face.areaMm2).toLocaleString()} mm² · looks ${face.outwardPositive ? "+" : "−"}${face.axisName}`
        });
      }
    }
    return options.slice(0, 9);
  }, [project.part.generalBodies]);
  const electromechanicalCandidate = useMemo(() => electromechanicalReviewOpen
    ? createElectromechanicalAssembly(
      project.electrical,
      preferredElectromechanicalLayout(project.electrical),
      defaultElectromechanicalMappings(project.electrical),
      project.revision,
      electrical.routing
    )
    : { ok: false as const, diagnostics: [] }, [electrical.routing, electromechanicalReviewOpen, project.electrical, project.revision]);

  const persistBroadProject = useCallback((next: WorkbenchProject): Promise<void> => {
    const queued = projectPersistenceQueueRef.current.then(() => saveWorkbenchProject(next));
    projectPersistenceQueueRef.current = queued.catch(() => undefined);
    return queued;
  }, []);

  const syncTimelineState = useCallback((): void => {
    setLaneTimelineIndex(laneTimelineIndexRef.current);
    setLaneTimelineLength(laneTimelineRef.current.length);
  }, []);

  const recordLane = useCallback((lane: "qualified-part" | "broad-project"): void => {
    const log = laneTimelineRef.current.slice(0, laneTimelineIndexRef.current);
    log.push(lane);
    laneTimelineRef.current = log;
    laneTimelineIndexRef.current = log.length;
    syncTimelineState();
  }, [syncTimelineState]);

  const pushProject = useCallback((next: WorkbenchProject, persist = true): void => {
    const history = projectHistoryRef.current.slice(0, projectHistoryIndexRef.current + 1);
    history.push(next);
    projectHistoryRef.current = history;
    projectHistoryIndexRef.current = history.length - 1;
    setProjectUndoDepth(history.length - 1);
    setProjectRedoDepth(0);
    projectRef.current = next;
    setProject(next);
    recordLane("broad-project");
    if (persist) void persistBroadProject(next).catch((error: unknown) => {
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : "The broad project could not be persisted.");
    });
  }, [persistBroadProject, recordLane]);

  const resetProject = useCallback((next: WorkbenchProject): void => {
    projectHistoryRef.current = [next];
    projectHistoryIndexRef.current = 0;
    setProjectUndoDepth(0);
    setProjectRedoDepth(0);
    laneTimelineRef.current = [];
    laneTimelineIndexRef.current = 0;
    prevWorkerUndoDepthRef.current = 0;
    syncTimelineState();
    projectRef.current = next;
    setProject(next);
    // A freshly created, opened or recovered project starts clean: dirtiness counts from here.
    markProjectSaved(next.revision);
  }, [syncTimelineState]);

  const queueProjectTransition = useCallback((transition: () => Promise<void>): Promise<void> => {
    const queued = projectTransitionQueueRef.current.then(transition);
    projectTransitionQueueRef.current = queued.catch(() => undefined);
    return queued;
  }, []);

  const refreshFileWorkspace = useCallback(async (): Promise<void> => {
    const [workspace, recent] = await Promise.all([getPsCadWorkspaceStatus(), listRecentProjects()]);
    setFileWorkspaceStatus(workspace);
    setRecentProjects(recent);
  }, []);

  const applyProjectOperation = useCallback((intent: OperationIntent, announce = true): boolean => {
    const current = projectRef.current;
    const operation = { ...intent, operationId: `operation:ui-${crypto.randomUUID()}`, expectedRevision: current.revision } as WorkbenchOperation;
    const applied = applyWorkbenchOperation(current, operation);
    if (!applied.ok) {
      const first = applied.diagnostics[0];
      setDiagnostic(first === undefined ? undefined : { code: first.code, message: first.message, recovery: first.recovery });
      setStatus("error");
      setStatusText(first?.message ?? "The project operation was rejected.");
      return false;
    }
    pushProject(applied.value.project);
    setDiagnostic(undefined);
    if (announce) {
      setStatus("ready");
      setStatusText(applied.value.summary);
    }
    return true;
  }, [pushProject]);

  const previewAssemblyExplode = useCallback((valueMm: number): void => {
    const bounded = Math.round(Math.min(assemblyExplodeMaxMm, Math.max(0, Number.isFinite(valueMm) ? valueMm : 0)) * 10) / 10;
    assemblyExplodeRef.current = bounded;
    setAssemblyExplodePreviewMm(bounded);
  }, [assemblyExplodeMaxMm]);

  const commitAssemblyExplode = useCallback((valueMm = assemblyExplodeRef.current): void => {
    const bounded = Math.round(Math.min(assemblyExplodeMaxMm, Math.max(0, Number.isFinite(valueMm) ? valueMm : 0)) * 10) / 10;
    assemblyExplodeRef.current = bounded;
    setAssemblyExplodePreviewMm(null);
    if (Math.abs(projectRef.current.assembly.explodeMm - bounded) <= 0.05) return;
    applyProjectOperation({ kind: "set-assembly-explode", valueMm: bounded });
  }, [applyProjectOperation, assemblyExplodeMaxMm]);

  const updateCameraCursor = useCallback((cursor: CameraCursorState): void => {
    const element = cameraCursorRef.current;
    if (element === null) return;
    element.hidden = !cursor.visible;
    element.style.setProperty("--camera-cursor-x", `${Math.min(100, Math.max(0, cursor.x * 100)).toFixed(2)}%`);
    element.style.setProperty("--camera-cursor-y", `${Math.min(100, Math.max(0, cursor.y * 100)).toFixed(2)}%`);
    element.classList.toggle("pinching", cursor.pinching);
  }, []);

  useEffect(() => {
    assemblyExplodeRef.current = project.assembly.explodeMm;
    setAssemblyExplodePreviewMm(null);
  }, [project.id, project.assembly.explodeMm]);

  // Mirror the worker's qualified parameters into the CURRENT broad-project slot in place, without
  // pushing a new broad-history entry. The worker owns its own undo history for these params, so a
  // worker edit must not also create a separate broad-lane undo step (which desynced the two lanes).
  const replaceQualifiedParams = useCallback((values: readonly [PartParameter, number][]): void => {
    let project = projectRef.current;
    let changedAny = false;
    for (const [parameter, value] of values) {
      if (Math.abs(project.part[parameter] - value) <= 1e-9) continue;
      const operation = { kind: "set-part-parameter", parameter, value, operationId: `operation:worker-sync-${crypto.randomUUID()}`, expectedRevision: project.revision } as WorkbenchOperation;
      const applied = applyWorkbenchOperation(project, operation);
      if (applied.ok) { project = applied.value.project; changedAny = true; }
    }
    if (!changedAny) return;
    projectRef.current = project;
    setProject(project);
    projectHistoryRef.current[projectHistoryIndexRef.current] = project;
    void persistBroadProject(project).catch(() => undefined);
  }, [persistBroadProject]);

  const acceptModel = useCallback((response: ModelSuccessResponse): void => {
    setModel(response);
    modelRef.current = response;
    setDocument(response.document);
    documentRef.current = response.document;
    setUndoDepth(response.history.undoDepth);
    setRedoDepth(response.history.redoDepth);
    const values: readonly [PartParameter, number][] = [
      ["widthMm", parameterByKey(response.document, "width").valueMeters * 1000],
      ["heightMm", parameterByKey(response.document, "height").valueMeters * 1000],
      ["thicknessMm", parameterByKey(response.document, "thickness").valueMeters * 1000],
      ["holeDiameterMm", parameterByKey(response.document, "holeDiameter").valueMeters * 1000]
    ];
    replaceQualifiedParams(values);
    // A genuine new worker edit (not undo/redo navigation, not bootstrap/load) advances the worker's
    // own undo depth; record one chronological marker per such advance so the shared Undo stays in step.
    if (!workerNavigatingRef.current && response.history.undoDepth > prevWorkerUndoDepthRef.current) recordLane("qualified-part");
    prevWorkerUndoDepthRef.current = response.history.undoDepth;
    setDiagnostic(undefined);
    setStatus("ready");
    setStatusText(response.recoveredFromLocal ? `Recovered qualified solid revision ${response.currentRevision}.` : `Qualified solid revision ${response.currentRevision} validated.`);
  }, [replaceQualifiedParams, recordLane]);

  const acceptResponse = useCallback((response: WorkerResponse): boolean => {
    if (response.status === "error") {
      const first = response.diagnostics[0];
      setDiagnostic(first);
      setStatus("error");
      setStatusText(first?.message ?? "Geometry operation failed.");
      return false;
    }
    if (response.kind === "model") acceptModel(response);
    return true;
  }, [acceptModel]);

  const restoreAfterFailure = useCallback((message: string): void => {
    setStatus("error");
    setStatusText(message);
    setDiagnostic({ code: "WORKER_FAILURE", message, recovery: "The worker is restarting from the last committed document." });
    const client = clientRef.current;
    if (client === undefined) return;
    void client.bootstrap(documentRef.current, true, modelRef.current?.evidence ?? null).then(async (response) => {
      workerNavigatingRef.current = true;
      try {
        if (response.status === "error" && response.diagnostics[0]?.code === "PERSISTENCE_FAILURE") acceptResponse(await client.bootstrap(documentRef.current, false, modelRef.current?.evidence ?? null));
        else acceptResponse(response);
      } finally { workerNavigatingRef.current = false; }
    }).catch(() => undefined);
  }, [acceptResponse]);

  useEffect(() => {
    const client = new GeometryWorkerClient(restoreAfterFailure);
    clientRef.current = client;
    void (async () => {
      const stored = await loadWorkbenchProject().catch(() => undefined);
      const authoritativeProject = stored ?? initialProject;
      if (stored === undefined) await persistBroadProject(initialProject).catch(() => undefined);
      const fallbackDocument = createQualifiedPartDocument(authoritativeProject, initialDocument.id, initialDocument.displayUnit);
      const response = await client.bootstrap(fallbackDocument, false, null);
      if (clientRef.current !== client) return;
      resetProject(authoritativeProject);
      workerNavigatingRef.current = true;
      try { acceptResponse(response); }
      finally { workerNavigatingRef.current = false; }
      if (stored !== undefined && response.status !== "error") setStatusText(`Recovered synchronized workbench project revision ${stored.revision}.`);
    })().catch((error: unknown) => {
      if (clientRef.current !== client) return;
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : "The synchronized project could not be started.");
    });
    return () => {
      const active = clientRef.current;
      active?.dispose();
      if (active !== client) client.dispose();
      clientRef.current = undefined;
    };
  }, [acceptResponse, initialDocument, initialProject, persistBroadProject, resetProject, restoreAfterFailure]);

  useEffect(() => () => {
    const imported = activeImportRef.current;
    imported?.releaseResources();
    if (imported !== undefined) disposeExchangeObject(imported.object);
  }, []);

  useEffect(() => {
    void preparePsCadLocalStorage()
      .then(refreshFileWorkspace)
      .catch(() => setStatusText("Browser-private recovery storage is unavailable; standard file downloads remain available."));
  }, [refreshFileWorkspace]);

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!exchangeOpen && !electromechanicalReviewOpen && pendingAssemblyTemplate === undefined && pendingElectricalTemplate === undefined && pendingVehicleTemplate === undefined && globalThis.document.querySelector('[role="dialog"][aria-modal="true"]') === null) setPaletteOpen(true);
      }
      if (event.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [electromechanicalReviewOpen, exchangeOpen, pendingAssemblyTemplate, pendingElectricalTemplate, pendingVehicleTemplate]);

  useEffect(() => {
    if (!electromechanicalReviewOpen && pendingAssemblyTemplate === undefined && pendingElectricalTemplate === undefined && pendingVehicleTemplate === undefined) return;
    const dialog = engineeringDialogRef.current;
    if (dialog === null) return;
    const returnFocus = globalThis.document.activeElement instanceof HTMLElement && globalThis.document.activeElement !== globalThis.document.body ? globalThis.document.activeElement : null;
    const focusable = (): HTMLElement[] => [...dialog.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
    const initial = dialog.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? focusable()[0] ?? dialog;
    const frame = window.requestAnimationFrame(() => { dialog.scrollTop = 0; initial.focus({ preventScroll: true }); });
    const listener = (event: KeyboardEvent): void => {
      event.stopPropagation();
      if (event.key === "Escape") {
        event.preventDefault();
        if (pendingElectricalTemplate !== undefined) setStatusText("Schematic replacement cancelled; the current devices and nets were preserved.");
        if (pendingVehicleTemplate !== undefined) setStatusText("Vehicle replacement cancelled; the current topology and inputs were preserved.");
        setElectromechanicalReviewOpen(false);
        setElectromechanicalAcknowledged(false);
        setPendingAssemblyTemplate(undefined);
        setPendingElectricalTemplate(undefined);
        setPendingVehicleTemplate(undefined);
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) { event.preventDefault(); dialog.focus(); return; }
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && globalThis.document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && globalThis.document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    globalThis.document.addEventListener("keydown", listener, true);
    return () => {
      window.cancelAnimationFrame(frame);
      globalThis.document.removeEventListener("keydown", listener, true);
      queueMicrotask(() => {
        if (globalThis.document.querySelector('[role="dialog"]') !== null) return;
        const fallback = globalThis.document.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? globalThis.document.querySelector<HTMLElement>(".project-button");
        if (returnFocus?.isConnected) returnFocus.focus();
        else fallback?.focus();
      });
    };
  }, [electromechanicalReviewOpen, pendingAssemblyTemplate, pendingElectricalTemplate, pendingVehicleTemplate]);

  const isThreeDimensional = !renderStudioOpen && (project.activeWorkspace === "part" || project.activeWorkspace === "assembly" || project.activeWorkspace === "surface" || project.activeWorkspace === "vehicle");
  const acceptMeasurePoint = useCallback((point: ViewportMeasurePoint): void => {
    if (pickRef.current !== null) { pickRef.current(point); return; }
    setMeasurePoints((current) => current.length >= 2 ? [point] : [...current, point]);
  }, []);
  const openContextMenu = useCallback((clientX: number, clientY: number, selectionId: string | null, selectionKind?: WorkbenchSelectionKind): void => {
    if (selectionId !== null) setSelectedId(selectionId);
    setContextMenu({ x: clientX, y: clientY, selectionId, selectionKind: selectionKind ?? classifyWorkbenchSelection(selectionId) });
  }, []);
  useEffect(() => {
    if (masterCartOpen || !isThreeDimensional || canvasRef.current === null) return;
    const viewport = new ThreeViewportAdapter(canvasRef.current, {
      onSelectBody: setSelectedId,
      onViewChange: setViewportState,
      onMeasurePoint: acceptMeasurePoint,
      onContextMenu: (request) => openContextMenu(request.clientX, request.clientY, request.semanticId, (request.selectionKind === "body" || request.selectionKind === "component") && request.selectionKind === classifyWorkbenchSelection(request.semanticId) ? request.selectionKind : undefined),
      ...(project.activeWorkspace === "assembly" ? { assemblyTouchGestures: {
        getExplodeMm: () => assemblyExplodeRef.current,
        onExplodePreview: previewAssemblyExplode,
        onExplodeCommit: commitAssemblyExplode,
        maxExplodeMm: assemblyExplodeMaxMm
      } } : {})
    });
    viewport.restoreViewState(viewportState);
    viewportRef.current = viewport;
    if (zebraRef.current !== null) viewport.setZebra(zebraRef.current);
    return () => { viewport.dispose(); viewportRef.current = undefined; };
  }, [acceptMeasurePoint, assemblyExplodeMaxMm, commitAssemblyExplode, isThreeDimensional, masterCartOpen, openContextMenu, previewAssemblyExplode, project.activeWorkspace]);

  useEffect(() => {
    setMeasurePoints((current) => current.length === 0 ? current : []);
    const viewport = viewportRef.current;
    if (viewport === undefined) return;
    if (project.activeWorkspace === "part" && activeImport !== undefined) viewport.setExternalObject(activeImport.object);
    else if (project.activeWorkspace === "part" && model !== undefined) { viewport.setArtifactWithScene(model.render, partScene); viewport.fitPreview(partScene.boundsMm); }
    if (project.activeWorkspace === "assembly") viewport.setScene(assemblyScene);
    if (project.activeWorkspace === "surface") viewport.setScene(surfacePreview.scene);
    if (project.activeWorkspace === "vehicle") viewport.setScene(vehiclePreview.scene);
  }, [activeImport, assemblyScene, model, partScene, project.activeWorkspace, surfacePreview.scene, vehiclePreview.scene]);
  useEffect(() => viewportRef.current?.setSelectedId(selectedId), [selectedId]);
  // Escape ends a viewport pick that is waiting for a click.
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || pickRef.current === null) return;
      pickRef.current(null);
      setStatusText("Pick cancelled.");
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  // A face highlight belongs to its body; drop it whenever the body selection changes.
  useEffect(() => { setSelectedFace((current) => (current === null || current.bodyId === selectedId ? current : null)); }, [selectedId]);
  useEffect(() => { viewportRef.current?.setHighlightedFace(selectedFace?.bodyId ?? null, selectedFace?.faceIndex ?? null); }, [selectedFace]);
  useEffect(() => viewportRef.current?.setMeasurePoints(measurePoints.map((point) => point.pointMm)), [measurePoints]);

  useEffect(() => {
    if (!renderStudioOpen || renderCanvasRef.current === null) return;
    const viewport = new ThreeViewportAdapter(renderCanvasRef.current, { onSelectBody: () => undefined });
    viewport.restoreViewState({
      ...DEFAULT_VIEWPORT_STATE,
      navigationMode: "orbit",
      gridVisible: false,
      axesVisible: false,
      projection: renderSettings.projection,
      orientation: renderSettings.orientation,
      azimuthDeg: viewAnglesForOrientation(renderSettings.orientation)[0],
      elevationDeg: viewAnglesForOrientation(renderSettings.orientation)[1]
    });
    renderViewportRef.current = viewport;
    return () => { viewport.dispose(); renderViewportRef.current = undefined; };
  }, [renderStudioOpen]);

  useEffect(() => {
    const viewport = renderViewportRef.current;
    if (viewport === undefined) return;
    if (renderSettings.source === "part" && activeImport !== undefined) viewport.setExternalObject(activeImport.object);
    else if (renderSettings.source === "part" && model !== undefined) { viewport.setArtifactWithScene(model.render, partScene); viewport.fitPreview(partScene.boundsMm); }
    else if (renderSettings.source === "part") viewport.setScene(partScene);
    if (renderSettings.source === "assembly") viewport.setScene(assemblyScene);
    if (renderSettings.source === "surface") viewport.setScene(surfacePreview.scene);
    if (renderSettings.source === "vehicle") viewport.setScene(vehiclePreview.scene);
  }, [activeImport, assemblyScene, model, partScene, renderSettings.source, renderStudioOpen, surfacePreview.scene, vehiclePreview.scene]);

  useEffect(() => {
    const viewport = renderViewportRef.current;
    if (viewport === undefined) return;
    viewport.setStudioEnvironment(renderSettings.environment);
    viewport.setStudioMaterial({
      color: renderSettings.bodyColor,
      roughness: renderSettings.roughness,
      metalness: renderSettings.metalness,
      useSourceColors: renderSettings.materialPreset === "original"
    });
    viewport.setStudioLighting({
      exposure: renderSettings.exposure,
      keyIntensity: renderSettings.keyIntensity,
      fillIntensity: renderSettings.fillIntensity,
      rimIntensity: renderSettings.rimIntensity
    });
    viewport.setStudioGroundVisible(renderSettings.groundVisible);
  }, [renderSettings, renderStudioOpen, activeImport, model, partScene, assemblyScene, surfacePreview.scene, vehiclePreview.scene]);

  useEffect(() => {
    const viewport = renderViewportRef.current;
    if (viewport === undefined) return;
    viewport.setProjection(renderSettings.projection);
    viewport.setOrientation(renderSettings.orientation);
  }, [renderSettings.projection, renderSettings.orientation]);

  const switchWorkspace = (workspace: WorkspaceId): void => {
    setMasterCartOpen(false);
    setRenderStudioOpen(false);
    const current = projectRef.current;
    if (workspace === current.activeWorkspace) return;
    setContextMenu(undefined);
    setSelectedId(null);
    setMeasurePoints([]);
    setViewportState((currentState) => {
      const filter = currentState.selectionFilter;
      const sketchFilterInvalid = workspace !== "sketch" && (filter === "sketch-curve" || filter === "profile" || filter === "connected" || filter === "tangent");
      const componentFilterInvalid = workspace === "part" && filter === "component";
      const bodyFilterInvalid = (workspace === "assembly" || workspace === "surface" || workspace === "vehicle") && filter === "body";
      return sketchFilterInvalid || componentFilterInvalid || bodyFilterInvalid ? { ...currentState, selectionFilter: "auto" } : currentState;
    });
    const next = { ...current, activeWorkspace: workspace };
    projectRef.current = next;
    setProject(next);
    projectHistoryRef.current[projectHistoryIndexRef.current] = next;
    void persistBroadProject(next).catch(() => undefined);
    setStatus("ready");
    setStatusText(`Opened ${workspace === "automate" ? "Automate" : `${workspace[0]!.toUpperCase()}${workspace.slice(1)}`} workspace without changing engineering revision ${current.revision}.`);
  };

  // Fusion-style sketch entry: starting a sketch that has no geometry yet asks which datum plane to use.
  // A sketch that already has curves simply opens on its saved plane; the palette "Plane" button changes it.
  const requestWorkspace = (workspace: WorkspaceId): void => {
    if (workspace === "sketch" && projectRef.current.activeWorkspace !== "sketch" && !masterCartOpen && !renderStudioOpen && projectRef.current.sketch.entities.length === 0) {
      setSketchPlaneDialogOpen(true);
      return;
    }
    switchWorkspace(workspace);
  };

  const confirmSketchPlane = (plane: SketchPlane, offsetMm = 0, tilt?: SketchPlaneTilt, frame?: SketchPlaneFrame): void => {
    setSketchPlaneDialogOpen(false);
    const datum = `datum:${plane}` as const;
    const where = frame !== undefined ? "plane through three points"
      : `${plane.toUpperCase()} plane${offsetMm === 0 ? "" : ` offset ${offsetMm} mm`}${tilt === undefined ? "" : ` tilted ${tilt.angleDeg}° about ${tilt.axis.toUpperCase()}`}`;
    const placement = { ...(offsetMm === 0 ? {} : { offsetMm }), ...(tilt === undefined ? {} : { tilt }), ...(frame === undefined ? {} : { frame }) };
    if (sketchPlaneDialogMode === "new") {
      void (async () => {
        await commitWorkingSketch();
        if (applyProjectOperation({ kind: "new-design-sketch", plane: datum, ...placement }, false)) setStatusText(`New sketch on the ${where}. The previous sketch is in the timeline.`);
      })();
      return;
    }
    const sketch = projectRef.current.sketch;
    const sameTilt = (sketch.planeTilt?.axis ?? null) === (tilt?.axis ?? null) && (sketch.planeTilt?.angleDeg ?? 0) === (tilt?.angleDeg ?? 0);
    const sameFrame = JSON.stringify(sketch.planeFrame ?? null) === JSON.stringify(frame ?? null);
    if ((sketch.plane !== datum || (sketch.planeOffsetMm ?? 0) !== offsetMm || !sameTilt || !sameFrame)
      && !applyProjectOperation({ kind: "set-sketch-plane", plane: datum, ...placement })) return;
    if (projectRef.current.activeWorkspace !== "sketch") switchWorkspace("sketch");
    setStatusText(`Sketch on the ${where}, shown face-on. Draw a closed profile, then Create solid extrudes or revolves it from this plane.`);
  };

  const openMasterCart = (): void => {
    if (projectRef.current.activeWorkspace !== "assembly") switchWorkspace("assembly");
    setRenderStudioOpen(false);
    setMasterCartOpen(true);
    setSelectedId(null);
    setMeasurePoints([]);
    setStatus("ready");
    setStatusText("Opened PS3D Master Cart with original parametric component templates and supplier category references.");
  };

  const openRenderStudio = (): void => {
    setMasterCartOpen(false);
    setRenderStudioOpen(true);
    setContextMenu(undefined);
    setSelectedId(null);
    setMeasurePoints([]);
    setStatus("ready");
    setStatusText("Opened Render Studio with a linked, non-destructive scene for materials, lighting, cameras, and raster output.");
  };

  const createPartPreviewBody = (shape: PartPreviewBodyShape): void => {
    const current = projectRef.current;
    const ordinal = (current.part.previewBodies?.length ?? 0) + 1;
    const sizeMm = defaultPartPreviewSize(shape);
    const body: PartPreviewBody = {
      id: `part-body:user-${crypto.randomUUID()}`,
      name: `${partPreviewShapeLabel(shape)} ${ordinal}`,
      shape,
      visible: true,
      color: partPreviewColor(shape),
      translationMm: [current.part.widthMm / 2 + 28 + ((ordinal - 1) % 4) * 38, (Math.floor((ordinal - 1) / 4) - 0.5) * 34, sizeMm[2] / 2],
      rotationDeg: [0, 0, 0],
      sizeMm
    };
    if (applyProjectOperation({ kind: "add-part-preview-bodies", bodies: [body] })) setSelectedId(body.id);
  };

  const runSelectedPartPreviewAction = (operation: Extract<CadCommandRecord["action"], { kind: "selected-part-preview-body-action" }>["operation"], commandName: string): void => {
    const current = projectRef.current;
    const body = (current.part.previewBodies ?? []).find((candidate) => candidate.id === selectedId);
    if (body === undefined) {
      setStatus("ready");
      setStatusText(`Select an independent preview body in the viewport or Bodies tree before running ${commandName}.`);
      return;
    }
    if (operation === "edit-transform" || operation === "edit-size" || operation === "edit-appearance") {
      setSelectedId(body.id);
      setStatusText(`${commandName}: edit ${body.name} in the Preview body controls at right.`);
      return;
    }
    if (operation === "delete") {
      if (applyProjectOperation({ kind: "delete-part-preview-body", bodyId: body.id })) setSelectedId(null);
      return;
    }
    if (operation === "toggle-visible") {
      applyProjectOperation({ kind: "toggle-part-preview-body-visibility", bodyId: body.id });
      return;
    }
    if (operation === "isolate") {
      applyProjectOperation({ kind: "isolate-part-preview-body", bodyId: body.id });
      return;
    }
    const copies: PartPreviewBody[] = [];
    if (operation === "duplicate") copies.push(clonePartPreviewBody(body, "Copy", [Math.max(body.sizeMm[0], 15) * 1.3, 0, 0]));
    if (operation === "mirror-x") copies.push({
      ...clonePartPreviewBody(body, "Mirror", [0, 0, 0]),
      translationMm: [-body.translationMm[0], body.translationMm[1], body.translationMm[2]],
      rotationDeg: [body.rotationDeg[0], -body.rotationDeg[1], -body.rotationDeg[2]]
    });
    if (operation === "pattern-x") {
      const pitch = Math.max(body.sizeMm[0], 15) * 1.35;
      copies.push(clonePartPreviewBody(body, "Pattern 2", [pitch, 0, 0]), clonePartPreviewBody(body, "Pattern 3", [pitch * 2, 0, 0]));
    }
    if (operation === "bounding-block") copies.push({
      ...clonePartPreviewBody(body, "Bounding body", [0, 0, 0]),
      shape: "block",
      color: "#b6c2ca",
      rotationDeg: [0, 0, 0],
      sizeMm: orientedPreviewEnvelope(body)
    });
    if (copies.length > 0 && applyProjectOperation({ kind: "add-part-preview-bodies", bodies: copies })) setSelectedId(copies.at(-1)!.id);
  };

  const applyCombine = async (choice: CombineChoice): Promise<string | undefined> => {
    const bodies = projectRef.current.part.generalBodies ?? [];
    const target = bodies.find((body) => body.id === choice.targetId);
    const tool = bodies.find((body) => body.id === choice.toolId);
    if (target === undefined || tool === undefined) return "Choose two existing bodies.";
    const label = choice.mode === "join" ? "Join" : choice.mode === "cut" ? "Cut" : "Intersect";
    const result = await combineGeneralBodies({ target, tool, mode: choice.mode, bodyId: `general-body:${crypto.randomUUID()}`, name: `${label} ${target.name}${choice.mode === "cut" ? " − " : " + "}${tool.name}`.slice(0, 120) });
    if (!result.ok) return result.message;
    if (!applyProjectOperation({ kind: "boolean-general-bodies", targetBodyId: target.id, toolBodyId: tool.id, mode: choice.mode, keepTool: choice.keepTool, body: result.body })) return "The project rejected the Boolean result.";
    setSelectedId(result.body.id);
    setCombineRequest(null);
    return undefined;
  };

  const modifierLabelOf = (modifier: "hole" | "fillet" | "chamfer" | "shell"): string => (
    modifier === "hole" ? "Hole" : modifier === "fillet" ? "Fillet" : modifier === "chamfer" ? "Chamfer" : "Shell"
  );

  /**
   * Hole Wizard: click the face where the hole should start, choose its type and fastener, and the hole is recorded as a timeline
   * step at that point, drilled straight into the face. A body that is not in the timeline gets the older whole-body version.
   */
  const handleHoleWizard = async (): Promise<void> => {
    const current = projectRef.current;
    const bodies = current.part.generalBodies ?? [];
    const body = bodies.find((candidate) => candidate.id === selectedId);
    if (body === undefined) { setStatus("ready"); setStatusText("Hole Wizard needs a general solid body selected first."); return; }
    const history = designOf(current);
    const base = baseFeatureOf(history, body.id);
    if (base === undefined) { holeWizardOnMesh(); return; }
    const picked = await requestViewportPick(`Hole Wizard: click the face of ${body.name} where the hole should start`);
    if (picked === null) return;
    if (picked.semanticId !== body.id) { setStatus("ready"); setStatusText(`Hole Wizard: click on ${body.name}.`); return; }
    if (picked.normalMm === undefined) { setStatus("ready"); setStatusText("Hole Wizard: the clicked surface has no direction to drill along."); return; }
    const ask = (label: string, defaultValue: string): string | null => typeof window === "undefined" ? defaultValue : window.prompt(label, defaultValue);
    const typeRaw = (ask("Hole type (simple, counterbore, countersink, tapped):", "counterbore") ?? "").trim().toLowerCase();
    if (typeRaw === "" ) return;
    if (!["simple", "counterbore", "countersink", "tapped"].includes(typeRaw)) { setStatus("ready"); setStatusText("Hole Wizard: enter simple, counterbore, countersink or tapped."); return; }
    const fastenerRaw = (ask("Fastener size (M3, M4, M5, M6, M8, M10):", "M6") ?? "").trim().toUpperCase();
    const spec = METRIC_FASTENERS[fastenerRaw];
    if (spec === undefined) { setStatus("ready"); setStatusText("Hole Wizard: enter M3, M4, M5, M6, M8 or M10."); return; }
    const depthRaw = ask("Hole depth from the face in mm (0 drills through everything):", "0");
    if (depthRaw === null) return;
    const depth = Number.parseFloat(depthRaw);
    if (!Number.isFinite(depth) || depth < 0) { setStatus("ready"); setStatusText("Hole Wizard: depth must be 0 (through) or a positive number."); return; }
    const round = (value: number): number => Number(value.toFixed(3));
    const normal = snapToAxis(picked.normalMm);
    const diameter = typeRaw === "tapped" ? spec.nominalDiameterMm * 0.85 : spec.clearanceDiameterMm;
    const style = typeRaw === "counterbore" ? "counterbore" : typeRaw === "countersink" ? "countersink" : "simple";
    const label = typeRaw === "tapped" ? `${fastenerRaw} tapped hole Ø${diameter.toFixed(2)}` : `${fastenerRaw} ${typeRaw} hole Ø${diameter.toFixed(2)}`;
    const feature: DesignSolidFeature = {
      id: `feature:hole-${crypto.randomUUID()}`, name: label, kind: "hole", suppressed: false,
      sketchFeatureId: base.sketchFeatureId, profileIds: [], valueMm: Math.max(0.01, diameter),
      bodyId: body.id, operation: "direct-edit",
      holeStyle: style, holePositionMm: [round(picked.pointMm[0]), round(picked.pointMm[1]), round(picked.pointMm[2])], holeNormal: normal,
      holeDiameterMm: diameter, holeDepthMm: depth,
      ...(style === "counterbore" ? { holeCounterDiameterMm: spec.counterboreDiameterMm, holeCounterDepthMm: spec.counterboreDepthMm } : {}),
      ...(style === "countersink" ? { holeSinkDiameterMm: spec.countersinkDiameterMm, holeSinkAngleDeg: 90 } : {})
    };
    void commitWithReplay({ kind: "add-design-solid", feature, body }, feature.id).then((ok) => { if (ok) { setSelectedId(body.id); setStatusText(`Added ${label} to ${body.name}, drilled along (${normal.map((value) => -Number(value.toFixed(3)) || 0).join(", ")}) from (${feature.holePositionMm?.map((value) => value.toFixed(1)).join(", ")}) mm.`); } });
  };

  const holeWizardOnMesh = (): void => {
    const current = projectRef.current;
    const bodies = current.part.generalBodies ?? [];
    const body = bodies.find((candidate) => candidate.id === selectedId);
    if (body === undefined) { setStatus("ready"); setStatusText("Hole Wizard needs a general solid body selected first."); return; }
    const ask = (label: string, defaultValue: string): string | null => typeof window === "undefined" ? defaultValue : window.prompt(label, defaultValue);
    const typeRaw = (ask("Hole type (simple, counterbore, countersink, tapped):", "counterbore") ?? "").trim().toLowerCase();
    if (!["simple", "counterbore", "countersink", "tapped"].includes(typeRaw)) { setStatus("ready"); setStatusText("Hole Wizard: enter simple, counterbore, countersink or tapped."); return; }
    const fastenerRaw = (ask("Fastener size (M3, M4, M5, M6, M8, M10):", "M6") ?? "").trim().toUpperCase();
    const spec = METRIC_FASTENERS[fastenerRaw];
    if (spec === undefined) { setStatus("ready"); setStatusText("Hole Wizard: enter M3, M4, M5, M6, M8 or M10."); return; }
    const zs = body.positionsMm.filter((_, index) => index % 3 === 2);
    const extentZ = Math.max(...zs) - Math.min(...zs);
    const defaultDepth = extentZ + 4;
    const depthRaw = ask(`Pilot depth in mm (blank = through, body extent ${extentZ.toFixed(1)} mm):`, String(extentZ + 2));
    const pilotDepth = depthRaw === null || depthRaw.trim() === "" ? defaultDepth : Number.parseFloat(depthRaw);
    if (!Number.isFinite(pilotDepth) || pilotDepth <= 0) { setStatus("ready"); setStatusText("Hole Wizard: pilot depth must be a positive number."); return; }

    const input = { positionsMm: body.positionsMm, indices: body.indices };
    let result: { readonly ok: true; readonly positionsMm: readonly number[]; readonly indices: readonly number[] } | { readonly ok: false; readonly message: string };
    let label: string;
    if (typeRaw === "simple") {
      result = meshHole(input, { diameterMm: spec.clearanceDiameterMm, depthMm: pilotDepth, axis: "z" });
      label = `${fastenerRaw} clearance hole Ø ${spec.clearanceDiameterMm.toFixed(2)} mm`;
    } else if (typeRaw === "counterbore") {
      result = meshCounterbore(input, { pilotDiameterMm: spec.clearanceDiameterMm, pilotDepthMm: pilotDepth, headDiameterMm: spec.counterboreDiameterMm, headDepthMm: spec.counterboreDepthMm, axis: "z" });
      label = `${fastenerRaw} counterbore (pilot Ø ${spec.clearanceDiameterMm}, head Ø ${spec.counterboreDiameterMm} × ${spec.counterboreDepthMm} mm)`;
    } else if (typeRaw === "countersink") {
      result = meshCountersink(input, { pilotDiameterMm: spec.clearanceDiameterMm, pilotDepthMm: pilotDepth, headDiameterMm: spec.countersinkDiameterMm, headAngleDeg: 90, axis: "z" });
      label = `${fastenerRaw} countersink (pilot Ø ${spec.clearanceDiameterMm}, head Ø ${spec.countersinkDiameterMm} @ 90°)`;
    } else {
      result = meshTappedHole(input, { nominalDiameterMm: spec.nominalDiameterMm, depthMm: pilotDepth, axis: "z" });
      label = `${fastenerRaw} tapped hole (tap-drill Ø ${(spec.nominalDiameterMm * 0.85).toFixed(2)} mm)`;
    }
    if (!result.ok) { setStatus("ready"); setStatusText(`Hole Wizard failed: ${result.message}`); return; }
    const { feature: _feature, brep: _brep, ...keep } = body;
    void _feature; void _brep;
    const nextBody: GeneralSolidBody = { ...keep, positionsMm: Array.from(result.positionsMm), indices: Array.from(result.indices) };
    const modifier = typeRaw === "simple" ? "hole" : typeRaw === "counterbore" ? "counterbore" : typeRaw === "countersink" ? "countersink" : "tapped-hole";
    if (!applyProjectOperation({ kind: "modify-general-body", targetBodyId: body.id, modifier, label, body: nextBody })) { setStatus("ready"); setStatusText("The project rejected the Hole Wizard result."); return; }
    setSelectedId(body.id);
    setStatusText(`Applied ${label} to ${body.name}.`);
  };

  const handleAddConstructionPlane = (mode: "offset" | "angle" | "three-points" | "midplane" | "tangent-to-cylinder" | "perpendicular-to-axis"): void => {
    const current = projectRef.current;
    const existing = current.part.construction ?? [];
    const ordinal = existing.length + 1;
    const ask = (label: string, defaultValue: string): string | null => typeof window === "undefined" ? defaultValue : window.prompt(label, defaultValue);
    const parseNumber = (raw: string | null): number | undefined => raw === null ? undefined : (Number.isFinite(Number.parseFloat(raw)) ? Number.parseFloat(raw) : undefined);
    let definition: import("../../../packages/workbench-core/src/index.js").ConstructionPlaneDefinition | undefined;
    let labelText: string;
    if (mode === "offset") {
      const base = (ask("Base plane (xy, xz, yz):", "xy") ?? "").trim().toLowerCase();
      if (!["xy", "xz", "yz"].includes(base)) { setStatus("ready"); setStatusText("Offset Plane: enter xy, xz or yz as the base plane."); return; }
      const offset = parseNumber(ask("Offset distance along the plane normal (mm):", "10"));
      if (offset === undefined || offset === 0) { setStatus("ready"); setStatusText("Offset Plane: enter a non-zero offset in millimetres."); return; }
      definition = { kind: "offset", basePlane: `datum:${base}` as "datum:xy" | "datum:xz" | "datum:yz", offsetMm: offset };
      labelText = `Offset ${offset} mm from ${base.toUpperCase()}`;
    } else if (mode === "angle") {
      const base = (ask("Base plane (xy, xz, yz):", "xy") ?? "").trim().toLowerCase();
      if (!["xy", "xz", "yz"].includes(base)) { setStatus("ready"); setStatusText("Angle Plane: enter xy, xz or yz as the base plane."); return; }
      const axis = (ask("Rotation axis (x, y, z):", "x") ?? "").trim().toLowerCase();
      if (!["x", "y", "z"].includes(axis)) { setStatus("ready"); setStatusText("Angle Plane: enter x, y or z as the rotation axis."); return; }
      const angle = parseNumber(ask("Rotation angle (degrees):", "30"));
      if (angle === undefined || angle === 0) { setStatus("ready"); setStatusText("Angle Plane: enter a non-zero angle in degrees."); return; }
      definition = { kind: "angle", basePlane: `datum:${base}` as "datum:xy" | "datum:xz" | "datum:yz", axis: axis as "x" | "y" | "z", angleDeg: angle };
      labelText = `${base.toUpperCase()} rotated ${angle}° about ${axis.toUpperCase()}`;
    } else if (mode === "three-points") {
      const parsePoint = (raw: string | null): [number, number, number] | undefined => {
        if (raw === null) return undefined;
        const parts = raw.split(/[,\s]+/).map((part) => Number.parseFloat(part.trim())).filter((value) => Number.isFinite(value));
        return parts.length === 3 ? [parts[0]!, parts[1]!, parts[2]!] : undefined;
      };
      const p0 = parsePoint(ask("Point 1 (x, y, z in mm):", "0, 0, 0"));
      if (p0 === undefined) { setStatus("ready"); setStatusText("Three-Point Plane: each point is three numbers in millimetres, separated by commas."); return; }
      const p1 = parsePoint(ask("Point 2 (x, y, z in mm):", "50, 0, 0"));
      if (p1 === undefined) { setStatus("ready"); setStatusText("Three-Point Plane: point 2 is required."); return; }
      const p2 = parsePoint(ask("Point 3 (x, y, z in mm):", "0, 50, 25"));
      if (p2 === undefined) { setStatus("ready"); setStatusText("Three-Point Plane: point 3 is required."); return; }
      definition = { kind: "three-points", points: [p0, p1, p2] };
      labelText = "Three-point plane";
    } else if (mode === "midplane") {
      const base = (ask("Base plane (xy, xz, yz):", "xy") ?? "").trim().toLowerCase();
      if (!["xy", "xz", "yz"].includes(base)) { setStatus("ready"); setStatusText("Midplane: enter xy, xz or yz as the base plane."); return; }
      const fromMm = parseNumber(ask("Start offset (mm):", "-20"));
      const toMm = parseNumber(ask("End offset (mm):", "20"));
      if (fromMm === undefined || toMm === undefined || fromMm === toMm) { setStatus("ready"); setStatusText("Midplane: enter two different offsets in millimetres."); return; }
      definition = { kind: "midplane", basePlane: `datum:${base}` as "datum:xy" | "datum:xz" | "datum:yz", fromMm, toMm };
      labelText = `Midplane ${fromMm}..${toMm} mm of ${base.toUpperCase()}`;
    } else if (mode === "perpendicular-to-axis") {
      const axes = current.part.constructionAxes ?? [];
      if (axes.length === 0) { setStatus("ready"); setStatusText("Plane perpendicular to an axis: create a construction axis first."); return; }
      const nameOrId = (ask(`Axis name or id (available: ${axes.map((axis) => axis.name).join(", ")}):`, axes[0]!.name) ?? "").trim();
      const axis = axes.find((candidate) => candidate.name === nameOrId || candidate.id === nameOrId);
      if (axis === undefined) { setStatus("ready"); setStatusText("Plane perpendicular to an axis: no axis matched that name or id."); return; }
      const rawPoint = ask("Point the plane passes through (x, y, z in mm):", "0, 0, 0");
      const parts = (rawPoint ?? "").split(/[,\s]+/).map((part) => Number.parseFloat(part.trim())).filter((value) => Number.isFinite(value));
      if (parts.length !== 3) { setStatus("ready"); setStatusText("Plane perpendicular to an axis: enter the point as three numbers in millimetres."); return; }
      definition = { kind: "perpendicular-to-axis", axisId: axis.id, point: [parts[0]!, parts[1]!, parts[2]!] };
      labelText = `Perpendicular to ${axis.name}`;
    } else {
      // tangent-to-cylinder
      const bodies = current.part.generalBodies ?? [];
      if (bodies.length === 0) { setStatus("ready"); setStatusText("Tangent plane: create a revolve or extrude body first; the tangent plane rides that body's cylinder."); return; }
      const nameOrId = (ask(`Body name or id (available: ${bodies.map((body) => body.name).join(", ")}):`, bodies[0]!.name) ?? "").trim();
      const body = bodies.find((candidate) => candidate.name === nameOrId || candidate.id === nameOrId);
      if (body === undefined) { setStatus("ready"); setStatusText("Tangent plane: no body matched that name or id."); return; }
      const angleDeg = parseNumber(ask("Angle around the body axis (degrees, 0 is along the first in-plane axis):", "0"));
      if (angleDeg === undefined) { setStatus("ready"); setStatusText("Tangent plane: enter an angle in degrees."); return; }
      definition = { kind: "tangent-to-cylinder", bodyId: body.id, angleDeg };
      labelText = `Tangent to ${body.name} at ${angleDeg}°`;
    }
    const plane = {
      id: `construction-plane:${crypto.randomUUID()}`,
      name: labelText.length > 60 ? `${labelText.slice(0, 57)}…` : labelText,
      visible: true,
      definition
    };
    if (!applyProjectOperation({ kind: "add-construction-plane", plane })) { setStatus("ready"); setStatusText(`The project rejected ${labelText}.`); return; }
    setSelectedId(plane.id);
    setStatusText(`Created ${plane.name} (plane ${ordinal}).`);
  };

  const handleAddConstructionAxis = (mode: "two-points" | "point-and-direction" | "plane-intersection" | "perpendicular-to-plane" | "cylinder-axis"): void => {
    const current = projectRef.current;
    const existing = current.part.constructionAxes ?? [];
    const ordinal = existing.length + 1;
    const ask = (label: string, defaultValue: string): string | null => typeof window === "undefined" ? defaultValue : window.prompt(label, defaultValue);
    const parsePoint = (raw: string | null): [number, number, number] | undefined => {
      if (raw === null) return undefined;
      const parts = raw.split(/[,\s]+/).map((part) => Number.parseFloat(part.trim())).filter((value) => Number.isFinite(value));
      return parts.length === 3 ? [parts[0]!, parts[1]!, parts[2]!] : undefined;
    };
    let definition: import("../../../packages/workbench-core/src/index.js").ConstructionAxisDefinition | undefined;
    let labelText: string;
    if (mode === "two-points") {
      const a = parsePoint(ask("Axis start point (x, y, z in mm):", "0, 0, 0"));
      const b = parsePoint(ask("Axis end point (x, y, z in mm):", "50, 0, 0"));
      if (a === undefined || b === undefined) { setStatus("ready"); setStatusText("Two-point axis: each point is three numbers in millimetres, separated by commas."); return; }
      if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) { setStatus("ready"); setStatusText("Two-point axis: the two points must not coincide."); return; }
      definition = { kind: "two-points", a, b };
      labelText = "Axis through two points";
    } else if (mode === "point-and-direction") {
      const origin = parsePoint(ask("Axis origin (x, y, z in mm):", "0, 0, 0"));
      const direction = parsePoint(ask("Axis direction vector (x, y, z):", "0, 0, 1"));
      if (origin === undefined || direction === undefined) { setStatus("ready"); setStatusText("Point-and-direction axis: enter three numbers for origin and three for direction."); return; }
      if (Math.hypot(direction[0], direction[1], direction[2]) < 1e-6) { setStatus("ready"); setStatusText("Point-and-direction axis: the direction must not be zero."); return; }
      definition = { kind: "point-and-direction", origin, direction };
      labelText = "Axis along a direction";
    } else if (mode === "plane-intersection") {
      const a = (ask("First plane (xy, xz, yz):", "xy") ?? "").trim().toLowerCase();
      const b = (ask("Second plane (xy, xz, yz):", "xz") ?? "").trim().toLowerCase();
      if (!["xy", "xz", "yz"].includes(a) || !["xy", "xz", "yz"].includes(b) || a === b) { setStatus("ready"); setStatusText("Plane-intersection axis: enter two different primary planes (xy, xz, yz)."); return; }
      definition = { kind: "plane-intersection", planeA: `datum:${a}` as "datum:xy" | "datum:xz" | "datum:yz", planeB: `datum:${b}` as "datum:xy" | "datum:xz" | "datum:yz" };
      labelText = `Axis ${a.toUpperCase()} ∩ ${b.toUpperCase()}`;
    } else if (mode === "perpendicular-to-plane") {
      const plane = (ask("Base plane (xy, xz, yz):", "xy") ?? "").trim().toLowerCase();
      if (!["xy", "xz", "yz"].includes(plane)) { setStatus("ready"); setStatusText("Perpendicular axis: enter xy, xz or yz as the base plane."); return; }
      const point = parsePoint(ask("Pass-through point (x, y, z in mm):", "0, 0, 0"));
      if (point === undefined) { setStatus("ready"); setStatusText("Perpendicular axis: enter three numbers for the point in millimetres."); return; }
      definition = { kind: "perpendicular-to-plane", plane: `datum:${plane}` as "datum:xy" | "datum:xz" | "datum:yz", point };
      labelText = `Axis perpendicular to ${plane.toUpperCase()}`;
    } else {
      // cylinder-axis: ask for a body name match (any general body counts in this slice).
      const bodies = current.part.generalBodies ?? [];
      if (bodies.length === 0) { setStatus("ready"); setStatusText("Cylinder axis: create a revolve or extrude body first; this mode donates that body's axis."); return; }
      const nameOrId = (ask(`Body name or id (available: ${bodies.map((body) => body.name).join(", ")}):`, bodies[0]!.name) ?? "").trim();
      const body = bodies.find((candidate) => candidate.name === nameOrId || candidate.id === nameOrId);
      if (body === undefined) { setStatus("ready"); setStatusText("Cylinder axis: no body matched that name or id."); return; }
      definition = { kind: "cylinder-axis", bodyId: body.id };
      labelText = `Axis of ${body.name}`;
    }
    const axis = {
      id: `construction-axis:${crypto.randomUUID()}`,
      name: labelText.length > 60 ? `${labelText.slice(0, 57)}…` : labelText,
      visible: true,
      definition
    };
    if (!applyProjectOperation({ kind: "add-construction-axis", axis })) { setStatus("ready"); setStatusText(`The project rejected ${labelText}.`); return; }
    setSelectedId(axis.id);
    setStatusText(`Created ${axis.name} (axis ${ordinal}).`);
  };

  const handleAddConstructionPoint = (mode: "xyz" | "midpoint" | "axis-plane-intersection"): void => {
    const current = projectRef.current;
    const existing = current.part.constructionPoints ?? [];
    const ordinal = existing.length + 1;
    const ask = (label: string, defaultValue: string): string | null => typeof window === "undefined" ? defaultValue : window.prompt(label, defaultValue);
    const parsePoint = (raw: string | null): [number, number, number] | undefined => {
      if (raw === null) return undefined;
      const parts = raw.split(/[,\s]+/).map((part) => Number.parseFloat(part.trim())).filter((value) => Number.isFinite(value));
      return parts.length === 3 ? [parts[0]!, parts[1]!, parts[2]!] : undefined;
    };
    let definition: import("../../../packages/workbench-core/src/index.js").ConstructionPointDefinition | undefined;
    let labelText: string;
    if (mode === "xyz") {
      const position = parsePoint(ask("Point (x, y, z in mm):", "0, 0, 0"));
      if (position === undefined) { setStatus("ready"); setStatusText("XYZ point: enter three numbers in millimetres."); return; }
      definition = { kind: "xyz", position };
      labelText = `Point (${position.map((value) => value.toFixed(1)).join(", ")} mm)`;
    } else if (mode === "midpoint") {
      const a = parsePoint(ask("First point (x, y, z in mm):", "0, 0, 0"));
      const b = parsePoint(ask("Second point (x, y, z in mm):", "50, 0, 0"));
      if (a === undefined || b === undefined) { setStatus("ready"); setStatusText("Midpoint: enter three numbers for each point in millimetres."); return; }
      definition = { kind: "midpoint", a, b };
      labelText = "Midpoint of two points";
    } else {
      const axes = current.part.constructionAxes ?? [];
      if (axes.length === 0) { setStatus("ready"); setStatusText("Axis ∩ plane point: create a construction axis first."); return; }
      const nameOrId = (ask(`Axis name or id (available: ${axes.map((axis) => axis.name).join(", ")}):`, axes[0]!.name) ?? "").trim();
      const axis = axes.find((candidate) => candidate.name === nameOrId || candidate.id === nameOrId);
      if (axis === undefined) { setStatus("ready"); setStatusText("Axis ∩ plane point: no axis matched that name or id."); return; }
      const plane = (ask("Plane (xy, xz, yz):", "xy") ?? "").trim().toLowerCase();
      if (!["xy", "xz", "yz"].includes(plane)) { setStatus("ready"); setStatusText("Axis ∩ plane point: enter xy, xz or yz as the plane."); return; }
      definition = { kind: "axis-plane-intersection", axisId: axis.id, plane: `datum:${plane}` as "datum:xy" | "datum:xz" | "datum:yz" };
      labelText = `${axis.name} ∩ ${plane.toUpperCase()}`;
    }
    const point = {
      id: `construction-point:${crypto.randomUUID()}`,
      name: labelText.length > 60 ? `${labelText.slice(0, 57)}…` : labelText,
      visible: true,
      definition
    };
    if (!applyProjectOperation({ kind: "add-construction-point", point })) { setStatus("ready"); setStatusText(`The project rejected ${labelText}.`); return; }
    setSelectedId(point.id);
    setStatusText(`Created ${point.name} (point ${ordinal}).`);
  };

  /**
   * Waits for the user to click the model: the viewport switches to its pick mode, optional guide lines show what can be picked,
   * and the promise resolves with the clicked point (and face) or null when the user presses Escape or starts another pick.
   */
  const requestViewportPick = (instruction: string, guides: readonly ViewportGuideSegment[] = [], activeGuide: number | null = null): Promise<ViewportMeasurePoint | null> => new Promise((resolve) => {
    pickRef.current?.(null);
    const viewport = viewportRef.current;
    if (viewport === undefined) { resolve(null); return; }
    viewport.setGuideSegments(guides, activeGuide);
    viewport.setNavigationMode("measure");
    setStatus("ready");
    setStatusText(`${instruction} (Esc cancels)`);
    pickRef.current = (point) => {
      pickRef.current = null;
      viewport.setGuideSegments([]);
      viewport.setNavigationMode("select");
      resolve(point);
    };
  });

  const handleEdgeFlange = async (): Promise<void> => {
    const current = projectRef.current;
    const bodies = current.part.generalBodies ?? [];
    const body = bodies.find((candidate) => candidate.id === selectedId) ?? bodies[0];
    if (body === undefined) { setStatus("ready"); setStatusText("Edge flange: create or select a plate first (a Sheet metal base plate or any extruded profile)."); return; }
    const history = designOf(current);
    const base = baseFeatureOf(history, body.id);
    const sketchFeature = base === undefined ? undefined : history.features.find((candidate) => candidate.id === base.sketchFeatureId && candidate.kind === "sketch");
    if (base === undefined || sketchFeature?.kind !== "sketch") { setStatus("ready"); setStatusText("Edge flange: this body is not in the timeline, so a flange cannot be recorded."); return; }
    const rebuilt = await rebuildSolidFeature(base, sketchFeature, body.color);
    if (!rebuilt.ok) { setStatus("error"); setStatusText(`Edge flange: ${rebuilt.message}`); return; }
    const frame = sheetFrameOf(rebuilt.body, sketchNormal(sketchFeature));
    if (frame === undefined || frame.edges.length === 0) { setStatus("ready"); setStatusText("Edge flange: this body has no flat top face with straight edges to bend from."); return; }
    const ask = (label: string, defaultValue: string): string | null => typeof window === "undefined" ? defaultValue : window.prompt(label, defaultValue);
    const guides: ViewportGuideSegment[] = frame.edges.map((edge) => [edge.startMm, edge.endMm]);
    const picked = await requestViewportPick(`Edge flange: click near the plate edge to bend the flange from (${frame.edges.length} edges, ${frame.thicknessMm.toFixed(2)} mm sheet)`, guides);
    if (picked === null) return;
    const nearest = nearestFrameEdge(frame, picked.pointMm);
    if (nearest === undefined) { setStatus("ready"); setStatusText("Edge flange: this plate has no straight edge to pick."); return; }
    const edgeIndex = nearest.index;
    viewportRef.current?.setGuideSegments(guides, edgeIndex);
    window.setTimeout(() => viewportRef.current?.setGuideSegments([]), 1500);
    setStatusText(`Edge flange: using edge ${edgeIndex} (${frame.edges[edgeIndex]!.lengthMm.toFixed(1)} mm long, ${nearest.distanceMm.toFixed(1)} mm from your click).`);
    const radius = Number.parseFloat(ask("Inner bend radius (mm):", String(frame.thicknessMm)) ?? "");
    const length = Number.parseFloat(ask("Flange length after the bend (mm):", "20") ?? "");
    const angle = Number.parseFloat(ask("Bend angle (degrees, 1 to 180):", "90") ?? "");
    if (![radius, length, angle].every(Number.isFinite) || radius < 0 || length <= 0 || angle <= 0 || angle > 180) { setStatus("ready"); setStatusText("Edge flange: enter a bend radius of 0 or more, a flange length above 0 and an angle up to 180°."); return; }
    const liveFlangeEdges = history.features.filter((candidate) => candidate.kind === "sheet-edge-flange" && candidate.bodyId === body.id && isFeatureActive(history, candidate.id)).map((candidate) => (candidate as DesignSolidFeature).flangeEdgeIndex ?? 0);
    const meetsNeighbour = sharedFlangeEnds(frame, edgeIndex, liveFlangeEdges);
    const needsRelief = meetsNeighbour.start || meetsNeighbour.end;
    const relief = needsRelief ? Number.parseFloat(ask(`Edge ${edgeIndex} meets another flange at a corner. Corner relief (mm gap between the two flanges, 0 for none):`, frame.thicknessMm.toFixed(2)) ?? "") : 0;
    if (!Number.isFinite(relief) || relief < 0) { setStatus("ready"); setStatusText("Edge flange: enter a corner relief of 0 or more."); return; }
    const feature: DesignSolidFeature = {
      id: `feature:sheet-edge-flange-${crypto.randomUUID()}`,
      name: `Edge flange ${edgeIndex} (${angle.toFixed(0)}°, ${length.toFixed(0)} mm)`,
      kind: "sheet-edge-flange", suppressed: false,
      sketchFeatureId: base.sketchFeatureId, profileIds: [],
      valueMm: Math.max(0.01, length), bodyId: body.id, operation: "direct-edit",
      flangeEdgeIndex: edgeIndex, sheetBendRadiusMm: radius, flangeLengthMm: length, flangeAngleDeg: angle,
      ...(relief > 0 ? { flangeReliefMm: relief } : {})
    };
    void commitWithReplay({ kind: "add-design-solid", feature, body }, feature.id).then((ok) => { if (ok) setSelectedId(body.id); });
  };

  const handleFlatPattern = async (format: "svg" | "dxf"): Promise<void> => {
    const current = projectRef.current;
    const bodies = current.part.generalBodies ?? [];
    const body = bodies.find((candidate) => candidate.id === selectedId) ?? bodies[0];
    if (body === undefined) { setStatus("ready"); setStatusText("Flat pattern: select a sheet-metal body first."); return; }
    setStatus("working");
    const outcome = await flatPatternForBody(current, body.id);
    if (!outcome.ok) { setStatus("ready"); setStatusText(`Flat pattern: ${outcome.message}`); return; }
    const text = format === "svg" ? flatLayoutSvg(outcome.layout) : flatLayoutDxf(outcome.layout);
    downloadBlob(new Blob([text], { type: format === "svg" ? "image/svg+xml" : "application/dxf" }), exportFileName(current.name, `${body.name}-flat-pattern`, format));
    setStatus("ready");
    setStatusText(`Exported the flat pattern of ${body.name} as ${format.toUpperCase()}: ${outcome.summary}.${outcome.notes.length === 0 ? "" : ` Note: ${outcome.notes.join(" ")}`}`);
  };

  const handleIndent = (): void => {
    const current = projectRef.current;
    const bodies = current.part.generalBodies ?? [];
    const body = bodies.find((candidate) => candidate.id === selectedId) ?? bodies[0];
    if (body === undefined) { setStatus("ready"); setStatusText("Indent: select the solid to indent first."); return; }
    const tools = bodies.filter((candidate) => candidate.id !== body.id);
    if (tools.length === 0) { setStatus("ready"); setStatusText("Indent: make a second solid to use as the tool, positioned where it should press into the first."); return; }
    const history = designOf(current);
    const base = baseFeatureOf(history, body.id);
    if (base === undefined) { setStatus("ready"); setStatusText("Indent: this body is not in the timeline, so an indent cannot be recorded."); return; }
    const raw = typeof window === "undefined" ? tools[0]!.name : window.prompt(`Tool solid to press into ${body.name} (available: ${tools.map((tool) => tool.name).join(", ")}):`, tools[0]!.name);
    if (raw === null) return;
    const tool = tools.find((candidate) => candidate.name === raw.trim() || candidate.id === raw.trim());
    if (tool === undefined) { setStatus("ready"); setStatusText("Indent: no solid matched that name."); return; }
    const feature: DesignSolidFeature = {
      id: `feature:indent-${crypto.randomUUID()}`, name: `Indent ${body.name} with ${tool.name}`, kind: "indent", suppressed: false,
      sketchFeatureId: base.sketchFeatureId, profileIds: [], valueMm: 1, bodyId: body.id, indentToolBodyId: tool.id
    };
    void commitWithReplay({ kind: "add-design-solid", feature, body }, feature.id).then((ok) => { if (ok) setSelectedId(body.id); });
  };

  const handleDirectEdit = async (mode: "move-body" | "scale-body" | "move-face" | "offset-face" | "emboss"): Promise<void> => {
    const current = projectRef.current;
    const bodies = current.part.generalBodies ?? [];
    const body = bodies.find((candidate) => candidate.id === selectedId) ?? bodies[0];
    const niceName = mode === "move-body" ? "Move body" : mode === "scale-body" ? "Scale body" : mode === "move-face" ? "Move face" : mode === "emboss" ? "Emboss" : "Offset face";
    if (body === undefined) { setStatus("ready"); setStatusText(`${niceName}: create or select a solid body first.`); return; }
    const history = designOf(current);
    const base = baseFeatureOf(history, body.id);
    if (base === undefined) { setStatus("ready"); setStatusText(`${niceName}: this body is not in the timeline, so a direct edit cannot be recorded.`); return; }
    const ask = (label: string, defaultValue: string): string | null => typeof window === "undefined" ? defaultValue : window.prompt(label, defaultValue);
    if (mode === "move-face" || mode === "offset-face" || mode === "emboss") {
      const roles = body.brep?.faces.map((face) => face.role) ?? [];
      if (roles.length === 0) { setStatus("ready"); setStatusText(`${niceName}: this body has no named faces to target. Rebuild it through the extrude kernel first.`); return; }
      const picked = await requestViewportPick(`${niceName}: click the face of ${body.name} to change`);
      if (picked === null) return;
      const pickedFace = picked.semanticId === body.id && picked.faceIndex !== null && picked.faceIndex !== undefined ? body.brep?.faces[picked.faceIndex] : undefined;
      if (pickedFace === undefined || picked.faceIndex === null || picked.faceIndex === undefined) { setStatus("ready"); setStatusText(`${niceName}: click one of the named faces of ${body.name}.`); return; }
      const role = pickedFace.role;
      setSelectedFace({ bodyId: body.id, faceIndex: picked.faceIndex });
      setStatusText(`${niceName}: using face ${role}.`);
      if (mode === "move-face") {
        const raw = ask("Face translation (dx, dy, dz in mm):", "0, 0, 5");
        if (raw === null) return;
        const parts = raw.split(/[,\s]+/).map((part) => Number.parseFloat(part.trim())).filter((value) => Number.isFinite(value));
        if (parts.length !== 3) { setStatus("ready"); setStatusText("Move face: enter three numbers in millimetres."); return; }
        const delta: [number, number, number] = [parts[0]!, parts[1]!, parts[2]!];
        if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) { setStatus("ready"); setStatusText("Move face: delta is zero."); return; }
        const feature: DesignSolidFeature = {
          id: `feature:move-face-${crypto.randomUUID()}`,
          name: `Move face ${role} (${delta.map((value) => value.toFixed(1)).join(", ")} mm)`,
          kind: "move-face", suppressed: false,
          sketchFeatureId: base.sketchFeatureId, profileIds: [],
          valueMm: Math.max(0.01, Math.hypot(delta[0], delta[1], delta[2])),
          bodyId: body.id, operation: "direct-edit",
          targetFaceRole: role, moveFaceDeltaMm: delta
        };
        void commitWithReplay({ kind: "add-design-solid", feature, body }, feature.id).then((ok) => { if (ok) setSelectedId(body.id); });
        return;
      }
      if (mode === "emboss") {
        const heightRaw = ask("Emboss height (mm; negative presses the face in):", "1");
        if (heightRaw === null) return;
        const height = Number.parseFloat(heightRaw);
        if (!Number.isFinite(height) || height === 0) { setStatus("ready"); setStatusText("Emboss: enter a non-zero height in millimetres."); return; }
        const embossed: DesignSolidFeature = {
          id: `feature:emboss-${crypto.randomUUID()}`, name: `Emboss ${role} ${height.toFixed(2)} mm`, kind: "emboss", suppressed: false,
          sketchFeatureId: base.sketchFeatureId, profileIds: [], valueMm: Math.max(0.01, Math.abs(height)),
          bodyId: body.id, operation: "direct-edit", targetFaceRole: role, embossHeightMm: height
        };
        void commitWithReplay({ kind: "add-design-solid", feature: embossed, body }, embossed.id).then((ok) => { if (ok) setSelectedId(body.id); });
        return;
      }
      // offset-face
      const offsetRaw = ask("Face offset along its normal (mm, signed):", "2");
      if (offsetRaw === null) return;
      const offset = Number.parseFloat(offsetRaw);
      if (!Number.isFinite(offset) || offset === 0) { setStatus("ready"); setStatusText("Offset face: enter a non-zero distance in millimetres."); return; }
      const feature: DesignSolidFeature = {
        id: `feature:offset-face-${crypto.randomUUID()}`,
        name: `Offset face ${role} ${offset.toFixed(2)} mm`,
        kind: "offset-face", suppressed: false,
        sketchFeatureId: base.sketchFeatureId, profileIds: [],
        valueMm: Math.max(0.01, Math.abs(offset)),
        bodyId: body.id, operation: "direct-edit",
        targetFaceRole: role, offsetFaceMm: offset
      };
      void commitWithReplay({ kind: "add-design-solid", feature, body }, feature.id).then((ok) => { if (ok) setSelectedId(body.id); });
      return;
    }
    if (mode === "move-body") {
      const raw = ask("Translation (dx, dy, dz in mm):", "10, 0, 0");
      if (raw === null) return;
      const parts = raw.split(/[,\s]+/).map((part) => Number.parseFloat(part.trim())).filter((value) => Number.isFinite(value));
      if (parts.length !== 3) { setStatus("ready"); setStatusText("Move body: enter three numbers in millimetres."); return; }
      const delta: [number, number, number] = [parts[0]!, parts[1]!, parts[2]!];
      if (delta[0] === 0 && delta[1] === 0 && delta[2] === 0) { setStatus("ready"); setStatusText("Move body: delta is zero, nothing to do."); return; }
      const feature: DesignSolidFeature = {
        id: `feature:move-body-${crypto.randomUUID()}`,
        name: `Move ${body.name} (${delta.map((value) => value.toFixed(1)).join(", ")} mm)`,
        kind: "move-body",
        suppressed: false,
        sketchFeatureId: base.sketchFeatureId,
        profileIds: [],
        valueMm: Math.max(0.01, Math.hypot(delta[0], delta[1], delta[2])),
        bodyId: body.id,
        operation: "direct-edit",
        moveDeltaMm: delta
      };
      void commitWithReplay({ kind: "add-design-solid", feature, body }, feature.id).then((ok) => { if (ok) setSelectedId(body.id); });
      return;
    }
    const raw = ask("Scale factor (e.g. 1.25 for 125%):", "1.25");
    if (raw === null) return;
    const factor = Number.parseFloat(raw);
    if (!Number.isFinite(factor) || factor <= 0 || factor > 100) { setStatus("ready"); setStatusText("Scale body: enter a positive scale factor."); return; }
    if (factor === 1) { setStatus("ready"); setStatusText("Scale body: factor is 1, nothing to do."); return; }
    const feature: DesignSolidFeature = {
      id: `feature:scale-body-${crypto.randomUUID()}`,
      name: `Scale ${body.name} ×${factor.toFixed(3)}`,
      kind: "scale-body",
      suppressed: false,
      sketchFeatureId: base.sketchFeatureId,
      profileIds: [],
      valueMm: Math.max(0.01, factor),
      bodyId: body.id,
      operation: "direct-edit",
      scaleFactor: factor
    };
    void commitWithReplay({ kind: "add-design-solid", feature, body }, feature.id).then((ok) => { if (ok) setSelectedId(body.id); });
  };

  /**
   * Fillet or chamfer one picked edge: the sharp convex edges of the solid are drawn over it, and a click on any of them (flat,
   * slanted or round) picks that edge, with the rest of its smooth run, such as a whole circular rim. The click decides the solid
   * too, so an edge of another solid can be picked without selecting it first.
   */
  const handleEdgeTreatment = async (modifier: "fillet" | "chamfer"): Promise<void> => {
    const bodies = projectRef.current.part.generalBodies ?? [];
    const selected = bodies.find((candidate) => candidate.id === selectedId);
    const name = modifierLabelOf(modifier);
    if (selected === undefined) { setStatus("ready"); setStatusText(`${name} needs a general solid body selected first.`); return; }
    const edgesOf = (target: GeneralSolidBody): ReturnType<typeof pickableEdges> => pickableEdges({ positionsMm: target.positionsMm, indices: target.indices });
    const edges = edgesOf(selected);
    if (typeof edges === "string") { setStatus("ready"); setStatusText(`${name}: ${edges}`); return; }
    if (edges.length === 0) { setStatus("ready"); setStatusText(`${name}: ${selected.name} has no sharp convex edge to pick.`); return; }
    const guides: ViewportGuideSegment[] = edges.map((edge) => [edge.a, edge.b]);
    const runs = new Set(edges.map((edge) => edge.chain)).size;
    const picked = await requestViewportPick(`${name}: click an edge of ${selected.name} (${runs} ${runs === 1 ? "edge" : "edges"} outlined)`, guides);
    if (picked === null) return;
    const body = bodies.find((candidate) => candidate.id === picked.semanticId) ?? selected;
    const bodyEdges = body === selected ? edges : edgesOf(body);
    if (typeof bodyEdges === "string") { setStatus("ready"); setStatusText(`${name}: ${bodyEdges}`); return; }
    const nearest = nearestPickableEdge(bodyEdges, picked.pointMm);
    if (nearest === undefined) { setStatus("ready"); setStatusText(`${name}: ${body.name} has no sharp convex edge to pick.`); return; }
    const chainIndexes = bodyEdges.flatMap((edge, index) => edge.chain === nearest.edge.chain ? [index] : []);
    const viewport = viewportRef.current;
    viewport?.setGuideSegments(bodyEdges.map((edge) => [edge.a, edge.b] as ViewportGuideSegment), chainIndexes);
    const clearHighlight = (): void => viewport?.setGuideSegments([]);
    window.setTimeout(clearHighlight, 4000);
    const pieces = nearest.chain.length;
    const where = `${pieces === 1 ? `a ${Math.hypot(nearest.edge.b[0] - nearest.edge.a[0], nearest.edge.b[1] - nearest.edge.a[1], nearest.edge.b[2] - nearest.edge.a[2]).toFixed(1)} mm edge` : `a run of ${pieces} edges`} of ${body.name}, ${nearest.distanceMm.toFixed(1)} mm from your click`;
    setStatusText(`${name}: picked ${where}.`);
    const raw = typeof window === "undefined" ? "2" : window.prompt(modifier === "fillet" ? "Fillet radius (mm):" : "Chamfer distance (mm):", "2");
    if (raw === null) { clearHighlight(); return; }
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value) || value <= 0) { clearHighlight(); setStatus("ready"); setStatusText(`${name}: enter a positive number in millimetres.`); return; }
    const input = { positionsMm: body.positionsMm, indices: body.indices };
    const onlyEdges = nearest.chain.map((edge) => [edge.a, edge.b] as const);
    const result = modifier === "fillet" ? meshFillet(input, { sizeMm: value, onlyEdges }) : meshChamfer(input, { sizeMm: value, onlyEdges });
    clearHighlight();
    if (!result.ok) { setStatus("ready"); setStatusText(`${name} failed: ${result.message}`); return; }
    const label = modifier === "fillet" ? `Fillet R ${value} mm (picked edge)` : `Chamfer ${value} mm (picked edge)`;
    const { feature: _feature, brep: _brep, ...keep } = body;
    void _feature; void _brep;
    const nextBody: GeneralSolidBody = { ...keep, positionsMm: Array.from(result.positionsMm), indices: Array.from(result.indices) };
    if (!applyProjectOperation({ kind: "modify-general-body", targetBodyId: body.id, modifier, label, body: nextBody })) { setStatus("ready"); setStatusText(`The project rejected the ${name} result.`); return; }
    setSelectedId(body.id);
    setStatusText(`Applied ${label} to ${body.name}: ${where}.`);
  };

  const handleModifyGeneralBody = (modifier: "hole" | "fillet" | "chamfer" | "shell", scope: "picked" | "all" = "picked"): void => {
    if ((modifier === "fillet" || modifier === "chamfer") && scope === "picked") { void handleEdgeTreatment(modifier); return; }
    const current = projectRef.current;
    const bodies = current.part.generalBodies ?? [];
    const body = bodies.find((candidate) => candidate.id === selectedId);
    if (body === undefined) { setStatus("ready"); setStatusText(`${modifierLabelOf(modifier)} needs a general solid body selected first.`); return; }
    const defaults = { hole: 6, fillet: 2, chamfer: 2, shell: 2 } as const;
    const prompt: Record<typeof modifier, string> = {
      hole: "Hole diameter (mm):",
      fillet: "Fillet radius (mm):",
      chamfer: "Chamfer distance (mm):",
      shell: "Shell wall thickness (mm):"
    };
    const raw = typeof window === "undefined" ? String(defaults[modifier]) : window.prompt(prompt[modifier], String(defaults[modifier]));
    if (raw === null) return;
    const value = Number.parseFloat(raw);
    if (!Number.isFinite(value) || value <= 0) { setStatus("ready"); setStatusText(`${modifierLabelOf(modifier)}: enter a positive number in millimetres.`); return; }
    const input = { positionsMm: body.positionsMm, indices: body.indices };
    let result: { readonly ok: true; readonly positionsMm: readonly number[]; readonly indices: readonly number[] } | { readonly ok: false; readonly message: string };
    let label: string;
    if (modifier === "hole") {
      // Default hole axis is +Z, through the body with a small overshoot either side.
      const maxZ = Math.max(...body.positionsMm.filter((_, index) => index % 3 === 2));
      const minZ = Math.min(...body.positionsMm.filter((_, index) => index % 3 === 2));
      const depth = (maxZ - minZ) + 4;
      result = meshHole(input, { diameterMm: value, depthMm: depth, axis: "z" });
      label = `Hole Ø ${value} mm`;
    } else if (modifier === "fillet") {
      result = meshFillet(input, { sizeMm: value });
      label = `Fillet R ${value} mm`;
    } else if (modifier === "chamfer") {
      result = meshChamfer(input, { sizeMm: value });
      label = `Chamfer ${value} mm`;
    } else {
      result = meshShell(input, { thicknessMm: value, openFace: "+z" });
      label = `Shell ${value} mm`;
    }
    if (!result.ok) { setStatus("ready"); setStatusText(`${modifierLabelOf(modifier)} failed: ${result.message}`); return; }
    const { feature: _feature, brep: _brep, ...keep } = body;
    void _feature; void _brep;
    const nextBody: GeneralSolidBody = { ...keep, positionsMm: Array.from(result.positionsMm), indices: Array.from(result.indices) };
    if (!applyProjectOperation({ kind: "modify-general-body", targetBodyId: body.id, modifier, label, body: nextBody })) { setStatus("ready"); setStatusText(`The project rejected the ${modifierLabelOf(modifier)} result.`); return; }
    setSelectedId(body.id);
    setStatusText(`Applied ${label} to ${body.name}.`);
  };

  const runPartFeatureAction = (operation: Extract<CadCommandRecord["action"], { kind: "part-feature-action" }>["operation"], commandName: string, bodyIdOverride: string | null = selectedId): void => {
    const current = projectRef.current;
    const bodies = current.part.previewBodies ?? [];
    if ((operation === "unite" || operation === "subtract") && (current.part.generalBodies ?? []).some((body) => body.id === bodyIdOverride)) {
      // Solids from Extrude and Revolve combine through the mesh Boolean dialog, where the tool is chosen explicitly.
      if ((current.part.generalBodies ?? []).length < 2) { setStatus("ready"); setStatusText(`${commandName} needs a second solid body. Create another with Make solid first.`); return; }
      setCombineRequest({ targetId: bodyIdOverride ?? undefined, mode: operation === "unite" ? "join" : "cut" });
      return;
    }
    if (operation === "update-model") {
      applyProjectOperation({ kind: "update-part-model" });
      return;
    }
    if (operation === "revolve") {
      const bodyId = `part-body:revolve-${crypto.randomUUID()}`;
      const outerDiameterMm = 30;
      if (applyProjectOperation({
        kind: "create-part-revolve",
        bodyId,
        name: `Revolved ring ${bodies.length + 1}`,
        outerDiameterMm,
        innerDiameterMm: 16,
        heightMm: 12,
        angleDeg: current.part.revolveAngleDeg,
        translationMm: [current.part.widthMm / 2 + 34 + outerDiameterMm / 2, 0, 6]
      })) setSelectedId(bodyId);
      return;
    }
    const body = bodies.find((candidate) => candidate.id === bodyIdOverride);
    if (body === undefined) {
      setStatus("ready");
      setStatusText(`Select an analytic body in the viewport or Bodies tree before running ${commandName}.`);
      return;
    }
    if (operation === "pattern-feature") {
      const count = Math.max(2, current.part.patternCount);
      const instanceIds = Array.from({ length: count - 1 }, () => `part-body:pattern-${crypto.randomUUID()}`);
      const spacingMm = Math.max(body.sizeMm[0], 10) * 1.25;
      if (applyProjectOperation({ kind: "pattern-part-feature", bodyId: body.id, instanceIds, direction: "x", spacingMm })) setSelectedId(instanceIds.at(-1) ?? body.id);
      return;
    }
    if (operation === "mirror-feature") {
      const newBodyId = `part-body:mirror-${crypto.randomUUID()}`;
      if (applyProjectOperation({ kind: "mirror-part-feature", bodyId: body.id, newBodyId, plane: "yz" })) setSelectedId(newBodyId);
      return;
    }
    if (operation === "unite" || operation === "subtract") {
      const tool = bodies.find((candidate) => candidate.id !== body.id && candidate.visible);
      if (tool === undefined) {
        setStatus("ready");
        setStatusText(`${commandName} needs a second visible analytic body. Select the target, then create or show a compatible tool body.`);
        return;
      }
      if (applyProjectOperation({ kind: "boolean-part-bodies", targetBodyId: body.id, toolBodyId: tool.id, operation })) setSelectedId(body.id);
      return;
    }
    if (operation === "trim-body") {
      applyProjectOperation({ kind: "trim-part-body", bodyId: body.id, keptLengthMm: Math.max(0.5, body.sizeMm[2] * 0.7), side: "negative" });
      return;
    }
    if (operation === "edge-blend" || operation === "chamfer") {
      const maximum = Math.max(0.25, Math.min(body.sizeMm[0], body.sizeMm[1]) / 2 - 0.5);
      const sizeMm = Math.min(Math.max(0.5, current.part.edgeTreatmentMm), maximum);
      applyProjectOperation({ kind: "set-part-body-edge-treatment", bodyId: body.id, treatment: operation === "edge-blend" ? "blend" : "chamfer", sizeMm });
      return;
    }
    if (operation === "draft") {
      applyProjectOperation({ kind: "set-part-body-draft", bodyId: body.id, angleDeg: 5 });
      return;
    }
    if (operation === "shell") {
      const thicknessMm = Math.min(2, Math.max(0.5, Math.min(body.sizeMm[0] / 4, body.sizeMm[1] / 4, body.sizeMm[2] / 3)));
      applyProjectOperation({ kind: "set-part-body-shell", bodyId: body.id, thicknessMm });
      return;
    }
    if (operation === "move-face" || operation === "offset-face") {
      applyProjectOperation({ kind: "move-part-body-face", bodyId: body.id, face: "z-positive", offsetMm: 2, mode: operation === "move-face" ? "move" : "offset" });
      return;
    }
    if (operation === "replace-face") {
      applyProjectOperation({ kind: "replace-part-body-face", bodyId: body.id, face: "z-positive", localPositionMm: body.sizeMm[2] / 2 + 2 });
      return;
    }
    if (operation === "resize-blend") {
      if (body.edgeTreatment?.kind !== "blend") {
        setStatus("ready");
        setStatusText("Resize Blend needs a recognized analytic blend. Run Edge Blend on a plain block first.");
        return;
      }
      const maximum = Math.min(body.sizeMm[0], body.sizeMm[1]) / 2 - 0.5;
      applyProjectOperation({ kind: "set-part-body-edge-treatment", bodyId: body.id, treatment: "blend", sizeMm: Math.min(maximum, body.edgeTreatment.sizeMm + 0.5) });
      return;
    }
    const feature = body.boreDiameterMm !== undefined ? "bore"
      : body.edgeTreatment !== undefined ? "edge-treatment"
        : body.shellThicknessMm !== undefined ? "shell"
          : body.draftAngleDeg !== undefined ? "draft" : undefined;
    if (feature === undefined) {
      setStatus("ready");
      setStatusText("Delete Face needs a recognized bore, blend/chamfer, shell, or draft face set; the plain body was not changed.");
      return;
    }
    applyProjectOperation({ kind: "delete-part-body-face", bodyId: body.id, feature });
  };

  const insertAssemblyComponent = (shape: "box" | "cylinder"): void => {
    const current = projectRef.current;
    const label = shape === "box" ? "Box" : "Cylinder";
    const pattern = new RegExp(`^${label} (\\d+)$`, "u");
    const ordinal = current.assembly.components.reduce((max, component) => {
      const match = pattern.exec(component.name);
      const value = match === null ? 0 : Number(match[1]);
      return Number.isSafeInteger(value) && value > max ? value : max;
    }, 0) + 1;
    const occupied = new Set(current.assembly.components.map((component) => {
      const column = Math.round((component.translationMm[0] + 27) / 18);
      const row = Math.round(component.translationMm[1] / 18);
      return column >= 0 && column < 4 && row >= 0 ? row * 4 + column : -1;
    }));
    let slot = 0;
    while (occupied.has(slot)) slot += 1;
    const component: ComponentInstance = {
      id: `component:user-${crypto.randomUUID()}`,
      name: `${label} ${ordinal}`,
      shape,
      grounded: false,
      visible: true,
      color: shape === "box" ? "#5cc2d6" : "#e3a34e",
      translationMm: [(slot % 4) * 18 - 27, Math.floor(slot / 4) * 18, shape === "box" ? 8 : 14],
      rotationDeg: [0, 0, 0],
      sizeMm: shape === "box" ? [24, 18, 12] : [14, 14, 24],
      explosionDirection: shape === "box" ? [0.45, 0.2, 0.35] : [-0.35, 0.25, 0.55]
    };
    if (applyProjectOperation({ kind: "add-assembly-component", component })) setSelectedId(component.id);
  };

  const insertMasterCartItem = (templateId: MasterCartTemplateId, configuration: MasterCartConfiguration, designation: string): void => {
    const current = projectRef.current;
    const instanceId = `master-cart:${crypto.randomUUID()}`;
    const generated = buildMasterCartItem(templateId, configuration, instanceId);
    const occupied = new Set(current.assembly.components.flatMap((component) => {
      if (component.masterCart === undefined) return [];
      const column = Math.round((component.translationMm[0] - 105) / 90);
      const row = Math.round((component.translationMm[1] + 55) / 90);
      return column >= 0 && column < 4 && row >= 0 ? [row * 4 + column] : [];
    }));
    let placementSlot = 0;
    while (occupied.has(placementSlot)) placementSlot += 1;
    const placement: Vec3 = [105 + (placementSlot % 4) * 90, -55 + Math.floor(placementSlot / 4) * 90, 0];
    const components = generated.components.map((component): ComponentInstance => ({
      ...component,
      translationMm: [component.translationMm[0] + placement[0], component.translationMm[1] + placement[1], component.translationMm[2] + placement[2]]
    }));
    if (!applyProjectOperation({ kind: "add-assembly-components", components })) return;
    setMasterCartOpen(false);
    setSelectedId(components[0]?.id ?? null);
    setStatus("ready");
    setStatusText(`${designation} added to Assembly as one grouped, editable ${components.length}-body preview item at ${placement.join(", ")} mm.`);
  };

  const insertCurrentPartIntoAssembly = (): void => {
    const current = projectRef.current;
    const component: ComponentInstance = {
      id: `component:part-snapshot-${crypto.randomUUID()}`,
      name: `${current.part.name} · part R${current.revision}`,
      shape: "plate",
      grounded: false,
      visible: true,
      color: "#4fc7dd",
      translationMm: [0, 0, current.part.thicknessMm / 2],
      rotationDeg: [0, 0, 0],
      sizeMm: [current.part.widthMm, current.part.heightMm, current.part.thicknessMm],
      explosionDirection: [0.18, -0.12, 0.62]
    };
    if (!applyProjectOperation({ kind: "add-assembly-component", component })) return;
    switchWorkspace("assembly");
    setSelectedId(component.id);
    setStatus("ready");
    setStatusText(`Inserted ${current.part.name} from part revision ${current.revision} as an editable assembly snapshot. Later part edits are not associative yet.`);
  };

  const createComponentFromPartBody = (body: PartPreviewBody): void => {
    const component: ComponentInstance = {
      id: `component:part-body-${crypto.randomUUID()}`,
      name: `${body.name} · component`,
      shape: body.shape === "block" ? "box" : body.shape === "revolved" ? "ring" : body.shape,
      grounded: false,
      visible: true,
      color: body.color,
      translationMm: body.translationMm,
      rotationDeg: body.rotationDeg,
      sizeMm: body.sizeMm,
      explosionDirection: [0.2, -0.14, 0.62]
    };
    if (!applyProjectOperation({ kind: "add-assembly-component", component })) return;
    switchWorkspace("assembly");
    setSelectedId(component.id);
    setStatus("ready");
    setStatusText(`Created an assembly component from ${body.name}. Later part edits are not associative yet.`);
  };

  /** Snapshots a Part solid into the assembly as a mesh component, centred on its bounds so it moves and rotates about its middle. */
  const createComponentFromGeneralBody = (bodyId: string): void => {
    const body = (projectRef.current.part.generalBodies ?? []).find((candidate) => candidate.id === bodyId);
    if (body === undefined) { setStatusText("Select a solid body first."); return; }
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < body.positionsMm.length; index += 3) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = body.positionsMm[index + axis]!;
        if (value < min[axis]!) min[axis] = value;
        if (value > max[axis]!) max[axis] = value;
      }
    }
    const center = [0, 1, 2].map((axis) => (min[axis]! + max[axis]!) / 2) as unknown as Vec3;
    const positionsMm = body.positionsMm.map((value, index) => value - center[index % 3]!);
    const component: ComponentInstance = {
      id: `component:solid-${crypto.randomUUID()}`,
      name: `${body.name} · component`.slice(0, 120),
      shape: "mesh",
      grounded: false,
      visible: true,
      color: body.color,
      translationMm: center,
      rotationDeg: [0, 0, 0],
      sizeMm: [0, 1, 2].map((axis) => Math.max(0.01, max[axis]! - min[axis]!)) as unknown as Vec3,
      explosionDirection: [0.2, -0.14, 0.62],
      mesh: { positionsMm, indices: body.indices, ...(body.brep === undefined ? {} : { faceTriangles: body.brep.faceTriangles }) }
    };
    if (!applyProjectOperation({ kind: "add-assembly-component", component })) return;
    switchWorkspace("assembly");
    setSelectedId(component.id);
    setStatus("ready");
    setStatusText(`Created an assembly component with the real geometry of ${body.name}. It is a snapshot: later Part edits are not associative.`);
  };

  const deleteAssemblyComponent = (componentId: string): void => {
    if (applyProjectOperation({ kind: "delete-assembly-component", componentId })) setSelectedId(null);
  };

  const insertElectricalComponent = (kind: ElectricalComponentKind): void => {
    const current = projectRef.current.electrical;
    const reference = nextElectricalReference(current.components.map((component) => component.reference), electricalReferencePrefix(kind));
    const position = nextElectricalPosition(current.components.map((component) => component.position));
    if (position === undefined) {
      setStatus("error");
      setStatusText("The schematic placement grid is full. Move or delete a device before inserting another one.");
      return;
    }
    const component = createElectricalComponentInstance(
      kind,
      `electrical-component:user-${crypto.randomUUID()}`,
      reference,
      position
    );
    if (applyProjectOperation({ kind: "add-electrical-component", component })) setSelectedId(component.id);
  };

  const requestElectromechanicalAssembly = (): void => {
    setElectromechanicalAcknowledged(false);
    setElectromechanicalReviewOpen(true);
    setStatus("ready");
    setStatusText("Review the exact circuit-to-panel replacement scope before generating the wired mounting plate.");
  };

  const generateElectromechanicalAssembly = (): void => {
    const electricalIntent = projectRef.current.electrical;
    const applied = applyProjectOperation({
      kind: "generate-electromechanical-realization",
      catalogRevision: ELECTROMECHANICAL_CATALOG_REVISION,
      layoutPreset: preferredElectromechanicalLayout(electricalIntent),
      mappings: defaultElectromechanicalMappings(electricalIntent),
      replaceMode: "replace-assembly"
    });
    if (applied) {
      setElectromechanicalReviewOpen(false);
      setElectromechanicalAcknowledged(false);
      switchWorkspace("assembly");
      window.requestAnimationFrame(() => globalThis.document.querySelector<HTMLElement>('[role="tab"][data-workspace="assembly"]')?.focus());
    }
  };

  const requestAssemblyTemplate = (template: ReplaceableAssemblyTemplate): void => {
    if (projectRef.current.assembly.template === template) {
      setStatus("ready");
      setStatusText("That assembly template is already active; no components or mates were replaced.");
      return;
    }
    // Templates replace every component and mate, so always ask first (one undoable revision either way).
    setPendingAssemblyTemplate(template);
    setStatus("ready");
    setStatusText(projectRef.current.assembly.electromechanicalSource === undefined
      ? "Review required before replacing the current assembly components and mates."
      : "Review required before replacing the linked electromechanical assembly.");
  };

  const requestElectricalTemplate = (template: ElectricalTemplateId): void => {
    setPendingElectricalTemplate(template);
    setStatus("ready");
    setStatusText("Review required before replacing the current schematic devices and nets.");
  };

  const requestVehicleTemplate = (template: VehicleTemplateId): void => {
    if (template === projectRef.current.vehicle.template) {
      setStatus("ready");
      setStatusText("The selected vehicle topology is already active; no parameters were reset.");
      return;
    }
    setPendingVehicleTemplate(template);
    setStatus("ready");
    setStatusText("Review required before replacing the current vehicle topology and engineering inputs.");
  };

  const cancelElectricalTemplateReview = (): void => {
    setPendingElectricalTemplate(undefined);
    setStatus("ready");
    setStatusText("Schematic replacement cancelled; the current devices and nets were preserved.");
  };

  const addElectricalNet = (fromKey: string, toKey: string, name: string, netClass: ElectricalNetClass): void => {
    const [fromComponentId, fromTerminal] = fromKey.split("|");
    const [toComponentId, toTerminal] = toKey.split("|");
    if (fromComponentId === undefined || fromTerminal === undefined || toComponentId === undefined || toTerminal === undefined) {
      setStatusText("Choose two valid component terminals.");
      return;
    }
    const net: ElectricalNet = {
      id: `electrical-net:user-${crypto.randomUUID()}`,
      name,
      class: netClass,
      endpoints: [{ componentId: fromComponentId, terminal: fromTerminal }, { componentId: toComponentId, terminal: toTerminal }]
    };
    if (applyProjectOperation({ kind: "add-electrical-net", net })) setSelectedId(net.id);
  };

  // Several ribbon buttons, tree rows, and commands target a virtual "action" id that is
  // not a selectable entity with its own inspector panel. Routing those through setSelectedId
  // would clear the live selection and render nothing, so handle them explicitly here with
  // honest guidance (and keep the real selection intact). Returns true when handled.
  const handleVirtualSelection = (selectionId: string): boolean => {
    if (selectionId.startsWith("design-health:")) {
      openDesignHealth();
      return true;
    }
    if (selectionId === "analysis:interference" || selectionId === "assembly-action:clearance") {
      const count = interferences.length;
      setStatusText(count === 0
        ? "Interference check: no visible-component AABB overlaps detected."
        : `Interference check: ${count} candidate overlap${count === 1 ? "" : "s"} flagged — review the Interference panel in the Assembly inspector.`);
      return true;
    }
    if (selectionId === "assembly-action:move") {
      const hasComponent = selectedId?.startsWith("component:") === true;
      setStatusText(hasComponent
        ? "Move: edit the selected component's X / Y / Z position in the Assembly inspector."
        : "Move: select a component in the viewport or tree first, then edit its X / Y / Z position in the Assembly inspector.");
      return true;
    }
    if (selectionId === "assembly-action:mates") {
      const firstMate = projectRef.current.assembly.mates[0];
      if (firstMate !== undefined) { setSelectedId(firstMate.id); setStatusText(`Selected ${firstMate.name}. Direct-mate records are listed in the Assembly inspector.`); }
      else setStatusText("No direct mates yet — add one from the Assembly inspector to create a fixed relationship.");
      return true;
    }
    if (selectionId === "electrical-action:nets" || selectionId === "electrical-action:erc") {
      // These ribbon and tree entries used to do nothing visible. Bring the matching panel into view and say what it shows.
      if (projectRef.current.activeWorkspace !== "electrical") switchWorkspace("electrical");
      const nets = selectionId === "electrical-action:nets";
      window.setTimeout(() => {
        const panel = globalThis.document.querySelector<HTMLElement>(nets ? ".electrical-wire-card" : ".electrical-erc-card");
        if (panel === null) { setStatusText(nets ? "The net editor is the Create net card in the Electrical panel." : "The electrical rule check card is in the Electrical panel."); return; }
        panel.scrollIntoView({ behavior: "smooth", block: "center" });
        panel.classList.add("palette-reveal");
        window.setTimeout(() => panel.classList.remove("palette-reveal"), 1400);
        const erc = projectRef.current.electrical;
        setStatusText(nets ? `Net editor: ${erc.nets.length} net${erc.nets.length === 1 ? "" : "s"}. Create a net between two terminals in the highlighted card; delete one from the Netlist.` : "Electrical rule check: the highlighted card lists every error and warning for the current devices and nets.");
      }, 60);
      return true;
    }
    if (selectionId === "electrical-action:bom") {
      setStatusText("The concept device index is drawn on the schematic sheet. Review the grouped device list on the Electrical workspace sheet (Download SVG to export).");
      return true;
    }
    if (selectionId.startsWith("vehicle-analysis:")) {
      const section = selectionId.slice("vehicle-analysis:".length);
      setStatusText(`Open the ${section} section in the Vehicle workspace Results panel to review these calculations.`);
      return true;
    }
    return false;
  };

  // Selection entry point for the ribbon and project tree: route virtual action ids to honest
  // feedback / the right panel; everything else selects normally.
  const routeSelection = (selectionId: string | null): void => {
    if (selectionId !== null && handleVirtualSelection(selectionId)) return;
    setSelectedId(selectionId);
  };

  // View / navigation / display commands act on the shared 3D viewport, so running one from
  // another 3D workspace must not switch workspace and drop the user's context (finding: Point measure).
  const isViewportGlobalAction = (kind: string): boolean =>
    kind === "fit-view" || kind === "set-view-orientation" || kind === "set-view-projection"
    || kind === "set-shading-mode" || kind === "set-background-tone" || kind === "set-navigation-mode"
    || kind === "set-selection-filter";

  const executeCadCommand = (command: CadCommandRecord): void => {
    const action = command.action;
    if (action.kind === "open-design-health") {
      openDesignHealth();
      return;
    }
    if (action.kind === "file-new") { setNewDialogOpen(true); return; }
    if (action.kind === "file-open") { void openProjectFromSystem(); return; }
    if (action.kind === "file-save") { void saveAll(); return; }
    if (action.kind === "file-save-as") { setSaveDialogMode("save-as"); return; }
    if (action.kind === "file-save-copy") { setSaveDialogMode("copy"); return; }
    if (action.kind === "file-workspace") { void connectFileWorkspace(); return; }
    if (action.kind === "open-render-studio") { openRenderStudio(); return; }
    if (!(isViewportGlobalAction(action.kind) && isThreeDimensional)) switchWorkspace(command.workspace);
    if (action.kind === "unavailable") {
      setSelectedId(command.id);
      setStatus("ready");
      setStatusText(`${command.name} is cataloged but unavailable: ${command.description}`);
      return;
    }
    switch (action.kind) {
      case "open-workspace":
        setStatusText(`Opened ${command.name}. ${command.description}`);
        break;
      case "finish-sketch":
        switchWorkspace("part");
        setStatusText("Sketch session finished. Revisioned sketch geometry remains linked to the Part workspace.");
        break;
      case "open-exchange-center":
        setExchangeOpen(true);
        setExchangeFeedback("Choose a local import, export, or PDF delivery workflow.");
        break;
      case "apply-electrical-template":
        requestElectricalTemplate(action.template);
        break;
      case "insert-electrical-component":
        insertElectricalComponent(action.componentKind);
        break;
      case "generate-electromechanical-realization":
        requestElectromechanicalAssembly();
        break;
      case "apply-vehicle-template":
        requestVehicleTemplate(action.template);
        break;
      case "set-vehicle-state":
        applyProjectOperation({ kind: "set-vehicle-simulation-state", state: action.state });
        break;
      case "toggle-vehicle-layer":
        applyProjectOperation({ kind: "toggle-vehicle-layer", layer: action.layer });
        break;
      case "activate-sketch-tool":
        activateSketchTool(action.tool, "from the command launcher");
        break;
      case "activate-sketch-dimension":
        activateSketchDimension("from the command launcher");
        break;
      case "activate-sketch-edit":
        activateSketchEdit(action.tool, "from the command launcher");
        break;
      case "sketch-command":
        runSketchCommand(action.command, "from the command launcher");
        break;
      case "select-record":
        if (handleVirtualSelection(action.selectionId)) break;
        setSelectedId(action.selectionId);
        setStatusText(`${command.name} selected. ${command.description}`);
        break;
      case "create-part-preview-body":
        createPartPreviewBody(action.shape);
        break;
      case "selected-part-preview-body-action":
        runSelectedPartPreviewAction(action.operation, command.name);
        break;
      case "part-feature-action":
        runPartFeatureAction(action.operation, command.name);
        break;
      case "set-part-preview-bodies-visibility":
        applyProjectOperation({ kind: "set-part-preview-bodies-visibility", visible: action.visible });
        break;
      case "insert-component":
        insertAssemblyComponent(action.shape);
        break;
      case "insert-current-part-into-assembly":
        insertCurrentPartIntoAssembly();
        break;
      case "apply-assembly-template":
        requestAssemblyTemplate(action.template);
        break;
      case "selected-component-action": {
        const componentId = selectedId?.startsWith("component:") === true ? selectedId : undefined;
        if (componentId === undefined) {
          setStatusText(`Select a component before running ${command.name}.`);
          break;
        }
        if (action.operation === "delete") deleteAssemblyComponent(componentId);
        if (action.operation === "toggle-grounded") applyProjectOperation({ kind: "toggle-component-grounded", componentId });
        if (action.operation === "toggle-visible") applyProjectOperation({ kind: "toggle-component-visibility", componentId });
        break;
      }
      case "set-surface-mode":
        applyProjectOperation({ kind: "set-surface-mode", mode: action.mode });
        break;
      case "fit-view":
        fitViewport();
        break;
      case "set-view-orientation":
        setViewportOrientation(action.orientation);
        break;
      case "set-view-projection":
        setViewportProjection(action.projection);
        break;
      case "set-shading-mode":
        if (viewportRef.current === undefined) setViewportState((currentState) => ({ ...currentState, shadingMode: action.mode }));
        else viewportRef.current.setShadingMode(action.mode);
        setStatusText(`${command.name} display mode active.`);
        break;
      case "set-background-tone":
        if (viewportRef.current === undefined) setViewportState((currentState) => ({ ...currentState, backgroundTone: action.tone }));
        else viewportRef.current.setBackgroundTone(action.tone);
        setStatusText(`${command.name} viewport background active.`);
        break;
      case "set-navigation-mode":
        setViewportNavigation(action.mode);
        break;
      case "set-selection-filter":
        setViewportSelectionFilter(action.filter);
        break;
      default:
        assertNever(action);
    }
  };

  const commitPartParameter = async (parameter: PartParameter, value: number): Promise<void> => {
    if (!Number.isFinite(value)) { setStatus("error"); setStatusText("Enter a finite part value."); return; }
    const qualifiedKey = QUALIFIED_PART_KEYS[parameter];
    if (qualifiedKey === undefined) { applyProjectOperation({ kind: "set-part-parameter", parameter, value }); return; }
    const client = clientRef.current;
    if (client === undefined || status === "working") return;
    setStatus("working");
    setStatusText(`Regenerating qualified ${qualifiedKey}…`);
    const response = await client.commit(documentRef.current.revision, {
      protocolVersion: 1,
      kind: "set-parameter",
      commandId: parameterCommandId(qualifiedKey, crypto.randomUUID()),
      expectedRevision: documentRef.current.revision,
      parameterKey: qualifiedKey,
      expression: { decimal: String(value), unit: "mm" }
    }).catch(() => undefined);
    if (response !== undefined) acceptResponse(response);
  };

  /** Rebuilds every timeline solid that depends on a sketch feature and applies the results (or flags the ones that failed). */
  const rebuildFrom = async (sketchFeatureId: string): Promise<void> => {
    const results = await rebuildDependents(projectRef.current, sketchFeatureId);
    if (results.length === 0) return;
    if (!applyProjectOperation({ kind: "regenerate-design", results }, false)) return;
    const failed = results.filter((result) => result.message !== undefined);
    setStatus(failed.length > 0 ? "error" : "ready");
    setStatusText(failed.length > 0
      ? `${failed.length} timeline step${failed.length === 1 ? "" : "s"} could not be rebuilt: ${failed[0]!.message}`
      : `Rebuilt ${results.length} timeline step${results.length === 1 ? "" : "s"} from the edited sketch.`);
  };

  /**
   * Brings the timeline up to date with the working sketch: a new sketch feature, or an update of the one being edited
   * (which rebuilds the solids built on it). Returns the sketch feature's ID, or undefined if there is nothing to finish.
   */
  const commitWorkingSketch = async (): Promise<string | undefined> => {
    const current = projectRef.current;
    const history = designOf(current);
    const editing = history.features.find((feature) => feature.id === history.editingSketchId && feature.kind === "sketch");
    if (current.sketch.entities.length === 0) return editing?.id;
    if (editing?.kind === "sketch" && JSON.stringify(editing.sketch) === JSON.stringify(current.sketch)) return editing.id;
    const ordinal = history.features.filter((feature) => feature.kind === "sketch").length + 1;
    if (!applyProjectOperation({ kind: "commit-design-sketch", featureId: `feature:sketch-${crypto.randomUUID()}`, name: `Sketch ${ordinal}` }, false)) return undefined;
    const sketchId = designOf(projectRef.current).editingSketchId ?? undefined;
    if (sketchId !== undefined && editing !== undefined) await rebuildFrom(sketchId);
    return sketchId;
  };

  const finishSketch = async (): Promise<void> => {
    setStatus("working");
    const sketchId = await commitWorkingSketch();
    setStatus("ready");
    switchWorkspace("part");
    setStatusText(sketchId === undefined
      ? "Sketch session finished. There was no closed geometry to record yet."
      : "Finished the sketch into the timeline. Extrude it with Create solid in the Sketch palette; editing it later rebuilds what is built on it.");
  };

  /** Extrude or revolve the working sketch's profiles into a new timeline feature and solid. */
  const createGeneralSolid = async (
    selectedProfileIds: readonly string[],
    _plane: SketchPlane,
    operation: "extrude" | "revolve" | "sweep" | "loft" | "edge-fillet" | "edge-chamfer" | "shell" | "draft" | "helix" | "thread" | "rib" | "dome" | "sheet-base" | "sheet-flange" | "sheet-hem",
    valueMm: number,
    edge?: { readonly kind: "chamfer" | "fillet"; readonly sizeMm: number },
    direction: "one-side" | "symmetric" | "flipped" = "one-side",
    target?: { readonly mode: "join" | "cut"; readonly bodyId: string; readonly extent?: "through-all" },
    advancedParams?: {
      readonly sweepDirectionMm?: readonly [number, number, number];
      readonly sweepPathEntityId?: string;
      readonly sweepTwistDeg?: number;
      readonly sweepFrameTransport?: boolean;
      readonly loftTopScale?: number;
      readonly loftSecondaryProfileIds?: readonly string[];
      readonly loftContinuity?: "position" | "tangent" | "curvature";
      readonly loftRailEntityId?: string;
      readonly loftTangencyWeight?: number;
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
      readonly shellThicknessMm?: number;
      readonly shellOpenFace?: "top" | "bottom" | "none";
      readonly draftAngleDeg?: number;
      readonly draftNeutralFace?: "top" | "bottom";
    }
  ): Promise<void> => {
    if (!Number.isFinite(valueMm) || valueMm <= 0) { setStatus("error"); setStatusText(operation === "revolve" ? "Enter a revolve angle between 1 and 360 degrees." : operation === "sweep" ? "Enter a positive sweep distance." : operation === "loft" ? "Enter a positive loft height." : "Enter a positive extrusion distance."); return; }
    if (operation === "sweep") {
      const direction = advancedParams?.sweepDirectionMm;
      const pathId = advancedParams?.sweepPathEntityId;
      if ((pathId === undefined || pathId.length === 0) && (direction === undefined || Math.hypot(direction[0], direction[1], direction[2]) < 1e-6)) {
        setStatus("error"); setStatusText("Sweep: pick a path entity or enter a non-zero direction."); return;
      }
    }
    if (operation === "loft") {
      const scale = advancedParams?.loftTopScale;
      const secondary = advancedParams?.loftSecondaryProfileIds;
      if (secondary !== undefined && secondary.length > 0) {
        // Two-profile loft: no top-scale required.
      } else if (scale === undefined || !Number.isFinite(scale) || scale <= 0) {
        setStatus("error"); setStatusText("Enter a positive loft top scale, or pick two profiles for a two-profile loft."); return;
      }
    }
    if (operation === "shell") {
      const thickness = advancedParams?.shellThicknessMm;
      if (thickness === undefined || !Number.isFinite(thickness) || thickness <= 0) { setStatus("error"); setStatusText("Enter a positive shell wall thickness."); return; }
    }
    if (operation === "draft") {
      const angle = advancedParams?.draftAngleDeg;
      if (angle === undefined || !Number.isFinite(angle) || angle <= 0 || angle >= 80) { setStatus("error"); setStatusText("Enter a draft angle between 0° and 80°."); return; }
    }
    if ((operation === "edge-fillet" || operation === "edge-chamfer") && (edge === undefined || edge.sizeMm <= 0)) {
      setStatus("error"); setStatusText(`Enter a positive ${operation === "edge-fillet" ? "fillet radius" : "chamfer distance"}.`); return;
    }
    if (detectSketchProfiles(projectRef.current.sketch).length === 0) { setStatus("error"); setStatusText("Draw or select a closed profile before creating a solid."); return; }
    setStatus("working");
    setStatusText(`Building ${operation === "extrude" ? "extruded" : operation === "revolve" ? "revolved" : operation === "sweep" ? "swept" : operation === "loft" ? "lofted" : operation === "edge-fillet" ? "filleted" : operation === "edge-chamfer" ? "chamfered" : operation === "shell" ? "shelled" : operation === "helix" ? "helical" : operation === "thread" ? "threaded" : operation === "rib" ? "ribbed" : operation === "dome" ? "domed" : operation === "sheet-base" ? "sheet-metal base" : operation === "sheet-flange" ? "sheet-metal flange" : operation === "sheet-hem" ? "hemmed" : "drafted"} solid…`);
    const sketchId = await commitWorkingSketch();
    const sketchFeature = designOf(projectRef.current).features.find((feature) => feature.id === sketchId);
    // A refused commit has already reported why (status and diagnostic); keep that message.
    if (sketchId === undefined) return;
    if (sketchFeature?.kind !== "sketch") { setStatus("error"); setStatusText("The sketch feature could not be found in the timeline."); return; }
    const ordinal = designOf(projectRef.current).features.filter((feature) => feature.kind === operation).length + 1;
    const targetBody = target === undefined ? undefined : projectRef.current.part.generalBodies?.find((body) => body.id === target.bodyId);
    if (target !== undefined && targetBody === undefined) { setStatus("error"); setStatusText(`Pick the solid to ${target.mode} first. Create a solid with New body, then ${target.mode} with another sketch.`); return; }
    const bodyId = targetBody?.id ?? `general-body:${crypto.randomUUID()}`;
    const verb = target === undefined
      ? (operation === "extrude" ? "Extrude"
        : operation === "revolve" ? "Revolve"
          : operation === "sweep" ? "Sweep"
            : operation === "loft" ? "Loft"
              : operation === "edge-fillet" ? "Fillet"
                : operation === "edge-chamfer" ? "Chamfer"
                  : operation === "shell" ? "Shell"
                    : operation === "helix" ? "Helix"
                      : operation === "thread" ? "Thread"
                        : operation === "rib" ? "Rib"
                          : operation === "dome" ? "Dome"
                            : operation === "sheet-base" ? "Sheet base"
                              : operation === "sheet-flange" ? "Flange"
                                : operation === "sheet-hem" ? "Hem"
                                  : "Draft")
      : target.mode === "cut" ? "Cut" : "Join";
    const feature: DesignSolidFeature = {
      id: `feature:${operation}-${crypto.randomUUID()}`,
      name: `${verb} ${target === undefined ? ordinal : designOf(projectRef.current).features.filter((candidate) => candidate.kind !== "sketch" && candidate.operation === target.mode).length + 1}`,
      kind: operation,
      suppressed: false,
      sketchFeatureId: sketchId,
      profileIds: selectedProfileIds,
      valueMm,
      bodyId,
      ...(operation === "extrude" && direction !== "one-side" ? { direction } : {}),
      ...(edge === undefined ? {} : { edge }),
      ...(target === undefined ? {} : { operation: target.mode }),
      ...(target?.extent === "through-all" && operation === "extrude" && target.mode === "cut" ? { extent: "through-all" as const } : {}),
      ...(operation === "sweep" && advancedParams?.sweepDirectionMm !== undefined && (advancedParams.sweepPathEntityId === undefined || advancedParams.sweepPathEntityId === "") ? { sweepDirectionMm: advancedParams.sweepDirectionMm } : {}),
      ...(operation === "sweep" && advancedParams?.sweepPathEntityId !== undefined && advancedParams.sweepPathEntityId !== "" ? { sweepPathEntityId: advancedParams.sweepPathEntityId } : {}),
      ...(operation === "sweep" && advancedParams?.sweepTwistDeg !== undefined ? { sweepTwistDeg: advancedParams.sweepTwistDeg } : {}),
      ...(operation === "sweep" && advancedParams?.sweepFrameTransport === true ? { sweepFrameTransport: true } : {}),
      ...(operation === "loft" && advancedParams?.loftRailEntityId !== undefined && advancedParams.loftRailEntityId !== "" ? { loftRailEntityId: advancedParams.loftRailEntityId } : {}),
      ...(operation === "loft" && advancedParams?.loftTangencyWeight !== undefined ? { loftTangencyWeight: advancedParams.loftTangencyWeight } : {}),
      ...(operation === "helix" && advancedParams?.helixRadiusMm !== undefined ? { helixRadiusMm: advancedParams.helixRadiusMm } : {}),
      ...(operation === "helix" && advancedParams?.helixPitchMm !== undefined ? { helixPitchMm: advancedParams.helixPitchMm } : {}),
      ...(operation === "helix" && advancedParams?.helixTurns !== undefined ? { helixTurns: advancedParams.helixTurns } : {}),
      ...(operation === "helix" && advancedParams?.helixHandedness !== undefined ? { helixHandedness: advancedParams.helixHandedness } : {}),
      ...(operation === "thread" && advancedParams?.threadPitchMm !== undefined ? { threadPitchMm: advancedParams.threadPitchMm } : {}),
      ...(operation === "thread" && advancedParams?.threadTurns !== undefined ? { threadTurns: advancedParams.threadTurns } : {}),
      ...(operation === "thread" && advancedParams?.threadDepthMm !== undefined ? { threadDepthMm: advancedParams.threadDepthMm } : {}),
      ...(operation === "thread" && advancedParams?.threadHandedness !== undefined ? { threadHandedness: advancedParams.threadHandedness } : {}),
      ...(operation === "rib" && advancedParams?.ribThicknessMm !== undefined ? { ribThicknessMm: advancedParams.ribThicknessMm } : {}),
      ...(operation === "rib" && advancedParams?.ribDirection !== undefined ? { ribDirection: advancedParams.ribDirection } : {}),
      ...(operation === "dome" && advancedParams?.domeHeightMm !== undefined ? { domeHeightMm: advancedParams.domeHeightMm } : {}),
      ...((operation === "sheet-base" || operation === "sheet-flange" || operation === "sheet-hem") && advancedParams?.sheetThicknessMm !== undefined ? { sheetThicknessMm: advancedParams.sheetThicknessMm } : {}),
      ...((operation === "sheet-flange" || operation === "sheet-hem") && advancedParams?.sheetBendRadiusMm !== undefined ? { sheetBendRadiusMm: advancedParams.sheetBendRadiusMm } : {}),
      ...((operation === "sheet-flange" || operation === "sheet-hem") && advancedParams?.flangeLengthMm !== undefined ? { flangeLengthMm: advancedParams.flangeLengthMm } : {}),
      ...(operation === "sheet-flange" && advancedParams?.flangeAngleDeg !== undefined ? { flangeAngleDeg: advancedParams.flangeAngleDeg } : {}),
      ...(operation === "sheet-hem" && advancedParams?.hemStyle !== undefined ? { hemStyle: advancedParams.hemStyle } : {}),
      ...(operation === "loft" && advancedParams?.loftTopScale !== undefined ? { loftTopScale: advancedParams.loftTopScale } : {}),
      ...(operation === "loft" && advancedParams?.loftSecondaryProfileIds !== undefined && advancedParams.loftSecondaryProfileIds.length > 0 ? { loftSecondaryProfileIds: advancedParams.loftSecondaryProfileIds } : {}),
      ...(operation === "loft" && advancedParams?.loftContinuity !== undefined ? { loftContinuity: advancedParams.loftContinuity } : {}),
      ...(operation === "shell" && advancedParams?.shellThicknessMm !== undefined ? { shellThicknessMm: advancedParams.shellThicknessMm } : {}),
      ...(operation === "shell" && advancedParams?.shellOpenFace !== undefined ? { shellOpenFace: advancedParams.shellOpenFace } : {}),
      ...(operation === "draft" && advancedParams?.draftAngleDeg !== undefined ? { draftAngleDeg: advancedParams.draftAngleDeg } : {}),
      ...(operation === "draft" && advancedParams?.draftNeutralFace !== undefined ? { draftNeutralFace: advancedParams.draftNeutralFace } : {})
    };
    // A join or cut builds its solid as a tool and combines it with the current shape of the body it modifies.
    // A through-all cut is sized across the target body here, the same way the timeline replay sizes it.
    const sized = feature.extent === "through-all" && targetBody !== undefined ? throughAllOverride(feature, sketchFeature, targetBody) : feature;
    const rebuilt = await rebuildSolidFeature(target === undefined ? feature : { ...sized, bodyId: `${feature.id}:tool` }, sketchFeature, targetBody?.color);
    if (!rebuilt.ok) { setStatus("error"); setStatusText(rebuilt.message); return; }
    let resultBody = rebuilt.body;
    if (targetBody !== undefined && target !== undefined) {
      const combined = await combineGeneralBodies({ target: targetBody, tool: rebuilt.body, mode: target.mode, bodyId: targetBody.id, name: targetBody.name });
      if (!combined.ok) { setStatus("error"); setStatusText(`${verb} did not change the solid: ${combined.message}`); return; }
      resultBody = { ...combined.body, color: targetBody.color };
    }
    if (applyProjectOperation({ kind: "add-design-solid", feature, body: resultBody }, false)) {
      switchWorkspace("part");
      setSelectedId(bodyId);
      setStatus("ready");
      const brep = resultBody.brep;
      const detail = brep !== undefined
        ? `${brep.origin === "mesh-boolean" ? "Boolean mesh" : "B-rep"} solid · ${brep.topology.vertices} vertices · ${brep.topology.edges} edges · ${brep.topology.faces} named faces`
        : `general mesh solid (${resultBody.positionsMm.length / 3} vertices)`;
      setStatusText(target === undefined
        ? `Added ${feature.name} to the timeline as a ${detail}. Double-click it in the timeline to edit, or edit the sketch and it rebuilds.`
        : `Added ${feature.name} to the timeline: ${target.mode === "cut" ? "cut from" : "joined to"} ${targetBody?.name ?? "the solid"} (${detail}). Edit the step or its sketch and the solid is rebuilt in order.`);
    }
  };

  /**
   * Applies an operation and then replays the timeline, as one undo step. Used when the design has joins or cuts, because
   * suppressing, rolling back, deleting or editing a step then changes the shape of a body, not only whether it is shown.
   * With `mustApply`, the change is refused (nothing is applied) when that feature cannot be rebuilt.
   */
  const commitWithReplay = async (intent: OperationIntent, mustApply?: string): Promise<boolean> => {
    const before = projectRef.current;
    const first = applyWorkbenchOperation(before, { ...intent, operationId: `operation:ui-${crypto.randomUUID()}`, expectedRevision: before.revision } as WorkbenchOperation);
    if (!first.ok) {
      const problem = first.diagnostics[0];
      setDiagnostic(problem === undefined ? undefined : { code: problem.code, message: problem.message, recovery: problem.recovery });
      setStatus("error");
      setStatusText(problem?.message ?? "The project operation was rejected.");
      return false;
    }
    let next = first.value.project;
    let summary = first.value.summary;
    if (hasModifiers(next) || hasModifiers(before)) {
      setStatus("working");
      setStatusText("Rebuilding the timeline…");
      const results = await replayAllBodies(next);
      if (projectRef.current !== before) { setStatus("ready"); setStatusText("The design changed while it was rebuilding, so that edit was not applied. Try it again."); return false; }
      const blocked = mustApply === undefined ? undefined : results.find((result) => result.featureId === mustApply && result.message !== undefined);
      if (blocked?.message !== undefined) { setStatus("error"); setStatusText(`Not applied: ${blocked.message}`); return false; }
      if (results.length > 0) {
        const second = applyWorkbenchOperation(next, { kind: "regenerate-design", results, operationId: `operation:ui-${crypto.randomUUID()}`, expectedRevision: next.revision } as WorkbenchOperation);
        if (second.ok) {
          next = second.value.project;
          const failed = results.filter((result) => result.message !== undefined);
          if (failed.length > 0) summary = `${summary} ${failed.length} step${failed.length === 1 ? "" : "s"} could not be applied: ${failed[0]!.message}`;
        }
      }
    }
    pushProject(next);
    setDiagnostic(undefined);
    setStatus("ready");
    setStatusText(summary);
    return true;
  };

  /** A timeline change that only shows or hides solids is cheap; once a body has joins or cuts it is replayed with the change. */
  const timelineOperation = (intent: OperationIntent, then?: () => void): void => {
    if (hasModifiers(projectRef.current)) { void commitWithReplay(intent).then((ok) => { if (ok) then?.(); }); return; }
    if (applyProjectOperation(intent)) then?.();
  };

  /** Applies an edited timeline solid: rebuilds it from its sketch with the new parameters. */
  const updateTimelineSolid = async (next: DesignSolidFeature): Promise<void> => {
    const history = designOf(projectRef.current);
    const sketchFeature = history.features.find((feature) => feature.id === next.sketchFeatureId);
    if (sketchFeature?.kind !== "sketch") return;
    setStatus("working");
    const existing = projectRef.current.part.generalBodies?.find((body) => body.id === next.bodyId);
    if (hasModifiers(projectRef.current) && existing !== undefined) {
      // The body is shaped by several steps, so the edit is applied and the whole body replayed, as one undo step.
      if (await commitWithReplay({ kind: "update-design-solid", feature: next, body: existing }, next.id)) setFeatureEdit(undefined);
      return;
    }
    const rebuilt = await rebuildSolidFeature(next, sketchFeature, existing?.color);
    if (!rebuilt.ok) { setStatus("error"); setStatusText(rebuilt.message); return; }
    if (applyProjectOperation({ kind: "update-design-solid", feature: next, body: rebuilt.body })) setFeatureEdit(undefined);
  };

  /** A timeline sketch is reopened for editing; a solid opens its parameter dialog. */
  const editTimelineFeature = (feature: DesignFeature): void => {
    if (feature.kind === "sketch") { applyProjectOperation({ kind: "edit-design-sketch", featureId: feature.id }); return; }
    setFeatureEdit(feature);
  };

  const changeUnit = async (unit: DisplayUnit): Promise<void> => {
    if (unit === documentRef.current.displayUnit || clientRef.current === undefined) return;
    setStatus("working");
    const response = await clientRef.current.commit(documentRef.current.revision, { protocolVersion: 1, kind: "set-display-unit", commandId: `command:display-unit-${crypto.randomUUID()}`, expectedRevision: documentRef.current.revision, displayUnit: unit }).catch(() => undefined);
    if (response !== undefined) acceptResponse(response);
  };

  const moveHistory = async (direction: "undo" | "redo"): Promise<boolean> => {
    const client = clientRef.current;
    if (client === undefined) { workerHistoryBusyRef.current = false; return false; }
    setStatus("working");
    const response = await client.history(documentRef.current.revision, direction, `command:${direction}-${crypto.randomUUID()}`).catch(() => undefined);
    // Navigation, not a new edit: suppress a chronological marker while the worker reverts/replays.
    workerNavigatingRef.current = true;
    let moved = false;
    try { moved = response !== undefined && acceptResponse(response); }
    finally { workerNavigatingRef.current = false; workerHistoryBusyRef.current = false; }
    return moved;
  };

  const moveProjectHistory = (direction: "undo" | "redo"): boolean => {
    const delta = direction === "undo" ? -1 : 1;
    const nextIndex = projectHistoryIndexRef.current + delta;
    if (nextIndex < 0 || nextIndex >= projectHistoryRef.current.length) return false;
    projectHistoryIndexRef.current = nextIndex;
    const stored = projectHistoryRef.current[nextIndex]!;
    // Preserve the user's current workspace across history navigation: activeWorkspace is a
    // view concern baked into each snapshot, so a broad undo/redo must not yank the user into
    // whatever workspace was active when that revision was recorded.
    const preservedWorkspace = projectRef.current.activeWorkspace;
    // Qualified part parameters are owned by the worker lane, so a broad restore must keep the
    // current worker values instead of reinstating whatever they were when this broad revision
    // was recorded (which would clobber worker state and desync the lanes).
    const currentPart = projectRef.current.part;
    const next = {
      ...stored,
      activeWorkspace: preservedWorkspace,
      part: { ...stored.part, widthMm: currentPart.widthMm, heightMm: currentPart.heightMm, thicknessMm: currentPart.thicknessMm, holeDiameterMm: currentPart.holeDiameterMm }
    };
    projectRef.current = next;
    setProject(next);
    setProjectUndoDepth(nextIndex);
    setProjectRedoDepth(projectHistoryRef.current.length - nextIndex - 1);
    void persistBroadProject(next).catch(() => undefined);
    // A successful restore supersedes any prior rejected-operation error state.
    setDiagnostic(undefined);
    setStatus("ready");
    setStatusText(`${direction === "undo" ? "Restored prior" : "Restored next"} broad project revision ${next.revision}.`);
    return true;
  };

  const serializeProjectText = (): string => `${JSON.stringify(projectRef.current, null, 2)}\n`;

  const prepareQualifiedWorker = async (next: WorkbenchProject): Promise<PreparedQualifiedWorker | undefined> => {
    let active = false;
    const candidate = new GeometryWorkerClient((message) => { if (active) restoreAfterFailure(message); });
    try {
      const candidateDocument = createQualifiedPartDocument(next, `document:${crypto.randomUUID()}`, documentRef.current.displayUnit);
      const response = await candidate.bootstrap(candidateDocument, false, null);
      if (response.status === "error") {
        candidate.dispose();
        acceptResponse(response);
        return undefined;
      }
      if (response.kind !== "model") {
        candidate.dispose();
        throw new Error("The qualified geometry worker did not return a synchronized model snapshot.");
      }
      return { client: candidate, response, activate: () => { active = true; } };
    } catch (error) {
      candidate.dispose();
      throw error;
    }
  };

  const activateQualifiedWorker = (prepared: PreparedQualifiedWorker): void => {
    const previous = clientRef.current;
    clientRef.current = prepared.client;
    prepared.activate();
    previous?.dispose();
    // Loading a project re-establishes a fresh baseline, not a new undoable edit.
    workerNavigatingRef.current = true;
    try { acceptModel(prepared.response); }
    finally { workerNavigatingRef.current = false; }
  };

  const saveVisibleProject = async (mode: "save" | "save-as" | "copy", suggestedName: string): Promise<void> => {
    const current = projectRef.current;
    const outcome = await saveProjectText(serializeProjectText(), {
      mode,
      suggestedName,
      projectName: current.name,
      revision: current.revision
    });
    await refreshFileWorkspace();
    // A copy leaves the working file unsaved; Save and Save-as make this revision the saved one.
    if (mode !== "copy") markProjectSaved(current.revision);
    setStatus("ready");
    setStatusText(`${outcome.fileName} saved to ${outcome.destination === "workspace" ? `${outcome.workspaceName ?? "PS CAD Studio"} / Projects` : outcome.destination === "file-picker" ? "the approved file location" : "Downloads"}.`);
  };

  const saveAll = async (): Promise<void> => {
    setStatus("working");
    try {
      await queueProjectTransition(async () => {
        await persistBroadProject(projectRef.current);
        const response = await clientRef.current?.persist(documentRef.current.revision);
        if (response !== undefined && !acceptResponse(response)) return;
        await saveVisibleProject("save", fileWorkspaceStatus.currentFileName ?? projectRef.current.name);
      });
    } catch (error) {
      if (isAbortError(error)) { setStatus("ready"); setStatusText("Save cancelled; the browser recovery copy is still current."); return; }
      setStatus("error"); setStatusText(fileErrorText(error, "Local save failed."));
    }
  };

  const openProjectPayload = async (payload: ProjectFilePayload): Promise<void> => {
    await queueProjectTransition(async () => {
      const parsed = parseWorkbenchProjectText(payload.text);
      if (!parsed.ok) {
        const first = parsed.diagnostics[0];
        setStatus("error");
        setStatusText(first?.message ?? "Project rejected. The active file remains unchanged.");
        return;
      }
      const previous = projectRef.current;
      const prepared = await prepareQualifiedWorker(parsed.value);
      if (prepared === undefined) return;
      try {
        await persistBroadProject(parsed.value);
        await commitOpenedProject(payload, parsed.value);
      } catch (error) {
        prepared.client.dispose();
        await persistBroadProject(previous).catch(() => undefined);
        throw error;
      }
      resetProject(parsed.value);
      activateQualifiedWorker(prepared);
      await refreshFileWorkspace();
      setRenderStudioOpen(false);
      setMasterCartOpen(false);
      setStatus("ready");
      setStatusText(`Opened ${payload.fileName}, project revision ${parsed.value.revision}, with one synchronized qualified-part snapshot.`);
    });
  };

  const openProjectFromSystem = async (): Promise<void> => {
    try {
      const payload = await openProjectWithPicker();
      if (payload === undefined) { projectInputRef.current?.click(); return; }
      await openProjectPayload(payload);
    } catch (error) {
      if (isAbortError(error)) { setStatusText("Open project cancelled."); return; }
      setStatus("error");
      setStatusText(fileErrorText(error, "The project could not be opened."));
    }
  };

  const openProject = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (file === undefined) return;
    try { await openProjectPayload(await readProjectFilePayload(file)); }
    catch (error) {
      setStatus("error");
      setStatusText(fileErrorText(error, "The selected project could not be opened."));
    }
  };

  const createNewProject = async (name = "Untitled design", startWorkspace: WorkspaceId = "part"): Promise<void> => {
    setStatus("working");
    try {
      await queueProjectTransition(async () => {
        const nextProject = { ...createWorkbenchProject(`project:${crypto.randomUUID()}`), name: name.trim().length === 0 ? "Untitled design" : name.trim(), activeWorkspace: startWorkspace };
        const previous = projectRef.current;
        const prepared = await prepareQualifiedWorker(nextProject);
        if (prepared === undefined) return;
        try {
          await persistBroadProject(nextProject);
          await clearCurrentProjectFile();
        } catch (error) {
          prepared.client.dispose();
          await persistBroadProject(previous).catch(() => undefined);
          throw error;
        }
        const imported = activeImportRef.current;
        imported?.releaseResources();
        if (imported !== undefined) disposeExchangeObject(imported.object);
        activeImportRef.current = undefined;
        setActiveImport(undefined);
        setSelectedId(null);
        setMeasurePoints([]);
        setMasterCartOpen(false);
        setRenderStudioOpen(false);
        resetProject(nextProject);
        activateQualifiedWorker(prepared);
        await refreshFileWorkspace();
        setStatus("ready");
        setStatusText(`Created new design "${nextProject.name}" in the ${startWorkspace} environment with a clean, synchronized history.`);
      });
    } catch (error) {
      setStatus("error");
      setStatusText(fileErrorText(error, "A new design could not be created."));
    }
  };

  const reopenRecentProject = async (id: string): Promise<void> => {
    setStatus("working");
    try { await openProjectPayload(await openRecentProject(id)); }
    catch (error) {
      if (isAbortError(error)) { setStatus("ready"); setStatusText("Recent project opening cancelled."); return; }
      setStatus("error"); setStatusText(fileErrorText(error, "The recent project could not be reopened."));
    }
  };

  const connectFileWorkspace = async (): Promise<void> => {
    try {
      setStatus("working");
      const connected = await initializePsCadWorkspace();
      setFileWorkspaceStatus(connected);
      setRecentProjects(await listRecentProjects());
      setStatus("ready");
      setStatusText(`Connected ${connected.folderName} with Projects, Exports, Renders, Recovery, and Cache folders.`);
    } catch (error) {
      if (isAbortError(error)) { setStatus("ready"); setStatusText("Folder connection cancelled; browser-private recovery remains available."); return; }
      setStatus("error"); setStatusText(fileErrorText(error, "The PS CAD Studio folder could not be connected."));
    }
  };

  const recoverAutosave = async (): Promise<void> => {
    setStatus("working");
    try {
      await queueProjectTransition(async () => {
        const recovered = await loadCachedWorkbenchProject();
        if (recovered === undefined) { setStatus("ready"); setStatusText("No validated browser-private autosave is available."); return; }
        const previous = projectRef.current;
        const prepared = await prepareQualifiedWorker(recovered);
        if (prepared === undefined) return;
        try {
          await persistBroadProject(recovered);
          await clearCurrentProjectFile();
        } catch (error) {
          prepared.client.dispose();
          await persistBroadProject(previous).catch(() => undefined);
          throw error;
        }
        resetProject(recovered);
        activateQualifiedWorker(prepared);
        await refreshFileWorkspace();
        setMasterCartOpen(false);
        setRenderStudioOpen(false);
        setStatus("ready");
        setStatusText(`Recovered project revision ${recovered.revision} as an unsaved synchronized session. Use Save As to create a visible file.`);
      });
    } catch (error) {
      setStatus("error"); setStatusText(error instanceof Error ? error.message : "Autosave recovery failed.");
    }
  };

  const clearFileCaches = async (): Promise<void> => {
    try {
      await clearPsCadCaches();
      await refreshFileWorkspace();
      setStatus("ready");
      setStatusText("Browser-private PS3D render thumbnails and recovery caches were cleared; visible project files were not removed.");
    } catch (error) {
      setStatus("error"); setStatusText(error instanceof Error ? error.message : "The browser-private caches could not be cleared.");
    }
  };

  const confirmSaveDialog = async (fileName: string): Promise<void> => {
    const mode = saveDialogMode;
    setSaveDialogMode(undefined);
    if (mode === undefined) return;
    setStatus("working");
    try {
      await queueProjectTransition(async () => {
        await persistBroadProject(projectRef.current);
        await saveVisibleProject(mode, fileName);
      });
    } catch (error) {
      if (isAbortError(error)) { setStatus("ready"); setStatusText("Save cancelled; the active project was not rebound."); return; }
      setStatus("error");
      setStatusText(fileErrorText(error, "The project file could not be written."));
    }
  };

  const fitRenderViewport = (): void => {
    const viewport = renderViewportRef.current;
    if (viewport === undefined) return;
    if (renderSettings.source === "part" && activeImportRef.current !== undefined) viewport.fitCurrent();
    else if (renderSettings.source === "part") viewport.fitPreview(partScene.boundsMm);
    if (renderSettings.source === "assembly") viewport.fitPreview(assemblyScene.boundsMm);
    if (renderSettings.source === "surface") viewport.fitPreview(surfacePreview.scene.boundsMm);
    if (renderSettings.source === "vehicle") viewport.fitPreview(vehiclePreview.scene.boundsMm);
  };

  const renderStudioImage = async (): Promise<void> => {
    const viewport = renderViewportRef.current;
    if (viewport === undefined || renderBusy) return;
    setRenderBusy(true);
    setStatus("working");
    try {
      const [width, height] = renderResolutionSize(renderSettings.resolution);
      const image = await viewport.captureRenderImage(width, height, renderSettings.format, renderSettings.quality);
      const extension = renderSettings.format === "png" ? "png" : "jpg";
      const timestamp = new Date().toISOString().replace(/[:.]/gu, "-");
      const fileName = `${safeFileStem(projectRef.current.name)}-${renderSettings.source}-r${projectRef.current.revision}-${timestamp}.${extension}`;
      const renderBuffer = new ArrayBuffer(image.bytes.byteLength);
      new Uint8Array(renderBuffer).set(image.bytes);
      const blob = new Blob([renderBuffer], { type: image.mimeType });
      const written = await writeWorkspaceArtifact("Renders", fileName, blob);
      if (!written) downloadBlob(blob, fileName);
      const entry: RenderGalleryEntry = {
        id: `render:${crypto.randomUUID()}`,
        fileName,
        width: image.width,
        height: image.height,
        format: renderSettings.format,
        createdAt: new Date().toISOString(),
        destination: written ? "workspace" : "download"
      };
      setRenderGallery((current) => [entry, ...current].slice(0, 24));
      setStatus("ready");
      setStatusText(`Rendered ${image.width} × ${image.height} ${renderSettings.format.toUpperCase()} to ${written ? "PS CAD Studio / Renders" : "Downloads"}.`);
    } catch (error) {
      setStatus("error"); setStatusText(error instanceof Error ? error.message : "Render output failed.");
    } finally { setRenderBusy(false); }
  };

  const openNative = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (file === undefined || file.size > 1_000_000) { setStatusText("Choose a native JSON file no larger than 1 MB."); return; }
    const parsed = await parseNativeRevisionText(await file.text());
    if (!parsed.ok || clientRef.current === undefined) { setStatusText(parsed.ok ? "Geometry worker unavailable." : parsed.diagnostics[0]?.message ?? "Native file rejected."); return; }
    clientRef.current.restart();
    const response = await clientRef.current.bootstrap(parsed.value.document, false, parsed.value.evidence);
    if (response.status === "error" || response.kind !== "model") acceptResponse(response);
    else {
      await clientRef.current.persist(response.currentRevision);
      // Importing a native revision re-bootstraps a fresh worker session, so re-baseline the shared
      // history timeline (like every other worker-replacing path) before syncing — otherwise stale
      // lane markers would drive Undo/Redo against a worker that no longer has that history.
      resetProject(projectRef.current);
      workerNavigatingRef.current = true;
      try { acceptModel(response); } finally { workerNavigatingRef.current = false; }
      setStatusText(`Imported and validated native solid revision ${response.currentRevision}.`);
    }
  };

  const downloadNative = async (): Promise<void> => {
    if (modelRef.current === undefined) return;
    const serialized = await serializeNativeRevision({ document: documentRef.current, evidence: modelRef.current.evidence });
    if (!serialized.ok) return;
    downloadBlob(new Blob([serialized.value], { type: "application/json" }), exportFileName(projectRef.current.name, "plate", "ps3d.json"));
    // This file is the qualified plate alone; say so when the design holds more, so nothing is lost by surprise.
    const solids = (projectRef.current.part.generalBodies ?? []).length;
    setStatusText(solids === 0
      ? "Saved the qualified mounting plate (plate JSON)."
      : `Saved the qualified mounting plate only. Your ${solids} solid${solids === 1 ? "" : "s"}, sketches and timeline are not in this file: use File > Save project to keep them.`);
  };

  const exportStl = async (): Promise<void> => {
    // The qualified STL describes the plate alone. With any other body shown, export what is on screen instead.
    const current = projectRef.current;
    const otherShown = (current.part.generalBodies ?? []).some((body) => body.visible) || (current.part.previewBodies ?? []).some((body) => body.visible);
    if (otherShown && activeImportRef.current === undefined) { await exportExchangeFormat("stl", documentRef.current.displayUnit); return; }
    const response = await clientRef.current?.exportStl(documentRef.current.revision, documentRef.current.displayUnit);
    if (response === undefined || !acceptResponse(response) || response.kind !== "export-stl") return;
    downloadBlob(new Blob([response.bytes], { type: "model/stl" }), exportFileName(projectRef.current.name, `plate-${response.unit}`, "stl"));
    setStatusText(`Exported ${response.triangleCount} validated STL triangles in ${response.unit}.`);
  };

  const importExchangeFiles = async (files: readonly File[], unit: ExchangeUnit): Promise<void> => {
    if (exchangeBusy) return;
    setExchangeBusy(true);
    setExchangeFeedback("Parsing the selected model and local companions…");
    try {
      const result = await importReferenceModel(files, { unit });
      const previous = activeImportRef.current;
      previous?.releaseResources();
      if (previous !== undefined) disposeExchangeObject(previous.object);
      activeImportRef.current = result;
      setActiveImport(result);
      if (projectRef.current.activeWorkspace !== "part") switchWorkspace("part");
      setSelectedId(null);
      setMeasurePoints([]);
      const summary = `Imported ${result.primaryFileName}: ${result.metrics.meshCount} meshes, ${result.metrics.triangleCount.toLocaleString()} triangles, source unit ${result.sourceUnit}.`;
      setExchangeFeedback(summary);
      setStatus("ready");
      setStatusText(`${summary} Reference geometry is not a parametric feature conversion.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "The local 3D import failed.";
      setExchangeFeedback(`Import failed: ${message}`);
      setStatus("error");
      setStatusText(message);
    } finally {
      setExchangeBusy(false);
    }
  };

  const clearActiveImport = (): void => {
    const imported = activeImportRef.current;
    imported?.releaseResources();
    if (imported !== undefined) disposeExchangeObject(imported.object);
    activeImportRef.current = undefined;
    setActiveImport(undefined);
    setSelectedId(null);
    setMeasurePoints([]);
    setExchangeFeedback("Returned to the native PS3D qualified body.");
    setStatus("ready");
    setStatusText("Returned to the native PS3D qualified body; the imported reference was released.");
  };

  const withExchangeSource = async (action: (source: import("three").Object3D, sourceLabel: string) => Promise<void>): Promise<void> => {
    const imported = projectRef.current.activeWorkspace === "part" ? activeImportRef.current : undefined;
    if (imported !== undefined) { await action(imported.object, `${imported.format.name} / ${imported.primaryFileName}`); return; }
    const viewport = viewportRef.current;
    if (viewport === undefined) throw new Error("Open a 3D workspace before exporting the visible scene.");
    const snapshot = viewport.snapshotExchangeObject();
    try { await action(snapshot, `${projectRef.current.activeWorkspace} workspace`); }
    finally { disposeExchangeObject(snapshot); }
  };

  const exportExchangeFormat = async (format: ExchangeExportFormat, unit: Exclude<ExchangeUnit, "auto">): Promise<void> => {
    if (exchangeBusy) return;
    setExchangeBusy(true);
    setExchangeFeedback(`Preparing ${format.toUpperCase()} from the visible scene…`);
    try {
      await withExchangeSource(async (source) => {
        const result = await exportExchangeObject(source, { format, unit, binary: true, fileStem: projectRef.current.name });
        downloadBlob(result.blob, result.fileName);
        setExchangeFeedback(`Exported ${result.fileName}. ${result.warning}`);
        setStatusText(`Exported ${result.fileName}. ${result.warning}`);
      });
      setStatus("ready");
    } catch (error) {
      const message = error instanceof Error ? error.message : "The 3D export failed.";
      setExchangeFeedback(`Export failed: ${message}`);
      setStatus("error");
      setStatusText(message);
    } finally { setExchangeBusy(false); }
  };

  const exportPdfPackage = async (): Promise<void> => {
    if (exchangeBusy) return;
    setExchangeBusy(true);
    setExchangeFeedback("Capturing the viewport and attaching a GLB to the PDF model package…");
    try {
      await withExchangeSource(async (source, sourceLabel) => {
        const viewport = viewportRef.current;
        if (viewport === undefined) throw new Error("A visible 3D viewport is required for the PDF preview image.");
        const [preview, glbBytes] = await Promise.all([viewport.capturePreviewJpeg(), exportGlbBytes(source)]);
        const metrics = activeImportRef.current?.object === source ? activeImportRef.current.metrics : inspectExchangeObject(source);
        const blob = buildPdfModelPackage({ title: `${projectRef.current.name} - 3D model package`, projectName: projectRef.current.name, sourceLabel, metrics, preview, glbBytes });
        downloadBlob(blob, `${safeFileStem(projectRef.current.name)}-3d-model-package.pdf`);
      });
      setExchangeFeedback("Exported a PDF model report with the visible scene attached as ps3d-model.glb. This is not mislabeled as interactive U3D/PRC.");
      setStatus("ready");
      setStatusText("PDF model package exported with viewport audit page and embedded GLB attachment.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "The PDF model package failed.";
      setExchangeFeedback(`PDF export failed: ${message}`);
      setStatus("error");
      setStatusText(message);
    } finally { setExchangeBusy(false); }
  };

  const exportInteractivePdf = async (file: File): Promise<void> => {
    if (exchangeBusy) return;
    setExchangeBusy(true);
    setExchangeFeedback(`Embedding ${file.name} as an interactive 3D annotation…`);
    try {
      if (file.size <= 0 || file.size > 200 * 1024 * 1024) throw new Error("Choose a non-empty U3D or PRC payload no larger than 200 MB.");
      const extension = file.name.toLowerCase().split(".").at(-1);
      if (extension !== "u3d" && extension !== "prc") throw new Error("Interactive 3D PDF pass-through accepts only .u3d or .prc payloads.");
      const blob = buildInteractive3dPdf({ title: `${projectRef.current.name} - interactive 3D`, payloadName: file.name, payloadBytes: new Uint8Array(await file.arrayBuffer()), subtype: extension === "u3d" ? "U3D" : "PRC" });
      downloadBlob(blob, `${safeFileStem(projectRef.current.name)}-interactive-${extension}.pdf`);
      setExchangeFeedback(`Exported a true PDF 3D annotation using the supplied ${extension.toUpperCase()} payload unchanged. Compatible viewers may require explicit trust.`);
      setStatus("ready");
      setStatusText(`Interactive ${extension.toUpperCase()} PDF pass-through exported.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Interactive 3D PDF export failed.";
      setExchangeFeedback(`PDF export failed: ${message}`);
      setStatus("error");
      setStatusText(message);
    } finally { setExchangeBusy(false); }
  };

  const fitViewport = (): void => {
    if (projectRef.current.activeWorkspace === "sketch") { setSketchFitSerial((serial) => serial + 1); return; }
    if (projectRef.current.activeWorkspace === "part" && activeImportRef.current !== undefined) viewportRef.current?.fitCurrent();
    else if (projectRef.current.activeWorkspace === "part") viewportRef.current?.fitPreview(partScene.boundsMm);
    if (projectRef.current.activeWorkspace === "assembly") viewportRef.current?.fitPreview(assemblyScene.boundsMm);
    if (projectRef.current.activeWorkspace === "surface") viewportRef.current?.fitPreview(surfacePreview.scene.boundsMm);
    if (projectRef.current.activeWorkspace === "vehicle") viewportRef.current?.fitPreview(vehiclePreview.scene.boundsMm);
  };
  fitViewportRef.current = fitViewport;

  const setViewportNavigation = (mode: NavigationMode): void => {
    if (viewportRef.current === undefined) setViewportState((current) => ({ ...current, navigationMode: mode }));
    else viewportRef.current.setNavigationMode(mode);
    setStatusText(mode === "measure" ? "Measure active: pick two visible model points." : `${mode[0]!.toUpperCase()}${mode.slice(1)} navigation active.`);
  };

  const activateSketchEdit = (tool: SketchEditToolId, source: string): void => {
    if (projectRef.current.activeWorkspace !== "sketch") switchWorkspace("sketch");
    if (sketchEditTool === tool) {
      setSketchEditTool(null);
      setStatusText(`${SKETCH_EDIT_TOOL_LABELS[tool]} closed.`);
      return;
    }
    setSketchTool("select");
    setSketchDimensionMode(false);
    setSketchCheckOpen(false);
    setViewportNavigation("select");
    setViewportSelectionFilter("sketch-curve");
    setSketchEditTool(tool);
    const how = tool === "trim" ? "click a curve where you want it cut" : tool === "extend" ? "click a line near the end to lengthen" : tool === "split" ? "click a curve where you want it cut in two" : tool === "jog" ? "set the step in the right panel, then click a line" : tool === "delete-curve" ? "click a curve to delete it and heal the gap" : tool === "make-path" ? "select the curves of the path to see how they chain" : tool === "dynamic-mirror" ? "select the mirror line, then Start in the right panel" : "select the geometry (Shift-click for more), set the values in the right panel, then Apply";
    setStatusText(`${SKETCH_EDIT_TOOL_LABELS[tool]} active ${source}: ${how}.`);
  };

  const runSketchCommand = (command: "fix-curve" | "relax-relations" | "relax-dimensions" | "show-movable" | "sketch-check", source: string): void => {
    if (projectRef.current.activeWorkspace !== "sketch") switchWorkspace("sketch");
    if (command === "show-movable") {
      setSketchShowMovable((current) => !current);
      setStatusText(sketchShowMovable ? "Movable geometry highlight off." : `Movable geometry highlighted ${source}: entities with estimated degrees of freedom are shown in amber.`);
      return;
    }
    if (command === "sketch-check") {
      setSketchCheckOpen((current) => !current);
      setStatusText(sketchCheckOpen ? "Sketch checking closed." : `Sketch checking opened ${source}; the report is in the right panel.`);
      return;
    }
    setSketchRequest((current) => ({ command, serial: (current?.serial ?? 0) + 1 }));
  };

  const activateSketchTool = (tool: SketchTool, source: string): void => {
    setSketchTool(tool);
    setSketchEditTool(null);
    setSketchDimensionMode(false);
    if (tool !== "select") setViewportNavigation("select");
    setStatusText(tool === "select"
      ? `Select tool active ${source}: click curves or shaded profiles, or drag a box to pick several.`
      : `${sketchToolLabel(tool)} tool active ${source}: click to place points; the wheel zooms, a middle or Space drag pans, Esc cancels.`);
  };

  const activateSketchDimension = (source: string): void => {
    if (projectRef.current.activeWorkspace !== "sketch") switchWorkspace("sketch");
    setSketchTool("select");
    setSketchEditTool(null);
    setViewportNavigation("select");
    setViewportSelectionFilter("sketch-curve");
    setSketchDimensionMode(true);
    setStatusText(`Sketch Dimension active ${source}: select a curve or two displayed definition points, then edit the driving value in the inspector.`);
  };

  const setViewportSelectionFilter = (filter: SelectionFilter): void => {
    if (viewportRef.current === undefined) setViewportState((current) => ({ ...current, selectionFilter: filter }));
    else viewportRef.current.setSelectionFilter(filter);
    const switchedTool = projectRef.current.activeWorkspace === "sketch" && sketchTool !== "select";
    if (switchedTool) { setSketchTool("select"); setSketchDimensionMode(false); }
    const switchedNav = viewportState.navigationMode === "orbit" || viewportState.navigationMode === "pan";
    if (switchedNav) setViewportNavigation("select");
    const notes = [switchedTool ? "switched to the Select tool" : "", switchedNav ? "NAV set to Select" : ""].filter(Boolean).join(" and ");
    setStatusText(`${filter === "auto" ? "Automatic" : filter} selection priority active${notes === "" ? "" : ` (${notes} so picks work)`}.`);
  };

  const setViewportOrientation = (orientation: Exclude<ViewOrientation, "custom">): void => {
    if (viewportRef.current === undefined) {
      const [azimuthDeg, elevationDeg] = viewAnglesForOrientation(orientation);
      setViewportState((current) => ({ ...current, orientation, azimuthDeg, elevationDeg }));
    } else viewportRef.current.setOrientation(orientation);
    setStatusText(`${orientation[0]!.toUpperCase()}${orientation.slice(1)} view active.`);
  };

  const setViewportProjection = (projection: ViewProjection): void => {
    if (viewportRef.current === undefined) setViewportState((current) => ({ ...current, projection }));
    else viewportRef.current.setProjection(projection);
    setStatusText(`${projection === "orthographic" ? "Orthographic" : "Perspective"} projection active.`);
  };

  const setViewportAngles = (azimuthDeg: number, elevationDeg: number): void => {
    if (viewportRef.current === undefined) setViewportState((current) => ({ ...current, orientation: "custom", azimuthDeg: Math.round(azimuthDeg * 10) / 10, elevationDeg: Math.round(elevationDeg * 10) / 10 }));
    else viewportRef.current.setViewAngles(azimuthDeg, elevationDeg);
  };

  const setViewportGrid = (visible: boolean): void => {
    if (viewportRef.current === undefined) setViewportState((current) => ({ ...current, gridVisible: visible }));
    else viewportRef.current.setGridVisible(visible);
  };

  const setViewportAxes = (visible: boolean): void => {
    if (viewportRef.current === undefined) setViewportState((current) => ({ ...current, axesVisible: visible }));
    else viewportRef.current.setAxesVisible(visible);
  };

  const homeViewport = (): void => {
    if (projectRef.current.activeWorkspace === "sketch") { fitViewport(); setStatusText("Fitted the sketch to the window."); return; }
    viewportRef.current?.setOrientation("isometric");
    if (viewportRef.current === undefined) setViewportOrientation("isometric");
    fitViewport();
    setStatusText("Isometric home view fitted to visible geometry.");
  };

  const runContextCommand = (commandId: string): void => {
    const selectionId = contextMenu?.selectionId ?? selectedId;
    setContextMenu(undefined);
    if (commandId === "history.undo") { historyActionRef.current.undo(); return; }
    if (commandId === "history.redo") { historyActionRef.current.redo(); return; }
    if (commandId === "view.fit") { fitViewport(); return; }
    if (commandId === "view.home") { homeViewport(); return; }
    if (commandId.startsWith("view.orientation.")) {
      const orientation = commandId.slice("view.orientation.".length);
      if (orientation === "front" || orientation === "top" || orientation === "right" || orientation === "isometric") setViewportOrientation(orientation);
      return;
    }
    if (commandId === "view.projection.perspective") { setViewportProjection("perspective"); return; }
    if (commandId === "view.projection.orthographic") { setViewportProjection("orthographic"); return; }
    if (commandId === "sketch.look-at" && projectRef.current.activeWorkspace === "sketch") { setSketchFitSerial((serial) => serial + 1); setStatusText("The sketch is always shown face-on; fitted it to the window."); return; }
    if (commandId === "view.look-at" || commandId === "sketch.look-at") { setViewportOrientation(selectionId === "datum:yz" ? "right" : selectionId === "datum:xz" ? "front" : "top"); return; }
    if (commandId === "inspect.measure") { setViewportNavigation("measure"); return; }
    if (commandId === "sketch.create" || commandId === "sketch.edit") {
      // Creating a sketch on a datum plane from the tree or a right-click moves the sketch onto that plane.
      if ((selectionId === "datum:xy" || selectionId === "datum:xz" || selectionId === "datum:yz") && projectRef.current.sketch.plane !== selectionId) applyProjectOperation({ kind: "set-sketch-plane", plane: selectionId });
      switchWorkspace("sketch");
      if (selectionId !== null && !selectionId.startsWith("datum:")) setSelectedId(selectionId);
      return;
    }
    if (commandId === "sketch.finish") { void finishSketch(); return; }
    if (commandId === "sketch.select-profile" || commandId === "sketch.select-curve" || commandId === "sketch.select-connected" || commandId === "sketch.select-tangent") {
      if (projectRef.current.activeWorkspace !== "sketch") switchWorkspace("sketch");
      setViewportSelectionFilter(commandId === "sketch.select-profile" ? "profile" : commandId === "sketch.select-curve" ? "sketch-curve" : commandId === "sketch.select-connected" ? "connected" : "tangent");
      if (selectionId !== null) setSelectedId(selectionId);
      return;
    }
    if (commandId === "sketch.dimension") {
      activateSketchDimension("from the context menu");
      if (selectionId !== null) setSelectedId(selectionId);
      return;
    }
    if (commandId === "feature.extrude") { switchWorkspace("sketch"); if (selectionId !== null) setSelectedId(selectionId); setStatusText("Extrude ready: review the selected closed profile and operation in the right inspector."); return; }
    if (commandId === "body.boolean-join") { runPartFeatureAction("unite", "Unite", selectionId); return; }
    if (commandId === "body.boolean-cut") { runPartFeatureAction("subtract", "Subtract", selectionId); return; }
    if (commandId === "body.move-face") { runPartFeatureAction("move-face", "Move Face", selectionId); return; }
    if (commandId === "body.offset-face") { runPartFeatureAction("offset-face", "Offset Face", selectionId); return; }
    if (commandId === "body.replace-face") { runPartFeatureAction("replace-face", "Replace Face", selectionId); return; }
    if (commandId === "body.delete-face") { runPartFeatureAction("delete-face", "Delete Face", selectionId); return; }
    if (commandId === "body.edge-blend") { runPartFeatureAction("edge-blend", "Edge Blend", selectionId); return; }
    if (commandId === "body.chamfer") { runPartFeatureAction("chamfer", "Chamfer", selectionId); return; }
    if (commandId === "body.resize-blend") { runPartFeatureAction("resize-blend", "Resize Blend", selectionId); return; }
    if (commandId === "body.shell") { runPartFeatureAction("shell", "Shell", selectionId); return; }
    if (commandId === "body.draft") { runPartFeatureAction("draft", "Draft", selectionId); return; }
    if (commandId === "body.trim") { runPartFeatureAction("trim-body", "Trim Body", selectionId); return; }
    if (commandId === "body.pattern-feature") { runPartFeatureAction("pattern-feature", "Pattern Feature", selectionId); return; }
    if (commandId === "body.mirror-feature") { runPartFeatureAction("mirror-feature", "Mirror Feature", selectionId); return; }
    if (commandId === "body.update-model") { runPartFeatureAction("update-model", "Update Model"); return; }
    if (commandId === "feature.edit" || commandId === "body.appearance" || commandId === "body.move") { switchWorkspace("part"); if (selectionId !== null) setSelectedId(selectionId); return; }
    if (commandId === "feature.reveal-inputs") { switchWorkspace("sketch"); setSelectedId(projectRef.current.sketch.id); setTreeRevealRequest((request) => request + 1); return; }
    if (commandId === "body.boolean-intersect" && selectionId?.startsWith("general-body:") === true) { if ((projectRef.current.part.generalBodies ?? []).length < 2) { setStatusText("Intersect needs a second solid body. Create another with Make solid first."); return; } setCombineRequest({ targetId: selectionId, mode: "intersect" }); return; }
    if (commandId === "body.create-component") {
      if (selectionId?.startsWith("general-body:") === true) { createComponentFromGeneralBody(selectionId); return; }
      if (selectionId?.startsWith("part-body:") === true) {
        const body = (projectRef.current.part.previewBodies ?? []).find((candidate) => candidate.id === selectionId);
        if (body !== undefined) { createComponentFromPartBody(body); return; }
      }
      insertCurrentPartIntoAssembly();
      return;
    }
    if (commandId === "component.move" || commandId === "mate.create" || commandId === "mate.edit") { switchWorkspace("assembly"); if (selectionId !== null) setSelectedId(selectionId); return; }
    if (commandId === "component.ground" && selectionId !== null) { applyProjectOperation({ kind: "toggle-component-grounded", componentId: selectionId }); return; }
    if (commandId === "selection.toggle-visibility" && selectionId !== null) {
      if (selectionId.startsWith("entity:")) applyProjectOperation({ kind: "toggle-sketch-entity-visibility", entityId: selectionId });
      else if (selectionId.startsWith("component:")) applyProjectOperation({ kind: "toggle-component-visibility", componentId: selectionId });
      else if (selectionId.startsWith("part-body:")) applyProjectOperation({ kind: "toggle-part-preview-body-visibility", bodyId: selectionId });
      else if (selectionId.startsWith("general-body:")) applyProjectOperation({ kind: "toggle-general-body-visibility", bodyId: selectionId });
      return;
    }
    if (commandId === "selection.isolate" && selectionId?.startsWith("part-body:") === true) { applyProjectOperation({ kind: "isolate-part-preview-body", bodyId: selectionId }); return; }
    if (commandId === "selection.delete" && selectionId !== null) {
      if (selectionId.startsWith("entity:")) applyProjectOperation({ kind: "delete-sketch-entity", entityId: selectionId });
      else if (selectionId.startsWith("part-body:")) applyProjectOperation({ kind: "delete-part-preview-body", bodyId: selectionId });
      else if (selectionId.startsWith("general-body:")) applyProjectOperation({ kind: "delete-general-body", bodyId: selectionId });
      else if (selectionId.startsWith("component:")) deleteAssemblyComponent(selectionId);
      else if (selectionId.startsWith("mate:")) applyProjectOperation({ kind: "delete-assembly-mate", mateId: selectionId });
      else if (selectionId.startsWith("electrical-component:")) applyProjectOperation({ kind: "delete-electrical-component", componentId: selectionId });
      else if (selectionId.startsWith("electrical-net:")) applyProjectOperation({ kind: "delete-electrical-net", netId: selectionId });
      setSelectedId(null);
      return;
    }
    if (commandId === "electrical.edit" && selectionId !== null) {
      if (projectRef.current.activeWorkspace !== "electrical") switchWorkspace("electrical");
      setSelectedId(selectionId);
      setTreeRevealRequest((request) => request + 1);
      setStatusText(selectionId.startsWith("electrical-net:") ? "Net selected — edit its name, class, or endpoints in the Electrical inspector." : "Device selected — edit its reference, value, or position in the Electrical inspector.");
      return;
    }
    if (commandId === "mate.select-components" && selectionId !== null) {
      const mate = projectRef.current.assembly.mates.find((candidate) => candidate.id === selectionId);
      setSelectedId(mate?.componentIds[0] ?? null);
      setTreeRevealRequest((request) => request + 1);
      setStatusText(mate === undefined ? "Mate relationship is no longer available." : `Selected the first component of ${mate.name}; ${mate.componentIds.length} component reference(s) are shown in Selection relationships.`);
      return;
    }
    if (commandId === "sketch.toggle-construction" && selectionId?.startsWith("entity:") === true) { applyProjectOperation({ kind: "toggle-sketch-construction", entityId: selectionId }); return; }
    setStatusText(`${commandId.replaceAll(".", " ")} is available through the active inspector or is truth-labeled as unavailable in this preview.`);
  };

  const openDesignHealth = useCallback((): void => {
    setPaletteOpen(false);
    setExchangeOpen(false);
    setDesignHealthOpen(true);
    setStatusText(`Design health ${designHealth.overallStatus}: ${designHealth.score}/100 at revision ${designHealth.projectRevision}.`);
  }, [designHealth]);

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      const sketch = projectRef.current.activeWorkspace === "sketch";
      // The sketch canvas owns its own keyboard model (L, R, C, A, D, T, O, X, F, Esc, Delete...), so the 3D shortcuts stand aside.
      if (sketch || masterCartOpen || !isThreeDimensional || isEditableTarget(event.target) || globalThis.document.querySelector('[role="dialog"]') !== null) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key === "f") { fitViewportRef.current(); return; }
      if (key === "1") setViewportOrientation("front");
      if (key === "2") setViewportOrientation("top");
      if (key === "3") setViewportOrientation("right");
      if (key === "4") setViewportOrientation("isometric");
      if (key === "v") setViewportNavigation("select");
      if (key === "o") setViewportNavigation("orbit");
      if (key === "p") setViewportNavigation("pan");
      if (key === "m") setViewportNavigation("measure");
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [isThreeDimensional, masterCartOpen]);

  const downloadProject = (): void => downloadBlob(new Blob([JSON.stringify(projectRef.current, null, 2)], { type: "application/json" }), exportFileName(projectRef.current.name, "", "workbench.json"));
  const downloadDrawing = (): void => downloadBlob(new Blob([drawing.svg], { type: "image/svg+xml" }), exportFileName(projectRef.current.name, "drawing", "svg"));
  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && renderStudioOpen && globalThis.document.querySelector('[role="dialog"]') === null) {
        setRenderStudioOpen(false);
        setStatusText("Returned to the Design workspace; Render Studio settings remain available in this session.");
        return;
      }
      if (!(event.ctrlKey || event.metaKey) || isEditableTarget(event.target) || globalThis.document.querySelector('[role="dialog"]') !== null) return;
      const key = event.key.toLowerCase();
      if (key === "s" && event.shiftKey) { event.preventDefault(); setSaveDialogMode("save-as"); }
      else if (key === "s") { event.preventDefault(); void saveAll(); }
      if (key === "o") { event.preventDefault(); void openProjectFromSystem(); }
      if (key === "n") { event.preventDefault(); setNewDialogOpen(true); }
      if (key === "p") { event.preventDefault(); window.print(); }
      if (key === "h" && event.shiftKey) { event.preventDefault(); openDesignHealth(); }
      if (key === "z" && event.shiftKey) { event.preventDefault(); historyActionRef.current.redo(); }
      else if (key === "z") { event.preventDefault(); historyActionRef.current.undo(); }
      if (key === "y") { event.preventDefault(); historyActionRef.current.redo(); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [openDesignHealth, renderStudioOpen]);

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && shortcutsOpen) { setShortcutsOpen(false); return; }
      if (event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event.target)) return;
      if (event.key === "?" || (event.key === "/" && event.shiftKey)) {
        if (globalThis.document.querySelector('[role="dialog"]') !== null) return;
        event.preventDefault();
        setShortcutsOpen(true);
      }
      // Fusion's S: the command search, anywhere a dialog or menu does not own the keyboard. No sketch tool uses S.
      if (event.key.toLowerCase() === "s" && !event.shiftKey) {
        if (globalThis.document.querySelector('[role="dialog"], [role="menu"]') !== null) return;
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [shortcutsOpen]);

  // Leaving the tab with unsaved changes asks first. The autosave recovery copy still exists either way.
  const projectDirtyRef = useRef(false);
  projectDirtyRef.current = projectRef.current.revision !== savedRevisionRef.current;
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent): void => {
      if (!projectDirtyRef.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, []);
  const canUndo = laneTimelineIndex > 0;
  const canRedo = laneTimelineIndex < laneTimelineLength;
  const projectDirty = project.revision !== savedRevision;
  historyActionRef.current = {
    undo: () => {
      const prev = laneTimelineIndexRef.current;
      if (prev <= 0) return;
      const lane = laneTimelineRef.current[prev - 1];
      const rollback = (): void => { laneTimelineIndexRef.current = prev; syncTimelineState(); };
      if (lane === "qualified-part") {
        if (workerHistoryBusyRef.current) return; // a worker move is still in flight
        workerHistoryBusyRef.current = true;
        laneTimelineIndexRef.current = prev - 1;
        syncTimelineState();
        void moveHistory("undo").then((moved) => { if (!moved) rollback(); });
      } else {
        laneTimelineIndexRef.current = prev - 1;
        syncTimelineState();
        if (!moveProjectHistory("undo")) rollback();
      }
    },
    redo: () => {
      const prev = laneTimelineIndexRef.current;
      if (prev >= laneTimelineRef.current.length) return;
      const lane = laneTimelineRef.current[prev];
      const rollback = (): void => { laneTimelineIndexRef.current = prev; syncTimelineState(); };
      if (lane === "qualified-part") {
        if (workerHistoryBusyRef.current) return;
        workerHistoryBusyRef.current = true;
        laneTimelineIndexRef.current = prev + 1;
        syncTimelineState();
        void moveHistory("redo").then((moved) => { if (!moved) rollback(); });
      } else {
        laneTimelineIndexRef.current = prev + 1;
        syncTimelineState();
        if (!moveProjectHistory("redo")) rollback();
      }
    }
  };
  const contextCommands = contextMenu === undefined ? [] : resolveWorkbenchContextCommands({ workspace: project.activeWorkspace, selectionId: contextMenu.selectionId, selectionKind: contextMenu.selectionKind, canUndo, canRedo });

  /** The ribbon's Remote MCP entry and the Tools menu land here: the Automate workspace, remote recipes in view. */
  const revealRemoteMcp = (): void => {
    if (projectRef.current.activeWorkspace !== "automate") switchWorkspace("automate");
    setAutomateRemoteReveal((count) => count + 1);
    setStatusText("Remote MCP: copy your host's recipe, test the connection, and manage tokens in MCP Access.");
  };

  // What the current selection means to the menus: the timeline feature it resolves to, and whether it can be deleted.
  const selectedTimelineFeature = ((): DesignFeature | undefined => {
    if (selectedId === null) return undefined;
    const history = designOf(project);
    return history.features.find((feature) => feature.id === selectedId) ?? featureOfBody(history, selectedId);
  })();
  const previewBodySelected = selectedId?.startsWith("part-body:") === true;
  const selectedGeneralBody = (project.part.generalBodies ?? []).find((body) => body.id === selectedId);
  const openCombineDialog = (): void => {
    const bodies = projectRef.current.part.generalBodies ?? [];
    if (bodies.length < 2) { setStatusText("Combine needs two solid bodies. Create them with Make solid in the Sketch workspace."); return; }
    setCombineRequest({ targetId: bodies.some((body) => body.id === selectedId) ? selectedId ?? undefined : undefined, mode: "join" });
  };
  const openSketchCreateSolid = (): void => {
    if (projectRef.current.activeWorkspace !== "sketch") switchWorkspace("sketch");
    setSketchOptionsRevealRequest((request) => request + 1);
    setStatusText("Create solid is in the sketch palette: pick Extrude or Revolve, the result (new body, join or cut), and the distance or extent.");
  };
  const deleteSelection = (): void => {
    if (selectedTimelineFeature !== undefined) { timelineOperation({ kind: "delete-design-feature", featureId: selectedTimelineFeature.id }, () => setSelectedId(null)); return; }
    if (previewBodySelected && selectedId !== null) { if (applyProjectOperation({ kind: "delete-part-preview-body", bodyId: selectedId })) setSelectedId(null); return; }
    if (selectedGeneralBody !== undefined) { if (applyProjectOperation({ kind: "delete-general-body", bodyId: selectedGeneralBody.id })) setSelectedId(null); }
  };
  const workbenchMenus = buildWorkbenchMenus({
    workspace: project.activeWorkspace,
    masterCartOpen,
    renderStudioOpen,
    working: status === "working",
    gridVisible: viewportState.gridVisible,
    canUndo,
    canRedo,
    generalBodyCount: (project.part.generalBodies ?? []).length,
    previewBodySelected,
    generalBodySelected: selectedGeneralBody !== undefined,
    ...(selectedTimelineFeature === undefined ? {} : { selectedFeature: { name: selectedTimelineFeature.name, suppressed: selectedTimelineFeature.suppressed, kind: selectedTimelineFeature.kind } }),
    selectionDeletable: selectedTimelineFeature !== undefined || previewBodySelected || selectedGeneralBody !== undefined
  }, {
    onUndo: () => historyActionRef.current.undo(),
    onRedo: () => historyActionRef.current.redo(),
    onCommandPalette: () => setPaletteOpen(true),
    onNewSketch: () => { setSketchPlaneDialogMode("new"); setSketchPlaneDialogOpen(true); },
    onCreateSolidFromSketch: openSketchCreateSolid,
    onCreatePrimitive: createPartPreviewBody,
    onCombine: openCombineDialog,
    onInsertToAssembly: insertCurrentPartIntoAssembly,
    onMasterCart: openMasterCart,
    onRenderStudio: openRenderStudio,
    onEditSelectedFeature: () => { if (selectedTimelineFeature !== undefined) editTimelineFeature(selectedTimelineFeature); },
    onToggleSuppressSelected: () => { if (selectedTimelineFeature !== undefined) timelineOperation({ kind: "set-design-feature-suppressed", featureId: selectedTimelineFeature.id, suppressed: !selectedTimelineFeature.suppressed }); },
    onDeleteSelected: deleteSelection,
    onMoveSelectedBody: () => runSelectedPartPreviewAction("edit-transform", "Move Body"),
    onResizeSelectedBody: () => runSelectedPartPreviewAction("edit-size", "Scale Body"),
    onModifyGeneralBody: handleModifyGeneralBody,
    onFit: fitViewport,
    onHome: homeViewport,
    onToggleGrid: () => setViewportGrid(!viewportState.gridVisible),
    onWorkspace: requestWorkspace,
    onDesignHealth: openDesignHealth,
    onMeasure: () => setViewportNavigation("measure"),
    onExchange: () => setExchangeOpen(true),
    onAccess: () => window.location.assign("/access"),
    onConnectAi: revealRemoteMcp,
    onExportStl: () => void exportStl(),
    onPlateJson: () => void downloadNative(),
    onLearning: () => window.location.assign("/learn"),
    onShortcuts: () => setShortcutsOpen(true)
  });

  // What a visible-scene export would hold right now, named honestly in the Exchange Center.
  const exchangeExportContents = ((): readonly string[] => {
    if (masterCartOpen || renderStudioOpen || project.activeWorkspace !== "part") return [];
    if (activeImport !== undefined) return [`${activeImport.primaryFileName} (imported reference)`];
    return [
      "Centered-bore plate (template)",
      ...(project.part.generalBodies ?? []).filter((body) => body.visible).map((body) => body.name),
      ...(project.part.previewBodies ?? []).filter((body) => body.visible !== false).map((body) => body.name)
    ];
  })();

  // The selected entity's measure, one short line under the viewport. Memoized because it crawls the project for a match.
  const quickMeasure = useMemo(() => selectionMetrics(project, selectedId), [project, selectedId]);

  const showTimeline = !renderStudioOpen && !masterCartOpen && (project.activeWorkspace === "sketch" || project.activeWorkspace === "part");
  return <main className="studio-app" data-timeline={showTimeline ? "on" : "off"} data-workspace={renderStudioOpen ? "render-studio" : masterCartOpen ? "master-cart" : project.activeWorkspace} aria-busy={status === "working"}>
    <WorkbenchHeader
      project={project}
      menus={workbenchMenus}
      dirty={projectDirty}
      masterCartOpen={masterCartOpen}
      renderStudioOpen={renderStudioOpen}
      status={status}
      fileWorkspaceStatus={fileWorkspaceStatus}
      recentProjects={recentProjects}
      onWorkspace={requestWorkspace}
      onMasterCart={openMasterCart}
      onRenderStudio={openRenderStudio}
      onCommandPalette={() => setPaletteOpen(true)}
      onDesignHealth={openDesignHealth}
      onExchange={() => setExchangeOpen(true)}
      onLearning={() => window.location.assign("/learn")}
      onAccess={() => window.location.assign("/access")}
      onNew={() => setNewDialogOpen(true)}
      onSave={() => void saveAll()}
      onSaveAs={() => setSaveDialogMode("save-as")}
      onSaveCopy={() => setSaveDialogMode("copy")}
      onDownload={downloadProject}
      onOpen={() => void openProjectFromSystem()}
      onOpenRecent={(id) => void reopenRecentProject(id)}
      onOpenNative={() => nativeInputRef.current?.click()}
      onInitializeFileWorkspace={() => void connectFileWorkspace()}
      onRecoverProject={() => void recoverAutosave()}
      onClearFileCache={() => void clearFileCaches()}
      onPrint={() => window.print()}
      onUndo={() => historyActionRef.current.undo()}
      onRedo={() => historyActionRef.current.redo()}
      onFit={fitViewport}
      onHome={homeViewport}
      onToggleGrid={() => setViewportGrid(!viewportState.gridVisible)}
      onMeasure={() => setViewportNavigation("measure")}
      gridVisible={viewportState.gridVisible}
      canUndo={canUndo}
      canRedo={canRedo}
      designHealthStatus={designHealth.overallStatus}
      designHealthScore={designHealth.score}
    />
    {!renderStudioOpen && <WorkbenchRibbon
      project={project}
      masterCartOpen={masterCartOpen}
      displayUnit={document.displayUnit}
      sketchTool={sketchTool}
      sketchDimensionMode={sketchDimensionMode}
      assemblyExplodeMaxMm={assemblyExplodeMaxMm}
      selectedId={selectedId}
      onSketchTool={(tool) => activateSketchTool(tool, "in the top ribbon")}
      onSolveMates={() => applyProjectOperation({ kind: "solve-assembly-mates" })}
      onCombine={openCombineDialog}
      onSketchDimension={() => activateSketchDimension("in the top ribbon")}
      sketchEditTool={sketchEditTool}
      sketchShowMovable={sketchShowMovable}
      sketchCheckOpen={sketchCheckOpen}
      onSketchEditTool={(tool) => activateSketchEdit(tool, "in the top ribbon")}
      onSketchCommand={(command) => runSketchCommand(command, "in the top ribbon")}
      onOpenSketchOptions={openSketchCreateSolid}
      onToggleSketchEntityVisibility={(entityId) => applyProjectOperation({ kind: "toggle-sketch-entity-visibility", entityId })}
      onFinishSketch={() => void finishSketch()}
      onNewSketch={() => { setSketchPlaneDialogMode("new"); setSketchPlaneDialogOpen(true); }}
      onRemoteMcp={revealRemoteMcp}
      onCancelSketchPoints={() => { setSketchCancelVersion((version) => version + 1); setStatusText("Pending sketch points cleared from the top ribbon."); }}
      onSelect={routeSelection}
      onCreatePartPreviewBody={createPartPreviewBody}
      onPartPreviewAction={(operation, commandName) => runSelectedPartPreviewAction(operation, commandName)}
      onPartFeatureAction={(operation, commandName) => runPartFeatureAction(operation, commandName)}
      onModifyGeneralBody={handleModifyGeneralBody}
      onAddConstructionPlane={handleAddConstructionPlane}
      onAddConstructionAxis={handleAddConstructionAxis}
      onAddConstructionPoint={handleAddConstructionPoint}
      zebra={zebra}
      onZebra={(next) => {
        zebraRef.current = next;
        setZebraState(next);
        viewportRef.current?.setZebra(next);
        setStatusText(next === null ? "Zebra stripes off." : `Zebra stripes on (${next.axis.toUpperCase()} axis, ×${next.frequency}). Orbit the model: stripes that run straight across a seam mean tangent (G1) continuity; stripes that kink there mean a tangent break.`);
      }}
      onEdgeFlange={() => void handleEdgeFlange()}
      onIndent={handleIndent}
      onFlatPattern={(format) => void handleFlatPattern(format)}
      onDirectEdit={handleDirectEdit}
      onHoleWizard={handleHoleWizard}
      onFit={fitViewport}
      onMeasure={() => setViewportNavigation("measure")}
      onNativeDownload={() => void downloadNative()}
      onNativeOpen={() => nativeInputRef.current?.click()}
      onExportStl={() => void exportStl()}
      onExchange={() => setExchangeOpen(true)}
      onDisplayUnit={(unit) => void changeUnit(unit)}
      onAssemblyExplode={(valueMm) => { previewAssemblyExplode(valueMm); commitAssemblyExplode(valueMm); }}
      onAssemblyTemplate={requestAssemblyTemplate}
      onInsertPartIntoAssembly={insertCurrentPartIntoAssembly}
      onInsertComponent={insertAssemblyComponent}
      onDeleteComponent={deleteAssemblyComponent}
      onToggleGrounded={(componentId) => applyProjectOperation({ kind: "toggle-component-grounded", componentId })}
      onToggleVisibility={(componentId) => applyProjectOperation({ kind: "toggle-component-visibility", componentId })}
      onSurfaceMode={(mode) => applyProjectOperation({ kind: "set-surface-mode", mode })}
      onSurfaceParameter={(parameter, value) => applyProjectOperation({ kind: "set-surface-parameter", parameter, value })}
      onSurfacePreset={(preset) => applyProjectOperation({ kind: "apply-surface-preset", preset })}
      onDrawingSheet={(sheet) => applyProjectOperation({ kind: "set-drawing-sheet", sheet })}
      onDrawingProjection={(projection) => applyProjectOperation({ kind: "set-drawing-projection", projection })}
      onDrawingScale={(scale) => applyProjectOperation({ kind: "set-drawing-scale", scale })}
      onDrawingDimensions={(show) => applyProjectOperation({ kind: "set-drawing-dimensions", show })}
      onDrawingViewPreset={(preset) => applyProjectOperation({ kind: "set-drawing-view-preset", preset })}
      onDrawingDisplayStyle={(style) => applyProjectOperation({ kind: "set-drawing-display-style", style })}
      onDrawingSectionView={(show) => applyProjectOperation({ kind: "set-drawing-section-view", show })}
      onDrawingDraftingStandard={(standard) => applyProjectOperation({ kind: "set-drawing-drafting-standard", standard })}
      onDrawingGdt={(show) => applyProjectOperation({ kind: "set-drawing-gdt", show })}
      onDrawingDatumScheme={(scheme) => applyProjectOperation({ kind: "set-drawing-datum-scheme", scheme })}
      onDrawingDownload={downloadDrawing}
      onElectricalTemplate={requestElectricalTemplate}
      onElectricalStandard={(standard) => applyProjectOperation({ kind: "set-electrical-standard", standard })}
      onElectricalInsert={insertElectricalComponent}
      onElectricalPhysicalize={requestElectromechanicalAssembly}
      onElectricalDownload={() => downloadBlob(new Blob([electrical.svg], { type: "image/svg+xml" }), exportFileName(projectRef.current.name, "electrical", "svg"))}
      onVehicleTemplate={requestVehicleTemplate}
      onVehicleState={(state) => applyProjectOperation({ kind: "set-vehicle-simulation-state", state })}
      onVehicleLayer={(layer) => applyProjectOperation({ kind: "toggle-vehicle-layer", layer })}
      onCloseMasterCart={() => { setMasterCartOpen(false); setStatusText("Returned to the Assembly workspace; no uninserted catalog preview was committed."); }}
    />}
    <input ref={projectInputRef} type="file" accept="application/json,.json" className="visually-hidden" aria-label="Open PS3D workbench project" tabIndex={-1} onChange={(event) => void openProject(event)} />
    <input ref={nativeInputRef} type="file" accept="application/json,.json" className="visually-hidden" aria-label="Open qualified PS3D native part revision" tabIndex={-1} onChange={(event) => void openNative(event)} />
    {renderStudioOpen && <RenderStudioWorkspace
      project={project}
      canvasRef={renderCanvasRef}
      settings={renderSettings}
      gallery={renderGallery}
      busy={renderBusy}
      onSettings={setRenderSettings}
      onFit={fitRenderViewport}
      onRender={() => void renderStudioImage()}
      onClose={() => { setRenderStudioOpen(false); setStatusText("Returned to the Design workspace; Render Studio settings remain available in this session."); }}
    />}
    {!renderStudioOpen && <section className="workbench-grid">
      {masterCartOpen && <MasterCartWorkspace assemblyComponentCount={project.assembly.components.length} onAdd={insertMasterCartItem} onMessage={setStatusText} />}
      {!masterCartOpen && <ProjectTree project={project} selectedId={selectedId} revealSelectionRequest={treeRevealRequest} designHealth={designHealth} onSelect={routeSelection} onContextMenu={openContextMenu} />}
      {!masterCartOpen && project.activeWorkspace === "sketch" && <SketchWorkspace projectId={project.id} sketch={project.sketch} tool={sketchTool} dimensionMode={sketchDimensionMode} cancelVersion={sketchCancelVersion} selectedId={selectedId} onSelect={setSelectedId} onAddEntity={(entity: SketchEntity) => applyProjectOperation({ kind: "add-sketch-entity", entity })} onDeleteEntity={(entityId) => { if (applyProjectOperation({ kind: "delete-sketch-entity", entityId })) setSelectedId(null); }} onAddConstraint={(constraint: WorkbenchSketchConstraint) => applyProjectOperation({ kind: "add-sketch-constraint", constraint })} onDeleteConstraint={(constraintId) => applyProjectOperation({ kind: "delete-sketch-constraint", constraintId })} onSetDimension={(entityId, dimension, valueMm) => applyProjectOperation({ kind: "set-sketch-dimension", entityId, dimension, valueMm })} onToggleConstruction={(entityId) => applyProjectOperation({ kind: "toggle-sketch-construction", entityId })} onToggleVisibility={(entityId) => applyProjectOperation({ kind: "toggle-sketch-entity-visibility", entityId })} viewportState={viewportState} onNavigationMode={setViewportNavigation} onSelectionFilter={setViewportSelectionFilter} onOrientation={setViewportOrientation} onViewAngles={setViewportAngles} onProjection={setViewportProjection} onGrid={setViewportGrid} onAxes={setViewportAxes} fitSerial={sketchFitSerial} onContextMenu={openContextMenu} onMessage={setStatusText} optionsRevealRequest={sketchOptionsRevealRequest} solidBodies={(project.part.generalBodies ?? []).map((body) => ({ id: body.id, name: body.name }))} onCreateSolid={(profileId, plane, operation, valueMm, edge, direction, target, advancedParams) => void createGeneralSolid(profileId, plane, operation, valueMm, edge, direction, target, advancedParams)} onChangePlane={() => setSketchPlaneDialogOpen(true)} editTool={sketchEditTool} showMovable={sketchShowMovable} checkOpen={sketchCheckOpen} request={sketchRequest} onApplyEdit={(plan: SketchEditPlan) => applyProjectOperation({ kind: "apply-sketch-edit", ...plan })} onSetSuppressed={(constraintIds, suppressed) => applyProjectOperation({ kind: "set-sketch-constraints-suppressed", constraintIds, suppressed })} onCloseEditTool={() => { setSketchEditTool(null); setStatusText("Sketch edit tool closed."); }} onCloseCheck={() => setSketchCheckOpen(false)} onActivateTool={(tool) => activateSketchTool(tool, "from the keyboard")} onActivateDimension={() => activateSketchDimension("from the keyboard")} onExitDimension={() => { setSketchDimensionMode(false); setStatusText("Sketch Dimension finished."); }} onActivateEditTool={(tool) => activateSketchEdit(tool, "from the keyboard")} onFinishSketch={() => void finishSketch()} onCancelSketch={() => { setSketchCancelVersion((version) => version + 1); switchWorkspace("part"); setStatusText("Cancelled the sketch and returned to Design. Pending points were dropped; committed geometry is kept."); }} />}
      {!masterCartOpen && isThreeDimensional && <section className="workspace-canvas model-stage" aria-label={`${project.activeWorkspace} three-dimensional viewport`}>
        <canvas ref={canvasRef} className="model-canvas" role="img" aria-label={`Interactive ${project.activeWorkspace} preview`} />
        <CameraGestureControl
          workspace={project.activeWorkspace as "part" | "assembly" | "surface" | "vehicle"}
          currentExplodeMm={displayedAssembly.explodeMm}
          maxExplodeMm={assemblyExplodeMaxMm}
          onOrbit={(deltaX, deltaY) => viewportRef.current?.orbitByPixels(deltaX, deltaY)}
          onCursor={updateCameraCursor}
          onExplodePreview={previewAssemblyExplode}
          onExplodeCommit={commitAssemblyExplode}
          onMessage={setStatusText}
        />
        <div ref={cameraCursorRef} className="camera-cad-cursor" hidden aria-hidden="true"><i /><span>INDEX</span></div>
        {project.activeWorkspace === "assembly" && <div className="assembly-gesture-hud" aria-live="polite">
          <span><i />Open right palm · acquire lock</span>
          <span><i />Index cursor · pinch and hold to orbit</span>
          <span><i />Palm near / far · explode / assemble</span>
          <strong>{displayedAssembly.explodeMm.toFixed(1)} mm <small>{assemblyExplodePercent}% of {assemblyExplodeMaxMm.toFixed(1)} mm max</small></strong>
        </div>}
        <ViewportChrome
          workspace={project.activeWorkspace as "part" | "assembly" | "surface" | "vehicle"}
          state={viewportState}
          measurePoints={measurePoints}
          onNavigationMode={setViewportNavigation}
          onSelectionFilter={setViewportSelectionFilter}
          onOrientation={setViewportOrientation}
          onViewAngles={setViewportAngles}
          onProjection={setViewportProjection}
          onGrid={setViewportGrid}
          onAxes={setViewportAxes}
          onShadingMode={(mode) => viewportRef.current?.setShadingMode(mode)}
          onBodyColor={(color) => viewportRef.current?.setBodyColor(color)}
          onBackgroundTone={(tone: ViewportBackgroundTone) => viewportRef.current?.setBackgroundTone(tone)}
          onFit={fitViewport}
          onHome={homeViewport}
          onClearMeasure={() => setMeasurePoints([])}
        />
        <ViewportMetrics workspace={project.activeWorkspace} model={model} imported={activeImport} project={project} interferenceCount={interferences.length} surfaceTriangles={surfacePreview.metrics.triangles} vehicleAnalysis={vehiclePreview.analysis} vehiclePrimitiveCount={vehiclePreview.scene.primitives.length} />
        {quickMeasure !== undefined && <div className="quick-measure-bar" role="status" aria-live="polite" aria-label="Quick measure"><span className="quick-measure-title">{quickMeasure.title}</span>{quickMeasure.metrics.map((metric, index) => <span key={index}>{metric}</span>)}</div>}
      </section>}
      {!masterCartOpen && <>
      {project.activeWorkspace === "part" && activeImport === undefined && <PartInspector onGeneralBodyToAssembly={createComponentFromGeneralBody} onGeneralBodyVisibility={(bodyId) => { applyProjectOperation({ kind: "toggle-general-body-visibility", bodyId }); }} onGeneralBodyDelete={(bodyId) => { if (applyProjectOperation({ kind: "delete-general-body", bodyId })) setSelectedId(null); }} design={designOf(project)} onEditFeature={editTimelineFeature} part={project.part} model={model} working={status === "working"} bodyColor={viewportState.bodyColor} shadingMode={viewportState.shadingMode} selectedId={selectedId} selectedFace={selectedFace !== null && selectedFace.bodyId === selectedId ? selectedFace.faceIndex : null} onSelectFace={(bodyId, faceIndex) => setSelectedFace(faceIndex === null ? null : { bodyId, faceIndex })} onSelect={setSelectedId} onBodyColor={(color) => viewportRef.current?.setBodyColor(color)} onShadingMode={(mode) => viewportRef.current?.setShadingMode(mode)} onCommit={(parameter, value) => void commitPartParameter(parameter, value)} onInsertIntoAssembly={insertCurrentPartIntoAssembly} onCreatePreviewBody={createPartPreviewBody} onPreviewBodyTransform={(bodyId, translationMm, rotationDeg) => applyProjectOperation({ kind: "set-part-preview-body-transform", bodyId, translationMm, rotationDeg })} onPreviewBodySize={(bodyId, sizeMm) => applyProjectOperation({ kind: "set-part-preview-body-size", bodyId, sizeMm })} onPreviewBodyColor={(bodyId, color) => applyProjectOperation({ kind: "set-part-preview-body-color", bodyId, color })} onPreviewBodyVisibility={(bodyId) => applyProjectOperation({ kind: "toggle-part-preview-body-visibility", bodyId })} onPreviewBodyDelete={(bodyId) => { if (applyProjectOperation({ kind: "delete-part-preview-body", bodyId })) setSelectedId(null); }} />}
      {project.activeWorkspace === "part" && activeImport !== undefined && <ImportedModelInspector result={activeImport} onExchange={() => setExchangeOpen(true)} onClear={clearActiveImport} />}
      {project.activeWorkspace === "assembly" && <AssemblyInspector assembly={displayedAssembly} maxExplodeMm={assemblyExplodeMaxMm} selectedId={selectedId} interferences={interferences} onTemplate={requestAssemblyTemplate} onExplodePreview={previewAssemblyExplode} onExplodeCommit={commitAssemblyExplode} onMove={(componentId, translationMm) => applyProjectOperation({ kind: "set-component-translation", componentId, translationMm })} onToggleGrounded={(componentId) => applyProjectOperation({ kind: "toggle-component-grounded", componentId })} onToggleVisible={(componentId) => applyProjectOperation({ kind: "toggle-component-visibility", componentId })} onDelete={deleteAssemblyComponent} onAddMate={(mate) => applyProjectOperation({ kind: "add-assembly-mate", mate })} onSolveMates={() => applyProjectOperation({ kind: "solve-assembly-mates" })} onDeleteMate={(mateId) => { if (applyProjectOperation({ kind: "delete-assembly-mate", mateId }) && selectedId === mateId) setSelectedId(null); }} onSelect={setSelectedId} onOpenElectricalSource={(componentId) => { switchWorkspace("electrical"); setSelectedId(componentId ?? null); setTreeRevealRequest((request) => request + 1); }} />}
      {project.activeWorkspace === "surface" && <SurfaceInspector surface={project.surface} metrics={surfacePreview.metrics} onParameter={(parameter, value) => applyProjectOperation({ kind: "set-surface-parameter", parameter, value })} />}
      {project.activeWorkspace === "drawing" && <DrawingWorkspace settings={project.drawing} artifact={drawing} onSheet={(sheet) => applyProjectOperation({ kind: "set-drawing-sheet", sheet })} onProjection={(projection) => applyProjectOperation({ kind: "set-drawing-projection", projection })} onScale={(scale) => applyProjectOperation({ kind: "set-drawing-scale", scale })} onDimensions={(show) => applyProjectOperation({ kind: "set-drawing-dimensions", show })} onViewPreset={(preset) => applyProjectOperation({ kind: "set-drawing-view-preset", preset })} onDisplayStyle={(style) => applyProjectOperation({ kind: "set-drawing-display-style", style })} onSectionView={(show) => applyProjectOperation({ kind: "set-drawing-section-view", show })} onDraftingStandard={(standard) => applyProjectOperation({ kind: "set-drawing-drafting-standard", standard })} onGdt={(show) => applyProjectOperation({ kind: "set-drawing-gdt", show })} onDatumScheme={(scheme) => applyProjectOperation({ kind: "set-drawing-datum-scheme", scheme })} onGdtSpecification={(positionMm, flatnessMm, perpendicularityMm) => applyProjectOperation({ kind: "set-drawing-gdt-specification", positionMm, flatnessMm, perpendicularityMm })} onGeneralTolerance={(linearMm, angularDeg) => applyProjectOperation({ kind: "set-drawing-general-tolerance", linearMm, angularDeg })} onNotes={(notes) => applyProjectOperation({ kind: "set-drawing-notes", notes })} onTitleBlock={(fields) => applyProjectOperation({ kind: "set-drawing-title-block", ...fields })} />}
      {project.activeWorkspace === "electrical" && <ElectricalWorkspace intent={project.electrical} artifact={electrical} selectedId={selectedId} onSelect={setSelectedId} onTemplate={requestElectricalTemplate} onStandard={(standard) => { if (standard !== project.electrical.standard) applyProjectOperation({ kind: "set-electrical-standard", standard }); else setStatusText(`Electrical symbol basis is already ${standard}.`); }} onInsertComponent={insertElectricalComponent} onMoveComponent={(componentId, position) => { const current = project.electrical.components.find((component) => component.id === componentId)?.position; if (current === undefined || current[0] !== position[0] || current[1] !== position[1]) applyProjectOperation({ kind: "set-electrical-component-position", componentId, position }); }} onDeleteComponent={(componentId) => { if (applyProjectOperation({ kind: "delete-electrical-component", componentId })) setSelectedId(null); }} onAddNet={addElectricalNet} onDeleteNet={(netId) => { if (applyProjectOperation({ kind: "delete-electrical-net", netId })) setSelectedId(null); }} onNotes={(notes) => { if (notes !== project.electrical.notes) applyProjectOperation({ kind: "set-electrical-notes", notes }); }} onPhysicalize={requestElectromechanicalAssembly} onDownload={() => downloadBlob(new Blob([electrical.svg], { type: "image/svg+xml" }), exportFileName(projectRef.current.name, "electrical", "svg"))} />}
      {project.activeWorkspace === "vehicle" && <VehicleWorkspace intent={project.vehicle} analysis={vehiclePreview.analysis} geometry={vehiclePreview.geometry} primitiveCountByLayer={vehiclePreview.primitiveCountByLayer} selectedId={selectedId} onSelect={setSelectedId} onTemplate={requestVehicleTemplate} onParameter={(parameter, value) => applyProjectOperation({ kind: "set-vehicle-parameter", parameter, value })} onState={(state) => applyProjectOperation({ kind: "set-vehicle-simulation-state", state })} onLayer={(layer) => applyProjectOperation({ kind: "toggle-vehicle-layer", layer })} onFit={fitViewport} onMessage={setStatusText} onEvidenceStatus={(field, reviewed) => applyProjectOperation({ kind: "set-vehicle-evidence-status", field, reviewed })} />}
      {project.activeWorkspace === "automate" && <AutomateWorkspace project={project} selectedId={selectedId} remoteRevealRequest={automateRemoteReveal} onSelect={setSelectedId} onApplyProject={(next, message) => { const valid = validateWorkbenchProject(next); if (valid.ok) { pushProject(valid.value); setStatusText(message); return; } const first = valid.diagnostics[0]; setDiagnostic(first === undefined ? undefined : { code: first.code, message: first.message, recovery: first.recovery }); setStatus("error"); setStatusText(first?.message ?? "The confirmed preview failed project validation and was not applied."); }} onReviewElectromechanical={requestElectromechanicalAssembly} onMessage={setStatusText} />}
      </>}
    </section>}
    {contextMenu !== undefined && <WorkbenchContextMenu x={contextMenu.x} y={contextMenu.y} selectionLabel={contextMenu.selectionId ?? `${project.activeWorkspace} canvas`} commands={contextCommands} onRun={runContextCommand} onClose={() => setContextMenu(undefined)} />}
    {showTimeline && <TimelineBar
      history={designOf(project)}
      selectedId={selectedId}
      busy={status === "working"}
      onSelect={(feature) => setSelectedId(feature.kind === "sketch" ? feature.id : feature.bodyId)}
      onEdit={editTimelineFeature}
      onRollback={(index) => timelineOperation({ kind: "set-design-rollback", index })}
      onSuppress={(feature, suppressed) => timelineOperation({ kind: "set-design-feature-suppressed", featureId: feature.id, suppressed })}
      onDelete={(feature) => timelineOperation({ kind: "delete-design-feature", featureId: feature.id }, () => setSelectedId(null))}
      onRename={(feature, name) => { applyProjectOperation({ kind: "rename-design-feature", featureId: feature.id, name }); }}
    />}
    <footer className="app-status"><div className={`status-copy ${status}`} role="status" aria-live="polite"><span />{statusText}</div><div className="status-facts"><a className="app-brand-credit" href="/about" title={`${PS3D_BRAND.name} - ${PS3D_BRAND.serviceLine}`}>{PS3D_BRAND.name}</a><button className={`status-health ${designHealth.overallStatus}`} onClick={openDesignHealth}>health {designHealth.score}</button><button className="status-shortcuts" onClick={() => setShortcutsOpen(true)} title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts">? keys</button><span>{document.displayUnit}</span><span>{selectedId === null ? "0 selected" : "1 selected"}</span><span>{renderStudioOpen ? `${renderSettings.resolution} ${renderSettings.format}` : masterCartOpen ? "parametric preview" : isThreeDimensional ? viewportState.selectionFilter : project.activeWorkspace === "electrical" ? `ERC ${electrical.erc.status}` : "local"}</span><span>{renderStudioOpen ? "render-studio" : masterCartOpen ? "master-cart" : project.activeWorkspace}</span></div>{diagnostic !== undefined && <div className="diagnostic-toast" role="alert"><strong>{diagnostic.code}</strong><span>{diagnostic.message}</span><small>{diagnostic.recovery}</small><button onClick={() => setDiagnostic(undefined)} aria-label="Dismiss diagnostic">×</button></div>}</footer>
    <SmartFaultBrain report={designHealth} {...(diagnostic === undefined ? {} : { diagnostic })} onDesignHealth={openDesignHealth} onWorkspace={switchWorkspace} />
    {electromechanicalReviewOpen && <div className="engineering-confirmation-backdrop"><section ref={engineeringDialogRef} tabIndex={-1} className="engineering-confirmation-dialog exact-candidate" role="dialog" aria-modal="true" aria-labelledby="electromechanical-review-title" aria-describedby="electromechanical-review-description">
        <header><div><span>EXACT CANDIDATE REPLACEMENT REVIEW</span><h2 id="electromechanical-review-title">Circuit → wired mounting plate</h2></div><button data-dialog-initial-focus onClick={() => { setElectromechanicalReviewOpen(false); setElectromechanicalAcknowledged(false); }} aria-label="Close circuit to mounting plate review">×</button></header>
        <div className="engineering-review-metrics"><span><small>Remove</small><strong>{project.assembly.components.length} bodies · {project.assembly.mates.length} mates · {project.assembly.electricalRoutes?.length ?? 0} conductors · {project.assembly.electricalLinks?.length ?? 0} links</strong></span><span><small>Generate</small><strong>{electromechanicalCandidate.ok ? electromechanicalCandidate.value.components.length : 0} bodies · {electromechanicalCandidate.ok ? electromechanicalCandidate.value.mates.length : 0} fixed mates</strong></span><span><small>Trace</small><strong>{electromechanicalCandidate.ok ? electromechanicalCandidate.value.electricalRoutes?.length ?? 0 : 0} unsized conductors</strong></span><span><small>ERC</small><strong>{electrical.erc.errors} error · {electrical.erc.warnings} warning</strong></span></div>
        <div className="engineering-review-copy" id="electromechanical-review-description"><p>The candidate uses original generic panel packages plus a mounting plate, DIN rails, wiring ducts, bonding hardware, terminal studs, and class-colored conductor paths from <code>{ELECTROMECHANICAL_CATALOG_REVISION}</code>. It does not infer manufacturer geometry, ratings, clearances, conductor gauge, ampacity, harness construction, thermal performance, mass, procurement data, or regulatory approval.</p><p>The source schematic remains in the project. The following removed IDs, generated bodies, mappings, positions, conductor points, and individual ERC findings are the exact candidate reviewed for one undoable revision.</p>{electrical.physicalization.blockingErrors.map((error) => <p className="error" key={error}>{error}</p>)}</div>
      <div className="engineering-review-details">
        <details open><summary>Removed complete Assembly snapshot <span>{project.assembly.components.length + project.assembly.mates.length + (project.assembly.electricalRoutes?.length ?? 0) + (project.assembly.electricalLinks?.length ?? 0)}</span></summary><div className="engineering-id-list">{project.assembly.components.map((component) => <code key={component.id}>{component.id}</code>)}{project.assembly.mates.map((mate) => <code key={mate.id}>{mate.id}</code>)}{project.assembly.electricalRoutes?.map((route) => <code key={route.id}>{route.id}</code>)}{project.assembly.electricalLinks?.map((link) => <code key={`${link.electricalComponentId}:${link.assemblyComponentId}`}>{link.electricalComponentId} → {link.assemblyComponentId}</code>)}</div><pre className="engineering-assembly-snapshot">{JSON.stringify(project.assembly, null, 2)}</pre></details>
        <details open><summary>Generated bodies and source mappings <span>{electromechanicalCandidate.ok ? electromechanicalCandidate.value.components.length : 0}</span></summary><div className="engineering-candidate-list">{electromechanicalCandidate.ok ? electromechanicalCandidate.value.components.map((component) => { const link = electromechanicalCandidate.value.electricalLinks?.find((item) => item.assemblyComponentId === component.id); return <article key={component.id}><strong>{component.name}</strong><code>{component.id}</code><small>position {component.translationMm.join(", ")} mm · size {component.sizeMm.join(" × ")} mm</small><small>{link === undefined ? "reviewed support body" : `${link.electricalReference} → ${link.catalogPartId} · ${link.terminalMap.map((terminal) => `${terminal.electricalTerminal}:${terminal.catalogTerminal}`).join(", ")}`}</small></article>; }) : <p className="error">No candidate can be generated until every blocking readiness/ERC error is corrected.</p>}</div></details>
        <details open><summary>Generated fixed mates <span>{electromechanicalCandidate.ok ? electromechanicalCandidate.value.mates.length : 0}</span></summary><div className="engineering-id-list">{electromechanicalCandidate.ok && electromechanicalCandidate.value.mates.map((mate) => <code key={mate.id}>{mate.id} · {mate.kind} · {mate.componentIds.join(", ")} · {mate.status}</code>)}</div></details>
        <details open><summary>Unsized conductor paths <span>{electromechanicalCandidate.ok ? electromechanicalCandidate.value.electricalRoutes?.length ?? 0 : 0}</span></summary><div className="engineering-route-list">{electromechanicalCandidate.ok && electromechanicalCandidate.value.electricalRoutes?.map((route) => <article key={route.id}><strong>{route.name} · {route.class}</strong><small>{route.endpoints.map((endpoint) => `${endpoint.componentId}.${endpoint.terminal}`).join(" → ")}</small><code>{route.pointsMm.map((point) => `(${point.join(",")})`).join(" → ")}</code></article>)}</div></details>
        <details open><summary>Complete generated Assembly snapshot <span>{electromechanicalCandidate.ok ? "all fields" : "blocked"}</span></summary>{electromechanicalCandidate.ok ? <pre className="engineering-assembly-snapshot">{JSON.stringify(electromechanicalCandidate.value, null, 2)}</pre> : <p className="error">No generated Assembly snapshot is available until every blocking readiness/ERC error is corrected.</p>}</details>
        <details open><summary>Electrical rule-check findings <span>{electrical.erc.issues.length}</span></summary><div className="engineering-issue-list">{electrical.erc.issues.length === 0 ? <p>No structural ERC findings.</p> : electrical.erc.issues.map((issue) => <p className={issue.severity} key={issue.id}><strong>{issue.severity.toUpperCase()} · {issue.message}</strong><small>{issue.recovery}</small></p>)}</div></details>
      </div>
        <label className="engineering-confirmation-check"><input type="checkbox" checked={electromechanicalAcknowledged} onChange={(event) => setElectromechanicalAcknowledged(event.target.checked)} /><span>I reviewed the complete removed Assembly snapshot, every prior/generated ID, candidate body/mapping/position, fixed mate, conductor path, ERC finding, and the non-construction generic-panel boundary.</span></label><footer><button onClick={() => { setElectromechanicalReviewOpen(false); setElectromechanicalAcknowledged(false); }}>Cancel</button><button className="primary" disabled={!electromechanicalAcknowledged || !electromechanicalCandidate.ok || electrical.physicalization.status === "blocked" || electrical.erc.errors > 0} onClick={generateElectromechanicalAssembly}>Generate wired mounting plate</button></footer>
    </section></div>}
      {pendingAssemblyTemplate !== undefined && <div className="engineering-confirmation-backdrop"><section ref={engineeringDialogRef} tabIndex={-1} className="engineering-confirmation-dialog compact" role="dialog" aria-modal="true" aria-labelledby="assembly-replacement-title" aria-describedby="assembly-replacement-description"><header><div><span>{project.assembly.electromechanicalSource === undefined ? "REPLACE ASSEMBLY" : "LINKED ASSEMBLY PROTECTION"}</span><h2 id="assembly-replacement-title">{project.assembly.electromechanicalSource === undefined ? "Replace the current assembly?" : "Break ECAD trace and replace assembly?"}</h2></div><button onClick={() => setPendingAssemblyTemplate(undefined)} aria-label="Close assembly replacement review">×</button></header><div className="engineering-review-copy" id="assembly-replacement-description">{project.assembly.electromechanicalSource === undefined
          ? <p>The current assembly has {project.assembly.components.length} components and {project.assembly.mates.length} mates. Replacing it with <strong>{pendingAssemblyTemplate.replaceAll("-", " ")}</strong> removes them all. The replacement is one undoable revision, so Undo restores the current assembly.</p>
          : <p>The current assembly has {project.assembly.electricalLinks?.length ?? 0} ECAD-linked packages and {project.assembly.electricalRoutes?.length ?? 0} conductor paths. Replacing it with <strong>{pendingAssemblyTemplate.replaceAll("-", " ")}</strong> removes that physical trace from Assembly, while preserving the source schematic. The replacement is one undoable revision.</p>}</div><footer><button data-dialog-initial-focus onClick={() => setPendingAssemblyTemplate(undefined)}>Cancel</button><button className="danger" onClick={() => { const template = pendingAssemblyTemplate; setPendingAssemblyTemplate(undefined); applyProjectOperation({ kind: "apply-assembly-template", template }); }}>{project.assembly.electromechanicalSource === undefined ? "Replace assembly" : "Break link and replace"}</button></footer></section></div>}
    {pendingElectricalTemplate !== undefined && <div className="engineering-confirmation-backdrop"><section ref={engineeringDialogRef} tabIndex={-1} className="engineering-confirmation-dialog compact" role="dialog" aria-modal="true" aria-labelledby="electrical-template-replacement-title" aria-describedby="electrical-template-replacement-description"><header><div><span>SCHEMATIC REPLACEMENT REVIEW</span><h2 id="electrical-template-replacement-title">Replace current devices and nets?</h2></div><button onClick={cancelElectricalTemplateReview} aria-label="Close schematic replacement review">×</button></header><div className="engineering-review-copy" id="electrical-template-replacement-description"><p>Generating <strong>{pendingElectricalTemplate.replaceAll("-", " ")}</strong> replaces all {project.electrical.components.length} current devices and {project.electrical.nets.length} current nets, including local edits. The replacement is one undoable project revision.</p></div><footer><button data-dialog-initial-focus onClick={cancelElectricalTemplateReview}>Cancel</button><button className="danger" onClick={() => { const template = pendingElectricalTemplate; setPendingElectricalTemplate(undefined); if (applyProjectOperation({ kind: "apply-electrical-template", template })) setSelectedId(null); }}>Replace and generate</button></footer></section></div>}
    {pendingVehicleTemplate !== undefined && <div className="engineering-confirmation-backdrop"><section ref={engineeringDialogRef} tabIndex={-1} className="engineering-confirmation-dialog compact" role="dialog" aria-modal="true" aria-labelledby="vehicle-template-replacement-title" aria-describedby="vehicle-template-replacement-description"><header><div><span>VEHICLE TOPOLOGY REPLACEMENT REVIEW</span><h2 id="vehicle-template-replacement-title">Replace the current engineering study?</h2></div><button onClick={() => { setPendingVehicleTemplate(undefined); setStatusText("Vehicle replacement cancelled; the current topology and inputs were preserved."); }} aria-label="Close vehicle topology replacement review">×</button></header><div className="engineering-review-copy" id="vehicle-template-replacement-description"><p>Replacing <strong>{project.vehicle.template.replaceAll("-", " ")}</strong> with <strong>{pendingVehicleTemplate.replaceAll("-", " ")}</strong> resets all {Object.keys(project.vehicle.parameters).length} vehicle inputs, the suspension state, evidence-status fields, and layer visibility to the target generic template. The current {vehiclePreview.geometry.hardpoints.length}-hardpoint graph is removed. The replacement is one undoable project revision.</p><p>The new package remains illustrative and carries the same do-not-fabricate, roadworthiness, and homologation boundaries.</p></div><footer><button data-dialog-initial-focus onClick={() => { setPendingVehicleTemplate(undefined); setStatusText("Vehicle replacement cancelled; the current topology and inputs were preserved."); }}>Cancel</button><button className="danger" onClick={() => { const template = pendingVehicleTemplate; setPendingVehicleTemplate(undefined); if (applyProjectOperation({ kind: "apply-vehicle-template", template })) setSelectedId(null); }}>Replace topology and inputs</button></footer></section></div>}
    {combineRequest !== null && <CombineDialog bodies={(project.part.generalBodies ?? []).map((body) => ({ id: body.id, name: body.name, visible: body.visible }))} initialTargetId={combineRequest.targetId} initialMode={combineRequest.mode} onApply={applyCombine} onCancel={() => setCombineRequest(null)} />}
    <CommandPalette open={paletteOpen} workspace={project.activeWorkspace} onClose={() => setPaletteOpen(false)} onCommand={executeCadCommand} />
    {shortcutsOpen && <div className="shortcuts-overlay" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" onClick={() => setShortcutsOpen(false)}>
      <div className="shortcuts-panel" onClick={(event) => event.stopPropagation()}>
        <header><strong>Keyboard shortcuts</strong><button onClick={() => setShortcutsOpen(false)} aria-label="Close keyboard shortcuts">×</button></header>
        <div className="shortcuts-grid">
          {SHORTCUT_GROUPS.map((group) => <section key={group.title}><h4>{group.title}</h4><dl>{group.items.map((item) => <div key={item.label}><dt>{item.keys.map((k) => <kbd key={k}>{k}</kbd>)}</dt><dd>{item.label}</dd></div>)}</dl></section>)}
        </div>
        <footer>Press <kbd>?</kbd> anytime to open this list · <kbd>Esc</kbd> to close</footer>
      </div>
    </div>}
    <ExchangeCenter open={exchangeOpen} busy={exchangeBusy} hasScene={!masterCartOpen && isThreeDimensional} exportContents={exchangeExportContents} activeImport={activeImport} feedback={exchangeFeedback} onClose={() => setExchangeOpen(false)} onImport={(files, unit) => void importExchangeFiles(files, unit)} onExport={(format, unit) => void exportExchangeFormat(format, unit)} onPdfPackage={() => void exportPdfPackage()} onInteractivePdf={(file) => void exportInteractivePdf(file)} onClearImport={clearActiveImport} />
    {designHealthOpen && <DesignHealthCenter report={designHealth} onClose={() => setDesignHealthOpen(false)} onWorkspace={switchWorkspace} />}
    <SaveProjectDialog open={saveDialogMode !== undefined} mode={saveDialogMode ?? "save-as"} projectName={project.name} workspaceStatus={fileWorkspaceStatus} onConfirm={(fileName) => void confirmSaveDialog(fileName)} onClose={() => setSaveDialogMode(undefined)} />
    <NewProjectDialog
      open={newDialogOpen}
      dirty={projectDirty}
      onConfirm={(name, workspace) => { setNewDialogOpen(false); void createNewProject(name, workspace); }}
      onSaveAndCreate={(name, workspace) => {
        setNewDialogOpen(false);
        void (async () => {
          await saveAll();
          if (projectRef.current.revision === savedRevisionRef.current) await createNewProject(name, workspace);
          else setStatusText("The project was not saved, so the new design was not created. Save it, then use File > New again.");
        })();
      }}
      onClose={() => setNewDialogOpen(false)}
    />
    <SketchPlaneDialog open={sketchPlaneDialogOpen} initialPlane={project.sketch.plane === "datum:xz" ? "xz" : project.sketch.plane === "datum:yz" ? "yz" : "xy"} initialOffsetMm={sketchPlaneDialogMode === "new" ? 0 : project.sketch.planeOffsetMm ?? 0} initialTilt={sketchPlaneDialogMode === "new" ? undefined : project.sketch.planeTilt} anglePlanes={anglePlaneOptions} framePlanes={framePlaneOptions} faces={sketchFaceOptions} onConfirm={confirmSketchPlane} onClose={() => setSketchPlaneDialogOpen(false)} />
    <FeatureEditDialog feature={featureEdit} busy={status === "working"} onApply={(next) => void updateTimelineSolid(next)} onClose={() => setFeatureEdit(undefined)} />
  </main>;
}

function ViewportMetrics(props: { readonly workspace: WorkspaceId; readonly model: ModelSuccessResponse | undefined; readonly imported: ExchangeImportResult | undefined; readonly project: WorkbenchProject; readonly interferenceCount: number; readonly surfaceTriangles: number; readonly vehicleAnalysis: ReturnType<typeof buildVehiclePreview>["analysis"]; readonly vehiclePrimitiveCount: number }): React.JSX.Element {
  if (props.workspace === "part" && props.imported !== undefined) return <div className="viewport-metrics"><div><span>Reference</span><strong>{props.imported.primaryFileName}</strong></div><div><span>Triangles</span><strong>{props.imported.metrics.triangleCount.toLocaleString()}</strong></div><div><span>Fidelity</span><strong>tessellated · {props.imported.sourceUnit}</strong></div></div>;
  if (props.workspace === "part") return <div className="viewport-metrics"><div><span>Body</span><strong>{props.model?.render.bodyId ?? "starting"}</strong></div><div><span>Triangles</span><strong>{props.model?.render.topology.triangles ?? "—"}</strong></div><div><span>Validity</span><strong>{props.model === undefined ? "pending" : "closed · manifold"}</strong></div></div>;
  if (props.workspace === "assembly") return <div className="viewport-metrics"><div><span>Components</span><strong>{props.project.assembly.components.filter((component) => component.visible).length}/{props.project.assembly.components.length} visible</strong></div><div><span>Mates</span><strong>{props.project.assembly.mates.filter((mate) => mate.status === "satisfied").length}/{props.project.assembly.mates.length} satisfied</strong></div><div><span>AABB candidates</span><strong>{props.interferenceCount}</strong></div></div>;
  if (props.workspace === "vehicle") return <div className="viewport-metrics vehicle"><div><span>Template</span><strong>{props.project.vehicle.template.replaceAll("-", " ")}</strong></div><div><span>State / primitives</span><strong>{props.project.vehicle.state.replaceAll("-", " ")} · {props.vehiclePrimitiveCount}</strong></div><div><span>Engineering screen</span><strong className={props.vehicleAnalysis.status}>{props.vehicleAnalysis.status} · {props.vehicleAnalysis.errors.length} blocked / {props.vehicleAnalysis.warnings.length} review</strong></div></div>;
  return <div className="viewport-metrics"><div><span>Surface</span><strong>{props.project.surface.mode}</strong></div><div><span>Triangles</span><strong>{props.surfaceTriangles}</strong></div><div><span>Boundary</span><strong>open · finite</strong></div></div>;
}

function defaultPartPreviewSize(shape: PartPreviewBodyShape): Vec3 {
  if (shape === "block") return [36, 28, 20];
  if (shape === "sphere") return [26, 26, 26];
  if (shape === "cone") return [28, 14, 34];
  // A torus uses sizeMm[0] as the major diameter and sizeMm[2] as the tube diameter; Y is unused.
  if (shape === "torus") return [40, 40, 10];
  return [28, 28, 34];
}

function partPreviewShapeLabel(shape: PartPreviewBodyShape): string {
  if (shape === "block") return "Block";
  if (shape === "cylinder") return "Cylinder";
  if (shape === "cone") return "Cone";
  if (shape === "torus") return "Torus";
  return "Sphere";
}

function partPreviewColor(shape: PartPreviewBodyShape): string {
  if (shape === "block") return "#b9bec5";
  if (shape === "cylinder") return "#d2d5da";
  if (shape === "cone") return "#adb3ba";
  if (shape === "torus") return "#bec4cc";
  return "#c5c9ce";
}

function clonePartPreviewBody(body: PartPreviewBody, suffix: string, deltaMm: Vec3): PartPreviewBody {
  return {
    ...body,
    id: `part-body:${crypto.randomUUID()}`,
    name: `${body.name} ${suffix}`,
    visible: true,
    translationMm: [body.translationMm[0] + deltaMm[0], body.translationMm[1] + deltaMm[1], body.translationMm[2] + deltaMm[2]]
  };
}

function orientedPreviewEnvelope(body: PartPreviewBody): Vec3 {
  if (body.shape === "sphere") return body.sizeMm;
  const half: Vec3 = body.shape === "block"
    ? [body.sizeMm[0] / 2, body.sizeMm[1] / 2, body.sizeMm[2] / 2]
    : [body.sizeMm[0] / 2, body.sizeMm[0] / 2, body.sizeMm[2] / 2];
  const rx = body.rotationDeg[0] * Math.PI / 180;
  const ry = body.rotationDeg[1] * Math.PI / 180;
  const rz = body.rotationDeg[2] * Math.PI / 180;
  const sx = Math.sin(rx); const cx = Math.cos(rx);
  const sy = Math.sin(ry); const cy = Math.cos(ry);
  const sz = Math.sin(rz); const cz = Math.cos(rz);
  const matrix = [
    [cy * cz, cz * sx * sy - cx * sz, sx * sz + cx * cz * sy],
    [cy * sz, cx * cz + sx * sy * sz, cx * sy * sz - cz * sx],
    [-sy, cy * sx, cx * cy]
  ] as const;
  return matrix.map((row) => 2 * row.reduce((sum, value, index) => sum + Math.abs(value) * half[index]!, 0)) as unknown as Vec3;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function isEditableTarget(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

/** Error text for file dialogs: turns the browser's gesture refusal into an instruction instead of raw API wording. */
function fileErrorText(error: unknown, fallback: string): string {
  const raw = error instanceof Error ? error.message : "";
  if (/user gesture|user activation/iu.test(raw)) return "The browser blocked its file dialog because it was not opened by a direct click. Click the button again.";
  return raw !== "" ? raw : fallback;
}

function electricalReferencePrefix(kind: ElectricalComponentKind): string {
  const prefixes: Readonly<Record<ElectricalComponentKind, string>> = {
    battery: "BAT", fuse: "F", disconnect: "QS", contactor: "K", inverter: "PCS", transformer: "T",
    breaker: "QF", load: "Y", motor: "M", ground: "PE", terminal: "X", sensor: "B", hvac: "HV"
  };
  return prefixes[kind];
}

function nextElectricalReference(references: readonly string[], prefix: string): string {
  const pattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(\\d+)$`, "u");
  const used = new Set(references.map((reference) => {
    const match = pattern.exec(reference);
    return match === null ? 0 : Number(match[1]);
  }).filter((value) => Number.isSafeInteger(value) && value > 0));
  let ordinal = 1;
  while (used.has(ordinal)) ordinal += 1;
  return `${prefix}${ordinal}`;
}

function nextElectricalPosition(positions: readonly (readonly [number, number])[]): readonly [number, number] | undefined {
  for (const y of [200, 330, 460] as const) {
    for (const x of [150, 330, 510, 690, 870, 1050, 1230, 1410] as const) {
      if (!isElectricalSheetPositionAvailable([x, y])) continue;
      if (positions.some((position) => Math.abs(position[0] - x) < 90 && Math.abs(position[1] - y) < 65)) continue;
      return [x, y];
    }
  }
  return undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled CAD command action: ${JSON.stringify(value)}`);
}
