import { deepFreeze, sha256 } from "./canonical.js";
import type {
  AdapterCommandMapping,
  AdapterTarget,
  AdapterTargetDefinition,
  AdapterTranslationPlan,
  AdapterTranslationStep,
  FeaturePlan,
  GatewayDiagnostic,
  GeneratedAdapterArtifact
} from "./types.js";

export const ADAPTER_TARGET_DEFINITIONS: Readonly<Record<AdapterTarget, AdapterTargetDefinition>> = deepFreeze({
  "fusion-360-python": { id: "fusion-360-python", host: "Fusion 360", apiFamily: "Fusion 360 API", language: "Python", nativeFilePreservationClaim: false },
  "nxopen-python": { id: "nxopen-python", host: "NX", apiFamily: "NX/Open", language: "Python", nativeFilePreservationClaim: false },
  "nxopen-csharp": { id: "nxopen-csharp", host: "NX", apiFamily: "NX/Open", language: "C#", nativeFilePreservationClaim: false },
  "solidworks-vba": { id: "solidworks-vba", host: "SOLIDWORKS", apiFamily: "SOLIDWORKS API", language: "VBA", nativeFilePreservationClaim: false },
  "solidworks-csharp": { id: "solidworks-csharp", host: "SOLIDWORKS", apiFamily: "SOLIDWORKS API", language: "C#", nativeFilePreservationClaim: false },
  "creo-toolkit-cpp": { id: "creo-toolkit-cpp", host: "Creo", apiFamily: "Creo TOOLKIT", language: "C++", nativeFilePreservationClaim: false },
  "creo-jlink-java": { id: "creo-jlink-java", host: "Creo", apiFamily: "J-Link", language: "Java", nativeFilePreservationClaim: false },
  "catia-v5-vba": { id: "catia-v5-vba", host: "CATIA V5", apiFamily: "CATIA V5 Automation", language: "VBA", nativeFilePreservationClaim: false }
});

function gap(stepId: string, commandId: string, target: AdapterTarget): GatewayDiagnostic {
  return {
    code: "ADAPTER_MAPPING_GAP",
    severity: "error",
    message: `No reviewed ${target} mapping exists for '${commandId}'.`,
    relatedIds: [stepId, commandId],
    recovery: "Add and review an explicit host API mapping; do not infer or execute an unreviewed call."
  };
}

export async function createAdapterTranslationPlan(input: {
  readonly featurePlan: FeaturePlan;
  readonly featurePlanDigest?: string;
  readonly target: AdapterTarget;
  readonly mappings: readonly AdapterCommandMapping[];
}): Promise<AdapterTranslationPlan> {
  const featurePlanDigest = input.featurePlanDigest ?? await sha256(input.featurePlan);
  const mappingByCommand = new Map(
    input.mappings.filter((mapping) => mapping.target === input.target).map((mapping) => [mapping.commandId, mapping])
  );
  const diagnostics: GatewayDiagnostic[] = [];
  const steps: AdapterTranslationStep[] = input.featurePlan.steps.map((step) => {
    const mapping = mappingByCommand.get(step.commandId);
    if (!mapping) {
      diagnostics.push(gap(step.id, step.commandId, input.target));
      return { planStepId: step.id, commandId: step.commandId, hostOperation: null, status: "mapping-gap", limitations: [] };
    }
    return {
      planStepId: step.id,
      commandId: step.commandId,
      hostOperation: mapping.hostOperation,
      status: "mapped",
      limitations: mapping.limitations
    };
  });
  diagnostics.push({
    code: "HOST_VALIDATION_REQUIRED",
    severity: "warning",
    message: "This is an API translation plan, not a target-CAD-validated script.",
    relatedIds: [input.featurePlan.id, input.target],
    recovery: "Generate in an isolated test project, run in the declared host/version, inspect the feature tree and geometry, then attach validation evidence."
  });
  const content = {
    schemaVersion: "ps3d-adapter-translation-plan/1" as const,
    id: `adapter-plan:${input.target}:${featurePlanDigest.slice(0, 24)}`,
    target: input.target,
    targetDefinition: ADAPTER_TARGET_DEFINITIONS[input.target],
    featurePlanId: input.featurePlan.id,
    featurePlanDigest,
    status: "translation-plan-unvalidated" as const,
    hostValidationRequired: true as const,
    scriptExecutionAllowed: false as const,
    steps,
    diagnostics,
    validationChecklist: [
      "Run only in a disposable target-CAD test document.",
      "Confirm target CAD version, API family, units, templates, and locale.",
      "Verify feature order, stable parent/child ownership, dimensions, constraints, and body/component count.",
      "Regenerate after editing at least one driving dimension and inspect dependent features.",
      "Compare mass properties, bounding dimensions, joint state, and drawing updates against the PS3D plan.",
      "Record test-project and result digests before promoting the artifact."
    ]
  };
  return deepFreeze({ ...content, translationPlanDigest: await sha256(content) });
}

const extensionFor: Readonly<Record<AdapterTarget, string>> = {
  "fusion-360-python": ".py",
  "nxopen-python": ".py",
  "nxopen-csharp": ".cs",
  "solidworks-vba": ".bas",
  "solidworks-csharp": ".cs",
  "creo-toolkit-cpp": ".cpp",
  "creo-jlink-java": ".java",
  "catia-v5-vba": ".catvba"
};

export async function registerGeneratedAdapterArtifact(input: {
  readonly translationPlan: AdapterTranslationPlan;
  readonly baseFileName: string;
  readonly generatedContent: string;
}): Promise<GeneratedAdapterArtifact> {
  const safeName = input.baseFileName.replace(/[^a-zA-Z0-9._-]/g, "-").replace(/\.+$/g, "") || "ps3d-adapter";
  return deepFreeze({
    schemaVersion: "ps3d-generated-adapter/1",
    translationPlanDigest: input.translationPlan.translationPlanDigest,
    target: input.translationPlan.target,
    fileName: safeName.endsWith(extensionFor[input.translationPlan.target]) ? safeName : `${safeName}${extensionFor[input.translationPlan.target]}`,
    contentDigest: await sha256(input.generatedContent),
    status: "generated-unvalidated",
    hostValidationRequired: true
  });
}

export function recordAdapterHostValidation(
  artifact: GeneratedAdapterArtifact,
  evidence: NonNullable<GeneratedAdapterArtifact["validationEvidence"]>
): GeneratedAdapterArtifact {
  if (artifact.status !== "generated-unvalidated" || !artifact.hostValidationRequired) throw new Error("Only an unvalidated generated artifact can receive first host-validation evidence.");
  if (!evidence.hostVersion || !evidence.testProjectDigest || !evidence.resultDigest || !evidence.validatedBy || !evidence.validatedAt) {
    throw new Error("Host-validation evidence is incomplete.");
  }
  return deepFreeze({
    ...artifact,
    status: "host-validated",
    hostValidationRequired: false,
    validationEvidence: evidence
  });
}
