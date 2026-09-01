import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  createBracketDocument,
  parameterByKey,
  type CadDocument,
  type Diagnostic,
  type DisplayUnit,
  type ParameterKey
} from "../../../packages/model-schema/src/index.js";
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
  isElectricalSheetPositionAvailable,
  parseWorkbenchProjectText,
  preferredElectromechanicalLayout,
  resolveWorkbenchContextCommands,
  validateWorkbenchProject,
  type AssemblyTemplateId,
  type CadCommandRecord,
  type ComponentInstance,
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
  type WorkbenchSketchConstraint,
  type Vec3,
  type WorkspaceId
} from "../../../packages/workbench-core/src/index.js";
import { assemblyExplodeLimitMm, buildAssemblyPreview, buildPartPreview, buildSurfacePreview, findAssemblyInterference } from "../../../packages/workbench-geometry/src/index.js";
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
import { resolveQualifiedExtrusion, sketchToolLabel, type SketchTool } from "../../../packages/workbench-sketch/src/index.js";
import {
  ThreeViewportAdapter,
  viewAnglesForOrientation,
  type NavigationMode,
  type SelectionFilter,
  type ViewOrientation,
  type ViewportMeasurePoint,
  type ViewportBackgroundTone,
  type ViewportViewState,
  type ViewProjection
} from "../../../packages/viewport-three/src/index.js";
import type { ModelSuccessResponse, WorkerResponse } from "../../../packages/worker-protocol/src/index.js";
import { GeometryWorkerClient } from "./worker-client.js";
import { loadWorkbenchProject, saveWorkbenchProject } from "./workbench-store.js";
import {
  clearCurrentProjectFile,
  clearPsCadCaches,
  getPsCadWorkspaceStatus,
  initializePsCadWorkspace,
  listRecentProjects,
  loadCachedWorkbenchProject,
  openProjectWithPicker,
  openRecentProject,
  preparePsCadLocalStorage,
  rememberOpenedProject,
  saveProjectText,
  writeWorkspaceArtifact,
  type ProjectFilePayload,
  type PsCadWorkspaceStatus,
  type RecentProjectEntry
} from "./file-workspace.js";
import { WorkbenchHeader } from "./ui/WorkbenchHeader.js";
import { WorkbenchRibbon } from "./ui/WorkbenchRibbon.js";
import { SaveProjectDialog } from "./ui/SaveProjectDialog.js";
import { ProjectTree } from "./ui/ProjectTree.js";
import { CommandPalette } from "./ui/CommandPalette.js";
import { ExchangeCenter } from "./ui/ExchangeCenter.js";
import { ViewportChrome } from "./ui/ViewportChrome.js";
import { CameraGestureControl, type CameraCursorState } from "./ui/CameraGestureControl.js";
import { DesignHealthCenter } from "./ui/DesignHealthCenter.js";
import { SmartFaultBrain } from "./ui/SmartFaultBrain.js";
import { WorkbenchContextMenu } from "./ui/WorkbenchContextMenu.js";
import { selectWorkbenchHistoryLane } from "./ui/history-lane.js";
import { SketchWorkspace, type SketchExtrudeOperation } from "./workspaces/SketchWorkspace.js";
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
  azimuthDeg: 45,
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
  const [model, setModel] = useState<ModelSuccessResponse>();
  const modelRef = useRef<ModelSuccessResponse | undefined>(undefined);
  const [status, setStatus] = useState<"starting" | "ready" | "working" | "error">("starting");
  const [statusText, setStatusText] = useState("Starting the isolated geometry engine…");
  const [diagnostic, setDiagnostic] = useState<UiDiagnostic>();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [treeRevealRequest, setTreeRevealRequest] = useState(0);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [exchangeOpen, setExchangeOpen] = useState(false);
  const [designHealthOpen, setDesignHealthOpen] = useState(false);
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
  const [sketchDimensionMode, setSketchDimensionMode] = useState(false);
  const [viewportState, setViewportState] = useState<ViewportViewState>(DEFAULT_VIEWPORT_STATE);
  const [measurePoints, setMeasurePoints] = useState<readonly ViewportMeasurePoint[]>([]);
  const [assemblyExplodePreviewMm, setAssemblyExplodePreviewMm] = useState<number | null>(null);
  const assemblyExplodeRef = useRef(initialProject.assembly.explodeMm);
  const [contextMenu, setContextMenu] = useState<OpenContextMenu>();
  const clientRef = useRef<GeometryWorkerClient | undefined>(undefined);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cameraCursorRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<ThreeViewportAdapter | undefined>(undefined);
  const renderCanvasRef = useRef<HTMLCanvasElement>(null);
  const renderViewportRef = useRef<ThreeViewportAdapter | undefined>(undefined);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const nativeInputRef = useRef<HTMLInputElement>(null);
  const engineeringDialogRef = useRef<HTMLElement>(null);

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
  const electromechanicalCandidate = useMemo(() => electromechanicalReviewOpen
    ? createElectromechanicalAssembly(
      project.electrical,
      preferredElectromechanicalLayout(project.electrical),
      defaultElectromechanicalMappings(project.electrical),
      project.revision,
      electrical.routing
    )
    : { ok: false as const, diagnostics: [] }, [electrical.routing, electromechanicalReviewOpen, project.electrical, project.revision]);

  const pushProject = useCallback((next: WorkbenchProject, persist = true): void => {
    const history = projectHistoryRef.current.slice(0, projectHistoryIndexRef.current + 1);
    history.push(next);
    projectHistoryRef.current = history;
    projectHistoryIndexRef.current = history.length - 1;
    setProjectUndoDepth(history.length - 1);
    setProjectRedoDepth(0);
    projectRef.current = next;
    setProject(next);
    if (persist) void saveWorkbenchProject(next).catch((error: unknown) => {
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : "The broad project could not be persisted.");
    });
  }, []);

  const resetProject = useCallback((next: WorkbenchProject): void => {
    projectHistoryRef.current = [next];
    projectHistoryIndexRef.current = 0;
    setProjectUndoDepth(0);
    setProjectRedoDepth(0);
    projectRef.current = next;
    setProject(next);
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
    for (const [parameter, value] of values) {
      if (Math.abs(projectRef.current.part[parameter] - value) > 1e-9) applyProjectOperation({ kind: "set-part-parameter", parameter, value }, false);
    }
    setDiagnostic(undefined);
    setStatus("ready");
    setStatusText(response.recoveredFromLocal ? `Recovered qualified solid revision ${response.currentRevision}.` : `Qualified solid revision ${response.currentRevision} validated.`);
  }, [applyProjectOperation]);

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
      if (response.status === "error" && response.diagnostics[0]?.code === "PERSISTENCE_FAILURE") acceptResponse(await client.bootstrap(documentRef.current, false, modelRef.current?.evidence ?? null));
      else acceptResponse(response);
    }).catch(() => undefined);
  }, [acceptResponse]);

  useEffect(() => {
    const client = new GeometryWorkerClient(restoreAfterFailure);
    clientRef.current = client;
    void client.bootstrap(initialDocument, true, null).then(async (response) => {
      if (response.status === "error" && response.diagnostics[0]?.code === "PERSISTENCE_FAILURE") acceptResponse(await client.bootstrap(initialDocument, false, null));
      else acceptResponse(response);
    }).catch(() => undefined);
    return () => { client.dispose(); clientRef.current = undefined; };
  }, [acceptResponse, initialDocument, restoreAfterFailure]);

  useEffect(() => () => {
    const imported = activeImportRef.current;
    imported?.releaseResources();
    if (imported !== undefined) disposeExchangeObject(imported.object);
  }, []);

  useEffect(() => {
    void loadWorkbenchProject().then((stored) => {
      if (stored === undefined) return saveWorkbenchProject(initialProject);
      resetProject(stored);
      setStatusText(`Recovered broad workbench project revision ${stored.revision}.`);
    }).catch(() => setStatusText("No durable broad project was recovered; using the original local study."));
  }, [initialProject, resetProject]);

  useEffect(() => {
    void preparePsCadLocalStorage()
      .then(refreshFileWorkspace)
      .catch(() => setStatusText("Browser-private recovery storage is unavailable; standard file downloads remain available."));
  }, [refreshFileWorkspace]);

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!exchangeOpen && !electromechanicalReviewOpen && pendingAssemblyTemplate === undefined && pendingElectricalTemplate === undefined && pendingVehicleTemplate === undefined) setPaletteOpen(true);
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
      onContextMenu: (request) => openContextMenu(request.clientX, request.clientY, request.semanticId, request.selectionKind === "body" || request.selectionKind === "component" ? request.selectionKind : undefined),
      ...(project.activeWorkspace === "assembly" ? { assemblyTouchGestures: {
        getExplodeMm: () => assemblyExplodeRef.current,
        onExplodePreview: previewAssemblyExplode,
        onExplodeCommit: commitAssemblyExplode,
        maxExplodeMm: assemblyExplodeMaxMm
      } } : {})
    });
    viewport.restoreViewState(viewportState);
    viewportRef.current = viewport;
    return () => { viewport.dispose(); viewportRef.current = undefined; };
  }, [acceptMeasurePoint, assemblyExplodeMaxMm, commitAssemblyExplode, isThreeDimensional, masterCartOpen, openContextMenu, previewAssemblyExplode, project.activeWorkspace]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport === undefined) return;
    if (project.activeWorkspace === "part" && activeImport !== undefined) viewport.setExternalObject(activeImport.object);
    else if (project.activeWorkspace === "part" && model !== undefined) { viewport.setArtifactWithScene(model.render, partScene); viewport.fitPreview(partScene.boundsMm); }
    if (project.activeWorkspace === "assembly") viewport.setScene(assemblyScene);
    if (project.activeWorkspace === "surface") viewport.setScene(surfacePreview.scene);
    if (project.activeWorkspace === "vehicle") viewport.setScene(vehiclePreview.scene);
  }, [activeImport, assemblyScene, model, partScene, project.activeWorkspace, surfacePreview.scene, vehiclePreview.scene]);
  useEffect(() => viewportRef.current?.setSelectedId(selectedId), [selectedId]);
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
    viewport.setProjection(renderSettings.projection);
    viewport.setOrientation(renderSettings.orientation);
  }, [renderSettings]);

  const switchWorkspace = (workspace: WorkspaceId): void => {
    setMasterCartOpen(false);
    setRenderStudioOpen(false);
    setContextMenu(undefined);
    setSelectedId(null);
    setMeasurePoints([]);
    if (workspace !== "sketch") setViewportState((current) => ["sketch-curve", "profile", "connected", "tangent"].includes(current.selectionFilter) ? { ...current, selectionFilter: "auto" } : current);
    const current = projectRef.current;
    if (workspace === current.activeWorkspace) return;
    const next = { ...current, activeWorkspace: workspace };
    projectRef.current = next;
    setProject(next);
    projectHistoryRef.current[projectHistoryIndexRef.current] = next;
    void saveWorkbenchProject(next).catch(() => undefined);
    setStatus("ready");
    setStatusText(`Opened ${workspace === "automate" ? "Automate" : `${workspace[0]!.toUpperCase()}${workspace.slice(1)}`} workspace without changing engineering revision ${current.revision}.`);
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

  const runPartFeatureAction = (operation: Extract<CadCommandRecord["action"], { kind: "part-feature-action" }>["operation"], commandName: string, bodyIdOverride: string | null = selectedId): void => {
    const current = projectRef.current;
    const bodies = current.part.previewBodies ?? [];
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
    const ordinal = current.assembly.components.length + 1;
    const component: ComponentInstance = {
      id: `component:user-${crypto.randomUUID()}`,
      name: `${shape === "box" ? "Box" : "Cylinder"} ${ordinal}`,
      shape,
      grounded: false,
      visible: true,
      color: shape === "box" ? "#5cc2d6" : "#e3a34e",
      translationMm: [((ordinal - 1) % 4) * 18 - 27, Math.floor((ordinal - 1) / 4) * 18, shape === "box" ? 8 : 14],
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
    const catalogInstanceCount = new Set(current.assembly.components.flatMap((component) => component.masterCart === undefined ? [] : [component.masterCart.instanceId])).size;
    const placement: Vec3 = [105 + (catalogInstanceCount % 4) * 90, -55 + Math.floor(catalogInstanceCount / 4) * 90, 0];
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
    if (projectRef.current.assembly.electromechanicalSource === undefined) {
      applyProjectOperation({ kind: "apply-assembly-template", template });
      return;
    }
    setPendingAssemblyTemplate(template);
    setStatus("ready");
    setStatusText("Review required before replacing the linked electromechanical assembly.");
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

  const executeCadCommand = (command: CadCommandRecord): void => {
    const action = command.action;
    if (action.kind === "open-design-health") {
      openDesignHealth();
      return;
    }
    if (action.kind === "file-new") { void createNewProject(); return; }
    if (action.kind === "file-open") { void openProjectFromSystem(); return; }
    if (action.kind === "file-save") { void saveAll(); return; }
    if (action.kind === "file-save-as") { setSaveDialogMode("save-as"); return; }
    if (action.kind === "file-save-copy") { setSaveDialogMode("copy"); return; }
    if (action.kind === "file-workspace") { void connectFileWorkspace(); return; }
    if (action.kind === "open-render-studio") { openRenderStudio(); return; }
    switchWorkspace(command.workspace);
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
        setSketchTool(action.tool);
        setStatusText(`${command.name} tool active from the command launcher.`);
        break;
      case "select-record":
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
        viewportRef.current?.setShadingMode(action.mode);
        setStatusText(`${command.name} display mode active.`);
        break;
      case "set-background-tone":
        viewportRef.current?.setBackgroundTone(action.tone);
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
      commandId: `command:${qualifiedKey}-${crypto.randomUUID()}`,
      expectedRevision: documentRef.current.revision,
      parameterKey: qualifiedKey,
      expression: { decimal: String(value), unit: "mm" }
    }).catch(() => undefined);
    if (response !== undefined) acceptResponse(response);
  };

  const extrudeSketchProfiles = async (profileIds: readonly string[], distanceMm: number, operation: SketchExtrudeOperation): Promise<void> => {
    if (operation !== "new-body" && operation !== "new-component") {
      setStatus("error");
      setStatusText("Join, Cut and Intersect require persistent B-rep topology and an overlap preview; no Boolean was attempted.");
      return;
    }
    const resolved = resolveQualifiedExtrusion(projectRef.current.sketch, profileIds, distanceMm);
    if (!resolved.ok) {
      const first = resolved.diagnostics[0];
      setDiagnostic(first === undefined ? undefined : { code: first.code, message: first.message, recovery: first.recovery });
      setStatus("error");
      setStatusText(first?.message ?? "The sketch profiles cannot be extruded by the qualified evaluator.");
      return;
    }
    const client = clientRef.current;
    if (client === undefined || status === "working") return;
    const parameters: readonly (readonly [ParameterKey, number])[] = [
      ["width", resolved.value.widthMm],
      ["height", resolved.value.heightMm],
      ["holeDiameter", resolved.value.holeDiameterMm],
      ["thickness", resolved.value.distanceMm]
    ];
    setStatus("working");
    setStatusText("Regenerating the selected closed profiles in the qualified solid worker…");
    for (const [parameterKey, value] of parameters) {
      const current = parameterByKey(documentRef.current, parameterKey).valueMeters * 1000;
      if (Math.abs(current - value) < 1e-9) continue;
      const response = await client.commit(documentRef.current.revision, {
        protocolVersion: 1,
        kind: "set-parameter",
        commandId: `command:profile-extrude-${parameterKey}-${crypto.randomUUID()}`,
        expectedRevision: documentRef.current.revision,
        parameterKey,
        expression: { decimal: String(value), unit: "mm" }
      }).catch(() => undefined);
      if (response === undefined || !acceptResponse(response)) return;
    }
    if (operation === "new-component") {
      const component: ComponentInstance = {
        id: `component:sketch-extrusion-${crypto.randomUUID()}`,
        name: `${projectRef.current.sketch.name} extrusion`,
        shape: "plate",
        grounded: false,
        visible: true,
        color: "#aeb3b8",
        translationMm: [0, 0, resolved.value.distanceMm / 2],
        rotationDeg: [0, 0, 0],
        sizeMm: [resolved.value.widthMm, resolved.value.heightMm, resolved.value.distanceMm],
        explosionDirection: [0.2, -0.14, 0.65]
      };
      if (!applyProjectOperation({ kind: "add-assembly-component", component })) return;
      switchWorkspace("assembly");
      setSelectedId(component.id);
    } else {
      switchWorkspace("part");
      setSelectedId("feature:plate-extrusion");
    }
    setStatus("ready");
    setStatusText(`Created qualified ${resolved.value.widthMm} × ${resolved.value.heightMm} × ${resolved.value.distanceMm} mm ${operation === "new-component" ? "component" : "body"} with Ø${resolved.value.holeDiameterMm} mm through-bore from associative sketch profiles.`);
  };

  const changeUnit = async (unit: DisplayUnit): Promise<void> => {
    if (unit === documentRef.current.displayUnit || clientRef.current === undefined) return;
    setStatus("working");
    const response = await clientRef.current.commit(documentRef.current.revision, { protocolVersion: 1, kind: "set-display-unit", commandId: `command:display-unit-${crypto.randomUUID()}`, expectedRevision: documentRef.current.revision, displayUnit: unit }).catch(() => undefined);
    if (response !== undefined) acceptResponse(response);
  };

  const moveHistory = async (direction: "undo" | "redo"): Promise<void> => {
    if (projectRef.current.activeWorkspace !== "part") { moveProjectHistory(direction); return; }
    const client = clientRef.current;
    if (client === undefined) return;
    setStatus("working");
    const response = await client.history(documentRef.current.revision, direction, `command:${direction}-${crypto.randomUUID()}`).catch(() => undefined);
    if (response !== undefined) acceptResponse(response);
  };

  const moveProjectHistory = (direction: "undo" | "redo"): void => {
    const delta = direction === "undo" ? -1 : 1;
    const nextIndex = projectHistoryIndexRef.current + delta;
    if (nextIndex < 0 || nextIndex >= projectHistoryRef.current.length) return;
    projectHistoryIndexRef.current = nextIndex;
    const next = projectHistoryRef.current[nextIndex]!;
    projectRef.current = next;
    setProject(next);
    setProjectUndoDepth(nextIndex);
    setProjectRedoDepth(projectHistoryRef.current.length - nextIndex - 1);
    void saveWorkbenchProject(next);
    setStatusText(`${direction === "undo" ? "Restored prior" : "Restored next"} broad project revision ${next.revision}.`);
  };

  const serializeProjectText = (): string => `${JSON.stringify(projectRef.current, null, 2)}\n`;

  const saveVisibleProject = async (mode: "save" | "save-as" | "copy", suggestedName: string): Promise<void> => {
    const current = projectRef.current;
    const outcome = await saveProjectText(serializeProjectText(), {
      mode,
      suggestedName,
      projectName: current.name,
      revision: current.revision
    });
    await refreshFileWorkspace();
    setStatus("ready");
    setStatusText(`${outcome.fileName} saved to ${outcome.destination === "workspace" ? `${outcome.workspaceName ?? "PS CAD Studio"} / Projects` : outcome.destination === "file-picker" ? "the approved file location" : "Downloads"}.`);
  };

  const saveAll = async (): Promise<void> => {
    setStatus("working");
    try {
      await saveWorkbenchProject(projectRef.current);
      const response = await clientRef.current?.persist(documentRef.current.revision);
      if (response !== undefined && !acceptResponse(response)) return;
      await saveVisibleProject("save", fileWorkspaceStatus.currentFileName ?? projectRef.current.name);
    } catch (error) {
      if (isAbortError(error)) { setStatus("ready"); setStatusText("Save cancelled; the browser recovery copy is still current."); return; }
      setStatus("error"); setStatusText(error instanceof Error ? error.message : "Local save failed.");
    }
  };

  const openProjectPayload = async (payload: ProjectFilePayload): Promise<void> => {
    const parsed = parseWorkbenchProjectText(payload.text);
    if (!parsed.ok) {
      await clearCurrentProjectFile().catch(() => undefined);
      const first = parsed.diagnostics[0];
      setStatus("error");
      setStatusText(first?.message ?? "Project rejected.");
      return;
    }
    resetProject(parsed.value);
    await saveWorkbenchProject(parsed.value);
    await rememberOpenedProject(payload.fileName, parsed.value);
    await refreshFileWorkspace();
    setRenderStudioOpen(false);
    setMasterCartOpen(false);
    setStatus("ready");
    setStatusText(`Opened ${payload.fileName}, project revision ${parsed.value.revision}.`);
    void synchronizeWorkerPart(parsed.value);
  };

  const openProjectFromSystem = async (): Promise<void> => {
    try {
      const payload = await openProjectWithPicker();
      if (payload === undefined) { projectInputRef.current?.click(); return; }
      await openProjectPayload(payload);
    } catch (error) {
      if (isAbortError(error)) { setStatusText("Open project cancelled."); return; }
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : "The project could not be opened.");
    }
  };

  const openProject = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (file === undefined) return;
    await clearCurrentProjectFile().catch(() => undefined);
    await openProjectPayload({ text: await file.text(), fileName: file.name });
  };

  const synchronizeWorkerPart = async (next: WorkbenchProject): Promise<void> => {
    for (const [parameter, key] of Object.entries(QUALIFIED_PART_KEYS) as [PartParameter, ParameterKey][]) {
      const current = parameterByKey(documentRef.current, key).valueMeters * 1000;
      const target = next.part[parameter];
      if (Math.abs(current - target) < 1e-9 || clientRef.current === undefined) continue;
      const response = await clientRef.current.commit(documentRef.current.revision, { protocolVersion: 1, kind: "set-parameter", commandId: `command:project-open-${key}-${crypto.randomUUID()}`, expectedRevision: documentRef.current.revision, parameterKey: key, expression: { decimal: String(target), unit: "mm" } });
      if (!acceptResponse(response)) break;
    }
  };

  const createNewProject = async (): Promise<void> => {
    setStatus("working");
    try {
      const nextProject = createWorkbenchProject(`project:${crypto.randomUUID()}`);
      const nextDocument = createBracketDocument(`document:${crypto.randomUUID()}`);
      const imported = activeImportRef.current;
      imported?.releaseResources();
      if (imported !== undefined) disposeExchangeObject(imported.object);
      activeImportRef.current = undefined;
      setActiveImport(undefined);
      setSelectedId(null);
      setMeasurePoints([]);
      setMasterCartOpen(false);
      setRenderStudioOpen(false);
      await clearCurrentProjectFile();
      resetProject(nextProject);
      setDocument(nextDocument);
      documentRef.current = nextDocument;
      setModel(undefined);
      modelRef.current = undefined;
      await saveWorkbenchProject(nextProject);
      const client = clientRef.current;
      if (client !== undefined) {
        client.restart();
        const response = await client.bootstrap(nextDocument, false, null);
        if (!acceptResponse(response)) return;
      }
      await refreshFileWorkspace();
      setStatus("ready");
      setStatusText("Created a new unsaved PS3D design with a clean history and independent recovery identity.");
    } catch (error) {
      setStatus("error");
      setStatusText(error instanceof Error ? error.message : "A new design could not be created.");
    }
  };

  const reopenRecentProject = async (id: string): Promise<void> => {
    setStatus("working");
    try { await openProjectPayload(await openRecentProject(id)); }
    catch (error) {
      if (isAbortError(error)) { setStatus("ready"); setStatusText("Recent project opening cancelled."); return; }
      setStatus("error"); setStatusText(error instanceof Error ? error.message : "The recent project could not be reopened.");
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
      setStatus("error"); setStatusText(error instanceof Error ? error.message : "The PS CAD Studio folder could not be connected.");
    }
  };

  const recoverAutosave = async (): Promise<void> => {
    setStatus("working");
    try {
      const recovered = await loadCachedWorkbenchProject();
      if (recovered === undefined) { setStatus("ready"); setStatusText("No validated browser-private autosave is available."); return; }
      await clearCurrentProjectFile();
      resetProject(recovered);
      await saveWorkbenchProject(recovered);
      await refreshFileWorkspace();
      setMasterCartOpen(false);
      setRenderStudioOpen(false);
      setStatus("ready");
      setStatusText(`Recovered project revision ${recovered.revision} as an unsaved session. Use Save As to create a visible file.`);
      void synchronizeWorkerPart(recovered);
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
      await saveWorkbenchProject(projectRef.current);
      await saveVisibleProject(mode, fileName);
    } catch (error) {
      if (isAbortError(error)) { setStatus("ready"); setStatusText("Save cancelled; the active project was not rebound."); return; }
      setStatus("error"); setStatusText(error instanceof Error ? error.message : "The project file could not be written.");
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
    else { await clientRef.current.persist(response.currentRevision); acceptModel(response); setStatusText(`Imported and validated native solid revision ${response.currentRevision}.`); }
  };

  const downloadNative = async (): Promise<void> => {
    if (modelRef.current === undefined) return;
    const serialized = await serializeNativeRevision({ document: documentRef.current, evidence: modelRef.current.evidence });
    if (serialized.ok) downloadBlob(new Blob([serialized.value], { type: "application/json" }), "ps3d-qualified-solid.ps3d.json");
  };

  const exportStl = async (): Promise<void> => {
    const response = await clientRef.current?.exportStl(documentRef.current.revision, documentRef.current.displayUnit);
    if (response === undefined || !acceptResponse(response) || response.kind !== "export-stl") return;
    downloadBlob(new Blob([response.bytes], { type: "model/stl" }), `ps3d-mounting-plate-${response.unit}.stl`);
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
    if (projectRef.current.activeWorkspace === "part" && activeImportRef.current !== undefined) viewportRef.current?.fitCurrent();
    else if (projectRef.current.activeWorkspace === "part") viewportRef.current?.fitPreview(partScene.boundsMm);
    if (projectRef.current.activeWorkspace === "assembly") viewportRef.current?.fitPreview(assemblyScene.boundsMm);
    if (projectRef.current.activeWorkspace === "surface") viewportRef.current?.fitPreview(surfacePreview.scene.boundsMm);
    if (projectRef.current.activeWorkspace === "vehicle") viewportRef.current?.fitPreview(vehiclePreview.scene.boundsMm);
  };

  const setViewportNavigation = (mode: NavigationMode): void => {
    if (viewportRef.current === undefined) setViewportState((current) => ({ ...current, navigationMode: mode }));
    else viewportRef.current.setNavigationMode(mode);
    setStatusText(mode === "measure" ? "Measure active: pick two visible model points." : `${mode[0]!.toUpperCase()}${mode.slice(1)} navigation active.`);
  };

  const setViewportSelectionFilter = (filter: SelectionFilter): void => {
    if (viewportRef.current === undefined) setViewportState((current) => ({ ...current, selectionFilter: filter }));
    else viewportRef.current.setSelectionFilter(filter);
    setStatusText(`${filter === "auto" ? "Automatic" : filter} selection priority active.`);
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
    if (viewportRef.current === undefined) setViewportState((current) => ({ ...current, orientation: "custom", azimuthDeg, elevationDeg }));
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
    viewportRef.current?.setOrientation("isometric");
    if (viewportRef.current === undefined) setViewportOrientation("isometric");
    fitViewport();
    setStatusText("Isometric home view fitted to visible geometry.");
  };

  const runContextCommand = (commandId: string): void => {
    const selectionId = contextMenu?.selectionId ?? selectedId;
    setContextMenu(undefined);
    if (commandId === "history.undo") { void moveHistory("undo"); return; }
    if (commandId === "history.redo") { void moveHistory("redo"); return; }
    if (commandId === "view.fit") { fitViewport(); return; }
    if (commandId === "view.home") { homeViewport(); return; }
    if (commandId.startsWith("view.orientation.")) {
      const orientation = commandId.slice("view.orientation.".length);
      if (orientation === "front" || orientation === "top" || orientation === "right" || orientation === "isometric") setViewportOrientation(orientation);
      return;
    }
    if (commandId === "view.projection.perspective") { setViewportProjection("perspective"); return; }
    if (commandId === "view.projection.orthographic") { setViewportProjection("orthographic"); return; }
    if (commandId === "view.look-at" || commandId === "sketch.look-at") { setViewportOrientation(selectionId === "datum:yz" ? "right" : selectionId === "datum:xz" ? "front" : "top"); return; }
    if (commandId === "inspect.measure") { setViewportNavigation("measure"); return; }
    if (commandId === "sketch.create" || commandId === "sketch.edit") { switchWorkspace("sketch"); if (selectionId !== null) setSelectedId(selectionId); return; }
    if (commandId === "sketch.finish") { switchWorkspace("part"); return; }
    if (commandId === "sketch.select-profile") { setViewportSelectionFilter("profile"); return; }
    if (commandId === "sketch.select-curve") { setViewportSelectionFilter("sketch-curve"); return; }
    if (commandId === "sketch.select-connected") { setViewportSelectionFilter("connected"); return; }
    if (commandId === "sketch.select-tangent") { setViewportSelectionFilter("tangent"); return; }
    if (commandId === "sketch.dimension") {
      setSketchTool("select");
      setSketchDimensionMode(true);
      setViewportNavigation("select");
      setViewportSelectionFilter("sketch-curve");
      if (selectionId !== null) setSelectedId(selectionId);
      setStatusText("Sketch Dimension active: select a curve or two displayed definition points, then edit the driving value in the inspector.");
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
    if (commandId === "body.create-component") { insertCurrentPartIntoAssembly(); return; }
    if (commandId === "component.move" || commandId === "mate.create" || commandId === "mate.edit") { switchWorkspace("assembly"); if (selectionId !== null) setSelectedId(selectionId); return; }
    if (commandId === "component.ground" && selectionId !== null) { applyProjectOperation({ kind: "toggle-component-grounded", componentId: selectionId }); return; }
    if (commandId === "selection.toggle-visibility" && selectionId !== null) {
      if (selectionId.startsWith("entity:")) applyProjectOperation({ kind: "toggle-sketch-entity-visibility", entityId: selectionId });
      else if (selectionId.startsWith("component:")) applyProjectOperation({ kind: "toggle-component-visibility", componentId: selectionId });
      else if (selectionId.startsWith("part-body:")) applyProjectOperation({ kind: "toggle-part-preview-body-visibility", bodyId: selectionId });
      return;
    }
    if (commandId === "selection.isolate" && selectionId?.startsWith("part-body:") === true) { applyProjectOperation({ kind: "isolate-part-preview-body", bodyId: selectionId }); return; }
    if (commandId === "selection.delete" && selectionId !== null) {
      if (selectionId.startsWith("entity:")) applyProjectOperation({ kind: "delete-sketch-entity", entityId: selectionId });
      else if (selectionId.startsWith("part-body:")) applyProjectOperation({ kind: "delete-part-preview-body", bodyId: selectionId });
      else if (selectionId.startsWith("component:")) deleteAssemblyComponent(selectionId);
      else if (selectionId.startsWith("mate:")) applyProjectOperation({ kind: "delete-assembly-mate", mateId: selectionId });
      setSelectedId(null);
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
      if (!(isThreeDimensional || projectRef.current.activeWorkspace === "sketch") || isEditableTarget(event.target) || globalThis.document.querySelector('[role="dialog"]') !== null) return;
      const key = event.key.toLowerCase();
      if (key === "f") fitViewport();
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
  }, [isThreeDimensional]);

  const downloadProject = (): void => downloadBlob(new Blob([JSON.stringify(projectRef.current, null, 2)], { type: "application/json" }), "ps3d-fixture-study.workbench.json");
  const downloadDrawing = (): void => downloadBlob(new Blob([drawing.svg], { type: "image/svg+xml" }), "ps3d-centered-bore-plate.svg");
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
      if (key === "n") { event.preventDefault(); void createNewProject(); }
      if (key === "p") { event.preventDefault(); window.print(); }
      if (key === "h" && event.shiftKey) { event.preventDefault(); openDesignHealth(); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [openDesignHealth, renderStudioOpen]);
  const undoLane = selectWorkbenchHistoryLane(project.activeWorkspace, undoDepth, projectUndoDepth);
  const redoLane = selectWorkbenchHistoryLane(project.activeWorkspace, redoDepth, projectRedoDepth);
  const canUndo = undoLane !== null;
  const canRedo = redoLane !== null;
  const contextCommands = contextMenu === undefined ? [] : resolveWorkbenchContextCommands({ workspace: project.activeWorkspace, selectionId: contextMenu.selectionId, selectionKind: contextMenu.selectionKind, canUndo, canRedo });

  return <main className="studio-app" data-workspace={renderStudioOpen ? "render-studio" : masterCartOpen ? "master-cart" : project.activeWorkspace} aria-busy={status === "working"}>
    <WorkbenchHeader
      project={project}
      masterCartOpen={masterCartOpen}
      renderStudioOpen={renderStudioOpen}
      status={status}
      fileWorkspaceStatus={fileWorkspaceStatus}
      recentProjects={recentProjects}
      onWorkspace={switchWorkspace}
      onMasterCart={openMasterCart}
      onRenderStudio={openRenderStudio}
      onCommandPalette={() => setPaletteOpen(true)}
      onDesignHealth={openDesignHealth}
      onExchange={() => setExchangeOpen(true)}
      onLearning={() => window.location.assign("/learn")}
      onAccess={() => window.location.assign("/access")}
      onNew={() => void createNewProject()}
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
      onUndo={() => undoLane === "qualified-part" ? void moveHistory("undo") : moveProjectHistory("undo")}
      onRedo={() => redoLane === "qualified-part" ? void moveHistory("redo") : moveProjectHistory("redo")}
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
      onSketchTool={(tool) => { setSketchTool(tool); setSketchDimensionMode(false); setStatusText(`${sketchToolLabel(tool)} tool active in the top ribbon.`); }}
      onSketchDimension={() => { setSketchTool("select"); setSketchDimensionMode(true); setViewportNavigation("select"); setViewportSelectionFilter("sketch-curve"); setStatusText("Sketch Dimension active: select a curve or two displayed definition points."); }}
      onToggleSketchEntityVisibility={(entityId) => applyProjectOperation({ kind: "toggle-sketch-entity-visibility", entityId })}
      onFinishSketch={() => { switchWorkspace("part"); setStatusText("Sketch session finished. Revisioned sketch geometry remains linked to the Part workspace."); }}
      onCancelSketchPoints={() => { setSketchCancelVersion((version) => version + 1); setStatusText("Pending sketch points cleared from the top ribbon."); }}
      onSelect={setSelectedId}
      onCreatePartPreviewBody={createPartPreviewBody}
      onPartPreviewAction={(operation, commandName) => runSelectedPartPreviewAction(operation, commandName)}
      onPartFeatureAction={(operation, commandName) => runPartFeatureAction(operation, commandName)}
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
      onElectricalDownload={() => downloadBlob(new Blob([electrical.svg], { type: "image/svg+xml" }), "ps3d-electrical-concept.svg")}
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
      {!masterCartOpen && <ProjectTree project={project} selectedId={selectedId} revealSelectionRequest={treeRevealRequest} designHealth={designHealth} onSelect={setSelectedId} onContextMenu={openContextMenu} />}
      {!masterCartOpen && project.activeWorkspace === "sketch" && <SketchWorkspace sketch={project.sketch} tool={sketchTool} dimensionMode={sketchDimensionMode} cancelVersion={sketchCancelVersion} selectedId={selectedId} onSelect={setSelectedId} onAddEntity={(entity: SketchEntity) => applyProjectOperation({ kind: "add-sketch-entity", entity })} onDeleteEntity={(entityId) => { if (applyProjectOperation({ kind: "delete-sketch-entity", entityId })) setSelectedId(null); }} onAddConstraint={(constraint: WorkbenchSketchConstraint) => applyProjectOperation({ kind: "add-sketch-constraint", constraint })} onDeleteConstraint={(constraintId) => applyProjectOperation({ kind: "delete-sketch-constraint", constraintId })} onSetDimension={(entityId, dimension, valueMm) => applyProjectOperation({ kind: "set-sketch-dimension", entityId, dimension, valueMm })} onToggleConstruction={(entityId) => applyProjectOperation({ kind: "toggle-sketch-construction", entityId })} onToggleVisibility={(entityId) => applyProjectOperation({ kind: "toggle-sketch-entity-visibility", entityId })} onExtrudeProfiles={extrudeSketchProfiles} viewportState={viewportState} onNavigationMode={setViewportNavigation} onSelectionFilter={setViewportSelectionFilter} onOrientation={setViewportOrientation} onViewAngles={setViewportAngles} onProjection={setViewportProjection} onGrid={setViewportGrid} onAxes={setViewportAxes} onFit={() => setStatusText("Sketch fit is already bounded to all visible entities.")} onHome={homeViewport} onContextMenu={openContextMenu} working={status === "working"} onMessage={setStatusText} />}
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
      </section>}
      {!masterCartOpen && <>
      {project.activeWorkspace === "part" && activeImport === undefined && <PartInspector part={project.part} model={model} working={status === "working"} bodyColor={viewportState.bodyColor} shadingMode={viewportState.shadingMode} selectedId={selectedId} onSelect={setSelectedId} onBodyColor={(color) => viewportRef.current?.setBodyColor(color)} onShadingMode={(mode) => viewportRef.current?.setShadingMode(mode)} onCommit={(parameter, value) => void commitPartParameter(parameter, value)} onInsertIntoAssembly={insertCurrentPartIntoAssembly} onCreatePreviewBody={createPartPreviewBody} onPreviewBodyTransform={(bodyId, translationMm, rotationDeg) => applyProjectOperation({ kind: "set-part-preview-body-transform", bodyId, translationMm, rotationDeg })} onPreviewBodySize={(bodyId, sizeMm) => applyProjectOperation({ kind: "set-part-preview-body-size", bodyId, sizeMm })} onPreviewBodyColor={(bodyId, color) => applyProjectOperation({ kind: "set-part-preview-body-color", bodyId, color })} onPreviewBodyVisibility={(bodyId) => applyProjectOperation({ kind: "toggle-part-preview-body-visibility", bodyId })} onPreviewBodyDelete={(bodyId) => { if (applyProjectOperation({ kind: "delete-part-preview-body", bodyId })) setSelectedId(null); }} />}
      {project.activeWorkspace === "part" && activeImport !== undefined && <ImportedModelInspector result={activeImport} onExchange={() => setExchangeOpen(true)} onClear={clearActiveImport} />}
      {project.activeWorkspace === "assembly" && <AssemblyInspector assembly={displayedAssembly} maxExplodeMm={assemblyExplodeMaxMm} selectedId={selectedId} interferences={interferences} onTemplate={requestAssemblyTemplate} onExplodePreview={previewAssemblyExplode} onExplodeCommit={commitAssemblyExplode} onMove={(componentId, translationMm) => applyProjectOperation({ kind: "set-component-translation", componentId, translationMm })} onToggleGrounded={(componentId) => applyProjectOperation({ kind: "toggle-component-grounded", componentId })} onToggleVisible={(componentId) => applyProjectOperation({ kind: "toggle-component-visibility", componentId })} onDelete={deleteAssemblyComponent} onAddMate={(mate) => applyProjectOperation({ kind: "add-assembly-mate", mate })} onDeleteMate={(mateId) => { if (applyProjectOperation({ kind: "delete-assembly-mate", mateId })) setSelectedId(null); }} onSelect={setSelectedId} onOpenElectricalSource={(componentId) => { switchWorkspace("electrical"); setSelectedId(componentId ?? null); setTreeRevealRequest((request) => request + 1); }} />}
      {project.activeWorkspace === "surface" && <SurfaceInspector surface={project.surface} metrics={surfacePreview.metrics} onParameter={(parameter, value) => applyProjectOperation({ kind: "set-surface-parameter", parameter, value })} />}
      {project.activeWorkspace === "drawing" && <DrawingWorkspace settings={project.drawing} artifact={drawing} onSheet={(sheet) => applyProjectOperation({ kind: "set-drawing-sheet", sheet })} onProjection={(projection) => applyProjectOperation({ kind: "set-drawing-projection", projection })} onScale={(scale) => applyProjectOperation({ kind: "set-drawing-scale", scale })} onDimensions={(show) => applyProjectOperation({ kind: "set-drawing-dimensions", show })} onViewPreset={(preset) => applyProjectOperation({ kind: "set-drawing-view-preset", preset })} onDisplayStyle={(style) => applyProjectOperation({ kind: "set-drawing-display-style", style })} onSectionView={(show) => applyProjectOperation({ kind: "set-drawing-section-view", show })} onDraftingStandard={(standard) => applyProjectOperation({ kind: "set-drawing-drafting-standard", standard })} onGdt={(show) => applyProjectOperation({ kind: "set-drawing-gdt", show })} onDatumScheme={(scheme) => applyProjectOperation({ kind: "set-drawing-datum-scheme", scheme })} onGdtSpecification={(positionMm, flatnessMm, perpendicularityMm) => applyProjectOperation({ kind: "set-drawing-gdt-specification", positionMm, flatnessMm, perpendicularityMm })} onGeneralTolerance={(linearMm, angularDeg) => applyProjectOperation({ kind: "set-drawing-general-tolerance", linearMm, angularDeg })} onNotes={(notes) => applyProjectOperation({ kind: "set-drawing-notes", notes })} />}
      {project.activeWorkspace === "electrical" && <ElectricalWorkspace intent={project.electrical} artifact={electrical} selectedId={selectedId} onSelect={setSelectedId} onTemplate={requestElectricalTemplate} onStandard={(standard) => applyProjectOperation({ kind: "set-electrical-standard", standard })} onInsertComponent={insertElectricalComponent} onMoveComponent={(componentId, position) => applyProjectOperation({ kind: "set-electrical-component-position", componentId, position })} onDeleteComponent={(componentId) => { if (applyProjectOperation({ kind: "delete-electrical-component", componentId })) setSelectedId(null); }} onAddNet={addElectricalNet} onDeleteNet={(netId) => { if (applyProjectOperation({ kind: "delete-electrical-net", netId })) setSelectedId(null); }} onNotes={(notes) => applyProjectOperation({ kind: "set-electrical-notes", notes })} onPhysicalize={requestElectromechanicalAssembly} onDownload={() => downloadBlob(new Blob([electrical.svg], { type: "image/svg+xml" }), "ps3d-electrical-concept.svg")} />}
      {project.activeWorkspace === "vehicle" && <VehicleWorkspace intent={project.vehicle} analysis={vehiclePreview.analysis} geometry={vehiclePreview.geometry} primitiveCountByLayer={vehiclePreview.primitiveCountByLayer} selectedId={selectedId} onSelect={setSelectedId} onTemplate={requestVehicleTemplate} onParameter={(parameter, value) => applyProjectOperation({ kind: "set-vehicle-parameter", parameter, value })} onState={(state) => applyProjectOperation({ kind: "set-vehicle-simulation-state", state })} onLayer={(layer) => applyProjectOperation({ kind: "toggle-vehicle-layer", layer })} onFit={fitViewport} />}
      {project.activeWorkspace === "automate" && <AutomateWorkspace project={project} selectedId={selectedId} onSelect={setSelectedId} onApplyProject={(next, message) => { const valid = validateWorkbenchProject(next); if (valid.ok) { pushProject(valid.value); setStatusText(message); } }} onReviewElectromechanical={requestElectromechanicalAssembly} onMessage={setStatusText} />}
      </>}
    </section>}
    {contextMenu !== undefined && <WorkbenchContextMenu x={contextMenu.x} y={contextMenu.y} selectionLabel={contextMenu.selectionId ?? `${project.activeWorkspace} canvas`} commands={contextCommands} onRun={runContextCommand} onClose={() => setContextMenu(undefined)} />}
    <footer className="app-status"><div className={`status-copy ${status}`} role="status" aria-live="polite"><span />{statusText}</div><div className="status-facts"><a className="app-brand-credit" href="/about" title={`${PS3D_BRAND.name} - ${PS3D_BRAND.serviceLine}`}>{PS3D_BRAND.name}</a><button className={`status-health ${designHealth.overallStatus}`} onClick={openDesignHealth}>health {designHealth.score}</button><span>{document.displayUnit}</span><span>{selectedId === null ? "0 selected" : "1 selected"}</span><span>{renderStudioOpen ? `${renderSettings.resolution} ${renderSettings.format}` : masterCartOpen ? "parametric preview" : isThreeDimensional ? viewportState.selectionFilter : project.activeWorkspace === "electrical" ? `ERC ${electrical.erc.status}` : "local"}</span><span>{renderStudioOpen ? "render-studio" : masterCartOpen ? "master-cart" : project.activeWorkspace}</span></div>{diagnostic !== undefined && <div className="diagnostic-toast" role="alert"><strong>{diagnostic.code}</strong><span>{diagnostic.message}</span><small>{diagnostic.recovery}</small><button onClick={() => setDiagnostic(undefined)} aria-label="Dismiss diagnostic">×</button></div>}</footer>
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
      {pendingAssemblyTemplate !== undefined && <div className="engineering-confirmation-backdrop"><section ref={engineeringDialogRef} tabIndex={-1} className="engineering-confirmation-dialog compact" role="dialog" aria-modal="true" aria-labelledby="assembly-replacement-title" aria-describedby="assembly-replacement-description"><header><div><span>LINKED ASSEMBLY PROTECTION</span><h2 id="assembly-replacement-title">Break ECAD trace and replace assembly?</h2></div><button onClick={() => setPendingAssemblyTemplate(undefined)} aria-label="Close linked assembly replacement review">×</button></header><div className="engineering-review-copy" id="assembly-replacement-description"><p>The current assembly has {project.assembly.electricalLinks?.length ?? 0} ECAD-linked packages and {project.assembly.electricalRoutes?.length ?? 0} conductor paths. Replacing it with <strong>{pendingAssemblyTemplate.replaceAll("-", " ")}</strong> removes that physical trace from Assembly, while preserving the source schematic. The replacement is one undoable revision.</p></div><footer><button data-dialog-initial-focus onClick={() => setPendingAssemblyTemplate(undefined)}>Cancel</button><button className="danger" onClick={() => { const template = pendingAssemblyTemplate; setPendingAssemblyTemplate(undefined); applyProjectOperation({ kind: "apply-assembly-template", template }); }}>Break link and replace</button></footer></section></div>}
    {pendingElectricalTemplate !== undefined && <div className="engineering-confirmation-backdrop"><section ref={engineeringDialogRef} tabIndex={-1} className="engineering-confirmation-dialog compact" role="dialog" aria-modal="true" aria-labelledby="electrical-template-replacement-title" aria-describedby="electrical-template-replacement-description"><header><div><span>SCHEMATIC REPLACEMENT REVIEW</span><h2 id="electrical-template-replacement-title">Replace current devices and nets?</h2></div><button onClick={cancelElectricalTemplateReview} aria-label="Close schematic replacement review">×</button></header><div className="engineering-review-copy" id="electrical-template-replacement-description"><p>Generating <strong>{pendingElectricalTemplate.replaceAll("-", " ")}</strong> replaces all {project.electrical.components.length} current devices and {project.electrical.nets.length} current nets, including local edits. The replacement is one undoable project revision.</p></div><footer><button data-dialog-initial-focus onClick={cancelElectricalTemplateReview}>Cancel</button><button className="danger" onClick={() => { const template = pendingElectricalTemplate; setPendingElectricalTemplate(undefined); if (applyProjectOperation({ kind: "apply-electrical-template", template })) setSelectedId(null); }}>Replace and generate</button></footer></section></div>}
    {pendingVehicleTemplate !== undefined && <div className="engineering-confirmation-backdrop"><section ref={engineeringDialogRef} tabIndex={-1} className="engineering-confirmation-dialog compact" role="dialog" aria-modal="true" aria-labelledby="vehicle-template-replacement-title" aria-describedby="vehicle-template-replacement-description"><header><div><span>VEHICLE TOPOLOGY REPLACEMENT REVIEW</span><h2 id="vehicle-template-replacement-title">Replace the current engineering study?</h2></div><button onClick={() => setPendingVehicleTemplate(undefined)} aria-label="Close vehicle topology replacement review">×</button></header><div className="engineering-review-copy" id="vehicle-template-replacement-description"><p>Replacing <strong>{project.vehicle.template.replaceAll("-", " ")}</strong> with <strong>{pendingVehicleTemplate.replaceAll("-", " ")}</strong> resets all {Object.keys(project.vehicle.parameters).length} vehicle inputs, the suspension state, evidence-status fields, and layer visibility to the target generic template. The current {vehiclePreview.geometry.hardpoints.length}-hardpoint graph is removed. The replacement is one undoable project revision.</p><p>The new package remains illustrative and carries the same do-not-fabricate, roadworthiness, and homologation boundaries.</p></div><footer><button data-dialog-initial-focus onClick={() => { setPendingVehicleTemplate(undefined); setStatusText("Vehicle replacement cancelled; the current topology and inputs were preserved."); }}>Cancel</button><button className="danger" onClick={() => { const template = pendingVehicleTemplate; setPendingVehicleTemplate(undefined); if (applyProjectOperation({ kind: "apply-vehicle-template", template })) setSelectedId(null); }}>Replace topology and inputs</button></footer></section></div>}
    <CommandPalette open={paletteOpen} workspace={project.activeWorkspace} onClose={() => setPaletteOpen(false)} onCommand={executeCadCommand} />
    <ExchangeCenter open={exchangeOpen} busy={exchangeBusy} hasScene={!masterCartOpen && isThreeDimensional} activeImport={activeImport} feedback={exchangeFeedback} onClose={() => setExchangeOpen(false)} onImport={(files, unit) => void importExchangeFiles(files, unit)} onExport={(format, unit) => void exportExchangeFormat(format, unit)} onPdfPackage={() => void exportPdfPackage()} onInteractivePdf={(file) => void exportInteractivePdf(file)} onClearImport={clearActiveImport} />
    {designHealthOpen && <DesignHealthCenter report={designHealth} onClose={() => setDesignHealthOpen(false)} onWorkspace={switchWorkspace} />}
    <SaveProjectDialog open={saveDialogMode !== undefined} mode={saveDialogMode ?? "save-as"} projectName={project.name} workspaceStatus={fileWorkspaceStatus} onConfirm={(fileName) => void confirmSaveDialog(fileName)} onClose={() => setSaveDialogMode(undefined)} />
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
  return [28, 28, 34];
}

function partPreviewShapeLabel(shape: PartPreviewBodyShape): string {
  if (shape === "block") return "Block";
  if (shape === "cylinder") return "Cylinder";
  if (shape === "cone") return "Cone";
  return "Sphere";
}

function partPreviewColor(shape: PartPreviewBodyShape): string {
  if (shape === "block") return "#b9bec5";
  if (shape === "cylinder") return "#d2d5da";
  if (shape === "cone") return "#adb3ba";
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

function safeFileStem(value: string): string {
  const stem = value.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  return stem.length === 0 ? "ps3d-model" : stem.slice(0, 80);
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
  const occupied = new Set(positions.map((position) => `${Math.round(position[0])}:${Math.round(position[1])}`));
  for (const y of [190, 320, 450, 580] as const) {
    for (const x of [150, 330, 510, 690, 870, 1050, 1230, 1410] as const) {
      if (!occupied.has(`${x}:${y}`) && isElectricalSheetPositionAvailable([x, y])) return [x, y];
    }
  }
  return undefined;
}

function assertNever(value: never): never {
  throw new Error(`Unhandled CAD command action: ${JSON.stringify(value)}`);
}
