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
  createElectricalComponentInstance,
  createElectromechanicalAssembly,
  createWorkbenchProject,
  defaultElectromechanicalMappings,
  ELECTROMECHANICAL_CATALOG_REVISION,
  isElectricalSheetPositionAvailable,
  parseWorkbenchProjectText,
  preferredElectromechanicalLayout,
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
  type WorkbenchSketchConstraint,
  type Vec3,
  type WorkspaceId
} from "../../../packages/workbench-core/src/index.js";
import { buildAssemblyPreview, buildPartPreview, buildSurfacePreview, findAssemblyInterference } from "../../../packages/workbench-geometry/src/index.js";
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
import { WorkbenchHeader } from "./ui/WorkbenchHeader.js";
import { WorkbenchRibbon } from "./ui/WorkbenchRibbon.js";
import { ProjectTree } from "./ui/ProjectTree.js";
import { CommandPalette } from "./ui/CommandPalette.js";
import { ExchangeCenter } from "./ui/ExchangeCenter.js";
import { ViewportChrome } from "./ui/ViewportChrome.js";
import { DesignHealthCenter } from "./ui/DesignHealthCenter.js";
import { SketchWorkspace } from "./workspaces/SketchWorkspace.js";
import { PartInspector } from "./workspaces/PartInspector.js";
import { ImportedModelInspector } from "./workspaces/ImportedModelInspector.js";
import { AssemblyInspector } from "./workspaces/AssemblyInspector.js";
import { MasterCartWorkspace } from "./workspaces/MasterCartWorkspace.js";
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
  const [viewportState, setViewportState] = useState<ViewportViewState>(DEFAULT_VIEWPORT_STATE);
  const [measurePoints, setMeasurePoints] = useState<readonly ViewportMeasurePoint[]>([]);
  const clientRef = useRef<GeometryWorkerClient | undefined>(undefined);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewportRef = useRef<ThreeViewportAdapter | undefined>(undefined);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const nativeInputRef = useRef<HTMLInputElement>(null);
  const engineeringDialogRef = useRef<HTMLElement>(null);

  const assemblyScene = useMemo(() => buildAssemblyPreview(project.assembly), [project.assembly]);
  const partScene = useMemo(() => buildPartPreview(project.part), [project.part]);
  const interferences = useMemo(() => findAssemblyInterference(project.assembly), [project.assembly]);
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

  const isThreeDimensional = project.activeWorkspace === "part" || project.activeWorkspace === "assembly" || project.activeWorkspace === "surface" || project.activeWorkspace === "vehicle";
  const acceptMeasurePoint = useCallback((point: ViewportMeasurePoint): void => {
    setMeasurePoints((current) => current.length >= 2 ? [point] : [...current, point]);
  }, []);
  useEffect(() => {
    if (masterCartOpen || !isThreeDimensional || canvasRef.current === null) return;
    const viewport = new ThreeViewportAdapter(canvasRef.current, {
      onSelectBody: setSelectedId,
      onViewChange: setViewportState,
      onMeasurePoint: acceptMeasurePoint
    });
    viewport.setShadingMode(viewportState.shadingMode);
    viewport.setBodyColor(viewportState.bodyColor);
    viewportRef.current = viewport;
    return () => { viewport.dispose(); viewportRef.current = undefined; };
  }, [acceptMeasurePoint, isThreeDimensional, masterCartOpen, project.activeWorkspace]);

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

  const switchWorkspace = (workspace: WorkspaceId): void => {
    setMasterCartOpen(false);
    setSelectedId(null);
    setMeasurePoints([]);
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
    setMasterCartOpen(true);
    setSelectedId(null);
    setMeasurePoints([]);
    setStatus("ready");
    setStatusText("Opened PS3D Master Cart with original parametric component templates and supplier category references.");
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
    if (command.action.kind === "open-design-health") {
      openDesignHealth();
      return;
    }
    switchWorkspace(command.workspace);
    if (command.action.kind === "unavailable") {
      setSelectedId(command.id);
      setStatus("ready");
      setStatusText(`${command.name} is cataloged but unavailable: ${command.description}`);
      return;
    }
    switch (command.action.kind) {
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
        requestElectricalTemplate(command.action.template);
        break;
      case "insert-electrical-component":
        insertElectricalComponent(command.action.componentKind);
        break;
      case "generate-electromechanical-realization":
        requestElectromechanicalAssembly();
        break;
      case "apply-vehicle-template":
        requestVehicleTemplate(command.action.template);
        break;
      case "set-vehicle-state":
        applyProjectOperation({ kind: "set-vehicle-simulation-state", state: command.action.state });
        break;
      case "toggle-vehicle-layer":
        applyProjectOperation({ kind: "toggle-vehicle-layer", layer: command.action.layer });
        break;
      case "activate-sketch-tool":
        setSketchTool(command.action.tool);
        setStatusText(`${command.name} tool active from the command launcher.`);
        break;
      case "select-record":
        setSelectedId(command.action.selectionId);
        setStatusText(`${command.name} selected. ${command.description}`);
        break;
      case "create-part-preview-body":
        createPartPreviewBody(command.action.shape);
        break;
      case "selected-part-preview-body-action":
        runSelectedPartPreviewAction(command.action.operation, command.name);
        break;
      case "set-part-preview-bodies-visibility":
        applyProjectOperation({ kind: "set-part-preview-bodies-visibility", visible: command.action.visible });
        break;
      case "insert-component":
        insertAssemblyComponent(command.action.shape);
        break;
      case "insert-current-part-into-assembly":
        insertCurrentPartIntoAssembly();
        break;
      case "apply-assembly-template":
        requestAssemblyTemplate(command.action.template);
        break;
      case "selected-component-action": {
        const componentId = selectedId?.startsWith("component:") === true ? selectedId : undefined;
        if (componentId === undefined) {
          setStatusText(`Select a component before running ${command.name}.`);
          break;
        }
        if (command.action.operation === "delete") deleteAssemblyComponent(componentId);
        if (command.action.operation === "toggle-grounded") applyProjectOperation({ kind: "toggle-component-grounded", componentId });
        if (command.action.operation === "toggle-visible") applyProjectOperation({ kind: "toggle-component-visibility", componentId });
        break;
      }
      case "set-surface-mode":
        applyProjectOperation({ kind: "set-surface-mode", mode: command.action.mode });
        break;
      case "fit-view":
        fitViewport();
        break;
      case "set-view-orientation":
        setViewportOrientation(command.action.orientation);
        break;
      case "set-view-projection":
        setViewportProjection(command.action.projection);
        break;
      case "set-shading-mode":
        viewportRef.current?.setShadingMode(command.action.mode);
        setStatusText(`${command.name} display mode active.`);
        break;
      case "set-background-tone":
        viewportRef.current?.setBackgroundTone(command.action.tone);
        setStatusText(`${command.name} viewport background active.`);
        break;
      case "set-navigation-mode":
        setViewportNavigation(command.action.mode);
        break;
      case "set-selection-filter":
        setViewportSelectionFilter(command.action.filter);
        break;
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

  const extrudeSketchProfiles = async (profileIds: readonly string[], distanceMm: number): Promise<void> => {
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
    switchWorkspace("part");
    setSelectedId("feature:plate-extrusion");
    setStatus("ready");
    setStatusText(`Created qualified ${resolved.value.widthMm} × ${resolved.value.heightMm} × ${resolved.value.distanceMm} mm extrusion with Ø${resolved.value.holeDiameterMm} mm through-bore from the selected sketch profiles.`);
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

  const saveAll = async (): Promise<void> => {
    setStatus("working");
    try {
      await saveWorkbenchProject(projectRef.current);
      const response = await clientRef.current?.persist(documentRef.current.revision);
      if (response !== undefined && !acceptResponse(response)) return;
      setStatus("ready");
      setStatusText(`Broad project revision ${projectRef.current.revision} and qualified solid revision ${documentRef.current.revision} are durable in browser IndexedDB.`);
    } catch (error) {
      setStatus("error"); setStatusText(error instanceof Error ? error.message : "Local save failed.");
    }
  };

  const openProject = async (event: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (file === undefined) return;
    const parsed = parseWorkbenchProjectText(await file.text());
    if (!parsed.ok) { const first = parsed.diagnostics[0]; setStatus("error"); setStatusText(first?.message ?? "Project rejected."); return; }
    resetProject(parsed.value); await saveWorkbenchProject(parsed.value); setStatus("ready"); setStatusText(`Opened broad project revision ${parsed.value.revision}.`);
    void synchronizeWorkerPart(parsed.value);
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
    viewportRef.current?.setNavigationMode(mode);
    setStatusText(mode === "measure" ? "Measure active: pick two visible model points." : `${mode[0]!.toUpperCase()}${mode.slice(1)} navigation active.`);
  };

  const setViewportSelectionFilter = (filter: SelectionFilter): void => {
    viewportRef.current?.setSelectionFilter(filter);
    setStatusText(`${filter === "auto" ? "Automatic" : filter} selection priority active.`);
  };

  const setViewportOrientation = (orientation: Exclude<ViewOrientation, "custom">): void => {
    viewportRef.current?.setOrientation(orientation);
    setStatusText(`${orientation[0]!.toUpperCase()}${orientation.slice(1)} view active.`);
  };

  const setViewportProjection = (projection: ViewProjection): void => {
    viewportRef.current?.setProjection(projection);
    setStatusText(`${projection === "orthographic" ? "Orthographic" : "Perspective"} projection active.`);
  };

  const homeViewport = (): void => {
    viewportRef.current?.setOrientation("isometric");
    fitViewport();
    setStatusText("Isometric home view fitted to visible geometry.");
  };

  const openDesignHealth = useCallback((): void => {
    setPaletteOpen(false);
    setExchangeOpen(false);
    setDesignHealthOpen(true);
    setStatusText(`Design health ${designHealth.overallStatus}: ${designHealth.score}/100 at revision ${designHealth.projectRevision}.`);
  }, [designHealth]);

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (!isThreeDimensional || isEditableTarget(event.target) || globalThis.document.querySelector('[role="dialog"]') !== null) return;
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
      if (!(event.ctrlKey || event.metaKey) || isEditableTarget(event.target) || globalThis.document.querySelector('[role="dialog"]') !== null) return;
      const key = event.key.toLowerCase();
      if (key === "s") { event.preventDefault(); void saveAll(); }
      if (key === "o") { event.preventDefault(); projectInputRef.current?.click(); }
      if (key === "h" && event.shiftKey) { event.preventDefault(); openDesignHealth(); }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [openDesignHealth]);
  const canUndo = project.activeWorkspace === "part" ? undoDepth > 0 : projectUndoDepth > 0;
  const canRedo = project.activeWorkspace === "part" ? redoDepth > 0 : projectRedoDepth > 0;

  return <main className="studio-app" data-workspace={masterCartOpen ? "master-cart" : project.activeWorkspace} aria-busy={status === "working"}>
    <WorkbenchHeader project={project} masterCartOpen={masterCartOpen} status={status} onWorkspace={switchWorkspace} onMasterCart={openMasterCart} onCommandPalette={() => setPaletteOpen(true)} onDesignHealth={openDesignHealth} onExchange={() => setExchangeOpen(true)} onLearning={() => window.location.assign("/learn")} onAccess={() => window.location.assign("/access")} onSave={() => void saveAll()} onDownload={downloadProject} onOpen={() => projectInputRef.current?.click()} onUndo={() => void moveHistory("undo")} onRedo={() => void moveHistory("redo")} onFit={fitViewport} onHome={homeViewport} onToggleGrid={() => viewportRef.current?.setGridVisible(!viewportState.gridVisible)} onMeasure={() => setViewportNavigation("measure")} gridVisible={viewportState.gridVisible} canUndo={canUndo} canRedo={canRedo} designHealthStatus={designHealth.overallStatus} designHealthScore={designHealth.score} />
    <WorkbenchRibbon
      project={project}
      masterCartOpen={masterCartOpen}
      displayUnit={document.displayUnit}
      sketchTool={sketchTool}
      selectedId={selectedId}
      onSketchTool={(tool) => { setSketchTool(tool); setStatusText(`${sketchToolLabel(tool)} tool active in the top ribbon.`); }}
      onFinishSketch={() => { switchWorkspace("part"); setStatusText("Sketch session finished. Revisioned sketch geometry remains linked to the Part workspace."); }}
      onCancelSketchPoints={() => { setSketchCancelVersion((version) => version + 1); setStatusText("Pending sketch points cleared from the top ribbon."); }}
      onSelect={setSelectedId}
      onCreatePartPreviewBody={createPartPreviewBody}
      onPartPreviewAction={(operation, commandName) => runSelectedPartPreviewAction(operation, commandName)}
      onFit={fitViewport}
      onMeasure={() => setViewportNavigation("measure")}
      onNativeDownload={() => void downloadNative()}
      onNativeOpen={() => nativeInputRef.current?.click()}
      onExportStl={() => void exportStl()}
      onExchange={() => setExchangeOpen(true)}
      onDisplayUnit={(unit) => void changeUnit(unit)}
      onAssemblyExplode={(valueMm) => applyProjectOperation({ kind: "set-assembly-explode", valueMm })}
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
    />
    <input ref={projectInputRef} type="file" accept="application/json,.json" className="visually-hidden" aria-label="Open PS3D workbench project" tabIndex={-1} onChange={(event) => void openProject(event)} />
    <input ref={nativeInputRef} type="file" accept="application/json,.json" className="visually-hidden" aria-label="Open qualified PS3D native part revision" tabIndex={-1} onChange={(event) => void openNative(event)} />
    <section className="workbench-grid">
      {masterCartOpen && <MasterCartWorkspace assemblyComponentCount={project.assembly.components.length} onAdd={insertMasterCartItem} onMessage={setStatusText} />}
      {!masterCartOpen && <ProjectTree project={project} selectedId={selectedId} revealSelectionRequest={treeRevealRequest} designHealth={designHealth} onSelect={setSelectedId} />}
      {!masterCartOpen && project.activeWorkspace === "sketch" && <SketchWorkspace sketch={project.sketch} tool={sketchTool} cancelVersion={sketchCancelVersion} selectedId={selectedId} onSelect={setSelectedId} onAddEntity={(entity: SketchEntity) => applyProjectOperation({ kind: "add-sketch-entity", entity })} onDeleteEntity={(entityId) => { if (applyProjectOperation({ kind: "delete-sketch-entity", entityId })) setSelectedId(null); }} onAddConstraint={(constraint: WorkbenchSketchConstraint) => applyProjectOperation({ kind: "add-sketch-constraint", constraint })} onDeleteConstraint={(constraintId) => applyProjectOperation({ kind: "delete-sketch-constraint", constraintId })} onSetDimension={(entityId, dimension, valueMm) => applyProjectOperation({ kind: "set-sketch-dimension", entityId, dimension, valueMm })} onToggleConstruction={(entityId) => applyProjectOperation({ kind: "toggle-sketch-construction", entityId })} onExtrudeProfiles={extrudeSketchProfiles} working={status === "working"} onMessage={setStatusText} />}
      {!masterCartOpen && isThreeDimensional && <section className="workspace-canvas model-stage" aria-label={`${project.activeWorkspace} three-dimensional viewport`}>
        <canvas ref={canvasRef} className="model-canvas" role="img" aria-label={`Interactive ${project.activeWorkspace} preview`} />
        <ViewportChrome
          workspace={project.activeWorkspace as "part" | "assembly" | "surface" | "vehicle"}
          state={viewportState}
          measurePoints={measurePoints}
          onNavigationMode={setViewportNavigation}
          onSelectionFilter={setViewportSelectionFilter}
          onOrientation={setViewportOrientation}
          onProjection={setViewportProjection}
          onGrid={(visible) => viewportRef.current?.setGridVisible(visible)}
          onAxes={(visible) => viewportRef.current?.setAxesVisible(visible)}
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
      {project.activeWorkspace === "assembly" && <AssemblyInspector assembly={project.assembly} selectedId={selectedId} interferences={interferences} onTemplate={requestAssemblyTemplate} onExplode={(valueMm) => applyProjectOperation({ kind: "set-assembly-explode", valueMm })} onMove={(componentId, translationMm) => applyProjectOperation({ kind: "set-component-translation", componentId, translationMm })} onToggleGrounded={(componentId) => applyProjectOperation({ kind: "toggle-component-grounded", componentId })} onToggleVisible={(componentId) => applyProjectOperation({ kind: "toggle-component-visibility", componentId })} onDelete={deleteAssemblyComponent} onSelect={setSelectedId} onOpenElectricalSource={(componentId) => { switchWorkspace("electrical"); setSelectedId(componentId ?? null); setTreeRevealRequest((request) => request + 1); }} />}
      {project.activeWorkspace === "surface" && <SurfaceInspector surface={project.surface} metrics={surfacePreview.metrics} onParameter={(parameter, value) => applyProjectOperation({ kind: "set-surface-parameter", parameter, value })} />}
      {project.activeWorkspace === "drawing" && <DrawingWorkspace settings={project.drawing} artifact={drawing} onSheet={(sheet) => applyProjectOperation({ kind: "set-drawing-sheet", sheet })} onProjection={(projection) => applyProjectOperation({ kind: "set-drawing-projection", projection })} onScale={(scale) => applyProjectOperation({ kind: "set-drawing-scale", scale })} onDimensions={(show) => applyProjectOperation({ kind: "set-drawing-dimensions", show })} onViewPreset={(preset) => applyProjectOperation({ kind: "set-drawing-view-preset", preset })} onDisplayStyle={(style) => applyProjectOperation({ kind: "set-drawing-display-style", style })} onSectionView={(show) => applyProjectOperation({ kind: "set-drawing-section-view", show })} onDraftingStandard={(standard) => applyProjectOperation({ kind: "set-drawing-drafting-standard", standard })} onGdt={(show) => applyProjectOperation({ kind: "set-drawing-gdt", show })} onDatumScheme={(scheme) => applyProjectOperation({ kind: "set-drawing-datum-scheme", scheme })} onGdtSpecification={(positionMm, flatnessMm, perpendicularityMm) => applyProjectOperation({ kind: "set-drawing-gdt-specification", positionMm, flatnessMm, perpendicularityMm })} onGeneralTolerance={(linearMm, angularDeg) => applyProjectOperation({ kind: "set-drawing-general-tolerance", linearMm, angularDeg })} onNotes={(notes) => applyProjectOperation({ kind: "set-drawing-notes", notes })} />}
      {project.activeWorkspace === "electrical" && <ElectricalWorkspace intent={project.electrical} artifact={electrical} selectedId={selectedId} onSelect={setSelectedId} onTemplate={requestElectricalTemplate} onStandard={(standard) => applyProjectOperation({ kind: "set-electrical-standard", standard })} onInsertComponent={insertElectricalComponent} onMoveComponent={(componentId, position) => applyProjectOperation({ kind: "set-electrical-component-position", componentId, position })} onDeleteComponent={(componentId) => { if (applyProjectOperation({ kind: "delete-electrical-component", componentId })) setSelectedId(null); }} onAddNet={addElectricalNet} onDeleteNet={(netId) => { if (applyProjectOperation({ kind: "delete-electrical-net", netId })) setSelectedId(null); }} onNotes={(notes) => applyProjectOperation({ kind: "set-electrical-notes", notes })} onPhysicalize={requestElectromechanicalAssembly} onDownload={() => downloadBlob(new Blob([electrical.svg], { type: "image/svg+xml" }), "ps3d-electrical-concept.svg")} />}
      {project.activeWorkspace === "vehicle" && <VehicleWorkspace intent={project.vehicle} analysis={vehiclePreview.analysis} geometry={vehiclePreview.geometry} primitiveCountByLayer={vehiclePreview.primitiveCountByLayer} selectedId={selectedId} onSelect={setSelectedId} onTemplate={requestVehicleTemplate} onParameter={(parameter, value) => applyProjectOperation({ kind: "set-vehicle-parameter", parameter, value })} onState={(state) => applyProjectOperation({ kind: "set-vehicle-simulation-state", state })} onLayer={(layer) => applyProjectOperation({ kind: "toggle-vehicle-layer", layer })} onFit={fitViewport} />}
      {project.activeWorkspace === "automate" && <AutomateWorkspace project={project} selectedId={selectedId} onSelect={setSelectedId} onApplyProject={(next, message) => { const valid = validateWorkbenchProject(next); if (valid.ok) { pushProject(valid.value); setStatusText(message); } }} onReviewElectromechanical={requestElectromechanicalAssembly} onMessage={setStatusText} />}
      </>}
    </section>
    <footer className="app-status"><div className={`status-copy ${status}`} role="status" aria-live="polite"><span />{statusText}</div><div className="status-facts"><a className="app-brand-credit" href="/about" title={`${PS3D_BRAND.name} - ${PS3D_BRAND.serviceLine}`}>{PS3D_BRAND.name}</a><button className={`status-health ${designHealth.overallStatus}`} onClick={openDesignHealth}>health {designHealth.score}</button><span>{document.displayUnit}</span><span>{selectedId === null ? "0 selected" : "1 selected"}</span><span>{masterCartOpen ? "parametric preview" : isThreeDimensional ? viewportState.selectionFilter : project.activeWorkspace === "electrical" ? `ERC ${electrical.erc.status}` : "local"}</span><span>{masterCartOpen ? "master-cart" : project.activeWorkspace}</span></div>{diagnostic !== undefined && <div className="diagnostic-toast" role="alert"><strong>{diagnostic.code}</strong><span>{diagnostic.message}</span><small>{diagnostic.recovery}</small><button onClick={() => setDiagnostic(undefined)} aria-label="Dismiss diagnostic">×</button></div>}</footer>
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
