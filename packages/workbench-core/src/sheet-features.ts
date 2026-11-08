/**
 * Sheet-metal timeline fields added after the first flange kinds: miter chains, jogs, lofted bends and the per-body bend table.
 * They live here so `validSolidFeaturePayload` can accept and check them with one call.
 */

/** One row of a bend table. A row says what the bend of a given sheet thickness and inner radius (and optionally angle) develops to. */
export interface SheetBendTableRow {
  readonly thicknessMm: number;
  readonly innerRadiusMm: number;
  /** The bend angle this row is for. Absent, the row serves every angle and its allowance or deduction is the value at 90°. */
  readonly angleDeg?: number;
  /** Exactly one of the next three says how the bend develops: a K-factor, a bend allowance or a bend deduction. */
  readonly kFactor?: number;
  readonly bendAllowanceMm?: number;
  readonly bendDeductionMm?: number;
}

/** Bend table of a sheet-metal body: rows keyed by thickness and bend radius, and the K-factor used where no row matches. */
export interface SheetBendTable {
  readonly name?: string;
  readonly defaultKFactor: number;
  readonly rows: readonly SheetBendTableRow[];
}

export const MAX_BEND_TABLE_ROWS = 64;

/** Optional keys of a solid step that this file owns. */
export const SHEET_FEATURE_KEYS = ["flangeMiterEdges", "sheetBendTable", "jogEdgeIndex", "jogPositionMm", "jogOffsetMm", "jogAngleDeg"] as const;

/** Step kinds this file adds. */
export const SHEET_FEATURE_KINDS = ["sheet-jog", "sheet-lofted-bend"] as const;

/** Kinds whose body can carry a bend table: the steps that make a sheet-metal body. */
const BEND_TABLE_KINDS: readonly string[] = ["sheet-base", "sheet-flange", "sheet-hem", "extrude", "sheet-lofted-bend"];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const finiteIn = (value: unknown, low: number, high: number): value is number => typeof value === "number" && Number.isFinite(value) && value >= low && value <= high;
const positiveTo = (value: unknown, high: number): value is number => typeof value === "number" && Number.isFinite(value) && value > 0 && value <= high;

function validBendTableRow(row: unknown): boolean {
  if (!isRecord(row)) return false;
  const allowed = ["thicknessMm", "innerRadiusMm", "angleDeg", "kFactor", "bendAllowanceMm", "bendDeductionMm"];
  if (Object.keys(row).some((key) => !allowed.includes(key))) return false;
  if (!positiveTo(row.thicknessMm, 1000) || !finiteIn(row.innerRadiusMm, 0, 1000)) return false;
  if (Object.hasOwn(row, "angleDeg") && !positiveTo(row.angleDeg, 180)) return false;
  const given = ["kFactor", "bendAllowanceMm", "bendDeductionMm"].filter((key) => Object.hasOwn(row, key));
  if (given.length !== 1) return false;
  if (Object.hasOwn(row, "kFactor")) return positiveTo(row.kFactor, 1);
  if (Object.hasOwn(row, "bendAllowanceMm")) return positiveTo(row.bendAllowanceMm, 10_000);
  return finiteIn(row.bendDeductionMm, -10_000, 10_000);
}

/** Checks a bend table: bounded rows, each with one way to develop the bend, and no two rows for the same thickness, radius and angle. */
export function validSheetBendTable(table: unknown): table is SheetBendTable {
  if (!isRecord(table)) return false;
  if (Object.keys(table).some((key) => !["name", "defaultKFactor", "rows"].includes(key))) return false;
  if (Object.hasOwn(table, "name") && !(typeof table.name === "string" && table.name.trim().length >= 1 && table.name.length <= 80)) return false;
  if (!positiveTo(table.defaultKFactor, 1)) return false;
  const rows = table.rows;
  if (!Array.isArray(rows) || rows.length > MAX_BEND_TABLE_ROWS || !rows.every(validBendTableRow)) return false;
  const seen = new Set<string>();
  for (const row of rows as readonly Record<string, number | undefined>[]) {
    const key = `${row.thicknessMm}|${row.innerRadiusMm}|${row.angleDeg ?? "any"}`;
    if (seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

/**
 * Validates the sheet-metal fields of a timeline step (already known to be a record with an allowed key set). It enforces which kind
 * may carry which field, and the fields a jog and a lofted bend cannot do without.
 */
export function validSheetFeatureExtras(value: Record<string, unknown>): boolean {
  const kind = String(value.kind);
  if (Object.hasOwn(value, "flangeMiterEdges")) {
    const edges = value.flangeMiterEdges;
    if (kind !== "sheet-edge-flange" || !Array.isArray(edges) || edges.length === 0 || edges.length > 64) return false;
    if (!edges.every((edge) => typeof edge === "number" && Number.isInteger(edge) && edge >= 0 && edge <= 1000)) return false;
    const all = [value.flangeEdgeIndex, ...edges];
    if (new Set(all).size !== all.length) return false;
  }
  if (Object.hasOwn(value, "sheetBendTable")) {
    if (!BEND_TABLE_KINDS.includes(kind) || !validSheetBendTable(value.sheetBendTable)) return false;
  }
  const jogKeys = ["jogEdgeIndex", "jogPositionMm", "jogOffsetMm", "jogAngleDeg"];
  if (kind !== "sheet-jog" && jogKeys.some((key) => Object.hasOwn(value, key))) return false;
  if (kind === "sheet-jog") {
    if (value.operation !== "direct-edit" || !jogKeys.every((key) => Object.hasOwn(value, key)) || !Object.hasOwn(value, "sheetBendRadiusMm")) return false;
    const edge = value.jogEdgeIndex;
    if (typeof edge !== "number" || !Number.isInteger(edge) || edge < 0 || edge > 1000) return false;
    if (!finiteIn(value.jogPositionMm, 0, 100_000)) return false;
    if (typeof value.jogOffsetMm !== "number" || !Number.isFinite(value.jogOffsetMm) || value.jogOffsetMm === 0 || Math.abs(value.jogOffsetMm) > 10_000) return false;
    if (!(typeof value.jogAngleDeg === "number" && Number.isFinite(value.jogAngleDeg) && value.jogAngleDeg >= 1 && value.jogAngleDeg <= 89)) return false;
  }
  if (kind === "sheet-lofted-bend") {
    if (Object.hasOwn(value, "operation") && value.operation !== "new-body") return false;
    if (!Object.hasOwn(value, "sheetThicknessMm")) return false;
    if (!Object.hasOwn(value, "loftTopScale") && !Object.hasOwn(value, "loftSecondaryProfileIds")) return false;
  }
  return true;
}

/** Every plate edge a flange step bends: the edge it names, then the rest of its miter chain. */
export function flangeEdgesOf(feature: { readonly flangeEdgeIndex?: number; readonly flangeMiterEdges?: readonly number[] }): readonly number[] {
  return [feature.flangeEdgeIndex ?? 0, ...(feature.flangeMiterEdges ?? [])];
}
