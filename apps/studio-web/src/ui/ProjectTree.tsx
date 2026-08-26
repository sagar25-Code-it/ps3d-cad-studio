import { useEffect, useRef, useState } from "react";
import { WORKBENCH_MCP_TOOLS } from "../../../../packages/workbench-mcp/src/index.js";
import { vehicleHardPoints, type WorkbenchProject } from "../../../../packages/workbench-core/src/index.js";
import type { DesignHealthReport } from "../../../../packages/workbench-health/src/index.js";
import { detectSketchProfiles } from "../../../../packages/workbench-sketch/src/index.js";
import { CapabilityBadge } from "./CapabilityBadge.js";
import { CommandIcon, inferCommandIcon } from "./CommandIcon.js";

interface ProjectTreeProps {
  readonly project: WorkbenchProject;
  readonly selectedId: string | null;
  readonly revealSelectionRequest: number;
  readonly designHealth: DesignHealthReport;
  readonly onSelect: (id: string | null) => void;
  readonly onContextMenu: (clientX: number, clientY: number, selectionId: string | null) => void;
}

type TreeKind = "project" | "health" | "datum" | "sketch" | "feature" | "body" | "component" | "mate" | "surface" | "drawing" | "electrical" | "vehicle" | "route" | "tool" | "history";

export function ProjectTree({ project, selectedId, revealSelectionRequest, designHealth, onSelect, onContextMenu }: ProjectTreeProps): React.JSX.Element {
  const treeRef = useRef<HTMLElement>(null);
  const handledRevealRequest = useRef(0);
  useEffect(() => {
    if (selectedId === null) return;
    const selectedItem = treeRef.current?.querySelector<HTMLElement>('.tree-item[aria-pressed="true"]');
    if (selectedItem === undefined || selectedItem === null) return;
    selectedItem.scrollIntoView({ block: "nearest" });
    if (revealSelectionRequest > handledRevealRequest.current) {
      handledRevealRequest.current = revealSelectionRequest;
      selectedItem.focus({ preventScroll: true });
    }
  }, [project.activeWorkspace, revealSelectionRequest, selectedId]);
  const showOrigin = true;
  const showSketch = true;
  const showPartHistory = true;
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
  const linkedOutline = project.sketch.entities.find((entity) => entity.kind === "rectangle" && !entity.construction && Math.abs(entity.widthMm - project.part.widthMm) < 1e-6 && Math.abs(entity.heightMm - project.part.heightMm) < 1e-6);
  const linkedBore = project.sketch.entities.find((entity) => entity.kind === "circle" && !entity.construction && Math.hypot(entity.center[0] - (linkedOutline?.kind === "rectangle" ? linkedOutline.center[0] : 0), entity.center[1] - (linkedOutline?.kind === "rectangle" ? linkedOutline.center[1] : 0)) < 0.01 && Math.abs(entity.radiusMm * 2 - project.part.holeDiameterMm) < 1e-6);
  const relationships = selectionRelationships(project, selectedId);
  return <aside ref={treeRef} className="project-tree" aria-label="Model browser and feature history" onContextMenu={(event) => {
    event.preventDefault();
    const id = (event.target as Element).closest<HTMLElement>("[data-tree-id]")?.dataset["treeId"] ?? null;
    if (id !== null) onSelect(id);
    onContextMenu(event.clientX, event.clientY, id);
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
    </TreeSection>}
    {showSketch && <TreeSection title={`Sketches · ${project.sketch.entities.length} entities · ${sketchProfiles.length} profiles`} badge="preview">
      <TreeItem kind="sketch" id={project.sketch.id} label={project.sketch.name} meta={`${project.sketch.constraints.length} constraints`} selectedId={selectedId} onSelect={onSelect} />
      {project.sketch.entities.map((entity) => <TreeItem key={entity.id} kind="sketch" id={entity.id} label={entityLabel(entity.kind)} meta={`${shortId(entity.id)} · ${entity.visible === false ? "hidden" : "shown"}`} selectedId={selectedId} onSelect={onSelect} indent />)}
      {sketchProfiles.map((profile, index) => <TreeItem key={profile.id} kind="sketch" id={profile.id} label={`Profile P${index + 1}`} meta={`${profile.boundary.kind.replaceAll("-", " ")} · ${formatArea(profile.areaMm2)} mm²`} selectedId={selectedId} onSelect={onSelect} indent />)}
    </TreeSection>}
    {showPartHistory && <TreeSection title="Feature history" badge="preview">
      <TreeItem kind="feature" id="feature:plate-extrusion" label="Base extrusion" meta={`${project.part.widthMm} × ${project.part.heightMm} × ${project.part.thicknessMm} mm · ${linkedOutline === undefined ? "parameter driven" : "sketch linked"}`} selectedId={selectedId} onSelect={onSelect} />
      <TreeItem kind="feature" id="feature:centered-through-hole" label="Centered bore" meta={`Ø${project.part.holeDiameterMm} mm · through all · ${linkedBore === undefined ? "parameter driven" : "sketch linked"}`} selectedId={selectedId} onSelect={onSelect} />
      <TreeItem kind="feature" id="feature:edge-treatment" label="Edge treatment" meta={`${project.part.edgeTreatmentMm} mm · preview`} selectedId={selectedId} onSelect={onSelect} />
      <TreeItem kind="feature" id="feature:linear-pattern" label="Linear pattern" meta={`${project.part.patternCount} instances · preview`} selectedId={selectedId} onSelect={onSelect} />
      <TreeItem kind="feature" id="feature:revolve-study" label="Revolve study" meta={`${project.part.revolveAngleDeg}° · preview`} selectedId={selectedId} onSelect={onSelect} />
    </TreeSection>}
    {showBodies && <TreeSection title="Bodies" badge={project.activeWorkspace === "part" ? "qualified" : "preview"}>
      <TreeItem kind="body" id="body:bracket" label="Mounting plate" meta="closed manifold mesh" selectedId={selectedId} onSelect={onSelect} />
      {(project.part.previewBodies ?? []).map((body) => <TreeItem key={body.id} kind="body" id={body.id} label={body.name} meta={`${body.shape} · ${body.visible ? "shown" : "hidden"} · preview`} selectedId={selectedId} onSelect={onSelect} indent />)}
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

function TreeSection({ title, badge, children, initiallyOpen = true }: { readonly title: string; readonly badge: "qualified" | "preview"; readonly children: React.ReactNode; readonly initiallyOpen?: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(initiallyOpen);
  return <details className="tree-section" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}><summary><span className="tree-chevron" aria-hidden="true">›</span><strong>{title}</strong><CapabilityBadge level={badge} /></summary><div>{children}</div></details>;
}

function TreeItem(props: { readonly kind: TreeKind; readonly id: string; readonly label: string; readonly meta: string; readonly selectedId: string | null; readonly onSelect: (id: string | null) => void; readonly indent?: boolean }): React.JSX.Element {
  const selected = props.selectedId === props.id;
  return <button data-tree-id={props.id} className={`tree-item ${selected ? "selected" : ""} ${props.indent === true ? "indent" : ""}`} aria-pressed={selected} onClick={() => props.onSelect(selected ? null : props.id)}><span className={`tree-glyph ${props.kind}`} aria-hidden="true"><CommandIcon name={treeIcon(props.kind, props.label, props.id)} /></span><span><strong>{props.label}</strong><small>{props.meta}</small></span></button>;
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

function selectionRelationships(project: WorkbenchProject, selectedId: string | null): readonly { readonly role: string; readonly id: string; readonly label: string; readonly meta: string; readonly kind: TreeKind }[] {
  if (selectedId === null) return [];
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
