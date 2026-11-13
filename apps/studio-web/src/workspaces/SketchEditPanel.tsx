import { sketchEntityNames } from "../../../../packages/workbench-core/src/sketch-names.js";
import { useEffect, useMemo, useState } from "react";
import type { SketchEntity, WorkbenchSketch, WorkbenchSketchConstraint } from "../../../../packages/workbench-core/src/index.js";
import {
  MIRROR_AXIS_X,
  MIRROR_AXIS_Y,
  chamferCorners,
  chamferCornersAngle,
  chamferCornersAsymmetric,
  checkSketch,
  cornerLines,
  filletCorners,
  mirrorEntities,
  offsetEntities,
  selectionBounds,
  stretchEntities,
  transformEntities,
  type OffsetChainMode,
  type OffsetCorner,
  type SketchEditPlan,
  type SketchEditResult
} from "../../../../packages/workbench-sketch/src/edit-tools.js";
import { cornerQuadrant } from "../../../../packages/workbench-sketch/src/corner-tools.js";
import { parseDecimal } from "../../../../packages/workbench-sketch/src/edit-input.js";
import { formatLengthField, parseLengthField, parseNumberField } from "../../../../packages/workbench-sketch/src/edit-fields.js";
import type { SketchLengthUnit } from "../../../../packages/workbench-sketch/src/sketch-units.js";
import { defaultLengthText } from "../../../../packages/workbench-sketch/src/unit-defaults.js";
import { resolveMirrorAxis } from "../../../../packages/workbench-sketch/src/dynamic-mirror.js";
import { breakAtIntersections } from "../../../../packages/workbench-sketch/src/break-intersections.js";
import { describePath, healPathGaps, makePath, pathToSpline } from "../../../../packages/workbench-sketch/src/make-path.js";
import { offsetMoveEntities } from "../../../../packages/workbench-sketch/src/offset-move.js";
import { CommandIcon } from "../ui/CommandIcon.js";
import { CentrePickButton, useCentrePickFields, type CentrePickBridge } from "./sketch/CentrePick.js";

export type SketchEditToolId = "offset" | "mirror" | "pattern" | "move" | "rotate" | "scale" | "stretch" | "corner" | "fillet" | "chamfer" | "trim" | "extend"
  | "split" | "break" | "jog" | "delete-curve" | "offset-move" | "make-path" | "dynamic-mirror"
  /** Insert group: DXF/SVG import, DXF/SVG export and the picture to trace (their panels live in sketch/SketchExchangePanel.tsx). */
  | "import-drawing" | "export-drawing" | "underlay";

/** The tools that act on a click on a curve rather than on the selection, so the canvas must not start a selection box for them. */
export function isClickEditTool(tool: SketchEditToolId | null): tool is "trim" | "extend" | "split" | "jog" | "delete-curve" {
  return tool === "trim" || tool === "extend" || tool === "split" || tool === "jog" || tool === "delete-curve";
}

/** Jog values as typed, shared with the canvas so a click on a line uses them. */
export interface JogParams {
  readonly offset: string;
  readonly width: string;
}

export const DEFAULT_JOG_PARAMS: JogParams = { offset: "3", width: "6" };

/** Fillet and chamfer values as typed, shared with the canvas so a click on a vertex uses them. */
export interface CornerParams {
  readonly radius: string;
  readonly bevel: string;
}

export const DEFAULT_CORNER_PARAMS: CornerParams = { radius: "2", bevel: "2" };

export const SKETCH_EDIT_TOOL_LABELS: Readonly<Record<SketchEditToolId, string>> = {
  offset: "Offset",
  mirror: "Mirror",
  pattern: "Pattern",
  move: "Move / Copy",
  rotate: "Rotate",
  scale: "Scale",
  stretch: "Stretch",
  corner: "Corner",
  fillet: "Fillet",
  chamfer: "Chamfer",
  trim: "Trim",
  extend: "Extend",
  split: "Split",
  break: "Break at intersections",
  jog: "Jog",
  "delete-curve": "Delete Curve",
  "offset-move": "Offset Move",
  "make-path": "Make Path",
  "dynamic-mirror": "Dynamic Mirror",
  "import-drawing": "Import DXF / SVG",
  "export-drawing": "Export DXF / SVG",
  underlay: "Picture to trace"
};

const INSTRUCTIONS: Readonly<Record<SketchEditToolId, string>> = {
  offset: "Select a curve (a smooth chain of lines and arcs is picked up whole), set the distance, then Apply. Positive is outward for circles, arcs, rectangles and closed loops; on an open chain it is the left of the chain read from its lower-left end. Flip or Both sides change the side, and the preview shows where it lands. The copy keeps one offset dimension to its source: it follows when the source changes, and double-clicking the dimension changes the distance. A copy whose outside corners were closed with a round or chamfer, and an offset of an ellipse, a spline or a one-piece rectangle, is a plain copy with no dimension.",
  mirror: "Select the entities to mirror, then the mirror line last (or choose the sketch X or Y axis), then Apply. Copies keep their relations and are linked to the originals by symmetry.",
  pattern: "Select the entities to repeat, choose a layout, then Apply. The original is the first instance. A direction angle runs a linear pattern along any line; Total extent spaces the instances evenly between the first and last.",
  move: "Select the entities, enter the X and Y distance, then Apply. Tick Copy to leave the originals and add moved copies (several in one go if you set the count).",
  rotate: "Select the entities, set the angle (counter-clockwise) and the centre, then Apply. Tick Copy to keep the originals and set how many copies to make.",
  scale: "Select the entities, set the factor and the centre, then Apply. A different Y factor scales unevenly. Dimensions of what you scale follow the new size. Tick Copy to keep the originals.",
  stretch: "Select the entities, then drag a window on empty canvas (or type its corners) over the points or sides to move, enter the distance, then Apply. Only what lies inside the window moves, so the rest of each entity stays and it stretches. \"Use selection bounds\" fills the window from the selection.",
  corner: "Select two curves, then Apply. Both are extended or trimmed to meet. For curves that cross, choose which side to keep.",
  fillet: "Select two curves that meet (lines or arcs), a whole chain, or a rectangle, set the radius, then Apply. Or click a vertex with nothing selected. The corner relation is replaced by tangent relations and a radius dimension. For curves that cross, choose which corner to round.",
  chamfer: "Select two curves, a whole chain, or a rectangle, set the distance, then Apply. Or click a vertex with nothing selected. The corner relation is replaced by joints on the new cut line.",
  trim: "Click a curve where you want it cut: the part between its neighbouring crossings is removed, on lines, arcs, circles, rectangles, ellipses and splines. Drag across several curves to cut them all at once (Power Trim).",
  extend: "Click a line, arc or spline near the end you want to lengthen. It runs on to the first curve it reaches.",
  split: "Click a curve where you want it cut in two. Near a crossing with another curve it snaps to the crossing. A circle becomes two arcs; a rectangle becomes five lines.",
  break: "Select the curves to break (or select nothing to break all of them), then Apply. Every curve is cut where it crosses, touches or overlaps another, so a rectangle with a diagonal becomes lines you can delete one by one, and crossing lines meet in corners. Regions are found without this step; use it when you want the pieces as separate curves.",
  jog: "Set the step and its width, then click a line. The line steps out and back by the offset over the width (centred on your click); a width of 0 makes a single step and shifts the rest of the line.",
  "delete-curve": "Click a curve to delete it and heal the gap: the two curves that met it are extended or trimmed to meet each other.",
  "offset-move": "Select a chain or a closed region, then Apply. Offset mode moves each curve along its normal (positive is left of the first line's direction; a closed region grows) and stretches the lines attached to it. Vector mode moves the selection by X and Y and the attached curves follow.",
  "make-path": "Select the curves of a path. They are chained end to end from a free end; gaps, branches and curves that do not connect are listed. Close the gaps, or join the path into one spline so a sweep can follow it.",
  "dynamic-mirror": "Select the mirror line, then Start. Everything you draw afterwards is created together with its mirror image, linked by a symmetry relation, until you Stop.",
  "import-drawing": "Choose a DXF or SVG file, confirm the scale, then Import.",
  "export-drawing": "Choose DXF or SVG and download the visible curves of this sketch.",
  underlay: "Load a PNG or JPEG to trace, calibrate it with two points and a known distance."
};

/** The Stretch window in sketch millimetres: opposite corners, x1 <= x2 and y1 <= y2 when drawn. */
export interface StretchWindowRect {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

export { parseDecimal };

interface SketchEditPanelProps {
  /** The window drawn on the canvas, which the panel shows in its fields. */
  readonly stretchWindow?: StretchWindowRect | undefined;
  /** Called with the window the fields describe, so the canvas can draw what was typed. */
  readonly onStretchWindow?: (window: StretchWindowRect | undefined) => void;
  readonly tool: SketchEditToolId;
  readonly sketch: WorkbenchSketch;
  readonly selectionIds: readonly string[];
  readonly onApply: (plan: SketchEditPlan) => void;
  readonly onMessage: (message: string) => void;
  readonly onClose: () => void;
  /** Jog: the values typed here are read by the canvas when a line is clicked. */
  readonly jog?: JogParams;
  readonly onJog?: (params: JogParams) => void;
  /** Fillet and chamfer: the values typed here are read by the canvas when a vertex is clicked. */
  readonly corner?: CornerParams;
  readonly onCorner?: (params: CornerParams) => void;
  /** Dynamic Mirror: the axis line in use (null when off) and how to change it. */
  readonly dynamicMirrorAxis?: string | null;
  readonly onDynamicMirror?: (axisId: string | null) => void;
  /** The entities the edit would produce for the values typed now, drawn as a ghost on the canvas (empty clears it). */
  readonly onPreview?: (entities: readonly SketchEntity[]) => void;
  /** The unit lengths are shown and typed in; a bare number in a length field is in it. The sketch itself is always millimetres. Default millimetres. */
  readonly unit?: SketchLengthUnit;
  /** Rotate and Scale: picking the centre on the canvas (see sketch/CentrePick.tsx). */
  readonly centrePick?: CentrePickBridge;
}

type NewId = (prefix: "entity" | "constraint") => string;

function describePlan(plan: SketchEditPlan): string {
  const parts: string[] = [];
  if (plan.addEntities.length > 0) parts.push(`adds ${plan.addEntities.length} curve${plan.addEntities.length === 1 ? "" : "s"}`);
  if (plan.updateEntities.length > 0) parts.push(`changes ${plan.updateEntities.length}`);
  if (plan.removeEntityIds.length > 0) parts.push(`removes ${plan.removeEntityIds.length}`);
  if (plan.addConstraints.length > 0) parts.push(`adds ${plan.addConstraints.length} relation${plan.addConstraints.length === 1 ? "" : "s"}`);
  const dropped = plan.removeConstraintIds?.length ?? 0;
  if (dropped > 0) parts.push(`drops ${dropped} relation${dropped === 1 ? "" : "s"} it breaks`);
  return parts.length === 0 ? "No change." : `Apply ${parts.join(", ")}.`;
}

/** Options and Apply for the selection-driven sketch edit tools. Trim and Extend act directly on canvas clicks. */
export function SketchEditPanel(props: SketchEditPanelProps): React.JSX.Element {
  const unit: SketchLengthUnit = props.unit ?? "mm";
  /** A default length (millimetres) as the text of a field in the document's unit. */
  const seed = (valueMm: number): string => formatLengthField(valueMm, unit);
  /** A typed length in millimetres (NaN when unreadable) and a typed plain number. */
  const len = (text: string): number => parseLengthField(text, unit);
  const num = parseNumberField;
  /** The starting value of a field: the metric default in millimetres, the round inch size nearest to it in an inch document. */
  const start = (metricMm: number): string => defaultLengthText(metricMm, unit);
  const [offset, setOffset] = useState(() => start(5));
  const [offsetFlip, setOffsetFlip] = useState(false);
  const [offsetBoth, setOffsetBoth] = useState(false);
  const [offsetCorner, setOffsetCorner] = useState<OffsetCorner>("mitre");
  const [offsetChain, setOffsetChain] = useState<OffsetChainMode>("tangent");
  const [centerX, setCenterX] = useState("0");
  const [centerY, setCenterY] = useState("0");
  const [radius, setRadius] = useState(props.corner?.radius ?? DEFAULT_CORNER_PARAMS.radius);
  const [bevel, setBevel] = useState(props.corner?.bevel ?? DEFAULT_CORNER_PARAMS.bevel);
  const [bevelSecond, setBevelSecond] = useState(() => start(2));
  const [bevelAngle, setBevelAngle] = useState("45");
  const [radiusDimension, setRadiusDimension] = useState(true);
  const [cornerSide, setCornerSide] = useState<"auto" | "ne" | "nw" | "sw" | "se">("auto");
  const [mirrorAxis, setMirrorAxis] = useState<"line" | "x" | "y">("line");
  const [moveX, setMoveX] = useState(() => start(10));
  const [moveY, setMoveY] = useState("0");
  const [rotateAngle, setRotateAngle] = useState("45");
  const [scaleFactor, setScaleFactor] = useState("2");
  const [scaleFactorY, setScaleFactorY] = useState("");
  const [copyCount, setCopyCount] = useState("1");
  const [copyMode, setCopyMode] = useState(false);
  const [windowX1, setWindowX1] = useState("0");
  const [windowY1, setWindowY1] = useState("0");
  const [windowX2, setWindowX2] = useState(() => start(10));
  const [windowY2, setWindowY2] = useState(() => start(10));
  const [chamferMode, setChamferMode] = useState<"equal" | "asymmetric" | "distance-angle">("equal");
  const [moveMode, setMoveMode] = useState<"offset" | "vector">("offset");
  // Pattern has its own panel (SketchPatternPanel: rectangular, circular and path layouts, ghost preview, Enter to apply).
  const interactive = !isClickEditTool(props.tool) && props.tool !== "make-path" && props.tool !== "dynamic-mirror" && props.tool !== "pattern";
  const jog = props.jog ?? DEFAULT_JOG_PARAMS;
  const pathResult = useMemo(() => (props.tool === "make-path" && props.selectionIds.length > 0 ? makePath(props.sketch, props.selectionIds) : undefined), [props.tool, props.sketch, props.selectionIds]);
  const { stretchWindow, onStretchWindow, onCorner } = props;
  // Rotate and Scale: a point clicked on the canvas fills the centre, and the typed centre is drawn there.
  useCentrePickFields(props.centrePick, props.tool === "rotate" || props.tool === "scale", { x: centerX, y: centerY }, (x, y) => { setCenterX(x); setCenterY(y); }, len, seed);

  // A window drawn on the canvas fills the fields; a typed window is drawn on the canvas.
  useEffect(() => {
    if (stretchWindow === undefined) return;
    setWindowX1(seed(stretchWindow.x1)); setWindowY1(seed(stretchWindow.y1)); setWindowX2(seed(stretchWindow.x2)); setWindowY2(seed(stretchWindow.y2));
  }, [stretchWindow]);
  useEffect(() => {
    if (props.tool !== "stretch" || onStretchWindow === undefined) return;
    const values = [windowX1, windowY1, windowX2, windowY2].map(len);
    if (values.every(Number.isFinite)) onStretchWindow({ x1: values[0]!, y1: values[1]!, x2: values[2]!, y2: values[3]! });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tool, windowX1, windowY1, windowX2, windowY2, onStretchWindow, unit]);
  // The canvas reads the fillet and chamfer values when a vertex is clicked.
  useEffect(() => { onCorner?.({ radius, bevel }); }, [radius, bevel, onCorner]);

  /** Plans the edit for the values typed now; undefined when the tool takes no selection. */
  const plan = (newId: NewId): SketchEditResult | undefined => {
    const context = { sketch: props.sketch, newId };
    const ids = props.selectionIds;
    const picks = cornerSide === "auto" ? undefined : cornerQuadrant(props.sketch, ids, cornerSide);
    const cornerOptions = { ...(picks === undefined ? {} : { picks }), dimension: radiusDimension };
    switch (props.tool) {
      case "offset": return offsetEntities(context, ids, len(offset), { flip: offsetFlip, both: offsetBoth, corner: offsetCorner, chain: offsetChain });
      case "mirror": return mirrorEntities(context, mirrorAxis === "line" ? ids : [...ids, mirrorAxis === "x" ? MIRROR_AXIS_X : MIRROR_AXIS_Y]);
      case "break": return breakAtIntersections(context, ids);
      case "corner": return cornerLines(context, ids, cornerOptions);
      case "fillet": return filletCorners(context, ids, len(radius), cornerOptions);
      case "chamfer":
        return chamferMode === "equal" ? chamferCorners(context, ids, len(bevel), cornerOptions)
          : chamferMode === "asymmetric" ? chamferCornersAsymmetric(context, ids, len(bevel), len(bevelSecond), cornerOptions)
          : chamferCornersAngle(context, ids, len(bevel), num(bevelAngle), cornerOptions);
      case "move": return transformEntities(context, ids, { kind: "move", dxMm: len(moveX), dyMm: len(moveY), copies: num(copyCount) }, copyMode);
      case "rotate": return transformEntities(context, ids, { kind: "rotate", angleDeg: num(rotateAngle), center: [len(centerX), len(centerY)], copies: num(copyCount) }, copyMode);
      case "scale": {
        const factorY = scaleFactorY.trim() === "" ? undefined : num(scaleFactorY);
        return transformEntities(context, ids, { kind: "scale", factor: num(scaleFactor), center: [len(centerX), len(centerY)], ...(factorY === undefined ? {} : { factorY }) }, copyMode);
      }
      case "offset-move": return offsetMoveEntities(context, ids, moveMode === "offset" ? { kind: "offset", distanceMm: len(offset) } : { kind: "vector", dxMm: len(moveX), dyMm: len(moveY) });
      case "stretch": return stretchEntities(context, ids, { x1: len(windowX1), y1: len(windowY1), x2: len(windowX2), y2: len(windowY2) }, len(moveX), len(moveY));
      default: return undefined;
    }
  };

  // What the edit would do for the values typed now: a one-line summary (or the reason it cannot be done), and a ghost on the canvas.
  const preview = useMemo(() => {
    if (!interactive || props.selectionIds.length === 0) return undefined;
    let serial = 0;
    try { return plan((prefix) => `${prefix}:preview-${(serial += 1)}`); } catch { return undefined; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.tool, props.sketch, props.selectionIds, unit, offset, offsetFlip, offsetBoth, offsetCorner, offsetChain, centerX, centerY, radius, bevel, bevelSecond, bevelAngle, radiusDimension, cornerSide, mirrorAxis, moveX, moveY, rotateAngle, scaleFactor, scaleFactorY, copyCount, copyMode, windowX1, windowY1, windowX2, windowY2, chamferMode, moveMode]);
  const onPreview = props.onPreview;
  useEffect(() => {
    if (onPreview === undefined) return;
    const ghost = preview?.ok === true ? [...preview.value.addEntities, ...preview.value.updateEntities].slice(0, 200) : [];
    onPreview(ghost);
  }, [preview, onPreview]);
  useEffect(() => () => { onPreview?.([]); }, [onPreview]);

  const apply = (): void => {
    const result = plan((prefix) => `${prefix}:user-${crypto.randomUUID()}`);
    if (result === undefined) return;
    if (!result.ok) { props.onMessage(result.diagnostics[0]?.message ?? "The sketch edit was rejected."); return; }
    try {
      props.onApply(result.value);
    } catch (error) {
      props.onMessage(`The edit could not be applied: ${error instanceof Error ? error.message : "unexpected error"}.`);
    }
  };

  const keys = (event: React.KeyboardEvent): void => {
    if (event.key === "Enter" && interactive) { event.preventDefault(); apply(); }
    else if (event.key === "Escape") { event.preventDefault(); props.onClose(); }
  };

  /** A number field. A unit of "mm" marks a length: it is shown and read in the document's unit, whatever that is. */
  const field = (label: string, value: string, onChange: (next: string) => void, fieldUnit?: string): React.JSX.Element => {
    const shownUnit = fieldUnit === "mm" ? unit : fieldUnit;
    return <label><span>{label}</span><div className="distance-entry"><input aria-label={fieldUnit === "mm" ? `${label} (${unit})` : label} inputMode="text" value={value} onChange={(event) => onChange(event.target.value)} onKeyDown={keys} />{shownUnit !== undefined && <small>{shownUnit}</small>}</div></label>;
  };
  const check = (label: string, value: boolean, onChange: (next: boolean) => void): React.JSX.Element => (
    <label className="check-row"><input type="checkbox" aria-label={label} checked={value} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>
  );
  const centreButtons = (): React.JSX.Element => (
    <div className="palette-row">
      <button className="palette-action" title="Put the centre at the middle of the selection" onClick={() => {
        const bounds = selectionBounds(props.sketch, props.selectionIds);
        if (bounds === undefined) { props.onMessage("Select the entities first, then use their middle as the centre."); return; }
        setCenterX(seed((bounds.x1 + bounds.x2) / 2)); setCenterY(seed((bounds.y1 + bounds.y2) / 2));
      }}><CommandIcon name="fit" />Centre of selection</button>
      <button className="palette-action" title="Put the centre at the sketch origin" onClick={() => { setCenterX("0"); setCenterY("0"); }}><CommandIcon name="coincident" />Origin</button>
      <CentrePickButton bridge={props.centrePick} />
    </div>
  );
  const sideSelect = (): React.JSX.Element => (
    <label><span>Keep (crossing curves)</span><select aria-label="Corner side to keep" value={cornerSide} onChange={(event) => setCornerSide(event.target.value as "auto" | "ne" | "nw" | "sw" | "se")}>
      <option value="auto">Longer sides</option><option value="ne">Upper right</option><option value="nw">Upper left</option><option value="sw">Lower left</option><option value="se">Lower right</option>
    </select></label>
  );

  return <section className="inspector-section sketch-edit-panel" aria-label={`${SKETCH_EDIT_TOOL_LABELS[props.tool]} options`}>
    <header><strong>{SKETCH_EDIT_TOOL_LABELS[props.tool]}</strong><span>{props.selectionIds.length} selected</span></header>
    <p className="profile-help">{INSTRUCTIONS[props.tool]}</p>
    {props.tool === "offset" && <>
      {field("Distance", offset, setOffset, "mm")}
      {check("Flip side", offsetFlip, setOffsetFlip)}
      {check("Both sides", offsetBoth, setOffsetBoth)}
      <label><span>Outside corners</span><select aria-label="Offset corner type" value={offsetCorner} onChange={(event) => setOffsetCorner(event.target.value as OffsetCorner)}><option value="mitre">Sharp (mitre)</option><option value="round">Round</option><option value="chamfer">Chamfer</option></select></label>
      <label><span>Chain</span><select aria-label="Offset chain selection" value={offsetChain} onChange={(event) => setOffsetChain(event.target.value as OffsetChainMode)}><option value="tangent">Tangent chain</option><option value="connected">Everything connected</option><option value="none">Only what is selected</option></select></label>
    </>}
    {props.tool === "offset-move" && <>
      <label><span>Move by</span><select aria-label="Offset move mode" value={moveMode} onChange={(event) => setMoveMode(event.target.value as "offset" | "vector")}><option value="offset">Offset along the normal</option><option value="vector">X and Y distance</option></select></label>
      {moveMode === "offset" ? field("Distance", offset, setOffset, "mm") : <>{field("Distance X", moveX, setMoveX, "mm")}{field("Distance Y", moveY, setMoveY, "mm")}</>}
    </>}
    {props.tool === "mirror" && <label><span>Mirror about</span><select aria-label="Mirror axis" value={mirrorAxis} onChange={(event) => setMirrorAxis(event.target.value as "line" | "x" | "y")}><option value="line">The selected line (last)</option><option value="x">Sketch X axis</option><option value="y">Sketch Y axis</option></select></label>}
    {props.tool === "jog" && <>
      {field("Offset (step)", jog.offset, (next) => props.onJog?.({ ...jog, offset: next }), "mm")}
      {field("Width (0 = single step)", jog.width, (next) => props.onJog?.({ ...jog, width: next }), "mm")}
    </>}
    {props.tool === "make-path" && <div className="make-path-report" aria-label="Path report">
      {pathResult === undefined && <p className="profile-help">Select the curves of the path.</p>}
      {pathResult !== undefined && !pathResult.ok && <p className="profile-help">{pathResult.diagnostics[0]?.message}</p>}
      {pathResult?.ok === true && <>
        <ul className="sketch-check-list">{describePath(pathResult.value).map((text, index) => <li key={index} className={index === 0 ? "check-info" : "check-warning"}><b>{index === 0 ? "Path" : "Note"}</b><span>{text}</span></li>)}</ul>
        {pathResult.value.gaps.length > 0 && <button className="palette-action" onClick={() => {
          const context = { sketch: props.sketch, newId: (prefix: "entity" | "constraint"): string => `${prefix}:user-${crypto.randomUUID()}` };
          const result = healPathGaps(context, pathResult.value);
          if (!result.ok) { props.onMessage(result.diagnostics[0]?.message ?? "The gaps could not be closed."); return; }
          props.onApply(result.value);
        }}><CommandIcon name="coincident" />Close {pathResult.value.gaps.length} gap{pathResult.value.gaps.length === 1 ? "" : "s"}</button>}
        <button className="palette-action" onClick={() => {
          const context = { sketch: props.sketch, newId: (prefix: "entity" | "constraint"): string => `${prefix}:user-${crypto.randomUUID()}` };
          const result = pathToSpline(context, pathResult.value);
          if (!result.ok) { props.onMessage(result.diagnostics[0]?.message ?? "The path could not be joined."); return; }
          props.onApply(result.value);
        }}><CommandIcon name="spline" />Join into one spline (sweep path)</button>
      </>}
    </div>}
    {props.tool === "dynamic-mirror" && <>
      <p className="profile-help">{props.dynamicMirrorAxis == null ? "Not mirroring." : `Mirroring about ${sketchEntityNames(props.sketch.entities).get(props.dynamicMirrorAxis) ?? "the axis"}. New curves are drawn with their mirror image.`}</p>
      <button className="palette-action primary" onClick={() => {
        const axis = resolveMirrorAxis(props.sketch, props.selectionIds);
        if (axis === undefined) { props.onMessage("Select the mirror line first, then press Start."); return; }
        props.onDynamicMirror?.(axis.id);
      }}><CommandIcon name="mirror" />Start with the selected line</button>
      {props.dynamicMirrorAxis != null && <button className="palette-action" onClick={() => props.onDynamicMirror?.(null)}><CommandIcon name="cancel" />Stop mirroring</button>}
    </>}
    {props.tool === "move" && <>{field("Distance X", moveX, setMoveX, "mm")}{field("Distance Y", moveY, setMoveY, "mm")}</>}
    {props.tool === "stretch" && <>
      {field("Window X1", windowX1, setWindowX1, "mm")}{field("Window Y1", windowY1, setWindowY1, "mm")}
      {field("Window X2", windowX2, setWindowX2, "mm")}{field("Window Y2", windowY2, setWindowY2, "mm")}
      <button className="palette-action" onClick={() => {
        const bounds = selectionBounds(props.sketch, props.selectionIds);
        if (bounds === undefined) { props.onMessage("Select the entities first, then use their bounds as the window."); return; }
        setWindowX1(seed(bounds.x1)); setWindowY1(seed(bounds.y1)); setWindowX2(seed(bounds.x2)); setWindowY2(seed(bounds.y2));
      }}><CommandIcon name="fit" />Use selection bounds</button>
      {field("Distance X", moveX, setMoveX, "mm")}{field("Distance Y", moveY, setMoveY, "mm")}
    </>}
    {props.tool === "rotate" && <>{field("Angle", rotateAngle, setRotateAngle, "°")}{field("Centre X", centerX, setCenterX, "mm")}{field("Centre Y", centerY, setCenterY, "mm")}{centreButtons()}</>}
    {props.tool === "scale" && <>{field("Factor", scaleFactor, setScaleFactor, "×")}{field("Factor Y (blank = same)", scaleFactorY, setScaleFactorY, "×")}{field("Centre X", centerX, setCenterX, "mm")}{field("Centre Y", centerY, setCenterY, "mm")}{centreButtons()}</>}
    {(props.tool === "move" || props.tool === "rotate" || props.tool === "scale") && check("Copy (keep the originals)", copyMode, setCopyMode)}
    {copyMode && (props.tool === "move" || props.tool === "rotate") && field("Number of copies", copyCount, setCopyCount)}
    {props.tool === "fillet" && <>{field("Radius", radius, setRadius, "mm")}{check("Add a radius dimension", radiusDimension, setRadiusDimension)}{sideSelect()}</>}
    {props.tool === "corner" && sideSelect()}
    {props.tool === "chamfer" && <>
      <label><span>Chamfer mode</span><select aria-label="Chamfer mode" value={chamferMode} onChange={(event) => setChamferMode(event.target.value as "equal" | "asymmetric" | "distance-angle")}><option value="equal">Equal distance</option><option value="asymmetric">Two distances</option><option value="distance-angle">Distance + angle</option></select></label>
      {field(chamferMode === "equal" ? "Distance" : chamferMode === "asymmetric" ? "First distance" : "Distance", bevel, setBevel, "mm")}
      {chamferMode === "asymmetric" && field("Second distance", bevelSecond, setBevelSecond, "mm")}
      {chamferMode === "distance-angle" && field("Angle from first line", bevelAngle, setBevelAngle, "°")}
      {sideSelect()}
    </>}
    {interactive && props.selectionIds.length > 0 && preview !== undefined && <p className={`profile-help edit-preview ${preview.ok ? "" : "edit-preview-error"}`} role="status" aria-live="polite">{preview.ok ? describePlan(preview.value) : preview.diagnostics[0]?.message}</p>}
    {interactive && <button className="palette-action primary" onClick={apply}><CommandIcon name="cube-check" />Apply {SKETCH_EDIT_TOOL_LABELS[props.tool].toLowerCase()}</button>}
    <button className="palette-action" onClick={props.onClose}><CommandIcon name="cancel" />Done</button>
  </section>;
}

/** Read-only diagnostics for the Sketch Checking command. */
export function SketchCheckPanel(props: { readonly sketch: WorkbenchSketch; readonly onClose: () => void }): React.JSX.Element {
  const report = useMemo(() => checkSketch(props.sketch), [props.sketch]);
  return <section className="inspector-section sketch-check-panel" aria-label="Sketch checking">
    <header><strong>Sketch checking</strong><span>{report.errors} error{report.errors === 1 ? "" : "s"} · {report.warnings} warning{report.warnings === 1 ? "" : "s"}</span></header>
    <ul className="sketch-check-list">
      {report.items.map((item, index) => <li key={index} className={`check-${item.severity}`}><b>{item.severity === "error" ? "Error" : item.severity === "warning" ? "Warning" : "Note"}</b><span>{item.message}</span></li>)}
    </ul>
    <button className="palette-action" onClick={props.onClose}><CommandIcon name="cancel" />Close</button>
  </section>;
}

/** The relations on the current selection, each with a Relax or Restore toggle. */
export function SketchRelationList(props: {
  readonly constraints: readonly WorkbenchSketchConstraint[];
  readonly entities: readonly SketchEntity[];
  readonly onSetSuppressed: (constraintIds: readonly string[], suppressed: boolean) => void;
}): React.JSX.Element | null {
  if (props.constraints.length === 0) return null;
  return <section className="inspector-section sketch-relation-list" aria-label="Relations on the selection">
    <header><strong>Relations on selection</strong><span>{props.constraints.length}</span></header>
    <div className="record-list">
      {props.constraints.map((constraint) => {
        const relaxed = constraint.suppressed === true;
        return <button key={constraint.id} className={relaxed ? "relaxed" : ""} onClick={() => props.onSetSuppressed([constraint.id], !relaxed)} title={relaxed ? "Restore this relation" : "Relax this relation (kept, but ignored by the solver)"}>
          <CommandIcon name={constraint.dimension === undefined ? constraint.kind : "dimension"} />
          <span>{constraint.kind}{constraint.dimension === undefined ? "" : ` · ${constraint.dimension}`}</span>
          <small>{relaxed ? "relaxed · restore" : "active · relax"}</small>
        </button>;
      })}
    </div>
  </section>;
}
