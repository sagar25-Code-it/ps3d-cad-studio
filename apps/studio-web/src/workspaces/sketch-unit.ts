import { createContext, useContext } from "react";
import { formatLength, parseLengthInput, type LengthUnit } from "../../../../packages/workbench-core/src/index.js";

/**
 * The unit the sketch shows and reads lengths in (millimetres or inches). The project itself is always stored in millimetres; this only
 * changes how a dimension reads and what a bare number typed into a dimension field means.
 */
export const SketchUnitContext = createContext<LengthUnit>("mm");

export function useSketchUnit(): LengthUnit {
  return useContext(SketchUnitContext);
}

/** A length in millimetres written in the sketch's unit: `12.7 mm` or `0.5 in`. */
export function sketchLength(valueMm: number, unit: LengthUnit): string {
  return formatLength(valueMm, unit);
}

/** What a typed dimension means in millimetres, or the reason it is not a length. */
export function readSketchLength(text: string, unit: LengthUnit): { readonly ok: true; readonly valueMm: number } | { readonly ok: false; readonly message: string } {
  return parseLengthInput(text, unit);
}
