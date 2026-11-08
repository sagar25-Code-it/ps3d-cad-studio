import type { SheetBendTable, SheetBendTableRow } from "../../../packages/workbench-core/src/index.js";
import { validSheetBendTable } from "../../../packages/workbench-core/src/index.js";

/** One row of the bend table dialog as typed: text fields and which way the value is given. */
export type RowMode = "k" | "allowance" | "deduction";

export interface RowDraft {
  readonly thickness: string;
  readonly radius: string;
  readonly angle: string;
  readonly mode: RowMode;
  readonly value: string;
}

const trim = (value: number): string => String(Number(value.toFixed(5)));

export function draftOf(row: SheetBendTableRow): RowDraft {
  const mode: RowMode = row.kFactor !== undefined ? "k" : row.bendAllowanceMm !== undefined ? "allowance" : "deduction";
  const value = row.kFactor ?? row.bendAllowanceMm ?? row.bendDeductionMm ?? 0;
  return { thickness: trim(row.thicknessMm), radius: trim(row.innerRadiusMm), angle: row.angleDeg === undefined ? "" : trim(row.angleDeg), mode, value: trim(value) };
}

/** Reads the typed rows back into a table, or says what is wrong with them. */
export function tableFromDrafts(defaultK: string, drafts: readonly RowDraft[], name?: string): { readonly ok: true; readonly table: SheetBendTable } | { readonly ok: false; readonly message: string } {
  const defaultKFactor = Number(defaultK.replace(",", "."));
  if (!(defaultKFactor > 0 && defaultKFactor <= 1)) return { ok: false, message: "The default K-factor must be above 0 and at most 1." };
  const rows: SheetBendTableRow[] = [];
  for (let index = 0; index < drafts.length; index += 1) {
    const draft = drafts[index]!;
    const thickness = Number(draft.thickness.replace(",", "."));
    const radius = Number(draft.radius.replace(",", "."));
    const value = Number(draft.value.replace(",", "."));
    const angle = draft.angle.trim() === "" ? undefined : Number(draft.angle.replace(",", "."));
    if (!(thickness > 0) || !(radius >= 0) || !Number.isFinite(value) || draft.value.trim() === "" || (angle !== undefined && !(angle > 0 && angle <= 180))) return { ok: false, message: `Row ${index + 1}: give a thickness above 0, a radius of 0 or more, a value, and an angle from 0 to 180 or none.` };
    rows.push({
      thicknessMm: thickness, innerRadiusMm: radius,
      ...(angle === undefined ? {} : { angleDeg: angle }),
      ...(draft.mode === "k" ? { kFactor: value } : draft.mode === "allowance" ? { bendAllowanceMm: value } : { bendDeductionMm: value })
    });
  }
  const table: SheetBendTable = { ...(name === undefined ? {} : { name }), defaultKFactor, rows };
  if (!validSheetBendTable(table)) return { ok: false, message: "The table is not valid: a K-factor must be above 0 and at most 1, an allowance above 0, and no two rows may share a thickness, radius and angle." };
  return { ok: true, table };
}

