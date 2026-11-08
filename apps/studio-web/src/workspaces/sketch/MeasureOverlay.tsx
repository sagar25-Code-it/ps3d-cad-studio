import type { Vec2 } from "../../../../../packages/workbench-core/src/index.js";
import { describeMeasurement, type MeasureState } from "../../../../../packages/workbench-sketch/src/sketch-measure-tool.js";

/** What the sketch Measure tool has picked and measured, drawn over the canvas. It only reads the sketch: it never adds a relation. */
export function MeasureOverlay(props: { readonly state: MeasureState; readonly px: number }): React.JSX.Element {
  const { state, px } = props;
  const result = state.result;
  const flip = (point: Vec2): [number, number] => [point[0], -point[1]];
  const labelAt = (a: Vec2, b: Vec2): [number, number] => flip([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  return <g className="measure-overlay" pointerEvents="none">
    {state.picks.map((pick, index) => pick.kind === "point"
      ? <circle key={index} className="measure-pick" cx={pick.at[0]} cy={-pick.at[1]} r={5 * px} />
      : <line key={index} className="measure-pick-line" x1={pick.start[0]} y1={-pick.start[1]} x2={pick.end[0]} y2={-pick.end[1]} />)}
    {result?.kind === "points" && <>
      <line className="measure-line" x1={result.from[0]} y1={-result.from[1]} x2={result.to[0]} y2={-result.to[1]} />
      <line className="measure-component" x1={result.from[0]} y1={-result.from[1]} x2={result.to[0]} y2={-result.from[1]} />
      <line className="measure-component" x1={result.to[0]} y1={-result.from[1]} x2={result.to[0]} y2={-result.to[1]} />
    </>}
    {result?.kind === "point-line" && <line className="measure-line" x1={result.point[0]} y1={-result.point[1]} x2={result.foot[0]} y2={-result.foot[1]} />}
    {result?.kind === "lines" && result.crossing !== undefined && <circle className="measure-pick" cx={result.crossing[0]} cy={-result.crossing[1]} r={4 * px} />}
    {result !== undefined && (() => {
      const anchor = result.kind === "points" ? labelAt(result.from, result.to) : result.kind === "point-line" ? labelAt(result.point, result.foot) : result.crossing !== undefined ? flip(result.crossing) : labelAt(result.first.start, result.second.start);
      return <text className="measure-text" x={anchor[0] + 10 * px} y={anchor[1] - 10 * px} style={{ fontSize: 12.5 * px, strokeWidth: 3.5 * px }}>{describeMeasurement(result)}</text>;
    })()}
  </g>;
}
