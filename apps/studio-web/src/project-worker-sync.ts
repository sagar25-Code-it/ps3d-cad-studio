import {
  createBracketDocument,
  validateCadDocument,
  type CadDocument,
  type DisplayUnit,
  type ParameterKey,
  type UnitExpression
} from "../../../packages/model-schema/src/index.js";
import type { WorkbenchProject } from "../../../packages/workbench-core/src/index.js";

const QUALIFIED_PARAMETER_VALUES = [
  ["width", "widthMm"],
  ["height", "heightMm"],
  ["thickness", "thicknessMm"],
  ["holeDiameter", "holeDiameterMm"]
] as const satisfies readonly (readonly [ParameterKey, "widthMm" | "heightMm" | "thicknessMm" | "holeDiameterMm"])[];

/**
 * Builds one self-contained qualified-worker snapshot from the broad project.
 * A fresh journal prevents an opened project from inheriting stale undo state or
 * observing partially synchronized parameter commits from the previous project.
 */
export function createQualifiedPartDocument(
  project: WorkbenchProject,
  documentId: string,
  displayUnit: DisplayUnit = "mm"
): CadDocument {
  let document = createBracketDocument(documentId, displayUnit);
  for (const [parameterKey, projectKey] of QUALIFIED_PARAMETER_VALUES) {
    const valueMm = project.part[projectKey];
    const current = document.parameters.find((parameter) => parameter.key === parameterKey);
    if (current !== undefined && Math.abs(current.valueMeters * 1000 - valueMm) < 1e-9) continue;
    const expression: UnitExpression = { decimal: decimalMillimeters(valueMm), unit: "mm" };
    const parentRevision = document.revision;
    const revision = parentRevision + 1;
    const commandId = `command:project-sync-${parameterKey.toLocaleLowerCase()}-${revision}`;
    document = {
      ...document,
      revision,
      parentRevision,
      commandId,
      parameters: document.parameters.map((parameter) => parameter.key === parameterKey
        ? { ...parameter, expression, valueMeters: valueMm / 1000 }
        : parameter),
      commandJournal: [...document.commandJournal, {
        revision,
        parentRevision,
        commandId,
        kind: "set-parameter",
        parameterKey,
        expression
      }]
    };
  }
  const valid = validateCadDocument(document);
  if (!valid.ok) throw new Error(valid.diagnostics[0]?.message ?? "The broad project could not be converted into a qualified worker document.");
  return valid.value;
}

function decimalMillimeters(value: number): string {
  if (!Number.isFinite(value) || value <= 0) throw new TypeError("Qualified part dimensions must be finite positive millimetre values.");
  return value.toFixed(9).replace(/(?:\.0+|(\.\d*?[1-9])0+)$/u, "$1");
}
