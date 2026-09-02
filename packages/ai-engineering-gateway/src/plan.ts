import { sha256 } from "./canonical.js";
import type {
  CommandManifest,
  FeaturePlan,
  GatewayDiagnostic,
  PlanReadiness,
  PlanStepId
} from "./types.js";

const STABLE_ID = /^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9._-]*$/;
const FORBIDDEN_PARAMETER_NAMES = new Set(["meshcoordinates", "rawcoordinates", "vertexcoordinates", "triangleindices", "vertexarray", "trianglearray"]);

function issue(
  code: GatewayDiagnostic["code"],
  message: string,
  recovery: string,
  relatedIds: readonly string[] = [],
  severity: GatewayDiagnostic["severity"] = "error"
): GatewayDiagnostic {
  return { code, severity, message, relatedIds, recovery };
}

function orderSteps(plan: FeaturePlan): { readonly order: readonly PlanStepId[]; readonly cycle: readonly PlanStepId[] } {
  const steps = new Map(plan.steps.map((step) => [step.id, step]));
  const temporary = new Set<PlanStepId>();
  const permanent = new Set<PlanStepId>();
  const result: PlanStepId[] = [];
  const cycle: PlanStepId[] = [];
  const visit = (id: PlanStepId): void => {
    if (permanent.has(id) || cycle.length > 0) return;
    if (temporary.has(id)) {
      cycle.push(id);
      return;
    }
    const step = steps.get(id);
    if (!step) return;
    temporary.add(id);
    for (const dependency of step.dependsOn) visit(dependency);
    temporary.delete(id);
    permanent.add(id);
    result.push(id);
  };
  for (const step of plan.steps) visit(step.id);
  return { order: result, cycle };
}

export async function analyzeFeaturePlan(plan: FeaturePlan, manifest: CommandManifest): Promise<PlanReadiness> {
  const diagnostics: GatewayDiagnostic[] = [];
  const commandById = new Map(manifest.commands.map((command) => [command.id, command]));
  const stepIds = new Set<PlanStepId>();
  const resultIds = new Set<string>();

  if (plan.schemaVersion !== "ps3d-feature-plan/1" || !STABLE_ID.test(plan.id) || !STABLE_ID.test(plan.projectId)
    || !STABLE_ID.test(plan.targetComponentId) || !Number.isInteger(plan.baseRevision) || plan.baseRevision < 0) {
    diagnostics.push(issue("INVALID_PLAN", "The feature plan header is invalid.", "Use the advertised feature-plan schema and stable namespace-prefixed IDs.", [plan.id]));
  }
  if (plan.steps.length === 0) diagnostics.push(issue("INVALID_PLAN", "The feature plan contains no operations.", "Add at least one engineering-intent step."));

  for (const step of plan.steps) {
    if (!STABLE_ID.test(step.id) || stepIds.has(step.id)) diagnostics.push(issue(
      "INVALID_ID", `Plan step ID '${step.id}' is invalid or duplicated.`, "Use one unique 'plan-step:<stable-name>' ID per step.", [step.id]
    ));
    stepIds.add(step.id);
    const command = commandById.get(step.commandId);
    if (!command) diagnostics.push(issue("UNKNOWN_COMMAND", `Command '${step.commandId}' is absent from the manifest.`, "Read the current command manifest and re-plan.", [step.id, step.commandId]));
    else if (!command.intentKinds.includes(step.intent.kind) || command.workspace !== step.workspace) diagnostics.push(issue(
      "INVALID_PLAN", `Step '${step.id}' does not match command '${step.commandId}'.`, "Use an intent kind and workspace advertised by that command.", [step.id, step.commandId]
    ));
    for (const parameter of step.intent.parameters) {
      if (FORBIDDEN_PARAMETER_NAMES.has(parameter.name.replace(/[\s_-]/g, "").toLowerCase())) diagnostics.push(issue(
        "MESH_COORDINATE_BYPASS",
        `Parameter '${parameter.name}' attempts to bypass engineering intent with raw display/mesh data.`,
        "Reference stable CAD entities and provide dimensions, constraints, materials, fits, or other engineering parameters.",
        [step.id]
      ));
    }
    for (const reference of step.intent.references) {
      if (reference.documentId !== plan.projectId || reference.documentRevision !== plan.baseRevision || !STABLE_ID.test(reference.entityId)) diagnostics.push(issue(
        "INVALID_PLAN",
        `Reference '${reference.entityId}' is not bound to the plan's project and base revision.`,
        "Re-inspect the current document and create a stable reference at the exact base revision.",
        [step.id, reference.entityId]
      ));
    }
    for (const outputId of step.intent.resultEntityIds) {
      if (!STABLE_ID.test(outputId) || resultIds.has(outputId)) diagnostics.push(issue(
        "INVALID_ID", `Result entity ID '${outputId}' is invalid or duplicated.`, "Allocate a unique stable output entity ID.", [step.id, outputId]
      ));
      resultIds.add(outputId);
    }
  }

  for (const step of plan.steps) {
    for (const dependency of step.dependsOn) if (!stepIds.has(dependency)) diagnostics.push(issue(
      "INVALID_PLAN", `Step '${step.id}' depends on missing step '${dependency}'.`, "Repair the dependency graph before preview.", [step.id, dependency]
    ));
  }
  const ordering = orderSteps(plan);
  if (ordering.cycle.length > 0) diagnostics.push(issue(
    "DEPENDENCY_CYCLE", "The feature plan dependency graph contains a cycle.", "Break the cycle and preserve a deterministic feature order.", ordering.cycle
  ));

  for (const question of plan.questions) {
    if (question.blocksPreview && (!question.answer || question.answer.trim().length === 0)) diagnostics.push(issue(
      "AMBIGUITY_UNRESOLVED", question.prompt, question.whyRequired, [question.id, ...question.relatedStepIds]
    ));
  }
  for (const evidence of plan.standardsEvidence) {
    if (evidence.requiredForStepIds.length > 0 && (evidence.status !== "verified" || !evidence.sourceDigest)) diagnostics.push(issue(
      "EVIDENCE_UNVERIFIED",
      `Required evidence '${evidence.designation}' is not verified with a source digest.`,
      "Obtain the governing standard or drawing, verify its applicability, and record its immutable digest.",
      [evidence.id, ...evidence.requiredForStepIds]
    ));
  }

  const planDigest = await sha256(plan);
  return {
    readyForPreview: !diagnostics.some((entry) => entry.severity === "error"),
    planDigest,
    orderedStepIds: ordering.cycle.length === 0 ? ordering.order : [],
    diagnostics
  };
}
