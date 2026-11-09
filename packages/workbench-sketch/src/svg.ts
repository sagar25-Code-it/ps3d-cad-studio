import { failure, type SketchEntity, type Vec2, type WorkbenchResult, type WorkbenchSketch } from "../../workbench-core/src/index.js";
import { splineAsBezierChain } from "./dxf.js";
import { arcExtremePoints, arcGeometry, catmullRomSamples, curvesFromDensePolyline, type DetectedUnits, type ParseResult, type ParsedDrawing, type RawCurve } from "./sketch-exchange.js";

/**
 * SVG for sketches.
 *
 * Writer: millimetres (`width`/`height` in mm with a matching viewBox), Y flipped so the picture is upright, profile curves in one
 * group and construction curves in a dashed grey group. Lines, circles, ellipses and arcs map to line, circle, ellipse and path A;
 * splines to cubic path C segments.
 *
 * Reader: path (M L H V C S Q T A Z, absolute and relative, compact numbers and flags), rect (with rounded corners), circle, ellipse,
 * line, polyline and polygon, with `transform` on any ancestor (matrix, translate, scale, rotate, skewX, skewY). The Y axis is flipped
 * so the drawing comes in upright. Circular arcs stay arcs (also under rotation, mirroring and uniform scaling); Bezier curves and
 * elliptical arcs become fit-point splines within 0.005 mm of the original. Text, images, gradients, clip paths and `use` are skipped
 * and counted. The XML reader never expands entities and never fetches anything.
 */

// ---------------------------------------------------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------------------------------------------------

export interface SvgWriteOptions {
  readonly includeConstruction?: boolean;
  readonly title?: string;
}

function n(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const text = value.toFixed(4);
  const trimmed = text.includes(".") ? text.replace(/0+$/u, "").replace(/\.$/u, "") : text;
  return trimmed === "-0" ? "0" : trimmed;
}

function escapeXml(text: string): string {
  return text.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;");
}

function extentOf(entity: SketchEntity): readonly Vec2[] {
  switch (entity.kind) {
    case "line": return [entity.start, entity.end];
    case "arc": return arcExtremePoints(entity.start, entity.mid, entity.end);
    case "circle": return [[entity.center[0] - entity.radiusMm, entity.center[1] - entity.radiusMm], [entity.center[0] + entity.radiusMm, entity.center[1] + entity.radiusMm]];
    case "ellipse": {
      const radians = (entity.rotationDeg * Math.PI) / 180;
      const hx = Math.hypot(entity.majorRadiusMm * Math.cos(radians), entity.minorRadiusMm * Math.sin(radians));
      const hy = Math.hypot(entity.majorRadiusMm * Math.sin(radians), entity.minorRadiusMm * Math.cos(radians));
      return [[entity.center[0] - hx, entity.center[1] - hy], [entity.center[0] + hx, entity.center[1] + hy]];
    }
    case "rectangle": { const half = Math.hypot(entity.widthMm, entity.heightMm) / 2; return [[entity.center[0] - half, entity.center[1] - half], [entity.center[0] + half, entity.center[1] + half]]; }
    case "point": return [entity.point];
    case "spline": return catmullRomSamples(entity.fitPoints, 8);
  }
}

/** SVG text for the visible curves of a sketch, in millimetres. */
export function writeSketchSvg(sketch: WorkbenchSketch, options: SvgWriteOptions = {}): string {
  const includeConstruction = options.includeConstruction !== false;
  const entities = sketch.entities.filter((entity) => entity.visible !== false && (includeConstruction || !entity.construction));
  const points = entities.flatMap(extentOf);
  const minX = points.length === 0 ? 0 : Math.min(...points.map((p) => p[0]));
  const maxX = points.length === 0 ? 0 : Math.max(...points.map((p) => p[0]));
  const minY = points.length === 0 ? 0 : Math.min(...points.map((p) => p[1]));
  const maxY = points.length === 0 ? 0 : Math.max(...points.map((p) => p[1]));
  const pad = 1;
  const width = maxX - minX + 2 * pad;
  const height = maxY - minY + 2 * pad;
  const x = (value: number): string => n(value - minX + pad);
  const y = (value: number): string => n(maxY - value + pad);
  const element = (entity: SketchEntity): string => {
    switch (entity.kind) {
      case "line": return `<line x1="${x(entity.start[0])}" y1="${y(entity.start[1])}" x2="${x(entity.end[0])}" y2="${y(entity.end[1])}"/>`;
      case "circle": return `<circle cx="${x(entity.center[0])}" cy="${y(entity.center[1])}" r="${n(entity.radiusMm)}"/>`;
      case "ellipse": return `<ellipse cx="${x(entity.center[0])}" cy="${y(entity.center[1])}" rx="${n(entity.majorRadiusMm)}" ry="${n(entity.minorRadiusMm)}"${Math.abs(entity.rotationDeg) < 1e-9 ? "" : ` transform="rotate(${n(-entity.rotationDeg)} ${x(entity.center[0])} ${y(entity.center[1])})"`}/>`;
      case "arc": {
        const geometry = arcGeometry(entity.start, entity.mid, entity.end);
        if (geometry === undefined) return `<line x1="${x(entity.start[0])}" y1="${y(entity.start[1])}" x2="${x(entity.end[0])}" y2="${y(entity.end[1])}"/>`;
        const large = Math.abs(geometry.sweep) > Math.PI ? 1 : 0;
        const sweep = geometry.sweep > 0 ? 0 : 1;
        return `<path d="M${x(entity.start[0])} ${y(entity.start[1])}A${n(geometry.radius)} ${n(geometry.radius)} 0 ${large} ${sweep} ${x(entity.end[0])} ${y(entity.end[1])}"/>`;
      }
      case "rectangle": {
        const radians = (entity.rotationDeg * Math.PI) / 180;
        const corner = (sx: number, sy: number): string => {
          const cx = (sx * entity.widthMm) / 2;
          const cy = (sy * entity.heightMm) / 2;
          return `${x(entity.center[0] + cx * Math.cos(radians) - cy * Math.sin(radians))},${y(entity.center[1] + cx * Math.sin(radians) + cy * Math.cos(radians))}`;
        };
        return `<polygon points="${corner(-1, -1)} ${corner(1, -1)} ${corner(1, 1)} ${corner(-1, 1)}"/>`;
      }
      case "point": return `<path class="point" d="M${x(entity.point[0])} ${y(entity.point[1])}"/>`;
      case "spline": {
        const chain = splineAsBezierChain(entity.fitPoints);
        let d = `M${x(chain.controls[0]![0])} ${y(chain.controls[0]![1])}`;
        for (let index = 1; index + 2 < chain.controls.length + 0; index += 3) {
          const c1 = chain.controls[index]!;
          const c2 = chain.controls[index + 1]!;
          const end = chain.controls[index + 2]!;
          d += `C${x(c1[0])} ${y(c1[1])} ${x(c2[0])} ${y(c2[1])} ${x(end[0])} ${y(end[1])}`;
        }
        // The fit points ride along (in the same coordinates as the path) so PS3D reads the same spline back, not a refit of the curve.
        const fit = entity.fitPoints.map((point) => `${x(point[0])} ${y(point[1])}`).join(" ");
        return `<path d="${d}" data-ps3d-fit="${fit}"/>`;
      }
    }
  };
  const profile = entities.filter((entity) => !entity.construction).map(element);
  const construction = entities.filter((entity) => entity.construction).map(element);
  const title = escapeXml(options.title ?? sketch.name);
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    // data-ps3d-origin: the sketch point (mm) that the drawing's own 0,0 (with its Y axis turned up) stands for, so PS3D puts the curves back where they were.
    `<svg xmlns="http://www.w3.org/2000/svg" width="${n(width)}mm" height="${n(height)}mm" viewBox="0 0 ${n(width)} ${n(height)}" data-ps3d-origin="${Number((minX - pad).toFixed(9))} ${Number((maxY + pad).toFixed(9))}">`,
    `<title>${title}</title>`,
    `<g id="profile" fill="none" stroke="#000000" stroke-width="0.1" stroke-linecap="round" stroke-linejoin="round">${profile.join("")}</g>`,
    ...(construction.length === 0 ? [] : [`<g id="construction" fill="none" stroke="#808080" stroke-width="0.1" stroke-dasharray="2 1">${construction.join("")}</g>`]),
    `</svg>`,
    ``
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------------------------------
// Minimal XML reader
// ---------------------------------------------------------------------------------------------------------------------

interface XmlElement {
  readonly name: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly children: XmlElement[];
}

const MAX_ELEMENTS = 100_000;
const MAX_DEPTH = 256;

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/giu, (_match, entity: string) => {
    const lower = entity.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return "\"";
    if (lower === "apos") return "'";
    const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : "";
  });
}

function parseXml(text: string): XmlElement | string {
  const root: XmlElement = { name: "#document", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let index = 0;
  let count = 0;
  const length = text.length;
  while (index < length) {
    const open = text.indexOf("<", index);
    if (open < 0) break;
    if (text.startsWith("<!--", open)) {
      const close = text.indexOf("-->", open + 4);
      if (close < 0) return "The SVG has an unterminated comment.";
      index = close + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", open)) {
      const close = text.indexOf("]]>", open + 9);
      if (close < 0) return "The SVG has an unterminated CDATA section.";
      index = close + 3;
      continue;
    }
    if (text.startsWith("<?", open)) {
      const close = text.indexOf("?>", open + 2);
      if (close < 0) return "The SVG has an unterminated processing instruction.";
      index = close + 2;
      continue;
    }
    if (text.startsWith("<!", open)) {
      // DOCTYPE, possibly with an internal subset in brackets. Entities declared there are ignored, never expanded.
      let depth = 0;
      let cursor = open + 2;
      for (; cursor < length; cursor += 1) {
        const char = text[cursor]!;
        if (char === "[") depth += 1;
        else if (char === "]") depth -= 1;
        else if (char === ">" && depth <= 0) break;
      }
      if (cursor >= length) return "The SVG has an unterminated declaration.";
      index = cursor + 1;
      continue;
    }
    if (text[open + 1] === "/") {
      const close = text.indexOf(">", open + 2);
      if (close < 0) return "The SVG has an unterminated closing tag.";
      const name = text.slice(open + 2, close).trim();
      if (stack.length > 1 && stack[stack.length - 1]!.name === name) stack.pop();
      else if (stack.length > 1) {
        // Mismatched: close up to the matching open element if there is one.
        const at = stack.map((element) => element.name).lastIndexOf(name);
        if (at > 0) stack.length = at;
        else return `The SVG is not well formed: </${name}> has no matching opening tag.`;
      }
      index = close + 1;
      continue;
    }
    // Start tag: find the end, skipping quoted attribute values.
    let cursor = open + 1;
    let quote: string | undefined;
    for (; cursor < length; cursor += 1) {
      const char = text[cursor]!;
      if (quote !== undefined) { if (char === quote) quote = undefined; continue; }
      if (char === "\"" || char === "'") quote = char;
      else if (char === ">") break;
    }
    if (cursor >= length) return "The SVG ends inside a tag.";
    let inner = text.slice(open + 1, cursor);
    const selfClosing = inner.endsWith("/");
    if (selfClosing) inner = inner.slice(0, -1);
    const nameMatch = /^\s*([^\s/>]+)/u.exec(inner);
    if (nameMatch === null) return "The SVG has a tag without a name.";
    const name = nameMatch[1]!;
    const attrs: Record<string, string> = {};
    const attrPattern = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/gu;
    let match: RegExpExecArray | null;
    const rest = inner.slice(nameMatch[0].length);
    while ((match = attrPattern.exec(rest)) !== null) attrs[match[1]!] = decodeEntities(match[3] ?? match[4] ?? "");
    const element: XmlElement = { name, attrs, children: [] };
    count += 1;
    if (count > MAX_ELEMENTS) return `The SVG has more than ${MAX_ELEMENTS} elements; simplify it before importing.`;
    stack[stack.length - 1]!.children.push(element);
    if (!selfClosing) {
      if (stack.length > MAX_DEPTH) return "The SVG is nested too deeply.";
      stack.push(element);
    }
    index = cursor + 1;
  }
  const svg = root.children.find((child) => localName(child.name) === "svg");
  // Elements still open at the end of the text: the file stops before its closing tags (a half-saved or half-downloaded drawing).
  if (svg !== undefined && stack.length > 1) UNCLOSED_ELEMENTS.set(svg, stack.slice(1).map((element) => element.name));
  return svg ?? "There is no <svg> element in this file.";
}

/** The names of the elements a parsed document left open, keyed by its root, so the reader can say the file was cut off. */
const UNCLOSED_ELEMENTS = new WeakMap<XmlElement, readonly string[]>();

function localName(name: string): string {
  const colon = name.indexOf(":");
  return (colon >= 0 ? name.slice(colon + 1) : name).toLowerCase();
}

// ---------------------------------------------------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------------------------------------------------

/** [a, b, c, d, e, f]: x' = a x + c y + e, y' = b x + d y + f. */
type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

function multiply(m: Matrix, k: Matrix): Matrix {
  return [
    m[0] * k[0] + m[2] * k[1], m[1] * k[0] + m[3] * k[1],
    m[0] * k[2] + m[2] * k[3], m[1] * k[2] + m[3] * k[3],
    m[0] * k[4] + m[2] * k[5] + m[4], m[1] * k[4] + m[3] * k[5] + m[5]
  ];
}

const apply = (m: Matrix, p: Vec2): Vec2 => [m[0] * p[0] + m[2] * p[1] + m[4], m[1] * p[0] + m[3] * p[1] + m[5]];

function parseTransform(text: string | undefined, warnings: Set<string>): Matrix {
  if (text === undefined || text.trim() === "") return IDENTITY;
  let matrix = IDENTITY;
  const pattern = /([a-zA-Z]+)\s*\(([^)]*)\)/gu;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const values = (match[2] ?? "").split(/[\s,]+/u).filter((part) => part !== "").map(Number);
    if (values.some((value) => !Number.isFinite(value))) { warnings.add("A transform with unreadable numbers was ignored."); continue; }
    const name = match[1]!;
    let step: Matrix | undefined;
    if (name === "matrix" && values.length === 6) step = values as unknown as Matrix;
    else if (name === "translate" && values.length >= 1) step = [1, 0, 0, 1, values[0]!, values[1] ?? 0];
    else if (name === "scale" && values.length >= 1) step = [values[0]!, 0, 0, values[1] ?? values[0]!, 0, 0];
    else if (name === "rotate" && values.length >= 1) {
      const radians = (values[0]! * Math.PI) / 180;
      const cos = Math.cos(radians);
      const sin = Math.sin(radians);
      const rotation: Matrix = [cos, sin, -sin, cos, 0, 0];
      step = values.length >= 3 ? multiply(multiply([1, 0, 0, 1, values[1]!, values[2]!], rotation), [1, 0, 0, 1, -values[1]!, -values[2]!]) : rotation;
    } else if (name === "skewX" && values.length === 1) step = [1, 0, Math.tan((values[0]! * Math.PI) / 180), 1, 0, 0];
    else if (name === "skewY" && values.length === 1) step = [1, Math.tan((values[0]! * Math.PI) / 180), 0, 1, 0, 0];
    if (step === undefined) { warnings.add(`The transform "${name}" was not understood and was ignored.`); continue; }
    matrix = multiply(matrix, step);
  }
  return matrix;
}

/** Whether the matrix turns circles into circles (rotation, mirroring and uniform scale). */
function isSimilarity(m: Matrix): boolean {
  const column1 = Math.hypot(m[0], m[1]);
  const column2 = Math.hypot(m[2], m[3]);
  const dot = m[0] * m[2] + m[1] * m[3];
  return column1 > 1e-12 && Math.abs(column1 - column2) <= 1e-9 * Math.max(column1, column2) && Math.abs(dot) <= 1e-9 * column1 * column2;
}

function scaleOf(m: Matrix): number {
  return Math.hypot(m[0], m[1]);
}

// ---------------------------------------------------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------------------------------------------------

type Segment =
  | { readonly kind: "line"; readonly a: Vec2; readonly b: Vec2 }
  | { readonly kind: "cubic"; readonly p0: Vec2; readonly p1: Vec2; readonly p2: Vec2; readonly p3: Vec2 }
  | { readonly kind: "arc"; readonly from: Vec2; readonly to: Vec2; readonly rx: number; readonly ry: number; readonly rotationDeg: number; readonly large: boolean; readonly sweep: boolean };

interface PathParse {
  readonly subpaths: readonly (readonly Segment[])[];
  readonly lonePoints: readonly Vec2[];
  readonly problem?: string;
}

function parsePathData(d: string): PathParse {
  const subpaths: Segment[][] = [];
  const lonePoints: Vec2[] = [];
  let current: Segment[] = [];
  let position: Vec2 = [0, 0];
  let start: Vec2 = [0, 0];
  let lastCubicControl: Vec2 | undefined;
  let lastQuadControl: Vec2 | undefined;
  let index = 0;
  let command = "";
  let problem: string | undefined;
  const length = d.length;
  const skipSeparators = (): void => { while (index < length && /[\s,]/u.test(d[index]!)) index += 1; };
  const numberPattern = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/uy;
  const readNumber = (): number | undefined => {
    skipSeparators();
    numberPattern.lastIndex = index;
    const match = numberPattern.exec(d);
    if (match === null) return undefined;
    index = numberPattern.lastIndex;
    return Number(match[0]);
  };
  const readFlag = (): boolean | undefined => {
    skipSeparators();
    const char = d[index];
    if (char !== "0" && char !== "1") return undefined;
    index += 1;
    return char === "1";
  };
  const flush = (): void => {
    if (current.length > 0) subpaths.push(current);
    current = [];
  };
  const quadToCubic = (p0: Vec2, q: Vec2, p3: Vec2): Segment => ({ kind: "cubic", p0, p1: [p0[0] + (2 / 3) * (q[0] - p0[0]), p0[1] + (2 / 3) * (q[1] - p0[1])], p2: [p3[0] + (2 / 3) * (q[0] - p3[0]), p3[1] + (2 / 3) * (q[1] - p3[1])], p3 });
  while (index < length) {
    skipSeparators();
    if (index >= length) break;
    const char = d[index]!;
    if (/[a-zA-Z]/u.test(char)) {
      command = char;
      index += 1;
      if (command === "Z" || command === "z") {
        if (current.length > 0 && (position[0] !== start[0] || position[1] !== start[1])) current.push({ kind: "line", a: position, b: start });
        position = start;
        flush();
        lastCubicControl = undefined;
        lastQuadControl = undefined;
        continue;
      }
    } else if (command === "") {
      problem = "The path data does not start with a command.";
      break;
    } else if (command === "Z" || command === "z") {
      problem = `Unexpected number after Z at character ${index + 1}.`;
      break;
    }
    const relative = command === command.toLowerCase();
    const upper = command.toUpperCase();
    const need = upper === "M" || upper === "L" || upper === "T" ? 2 : upper === "H" || upper === "V" ? 1 : upper === "C" ? 6 : upper === "S" || upper === "Q" ? 4 : upper === "A" ? 7 : 0;
    if (need === 0) { problem = `Unknown path command "${command}".`; break; }
    const args: number[] = [];
    let flagsOk = true;
    for (let k = 0; k < need; k += 1) {
      if (upper === "A" && (k === 3 || k === 4)) {
        const flag = readFlag();
        if (flag === undefined) { flagsOk = false; break; }
        args.push(flag ? 1 : 0);
        continue;
      }
      const value = readNumber();
      if (value === undefined) { flagsOk = false; break; }
      args.push(value);
    }
    if (!flagsOk) { problem = `The path data is incomplete near character ${Math.min(index + 1, length)} (command ${command}).`; break; }
    const ox = relative ? position[0] : 0;
    const oy = relative ? position[1] : 0;
    switch (upper) {
      case "M": {
        flush();
        position = [args[0]! + ox, args[1]! + oy];
        start = position;
        command = relative ? "l" : "L";
        lastCubicControl = undefined; lastQuadControl = undefined;
        // A moveto followed by nothing else is a lone point; keep it when the next token is another command.
        const save = index;
        skipSeparators();
        if (index >= length || /[a-zA-Z]/u.test(d[index]!)) { if (index >= length || /[Mm]/u.test(d[index]!)) lonePoints.push(position); }
        index = save;
        break;
      }
      case "L": { const to: Vec2 = [args[0]! + ox, args[1]! + oy]; current.push({ kind: "line", a: position, b: to }); position = to; lastCubicControl = undefined; lastQuadControl = undefined; break; }
      case "H": { const to: Vec2 = [args[0]! + ox, position[1]]; current.push({ kind: "line", a: position, b: to }); position = to; lastCubicControl = undefined; lastQuadControl = undefined; break; }
      case "V": { const to: Vec2 = [position[0], args[0]! + oy]; current.push({ kind: "line", a: position, b: to }); position = to; lastCubicControl = undefined; lastQuadControl = undefined; break; }
      case "C": {
        const p1: Vec2 = [args[0]! + ox, args[1]! + oy];
        const p2: Vec2 = [args[2]! + ox, args[3]! + oy];
        const p3: Vec2 = [args[4]! + ox, args[5]! + oy];
        current.push({ kind: "cubic", p0: position, p1, p2, p3 });
        lastCubicControl = p2; lastQuadControl = undefined; position = p3;
        break;
      }
      case "S": {
        const p1: Vec2 = lastCubicControl === undefined ? position : [2 * position[0] - lastCubicControl[0], 2 * position[1] - lastCubicControl[1]];
        const p2: Vec2 = [args[0]! + ox, args[1]! + oy];
        const p3: Vec2 = [args[2]! + ox, args[3]! + oy];
        current.push({ kind: "cubic", p0: position, p1, p2, p3 });
        lastCubicControl = p2; lastQuadControl = undefined; position = p3;
        break;
      }
      case "Q": {
        const q: Vec2 = [args[0]! + ox, args[1]! + oy];
        const p3: Vec2 = [args[2]! + ox, args[3]! + oy];
        current.push(quadToCubic(position, q, p3));
        lastQuadControl = q; lastCubicControl = undefined; position = p3;
        break;
      }
      case "T": {
        const q: Vec2 = lastQuadControl === undefined ? position : [2 * position[0] - lastQuadControl[0], 2 * position[1] - lastQuadControl[1]];
        const p3: Vec2 = [args[0]! + ox, args[1]! + oy];
        current.push(quadToCubic(position, q, p3));
        lastQuadControl = q; lastCubicControl = undefined; position = p3;
        break;
      }
      case "A": {
        const to: Vec2 = [args[5]! + ox, args[6]! + oy];
        if (to[0] !== position[0] || to[1] !== position[1]) current.push({ kind: "arc", from: position, to, rx: Math.abs(args[0]!), ry: Math.abs(args[1]!), rotationDeg: args[2]!, large: args[3] === 1, sweep: args[4] === 1 });
        position = to; lastCubicControl = undefined; lastQuadControl = undefined;
        break;
      }
    }
  }
  flush();
  return { subpaths, lonePoints, ...(problem === undefined ? {} : { problem }) };
}

interface CenterArc { readonly center: Vec2; readonly rx: number; readonly ry: number; readonly phi: number; readonly theta1: number; readonly dtheta: number }

/** SVG endpoint arc to centre parameters (SVG 1.1 appendix F.6.5), with radii enlarged when they are too small. */
function centerArc(segment: Extract<Segment, { kind: "arc" }>): CenterArc | undefined {
  let { rx, ry } = segment;
  if (rx < 1e-12 || ry < 1e-12) return undefined;
  const phi = (segment.rotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);
  const dx = (segment.from[0] - segment.to[0]) / 2;
  const dy = (segment.from[1] - segment.to[1]) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) { const root = Math.sqrt(lambda); rx *= root; ry *= root; }
  const numerator = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const denominator = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const factor = (segment.large === segment.sweep ? -1 : 1) * Math.sqrt(Math.max(0, denominator === 0 ? 0 : numerator / denominator));
  const cxp = (factor * rx * y1p) / ry;
  const cyp = (-factor * ry * x1p) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (segment.from[0] + segment.to[0]) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (segment.from[1] + segment.to[1]) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number): number => {
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    const cosine = (ux * vx + uy * vy) / (Math.hypot(ux, uy) * Math.hypot(vx, vy));
    return sign * Math.acos(Math.max(-1, Math.min(1, cosine)));
  };
  const theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!segment.sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (segment.sweep && dtheta < 0) dtheta += 2 * Math.PI;
  return { center: [cx, cy], rx, ry, phi, theta1, dtheta };
}

function arcPoint(arc: CenterArc, theta: number): Vec2 {
  const x = arc.rx * Math.cos(theta);
  const y = arc.ry * Math.sin(theta);
  return [arc.center[0] + x * Math.cos(arc.phi) - y * Math.sin(arc.phi), arc.center[1] + x * Math.sin(arc.phi) + y * Math.cos(arc.phi)];
}

function arcAsCubics(arc: CenterArc): readonly Extract<Segment, { kind: "cubic" }>[] {
  const pieces = Math.max(1, Math.ceil(Math.abs(arc.dtheta) / (Math.PI / 2) - 1e-9));
  const step = arc.dtheta / pieces;
  const k = (4 / 3) * Math.tan(step / 4);
  const result: Extract<Segment, { kind: "cubic" }>[] = [];
  for (let piece = 0; piece < pieces; piece += 1) {
    const t1 = arc.theta1 + piece * step;
    const t2 = t1 + step;
    const derivative = (theta: number): Vec2 => {
      const dx = -arc.rx * Math.sin(theta);
      const dy = arc.ry * Math.cos(theta);
      return [dx * Math.cos(arc.phi) - dy * Math.sin(arc.phi), dx * Math.sin(arc.phi) + dy * Math.cos(arc.phi)];
    };
    const p0 = arcPoint(arc, t1);
    const p3 = arcPoint(arc, t2);
    const d1 = derivative(t1);
    const d2 = derivative(t2);
    result.push({ kind: "cubic", p0, p1: [p0[0] + k * d1[0], p0[1] + k * d1[1]], p2: [p3[0] - k * d2[0], p3[1] - k * d2[1]], p3 });
  }
  return result;
}

function cubicPoint(c: Extract<Segment, { kind: "cubic" }>, t: number): Vec2 {
  const u = 1 - t;
  return [
    u * u * u * c.p0[0] + 3 * u * u * t * c.p1[0] + 3 * u * t * t * c.p2[0] + t * t * t * c.p3[0],
    u * u * u * c.p0[1] + 3 * u * u * t * c.p1[1] + 3 * u * t * t * c.p2[1] + t * t * t * c.p3[1]
  ];
}

function cubicTangent(c: Extract<Segment, { kind: "cubic" }>, atEnd: boolean): number {
  const a = atEnd ? c.p3 : c.p0;
  const candidates: readonly Vec2[] = atEnd ? [c.p2, c.p1, c.p0] : [c.p1, c.p2, c.p3];
  for (const b of candidates) if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 1e-12) return atEnd ? Math.atan2(a[1] - b[1], a[0] - b[0]) : Math.atan2(b[1] - a[1], b[0] - a[0]);
  return 0;
}

function mapSegment(segment: Segment, m: Matrix): Segment {
  switch (segment.kind) {
    case "line": return { kind: "line", a: apply(m, segment.a), b: apply(m, segment.b) };
    case "cubic": return { kind: "cubic", p0: apply(m, segment.p0), p1: apply(m, segment.p1), p2: apply(m, segment.p2), p3: apply(m, segment.p3) };
    case "arc": return segment;
  }
}

interface Context {
  readonly warnings: Set<string>;
  readonly toleranceUnits: number;
}

/** Converts the subpaths of one element (already in drawing coordinates) into sketch curves. */
function subpathCurves(segments: readonly Segment[], m: Matrix, layer: string, context: Context): readonly RawCurve[] {
  const curves: RawCurve[] = [];
  const similarity = isSimilarity(m);
  const smooth: Extract<Segment, { kind: "cubic" }>[] = [];
  const flushRun = (): void => {
    if (smooth.length === 0) return;
    // Split the run where the tangent turns sharply, then fit splines through each smooth piece.
    let piece: Extract<Segment, { kind: "cubic" }>[] = [];
    const finishPiece = (): void => {
      if (piece.length === 0) return;
      const dense: Vec2[] = [piece[0]!.p0];
      for (const cubic of piece) {
        const polygon = Math.hypot(cubic.p1[0] - cubic.p0[0], cubic.p1[1] - cubic.p0[1]) + Math.hypot(cubic.p2[0] - cubic.p1[0], cubic.p2[1] - cubic.p1[1]) + Math.hypot(cubic.p3[0] - cubic.p2[0], cubic.p3[1] - cubic.p2[1]);
        const steps = Math.max(16, Math.min(400, Math.ceil(Math.sqrt(polygon / Math.max(context.toleranceUnits, 1e-9)))));
        for (let step = 1; step <= steps; step += 1) dense.push(step === steps ? cubic.p3 : cubicPoint(cubic, step / steps));
      }
      curves.push(...curvesFromDensePolyline(dense, layer, context.toleranceUnits));
      piece = [];
    };
    smooth.forEach((cubic, index) => {
      if (index > 0) {
        const before = cubicTangent(smooth[index - 1]!, true);
        const after = cubicTangent(cubic, false);
        let turn = Math.abs(after - before);
        if (turn > Math.PI) turn = 2 * Math.PI - turn;
        if (turn > (8 * Math.PI) / 180) finishPiece();
      }
      piece.push(cubic);
    });
    finishPiece();
    smooth.length = 0;
  };
  for (const segment of segments) {
    if (segment.kind === "line") {
      flushRun();
      const a = apply(m, segment.a);
      const b = apply(m, segment.b);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0) curves.push({ kind: "line", a, b, layer });
    } else if (segment.kind === "cubic") {
      smooth.push(mapSegment(segment, m) as Extract<Segment, { kind: "cubic" }>);
    } else {
      const arc = centerArc(segment);
      if (arc === undefined) {
        flushRun();
        const a = apply(m, segment.from);
        const b = apply(m, segment.to);
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0) curves.push({ kind: "line", a, b, layer });
      } else if (similarity && Math.abs(arc.rx - arc.ry) <= 1e-9 * arc.rx) {
        flushRun();
        const start = apply(m, arcPoint(arc, arc.theta1));
        const mid = apply(m, arcPoint(arc, arc.theta1 + arc.dtheta / 2));
        const end = apply(m, arcPoint(arc, arc.theta1 + arc.dtheta));
        curves.push({ kind: "arc", start, mid, end, layer });
      } else {
        for (const cubic of arcAsCubics(arc)) smooth.push(mapSegment(cubic, m) as Extract<Segment, { kind: "cubic" }>);
      }
    }
  }
  flushRun();
  return curves;
}

/** Axes and angle of the image of a circle or ellipse (radii `rx`, `ry`) under a linear map. */
function ellipseUnder(m: Matrix, center: Vec2, rx: number, ry: number): RawCurve | undefined {
  const a = m[0] * rx;
  const b = m[1] * rx;
  const c = m[2] * ry;
  const d = m[3] * ry;
  const e = (a + d) / 2;
  const f = (a - d) / 2;
  const g = (b + c) / 2;
  const h = (b - c) / 2;
  const q = Math.hypot(e, h);
  const r = Math.hypot(f, g);
  const sx = q + r;
  const sy = q - r;
  const a1 = Math.atan2(g, f);
  const a2 = Math.atan2(h, e);
  const phi = (a2 + a1) / 2;
  const major = Math.max(Math.abs(sx), Math.abs(sy));
  const minor = Math.min(Math.abs(sx), Math.abs(sy));
  if (major < 1e-12) return undefined;
  const rotationDeg = ((Math.abs(sx) >= Math.abs(sy) ? phi : phi + Math.PI / 2) * 180) / Math.PI;
  return { kind: "ellipse", center: apply(m, center), major, minor, rotationDeg, layer: "" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------------------------------------------------

const MM_PER_CSS_UNIT: Readonly<Record<string, number>> = { "": 25.4 / 96, px: 25.4 / 96, mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, m: 1000, q: 0.25 };

function lengthMm(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const match = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z%]*)\s*$/u.exec(text);
  if (match === null) return undefined;
  const unit = (match[2] ?? "").toLowerCase();
  if (unit === "%" || unit === "em" || unit === "ex") return undefined;
  const factor = MM_PER_CSS_UNIT[unit];
  return factor === undefined ? undefined : Number(match[1]) * factor;
}

function detectUnits(svg: XmlElement): DetectedUnits {
  const box = (svg.attrs["viewBox"] ?? "").split(/[\s,]+/u).filter((part) => part !== "").map(Number);
  const widthMm = lengthMm(svg.attrs["width"]);
  if (box.length === 4 && box.every(Number.isFinite) && box[2]! > 0 && widthMm !== undefined && widthMm > 0) {
    const hasPhysicalUnit = /[a-zA-Z]/u.test(svg.attrs["width"] ?? "");
    const perUnit = widthMm / box[2]!;
    return { name: Math.abs(perUnit - 1) < 1e-9 ? "millimetres" : Math.abs(perUnit - 25.4 / 96) < 1e-9 ? "pixels (96 per inch)" : `${Math.round(perUnit * 1e6) / 1e6} mm per user unit`, mmPerUnit: perUnit, source: hasPhysicalUnit ? "file" : "assumed" };
  }
  return { name: "pixels (96 per inch)", mmPerUnit: 25.4 / 96, source: "assumed" };
}

// ---------------------------------------------------------------------------------------------------------------------
// Reader
// ---------------------------------------------------------------------------------------------------------------------

const SKIPPED_CONTAINERS = new Set(["defs", "clippath", "mask", "pattern", "symbol", "marker", "metadata", "title", "desc", "style", "script", "lineargradient", "radialgradient", "filter", "foreignobject"]);
const SHAPES = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);

function styleValue(element: XmlElement, property: string): string | undefined {
  const own = element.attrs[property];
  if (own !== undefined) return own.trim();
  const style = element.attrs["style"];
  if (style === undefined) return undefined;
  for (const declaration of style.split(";")) {
    const [name, value] = declaration.split(":");
    if (name?.trim().toLowerCase() === property && value !== undefined) return value.trim();
  }
  return undefined;
}

function number(text: string | undefined, fallback = 0): number {
  if (text === undefined) return fallback;
  const parsed = Number.parseFloat(text);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The fit points a PS3D-written path carries (3 to 64 of them), mapped through the element's matrix; undefined when absent or unusable. */
function fitPointsOf(text: string | undefined, matrix: Matrix): Vec2[] | undefined {
  if (text === undefined) return undefined;
  const values = text.split(/[\s,]+/u).filter((part) => part !== "").map(Number);
  if (values.length < 6 || values.length % 2 === 1 || values.length > 128 || values.some((value) => !Number.isFinite(value))) return undefined;
  const points: Vec2[] = [];
  for (let index = 0; index + 1 < values.length; index += 2) points.push(apply(matrix, [values[index]!, values[index + 1]!]));
  return points;
}

function shiftedCurve(curve: RawCurve, shift: Vec2): RawCurve {
  const move = (point: Vec2): Vec2 => [point[0] + shift[0], point[1] + shift[1]];
  switch (curve.kind) {
    case "line": return { ...curve, a: move(curve.a), b: move(curve.b) };
    case "arc": return { ...curve, start: move(curve.start), mid: move(curve.mid), end: move(curve.end) };
    case "circle": return { ...curve, center: move(curve.center) };
    case "ellipse": return { ...curve, center: move(curve.center) };
    case "spline": return { ...curve, fit: curve.fit.map(move) };
    case "point": return { ...curve, at: move(curve.at) };
  }
}

/** Reads an SVG into curves. The Y axis is flipped so the drawing is upright in the sketch. */
export interface SvgReadOptions {
  /** How closely Bezier curves and elliptical arcs must be followed by the fit-point splines, in millimetres (default 0.02). */
  readonly curveToleranceMm?: number;
}

export function parseSvg(text: string, options: SvgReadOptions = {}): ParseResult {
  const trimmed = text.replace(/^﻿/u, "");
  if (trimmed.trim() === "") return failure("INVALID_OPERATION", "The file is empty.", [], "Choose an SVG file.");
  const svg = parseXml(trimmed);
  if (typeof svg === "string") return failure("INVALID_OPERATION", svg, [], "Choose a plain SVG file (save as 'Plain SVG' from Inkscape or 'SVG' from Illustrator).");
  const units = detectUnits(svg);
  const context: Context = { warnings: new Set<string>(), toleranceUnits: Math.max(0.0005, Math.min(1, options.curveToleranceMm ?? 0.02)) / units.mmPerUnit };
  const curves: RawCurve[] = [];
  const skipped: Record<string, number> = {};
  const skip = (name: string): void => { skipped[name] = (skipped[name] ?? 0) + 1; };
  const flip: Matrix = [1, 0, 0, -1, 0, 0];
  const visit = (element: XmlElement, parent: Matrix, layer: string): void => {
    const name = localName(element.name);
    if (SKIPPED_CONTAINERS.has(name)) return;
    if (styleValue(element, "display") === "none" || styleValue(element, "visibility") === "hidden") return;
    const matrix = multiply(parent, parseTransform(element.attrs["transform"], context.warnings));
    const label = element.attrs["inkscape:label"] ?? element.attrs["id"];
    const here = (name === "g" || name === "svg") && label !== undefined && (element.attrs["inkscape:groupmode"] === "layer" || layer === "SVG") ? label : layer;
    if (name === "svg" || name === "g" || name === "a" || name === "switch") {
      for (const child of element.children) visit(child, matrix, here);
      return;
    }
    if (!SHAPES.has(name)) {
      if (name === "text" || name === "image" || name === "use" || name === "tspan") skip(name);
      return;
    }
    const attr = element.attrs;
    const m = multiply(flip, matrix);
    const construction = /^construction$/iu.test(here);
    const push = (list: readonly RawCurve[]): void => { for (const curve of list) curves.push({ ...curve, layer: here, ...(construction ? { construction: true } : {}) }); };
    if (name === "line") {
      const a = apply(m, [number(attr["x1"]), number(attr["y1"])]);
      const b = apply(m, [number(attr["x2"]), number(attr["y2"])]);
      if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0) push([{ kind: "line", a, b, layer: here }]);
    } else if (name === "polyline" || name === "polygon") {
      const values = (attr["points"] ?? "").split(/[\s,]+/u).filter((part) => part !== "").map(Number);
      if (values.some((value) => !Number.isFinite(value))) { context.warnings.add(`A ${name} with unreadable points was skipped.`); return; }
      const points: Vec2[] = [];
      for (let index = 0; index + 1 < values.length; index += 2) points.push(apply(m, [values[index]!, values[index + 1]!]));
      if (name === "polygon" && points.length > 2) points.push(points[0]!);
      for (let index = 1; index < points.length; index += 1) {
        const a = points[index - 1]!;
        const b = points[index]!;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) > 0) push([{ kind: "line", a, b, layer: here }]);
      }
    } else if (name === "rect") {
      const x = number(attr["x"]);
      const y = number(attr["y"]);
      const width = number(attr["width"]);
      const height = number(attr["height"]);
      if (!(width > 0) || !(height > 0)) return;
      let rx = number(attr["rx"], Number.NaN);
      let ry = number(attr["ry"], Number.NaN);
      if (Number.isNaN(rx) && Number.isNaN(ry)) { rx = 0; ry = 0; } else if (Number.isNaN(rx)) rx = ry; else if (Number.isNaN(ry)) ry = rx;
      rx = Math.min(Math.max(rx, 0), width / 2);
      ry = Math.min(Math.max(ry, 0), height / 2);
      const d = rx > 0 && ry > 0
        ? `M${x + rx} ${y}H${x + width - rx}A${rx} ${ry} 0 0 1 ${x + width} ${y + ry}V${y + height - ry}A${rx} ${ry} 0 0 1 ${x + width - rx} ${y + height}H${x + rx}A${rx} ${ry} 0 0 1 ${x} ${y + height - ry}V${y + ry}A${rx} ${ry} 0 0 1 ${x + rx} ${y}Z`
        : `M${x} ${y}H${x + width}V${y + height}H${x}Z`;
      const parsed = parsePathData(d);
      for (const sub of parsed.subpaths) push(subpathCurves(sub, m, here, context));
    } else if (name === "circle" || name === "ellipse") {
      const cx = number(attr["cx"]);
      const cy = number(attr["cy"]);
      const rx = name === "circle" ? number(attr["r"]) : number(attr["rx"]);
      const ry = name === "circle" ? rx : number(attr["ry"]);
      if (!(rx > 0) || !(ry > 0)) return;
      if (isSimilarity(m) && Math.abs(rx - ry) <= 1e-12 * rx) push([{ kind: "circle", center: apply(m, [cx, cy]), radius: rx * scaleOf(m), layer: here }]);
      else {
        const ellipse = ellipseUnder(m, [cx, cy], rx, ry);
        if (ellipse !== undefined) push([ellipse]);
      }
    } else if (name === "path" && fitPointsOf(attr["data-ps3d-fit"], m) !== undefined) {
      push([{ kind: "spline", fit: fitPointsOf(attr["data-ps3d-fit"], m)!, layer: here }]);
    } else {
      const parsed = parsePathData(attr["d"] ?? "");
      if (parsed.problem !== undefined) context.warnings.add(`A path was only partly read: ${parsed.problem}`);
      for (const sub of parsed.subpaths) push(subpathCurves(sub, m, here, context));
      if (parsed.subpaths.length === 0 && attr["class"]?.split(/\s+/u).includes("point") === true && parsed.lonePoints.length > 0) {
        for (const point of parsed.lonePoints) push([{ kind: "point", at: apply(m, point), layer: here }]);
      }
    }
  };
  visit(svg, IDENTITY, "SVG");
  // A drawing PS3D wrote says where its own origin sits in the sketch; move the curves back there.
  const origin = (svg.attrs["data-ps3d-origin"] ?? "").split(/\s+/u).map(Number);
  if (origin.length === 2 && origin.every(Number.isFinite)) {
    const shift: Vec2 = [origin[0]! / units.mmPerUnit, origin[1]! / units.mmPerUnit];
    for (let index = 0; index < curves.length; index += 1) curves[index] = shiftedCurve(curves[index]!, shift);
  }
  const counts = new Map<string, number>();
  for (const curve of curves) counts.set(curve.layer, (counts.get(curve.layer) ?? 0) + 1);
  const layers = [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name));
  const warnings = [...context.warnings];
  const unclosed = UNCLOSED_ELEMENTS.get(svg);
  if (unclosed !== undefined) warnings.unshift(`The SVG looks cut off: <${unclosed[unclosed.length - 1]!}> is never closed (${unclosed.length === 1 ? "no </" + unclosed[0]! + ">" : "the closing tags are missing"}). ${curves.length} curve${curves.length === 1 ? " was" : "s were"} read before the file stops; everything after that point is missing. Export the drawing again before relying on this outline.`);
  const skippedTypes = Object.entries(skipped);
  if (skippedTypes.length > 0) warnings.push(`Skipped ${skippedTypes.map(([type, count]) => `${count} ${type}`).join(", ")}: only paths and basic shapes are imported (convert text to outlines first).`);
  if (units.source !== "file") warnings.push(`The SVG does not give a physical size (width and height with a unit), so ${units.name} are assumed. Check the scale before importing.`);
  const drawing: ParsedDrawing = { format: "svg", curves, units, warnings, skipped, layers };
  return { ok: true, value: drawing };
}

export type SvgParseResult = WorkbenchResult<ParsedDrawing>;
