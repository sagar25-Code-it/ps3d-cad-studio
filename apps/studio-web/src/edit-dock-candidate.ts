import type { DesignSolidFeature, WorkbenchProject } from "../../../packages/workbench-core/src/index.js";
import { applyParameterValues, applyPlainSize, parameterFieldsOf, type ParameterResult } from "./feature-parameters.js";

/**
 * The step the Edit Feature dock would apply with its form as it stands. The dock's Update button and the live preview both ask
 * this one function, so the ghost in the view is built from exactly what Update would record, with the same parsing, limits and
 * expression binding. Undefined: the step has no numbers to edit, so there is nothing to apply or to preview.
 */
export interface DockForm {
  readonly value: string;
  readonly direction: NonNullable<DesignSolidFeature["direction"]>;
  readonly second: string;
  readonly extent: NonNullable<DesignSolidFeature["extent"]>;
  readonly thin: boolean;
  readonly thinWall: string;
  readonly thinSide: NonNullable<DesignSolidFeature["thinSide"]>;
  readonly operation: "join" | "cut" | "intersect";
  readonly values: Readonly<Record<string, string>>;
}

export function dockCandidate(feature: DesignSolidFeature, form: DockForm, project: WorkbenchProject): ParameterResult | undefined {
  if (parameterFieldsOf(feature) !== undefined) return applyParameterValues(feature, form.values, project);
  if (feature.kind !== "extrude" && feature.kind !== "revolve") return undefined;
  const isExtrude = feature.kind === "extrude";
  // A join, cut or intersect step can switch between them; a step that makes a body of its own has no target to switch to.
  const cuts = feature.operation === "cut";
  const switchable = feature.operation === "join" || feature.operation === "cut" || feature.operation === "intersect";
  const isCut = isExtrude && (switchable ? form.operation === "cut" : cuts);
  const throughAll = isCut && form.extent === "through-all";
  const reaching = feature.extentTarget !== undefined && form.extent === feature.extent && form.extent !== "distance" && form.extent !== "through-all";
  return applyPlainSize(feature, {
    text: form.value, direction: form.direction, throughAll, reaching, secondText: form.second,
    ...(switchable && form.operation !== feature.operation ? { operation: form.operation } : {}),
    ...(!isExtrude && form.thin ? { thin: { wallText: form.thinWall, side: form.thinSide } } : {})
  }, project);
}
