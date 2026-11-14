import type { DesignSolidFeature } from "../../../packages/workbench-core/src/index.js";
import { bindableFieldsOf, primitiveSizeFieldLabel } from "../../../packages/workbench-core/src/index.js";
import type { ParameterField } from "./feature-parameters.js";

/**
 * The fields the Edit dialog shows for a construction plane, axis, point or primitive step: its numbers, labelled for how it was
 * defined (a primitive's size fields carry the names of its shape: "Diameter", "Height"). They are the step's bindable fields, so each
 * one also takes an expression (`plate_w / 2`, `Offset1.offset + 5`).
 */

const trim = (value: number): string => String(Number(value.toFixed(4)));

export function referenceParameterFields(feature: DesignSolidFeature): readonly ParameterField[] {
  const shape = feature.reference?.kind === "primitive" ? feature.reference.body.shape : undefined;
  return bindableFieldsOf(feature).map((field): ParameterField => {
    const sizeIndex = field.id === "sizeX" ? 0 : field.id === "sizeY" ? 1 : field.id === "sizeZ" ? 2 : undefined;
    const sized = shape === undefined || sizeIndex === undefined ? undefined : primitiveSizeFieldLabel(shape, sizeIndex);
    return {
      id: field.id,
      label: sized ?? field.label,
      unit: field.dimension === "length" ? "mm" : field.dimension === "angle" ? "°" : "",
      input: field.integer === true ? "integer" : "number",
      ...(field.min === undefined ? {} : { min: field.min }),
      ...(field.max === undefined ? {} : { max: field.max }),
      ...(field.exclusiveMin === true ? { exclusiveMin: true } : {}),
      read: (step) => { const value = field.read(step); return value === undefined ? "" : trim(value); },
      write: (step, value) => field.write(step, value as number)
    };
  });
}
