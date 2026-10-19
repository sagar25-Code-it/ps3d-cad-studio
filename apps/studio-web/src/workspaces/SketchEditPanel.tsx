import { useMemo, useState } from "react";
import type { SketchEntity, WorkbenchSketch, WorkbenchSketchConstraint } from "../../../../packages/workbench-core/src/index.js";
import {
  chamferCorners,
  checkSketch,
  cornerLines,
  filletCorners,
  mirrorEntities,
  offsetEntities,
  patternEntities,
  type SketchEditPlan,
  type SketchEditResult
} from "../../../../packages/workbench-sketch/src/edit-tools.js";
import { CommandIcon } from "../ui/CommandIcon.js";

export type SketchEditToolId = "offset" | "mirror" | "pattern" | "corner" | "fillet" | "chamfer" | "trim" | "extend";

export const SKETCH_EDIT_TOOL_LABELS: Readonly<Record<SketchEditToolId, string>> = {
  offset: "Offset",
  mirror: "Mirror",
  pattern: "Pattern",
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
      case "chamfer": result = chamferCorners(context, ids, Number(bevel)); break;
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
    {props.tool === "fillet" && field("Radius", radius, setRadius, "mm")}
    {props.tool === "chamfer" && field("Distance", bevel, setBevel, "mm")}
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
