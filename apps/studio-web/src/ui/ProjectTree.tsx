import { useEffect, useRef, useState } from "react";
import { WORKBENCH_MCP_TOOLS } from "../../../../packages/workbench-mcp/src/index.js";
import { dependentsOf, describeBodyFailure, describeFeature, designOf, failedBodies, featureOfBody, featureStatus, featureStatusText, isHealthNote, isSketchShown, sketchEyeShown, vehicleHardPoints, type DesignFeature, type DesignSketchFeature, type WorkbenchProject } from "../../../../packages/workbench-core/src/index.js";
import type { DesignHealthReport } from "../../../../packages/workbench-health/src/index.js";
import { analyzeWorkbenchSketch, detectSketchProfiles } from "../../../../packages/workbench-sketch/src/index.js";
import { friendlySketchText, sketchConstraintNames, sketchEntityNames, type WorkbenchSketch } from "../../../../packages/workbench-core/src/index.js";
import { evaluateConstructionPlane, resolveBinder } from "../../../../packages/workbench-geometry/src/index.js";
import { describeBinderKind } from "../construction-ui.js";
import { relationsEmptyHelp } from "../sketch-help-text.js";
import { timelineRowOpenId, timelineRowSelectionId } from "../sketch-plane-ui.js";
import { useSketchKeymap } from "../workspaces/sketch/useSketchKeymap.js";
import { CapabilityBadge } from "./CapabilityBadge.js";
import { CommandIcon, inferCommandIcon } from "./CommandIcon.js";
import { baseGridLabel } from "../../../../packages/workbench-sketch/src/unit-defaults.js";

interface ProjectTreeProps {
  readonly project: WorkbenchProject;
  readonly selectedId: string | null;
  readonly revealSelectionRequest: number;
  readonly designHealth: DesignHealthReport;
  readonly onSelect: (id: string | null) => void;
  /** HS-01: the one timeline step the selection means; only its row shows as selected (rows of a body's other steps do not). */
  readonly selectedStepId?: string | null;
  /** A click on a timeline row: select that step (or clear it when it was already selected). */
  readonly onSelectStep?: (feature: DesignFeature, wasSelected: boolean) => void;
  /** `featureId` is the timeline step of the row that was right-clicked, when it is a timeline row (its `selectionId` is the step's body). */
  readonly onContextMenu: (clientX: number, clientY: number, selectionId: string | null, featureId?: string) => void;
  /** Double-click on a row that can be opened: a timeline step (by the row's ID) or the working sketch. */
  readonly onOpenItem?: (id: string) => void;
  /** HS-10: rename a timeline step from its browser row (F2 on the row, or Rename in its menu). */
  readonly onRenameStep?: (feature: DesignFeature, name: string) => void;
  /** Rename a solid body from its browser row. */
  readonly onRenameBody?: (bodyId: string, name: string) => void;
  /** The eye on a body row: show or hide that body. */
  readonly onToggleBody?: (bodyId: string, kind: "general" | "preview") => void;
  /** The eye on a row of the Sketches folder: show or hide that sketch's curves in the model (HS-24). */
  readonly onToggleSketch?: (feature: DesignSketchFeature, shown: boolean) => void;
  /** Starts the inline rename of a row (a step ID or a body ID); a new `serial` is a new request. */
  readonly renameRequest?: { readonly id: string; readonly serial: number } | null;
}

type TreeKind = "project" | "health" | "datum" | "sketch" | "feature" | "body" | "component" | "mate" | "surface" | "drawing" | "electrical" | "vehicle" | "route" | "tool" | "history";

export function ProjectTree({ project, selectedId, selectedStepId, onSelectStep, revealSelectionRequest, designHealth, onSelect, onContextMenu, onOpenItem, onRenameStep, onRenameBody, onToggleBody, onToggleSketch, renameRequest }: ProjectTreeProps): React.JSX.Element {
  const treeRef = useRef<HTMLElement>(null);
  const handledRevealRequest = useRef(0);
  /** The row being renamed inline (a step ID or a body ID). */
  const [renaming, setRenaming] = useState<string | null>(null);
  const handledRenameRequest = useRef(0);
  useEffect(() => {
    if (renameRequest === undefined || renameRequest === null || renameRequest.serial <= handledRenameRequest.current) return;
    handledRenameRequest.current = renameRequest.serial;
    setRenaming(renameRequest.id);
  }, [renameRequest]);
  const renameFor = (key: string, commit: ((name: string) => void) | undefined): { readonly rename?: { readonly editing: boolean; readonly onStart: () => void; readonly onCommit: (name: string) => void; readonly onCancel: () => void } } =>
    commit === undefined ? {} : { rename: { editing: renaming === key, onStart: () => setRenaming(key), onCommit: (name: string) => { setRenaming(null); commit(name); }, onCancel: () => setRenaming(null) } };
  // Curves are listed as "Line 3", "Circle 1" (derived, see sketch-names.ts), never by their generated ids.
  const entityNames = sketchEntityNames(project.sketch.entities);
  useEffect(() => {
    if (selectedId === null) return;
    const selectedItem = treeRef.current?.querySelector<HTMLElement>('.tree-item[aria-pressed="true"]');
    if (selectedItem === undefined || selectedItem === null) return;
    selectedItem.scrollIntoView({ block: "nearest" });
    if (revealSelectionRequest > handledRevealRequest.current) {
      handledRevealRequest.current = revealSelectionRequest;
      // Find in browser: a section the person had folded is opened so the row can be seen.
      const section = selectedItem.closest("details");
      if (section !== null && !section.open) section.open = true;
      selectedItem.scrollIntoView({ block: "nearest" });
      selectedItem.focus({ preventScroll: true });
    }
  }, [project.activeWorkspace, revealSelectionRequest, selectedId]);
  const showOrigin = true;
  const showSketch = true;
  // A blank design has no template plate, so its canned feature rows and its body row are not listed.
  const hasPlate = project.part.templateVisible !== false;
  const showPartHistory = hasPlate;
  const showBodies = true;
  const drawingPreset = project.drawing.viewPreset ?? "automatic-4-view";
  const drawingViews = drawingPreset === "front-only"
    ? ["front"] as const
    : drawingPreset === "orthographic-3-view"
      ? ["front", "top", "right", ...(project.drawing.showSectionView ?? false ? ["section-a"] : [])] as const
      : ["front", "top", "right", "isometric", ...(project.drawing.showSectionView ?? false ? ["section-a"] : [])] as const;
  const drawingHasTop = drawingPreset !== "front-only";
  const drawingHasDatumFrame = drawingHasTop && project.drawing.datumScheme === "plate-3-2-1" && (project.drawing.showGdt ?? false);
  const drawingDimensionCount = project.drawing.showDimensions ? (drawingHasTop ? (drawingHasDatumFrame ? 6 : 4) : 3) : 0;
  const drawingGdtCount = (project.drawing.showGdt ?? false) ? (drawingHasDatumFrame ? 3 : 1) : 0;
  const vehiclePoints = project.activeWorkspace === "vehicle" ? vehicleHardPoints(project.vehicle) : [];
  const sketchProfiles = detectSketchProfiles(project.sketch);
  const workingSketchFullyConstrained = isSketchFullyConstrained(project.sketch);
  const linkedOutline = project.sketch.entities.find((entity) => entity.kind === "rectangle" && !entity.construction && Math.abs(entity.widthMm - project.part.widthMm) < 1e-6 && Math.abs(entity.heightMm - project.part.heightMm) < 1e-6);
  const linkedBore = project.sketch.entities.find((entity) => entity.kind === "circle" && !entity.construction && Math.hypot(entity.center[0] - (linkedOutline?.kind === "rectangle" ? linkedOutline.center[0] : 0), entity.center[1] - (linkedOutline?.kind === "rectangle" ? linkedOutline.center[1] : 0)) < 0.01 && Math.abs(entity.radiusMm * 2 - project.part.holeDiameterMm) < 1e-6);
  const relationships = selectionRelationships(project, selectedId, selectedStepId);
  const history = designOf(project);
  // HS-24: every finished sketch is listed under Sketches with its own eye. The working sketch is listed too while it is a sketch of its own (not yet finished) or is open.
  const timelineSketches = history.features.filter((feature): feature is DesignSketchFeature => feature.kind === "sketch");
  const workingSketchListed = history.editingSketchId === null && (project.sketch.entities.length > 0 || project.activeWorkspace === "sketch");
  // HS-21: a solid whose rebuild failed says so on its row, with the step and the reason.
  const failures = failedBodies(history);
  return <aside ref={treeRef} className="project-tree" aria-label="Model browser and feature history" onContextMenu={(event) => {
    event.preventDefault();
    const row = (event.target as Element).closest<HTMLElement>("[data-tree-id]");
    const id = row?.dataset["treeId"] ?? null;
    const featureId = row?.dataset["treeFeatureId"];
    if (id !== null) onSelect(id);
    if (featureId === undefined) onContextMenu(event.clientX, event.clientY, id);
    else onContextMenu(event.clientX, event.clientY, id, featureId);
  }}>
    <div className="panel-title model-browser-title"><p>Model browser</p><h2>{project.name}</h2><div><span>Revision {project.revision}</span><strong>{project.activeWorkspace}</strong></div></div>
    <TreeSection title="Document" badge="preview" initiallyOpen={false}>
      <TreeItem kind="project" id={project.id} label={project.name} meta="workbench / 1" selectedId={selectedId} onSelect={onSelect} />
    </TreeSection>
    <TreeSection title={`Design health · ${designHealth.score}`} badge="preview" initiallyOpen={false}>
      {designHealth.workspaces.map((workspace) => <TreeItem key={workspace.workspace} kind="health" id={`design-health:${workspace.workspace}`} label={workspace.label} meta={`${workspace.status} · ${workspace.score}/100 · ${workspace.findingIds.length} finding${workspace.findingIds.length === 1 ? "" : "s"}`} selectedId={selectedId} onSelect={onSelect} />)}
    </TreeSection>
    {relationships.length > 0 && <TreeSection title="Selection relationships" badge="preview">
      {relationships.map((relationship) => <TreeItem key={`${relationship.role}:${relationship.id}`} kind={relationship.kind} id={relationship.id} label={`${relationship.role} · ${relationship.label}`} meta={relationship.meta} selectedId={selectedId} onSelect={onSelect} />)}
    </TreeSection>}
    {showOrigin && <TreeSection title="Origin" badge="preview" initiallyOpen={false}>
      <TreeItem kind="datum" id="datum:origin" label="Origin" meta="0, 0, 0" selectedId={selectedId} onSelect={onSelect} />
      <TreeItem kind="datum" id="datum:xy" label="XY plane" meta="primary sketch plane" selectedId={selectedId} onSelect={onSelect} indent />
      <TreeItem kind="datum" id="datum:yz" label="YZ plane" meta="reference" selectedId={selectedId} onSelect={onSelect} indent />
      <TreeItem kind="datum" id="datum:xz" label="XZ plane" meta="reference" selectedId={selectedId} onSelect={onSelect} indent />
      {(project.part.constructionAxes ?? []).map((axis) => <TreeItem key={axis.id} kind="datum" id={axis.id} label={axis.name} meta={`axis · ${axis.definition.kind.replaceAll("-", " ")}${axis.visible ? "" : " · hidden"}`} selectedId={selectedId} onSelect={onSelect} indent />)}
      {(project.part.construction ?? []).map((plane) => {
        const frame = evaluateConstructionPlane(plane, project.part.generalBodies ?? [], project.part.constructionAxes ?? [], project.part.constructionBinders ?? []);
        return <TreeItem key={plane.id} kind="datum" id={plane.id} label={plane.name} meta={`plane · ${plane.definition.kind.replaceAll("-", " ")}${plane.visible ? "" : " · hidden"}${"error" in frame ? ` · broken: ${frame.error}` : ""}`} selectedId={selectedId} onSelect={onSelect} indent />;
      })}
      {(project.part.constructionBinders ?? []).map((binder) => {
        const resolved = resolveBinder(binder, project.part.generalBodies ?? []);
        return <TreeItem key={binder.id} kind="datum" id={binder.id} label={binder.name} meta={`${describeBinderKind(binder)}${binder.visible ? "" : " · hidden"} · ${"error" in resolved ? `lost: ${resolved.error}` : "resolved"}`} selectedId={selectedId} onSelect={onSelect} indent />;
      })}
      {(project.part.constructionPoints ?? []).map((point) => <TreeItem key={point.id} kind="datum" id={point.id} label={point.name} meta={`point · ${point.definition.kind.replaceAll("-", " ")}${point.visible ? "" : " · hidden"}`} selectedId={selectedId} onSelect={onSelect} indent />)}
    </TreeSection>}
    {showSketch && <TreeSection title={`Sketches · ${timelineSketches.length + (workingSketchListed ? 1 : 0)}`} badge="preview">
      {timelineSketches.map((feature) => {
        const eyeOn = sketchEyeShown(history, feature);
        const inModel = isSketchShown(history, feature);
        const curves = feature.sketch.entities.length;
        return <TreeItem
          key={`sketch-folder:${feature.id}`}
          kind="sketch"
          icon="sketch"
          id={timelineRowSelectionId(feature)}
          featureId={timelineRowOpenId(feature)}
          label={feature.name}
          meta={`${curves} curve${curves === 1 ? "" : "s"} · ${inModel ? "shown in the model" : eyeOn ? (feature.suppressed ? "suppressed" : "not in the model at this point") : "hidden"}`}
          {...(feature.health !== undefined && !isHealthNote(feature.health.message) ? { failed: true } : {})}
          selectedId={selectedId}
          onSelect={onSelect}
          {...(onSelectStep === undefined ? {} : { selected: selectedStepId === feature.id, onPick: (wasSelected: boolean) => onSelectStep(feature, wasSelected) })}
          {...(onOpenItem === undefined ? {} : { onOpen: onOpenItem, openHint: "Double-click to edit this sketch" })}
          {...(onToggleSketch === undefined ? {} : { eye: { shown: eyeOn, what: "sketch", onToggle: () => onToggleSketch(feature, !eyeOn) } })}
        />;
      })}
      <TreeItem kind="sketch" id={project.sketch.id} label={project.sketch.name} meta={`${project.sketch.constraints.length} constraints${workingSketchFullyConstrained ? " · fully constrained" : ""}`} selectedId={selectedId} onSelect={onSelect} {...(onOpenItem === undefined || project.activeWorkspace === "sketch" ? {} : { onOpen: onOpenItem, openHint: "Double-click to edit this sketch" })} {...(workingSketchFullyConstrained ? { trailingIcon: "lock" as const } : {})} />
      {project.activeWorkspace === "sketch"
        ? <SketchNavigator project={project} sketchProfiles={sketchProfiles} selectedId={selectedId} onSelect={onSelect} />
        : <>
          {project.sketch.entities.map((entity) => <TreeItem key={entity.id} kind="sketch" id={entity.id} label={entityNames.get(entity.id) ?? entityLabel(entity.kind)} meta={`${entityLabel(entity.kind)} · ${entity.visible === false ? "hidden" : "shown"}`} selectedId={selectedId} onSelect={onSelect} indent />)}
          {sketchProfiles.map((profile, index) => <TreeItem key={profile.id} kind="sketch" id={profile.id} label={`Profile P${index + 1}`} meta={`${profile.boundary.kind.replaceAll("-", " ")} · ${formatArea(profile.areaMm2)} mm²`} selectedId={selectedId} onSelect={onSelect} indent />)}
        </>}
    </TreeSection>}
    {history.features.length > 0 && <TreeSection title={`Timeline · ${history.features.length} step${history.features.length === 1 ? "" : "s"}`} badge="preview">
      {history.features.map((feature) => {
        const status = featureStatusText(featureStatus(history, feature));
        // A sketch feature in the timeline is a snapshot, so we read its classification from that snapshot directly.
        const locked = feature.kind === "sketch" && isSketchFullyConstrained(feature.sketch);
        return <TreeItem
          key={feature.id}
          kind={feature.kind === "sketch" ? "sketch" : "feature"}
          icon={feature.kind}
          id={timelineRowSelectionId(feature)}
          featureId={timelineRowOpenId(feature)}
          label={feature.name}
          meta={`${describeFeature(history, feature)}${locked ? " · fully constrained" : ""}${status === "" ? "" : ` · ${status}`}${feature.health === undefined ? "" : ` · ${feature.health.message}`}`}
          {...(feature.health !== undefined && !isHealthNote(feature.health.message) ? { failed: true } : {})}
          selectedId={selectedId}
          onSelect={onSelect}
          {...(onSelectStep === undefined ? {} : { selected: selectedStepId === feature.id, onPick: (wasSelected: boolean) => onSelectStep(feature, wasSelected) })}
          {...renameFor(feature.id, onRenameStep === undefined ? undefined : (name) => onRenameStep(feature, name))}
          {...(onOpenItem === undefined ? {} : { onOpen: onOpenItem, openHint: feature.kind === "sketch" ? "Double-click to edit this sketch" : "Double-click to edit this step" })}
          {...(locked ? { trailingIcon: "lock" as const } : {})}
        />;
      })}
    </TreeSection>}
    {showPartHistory && <TreeSection title="Mounting plate features" badge="preview" initiallyOpen={history.features.length === 0}>
      <TreeItem kind="feature" id="feature:plate-extrusion" label="Base extrusion" meta={`${project.part.widthMm} × ${project.part.heightMm} × ${project.part.thicknessMm} mm · ${linkedOutline === undefined ? "parameter driven" : "sketch linked"}`} selectedId={selectedId} onSelect={onSelect} />
      <TreeItem kind="feature" id="feature:centered-through-hole" label="Centered bore" meta={`Ø${project.part.holeDiameterMm} mm · through all · ${linkedBore === undefined ? "parameter driven" : "sketch linked"}`} selectedId={selectedId} onSelect={onSelect} />
      <TreeItem kind="feature" id="feature:edge-treatment" label="Edge treatment" meta={`${project.part.edgeTreatmentMm} mm · preview`} selectedId={selectedId} onSelect={onSelect} />
      <TreeItem kind="feature" id="feature:linear-pattern" label="Linear pattern" meta={`${project.part.patternCount} instances · preview`} selectedId={selectedId} onSelect={onSelect} />
      <TreeItem kind="feature" id="feature:revolve-study" label="Revolve study" meta={`${project.part.revolveAngleDeg}° · preview`} selectedId={selectedId} onSelect={onSelect} />
    </TreeSection>}
    {showBodies && <TreeSection title="Bodies" badge={project.activeWorkspace === "part" ? "qualified" : "preview"}>
      {hasPlate && <TreeItem kind="body" id="body:bracket" label="Mounting plate" meta="closed manifold mesh" selectedId={selectedId} onSelect={onSelect} />}
      {(project.part.previewBodies ?? []).map((body) => <TreeItem key={body.id} kind="body" id={body.id} label={body.name} meta={`${body.shape} · ${body.visible ? "shown" : "hidden"} · preview`} selectedId={selectedId} onSelect={onSelect} indent {...(onToggleBody === undefined ? {} : { eye: { shown: body.visible, onToggle: () => onToggleBody(body.id, "preview") } })} />)}
      {(project.part.generalBodies ?? []).map((body) => <TreeItem key={body.id} kind="body" id={body.id} label={body.name} {...(failures.has(body.id) ? { failed: true } : {})} {...(onToggleBody === undefined ? {} : { eye: { shown: body.visible, onToggle: () => onToggleBody(body.id, "general") } })} {...renameFor(body.id, onRenameBody === undefined ? undefined : (name) => onRenameBody(body.id, name))} meta={`${body.feature?.operation === "surface" ? "surface" : body.subd !== undefined ? "SubD form" : `${body.feature?.operation ?? "mesh"} solid`} · ${body.visible ? "shown" : "hidden"} · ${body.brep !== undefined ? `${body.brep.topology.faces} faces · ${body.brep.origin === "mesh-boolean" ? "Boolean mesh" : "B-rep"}` : `${body.positionsMm.length / 3} verts`}${failures.has(body.id) ? ` · ${describeBodyFailure(failures.get(body.id)!)}` : ""}`} selectedId={selectedId} onSelect={onSelect} indent />)}
      <TreeItem kind="surface" id={project.surface.id} label={project.surface.name} meta={`${project.surface.mode} · open surface preview`} selectedId={selectedId} onSelect={onSelect} />
    </TreeSection>}
    {project.activeWorkspace === "assembly" && <>
      <TreeSection title="Assembly template" badge="preview">
        <TreeItem kind="component" id="assembly-action:template" label={assemblyTemplateLabel(project.assembly.template ?? "custom")} meta={project.assembly.nominalEnvelopeMm === undefined ? "custom envelope" : `${project.assembly.nominalEnvelopeMm.join(" × ")} mm nominal`} selectedId={selectedId} onSelect={onSelect} />
        <TreeItem kind="component" id="assembly-action:status" label="Design status" meta={project.assembly.designStatus ?? "editable-preview"} selectedId={selectedId} onSelect={onSelect} indent />
        {project.assembly.electromechanicalSource !== undefined && <TreeItem kind="electrical" id="electromechanical:source" label="Schematic link" meta={`${project.assembly.electromechanicalSource.status} · ${project.assembly.electromechanicalSource.catalogRevision}`} selectedId={selectedId} onSelect={onSelect} indent />}
      </TreeSection>
      {project.assembly.electricalLinks !== undefined && <TreeSection title={`ECAD ↔ MCAD links · ${project.assembly.electricalLinks.length}`} badge="preview">
        {project.assembly.electricalLinks.map((link) => <TreeItem key={link.assemblyComponentId} kind="electrical" id={link.assemblyComponentId} label={`${link.electricalReference} → panel package`} meta={`${link.terminalMap.length} terminal map${link.terminalMap.length === 1 ? "" : "s"} · generic proxy`} selectedId={selectedId} onSelect={onSelect} />)}
      </TreeSection>}
      {project.assembly.electricalRoutes !== undefined && <TreeSection title={`Conductors · ${project.assembly.electricalRoutes.length}`} badge="preview">
        {project.assembly.electricalRoutes.map((route) => <TreeItem key={route.id} kind="route" id={route.id} label={route.name} meta={`${route.class} · unsized visualization`} selectedId={selectedId} onSelect={onSelect} />)}
      </TreeSection>}
      <TreeSection title={`Components · ${project.assembly.components.length}`} badge="preview">
        {project.assembly.components.map((component) => <TreeItem key={component.id} kind="component" id={component.id} label={component.name} meta={`${component.grounded ? "grounded" : component.shape} · ${component.visible ? "shown" : "hidden"}`} selectedId={selectedId} onSelect={onSelect} />)}
      </TreeSection>
      <TreeSection title={`Mates · ${project.assembly.mates.length}`} badge="preview">
        {project.assembly.mates.map((mate) => <TreeItem key={mate.id} kind="mate" id={mate.id} label={mate.name} meta={mate.status} selectedId={selectedId} onSelect={onSelect} />)}
      </TreeSection>
    </>}
    {project.activeWorkspace !== "assembly" && <>
      <TreeSection title={`Components · ${project.assembly.components.length}`} badge="preview" initiallyOpen={false}>
        {project.assembly.components.map((component) => <TreeItem key={component.id} kind="component" id={component.id} label={component.name} meta={`${component.grounded ? "grounded" : component.shape} · ${component.visible ? "shown" : "hidden"}`} selectedId={selectedId} onSelect={onSelect} />)}
      </TreeSection>
      <TreeSection title={`Mates · ${project.assembly.mates.length}`} badge="preview" initiallyOpen={false}>
        {project.assembly.mates.map((mate) => <TreeItem key={mate.id} kind="mate" id={mate.id} label={mate.name} meta={`${mate.kind} · ${mate.status}`} selectedId={selectedId} onSelect={onSelect} />)}
      </TreeSection>
    </>}
    {project.activeWorkspace === "drawing" && <TreeSection title="Drawing views" badge="preview">
      {drawingViews.map((view) => <TreeItem key={view} kind="drawing" id={`drawing-view:${view}`} label={drawingViewLabel(view)} meta={view === "front" ? "base · parent" : view === "isometric" ? "pictorial · reference" : view === "section-a" ? "full section · from front" : "projected · aligned to front"} selectedId={selectedId} onSelect={onSelect} />)}
      <TreeItem kind="drawing" id={project.drawing.id} label="PS3D title block" meta={project.drawing.sheet} selectedId={selectedId} onSelect={onSelect} />
    </TreeSection>}
    {project.activeWorkspace === "drawing" && <TreeSection title="Drawing annotations" badge="preview">
      <TreeItem kind="drawing" id="drawing-action:dimensions" label="Selected model dimensions" meta={`${drawingDimensionCount} generated · duplicates removed`} selectedId={selectedId} onSelect={onSelect} />
      <TreeItem kind="drawing" id="drawing-action:tolerance" label="General tolerance" meta={`±${project.drawing.generalToleranceLinearMm ?? 0.2} mm`} selectedId={selectedId} onSelect={onSelect} />
      <TreeItem kind="drawing" id="drawing-action:gdt" label="Explicit GD&T and datums" meta={`${drawingGdtCount} frames · ${(project.drawing.showGdt ?? false) ? "shown" : "hidden"}`} selectedId={selectedId} onSelect={onSelect} />
      <TreeItem kind="drawing" id="drawing-action:standard" label="Drafting basis" meta={`${project.drawing.draftingStandard ?? "ASME"} · ${project.drawing.projection}`} selectedId={selectedId} onSelect={onSelect} />
    </TreeSection>}
    {project.activeWorkspace === "electrical" && <>
      <TreeSection title="Electrical document" badge="preview">
        <TreeItem kind="electrical" id={project.electrical.id} label={project.electrical.title} meta={`${project.electrical.standard} · ${project.electrical.template.replaceAll("-", " ")}`} selectedId={selectedId} onSelect={onSelect} />
      </TreeSection>
      <TreeSection title={`Components · ${project.electrical.components.length}`} badge="preview">
        {project.electrical.components.map((component) => <TreeItem key={component.id} kind="electrical" id={component.id} label={`${component.reference} · ${component.label}`} meta={`${component.kind} · ${component.terminals.length} terminal${component.terminals.length === 1 ? "" : "s"}`} selectedId={selectedId} onSelect={onSelect} />)}
      </TreeSection>
      <TreeSection title={`Nets · ${project.electrical.nets.length}`} badge="preview">
        {project.electrical.nets.map((net) => <TreeItem key={net.id} kind="electrical" id={net.id} label={net.name} meta={`${net.class} · ${net.endpoints.length} endpoints`} selectedId={selectedId} onSelect={onSelect} />)}
      </TreeSection>
      <TreeSection title="Electrical checks" badge="preview">
        <TreeItem kind="electrical" id="electrical-action:erc" label="Electrical rule check" meta="live connectivity / references" selectedId={selectedId} onSelect={onSelect} />
        <TreeItem kind="electrical" id="electrical-action:bom" label="Concept device index" meta="reference / value / quantity" selectedId={selectedId} onSelect={onSelect} />
        <TreeItem kind="electrical" id="electrical-action:physicalize" label="Circuit → wired panel readiness" meta="packages / terminals / conductors" selectedId={selectedId} onSelect={onSelect} />
      </TreeSection>
    </>}
    {project.activeWorkspace === "vehicle" && <>
      <TreeSection title="Vehicle definition" badge="preview">
        <TreeItem kind="vehicle" id={project.vehicle.id} label={project.vehicle.name} meta={`${project.vehicle.kind} · ${project.vehicle.powertrain}`} selectedId={selectedId} onSelect={onSelect} />
        <TreeItem kind="vehicle" id="vehicle-action:template" label="Generic template" meta={project.vehicle.template.replaceAll("-", " ")} selectedId={selectedId} onSelect={onSelect} indent />
        <TreeItem kind="vehicle" id="vehicle-action:layout" label="Wheel layout" meta={project.vehicle.layout.replaceAll("-", " ")} selectedId={selectedId} onSelect={onSelect} indent />
        <TreeItem kind="vehicle" id="vehicle-action:state" label="Suspension state" meta={project.vehicle.state.replaceAll("-", " ")} selectedId={selectedId} onSelect={onSelect} indent />
      </TreeSection>
      <TreeSection title="Vehicle CAD layers" badge="preview">
        {(Object.entries(project.vehicle.layers) as readonly (readonly [keyof typeof project.vehicle.layers, boolean])[]).map(([layer, visible]) => <TreeItem key={layer} kind="vehicle" id={`vehicle-layer:${layer}`} label={layer === "cg-loads" ? "CG and loads" : capitalizeWords(layer)} meta={visible ? "visible" : "hidden"} selectedId={selectedId} onSelect={onSelect} />)}
      </TreeSection>
      <TreeSection title={`Hardpoints · ${vehiclePoints.length}`} badge="preview">
        {vehiclePoints.map((point) => <TreeItem key={point.id} kind="vehicle" id={point.id} label={point.label} meta={`${point.positionM.map((value) => Math.round(value * 1000)).join(", ")} mm`} selectedId={selectedId} onSelect={onSelect} />)}
      </TreeSection>
      <TreeSection title="Engineering calculations" badge="preview">
        <TreeItem kind="vehicle" id="vehicle-analysis:geometry" label="Geometry & steering" meta="trail · turn radius · rake" selectedId={selectedId} onSelect={onSelect} />
        <TreeItem kind="vehicle" id="vehicle-analysis:suspension" label="Suspension & springs" meta="wheel rate · ride frequency · state" selectedId={selectedId} onSelect={onSelect} />
        <TreeItem kind="vehicle" id="vehicle-analysis:brakes" label="Brake system" meta="load transfer · pressure · split · stop" selectedId={selectedId} onSelect={onSelect} />
        <TreeItem kind="vehicle" id="vehicle-analysis:stability" label="CG & stability" meta={project.vehicle.layout === "single-track" ? "steady lean reference" : "triangular support polygon"} selectedId={selectedId} onSelect={onSelect} />
        <TreeItem kind="vehicle" id="vehicle-analysis:powertrain" label="Powertrain & road load" meta="operating-point screen" selectedId={selectedId} onSelect={onSelect} />
      </TreeSection>
    </>}
    {project.activeWorkspace === "automate" && <TreeSection title="Automation tools" badge="preview">
      {WORKBENCH_MCP_TOOLS.map((tool) => <TreeItem key={tool.name} kind="tool" id={`mcp-tool:${tool.name}`} label={tool.title} meta={tool.annotations.readOnlyHint ? "read only" : "confirmation"} selectedId={selectedId} onSelect={onSelect} />)}
      <TreeItem kind="tool" id="automation:python-sdk" label="Python MCP client" meta="stdlib · explicit command" selectedId={selectedId} onSelect={onSelect} />
    </TreeSection>}
    <TreeSection title={`Revision timeline · ${project.audit.length}`} badge="preview">
      {project.audit.length === 0 ? <p className="tree-empty">No broad-workbench edits yet.</p> : project.audit.slice(-8).reverse().map((entry) => <TreeItem key={`${entry.revision}:${entry.operationId}`} kind="history" id={`history:${entry.revision}`} label={entry.summary} meta={`R${entry.revision} · ${formatKind(entry.kind)}`} selectedId={selectedId} onSelect={onSelect} />)}
    </TreeSection>
    <div className="tree-footer"><span>Schema</span><strong>workbench / 1</strong><span>Units</span><strong>{project.activeWorkspace === "vehicle" ? "SI native · mm display" : "millimeters"}</strong><span>Capabilities</span><strong>truth labeled</strong></div>
  </aside>;
}

/**
 * 4-tab Sketch Navigator (Fusion/NX-style): Curves lists every drawn entity plus derived profiles, Relations lists
 * constraints the solver has, External refs lists the datums the sketch is attached to, and Issues reads
 * `analyzeWorkbenchSketch` to show the solver classification and any conflicts it flagged. Each tab's rows are clickable
 * TreeItems that drive the viewport selection.
 */
function SketchNavigator({ project, sketchProfiles, selectedId, onSelect }: {
  readonly project: WorkbenchProject;
  readonly sketchProfiles: ReturnType<typeof detectSketchProfiles>;
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
}): React.JSX.Element {
  const sketchKeymap = useSketchKeymap();
  const [tab, setTab] = useState<"curves" | "relations" | "refs" | "issues">("curves");
  const analysis = analyzeWorkbenchSketch(project.sketch);
  const curves = project.sketch.entities;
  const relations = project.sketch.constraints;
  const entityNames = sketchEntityNames(curves);
  const relationNames = sketchConstraintNames(relations);
  const hiddenCount = curves.filter((entity) => entity.visible === false).length;
  const planeKey = project.sketch.plane.replace("datum:", "").toUpperCase();
  const tabs = [
    { id: "curves" as const, label: `Curves · ${curves.length}` },
    { id: "relations" as const, label: `Relations · ${relations.length}` },
    { id: "refs" as const, label: "External refs" },
    { id: "issues" as const, label: `Issues · ${analysis.conflicts.length}` }
  ];
  return <>
    <div className="sketch-navigator-tabs" role="tablist" aria-label="Sketch navigator">
      {tabs.map((entry) => <button key={entry.id} type="button" role="tab" aria-selected={tab === entry.id} className={`sketch-navigator-tab ${tab === entry.id ? "active" : ""}`} onClick={() => setTab(entry.id)}>{entry.label}</button>)}
    </div>
    <div role="tabpanel" aria-label={`Sketch navigator · ${tab}`} className="sketch-navigator-panel">
      {tab === "curves" && <>
        {curves.length === 0 && <p className="tree-empty">No curves yet — pick a sketch tool from the ribbon.</p>}
        {curves.map((entity) => <TreeItem key={entity.id} kind="sketch" id={entity.id} label={entityNames.get(entity.id) ?? entityLabel(entity.kind)} meta={`${entityLabel(entity.kind)} · ${entity.visible === false ? "hidden" : "shown"}${entity.construction ? " · construction" : ""}`} selectedId={selectedId} onSelect={onSelect} indent />)}
        {sketchProfiles.map((profile, index) => <TreeItem key={profile.id} kind="sketch" id={profile.id} label={`Profile P${index + 1}`} meta={`${profile.boundary.kind.replaceAll("-", " ")} · ${formatArea(profile.areaMm2)} mm²`} selectedId={selectedId} onSelect={onSelect} indent />)}
      </>}
      {tab === "relations" && <>
        {relations.length === 0 && <p className="tree-empty">{relationsEmptyHelp(sketchKeymap)}</p>}
        {relations.map((constraint) => <TreeItem key={constraint.id} kind="sketch" id={constraint.id} label={relationNames.get(constraint.id) ?? constraint.kind.replaceAll("-", " ")} meta={`${constraint.entityIds.map((id) => entityNames.get(id) ?? "a curve").join(" + ")}${constraint.valueMm !== undefined ? ` · ${constraint.valueMm} mm` : ""}${constraint.suppressed === true ? " · suppressed" : ""}`} selectedId={selectedId} onSelect={onSelect} indent />)}
      </>}
      {tab === "refs" && <>
        <TreeItem kind="datum" id={project.sketch.plane} label={`${planeKey} plane`} meta={`active sketch plane · ${baseGridLabel(project.sketch.gridMm, project.displayUnit ?? "mm")} grid`} selectedId={selectedId} onSelect={onSelect} indent />
        <TreeItem kind="datum" id="datum:origin" label="Origin" meta="projected into sketch" selectedId={selectedId} onSelect={onSelect} indent />
        {hiddenCount > 0 && <p className="tree-empty">{hiddenCount} entit{hiddenCount === 1 ? "y is" : "ies are"} hidden. Hidden entities do not bound a profile.</p>}
      </>}
      {tab === "issues" && <>
        <TreeItem kind="health" id="sketch-navigator:classification" label={analysis.classification === "fully-constrained" ? "Fully constrained" : analysis.classification === "conflict" ? "Conflicting constraints" : `Under-constrained · ${analysis.degreesOfFreedom} DOF`} meta={`${analysis.appliedConstraints} constraint${analysis.appliedConstraints === 1 ? "" : "s"} applied`} selectedId={selectedId} onSelect={onSelect} indent />
        {analysis.conflicts.length === 0 && analysis.classification !== "conflict" && <p className="tree-empty">No solver conflicts reported.</p>}
        {analysis.conflicts.map((issue, index) => <TreeItem key={`issue:${index}`} kind="health" id={`sketch-navigator:issue:${index}`} label={`Conflict ${index + 1}`} meta={friendlySketchText(issue, [project.sketch])} selectedId={selectedId} onSelect={onSelect} indent />)}
      </>}
    </div>
  </>;
}

function TreeSection({ title, badge, children, initiallyOpen = true }: { readonly title: string; readonly badge: "qualified" | "preview"; readonly children: React.ReactNode; readonly initiallyOpen?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(initiallyOpen);
  return <details className="tree-section" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span className="tree-chevron" aria-hidden="true">›</span><strong>{title}</strong><CapabilityBadge level={badge} /></summary><div>{children}</div></details>;
}

export function TreeItem(props: { readonly kind: TreeKind; readonly id: string; readonly label: string; readonly meta: string; readonly selectedId: string | null; readonly onSelect: (id: string | null) => void; readonly indent?: boolean; readonly icon?: string; readonly trailingIcon?: string; readonly onOpen?: (id: string) => void; readonly openHint?: string; /** The timeline step this row shows. Double-click opens it, whatever the row selects. */ readonly featureId?: string; /** A row that stands for one step says itself whether it is selected, and what a click does. */ readonly selected?: boolean; readonly onPick?: (wasSelected: boolean) => void; /** Inline rename: F2 on the row starts it, Enter commits, Esc cancels. */ readonly rename?: { readonly editing: boolean; readonly onStart: () => void; readonly onCommit: (name: string) => void; readonly onCancel: () => void }; /** The eye of a body or sketch row. */ readonly eye?: { readonly shown: boolean; readonly onToggle: () => void; /** What the eye shows or hides, for its tooltip ("body" when absent). */ readonly what?: string }; /** The row's step or solid could not be rebuilt: it is drawn in the error colour and says so to a screen reader. */ readonly failed?: boolean }): React.JSX.Element {
  const selected = props.selected ?? props.selectedId === props.id;
  // A double-click is two clicks first (select, then deselect); opening selects the row again so it reads as the thing being edited.
  const open = props.onOpen;
  const openId = props.featureId ?? props.id;
  const rename = props.rename;
  const main = rename?.editing === true
    ? <input
      className="tree-rename"
      aria-label={`Rename ${props.label}`}
      defaultValue={props.label}
      maxLength={120}
      autoFocus
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => rename.onCancel()}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); const name = event.currentTarget.value.trim(); if (name.length > 0 && name !== props.label) rename.onCommit(name); else rename.onCancel(); }
        else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); rename.onCancel(); }
      }}
    />
    : <button data-tree-id={props.id} {...(props.featureId === undefined ? {} : { "data-tree-feature-id": props.featureId })} className={`tree-item ${selected ? "selected" : ""} ${props.indent === true ? "indent" : ""} ${props.failed === true ? "failed" : ""}`.trimEnd()} aria-pressed={selected} {...(props.failed === true ? { "data-health": "failed" } : {})} onClick={() => { if (props.onPick !== undefined) props.onPick(selected); else props.onSelect(selected ? null : props.id); }} {...(rename === undefined ? {} : { onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => { if (event.key === "F2") { event.preventDefault(); rename.onStart(); } } })} {...(open === undefined ? {} : { onDoubleClick: () => { if (props.onPick !== undefined) props.onPick(false); else props.onSelect(props.id); open(openId); }, "data-opens": "true", "data-tree-open-id": openId, title: props.openHint ?? "Double-click to open" })}><span className={`tree-glyph ${props.kind}`} aria-hidden="true"><CommandIcon name={props.icon ?? treeIcon(props.kind, props.label, props.id)} /></span><span><strong>{props.label}</strong><small>{props.meta}</small></span>{props.trailingIcon !== undefined && <span className="tree-trailing" aria-label="Fully constrained" title="Fully constrained"><CommandIcon name={props.trailingIcon} /></span>}</button>;
  if (props.eye === undefined && rename?.editing !== true) return main;
  return <div className="tree-row">
    {main}
    {props.eye !== undefined && <button
      type="button"
      data-tree-id={props.id}
      className="tree-eye"
      aria-pressed={props.eye.shown}
      aria-label={`${props.eye.shown ? "Hide" : "Show"} ${props.label}`}
      title={props.eye.shown ? `Hide this ${props.eye.what ?? "body"}` : `Show this ${props.eye.what ?? "body"}`}
      onClick={props.eye.onToggle}
    ><CommandIcon name={props.eye.shown ? "eye" : "eye-off"} /></button>}
  </div>;
}

/** A sketch is fully constrained when every drawn primitive has a determined pose: the solver reports zero degrees of freedom. An empty sketch is not called "fully constrained" because there is nothing to constrain yet. */
function isSketchFullyConstrained(sketch: WorkbenchSketch): boolean {
  if (sketch.entities.every((entity) => entity.construction)) return false;
  return analyzeWorkbenchSketch(sketch).classification === "fully-constrained";
}

function treeIcon(kind: TreeKind, label: string, id: string): string {
  if (kind === "feature") return inferCommandIcon(`${label} ${id}`, "part");
  if (kind === "sketch") return inferCommandIcon(label, "sketch");
  if (kind === "drawing") return inferCommandIcon(`${label} ${id}`, "drawing");
  if (kind === "electrical") return inferCommandIcon(`${label} ${id}`, "electrical");
  if (kind === "vehicle") return inferCommandIcon(`${label} ${id}`, "vehicle");
  if (kind === "tool") return id === "automation:python-sdk" ? "python" : "mcp";
  const icons: Record<TreeKind, string> = { project: "file", health: "inspect", datum: "axes", sketch: "sketch", feature: "part", body: "part", component: "assembly", mate: "mate", surface: "surface", drawing: "drawing", electrical: "electrical", vehicle: "vehicle", route: "wire", tool: "mcp", history: "command" };
  return icons[kind];
}

function entityLabel(kind: WorkbenchProject["sketch"]["entities"][number]["kind"]): string {
  return kind === "arc" ? "Three-point arc" : `${kind[0]!.toUpperCase()}${kind.slice(1)}`;
}

function assemblyTemplateLabel(template: NonNullable<WorkbenchProject["assembly"]["template"]>): string {
  const labels = { custom: "Custom editable assembly", "cargo-20ft": "20 ft cargo planning frame", "cargo-40ft-hc": "40 ft high-cube planning frame", "bess-20ft-hc": "20 ft high-cube BESS arrangement", "electrical-panel": "Wired electrical mounting plate" };
  return labels[template];
}

function drawingViewLabel(view: string): string {
  const labels: Record<string, string> = { front: "Front base view", top: "Top projected view", right: "Right projected view", isometric: "Isometric reference", "section-a": "Section A–A" };
  return labels[view] ?? view;
}

function shortId(id: string): string {
  return id.split(":").at(-1) ?? id;
}

function formatKind(kind: string): string {
  return kind.replaceAll("-", " ");
}

function capitalizeWords(value: string): string {
  return value.split("-").map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`).join(" ");
}

function formatArea(value: number): string {
  return String(Number(value.toFixed(2)));
}

function selectionRelationships(project: WorkbenchProject, selectedId: string | null, selectedStepId?: string | null): readonly { readonly role: string; readonly id: string; readonly label: string; readonly meta: string; readonly kind: TreeKind }[] {
  if (selectedId === null) return [];
  const history = designOf(project);
  const ownStep = (selectedStepId === undefined || selectedStepId === null ? undefined : history.features.find((feature) => feature.id === selectedStepId))
    ?? history.features.find((feature) => feature.id === selectedId) ?? (selectedId.startsWith("general-body:") ? featureOfBody(history, selectedId) : undefined);
  if (ownStep !== undefined) {
    if (ownStep.kind === "sketch") return dependentsOf(history, ownStep.id).map((step) => ({ role: "Built on it", id: timelineRowSelectionId(step), label: step.name, meta: describeFeature(history, step), kind: "feature" as const }));
    const source = history.features.find((feature) => feature.id === ownStep.sketchFeatureId);
    return source === undefined ? [] : [{ role: "Made from", id: source.id, label: source.name, meta: describeFeature(history, source), kind: "sketch" as const }];
  }
  if (selectedId.startsWith("entity:") || selectedId.startsWith("profile:")) return [
    { role: "Parent", id: project.sketch.id, label: project.sketch.name, meta: "XY sketch · associative input", kind: "sketch" },
    { role: "Child", id: "feature:plate-extrusion", label: "Base extrusion", meta: "qualified profile consumer", kind: "feature" }
  ];
  if (selectedId.startsWith("feature:")) return [
    { role: "Input", id: project.sketch.id, label: project.sketch.name, meta: "source sketch", kind: "sketch" },
    { role: "Output", id: "body:bracket", label: "Mounting plate", meta: "closed manifold mesh", kind: "body" }
  ];
  if (selectedId === "body:bracket") return [
    { role: "Parent", id: "feature:plate-extrusion", label: "Base extrusion", meta: "history feature", kind: "feature" }
  ];
  const component = project.assembly.components.find((candidate) => candidate.id === selectedId);
  if (component !== undefined) return project.assembly.mates.filter((mate) => mate.componentIds.includes(component.id)).map((mate) => ({ role: "Mate", id: mate.id, label: mate.name, meta: mate.kind, kind: "mate" as const }));
  const mate = project.assembly.mates.find((candidate) => candidate.id === selectedId);
  if (mate !== undefined) return mate.componentIds.flatMap((componentId) => {
    const related = project.assembly.components.find((candidate) => candidate.id === componentId);
    return related === undefined ? [] : [{ role: "Component", id: related.id, label: related.name, meta: related.grounded ? "grounded" : related.shape, kind: "component" as const }];
  });
  return [];
}
