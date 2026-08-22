import {
  WORKBENCH_CAPABILITIES,
  electricalSignature,
  validateWorkbenchProject,
  type CapabilityLevel,
  type WorkbenchProject,
  type WorkbenchResult,
  type WorkspaceId
} from "../../workbench-core/src/index.js";
import { analyzeWorkbenchSketch } from "../../workbench-sketch/src/index.js";
import { buildSurfacePreview, findAssemblyInterference } from "../../workbench-geometry/src/index.js";
import { createAutomaticDrawingPlan } from "../../workbench-drawing/src/index.js";
import { createElectricalSchematic } from "../../workbench-electrical/src/index.js";
import { buildVehiclePreview } from "../../workbench-vehicle/src/index.js";

export type DesignHealthStatus = "healthy" | "review" | "blocked";
export type DesignHealthSeverity = "info" | "warning" | "error";
export type AssociativityMode = "associative" | "trace-linked" | "snapshot" | "detached";
export type DependencyStatus = "current" | "stale" | "detached";

export interface DesignHealthFinding {
  readonly id: string;
  readonly workspace: WorkspaceId;
  readonly severity: DesignHealthSeverity;
  readonly title: string;
  readonly message: string;
  readonly recovery: string;
  readonly relatedIds: readonly string[];
  readonly evidence: string;
}

export interface WorkspaceHealthRecord {
  readonly workspace: WorkspaceId;
  readonly label: string;
  readonly status: DesignHealthStatus;
  readonly score: number;
  readonly lastChangedRevision: number;
  readonly findingIds: readonly string[];
  readonly capabilityCounts: Readonly<Record<CapabilityLevel, number>>;
  readonly metrics: Readonly<Record<string, string | number | boolean>>;
}

export interface WorkbenchDependencyRecord {
  readonly id: string;
  readonly from: WorkspaceId;
  readonly to: WorkspaceId;
  readonly mode: AssociativityMode;
  readonly status: DependencyStatus;
  readonly label: string;
  readonly detail: string;
}

export interface DesignHealthReport {
  readonly schema: "ps3d-design-health/1";
  readonly projectId: string;
  readonly projectRevision: number;
  readonly generatedFrom: "deterministic-caller-supplied-project";
  readonly overallStatus: DesignHealthStatus;
  readonly score: number;
  readonly errors: number;
  readonly warnings: number;
  readonly information: number;
  readonly workspaces: readonly WorkspaceHealthRecord[];
  readonly dependencies: readonly WorkbenchDependencyRecord[];
  readonly rebuildOrder: readonly WorkspaceId[];
  readonly findings: readonly DesignHealthFinding[];
  readonly releaseBoundary: string;
}

const WORKSPACES: readonly WorkspaceId[] = ["sketch", "part", "surface", "electrical", "assembly", "vehicle", "drawing", "automate"];
const WORKSPACE_LABELS: Readonly<Record<WorkspaceId, string>> = {
  sketch: "Sketch",
  part: "Part",
  assembly: "Assembly",
  surface: "Surface",
  drawing: "Drawing",
  electrical: "Electrical",
  vehicle: "Vehicle",
  automate: "Automate"
};

export function analyzeDesignHealth(input: unknown): WorkbenchResult<DesignHealthReport> {
  const valid = validateWorkbenchProject(input);
  if (!valid.ok) return valid;
  return { ok: true, value: buildDesignHealthReport(valid.value) };
}

export function buildDesignHealthReport(project: WorkbenchProject): DesignHealthReport {
  const findings: DesignHealthFinding[] = [];
  const add = (finding: DesignHealthFinding): void => { findings.push(finding); };

  const sketch = analyzeWorkbenchSketch(project.sketch);
  if (project.sketch.entities.length === 0) add(finding("health:sketch-empty", "sketch", "error", "Sketch has no geometry", "The primary sketch cannot communicate a profile without entities.", "Create bounded sketch entities before treating the profile as design intent.", [project.sketch.id], "0 entities"));
  else if (sketch.classification === "conflict") add(finding("health:sketch-conflict", "sketch", "error", "Sketch constraint conflict", `${sketch.conflicts.length} constraint conflict${sketch.conflicts.length === 1 ? "" : "s"} were detected.`, "Resolve the reported constraint conflicts before relying on sketch dimensions.", [project.sketch.id], sketch.conflicts.join(" | ")));
  else if (sketch.classification === "underconstrained") add(finding("health:sketch-underconstrained", "sketch", "warning", "Sketch is underconstrained", `${sketch.degreesOfFreedom} estimated degree${sketch.degreesOfFreedom === 1 ? "" : "s"} of freedom remain.`, "Add only the dimensions and geometric constraints required to preserve design intent.", [project.sketch.id], `${sketch.appliedConstraints} applied constraints`));
  else add(finding("health:sketch-constrained", "sketch", "info", "Sketch constraint state is closed", "The bounded solver estimates zero remaining degrees of freedom.", "Continue to review constraint intent after topology edits.", [project.sketch.id], `${sketch.appliedConstraints} applied constraints`));

  add(finding("health:part-kernel-boundary", "part", "info", "Qualified solid slice is bounded", "The centered-bore plate is worker-validated; pattern, revolve, edge-treatment, and exact B-rep behavior remain preview-scoped.", "Use the capability labels and export a neutral tessellated reference until an exact kernel is separately qualified.", [project.part.id], `${project.part.widthMm} × ${project.part.heightMm} × ${project.part.thicknessMm} mm`));

  const interferences = findAssemblyInterference(project.assembly);
  const conflictingMates = project.assembly.mates.filter((mate) => mate.status === "conflict");
  const redundantMates = project.assembly.mates.filter((mate) => mate.status === "redundant");
  if (project.assembly.components.length === 0) add(finding("health:assembly-empty", "assembly", "error", "Assembly has no components", "No component instance is available for assembly review.", "Insert a bounded component or apply a reviewed template.", [project.assembly.id], "0 components"));
  if (conflictingMates.length > 0) add(finding("health:assembly-mate-conflict", "assembly", "error", "Assembly mate conflict", `${conflictingMates.length} mate${conflictingMates.length === 1 ? " is" : "s are"} marked as conflicting.`, "Repair or remove conflicting mates before using the component positions downstream.", conflictingMates.map((mate) => mate.id), conflictingMates.map((mate) => mate.name).join(" | ")));
  if (redundantMates.length > 0) add(finding("health:assembly-mate-redundant", "assembly", "warning", "Assembly contains redundant mates", `${redundantMates.length} mate${redundantMates.length === 1 ? " is" : "s are"} redundant.`, "Remove redundant relationships or document why they are intentionally retained.", redundantMates.map((mate) => mate.id), redundantMates.map((mate) => mate.name).join(" | ")));
  if (project.assembly.components.length > 0 && project.assembly.components.every((component) => !component.grounded)) add(finding("health:assembly-floating", "assembly", "warning", "Assembly has no grounded component", "Every visible component remains free in the bounded assembly intent.", "Ground one base component or add a reviewed fixed relationship.", project.assembly.components.map((component) => component.id), `${project.assembly.components.length} ungrounded components`));
  if (interferences.length > 0) add(finding("health:assembly-interference", "assembly", "warning", "Conservative interference candidates", `${interferences.length} axis-aligned overlap candidate${interferences.length === 1 ? "" : "s"} require review.`, "Inspect the reported component pairs; this preview is conservative and is not exact collision validation.", [...new Set(interferences.flatMap((candidate) => candidate.componentIds))], `${Math.round(interferences.reduce((sum, candidate) => sum + candidate.volumeCubicMm, 0))} mm³ conservative overlap`));

  const surface = buildSurfacePreview(project.surface);
  if (surface.metrics.approximateAreaSquareMm <= 0 || surface.metrics.triangles === 0) add(finding("health:surface-degenerate", "surface", "error", "Surface tessellation is degenerate", "The current surface does not produce a usable tessellated patch.", "Increase the bounded dimensions and segment counts before downstream use.", [project.surface.id], `${surface.metrics.triangles} triangles`));
  else if (project.surface.uSegments < 12 || project.surface.vSegments < 12 || surface.metrics.maximumNormalVariationDeg > 75) add(finding("health:surface-resolution", "surface", "warning", "Surface requires visual-quality review", "The patch is coarse or has high normal variation for a presentation-quality surface.", "Increase U/V segmentation or reduce crown and twist while checking the shape visually.", [project.surface.id], `${project.surface.uSegments} × ${project.surface.vSegments} segments · ${round(surface.metrics.maximumNormalVariationDeg)}° max normal variation`));
  add(finding("health:surface-open-boundary", "surface", "info", "Surface remains an open tessellated patch", "The current surface is not a trimmed, stitched, watertight, or exact NURBS body.", "Use it as a design-study surface only until an exact surfacing kernel is qualified.", [project.surface.id], `${surface.metrics.boundaryEdges} boundary edges · ${surface.metrics.triangles} triangles`));

  const drawing = createAutomaticDrawingPlan(project.part, project.drawing);
  if (drawing.views.length < 3) add(finding("health:drawing-view-coverage", "drawing", "warning", "Drawing view coverage is limited", "Fewer than three orthographic views are present on the current sheet.", "Select the automatic four-view or orthographic three-view preset when additional views are necessary.", [project.drawing.id], `${drawing.views.length} views`));
  if (project.drawing.showDimensions !== true) add(finding("health:drawing-dimensions-hidden", "drawing", "warning", "Drawing dimensions are hidden", "The generated sheet contains no selected model dimensions.", "Enable dimensions and review every displayed value and tolerance before release.", [project.drawing.id], "dimensions disabled"));
  if ((project.drawing.showGdt ?? false) && (project.drawing.datumScheme ?? "none") === "none") add(finding("health:drawing-gdt-datum", "drawing", "warning", "GD&T has no datum scheme", "Geometric controls are enabled without an explicit datum reference frame.", "Choose the bounded 3-2-1 datum scheme or disable datum-dependent controls.", [project.drawing.id], `${drawing.gdtFrames.length} GD&T frames`));
  const linearTolerance = project.drawing.generalToleranceLinearMm ?? 0.2;
  if (linearTolerance >= project.part.thicknessMm / 2) add(finding("health:drawing-tolerance-scale", "drawing", "warning", "General tolerance is large relative to thickness", "The sheet-wide linear tolerance is at least half of the current part thickness.", "Review functional intent and apply explicit feature tolerances where the general value is inappropriate.", [project.drawing.id, project.part.id], `±${linearTolerance} mm general · ${project.part.thicknessMm} mm thickness`));

  const electrical = createElectricalSchematic(project.electrical);
  for (const issue of electrical.erc.issues) add(finding(`health:${issue.id}`, "electrical", issue.severity, issue.severity === "error" ? "Electrical rule error" : "Electrical rule review", issue.message, issue.recovery, issue.relatedIds, `${project.electrical.standard} structural ERC`));
  if (electrical.physicalization.status === "blocked") add(finding("health:electrical-physicalization", "electrical", "warning", "Circuit-to-3D realization is blocked", `${electrical.physicalization.blockingErrors.length} readiness condition${electrical.physicalization.blockingErrors.length === 1 ? "" : "s"} prevent a reviewed generic mounting-plate candidate.`, "Resolve ERC, mapping, or route-plan findings before generating a new physical candidate.", [project.electrical.id], electrical.physicalization.blockingErrors.join(" | ")));
  if (project.assembly.electromechanicalSource?.status === "stale") add(finding("health:electrical-assembly-stale", "assembly", "warning", "ECAD-to-MCAD trace is stale", "The physical assembly records an earlier schematic signature.", "Review and regenerate the complete mounting-plate candidate; do not silently patch individual packages.", [project.electrical.id, project.assembly.id], project.assembly.electromechanicalSource.electricalSignature));

  const vehicle = buildVehiclePreview(project.vehicle);
  if (vehicle.analysis.errors.length > 0 || vehicle.geometry.errors.length > 0) add(finding("health:vehicle-blocked", "vehicle", "error", "Vehicle engineering analysis is blocked", "The current hardpoint or calculation model contains blocking errors.", "Resolve the reported geometry and input conditions before interpreting calculated values.", [project.vehicle.id], [...vehicle.geometry.errors, ...vehicle.analysis.errors].join(" | ")));
  if (vehicle.analysis.warnings.length > 0) add(finding("health:vehicle-review", "vehicle", "warning", "Vehicle calculations require review", `${vehicle.analysis.warnings.length} model warning${vehicle.analysis.warnings.length === 1 ? "" : "s"} remain.`, "Review hardpoints, supplier inputs, assumptions, and state selection with a qualified vehicle engineer.", [project.vehicle.id], vehicle.analysis.warnings.slice(0, 6).join(" | ")));
  if (project.vehicle.inputStatus !== "user-reviewed" || project.vehicle.tireDataStatus !== "supplier-reviewed" || project.vehicle.brakeDataStatus !== "supplier-reviewed") add(finding("health:vehicle-evidence", "vehicle", "warning", "Vehicle evidence is not release-ready", "Geometry inputs, tire data, or brake data have not all been marked reviewed.", "Correlate project inputs to controlled supplier evidence and independent engineering review.", [project.vehicle.id], `${project.vehicle.inputStatus} · ${project.vehicle.tireDataStatus} · ${project.vehicle.brakeDataStatus}`));

  if (project.audit.length >= 450) add(finding("health:automation-audit-capacity", "automate", "warning", "Revision audit is nearing its bounded limit", `${project.audit.length} of 500 audit entries are in use.`, "Export a controlled checkpoint and start a reviewed compacted lineage before reaching the limit.", [project.id], `${project.audit.length}/500 entries`));
  else add(finding("health:automation-contract", "automate", "info", "AI collaboration remains caller-controlled", "AI tools inspect caller-supplied state and return immutable candidates; they do not control the open browser project automatically.", "Continue using inspect, preview, explicit confirmation, and returned-project import boundaries.", [project.id], `${project.audit.length} recorded operations`));

  const dependencies = buildDependencies(project);
  for (const dependency of dependencies.filter((record) => record.status === "detached")) add(finding(`health:${dependency.id}`, dependency.to, "info", `${WORKSPACE_LABELS[dependency.from]} → ${WORKSPACE_LABELS[dependency.to]} is detached`, dependency.detail, "Treat changes as independent until a future explicit associative contract is implemented and qualified.", [], dependency.label));

  const workspaces = WORKSPACES.map((workspace) => workspaceHealth(project, workspace, findings, metricsFor(workspace, project, { sketch, interferences, surface, drawing, electrical, vehicle })));
  const errors = findings.filter((item) => item.severity === "error").length;
  const warnings = findings.filter((item) => item.severity === "warning").length;
  const information = findings.length - errors - warnings;
  const score = Math.round(workspaces.reduce((sum, item) => sum + item.score, 0) / workspaces.length);
  const overallStatus: DesignHealthStatus = workspaces.some((item) => item.status === "blocked") ? "blocked" : workspaces.some((item) => item.status === "review") ? "review" : "healthy";
  return {
    schema: "ps3d-design-health/1",
    projectId: project.id,
    projectRevision: project.revision,
    generatedFrom: "deterministic-caller-supplied-project",
    overallStatus,
    score,
    errors,
    warnings,
    information,
    workspaces,
    dependencies,
    rebuildOrder: WORKSPACES,
    findings,
    releaseBoundary: "Design health is deterministic assistance, not a solver certificate, manufacturing release, code-compliance result, roadworthiness approval, or substitute for qualified engineering review."
  };
}

function buildDependencies(project: WorkbenchProject): readonly WorkbenchDependencyRecord[] {
  const source = project.assembly.electromechanicalSource;
  const electricalCurrent = source !== undefined && source.status === "current" && source.electricalSignature === electricalSignature(project.electrical);
  const records: WorkbenchDependencyRecord[] = [
    dependency("dependency:sketch-part", "sketch", "part", "detached", "detached", "Independent intent", "The current Part parameters are not regenerated from Sketch geometry."),
    dependency("dependency:part-drawing", "part", "drawing", "associative", "current", "Associative drawing source", "Drawing views and selected dimensions are regenerated from the current Part intent."),
    dependency("dependency:surface-drawing", "surface", "drawing", "detached", "detached", "Surface not on drawing", "The Drawing generator does not currently consume Surface geometry."),
    dependency("dependency:assembly-drawing", "assembly", "drawing", "detached", "detached", "Assembly not on drawing", "The Drawing generator does not currently create assembly views, balloons, or a parts list."),
    dependency("dependency:vehicle-drawing", "vehicle", "drawing", "detached", "detached", "Vehicle not on drawing", "Vehicle hardpoints and geometry are not currently projected onto a drawing sheet."),
    dependency("dependency:sketch-automate", "sketch", "automate", "snapshot", "current", "Caller-supplied snapshot", "AI tools receive the complete validated project snapshot supplied by the caller."),
    dependency("dependency:drawing-automate", "drawing", "automate", "snapshot", "current", "Caller-supplied snapshot", "AI tools receive current drawing settings as structured project state."),
    dependency("dependency:vehicle-automate", "vehicle", "automate", "snapshot", "current", "Caller-supplied snapshot", "AI vehicle analysis reads the current validated Vehicle intent without mutating it.")
  ];
  records.push(source === undefined
    ? dependency("dependency:electrical-assembly", "electrical", "assembly", "detached", "detached", "No physical trace", "No reviewed circuit-to-3D candidate has been applied to the Assembly.")
    : dependency("dependency:electrical-assembly", "electrical", "assembly", "trace-linked", electricalCurrent ? "current" : "stale", "ECAD ↔ MCAD trace", electricalCurrent ? "The Assembly records the current schematic signature and generic catalog revision." : "The Assembly source record does not match the current schematic signature."));
  return records;
}

function dependency(id: string, from: WorkspaceId, to: WorkspaceId, mode: AssociativityMode, status: DependencyStatus, label: string, detail: string): WorkbenchDependencyRecord {
  return { id, from, to, mode, status, label, detail };
}

function workspaceHealth(
  project: WorkbenchProject,
  workspace: WorkspaceId,
  findings: readonly DesignHealthFinding[],
  metrics: Readonly<Record<string, string | number | boolean>>
): WorkspaceHealthRecord {
  const scoped = findings.filter((finding) => finding.workspace === workspace);
  const errors = scoped.filter((finding) => finding.severity === "error").length;
  const warnings = scoped.filter((finding) => finding.severity === "warning").length;
  const status: DesignHealthStatus = errors > 0 ? "blocked" : warnings > 0 ? "review" : "healthy";
  const score = Math.max(0, 100 - errors * 24 - warnings * 7);
  const capabilities = WORKBENCH_CAPABILITIES.filter((record) => record.workspace === workspace);
  return {
    workspace,
    label: WORKSPACE_LABELS[workspace],
    status,
    score,
    lastChangedRevision: lastChangedRevision(project, workspace),
    findingIds: scoped.map((finding) => finding.id),
    capabilityCounts: {
      qualified: capabilities.filter((record) => record.level === "qualified").length,
      preview: capabilities.filter((record) => record.level === "preview").length,
      unavailable: capabilities.filter((record) => record.level === "unavailable").length
    },
    metrics
  };
}

function metricsFor(
  workspace: WorkspaceId,
  project: WorkbenchProject,
  derived: {
    readonly sketch: ReturnType<typeof analyzeWorkbenchSketch>;
    readonly interferences: ReturnType<typeof findAssemblyInterference>;
    readonly surface: ReturnType<typeof buildSurfacePreview>;
    readonly drawing: ReturnType<typeof createAutomaticDrawingPlan>;
    readonly electrical: ReturnType<typeof createElectricalSchematic>;
    readonly vehicle: ReturnType<typeof buildVehiclePreview>;
  }
): Readonly<Record<string, string | number | boolean>> {
  switch (workspace) {
    case "sketch": return { entities: project.sketch.entities.length, constraints: project.sketch.constraints.length, degreesOfFreedom: derived.sketch.degreesOfFreedom, classification: derived.sketch.classification };
    case "part": return { widthMm: project.part.widthMm, heightMm: project.part.heightMm, thicknessMm: project.part.thicknessMm, holeDiameterMm: project.part.holeDiameterMm };
    case "assembly": return { components: project.assembly.components.length, mates: project.assembly.mates.length, interferences: derived.interferences.length, ecadTrace: project.assembly.electromechanicalSource?.status ?? "none" };
    case "surface": return { mode: project.surface.mode, triangles: derived.surface.metrics.triangles, areaSquareMm: round(derived.surface.metrics.approximateAreaSquareMm), boundaryEdges: derived.surface.metrics.boundaryEdges };
    case "drawing": return { views: derived.drawing.views.length, dimensions: derived.drawing.dimensions.length, gdtFrames: derived.drawing.gdtFrames.length, draftingStandard: derived.drawing.draftingStandard };
    case "electrical": return { components: derived.electrical.componentCount, nets: derived.electrical.netCount, ercStatus: derived.electrical.erc.status, ercErrors: derived.electrical.erc.errors, ercWarnings: derived.electrical.erc.warnings };
    case "vehicle": return { template: project.vehicle.template, state: project.vehicle.state, hardpoints: derived.vehicle.geometry.hardpoints.length, geometryChecks: derived.vehicle.geometry.checks.length, analysisStatus: derived.vehicle.analysis.status };
    case "automate": return { revision: project.revision, auditEntries: project.audit.length, stateOwnership: "caller" };
  }
}

function lastChangedRevision(project: WorkbenchProject, workspace: WorkspaceId): number {
  const prefixes: Readonly<Record<WorkspaceId, readonly string[]>> = {
    sketch: ["sketch:", "constraint:"], part: ["part:", "feature:"], assembly: ["assembly:", "component:", "mate:", "electromechanical:"],
    surface: ["surface:"], drawing: ["drawing:"], electrical: ["electrical:", "net:"], vehicle: ["vehicle:"], automate: ["automation:", "mcp:"]
  };
  const match = [...project.audit].reverse().find((entry) => entry.changedIds.some((id) => prefixes[workspace].some((prefix) => id.startsWith(prefix))) || entry.kind.includes(workspace));
  return match?.revision ?? 0;
}

function finding(id: string, workspace: WorkspaceId, severity: DesignHealthSeverity, title: string, message: string, recovery: string, relatedIds: readonly string[], evidence: string): DesignHealthFinding {
  return { id, workspace, severity, title, message, recovery, relatedIds, evidence };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
