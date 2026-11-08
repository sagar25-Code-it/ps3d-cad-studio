import { useMemo, useState } from "react";
import type { SketchEntity, WorkbenchSketch, WorkbenchSketchConstraint } from "../../../../packages/workbench-core/src/index.js";
import {
  chamferCorners,
  chamferCornersAngle,
  chamferCornersAsymmetric,
  checkSketch,
  cornerLines,
  filletCorners,
  mirrorEntities,
  offsetEntities,
  patternEntities,
  selectionBounds,
  stretchEntities,
  transformEntities,
  type SketchEditPlan,
  type SketchEditResult
} from "../../../../packages/workbench-sketch/src/edit-tools.js";
import { CommandIcon } from "../ui/CommandIcon.js";

export type SketchEditToolId = "offset" | "mirror" | "pattern" | "move" | "rotate" | "scale" | "stretch" | "corner" | "fillet" | "chamfer" | "trim" | "extend";

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
  extend: "Extend"
};

const INSTRUCTIONS: Readonly<Record<SketchEditToolId, string>> = {
  offset: "Select the curves to offset (a connected chain of lines is mitred), set the distance, then Apply. Positive is outward for circles, arcs, rectangles and closed loops, and to the left of a line's direction.",
  mirror: "Select the entities to mirror, then the mirror line last, then Apply. Mirrored lines and circles get symmetric relations.",
  pattern: "Select the entities to repeat, choose a layout, then Apply. The original is the first instance.",
  move: "Select the entities, enter the X and Y distance, then Apply. Tick Copy to leave the originals and add moved copies.",
  rotate: "Select the entities, set the angle (counter-clockwise) and the centre, then Apply. Tick Copy to keep the originals.",
  scale: "Select the entities, set the factor and the centre, then Apply. Circles, rectangles and ellipses scale their size too. Tick Copy to keep the originals.",
  stretch: "Select the entities, set a window over the points or sides to move, enter the distance, then Apply. Only what lies inside the window moves, so the rest of each entity stays and it stretches. \"Use selection bounds\" fills the window from the selection.",
  corner: "Select two lines, then Apply. Both are extended or trimmed to meet at their intersection.",
  fillet: "Select two lines (or one rectangle), set the radius, then Apply. The lines are shortened to the tangent points and an arc joins them.",
  chamfer: "Select two lines (or one rectangle), set the distance, then Apply. The lines are shortened and a straight cut joins them.",
  trim: "Click a curve where you want it cut: the part between its neighbouring crossings is removed. A circle becomes the arc that remains.",
  extend: "Click a line near the end you want to lengthen. It runs on to the first curve it reaches."
};

interface SketchEditPanelProps {
  readonly tool: SketchEditToolId;
  readonly sketch: WorkbenchSketch;
  readonly selectionIds: readonly string[];
  readonly onApply: (plan: SketchEditPlan) => void;
  readonly onMessage: (message: string) => void;
  readonly onClose: () => void;
}

/** Options and Apply for the selection-driven sketch edit tools. Trim and Extend act directly on canvas clicks. */
export function SketchEditPanel(props: SketchEditPanelProps): React.JSX.Element {
  const [offset, setOffset] = useState("5");
  const [layout, setLayout] = useState<"rectangular" | "circular">("rectangular");
  const [countX, setCountX] = useState("3");
  const [countY, setCountY] = useState("1");
  const [stepX, setStepX] = useState("10");
  const [stepY, setStepY] = useState("10");
  const [count, setCount] = useState("6");
  const [angle, setAngle] = useState("360");
  const [centerX, setCenterX] = useState("0");
  const [centerY, setCenterY] = useState("0");
  const [radius, setRadius] = useState("2");
  const [bevel, setBevel] = useState("2");
  const [bevelSecond, setBevelSecond] = useState("2");
  const [bevelAngle, setBevelAngle] = useState("45");
  const [moveX, setMoveX] = useState("10");
  const [moveY, setMoveY] = useState("0");
  const [rotateAngle, setRotateAngle] = useState("45");
  const [scaleFactor, setScaleFactor] = useState("2");
  const [copyMode, setCopyMode] = useState(false);
  const [windowX1, setWindowX1] = useState("0");
  const [windowY1, setWindowY1] = useState("0");
  const [windowX2, setWindowX2] = useState("10");
  const [windowY2, setWindowY2] = useState("10");
  const [chamferMode, setChamferMode] = useState<"equal" | "asymmetric" | "distance-angle">("equal");
  const interactive = props.tool !== "trim" && props.tool !== "extend";

  const apply = (): void => {
    const context = { sketch: props.sketch, newId: (prefix: "entity" | "constraint"): string => `${prefix}:user-${crypto.randomUUID()}` };
    const ids = props.selectionIds;
    let result: SketchEditResult;
    switch (props.tool) {
      case "offset": result = offsetEntities(context, ids, Number(offset)); break;
      case "mirror": result = mirrorEntities(context, ids); break;
      case "corner": result = cornerLines(context, ids); break;
      case "fillet": result = filletCorners(context, ids, Number(radius)); break;
      case "chamfer":
        result = chamferMode === "equal" ? chamferCorners(context, ids, Number(bevel))
          : chamferMode === "asymmetric" ? chamferCornersAsymmetric(context, ids, Number(bevel), Number(bevelSecond))
          : chamferCornersAngle(context, ids, Number(bevel), Number(bevelAngle));
        break;
      case "move": result = transformEntities(context, ids, { kind: "move", dxMm: Number(moveX), dyMm: Number(moveY) }, copyMode); break;
      case "rotate": result = transformEntities(context, ids, { kind: "rotate", angleDeg: Number(rotateAngle), center: [Number(centerX), Number(centerY)] }, copyMode); break;
      case "scale": result = transformEntities(context, ids, { kind: "scale", factor: Number(scaleFactor), center: [Number(centerX), Number(centerY)] }, copyMode); break;
      case "stretch": result = stretchEntities(context, ids, { x1: Number(windowX1), y1: Number(windowY1), x2: Number(windowX2), y2: Number(windowY2) }, Number(moveX), Number(moveY)); break;
      case "pattern":
        result = patternEntities(context, ids, layout === "rectangular"
          ? { kind: "rectangular", countX: Number(countX), countY: Number(countY), dxMm: Number(stepX), dyMm: Number(stepY) }
          : { kind: "circular", count: Number(count), angleDeg: Number(angle), center: [Number(centerX), Number(centerY)] });
        break;
      default: return;
    }
    if (!result.ok) { props.onMessage(result.diagnostics[0]?.message ?? "The sketch edit was rejected."); return; }
    props.onApply(result.value);
  };

  const field = (label: string, value: string, onChange: (next: string) => void, unit?: string): React.JSX.Element => (
    <label><span>{label}</span><div className="distance-entry"><input aria-label={label} inputMode="decimal" value={value} onChange={(event) => onChange(event.target.value)} />{unit !== undefined && <small>{unit}</small>}</div></label>
  );

  return <section className="inspector-section sketch-edit-panel" aria-label={`${SKETCH_EDIT_TOOL_LABELS[props.tool]} options`}>
    <header><strong>{SKETCH_EDIT_TOOL_LABELS[props.tool]}</strong><span>{props.selectionIds.length} selected</span></header>
    <p className="profile-help">{INSTRUCTIONS[props.tool]}</p>
    {props.tool === "offset" && field("Distance", offset, setOffset, "mm")}
    {props.tool === "move" && <>{field("Distance X", moveX, setMoveX, "mm")}{field("Distance Y", moveY, setMoveY, "mm")}</>}
    {props.tool === "stretch" && <>
      {field("Window X1", windowX1, setWindowX1, "mm")}{field("Window Y1", windowY1, setWindowY1, "mm")}
      {field("Window X2", windowX2, setWindowX2, "mm")}{field("Window Y2", windowY2, setWindowY2, "mm")}
      <button className="palette-action" onClick={() => {
        const bounds = selectionBounds(props.sketch, props.selectionIds);
        if (bounds === undefined) { props.onMessage("Select the entities first, then use their bounds as the window."); return; }
        setWindowX1(String(Number(bounds.x1.toFixed(3)))); setWindowY1(String(Number(bounds.y1.toFixed(3)))); setWindowX2(String(Number(bounds.x2.toFixed(3)))); setWindowY2(String(Number(bounds.y2.toFixed(3))));
      }}><CommandIcon name="fit" />Use selection bounds</button>
      {field("Distance X", moveX, setMoveX, "mm")}{field("Distance Y", moveY, setMoveY, "mm")}
    </>}
    {props.tool === "rotate" && <>{field("Angle", rotateAngle, setRotateAngle, "°")}{field("Centre X", centerX, setCenterX, "mm")}{field("Centre Y", centerY, setCenterY, "mm")}</>}
    {props.tool === "scale" && <>{field("Factor", scaleFactor, setScaleFactor, "×")}{field("Centre X", centerX, setCenterX, "mm")}{field("Centre Y", centerY, setCenterY, "mm")}</>}
    {(props.tool === "move" || props.tool === "rotate" || props.tool === "scale") && <label className="check-row"><input type="checkbox" aria-label="Copy instead of moving the originals" checked={copyMode} onChange={(event) => setCopyMode(event.target.checked)} /><span>Copy (keep the originals)</span></label>}
    {props.tool === "fillet" && field("Radius", radius, setRadius, "mm")}
    {props.tool === "chamfer" && <>
      <label><span>Chamfer mode</span><select aria-label="Chamfer mode" value={chamferMode} onChange={(event) => setChamferMode(event.target.value as "equal" | "asymmetric" | "distance-angle")}><option value="equal">Equal distance</option><option value="asymmetric">Two distances</option><option value="distance-angle">Distance + angle</option></select></label>
      {field(chamferMode === "equal" ? "Distance" : chamferMode === "asymmetric" ? "First distance" : "Distance", bevel, setBevel, "mm")}
      {chamferMode === "asymmetric" && field("Second distance", bevelSecond, setBevelSecond, "mm")}
      {chamferMode === "distance-angle" && field("Angle from first line", bevelAngle, setBevelAngle, "°")}
    </>}
    {props.tool === "pattern" && <>
      <label><span>Layout</span><select aria-label="Pattern layout" value={layout} onChange={(event) => setLayout(event.target.value as "rectangular" | "circular")}><option value="rectangular">Rectangular</option><option value="circular">Circular</option></select></label>
      {layout === "rectangular" ? <>
        {field("Count X", countX, setCountX)}{field("Spacing X", stepX, setStepX, "mm")}
        {field("Count Y", countY, setCountY)}{field("Spacing Y", stepY, setStepY, "mm")}
      </> : <>
        {field("Count", count, setCount)}{field("Total angle", angle, setAngle, "°")}
        {field("Centre X", centerX, setCenterX, "mm")}{field("Centre Y", centerY, setCenterY, "mm")}
      </>}
    </>}
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
