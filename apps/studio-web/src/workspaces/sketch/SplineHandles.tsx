import type { SketchEntity } from "../../../../../packages/workbench-core/src/index.js";
import { splineTangentGrabHandle, type DragHandle } from "../../../../../packages/workbench-sketch/src/drag.js";

/**
 * Extra handles for the selected spline (audit Sketch edit E25): the tangent handle of the fit point the person is working on, and a
 * small remove button beside that fit point. Adding a fit point is a double-click on the curve; the fit points themselves are the
 * ordinary grab handles.
 */
type Spline = Extract<SketchEntity, { kind: "spline" }>;

export function SplineHandles(props: {
  readonly spline: Spline;
  readonly activeIndex: number | undefined;
  readonly px: number;
  readonly handleRadiusPx: number;
  readonly hitRadiusPx: number;
  readonly canRemove: boolean;
  readonly onGrab: (event: React.PointerEvent, handle: DragHandle) => void;
  readonly onRemove: (index: number) => void;
}): React.JSX.Element {
  const { spline, px } = props;
  const index = props.activeIndex;
  const point = index === undefined ? undefined : spline.fitPoints[index];
  const tangent = index === undefined ? undefined : splineTangentGrabHandle(spline, index);
  if (index === undefined || point === undefined || tangent === undefined) return <></>;
  return <g className="spline-handles" data-spline-handles={spline.id}>
    <line className="tangent-leader" x1={point[0]} y1={-point[1]} x2={tangent.point[0]} y2={-tangent.point[1]} pointerEvents="none" />
    <circle className="grab-hit" cx={tangent.point[0]} cy={-tangent.point[1]} r={props.hitRadiusPx * px} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); props.onGrab(event, tangent.handle); }} />
    <circle
      className="grab-handle tangent"
      data-grab-handle={tangent.id}
      cx={tangent.point[0]}
      cy={-tangent.point[1]}
      r={props.handleRadiusPx * px}
      role="button"
      aria-label={tangent.label}
      onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); props.onGrab(event, tangent.handle); }}
    />
    {props.canRemove && <g className="spline-remove" role="button" tabIndex={0} aria-label={`Remove spline point ${index + 1}`} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); props.onRemove(index); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onRemove(index); } }}>
      <circle cx={point[0] + 14 * px} cy={-point[1] - 14 * px} r={props.handleRadiusPx * 1.5 * px} />
      <path d={`M ${point[0] + 11 * px} ${-point[1] - 17 * px} L ${point[0] + 17 * px} ${-point[1] - 11 * px} M ${point[0] + 11 * px} ${-point[1] - 11 * px} L ${point[0] + 17 * px} ${-point[1] - 17 * px}`} />
      <title>Remove this fit point (Delete)</title>
    </g>}
  </g>;
}
