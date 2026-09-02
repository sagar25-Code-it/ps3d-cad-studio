import type { FeatureKind } from "@ps3d/cad-document-core/src/index.js";
import type { ExactKernelOperationKind } from "@ps3d/exact-kernel-api/src/index.js";
import type {
  EngineDiagnostic,
  FeatureOperationMapper,
  FeatureOperationMapping,
  OperationTableEntry
} from "./types.js";

const FEATURE_OPERATION_KINDS: Readonly<Partial<Record<FeatureKind, ExactKernelOperationKind>>> = Object.freeze({
  extrude: "solid.extrude",
  revolve: "solid.revolve",
  sweep: "solid.sweep",
  loft: "solid.loft",
  hole: "solid.hole",
  thread: "solid.thread",
  fillet: "solid.fillet",
  chamfer: "solid.chamfer",
  draft: "solid.draft",
  shell: "solid.shell",
  rib: "solid.rib",
  "thin-extrude": "solid.thin-extrude",
  boolean: "solid.boolean",
  "linear-pattern": "solid.pattern-linear",
  "circular-pattern": "solid.pattern-circular",
  "path-pattern": "solid.pattern-path",
  mirror: "solid.mirror",
  "construction-plane": "construct.plane",
  "construction-axis": "construct.axis",
  "construction-point": "construct.point",
  "move-face": "direct.move-face",
  "offset-face": "direct.offset-face",
  "replace-face": "direct.replace-face",
  "delete-face": "direct.delete-face",
  "surface-extrude": "surface.extrude",
  "surface-revolve": "surface.revolve",
  "surface-sweep": "surface.sweep",
  "surface-loft": "surface.loft",
  "surface-patch": "surface.patch",
  "surface-offset": "surface.offset",
  "surface-trim": "surface.trim",
  "surface-extend": "surface.extend",
  "surface-stitch": "surface.stitch",
  "surface-thicken": "surface.thicken",
  "imported-base": "exchange.import"
});

export function expectedKernelOperationKind(featureKind: FeatureKind): ExactKernelOperationKind | null {
  return FEATURE_OPERATION_KINDS[featureKind] ?? null;
}

export function createFeatureOperationTableMapper(entries: readonly OperationTableEntry[]): FeatureOperationMapper {
  const table = new Map(entries.map((entry) => [entry.featureId, entry.factory] as const));
  if (table.size !== entries.length) throw new TypeError("Feature operation table contains a duplicate feature ID.");
  return {
    async map(context): Promise<FeatureOperationMapping> {
      const factory = table.get(context.feature.id);
      if (factory === undefined) {
        return {
          status: "unsupported",
          diagnostics: [engineMappingDiagnostic(
            "FEATURE_UNSUPPORTED",
            `No exact operation is registered for feature ${context.feature.id}.`,
            [context.feature.id],
            "Register a deterministic operation factory after the feature parameters and references are fully resolved."
          )]
        };
      }
      return { status: "mapped", operation: await factory(context) };
    }
  };
}

export function validateFeatureOperationMapping(
  featureKind: FeatureKind,
  featureId: string,
  outputBodyIds: readonly string[],
  operation: { readonly operationId: string; readonly kind: ExactKernelOperationKind; readonly semanticOutputIds: readonly string[]; readonly expectedOutputCount: number }
): readonly EngineDiagnostic[] {
  const diagnostics: EngineDiagnostic[] = [];
  const expectedKind = expectedKernelOperationKind(featureKind);
  if (expectedKind === null) diagnostics.push(engineMappingDiagnostic(
    "FEATURE_UNSUPPORTED",
    `Feature kind '${featureKind}' has no exact-kernel contract.`,
    [featureId],
    "Add a reviewed feature-kind contract before enabling this feature."
  ));
  else if (operation.kind !== expectedKind) diagnostics.push(engineMappingDiagnostic(
    "FEATURE_MAPPING_INVALID",
    `Feature kind '${featureKind}' mapped to '${operation.kind}', expected '${expectedKind}'.`,
    [featureId],
    "Correct the operation mapper; do not reinterpret feature semantics at runtime."
  ));
  if (operation.operationId !== featureId) diagnostics.push(engineMappingDiagnostic(
    "FEATURE_MAPPING_INVALID",
    "The exact operation ID does not equal its stable feature ID.",
    [featureId, operation.operationId],
    "Use the canonical feature ID as the exact operation ID."
  ));
  if (operation.expectedOutputCount !== outputBodyIds.length
    || !sameStrings(operation.semanticOutputIds, outputBodyIds)) diagnostics.push(engineMappingDiagnostic(
    "FEATURE_MAPPING_INVALID",
    "The exact operation output contract does not match the canonical feature outputs.",
    [featureId, ...outputBodyIds],
    "Declare one semantic output per canonical output body in stable body order."
  ));
  return diagnostics;
}

function sameStrings(first: readonly string[], second: readonly string[]): boolean {
  return first.length === second.length && first.every((value, index) => value === second[index]);
}

function engineMappingDiagnostic(
  code: "FEATURE_MAPPING_INVALID" | "FEATURE_UNSUPPORTED",
  message: string,
  relatedIds: readonly string[],
  recovery: string
): EngineDiagnostic {
  return { code, severity: "error", stage: "mapping", message, relatedIds, recovery, sourceCodes: [] };
}
