import { failure, SPLINE_MAX_FIT_POINTS, type SketchEntity, type Vec2, type WorkbenchResult, type WorkbenchSketch } from "../../workbench-core/src/index.js";
import {
  arcFromAngles,
  arcGeometry,
  catmullRomSamples,
  curvesFromDensePolyline,
  mmPerInsUnit,
  type DetectedUnits,
  type ParseResult,
  type ParsedDrawing,
  type RawCurve
} from "./sketch-exchange.js";
import { splineSpanHermite } from "../../workbench-core/src/spline-curvature.js";
import { flattenSpline } from "./curve-sampling.js";

/**
 * DXF for sketches.
 *
 * Writer: ASCII DXF R2000 (AC1015) with model-space entities on two layers, `0` for profile curves and `CONSTRUCTION` (grey, dashed)
 * for construction curves. Lines, circles, arcs, ellipses and points map to LINE, CIRCLE, ARC, ELLIPSE and POINT; a rectangle is a
 * closed LWPOLYLINE; a fit-point spline is a cubic SPLINE with control points and knots (the sketch's Catmull-Rom curve written as
 * a chain of Bezier spans, so the shape is the same). `$INSUNITS` and `$MEASUREMENT` carry the unit. Hidden curves are not written.
 *
 * Reader: LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE (with bulge arcs), POLYLINE/VERTEX, SPLINE (control points and knots, or fit
 * points) and POINT, in millimetres, inches or any other `$INSUNITS` unit. Everything else (text, dimensions, hatches, blocks) is
 * counted and skipped, never guessed at. DWG is not read: the message tells the user to save as DXF.
 */

export type DxfUnits = "mm" | "in";

export interface DxfWriteOptions {
  readonly units?: DxfUnits;
  /** Write construction curves on the CONSTRUCTION layer (default true). */
  readonly includeConstruction?: boolean;
  /** A name for the first comment line. */
  readonly title?: string;
}

const MODEL_SPACE_RECORD = "1F";
const OWNER_ROOT = "0";

/** Number text with at most 9 decimals and no trailing zeros. */
function num(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const text = value.toFixed(9);
  const trimmed = text.includes(".") ? text.replace(/0+$/u, "").replace(/\.$/u, "") : text;
  return trimmed === "-0" ? "0" : trimmed;
}

/**
 * A number with 15 significant digits, for the values an ellipse is rebuilt from (the major-axis vector and the axis ratio): nine decimals
 * would leave the reader with 11.9999999996 for a radius of 12.
 */
function exact(value: number): string {
  if (!Number.isFinite(value) || Math.abs(value) < 1e-12) return "0";
  const text = String(Number(value.toPrecision(15)));
  return /e/iu.test(text) ? value.toFixed(12).replace(/0+$/u, "").replace(/\.$/u, "") : text;
}

class DxfWriter {
  private readonly lines: string[] = [];
  private nextHandle = 0x100;

  pair(code: number, value: string | number): void {
    this.lines.push(String(code), typeof value === "number" ? num(value) : value);
  }

  intPair(code: number, value: number): void {
    this.lines.push(String(code), String(Math.trunc(value)));
  }

  handle(): string {
    const text = this.nextHandle.toString(16).toUpperCase();
    this.nextHandle += 1;
    return text;
  }

  get handleSeed(): string {
    return this.nextHandle.toString(16).toUpperCase();
  }

  text(): string {
    return `${this.lines.join("\n")}\n`;
  }
}

interface LayerDefinition {
  readonly name: string;
  readonly color: number;
  readonly lineType: string;
}

const LAYERS: readonly LayerDefinition[] = [
  { name: "0", color: 7, lineType: "CONTINUOUS" },
  { name: "CONSTRUCTION", color: 8, lineType: "DASHED" }
];

function mapPoint(point: Vec2, factor: number): Vec2 {
  return [point[0] * factor, point[1] * factor];
}

/**
 * The cubic Bezier chain of the sketch spline through fit points, as B-spline control points and a clamped knot vector. Each span is
 * the sketch's own Hermite span (the one the sketch draws and builds solids from, with its uneven-spacing handling), so the exported
 * curve is the same curve, not a uniform Catmull-Rom look-alike.
 */
export function splineAsBezierChain(fit: readonly Vec2[]): { readonly controls: readonly Vec2[]; readonly knots: readonly number[] } {
  const controls: Vec2[] = [fit[0]!];
  const spans = fit.length - 1;
  for (let span = 0; span < spans; span += 1) {
    const { p1, p2, m1, m2 } = splineSpanHermite(fit, span);
    controls.push([p1[0] + m1[0] / 3, p1[1] + m1[1] / 3]);
    controls.push([p2[0] - m2[0] / 3, p2[1] - m2[1] / 3]);
    controls.push([p2[0], p2[1]]);
  }
  const knots: number[] = [0, 0, 0, 0];
  for (let span = 1; span < spans; span += 1) knots.push(span, span, span);
  knots.push(spans, spans, spans, spans);
  return { controls, knots };
}

function curveBounds(entity: SketchEntity): readonly Vec2[] {
  switch (entity.kind) {
    case "line": return [entity.start, entity.end];
    case "arc": return [entity.start, entity.mid, entity.end];
    case "circle": return [[entity.center[0] - entity.radiusMm, entity.center[1] - entity.radiusMm], [entity.center[0] + entity.radiusMm, entity.center[1] + entity.radiusMm]];
    case "ellipse": return [[entity.center[0] - entity.majorRadiusMm, entity.center[1] - entity.majorRadiusMm], [entity.center[0] + entity.majorRadiusMm, entity.center[1] + entity.majorRadiusMm]];
    case "rectangle": { const half = Math.hypot(entity.widthMm, entity.heightMm) / 2; return [[entity.center[0] - half, entity.center[1] - half], [entity.center[0] + half, entity.center[1] + half]]; }
    case "point": return [entity.point];
    case "spline": return catmullRomSamples(entity.fitPoints, 4);
  }
}

/** DXF text for the visible curves of a sketch. */
export function writeSketchDxf(sketch: WorkbenchSketch, options: DxfWriteOptions = {}): string {
  const units = options.units ?? "mm";
  const factor = units === "in" ? 1 / 25.4 : 1;
  const includeConstruction = options.includeConstruction !== false;
  const entities = sketch.entities.filter((entity) => entity.visible !== false && (includeConstruction || !entity.construction));
  const w = new DxfWriter();
  const points = entities.flatMap((entity) => curveBounds(entity).map((point) => mapPoint(point, factor)));
  const min: Vec2 = points.length === 0 ? [0, 0] : [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1]))];
  const max: Vec2 = points.length === 0 ? [0, 0] : [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1]))];

  // Entities first, so the handle seed in the header is right.
  const body = new DxfWriter();
  const common = (type: string, subclass: string, entity: SketchEntity): void => {
    body.pair(0, type);
    body.pair(5, body.handle());
    body.pair(330, MODEL_SPACE_RECORD);
    body.pair(100, "AcDbEntity");
    body.pair(8, entity.construction ? "CONSTRUCTION" : "0");
    if (entity.construction) body.pair(6, "DASHED");
    body.pair(100, subclass);
  };
  for (const entity of entities) {
    switch (entity.kind) {
      case "line": {
        common("LINE", "AcDbLine", entity);
        const a = mapPoint(entity.start, factor);
        const b = mapPoint(entity.end, factor);
        body.pair(10, a[0]); body.pair(20, a[1]); body.pair(30, 0);
        body.pair(11, b[0]); body.pair(21, b[1]); body.pair(31, 0);
        break;
      }
      case "circle": {
        common("CIRCLE", "AcDbCircle", entity);
        const c = mapPoint(entity.center, factor);
        body.pair(10, c[0]); body.pair(20, c[1]); body.pair(30, 0); body.pair(40, entity.radiusMm * factor);
        break;
      }
      case "arc": {
        const geometry = arcGeometry(entity.start, entity.mid, entity.end);
        if (geometry === undefined) {
          common("LINE", "AcDbLine", { ...entity });
          const a = mapPoint(entity.start, factor);
          const b = mapPoint(entity.end, factor);
          body.pair(10, a[0]); body.pair(20, a[1]); body.pair(30, 0); body.pair(11, b[0]); body.pair(21, b[1]); body.pair(31, 0);
          break;
        }
        // A DXF arc always runs counter-clockwise from its start angle to its end angle.
        const first = geometry.sweep >= 0 ? geometry.startAngle : geometry.startAngle + geometry.sweep;
        const last = geometry.sweep >= 0 ? geometry.startAngle + geometry.sweep : geometry.startAngle;
        const degrees = (angle: number): number => ((((angle * 180) / Math.PI) % 360) + 360) % 360;
        common("ARC", "AcDbCircle", entity);
        const c = mapPoint(geometry.center, factor);
        body.pair(10, c[0]); body.pair(20, c[1]); body.pair(30, 0); body.pair(40, geometry.radius * factor);
        body.pair(100, "AcDbArc");
        body.pair(50, degrees(first)); body.pair(51, degrees(last));
        break;
      }
      case "ellipse": {
        common("ELLIPSE", "AcDbEllipse", entity);
        const c = mapPoint(entity.center, factor);
        const radians = (entity.rotationDeg * Math.PI) / 180;
        body.pair(10, c[0]); body.pair(20, c[1]); body.pair(30, 0);
        body.pair(11, exact(entity.majorRadiusMm * factor * Math.cos(radians))); body.pair(21, exact(entity.majorRadiusMm * factor * Math.sin(radians))); body.pair(31, 0);
        body.pair(210, 0); body.pair(220, 0); body.pair(230, 1);
        body.pair(40, exact(entity.minorRadiusMm / entity.majorRadiusMm));
        body.pair(41, 0); body.pair(42, 2 * Math.PI);
        break;
      }
      case "rectangle": {
        common("LWPOLYLINE", "AcDbPolyline", entity);
        const radians = (entity.rotationDeg * Math.PI) / 180;
        const corner = (sx: number, sy: number): Vec2 => {
          const x = (sx * entity.widthMm) / 2;
          const y = (sy * entity.heightMm) / 2;
          return mapPoint([entity.center[0] + x * Math.cos(radians) - y * Math.sin(radians), entity.center[1] + x * Math.sin(radians) + y * Math.cos(radians)], factor);
        };
        body.intPair(90, 4); body.intPair(70, 1);
        for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) { const p = corner(sx, sy); body.pair(10, p[0]); body.pair(20, p[1]); }
        break;
      }
      case "point": {
        common("POINT", "AcDbPoint", entity);
        const p = mapPoint(entity.point, factor);
        body.pair(10, p[0]); body.pair(20, p[1]); body.pair(30, 0);
        break;
      }
      case "spline": {
        common("SPLINE", "AcDbSpline", entity);
        const fit = entity.fitPoints.map((point) => mapPoint(point, factor));
        const chain = splineAsBezierChain(fit);
        body.pair(210, 0); body.pair(220, 0); body.pair(230, 1);
        body.intPair(70, 8);
        body.intPair(71, 3);
        body.intPair(72, chain.knots.length);
        body.intPair(73, chain.controls.length);
        body.intPair(74, fit.length);
        body.pair(42, 1e-7); body.pair(43, 1e-7);
        for (const knot of chain.knots) body.pair(40, knot);
        for (const control of chain.controls) { body.pair(10, control[0]); body.pair(20, control[1]); body.pair(30, 0); }
        // The fit points ride along, so PS3D reads back the same spline (same points, same count) and not a refit of the curve.
        for (const point of fit) { body.pair(11, point[0]); body.pair(21, point[1]); body.pair(31, 0); }
        break;
      }
    }
  }

  w.pair(999, options.title ?? "PS3D CAD Studio sketch export");
  w.pair(0, "SECTION"); w.pair(2, "HEADER");
  w.pair(9, "$ACADVER"); w.pair(1, "AC1015");
  w.pair(9, "$HANDSEED"); w.pair(5, body.handleSeed);
  w.pair(9, "$INSBASE"); w.pair(10, 0); w.pair(20, 0); w.pair(30, 0);
  w.pair(9, "$EXTMIN"); w.pair(10, min[0]); w.pair(20, min[1]); w.pair(30, 0);
  w.pair(9, "$EXTMAX"); w.pair(10, max[0]); w.pair(20, max[1]); w.pair(30, 0);
  w.pair(9, "$MEASUREMENT"); w.intPair(70, units === "in" ? 0 : 1);
  w.pair(9, "$INSUNITS"); w.intPair(70, units === "in" ? 1 : 4);
  w.pair(9, "$LUNITS"); w.intPair(70, 2);
  w.pair(0, "ENDSEC");

  w.pair(0, "SECTION"); w.pair(2, "TABLES");
  w.pair(0, "TABLE"); w.pair(2, "VPORT"); w.pair(5, "8"); w.pair(330, OWNER_ROOT); w.pair(100, "AcDbSymbolTable"); w.intPair(70, 0); w.pair(0, "ENDTAB");
  w.pair(0, "TABLE"); w.pair(2, "LTYPE"); w.pair(5, "5"); w.pair(330, OWNER_ROOT); w.pair(100, "AcDbSymbolTable"); w.intPair(70, 2);
  w.pair(0, "LTYPE"); w.pair(5, "14"); w.pair(330, "5"); w.pair(100, "AcDbSymbolTableRecord"); w.pair(100, "AcDbLinetypeTableRecord"); w.pair(2, "CONTINUOUS"); w.intPair(70, 0); w.pair(3, "Solid line"); w.intPair(72, 65); w.intPair(73, 0); w.pair(40, 0);
  w.pair(0, "LTYPE"); w.pair(5, "15"); w.pair(330, "5"); w.pair(100, "AcDbSymbolTableRecord"); w.pair(100, "AcDbLinetypeTableRecord"); w.pair(2, "DASHED"); w.intPair(70, 0); w.pair(3, "Dashed __ __ __"); w.intPair(72, 65); w.intPair(73, 2); w.pair(40, 6 * (units === "in" ? 1 / 25.4 : 1)); w.pair(49, 4 * (units === "in" ? 1 / 25.4 : 1)); w.intPair(74, 0); w.pair(49, -2 * (units === "in" ? 1 / 25.4 : 1)); w.intPair(74, 0);
  w.pair(0, "ENDTAB");
  w.pair(0, "TABLE"); w.pair(2, "LAYER"); w.pair(5, "2"); w.pair(330, OWNER_ROOT); w.pair(100, "AcDbSymbolTable"); w.intPair(70, LAYERS.length);
  LAYERS.forEach((layer, index) => {
    w.pair(0, "LAYER"); w.pair(5, (0x10 + index).toString(16).toUpperCase()); w.pair(330, "2"); w.pair(100, "AcDbSymbolTableRecord"); w.pair(100, "AcDbLayerTableRecord");
    w.pair(2, layer.name); w.intPair(70, 0); w.intPair(62, layer.color); w.pair(6, layer.lineType);
  });
  w.pair(0, "ENDTAB");
  w.pair(0, "TABLE"); w.pair(2, "STYLE"); w.pair(5, "3"); w.pair(330, OWNER_ROOT); w.pair(100, "AcDbSymbolTable"); w.intPair(70, 1);
  w.pair(0, "STYLE"); w.pair(5, "16"); w.pair(330, "3"); w.pair(100, "AcDbSymbolTableRecord"); w.pair(100, "AcDbTextStyleTableRecord"); w.pair(2, "STANDARD"); w.intPair(70, 0); w.pair(40, 0); w.pair(41, 1); w.pair(50, 0); w.intPair(71, 0); w.pair(42, 2.5); w.pair(3, "txt"); w.pair(4, "");
  w.pair(0, "ENDTAB");
  w.pair(0, "TABLE"); w.pair(2, "VIEW"); w.pair(5, "6"); w.pair(330, OWNER_ROOT); w.pair(100, "AcDbSymbolTable"); w.intPair(70, 0); w.pair(0, "ENDTAB");
  w.pair(0, "TABLE"); w.pair(2, "UCS"); w.pair(5, "7"); w.pair(330, OWNER_ROOT); w.pair(100, "AcDbSymbolTable"); w.intPair(70, 0); w.pair(0, "ENDTAB");
  w.pair(0, "TABLE"); w.pair(2, "APPID"); w.pair(5, "9"); w.pair(330, OWNER_ROOT); w.pair(100, "AcDbSymbolTable"); w.intPair(70, 1);
  w.pair(0, "APPID"); w.pair(5, "12"); w.pair(330, "9"); w.pair(100, "AcDbSymbolTableRecord"); w.pair(100, "AcDbRegAppTableRecord"); w.pair(2, "ACAD"); w.intPair(70, 0);
  w.pair(0, "ENDTAB");
  w.pair(0, "TABLE"); w.pair(2, "BLOCK_RECORD"); w.pair(5, "1"); w.pair(330, OWNER_ROOT); w.pair(100, "AcDbSymbolTable"); w.intPair(70, 2);
  w.pair(0, "BLOCK_RECORD"); w.pair(5, MODEL_SPACE_RECORD); w.pair(330, "1"); w.pair(100, "AcDbSymbolTableRecord"); w.pair(100, "AcDbBlockTableRecord"); w.pair(2, "*Model_Space"); w.intPair(70, 0); w.intPair(280, 1); w.intPair(281, 0);
  w.pair(0, "BLOCK_RECORD"); w.pair(5, "1B"); w.pair(330, "1"); w.pair(100, "AcDbSymbolTableRecord"); w.pair(100, "AcDbBlockTableRecord"); w.pair(2, "*Paper_Space"); w.intPair(70, 0); w.intPair(280, 1); w.intPair(281, 0);
  w.pair(0, "ENDTAB");
  w.pair(0, "ENDSEC");

  w.pair(0, "SECTION"); w.pair(2, "BLOCKS");
  for (const [name, record, begin, end] of [["*Model_Space", MODEL_SPACE_RECORD, "20", "21"], ["*Paper_Space", "1B", "1C", "1D"]] as const) {
    w.pair(0, "BLOCK"); w.pair(5, begin); w.pair(330, record); w.pair(100, "AcDbEntity"); w.pair(8, "0"); w.pair(100, "AcDbBlockBegin"); w.pair(2, name); w.intPair(70, 0); w.pair(10, 0); w.pair(20, 0); w.pair(30, 0); w.pair(3, name); w.pair(1, "");
    w.pair(0, "ENDBLK"); w.pair(5, end); w.pair(330, record); w.pair(100, "AcDbEntity"); w.pair(8, "0"); w.pair(100, "AcDbBlockEnd");
  }
  w.pair(0, "ENDSEC");

  w.pair(0, "SECTION"); w.pair(2, "ENTITIES");
  const header = w.text();
  const objects = new DxfWriter();
  objects.pair(0, "ENDSEC");
  objects.pair(0, "SECTION"); objects.pair(2, "OBJECTS");
  objects.pair(0, "DICTIONARY"); objects.pair(5, "C"); objects.pair(330, OWNER_ROOT); objects.pair(100, "AcDbDictionary"); objects.intPair(281, 1); objects.pair(3, "ACAD_GROUP"); objects.pair(350, "D");
  objects.pair(0, "DICTIONARY"); objects.pair(5, "D"); objects.pair(330, "C"); objects.pair(100, "AcDbDictionary"); objects.intPair(281, 1);
  objects.pair(0, "ENDSEC");
  objects.pair(0, "EOF");
  return `${header}${body.text()}${objects.text()}`;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------------------------------------------------

/** A group code, its value, and the 1-based line the value is on (so a damaged number can be named). */
type Pair = readonly [number, string, number?];

interface DxfRecord {
  /** The entity type (group 0 value). */
  readonly type: string;
  readonly pairs: readonly Pair[];
}

const bad = (message: string, recovery = "Choose a text DXF file saved from your CAD program (R12 to 2018)."): WorkbenchResult<never> => failure("INVALID_OPERATION", message, [], recovery);

function numberOf(value: string | undefined, fallback = 0): number {
  if (value === undefined) return fallback;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function first(record: DxfRecord, code: number): string | undefined {
  return record.pairs.find((pair) => pair[0] === code)?.[1];
}

function firstNumber(record: DxfRecord, code: number, fallback = 0): number {
  return numberOf(first(record, code), fallback);
}

/** Splits DXF text into group-code pairs. Returns a message when the text is not an ASCII DXF. */
function tokenize(text: string): readonly Pair[] | string {
  if (text.length === 0) return "The file is empty.";
  if (text.startsWith("AutoCAD Binary DXF")) return "This is a binary DXF. Save the drawing as an ASCII DXF (in most CAD programs: Save As, DXF, ASCII or text).";
  if (/^AC10\d\d/u.test(text) && text.includes("\u0000")) return "This is a DWG file, which PS3D cannot read. Save or export the drawing as DXF from your CAD program and open that.";
  const lines = text.replace(/^﻿/u, "").split(/\r\n|\r|\n/u);
  // A file cut off in the middle of a group ends on a code with no value: say so instead of quietly dropping the last group.
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length % 2 === 1 && lines.length > 1) return `The DXF ends in the middle of a group at line ${lines.length} (the group code "${lines[lines.length - 1]!.trim().slice(0, 20)}" has no value): the file looks cut off. Export the drawing again.`;
  const pairs: Pair[] = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    const codeText = lines[index]!.trim();
    if (!/^-?\d+$/u.test(codeText)) {
      if (index === 0 || pairs.length === 0) return "This does not look like a DXF file: the first line is not a group code number.";
      return `The DXF is damaged near line ${index + 1}: expected a group code number but found "${codeText.slice(0, 20)}".`;
    }
    pairs.push([Number(codeText), lines[index + 1]!.trim(), index + 2]);
  }
  return pairs;
}

/** Group codes whose value is a number (coordinates, radii, angles, flags, counts). */
function isNumericGroup(code: number): boolean {
  return (code >= 10 && code <= 99) || (code >= 110 && code <= 149) || (code >= 160 && code <= 179) || (code >= 210 && code <= 239) || (code >= 270 && code <= 289) || (code >= 370 && code <= 389) || (code >= 400 && code <= 409) || (code >= 420 && code <= 429) || (code >= 440 && code <= 469);
}

const DXF_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;

/** The first number in the pairs that cannot be read (not a number, or too large to be one), with the line it is on; undefined when all are fine. */
function unreadableNumber(pairs: readonly Pair[]): string | undefined {
  for (const [code, value, line] of pairs) {
    if (!isNumericGroup(code)) continue;
    if (DXF_NUMBER.test(value) && Number.isFinite(Number(value))) continue;
    return `The DXF has an unreadable number "${value.slice(0, 24)}" for group ${code} at line ${line ?? "?"}. The file may be damaged or cut off, and importing it would put wrong geometry in the sketch. Export the drawing again.`;
  }
  return undefined;
}

function sectionsOf(pairs: readonly Pair[]): ReadonlyMap<string, readonly Pair[]> {
  const sections = new Map<string, Pair[]>();
  for (let index = 0; index < pairs.length; index += 1) {
    if (pairs[index]![0] === 0 && pairs[index]![1] === "SECTION" && pairs[index + 1]?.[0] === 2) {
      const name = pairs[index + 1]![1].toUpperCase();
      const body: Pair[] = [];
      let cursor = index + 2;
      while (cursor < pairs.length && !(pairs[cursor]![0] === 0 && pairs[cursor]![1] === "ENDSEC")) { body.push(pairs[cursor]!); cursor += 1; }
      sections.set(name, body);
      index = cursor;
    }
  }
  return sections;
}

/**
 * Whether a file that parsed cleanly still stops early: a DXF ends its entities with ENDSEC and the file with "0 EOF". A download cut at a
 * group boundary has valid pairs all the way and just ends, so the missing end markers are the only sign.
 */
function truncationProblem(pairs: readonly Pair[]): string | undefined {
  const start = pairs.findIndex((pair, index) => pair[0] === 0 && pair[1] === "SECTION" && pairs[index + 1]?.[0] === 2 && pairs[index + 1]![1].toUpperCase() === "ENTITIES");
  if (start < 0) return undefined;
  let cursor = start + 2;
  while (cursor < pairs.length && !(pairs[cursor]![0] === 0 && pairs[cursor]![1] === "ENDSEC")) cursor += 1;
  if (cursor >= pairs.length) return "The file looks cut off: its ENTITIES section is never closed (there is no ENDSEC).";
  const last = pairs[pairs.length - 1]!;
  if (!(last[0] === 0 && last[1].toUpperCase() === "EOF")) return "The file looks cut off: it does not end with the EOF marker.";
  return undefined;
}

function recordsOf(pairs: readonly Pair[]): readonly DxfRecord[] {
  const records: DxfRecord[] = [];
  let current: { type: string; pairs: Pair[] } | undefined;
  for (const pair of pairs) {
    if (pair[0] === 0) {
      if (current !== undefined) records.push(current);
      current = { type: pair[1].toUpperCase(), pairs: [] };
    } else current?.pairs.push(pair);
  }
  if (current !== undefined) records.push(current);
  return records;
}

function headerVariable(header: readonly Pair[] | undefined, name: string): readonly Pair[] | undefined {
  if (header === undefined) return undefined;
  const index = header.findIndex((pair) => pair[0] === 9 && pair[1].toUpperCase() === name);
  if (index < 0) return undefined;
  const values: Pair[] = [];
  for (let cursor = index + 1; cursor < header.length && header[cursor]![0] !== 9; cursor += 1) values.push(header[cursor]!);
  return values;
}

function detectUnits(header: readonly Pair[] | undefined): DetectedUnits {
  const insunits = headerVariable(header, "$INSUNITS")?.find((pair) => pair[0] === 70);
  if (insunits !== undefined) {
    const known = mmPerInsUnit(Math.trunc(numberOf(insunits[1], 0)));
    if (known !== undefined) return { name: known.name, mmPerUnit: known.mmPerUnit, source: "file" };
  }
  const measurement = headerVariable(header, "$MEASUREMENT")?.find((pair) => pair[0] === 70);
  if (measurement !== undefined) {
    return Math.trunc(numberOf(measurement[1], 1)) === 0
      ? { name: "inches", mmPerUnit: 25.4, source: "measurement" }
      : { name: "millimetres", mmPerUnit: 1, source: "measurement" };
  }
  return { name: "millimetres", mmPerUnit: 1, source: "assumed" };
}

const TWO_PI = Math.PI * 2;

/** An arc from `from` to `to` with a DXF bulge (tan of a quarter of the included angle; positive is counter-clockwise). */
function bulgeArc(from: Vec2, to: Vec2, bulge: number): RawCurveShapeOrNothing {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-12) return undefined;
  if (Math.abs(bulge) < 1e-9) return { kind: "line", a: from, b: to };
  const sagitta = (bulge * chord) / 2;
  const mid: Vec2 = [(from[0] + to[0]) / 2 + (dy / chord) * sagitta, (from[1] + to[1]) / 2 - (dx / chord) * sagitta];
  return { kind: "arc", start: from, mid, end: to };
}

type RawCurveShapeOrNothing = { readonly kind: "line"; readonly a: Vec2; readonly b: Vec2 } | { readonly kind: "arc"; readonly start: Vec2; readonly mid: Vec2; readonly end: Vec2 } | undefined;

interface Vertex { readonly point: Vec2; readonly bulge: number }

function polylineCurves(vertices: readonly Vertex[], closed: boolean, layer: string, flipX: boolean): readonly RawCurve[] {
  const curves: RawCurve[] = [];
  const count = closed ? vertices.length : vertices.length - 1;
  const fix = (point: Vec2): Vec2 => (flipX ? [-point[0], point[1]] : point);
  for (let index = 0; index < count; index += 1) {
    const a = vertices[index]!;
    const b = vertices[(index + 1) % vertices.length]!;
    const segment = bulgeArc(fix(a.point), fix(b.point), flipX ? -a.bulge : a.bulge);
    if (segment !== undefined) curves.push({ ...segment, layer });
  }
  return curves;
}

/** B-spline basis evaluation (de Boor), rational when weights are given. */
function evaluateNurbs(degree: number, knots: readonly number[], controls: readonly Vec2[], weights: readonly number[] | undefined, u: number): Vec2 {
  const n = controls.length - 1;
  let span = degree;
  while (span < n && u >= knots[span + 1]!) span += 1;
  const d: [number, number, number][] = [];
  for (let j = 0; j <= degree; j += 1) {
    const index = span - degree + j;
    const w = weights?.[index] ?? 1;
    d.push([controls[index]![0] * w, controls[index]![1] * w, w]);
  }
  for (let r = 1; r <= degree; r += 1) {
    for (let j = degree; j >= r; j -= 1) {
      const left = knots[span - degree + j]!;
      const right = knots[span + 1 + j - r]!;
      const alpha = right - left < 1e-14 ? 0 : (u - left) / (right - left);
      const a = d[j - 1]!;
      const b = d[j]!;
      d[j] = [(1 - alpha) * a[0] + alpha * b[0], (1 - alpha) * a[1] + alpha * b[1], (1 - alpha) * a[2] + alpha * b[2]];
    }
  }
  const result = d[degree]!;
  return result[2] === 0 ? [result[0], result[1]] : [result[0] / result[2], result[1] / result[2]];
}

/** The curve of a B-spline as a dense list of points, or an empty list when its knots do not span a curve. */
function nurbsPolyline(degree: number, knots: readonly number[], controls: readonly Vec2[], weights: readonly number[]): Vec2[] {
  const start = knots[degree]!;
  const end = knots[controls.length]!;
  if (!(end - start > 1e-12)) return [];
  const points: Vec2[] = [];
  const total = Math.min(2000, Math.max(120, controls.length * 8));
  for (let step = 0; step <= total; step += 1) {
    const u = step === total ? end - 1e-12 : start + ((end - start) * step) / total;
    points.push(evaluateNurbs(degree, knots, controls, weights.length === 0 ? undefined : weights, u));
  }
  return points;
}

function distanceToPolyline(point: Vec2, line: readonly Vec2[]): number {
  let best = Infinity;
  for (let index = 0; index + 1 < line.length; index += 1) {
    const a = line[index]!;
    const b = line[index + 1]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared < 1e-30 ? 0 : Math.max(0, Math.min(1, ((point[0] - a[0]) * dx + (point[1] - a[1]) * dy) / lengthSquared));
    best = Math.min(best, Math.hypot(point[0] - (a[0] + t * dx), point[1] - (a[1] + t * dy)));
  }
  return best;
}

function splineCurves(record: DxfRecord, layer: string, toleranceUnits: number, warnings: string[]): readonly RawCurve[] {
  const degree = Math.max(1, Math.trunc(firstNumber(record, 71, 3)));
  const knots = record.pairs.filter((pair) => pair[0] === 40).map((pair) => numberOf(pair[1]));
  const weights = record.pairs.filter((pair) => pair[0] === 41).map((pair) => numberOf(pair[1], 1));
  const controls: Vec2[] = [];
  const fits: Vec2[] = [];
  let pendingControl: number | undefined;
  let pendingFit: number | undefined;
  for (const [code, value] of record.pairs) {
    if (code === 10) pendingControl = numberOf(value);
    else if (code === 20 && pendingControl !== undefined) { controls.push([pendingControl, numberOf(value)]); pendingControl = undefined; }
    else if (code === 11) pendingFit = numberOf(value);
    else if (code === 21 && pendingFit !== undefined) { fits.push([pendingFit, numberOf(value)]); pendingFit = undefined; }
  }
  const usable = controls.length >= degree + 1 && knots.length === controls.length + degree + 1 && (weights.length === 0 || weights.length === controls.length);
  let dense: Vec2[] = [];
  const fitCount = Math.trunc(firstNumber(record, 74, 0));
  if (usable && fitCount === fits.length && fits.length >= 3 && fits.length <= SPLINE_MAX_FIT_POINTS) {
    // A spline that carries its fit points and whose curve is the sketch spline through them (PS3D wrote it) comes back as that spline.
    const sampled = nurbsPolyline(degree, knots, controls, weights);
    const reference = flattenSpline(fits, toleranceUnits / 10).points;
    if (sampled.length >= 2 && sampled.every((point) => distanceToPolyline(point, reference) <= toleranceUnits / 4)) return [{ kind: "spline", fit: fits, layer }];
  }
  if (usable) {
    const start = knots[degree]!;
    const end = knots[controls.length]!;
    if (end - start > 1e-12) {
      const spans = knots.slice(degree, controls.length + 1).filter((knot, index, all) => index > 0 && knot > all[index - 1]!).length;
      const total = Math.min(6000, Math.max(160, spans * 64));
      for (let step = 0; step <= total; step += 1) {
        const u = step === total ? end - 1e-12 : start + ((end - start) * step) / total;
        dense.push(evaluateNurbs(degree, knots, controls, weights.length === 0 ? undefined : weights, u));
      }
      dense[dense.length - 1] = evaluateNurbs(degree, knots, controls, weights.length === 0 ? undefined : weights, end - 1e-12);
    }
  } else if (fits.length >= 3 && fits.length <= SPLINE_MAX_FIT_POINTS) {
    // A spline given only by fit points is the same kind of curve as a sketch spline: keep the points.
    if (controls.length > 0) warnings.push("A spline had inconsistent control points and knots; its fit points were used instead.");
    return [{ kind: "spline", fit: fits, layer }];
  } else if (fits.length >= 2) {
    dense = fits.length >= 3 ? [...catmullRomSamples(fits, 12)] : [...fits];
    if (controls.length > 0) warnings.push("A spline had inconsistent control points and knots; its fit points were used instead.");
  } else if (controls.length >= 2) {
    dense = [...controls];
    warnings.push("A spline without usable knots was imported through its control points.");
  }
  if (dense.length < 2) return [];
  return curvesFromDensePolyline(dense, layer, toleranceUnits);
}

function ellipseCurves(record: DxfRecord, layer: string, toleranceUnits: number): readonly RawCurve[] {
  const center: Vec2 = [firstNumber(record, 10), firstNumber(record, 20)];
  const axis: Vec2 = [firstNumber(record, 11), firstNumber(record, 21)];
  const major = Math.hypot(axis[0], axis[1]);
  const ratio = firstNumber(record, 40, 1);
  if (major < 1e-12 || ratio <= 0) return [];
  const minor = major * Math.min(ratio, 1e6);
  const rotationDeg = (Math.atan2(axis[1], axis[0]) * 180) / Math.PI;
  const start = firstNumber(record, 41, 0);
  let end = firstNumber(record, 42, TWO_PI);
  if (end <= start) end += TWO_PI;
  // The file holds nine decimals, so a radius read back from the axis vector and the ratio carries noise (11.999999999612 for 12): snap it.
  const tidy = (value: number): number => Number(value.toFixed(9));
  if (Math.abs(end - start - TWO_PI) < 1e-6) return [{ kind: "ellipse", center, major: tidy(major), minor: tidy(minor), rotationDeg: tidy(rotationDeg), layer }];
  // An elliptical arc has no sketch entity; follow it with a spline.
  const rotation = Math.atan2(axis[1], axis[0]);
  const steps = Math.max(32, Math.ceil(((end - start) * 180) / Math.PI / 2));
  const dense: Vec2[] = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = start + ((end - start) * step) / steps;
    const x = major * Math.cos(t);
    const y = minor * Math.sin(t);
    dense.push([center[0] + x * Math.cos(rotation) - y * Math.sin(rotation), center[1] + x * Math.sin(rotation) + y * Math.cos(rotation)]);
  }
  return curvesFromDensePolyline(dense, layer, toleranceUnits);
}

/** Reads an ASCII DXF into curves. */
export interface DxfReadOptions {
  /** How closely curves that need fitting (NURBS, elliptical arcs) must follow the original, in millimetres (default 0.02). */
  readonly curveToleranceMm?: number;
}

export function parseDxf(text: string, options: DxfReadOptions = {}): ParseResult {
  const pairs = tokenize(text);
  if (typeof pairs === "string") return bad(pairs);
  const sections = sectionsOf(pairs);
  const entitiesSection = sections.get("ENTITIES");
  if (entitiesSection === undefined) return bad("The DXF has no ENTITIES section, so there is nothing to import.", "Choose a DXF that contains drawn geometry (not just blocks or tables).");
  const unreadable = unreadableNumber(entitiesSection) ?? unreadableNumber(sections.get("HEADER") ?? []);
  if (unreadable !== undefined) return bad(unreadable, "Export the drawing from your CAD program again as an ASCII DXF.");
  const units = detectUnits(sections.get("HEADER"));
  const toleranceUnits = Math.max(0.0005, Math.min(1, options.curveToleranceMm ?? 0.02)) / units.mmPerUnit;
  const records = recordsOf(entitiesSection);
  const curves: RawCurve[] = [];
  const skipped: Record<string, number> = {};
  const warnings: string[] = [];
  const skip = (type: string): void => { skipped[type] = (skipped[type] ?? 0) + 1; };
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const layer = first(record, 8) ?? "0";
    const flipX = firstNumber(record, 230, 1) < 0;
    switch (record.type) {
      case "LINE": {
        const a: Vec2 = [firstNumber(record, 10), firstNumber(record, 20)];
        const b: Vec2 = [firstNumber(record, 11), firstNumber(record, 21)];
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0) curves.push({ kind: "line", a, b, layer });
        break;
      }
      case "CIRCLE": {
        const radius = firstNumber(record, 40);
        if (radius > 0) curves.push({ kind: "circle", center: [flipX ? -firstNumber(record, 10) : firstNumber(record, 10), firstNumber(record, 20)], radius, layer });
        break;
      }
      case "ARC": {
        const radius = firstNumber(record, 40);
        if (!(radius > 0)) break;
        let a1 = (firstNumber(record, 50) * Math.PI) / 180;
        let a2 = (firstNumber(record, 51) * Math.PI) / 180;
        let center: Vec2 = [firstNumber(record, 10), firstNumber(record, 20)];
        if (flipX) { center = [-center[0], center[1]]; [a1, a2] = [Math.PI - a2, Math.PI - a1]; }
        let sweep = (((a2 - a1) % TWO_PI) + TWO_PI) % TWO_PI;
        if (sweep < 1e-9) sweep = TWO_PI;
        if (Math.abs(sweep - TWO_PI) < 1e-9) curves.push({ kind: "circle", center, radius, layer });
        else curves.push({ kind: "arc", ...arcFromAngles(center, radius, a1, sweep), layer });
        break;
      }
      case "ELLIPSE":
        curves.push(...ellipseCurves(record, layer, toleranceUnits));
        break;
      case "POINT":
        curves.push({ kind: "point", at: [firstNumber(record, 10), firstNumber(record, 20)], layer });
        break;
      case "LWPOLYLINE": {
        const vertices: { point: Vec2; bulge: number }[] = [];
        let pendingX: number | undefined;
        for (const [code, value] of record.pairs) {
          if (code === 10) pendingX = numberOf(value);
          else if (code === 20 && pendingX !== undefined) { vertices.push({ point: [pendingX, numberOf(value)], bulge: 0 }); pendingX = undefined; }
          else if (code === 42 && vertices.length > 0) vertices[vertices.length - 1] = { ...vertices[vertices.length - 1]!, bulge: numberOf(value) };
        }
        if (vertices.length >= 2) curves.push(...polylineCurves(vertices, (Math.trunc(firstNumber(record, 70)) & 1) === 1, layer, flipX));
        break;
      }
      case "POLYLINE": {
        const flags = Math.trunc(firstNumber(record, 70));
        const vertices: Vertex[] = [];
        let cursor = index + 1;
        for (; cursor < records.length && records[cursor]!.type !== "SEQEND"; cursor += 1) {
          if (records[cursor]!.type !== "VERTEX") break;
          const vertex = records[cursor]!;
          const vertexFlags = Math.trunc(firstNumber(vertex, 70));
          // Spline-fit control vertices (16) and mesh vertices are not on the curve.
          if ((vertexFlags & 16) !== 0 && (flags & 4) !== 0) continue;
          vertices.push({ point: [firstNumber(vertex, 10), firstNumber(vertex, 20)], bulge: firstNumber(vertex, 42, 0) });
        }
        index = cursor;
        if ((flags & 16) !== 0 || (flags & 64) !== 0) { skip("POLYLINE (mesh)"); break; }
        if ((flags & 8) !== 0) warnings.push("A 3D polyline was imported flat (its Z values were dropped).");
        if (vertices.length >= 2) curves.push(...polylineCurves(vertices, (flags & 1) === 1, layer, flipX));
        break;
      }
      case "SPLINE":
        curves.push(...splineCurves(record, layer, toleranceUnits, warnings));
        break;
      case "VERTEX": case "SEQEND": case "ENDBLK": break;
      default: skip(record.type);
    }
  }
  // The layer PS3D writes construction curves on is construction again when a PS3D drawing is read back, whatever the import dialog offers.
  for (let index = 0; index < curves.length; index += 1) if (/^construction$/iu.test(curves[index]!.layer)) curves[index] = { ...curves[index]!, construction: true };
  const counts = new Map<string, number>();
  for (const curve of curves) counts.set(curve.layer, (counts.get(curve.layer) ?? 0) + 1);
  const layers = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  const cutOff = truncationProblem(pairs);
  if (cutOff !== undefined) warnings.unshift(`${cutOff} ${curves.length} curve${curves.length === 1 ? " was" : "s were"} read before the file stops; everything after that point is missing. Export the drawing again before relying on this outline.`);
  const skippedTypes = Object.entries(skipped);
  if (skippedTypes.length > 0) warnings.push(`Skipped ${skippedTypes.map(([type, count]) => `${count} ${type}`).join(", ")}: only lines, arcs, circles, ellipses, polylines, splines and points are imported.`);
  if (units.source !== "file") warnings.push(`The file does not say what unit it uses; ${units.name} are assumed. Check the scale before importing.`);
  const drawing: ParsedDrawing = { format: "dxf", curves, units, warnings, skipped, layers };
  return { ok: true, value: drawing };
}

/** The layers a DXF names as construction by their name (CONSTRUCTION, CONSTR, REFERENCE, GUIDE ...). */
export function defaultConstructionLayers(layers: readonly { readonly name: string }[]): readonly string[] {
  return layers.filter((layer) => /constr|reference|guide|aux|layout|defpoints/iu.test(layer.name)).map((layer) => layer.name);
}
