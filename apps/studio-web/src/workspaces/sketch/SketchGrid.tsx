import type { SketchViewBox } from "../../../../../packages/workbench-sketch/src/camera.js";

export interface SketchGridProps {
  readonly viewBox: SketchViewBox;
  readonly mmPerPx: number;
  readonly minorMm: number;
  readonly majorMm: number;
  readonly showGrid: boolean;
  /** Which world axis the sketch's horizontal and vertical directions run along on the active plane. */
  readonly horizontalAxis: "x" | "y" | "z";
  readonly verticalAxis: "y" | "z";
  readonly horizontalLabel: string;
  readonly verticalLabel: string;
}

const MAX_LINES_PER_DIRECTION = 600;

function ladder(from: number, to: number, stepMm: number, majorEvery: number): { readonly minor: readonly number[]; readonly major: readonly number[] } {
  const first = Math.ceil(from / stepMm - 1e-9);
  const last = Math.floor(to / stepMm + 1e-9);
  if (!Number.isFinite(first) || !Number.isFinite(last) || last - first > MAX_LINES_PER_DIRECTION) return { minor: [], major: [] };
  const minor: number[] = [];
  const major: number[] = [];
  for (let index = first; index <= last; index += 1) {
    if (index === 0) continue;
    (index % majorEvery === 0 ? major : minor).push(index * stepMm);
  }
  return { minor, major };
}

/**
 * The sketch's adaptive grid, origin axes and axis labels. Lines are drawn in sketch millimetres but stroked in screen
 * pixels (CSS `vector-effect`), and only the lines inside the current view are generated, so zooming never thickens or
 * floods the canvas.
 */
export function SketchGrid(props: SketchGridProps): React.JSX.Element {
  const { viewBox: box, mmPerPx: px } = props;
  const left = box.x;
  const right = box.x + box.width;
  const bottom = -(box.y + box.height);
  const top = -box.y;
  const majorEvery = Math.max(1, Math.round(props.majorMm / props.minorMm));
  const columns = props.showGrid ? ladder(left, right, props.minorMm, majorEvery) : { minor: [], major: [] };
  const rows = props.showGrid ? ladder(bottom, top, props.minorMm, majorEvery) : { minor: [], major: [] };
  const vertical = (xs: readonly number[]): string => xs.map((x) => `M ${x} ${box.y} V ${box.y + box.height}`).join(" ");
  const horizontal = (ys: readonly number[]): string => ys.map((y) => `M ${left} ${-y} H ${right}`).join(" ");
  const originVisible = left <= 0 && right >= 0 && bottom <= 0 && top >= 0;
  return <g className="sketch-grid" aria-hidden="true" pointerEvents="none">
    {props.showGrid && <>
      <path className="sketch-grid-minor" d={`${vertical(columns.minor)} ${horizontal(rows.minor)}`} />
      <path className="sketch-grid-major" d={`${vertical(columns.major)} ${horizontal(rows.major)}`} />
    </>}
    <line className={`sketch-axis horizontal ${props.horizontalAxis}`} x1={left} y1="0" x2={right} y2="0" />
    <line className={`sketch-axis vertical ${props.verticalAxis}`} x1="0" y1={box.y} x2="0" y2={box.y + box.height} />
    {originVisible && <circle className="sketch-origin" cx="0" cy="0" r={4 * px} />}
    {bottom <= 0 && top >= 0 && <text className={`sketch-axis-label ${props.horizontalAxis}`} x={right - 12 * px} y={-7 * px} fontSize={12 * px} textAnchor="end">{props.horizontalLabel}</text>}
    {left <= 0 && right >= 0 && <text className={`sketch-axis-label ${props.verticalAxis}`} x={7 * px} y={box.y + 16 * px} fontSize={12 * px}>{props.verticalLabel}</text>}
  </g>;
}
