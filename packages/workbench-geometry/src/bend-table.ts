import { DEFAULT_K_FACTOR, sheetBendAllowanceMm, sheetBendDeductionMm, sheetOutsideSetbackMm } from "./sheet-metal.js";

/**
 * Bend tables: how a bend develops in the flat pattern, keyed by sheet thickness and inner bend radius (and optionally angle).
 * A row can state a K-factor, a bend allowance or a bend deduction; all three describe the same neutral-fibre position, so each is
 * turned into the K-factor it implies for the bend being developed. The flat pattern reads bends through `BendKResolver`.
 */
export interface BendTableRow {
  readonly thicknessMm: number;
  readonly innerRadiusMm: number;
  /** Bend angle the row is for; absent, the row serves every angle and an allowance or deduction is the value at 90 degrees. */
  readonly angleDeg?: number;
  readonly kFactor?: number;
  readonly bendAllowanceMm?: number;
  readonly bendDeductionMm?: number;
}

export interface BendTable {
  readonly name?: string;
  readonly defaultKFactor: number;
  readonly rows: readonly BendTableRow[];
}

/** Where the K-factor of a bend came from. */
export type BendKSource = "table" | "interpolated" | "default";

export interface BendKLookup {
  readonly kFactor: number;
  readonly source: BendKSource;
}

/** Gives the K-factor to develop a bend of this thickness, inner radius and angle with. */
export type BendKResolver = (thicknessMm: number, innerRadiusMm: number, angleDeg: number) => BendKLookup;

const TOLERANCE = 1e-6;

/**
 * The K-factor a row implies for a bend of its own thickness and radius. An allowance or deduction belongs to the row's angle, or to
 * 90 degrees when the row names none, and is turned back into the neutral-fibre position that produces it.
 */
export function kFactorOfRow(row: BendTableRow): number {
  if (row.kFactor !== undefined) return row.kFactor;
  const angle = row.angleDeg ?? 90;
  let allowance: number | undefined = row.bendAllowanceMm;
  if (allowance === undefined && row.bendDeductionMm !== undefined) allowance = 2 * sheetOutsideSetbackMm(angle, row.innerRadiusMm, row.thicknessMm) - row.bendDeductionMm;
  if (allowance === undefined) return DEFAULT_K_FACTOR;
  // The neutral fibre sits (allowance / angle - radius) from the inner face; as a fraction of thickness that is K.
  return (allowance / (angle * Math.PI / 180) - row.innerRadiusMm) / row.thicknessMm;
}

/**
 * Looks a bend up in a table. A row for the same thickness and radius (and angle, when the row names one; a row for the exact angle
 * beats a row for any angle) is used as it stands. Without one, two rows of the same thickness whose radii bracket this bend are
 * interpolated by radius. Anything else falls back to the table's default K-factor, so a bend is never silently developed with a
 * value the table does not support.
 */
export function lookupBendK(table: BendTable | undefined, thicknessMm: number, innerRadiusMm: number, angleDeg: number): BendKLookup {
  if (table === undefined) return { kFactor: DEFAULT_K_FACTOR, source: "default" };
  const sameThickness = table.rows.filter((row) => Math.abs(row.thicknessMm - thicknessMm) <= TOLERANCE && (row.angleDeg === undefined || Math.abs(row.angleDeg - angleDeg) <= TOLERANCE));
  const preferExact = (rows: readonly BendTableRow[]): readonly BendTableRow[] => {
    const exact = rows.filter((row) => row.angleDeg !== undefined);
    return exact.length > 0 ? exact : rows;
  };
  const atRadius = preferExact(sameThickness.filter((row) => Math.abs(row.innerRadiusMm - innerRadiusMm) <= TOLERANCE));
  if (atRadius.length > 0) return { kFactor: kFactorOfRow(atRadius[0]!), source: "table" };
  const pool = preferExact(sameThickness);
  const below = pool.filter((row) => row.innerRadiusMm < innerRadiusMm).sort((a, b) => b.innerRadiusMm - a.innerRadiusMm)[0];
  const above = pool.filter((row) => row.innerRadiusMm > innerRadiusMm).sort((a, b) => a.innerRadiusMm - b.innerRadiusMm)[0];
  if (below !== undefined && above !== undefined) {
    const fraction = (innerRadiusMm - below.innerRadiusMm) / (above.innerRadiusMm - below.innerRadiusMm);
    const k = kFactorOfRow(below) * (1 - fraction) + kFactorOfRow(above) * fraction;
    return { kFactor: k, source: "interpolated" };
  }
  return { kFactor: table.defaultKFactor, source: "default" };
}

/** A resolver for the flat pattern: a fixed K-factor, or a table lookup. */
export function bendResolverOf(source: number | BendTable | undefined): BendKResolver {
  if (typeof source === "number") return () => ({ kFactor: source, source: "default" });
  return (thicknessMm, innerRadiusMm, angleDeg) => lookupBendK(source, thicknessMm, innerRadiusMm, angleDeg);
}

/** One bend as developed: what went into it and the allowance, deduction and setback that came out. */
export interface BendRecord {
  readonly thicknessMm: number;
  readonly innerRadiusMm: number;
  readonly angleDeg: number;
  readonly kFactor: number;
  readonly source: BendKSource;
  readonly bendAllowanceMm: number;
  readonly bendDeductionMm: number;
  readonly outsideSetbackMm: number;
}

export function developBend(resolve: BendKResolver, thicknessMm: number, innerRadiusMm: number, angleDeg: number): BendRecord {
  const { kFactor, source } = resolve(thicknessMm, innerRadiusMm, angleDeg);
  return {
    thicknessMm, innerRadiusMm, angleDeg, kFactor, source,
    bendAllowanceMm: sheetBendAllowanceMm(angleDeg, innerRadiusMm, thicknessMm, kFactor),
    bendDeductionMm: sheetBendDeductionMm(angleDeg, innerRadiusMm, thicknessMm, kFactor),
    outsideSetbackMm: sheetOutsideSetbackMm(angleDeg, innerRadiusMm, thicknessMm)
  };
}

const num = (value: number): string => String(Number(value.toFixed(5)));

/** The bends of a part as a CSV: one line per distinct thickness, radius and angle, with how many there are and how each develops. */
export function bendReportCsv(bends: readonly BendRecord[]): string {
  const groups = new Map<string, { record: BendRecord; count: number }>();
  for (const bend of bends) {
    const key = `${num(bend.thicknessMm)}|${num(bend.innerRadiusMm)}|${num(bend.angleDeg)}|${num(bend.kFactor)}|${bend.source}`;
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, { record: bend, count: 1 });
    else existing.count += 1;
  }
  const lines = ["thickness_mm,inner_radius_mm,angle_deg,count,k_factor,k_source,bend_allowance_mm,bend_deduction_mm,outside_setback_mm"];
  for (const { record, count } of groups.values()) {
    lines.push([record.thicknessMm, record.innerRadiusMm, record.angleDeg, count, record.kFactor, record.source, record.bendAllowanceMm, record.bendDeductionMm, record.outsideSetbackMm].map((value) => (typeof value === "number" ? num(value) : value)).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

const ROW_HEADER = "thickness_mm,inner_radius_mm,angle_deg,k_factor,bend_allowance_mm,bend_deduction_mm";

/** The rows of a bend table as CSV (blank cells for what a row does not state); `parseBendTableCsv` reads it back. */
export function bendTableRowsCsv(table: BendTable): string {
  const lines = [ROW_HEADER];
  for (const row of table.rows) {
    lines.push([row.thicknessMm, row.innerRadiusMm, row.angleDeg, row.kFactor, row.bendAllowanceMm, row.bendDeductionMm].map((value) => (value === undefined ? "" : num(value))).join(","));
  }
  return `${lines.join("\r\n")}\r\n`;
}

export type BendTableParse =
  | { readonly ok: true; readonly rows: readonly BendTableRow[] }
  | { readonly ok: false; readonly message: string };

/** Reads the CSV `bendTableRowsCsv` writes (header optional). Each row needs a thickness, a radius and exactly one of K, allowance or deduction. */
export function parseBendTableCsv(text: string): BendTableParse {
  const rows: BendTableRow[] = [];
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== "");
  for (let index = 0; index < lines.length; index += 1) {
    const cells = lines[index]!.split(",").map((cell) => cell.trim());
    if (index === 0 && cells[0] !== undefined && Number.isNaN(Number(cells[0]))) continue;
    if (cells.length < 6) return { ok: false, message: `Line ${index + 1}: expected 6 values (${ROW_HEADER}).` };
    const [thickness, radius, angle, k, allowance, deduction] = cells.map((cell) => (cell === "" ? undefined : Number(cell)));
    if (thickness === undefined || radius === undefined || !Number.isFinite(thickness) || !Number.isFinite(radius) || thickness <= 0 || radius < 0) return { ok: false, message: `Line ${index + 1}: thickness must be above 0 and the radius 0 or more.` };
    if ([angle, k, allowance, deduction].some((value) => value !== undefined && !Number.isFinite(value))) return { ok: false, message: `Line ${index + 1}: a value is not a number.` };
    if ([k, allowance, deduction].filter((value) => value !== undefined).length !== 1) return { ok: false, message: `Line ${index + 1}: give exactly one of K-factor, bend allowance or bend deduction.` };
    if (angle !== undefined && !(angle > 0 && angle <= 180)) return { ok: false, message: `Line ${index + 1}: the angle must be above 0 and at most 180.` };
    rows.push({
      thicknessMm: thickness, innerRadiusMm: radius,
      ...(angle === undefined ? {} : { angleDeg: angle }),
      ...(k === undefined ? {} : { kFactor: k }),
      ...(allowance === undefined ? {} : { bendAllowanceMm: allowance }),
      ...(deduction === undefined ? {} : { bendDeductionMm: deduction })
    });
  }
  return { ok: true, rows };
}
