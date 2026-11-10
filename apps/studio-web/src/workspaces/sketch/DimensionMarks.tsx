import type { Vec2 } from "../../../../../packages/workbench-core/src/index.js";
import { arrowHead, type DimensionLayout } from "../../../../../packages/workbench-sketch/src/dimension-layout.js";
import { labelBoxPx } from "../../../../../packages/workbench-sketch/src/dimension-display.js";

/**
 * A driving dimension drawn like a drawing dimension: extension lines, a dimension line with arrowheads and the value. The layout is
 * computed by the caller (stacked so labels do not overlap, at the stand-off the person dragged it to). Press and drag the label to
 * move the dimension line; click it to select the dimension (Delete removes it); double-click it to edit the value in place.
 */
export interface DimensionMarksProps {
  readonly constraintId: string;
  readonly entityId: string;
  readonly layout: DimensionLayout;
  readonly px: number;
  readonly relaxed: boolean;
  readonly selected: boolean;
  /** False while a drawing tool is active: the marks are then only drawn. */
  readonly interactive: boolean;
  readonly repositionable: boolean;
  readonly title: string;
  readonly onPress: (event: React.PointerEvent, additive: boolean) => void;
  readonly onEdit: () => void;
  /** Selecting from the keyboard (Space); the pointer path is onPress. Without it only Enter (edit) is offered. */
  readonly onSelect?: () => void;
}

export function DimensionMarks(props: DimensionMarksProps): React.JSX.Element {
  const { layout, px } = props;
  const flip = (point: Vec2): string => `${point[0]},${-point[1]}`;
  const box = labelBoxPx(layout.label);
  return <g
    className={`driving-dimension${props.relaxed ? " relaxed" : ""}${props.selected ? " selected" : ""}${layout.reference === true ? " reference" : ""}${props.interactive && props.repositionable ? " repositionable" : ""}`}
    data-dimension-for={props.entityId}
    data-dimension-constraint={props.constraintId}
    pointerEvents={props.interactive ? undefined : "none"}
  >
    {layout.extensionLines.map((segment, index) => <line key={index} x1={segment.from[0]} y1={-segment.from[1]} x2={segment.to[0]} y2={-segment.to[1]} />)}
    <line x1={layout.dimensionLine.from[0]} y1={-layout.dimensionLine.from[1]} x2={layout.dimensionLine.to[0]} y2={-layout.dimensionLine.to[1]} />
    {layout.arrows.map((arrow, index) => <polygon key={index} className="arrow" points={arrowHead(arrow, px).map(flip).join(" ")} />)}
    <rect
      className="driving-dimension-hit"
      x={layout.textAt[0] - (box.width * px) / 2}
      y={-layout.textAt[1] - 11 * px}
      width={box.width * px}
      height={box.height * px}
      role={props.interactive ? "button" : undefined}
      tabIndex={props.interactive ? 0 : undefined}
      aria-pressed={props.interactive ? props.selected : undefined}
      aria-label={props.interactive ? `${props.title}. Click to select, double-click to edit${props.repositionable ? ", drag to move" : ""}. From the keyboard: Press Enter to edit, Space to select.` : undefined}
      onKeyDown={props.interactive ? (event) => {
        if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); props.onEdit(); }
        else if (event.key === " ") { event.preventDefault(); event.stopPropagation(); props.onSelect?.(); }
      } : undefined}
      onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); props.onPress(event, event.shiftKey || event.ctrlKey || event.metaKey); }}
      onDoubleClick={(event) => { event.stopPropagation(); props.onEdit(); }}
    />
    <text className="driving-dimension-text" x={layout.textAt[0]} y={-layout.textAt[1] + 4 * px} style={{ fontSize: 12.5 * px, strokeWidth: 3.5 * px }} pointerEvents="none">{layout.label}</text>
  </g>;
}
