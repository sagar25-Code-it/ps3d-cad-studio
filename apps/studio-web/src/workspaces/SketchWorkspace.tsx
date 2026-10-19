import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { SketchEntity, SketchConstraintKind, Vec2, WorkbenchSketch, WorkbenchSketchConstraint } from "../../../../packages/workbench-core/src/index.js";
import {
  analyzeWorkbenchSketch,
  buildSketchEntity,
  detectSketchProfiles,
  requiredSketchPoints,
  resolveQualifiedExtrusion,
  selectConnectedSketchEntities,
  selectTangentSketchEntities,
  sampleSpline,
  sketchChainBranchCount,
  sketchToolLabel,
  snapSketchPoint,
  type SketchProfile,
  type SketchTool
} from "../../../../packages/workbench-sketch/src/index.js";
import { constraintsOnEntities, extendAt, nearestEntityId, trimAt, type SketchEditPlan } from "../../../../packages/workbench-sketch/src/edit-tools.js";
import { SketchCheckPanel, SketchEditPanel, SketchRelationList, type SketchEditToolId } from "./SketchEditPanel.js";
import {
  orbitViewAngles,
  type NavigationMode,
  type SelectionFilter,
  type ViewOrientation,
  type ViewportViewState,
  type ViewProjection
} from "../../../../packages/viewport-three/src/index.js";
import { CapabilityBadge } from "../ui/CapabilityBadge.js";
import { CommandIcon } from "../ui/CommandIcon.js";
import { ViewportChrome } from "../ui/ViewportChrome.js";

type DrivingDimension = "length" | "width" | "height" | "radius";
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
export type SketchExtrudeOperation = "new-body" | "new-component" | "join" | "cut" | "intersect";

interface SketchWorkspaceProps {
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
  readonly onSetDimension: (entityId: string, dimension: DrivingDimension, valueMm: number) => void;
  readonly onToggleConstruction: (entityId: string) => void;
  readonly onToggleVisibility: (entityId: string) => void;
  readonly onExtrudeProfiles: (profileIds: readonly string[], distanceMm: number, operation: SketchExtrudeOperation) => Promise<void>;
  readonly viewportState: ViewportViewState;
  readonly onNavigationMode: (mode: NavigationMode) => void;
  readonly onSelectionFilter: (filter: SelectionFilter) => void;
  readonly onOrientation: (orientation: Exclude<ViewOrientation, "custom">) => void;
  readonly onViewAngles: (azimuthDeg: number, elevationDeg: number) => void;
  readonly onProjection: (projection: ViewProjection) => void;
  readonly onGrid: (visible: boolean) => void;
  readonly onAxes: (visible: boolean) => void;
  readonly onFit: () => void;
  readonly onHome: () => void;
  readonly onContextMenu: (clientX: number, clientY: number, selectionId: string | null) => void;
  readonly working: boolean;
  readonly onMessage: (message: string) => void;
  readonly optionsRevealRequest: number;
  readonly onCreateSolid: (profileIds: readonly string[], plane: "xy" | "xz" | "yz", operation: "extrude" | "revolve", valueMm: number, edge?: { readonly kind: "chamfer" | "fillet"; readonly sizeMm: number }) => void;
  readonly activePlane: "xy" | "xz" | "yz";
  readonly editTool: SketchEditToolId | null;
  readonly showMovable: boolean;
  readonly checkOpen: boolean;
  /** A one-shot ribbon command (Fix Curve, Relax Relations or Relax Dimensions); a new serial triggers it once. */
  readonly request: { readonly command: "fix-curve" | "relax-relations" | "relax-dimensions"; readonly serial: number } | null;
  readonly onApplyEdit: (plan: SketchEditPlan) => boolean | void;
  readonly onSetSuppressed: (constraintIds: readonly string[], suppressed: boolean) => boolean | void;
  readonly onCloseEditTool: () => void;
  readonly onCloseCheck: () => void;
}

export function SketchWorkspace(props: SketchWorkspaceProps): React.JSX.Element {
  const [pending, setPending] = useState<readonly Vec2[]>([]);
  const [cursor, setCursor] = useState<Vec2>([0, 0]);
  const [selectionIds, setSelectionIds] = useState<readonly string[]>(props.selectedId === null ? [] : [props.selectedId]);
  const [dimensionPoints, setDimensionPoints] = useState<readonly SketchDimensionPoint[]>([]);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [solidPlane, setSolidPlane] = useState<"xy" | "xz" | "yz">(props.activePlane);
  useEffect(() => { setSolidPlane(props.activePlane); }, [props.activePlane]);
  const [solidOp, setSolidOp] = useState<"extrude" | "revolve">("extrude");
  const [solidValue, setSolidValue] = useState("10");
  const [edgeKind, setEdgeKind] = useState<"none" | "chamfer" | "fillet">("none");
  const [edgeSize, setEdgeSize] = useState("2");
  const [showProfiles, setShowProfiles] = useState(true);
  const [showDimensions, setShowDimensions] = useState(true);
  const [showConstraints, setShowConstraints] = useState(true);
  const [selectedProfileIds, setSelectedProfileIds] = useState<readonly string[]>([]);
  const [extrudeDistance, setExtrudeDistance] = useState("10");
  const [extrudeOperation, setExtrudeOperation] = useState<SketchExtrudeOperation>("new-body");
  const orbitDrag = useRef<{ readonly pointerId: number; readonly startX: number; readonly startY: number; readonly azimuthDeg: number; readonly elevationDeg: number } | undefined>(undefined);
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
  const visibleEntities = useMemo(() => props.sketch.entities.filter((entity) => entity.visible !== false), [props.sketch.entities]);
  const visibleSketch = useMemo<WorkbenchSketch>(() => ({
    ...props.sketch,
    entities: visibleEntities,
    constraints: props.sketch.constraints.filter((constraint) => constraint.entityIds.every((id) => visibleEntities.some((entity) => entity.id === id)))
  }), [props.sketch, visibleEntities]);
  const analysis = useMemo(() => analyzeWorkbenchSketch(props.sketch), [props.sketch]);
  const profiles = useMemo(() => detectSketchProfiles(visibleSketch), [visibleSketch]);
  const view = expandedView(analysis.boundsMm.min, analysis.boundsMm.size);
  const selectedEntity = props.sketch.entities.find((entity) => entity.id === selectionIds.at(-1));
  const selectedEntities = selectionIds.map((id) => props.sketch.entities.find((entity) => entity.id === id)).filter((entity): entity is SketchEntity => entity !== undefined);
  const selectedConstraints = props.sketch.constraints.filter((constraint) => constraint.entityIds.some((id) => selectionIds.includes(id)));
  const dimensionHandleEntities = useMemo(() => [
    ...visibleEntities.filter((entity) => !selectionIds.includes(entity.id)),
    ...visibleEntities.filter((entity) => selectionIds.includes(entity.id))
  ], [selectionIds, visibleEntities]);
  const directDimension = useMemo(() => resolveDirectSketchDimension(dimensionPoints), [dimensionPoints]);
  const dimensionModeWasActive = useRef(false);
  const previewEntity = useMemo(() => {
    if (props.tool === "spline") {
      return pending.length >= 1 ? { id: "entity:tool-preview", kind: "spline" as const, fitPoints: [...pending, cursor], construction: false } satisfies SketchEntity : undefined;
    }
    if (props.tool === "select" || pending.length !== requiredSketchPoints(props.tool) - 1) return undefined;
    const preview = buildSketchEntity(props.tool, [...pending, cursor], "entity:tool-preview");
    return preview.ok ? preview.value : undefined;
  }, [cursor, pending, props.tool]);
  const distanceMm = Number(extrudeDistance);
  const extrusion = useMemo(() => resolveQualifiedExtrusion(props.sketch, selectedProfileIds, distanceMm), [distanceMm, props.sketch, selectedProfileIds]);
  const circleExtrusion = useMemo(() => {
    if (!Number.isFinite(distanceMm) || distanceMm < 1 || distanceMm > 100) return undefined;
    const selected = profiles.filter((profile) => selectedProfileIds.includes(profile.id));
    const only = selected.length === 1 ? selected[0] : undefined;
    if (only === undefined || only.boundary.kind !== "circle") return undefined;
    return { diameterMm: Math.round(only.boundary.radiusMm * 2 * 1000) / 1000 };
  }, [profiles, selectedProfileIds, distanceMm]);
  const extrudable = extrusion.ok || circleExtrusion !== undefined;
  const sketchIsNormal = props.viewportState.orientation === "top" || Math.abs(props.viewportState.elevationDeg - 90) < 0.2;
  const sketchPlaneStyle = {
    "--sketch-orbit-x": `${Math.max(-78, Math.min(78, 90 - props.viewportState.elevationDeg))}deg`,
    "--sketch-orbit-z": `${-props.viewportState.azimuthDeg - 90}deg`
  } as CSSProperties;

  useEffect(() => setPending([]), [props.tool, props.cancelVersion]);
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

  const pointer = (event: React.PointerEvent<SVGSVGElement>, commit: boolean): void => {
    const point = eventPoint(event, view);
    const snapped = snapEnabled ? snapSketchPoint(point, props.sketch) : { point, snapped: false, kind: "none" as const };
    setCursor(snapped.point);
    if (!commit) return;
    if ((props.editTool === "trim" || props.editTool === "extend") && props.tool === "select") {
      const target = nearestEntityId(props.sketch, point, Math.max(props.sketch.snapToleranceMm, view.width * 0.02));
      if (target === undefined) { props.onMessage(`${props.editTool === "trim" ? "Trim" : "Extend"}: click directly on a curve.`); return; }
      const context = { sketch: props.sketch, newId: (prefix: "entity" | "constraint"): string => `${prefix}:user-${crypto.randomUUID()}` };
      const result = props.editTool === "trim" ? trimAt(context, target, point) : extendAt(context, target, point);
      if (!result.ok) { props.onMessage(result.diagnostics[0]?.message ?? "The sketch edit was rejected."); return; }
      props.onApplyEdit(result.value);
      setSelectionIds([]);
      return;
    }
    if (props.tool === "spline") {
      const last = pending.at(-1);
      const gap = last === undefined ? Infinity : Math.hypot(snapped.point[0] - last[0], snapped.point[1] - last[1]);
      if (pending.length >= 3 && gap <= Math.max(props.sketch.snapToleranceMm, 0.5)) { finishSpline(pending); return; }
      if (gap < 0.01) return;
      if (pending.length >= 24) { props.onMessage("A spline takes at most 24 fit points. Click the last point again or press Enter to finish."); return; }
      const next = [...pending, snapped.point];
      setPending(next);
      props.onMessage(`Fit-point spline: point ${next.length} accepted.${next.length >= 3 ? " Click the last point again or press Enter to finish." : ""}`);
      return;
    }
    if (props.tool === "select") {
      setSelectionIds([]);
      setSelectedProfileIds([]);
      if (props.dimensionMode) setDimensionPoints([]);
      props.onSelect(null);
      return;
    }
    const points = [...pending, snapped.point];
    if (points.length < requiredSketchPoints(props.tool)) {
      setPending(points);
      props.onMessage(`${sketchToolLabel(props.tool)}: point ${points.length} accepted${snapped.snapped ? ` (${snapped.kind} snap)` : ""}.`);
      return;
    }
    const built = buildSketchEntity(props.tool, points, `entity:user-${crypto.randomUUID()}`);
    if (!built.ok) {
      props.onMessage(built.diagnostics[0]?.message ?? "Sketch entity rejected.");
      setPending([]);
      return;
    }
    props.onAddEntity(built.value);
    setPending([]);
    props.onMessage(`Added ${sketchToolLabel(props.tool)} with stable ID ${built.value.id}.`);
  };

  const finishSpline = (points: readonly Vec2[]): void => {
    const built = buildSketchEntity("spline", points, `entity:user-${crypto.randomUUID()}`);
    if (!built.ok) { props.onMessage(built.diagnostics[0]?.message ?? "The spline was rejected."); setPending([]); return; }
    props.onAddEntity(built.value);
    setPending([]);
    props.onMessage(`Added fit-point spline with ${points.length} points and stable ID ${built.value.id}.`);
  };

  useEffect(() => {
    if (props.tool !== "spline") return undefined;
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement) return;
      if (event.key === "Enter" && pending.length >= 3) { event.preventDefault(); finishSpline(pending); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const selectEntity = (id: string, additive: boolean): void => {
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
        props.onMessage("Curve selected for a driving dimension. Use its definition points for an alternate point-to-point reference.");
      }
      return;
    }
    // Keep a generous selection for Offset, Mirror and Pattern; pair and triple relations use the last two or three picked.
    setSelectionIds((current) => current.includes(id) ? current.filter((entry) => entry !== id) : [...current, id].slice(-60));
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
  const lastTwo = selectedEntities.length >= 2 ? selectedEntities.slice(-2) : [];
  const lastThree = selectedEntities.length >= 3 ? selectedEntities.slice(-3) : [];
  const twoLines = lastTwo.length === 2 && lastTwo.every((entity) => entity.kind === "line");
  const isRadial = (entity: SketchEntity): boolean => entity.kind === "circle" || entity.kind === "arc";
  const twoCircles = lastTwo.length === 2 && lastTwo.every(isRadial);
  // The solver handles a line against a circle or arc, or two circles or arcs; anything else would only be recorded.
  const tangentPair = lastTwo.length === 2 && ((lastTwo.some((entity) => entity.kind === "line") && lastTwo.some(isRadial)) || lastTwo.every(isRadial));
  const symmetricTriple = lastThree.length === 3 && lastThree[2]!.kind === "line" && ((lastThree[0]!.kind === "line" && lastThree[1]!.kind === "line") || (lastThree[0]!.kind === "circle" && lastThree[1]!.kind === "circle"));
  const twoCompatible = lastTwo.length === 2 && lastTwo[0]!.kind === lastTwo[1]!.kind;
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

  const handleCanvasPointerDown = (event: React.PointerEvent<SVGSVGElement>): void => {
    const mode: NavigationMode = event.button === 1
      ? event.shiftKey ? "orbit" : "pan"
      : props.tool === "select" ? props.viewportState.navigationMode : "select";
    if (event.button === 2) return;
    if (mode === "orbit") {
      event.currentTarget.setPointerCapture(event.pointerId);
      orbitDrag.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, azimuthDeg: props.viewportState.azimuthDeg, elevationDeg: props.viewportState.elevationDeg };
      return;
    }
    if (mode === "pan") {
      props.onMessage("Sketch pan is bounded to Fit in this preview; use wheel zoom or Fit while the shared camera service is upgraded.");
      return;
    }
    if (!sketchIsNormal && props.tool !== "select") {
      props.onMessage("Look At the XY sketch plane before placing new 2D geometry. Orbit changes the camera, not the sketch plane.");
      return;
    }
    pointer(event, true);
  };

  const handleCanvasPointerMove = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = orbitDrag.current;
    if (drag !== undefined && drag.pointerId === event.pointerId) {
      const [azimuth, elevation] = orbitViewAngles(drag.azimuthDeg, drag.elevationDeg, event.clientX - drag.startX, event.clientY - drag.startY);
      props.onViewAngles(azimuth, elevation);
      return;
    }
    pointer(event, false);
  };

  const finishCanvasDrag = (event: React.PointerEvent<SVGSVGElement>): void => {
    const drag = orbitDrag.current;
    orbitDrag.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    // A plain click (no drag) while NAV is Orbit would otherwise do nothing silently; explain why nothing was picked.
    if (drag !== undefined && drag.pointerId === event.pointerId && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) <= 3) {
      props.onMessage("Orbit navigation is active, so clicks rotate the view. Switch NAV to Select (V) to pick sketch entities, or drag to orbit.");
    }
  };

  return <>
    <section className="workspace-canvas sketch-stage" aria-label="Interactive XY sketch">
      <div className={`sketch-plane-shell ${sketchIsNormal ? "normal" : "orbited"}`} style={sketchPlaneStyle}>
      <svg
        className={`sketch-canvas ${showProfiles ? "show-profiles" : "hide-profiles"}`}
        viewBox={`${view.x} ${view.y} ${view.width} ${view.height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`XY sketch with ${props.sketch.entities.length} entities and ${analysis.degreesOfFreedom} estimated degrees of freedom`}
        onPointerMove={handleCanvasPointerMove}
        onPointerDown={handleCanvasPointerDown}
        onPointerUp={finishCanvasDrag}
        onPointerCancel={finishCanvasDrag}
        onContextMenu={(event) => {
          event.preventDefault();
          const hit = (event.target as Element).closest<SVGElement>("[data-selection-id]")?.dataset["selectionId"] ?? null;
          if (hit !== null) props.onSelect(hit);
          props.onContextMenu(event.clientX, event.clientY, hit);
        }}
      >
        <defs><pattern id="minor-grid" width={props.sketch.gridMm} height={props.sketch.gridMm} patternUnits="userSpaceOnUse"><path d={`M ${props.sketch.gridMm} 0 L 0 0 0 ${props.sketch.gridMm}`} fill="none" stroke="#1d3c58" strokeWidth="0.18" /></pattern></defs>
        {props.viewportState.gridVisible && <rect x={view.x} y={view.y} width={view.width} height={view.height} fill="url(#minor-grid)" />}
        {showProfiles && profiles.map((profile) => <SketchProfileShape key={profile.id} profile={profile} selected={selectedProfileIds.includes(profile.id)} {...(props.tool === "select" && props.viewportState.navigationMode === "select" ? { onSelect: (additive: boolean) => selectProfile(profile, additive) } : {})} />)}
        <line x1={view.x} y1="0" x2={view.x + view.width} y2="0" className="sketch-axis x" />
        <line x1="0" y1={view.y} x2="0" y2={view.y + view.height} className="sketch-axis y" />
        {visibleEntities.map((entity) => <SketchEntityShape key={entity.id} entity={entity} selected={selectionIds.includes(entity.id)} movable={props.showMovable && movableIds.has(entity.id)} {...(props.tool === "select" && props.viewportState.navigationMode === "select" && props.editTool !== "trim" && props.editTool !== "extend" ? { onSelect: (additive: boolean) => selectEntity(entity.id, additive) } : {})} />)}
        {previewEntity !== undefined && <SketchEntityShape entity={previewEntity} selected={false} preview />}
        {pending.map((point, index) => <circle key={index} cx={point[0]} cy={-point[1]} r="1.1" className="pending-point" />)}
        {props.tool !== "select" && <circle cx={cursor[0]} cy={-cursor[1]} r="0.8" className="cursor-point" />}
        {showDimensions && visibleEntities.map((entity) => <SketchDimensionGlyph key={`dimension:${entity.id}`} entity={entity} />)}
        {showConstraints && visibleSketch.constraints.map((constraint) => <ConstraintGlyph key={constraint.id} constraint={constraint} entities={visibleEntities} />)}
        {props.dimensionMode && <>
          {dimensionHandleEntities.flatMap(dimensionHandles).map((point) => <circle key={point.id} className={`dimension-point ${dimensionPoints.some((candidate) => candidate.id === point.id) ? "selected" : ""}`} data-dimension-point={point.id} cx={point.point[0]} cy={-point.point[1]} r="1.18" role="button" aria-label={`${point.label} dimension point`} onPointerDown={(event) => { event.stopPropagation(); selectDimensionPoint(point); }} />)}
          {directDimension !== undefined && <DirectDimensionPreview dimension={directDimension} />}
        </>}
      </svg>
      </div>

      {props.dimensionMode && <div className="dimension-mode-banner"><CommandIcon name="dimension" /><span><strong>Sketch Dimension</strong>Select a curve, or pick two blue definition points.</span></div>}

      <ViewportChrome workspace="sketch" state={props.viewportState} measurePoints={[]} onNavigationMode={props.onNavigationMode} onSelectionFilter={props.onSelectionFilter} onOrientation={props.onOrientation} onViewAngles={props.onViewAngles} onProjection={props.onProjection} onGrid={props.onGrid} onAxes={props.onAxes} onShadingMode={() => undefined} onBodyColor={() => undefined} onBackgroundTone={() => undefined} onFit={props.onFit} onHome={props.onHome} onClearMeasure={() => undefined} />

      <div className="sketch-palette" ref={paletteRef} aria-label="Sketch palette">
        <header><div><span>SKETCH</span><strong>Palette</strong></div><button onClick={() => props.onOrientation("top")}><CommandIcon name="view" />Look at</button></header>
        <PaletteToggle label="Sketch grid" active={props.viewportState.gridVisible} onToggle={props.onGrid} />
        <PaletteToggle label="Snap" active={snapEnabled} onToggle={setSnapEnabled} />
        <PaletteToggle label="Profiles" active={showProfiles} onToggle={setShowProfiles} />
        <PaletteToggle label="Dimensions" active={showDimensions} onToggle={setShowDimensions} />
        <PaletteToggle label="Constraints" active={showConstraints} onToggle={setShowConstraints} />
        <button className="palette-action" disabled={selectedEntity === undefined} onClick={() => selectedEntity !== undefined && props.onToggleConstruction(selectedEntity.id)}><CommandIcon name={selectedEntity?.construction === true ? "rectangle" : "construction"} />{selectedEntity?.construction === true ? "Profile geometry" : "Construction"}</button>
        <button className="palette-action primary" disabled={selectedProfileIds.length === 0} onClick={() => props.onMessage(extrudable ? "Closed profiles are ready. Confirm the extrusion in the inspector." : extrusion.diagnostics[0]?.message ?? "Select a closed profile.")}><CommandIcon name="extrude" />Extrude profiles</button>
        <div className="sketch-make-solid" aria-label="Create a general solid from a profile">
          <span className="make-solid-title">Make solid (any plane)</span>
          <div className="make-solid-row">
            <select aria-label="Operation" value={solidOp} onChange={(event) => { setSolidOp(event.target.value as "extrude" | "revolve"); setSolidValue(event.target.value === "revolve" ? "360" : "10"); }}>
              <option value="extrude">Extrude</option>
              <option value="revolve">Revolve</option>
            </select>
            <select aria-label="Plane" value={solidPlane} onChange={(event) => setSolidPlane(event.target.value as "xy" | "xz" | "yz")}>
              <option value="xy">Top (XY)</option>
              <option value="xz">Front (XZ)</option>
              <option value="yz">Right (YZ)</option>
            </select>
            <input aria-label={solidOp === "extrude" ? "Height in millimetres" : "Angle in degrees"} type="number" min={solidOp === "extrude" ? 0.1 : 1} max={solidOp === "revolve" ? 360 : undefined} step={solidOp === "extrude" ? 1 : 5} value={solidValue} onChange={(event) => setSolidValue(event.target.value)} />
            <small>{solidOp === "extrude" ? "mm" : "°"}</small>
          </div>
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
          <button className="palette-action primary" disabled={profiles.length === 0} onClick={() => props.onCreateSolid(selectedProfileIds, solidPlane, solidOp, Number(solidValue), solidOp === "extrude" && edgeKind !== "none" ? { kind: edgeKind, sizeMm: Number(edgeSize) } : undefined)}><CommandIcon name="box" />Create solid</button>
          {solidOp === "extrude" && <small className="make-solid-hint">Profiles drawn inside the outline become holes. Shift-select profiles to choose exactly which.</small>}
        </div>
      </div>

      <div className="canvas-hud"><span>XY plane · Z-up WCS</span><span>{props.dimensionMode ? "Dimension" : sketchToolLabel(props.tool)}</span><span>Grid {props.viewportState.gridVisible ? `${props.sketch.gridMm} mm` : "off"}</span><span>Snap {snapEnabled ? `${props.sketch.snapToleranceMm} mm` : "off"}</span><span>{visibleEntities.length}/{props.sketch.entities.length} entities visible</span><strong>{sketchIsNormal ? analysis.classification.replace("-", " ") : "3D orbit · Look At to draw"}</strong></div>
    </section>

    <aside className="inspector-panel" aria-label="Sketch inspector">
      <div className="inspector-title"><div><p>Sketch intelligence</p><h2>{props.sketch.name}</h2></div><CapabilityBadge level="preview" /></div>
      <section className={`solver-card ${analysis.classification}`}>
        <span className="solver-number">{analysis.degreesOfFreedom}</span>
        <div><strong>{analysis.classification === "fully-constrained" ? "Fully constrained" : analysis.classification === "conflict" ? "Constraint conflict" : "Degrees of freedom"}</strong><small>{analysis.appliedConstraints} supported constraints evaluated</small></div>
      </section>
      {analysis.conflicts.length > 0 && <div className="inline-warning">{analysis.conflicts[0]}</div>}

      {props.editTool !== null && <SketchEditPanel tool={props.editTool} sketch={props.sketch} selectionIds={selectionIds} onApply={(plan) => { props.onApplyEdit(plan); }} onMessage={props.onMessage} onClose={props.onCloseEditTool} />}
      {props.checkOpen && <SketchCheckPanel sketch={props.sketch} onClose={props.onCloseCheck} />}
      {props.showMovable && <div className="inline-warning movable-note">{movableIds.size === 0 ? "Show Movable: every entity is fully constrained." : `Show Movable: ${movableIds.size} entit${movableIds.size === 1 ? "y has" : "ies have"} estimated degrees of freedom (amber).`}</div>}
      <section className="inspector-section"><header><strong>Selection controller</strong><span>{selectionIds.length} selected</span></header>
        {selectedEntity === undefined ? <p className="empty-copy">Select an entity. Shift-click adds a second entity for pair constraints.</p> : <>
          <dl className="compact-facts"><div><dt>Primary</dt><dd>{selectedEntity.kind}</dd></div><div><dt>Freedom</dt><dd>{analysis.entityFreedom[selectedEntity.id] ?? 0}</dd></div><div><dt>Stable ID</dt><dd>{shortId(selectedEntity.id)}</dd></div><div><dt>Constraints</dt><dd>{selectedConstraints.length}</dd></div></dl>
          <div className="selection-chips">{selectedEntities.map((entity, index) => <span key={entity.id}><b>{index + 1}</b>{entity.kind}</span>)}</div>
          <div className="constraint-buttons">
            <button disabled={selectedEntities.length !== 1 || selectedEntity.kind !== "line"} onClick={() => constrain("horizontal")}><CommandIcon name="horizontal" />Horizontal</button>
            <button disabled={selectedEntities.length !== 1 || selectedEntity.kind !== "line"} onClick={() => constrain("vertical")}><CommandIcon name="vertical" />Vertical</button>
            <button disabled={!twoLines} onClick={() => constrain("parallel")}><CommandIcon name="parallel" />Parallel</button>
            <button disabled={!twoLines} onClick={() => constrain("perpendicular")}><CommandIcon name="perpendicular" />Perpendicular</button>
            <button disabled={!twoLines} onClick={() => constrain("collinear")}><CommandIcon name="collinear" />Collinear</button>
            <button disabled={!twoCircles} onClick={() => constrain("concentric")}><CommandIcon name="concentric" />Concentric</button>
            <button disabled={!twoCompatible} onClick={() => constrain("equal")}><CommandIcon name="equal" />Equal</button>
            <button disabled={!tangentPair} title="Line and circle/arc, or two circles/arcs. The second selection is adjusted." onClick={() => constrain("tangent")}><CommandIcon name="tangent" />Tangent</button>
            <button disabled={!symmetricTriple} title="Select two lines or two circles, then the axis line last. The second is mirrored onto the first." onClick={() => constrain("symmetry")}><CommandIcon name="mirror" />Symmetric</button>
            <button onClick={() => constrain("fixed")}><CommandIcon name="fixed" />Fix primary</button>
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

      <SketchRelationList constraints={selectedConstraints} entities={props.sketch.entities} onSetSuppressed={(ids, suppressed) => { props.onSetSuppressed(ids, suppressed); }} />
      {!props.dimensionMode && selectedEntity !== undefined && <section className="inspector-section dimension-controller"><header><strong>Driving dimensions</strong><span>mm</span></header><EntityDimensions entity={selectedEntity} onApply={(dimension, value) => props.onSetDimension(selectedEntity.id, dimension, value)} onMessage={props.onMessage} /></section>}

      <section className="inspector-section profile-controller"><header><strong>Closed profiles</strong><span>{profiles.length} found</span></header>
        <p className="profile-help">Profile selects a shaded region; Curve, Connected and Tangent intents use the shared top selection controller.</p>
        <div className="profile-list">{profiles.map((profile, index) => <button key={profile.id} className={selectedProfileIds.includes(profile.id) ? "selected" : ""} onClick={(event) => selectProfile(profile, event.shiftKey || event.ctrlKey || event.metaKey)}><span><b>P{index + 1}</b>{profileLabel(profile)}</span><small>{format(profile.areaMm2)} mm²</small></button>)}</div>
        <form className={`extrude-controller ${extrudable ? "ready" : "needs-input"}`} onSubmit={(event) => { event.preventDefault(); if (extrudable && !props.working && (extrudeOperation === "new-body" || extrudeOperation === "new-component")) void props.onExtrudeProfiles(selectedProfileIds, distanceMm, extrudeOperation); }}>
          <div className="feature-dialog-title"><span><CommandIcon name="extrude" /></span><div><small>SOLID / CREATE</small><strong>Extrude</strong></div></div>
          <label><span>Profiles</span><output>{selectedProfileIds.length === 0 ? "Select in canvas" : `${selectedProfileIds.length} selected`}</output></label>
          <label><span>Start</span><select aria-label="Extrude start" defaultValue="profile"><option value="profile">Profile plane</option></select></label>
          <label><span>Direction</span><select aria-label="Extrude direction" defaultValue="symmetric"><option value="symmetric">Symmetric</option></select></label>
          <label><span>Distance</span><div className="distance-entry"><input aria-label="Extrude distance in millimeters" inputMode="decimal" value={extrudeDistance} onChange={(event) => setExtrudeDistance(event.target.value)} /><small>mm</small></div></label>
          <label><span>Operation</span><select aria-label="Extrude operation" value={extrudeOperation} onChange={(event) => setExtrudeOperation(event.target.value as SketchExtrudeOperation)}><option value="new-body">New body (separate)</option><option value="new-component">New component</option><option value="join" disabled>Join — needs B-rep overlap</option><option value="cut" disabled>Cut — needs B-rep overlap</option><option value="intersect" disabled>Intersect — needs B-rep overlap</option></select></label>
          <div className={`profile-readiness ${extrudable ? "ready" : "blocked"}`}><CommandIcon name={extrudable ? "cube-check" : "inspect"} /><span>{extrusion.ok ? `Qualified rectangle + bore · ${format(extrusion.value.widthMm)} × ${format(extrusion.value.heightMm)} × ${format(extrusion.value.distanceMm)} mm` : circleExtrusion !== undefined ? `Circle Ø${format(circleExtrusion.diameterMm)} mm → ${format(distanceMm)} mm cylinder` : extrusion.diagnostics[0]?.message ?? "Select a profile."}</span></div>
          <div className="kernel-boundary"><strong>Boolean availability</strong><span>Join, Cut and Intersect stay disabled until stable face/body topology and an overlap preview are available.</span></div>
          <button className="extrude-submit" type="submit" disabled={!extrudable || props.working || (extrudeOperation !== "new-body" && extrudeOperation !== "new-component")}><CommandIcon name="extrude" />{props.working ? "Regenerating…" : extrudeOperation === "new-component" ? "Extrude as component" : "Finish sketch & extrude"}</button>
        </form>
      </section>

      <section className="inspector-section"><header><strong>Constraint records</strong><span>{props.sketch.constraints.length}</span></header>
        <div className="record-list">{props.sketch.constraints.slice(-10).reverse().map((constraint) => <button key={constraint.id} onClick={() => props.onDeleteConstraint(constraint.id)} title="Delete this constraint"><CommandIcon name={constraint.dimension === undefined ? constraint.kind : "dimension"} /><span>{constraint.kind}{constraint.dimension === undefined ? "" : ` · ${constraint.dimension}`}{constraint.suppressed === true ? " · relaxed" : ""}</span><small>{constraint.valueMm === undefined ? shortId(constraint.id) : `${format(constraint.valueMm)} mm`}</small></button>)}</div>
      </section>
      <div className="scope-note"><strong>Preview solver boundary</strong><p>A small analytic solver enforces horizontal, vertical, parallel, perpendicular, collinear, tangent, concentric, equal, symmetric and fixed relations plus radius and length dimensions on lines, circles and arcs; a conflict is refused with the reason. Rectangles are rigid, point-on-curve and endpoint relations are recorded but not solved, and there is no general nonlinear solver. Degrees of freedom are an estimate.</p></div>
    </aside>
  </>;
}

function PaletteToggle({ label, active, onToggle }: { readonly label: string; readonly active: boolean; readonly onToggle: (active: boolean) => void }): React.JSX.Element {
  return <label><span>{label}</span><input type="checkbox" checked={active} onChange={(event) => onToggle(event.target.checked)} /></label>;
}

function EntityDimensions({ entity, onApply, onMessage }: { readonly entity: SketchEntity; readonly onApply: (dimension: DrivingDimension, value: number) => void; readonly onMessage: (message: string) => void }): React.JSX.Element {
  if (entity.kind === "line") return <DimensionField label="Length" dimension="length" value={Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1])} onApply={onApply} onMessage={onMessage} />;
  if (entity.kind === "rectangle") return <div className="dimension-stack"><DimensionField label="Width" dimension="width" value={entity.widthMm} onApply={onApply} onMessage={onMessage} /><DimensionField label="Height" dimension="height" value={entity.heightMm} onApply={onApply} onMessage={onMessage} /></div>;
  if (entity.kind === "circle") return <><DimensionField label="Radius" dimension="radius" value={entity.radiusMm} onApply={onApply} onMessage={onMessage} /><div className="derived-dimension"><span>Diameter</span><strong>{format(entity.radiusMm * 2)} mm</strong></div></>;
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

function DirectDimensionPreview({ dimension }: { readonly dimension: DirectSketchDimension }): React.JSX.Element {
  const x = (dimension.first.point[0] + dimension.second.point[0]) / 2;
  const y = -(dimension.first.point[1] + dimension.second.point[1]) / 2 - 2.2;
  return <g className={`direct-dimension-preview ${dimension.driving === undefined ? "reference" : "driving"}`} pointerEvents="none">
    <line x1={dimension.first.point[0]} y1={-dimension.first.point[1]} x2={dimension.second.point[0]} y2={-dimension.second.point[1]} />
    <text x={x} y={y}>{format(dimension.valueMm)} mm</text>
  </g>;
}

function SketchEntityShape({ entity, selected, onSelect, preview = false, movable = false }: { readonly entity: SketchEntity; readonly selected: boolean; readonly onSelect?: (additive: boolean) => void; readonly preview?: boolean; readonly movable?: boolean }): React.JSX.Element {
  const className = `sketch-entity ${entity.construction ? "construction" : ""} ${selected ? "selected" : ""} ${preview ? "tool-preview" : ""} ${movable ? "movable" : ""}`;
  const common = {
    className,
    "data-selection-id": entity.id,
    style: onSelect === undefined ? { pointerEvents: "none" as const } : undefined,
    onPointerDown: preview || onSelect === undefined ? undefined : (event: React.PointerEvent) => { event.stopPropagation(); onSelect(event.shiftKey || event.ctrlKey || event.metaKey); }
  };
  if (entity.kind === "line") return <line {...common} x1={entity.start[0]} y1={-entity.start[1]} x2={entity.end[0]} y2={-entity.end[1]} />;
  if (entity.kind === "rectangle") return <rect {...common} x={entity.center[0] - entity.widthMm / 2} y={-entity.center[1] - entity.heightMm / 2} width={entity.widthMm} height={entity.heightMm} transform={`rotate(${-entity.rotationDeg} ${entity.center[0]} ${-entity.center[1]})`} />;
  if (entity.kind === "circle") return <circle {...common} cx={entity.center[0]} cy={-entity.center[1]} r={entity.radiusMm} />;
  if (entity.kind === "point") return <circle {...common} className={`${className} sketch-point`} cx={entity.point[0]} cy={-entity.point[1]} r="0.9" />;
  if (entity.kind === "spline") return <path {...common} d={sampleSpline(entity.fitPoints).map((point, index) => `${index === 0 ? "M" : "L"} ${point[0]} ${-point[1]}`).join(" ")} />;
  return <path {...common} d={arcPathData(entity.start, entity.mid, entity.end)} />;
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
  const common = {
    className: `sketch-profile ${selected ? "selected" : ""}`,
    "data-selection-id": profile.id,
    style: onSelect === undefined ? { pointerEvents: "none" as const } : undefined,
    onPointerDown: onSelect === undefined ? undefined : (event: React.PointerEvent) => { event.stopPropagation(); onSelect(event.shiftKey || event.ctrlKey || event.metaKey); },
    "aria-label": `${profileLabel(profile)} closed profile`
  };
  if (profile.boundary.kind === "rectangle") return <rect {...common} x={profile.boundary.center[0] - profile.boundary.widthMm / 2} y={-profile.boundary.center[1] - profile.boundary.heightMm / 2} width={profile.boundary.widthMm} height={profile.boundary.heightMm} transform={`rotate(${-profile.boundary.rotationDeg} ${profile.boundary.center[0]} ${-profile.boundary.center[1]})`} />;
  if (profile.boundary.kind === "circle") return <circle {...common} cx={profile.boundary.center[0]} cy={-profile.boundary.center[1]} r={profile.boundary.radiusMm} />;
  const path = profile.boundary.points.map((point, index) => `${index === 0 ? "M" : "L"} ${point[0]} ${-point[1]}`).join(" ");
  return <path {...common} d={`${path} Z`} />;
}

function SketchDimensionGlyph({ entity }: { readonly entity: SketchEntity }): React.JSX.Element {
  if (entity.kind === "line") {
    const x = (entity.start[0] + entity.end[0]) / 2;
    const y = -(entity.start[1] + entity.end[1]) / 2 - 3;
    return <text x={x} y={y} className="sketch-dimension-glyph">{format(Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1]))}</text>;
  }
  if (entity.kind === "rectangle") return <><text x={entity.center[0]} y={-entity.center[1] + entity.heightMm / 2 + 4} className="sketch-dimension-glyph">{format(entity.widthMm)}</text><text x={entity.center[0] + entity.widthMm / 2 + 3} y={-entity.center[1]} className="sketch-dimension-glyph vertical">{format(entity.heightMm)}</text></>;
  if (entity.kind === "circle") return <text x={entity.center[0] + entity.radiusMm * 0.35} y={-entity.center[1] - 2} className="sketch-dimension-glyph">R {format(entity.radiusMm)}</text>;
  return <></>;
}

function ConstraintGlyph({ constraint, entities }: { readonly constraint: WorkbenchSketchConstraint; readonly entities: readonly SketchEntity[] }): React.JSX.Element {
  const entity = entities.find((candidate) => candidate.id === constraint.entityIds[0]);
  if (entity === undefined) return <></>;
  const point = entityAnchor(entity);
  const label = constraint.kind === "horizontal" ? "H" : constraint.kind === "vertical" ? "V" : constraint.kind === "parallel" ? "∥" : constraint.kind === "perpendicular" ? "⊥" : constraint.kind === "fixed" ? "F" : constraint.kind === "concentric" ? "◎" : constraint.kind === "equal" ? "=" : constraint.kind.slice(0, 1).toUpperCase();
  return <g className="constraint-glyph"><circle cx={point[0] + 2.4} cy={-point[1] - 2.4} r="1.75" /><text x={point[0] + 2.4} y={-point[1] - 1.9}>{label}</text></g>;
}

function entityAnchor(entity: SketchEntity): Vec2 {
  if (entity.kind === "line") return [(entity.start[0] + entity.end[0]) / 2, (entity.start[1] + entity.end[1]) / 2];
  if (entity.kind === "rectangle" || entity.kind === "circle") return entity.center;
  if (entity.kind === "point") return entity.point;
  if (entity.kind === "spline") return entity.fitPoints[Math.floor(entity.fitPoints.length / 2)]!;
  return entity.mid;
}

function expandedView(min: Vec2, size: Vec2): { x: number; y: number; width: number; height: number } {
  const margin = Math.max(12, Math.max(...size) * 0.18);
  return { x: min[0] - margin, y: -(min[1] + size[1] + margin), width: size[0] + margin * 2, height: size[1] + margin * 2 };
}

function eventPoint(event: React.PointerEvent<SVGSVGElement>, view: { x: number; y: number; width: number; height: number }): Vec2 {
  const rect = event.currentTarget.getBoundingClientRect();
  const scale = Math.min(rect.width / view.width, rect.height / view.height);
  const renderedWidth = view.width * scale;
  const renderedHeight = view.height * scale;
  const offsetX = (rect.width - renderedWidth) / 2;
  const offsetY = (rect.height - renderedHeight) / 2;
  const x = view.x + (event.clientX - rect.left - offsetX) / scale;
  const svgY = view.y + (event.clientY - rect.top - offsetY) / scale;
  return [x, -svgY];
}

function profileLabel(profile: SketchProfile): string {
  return profile.boundary.kind === "rectangle" ? "Rectangle region" : profile.boundary.kind === "circle" ? "Circle region" : profile.boundary.kind === "curve-loop" ? "Closed curve loop" : "Closed line loop";
}

function shortId(id: string): string {
  return id.length < 28 ? id : `${id.slice(0, 18)}…${id.slice(-7)}`;
}

function format(value: number): string {
  return String(Number(value.toFixed(3)));
}
