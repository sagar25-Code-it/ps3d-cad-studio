import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Vec2, WorkbenchSketch } from "../../../../../packages/workbench-core/src/index.js";
import { assistedInference, type SnapAssistSettings } from "../../../../../packages/workbench-sketch/src/snap-assist.js";
import { CommandIcon } from "../../ui/CommandIcon.js";

/**
 * Picking the centre of Rotate, Scale and a circular Pattern on the canvas. The panels keep their typed Centre X and Centre Y fields;
 * "Pick on canvas" lets the person click the point instead (it snaps to endpoints, centres and the origin like any placed point), and
 * the centre the fields describe is drawn on the canvas as a marker, so a typed centre can be seen before Apply.
 *
 * The workspace owns the canvas side (`useCentrePickState`: whether a pick is under way, the pointer, the marker); a panel owns its
 * fields (`useCentrePickFields`). The bridge between them is plain data, so both sides are tested without a browser.
 */
export interface PickedCentre {
  readonly point: Vec2;
  /** Changes with every pick, so picking the same point twice still refills the fields. */
  readonly serial: number;
}

/** The point a click on the canvas picks: snapped to the nearest endpoint, centre, midpoint, intersection or the origin (Ctrl turns snapping off). */
export function snapPickedCentre(input: { readonly sketch: WorkbenchSketch; readonly point: Vec2; readonly toleranceMm: number; readonly gridMm: number | undefined; readonly settings: SnapAssistSettings; readonly ctrl: boolean }): Vec2 {
  return assistedInference({ tool: "point", pointer: input.point, sketch: input.sketch, toleranceMm: input.toleranceMm, gridMm: input.gridMm, settings: input.settings, modifiers: { ctrl: input.ctrl, shift: false } }).point;
}

/** The next pick: the serial moves on even when the same point is clicked twice, so the fields refill. */
export function nextPickedCentre(previous: PickedCentre | undefined, point: Vec2): PickedCentre {
  return { point, serial: (previous?.serial ?? 0) + 1 };
}

/** Whether a pick has not been put into the fields yet (a panel that was remounted must not re-apply an old pick). */
export function isUnhandledPick(handledSerial: number, picked: PickedCentre | undefined): picked is PickedCentre {
  return picked !== undefined && picked.serial !== handledSerial;
}

/** The two fields' text for a picked point, written by `write` (millimetres to the field's unit). */
export function centreFieldTexts(picked: PickedCentre, write: (valueMm: number) => string): CentrePickFields {
  return { x: write(picked.point[0]), y: write(picked.point[1]) };
}

/** The centre two fields describe in millimetres, or undefined while either is unreadable. */
export function centreOfFields(fields: CentrePickFields, read: (text: string) => number): Vec2 | undefined {
  const x = read(fields.x);
  const y = read(fields.y);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : undefined;
}

export interface CentrePickBridge {
  readonly picking: boolean;
  readonly picked: PickedCentre | undefined;
  readonly onPicking: (picking: boolean) => void;
  /** The centre the panel's fields describe (undefined when they are unreadable or the panel closed), for the marker. */
  readonly onCentre: (centre: Vec2 | undefined) => void;
}

export interface CentrePickState {
  readonly picking: boolean;
  readonly centre: Vec2 | undefined;
  readonly hover: Vec2 | undefined;
  readonly setHover: (point: Vec2 | undefined) => void;
  /** A click on the canvas while picking: hands the point to the panel and ends the pick. */
  readonly deliver: (point: Vec2) => void;
  readonly cancel: () => void;
  readonly bridge: CentrePickBridge;
}

/** Canvas side. `resetKey` changes when the edit tool changes, which ends a pick that was under way. */
export function useCentrePickState(resetKey: string): CentrePickState {
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<PickedCentre | undefined>(undefined);
  const [centre, setCentre] = useState<Vec2 | undefined>(undefined);
  const [hover, setHover] = useState<Vec2 | undefined>(undefined);
  const last = useRef<PickedCentre | undefined>(undefined);
  useEffect(() => { setPicking(false); setHover(undefined); }, [resetKey]);
  const deliver = useCallback((point: Vec2): void => {
    last.current = nextPickedCentre(last.current, point);
    setPicked(last.current);
    setPicking(false);
    setHover(undefined);
  }, []);
  const cancel = useCallback((): void => { setPicking(false); setHover(undefined); }, []);
  const onPicking = useCallback((next: boolean): void => { setPicking(next); if (!next) setHover(undefined); }, []);
  const bridge = useMemo<CentrePickBridge>(() => ({ picking, picked, onPicking, onCentre: setCentre }), [picking, picked, onPicking]);
  return { picking, centre, hover, setHover, deliver, cancel, bridge };
}

export interface CentrePickFields {
  readonly x: string;
  readonly y: string;
}

/**
 * Panel side. A picked point fills the two fields; the point the fields describe is reported for the marker; closing the panel (or
 * changing tool) clears the marker and ends a pick under way. `read` and `write` convert between the field text and millimetres.
 */
export function useCentrePickFields(
  bridge: CentrePickBridge | undefined,
  enabled: boolean,
  fields: CentrePickFields,
  setFields: (x: string, y: string) => void,
  read: (text: string) => number,
  write: (valueMm: number) => string
): void {
  const handled = useRef(bridge?.picked?.serial ?? 0);
  const picked = bridge?.picked;
  useEffect(() => {
    if (!enabled || !isUnhandledPick(handled.current, picked)) return;
    handled.current = picked.serial;
    const texts = centreFieldTexts(picked, write);
    setFields(texts.x, texts.y);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picked, enabled]);
  const onCentre = bridge?.onCentre;
  const centre = centreOfFields(fields, read);
  const x = centre?.[0];
  const y = centre?.[1];
  useEffect(() => {
    if (onCentre === undefined) return;
    onCentre(enabled && x !== undefined && y !== undefined ? [x, y] : undefined);
  }, [onCentre, enabled, x, y]);
  const onPicking = bridge?.onPicking;
  useEffect(() => () => { onCentre?.(undefined); onPicking?.(false); }, [onCentre, onPicking]);
}

/** The "Pick on canvas" button of a panel's centre fields. */
export function CentrePickButton(props: { readonly bridge: CentrePickBridge | undefined }): React.JSX.Element | null {
  const bridge = props.bridge;
  if (bridge === undefined) return null;
  return <button
    type="button"
    className={`palette-action${bridge.picking ? " active" : ""}`}
    aria-pressed={bridge.picking}
    title={bridge.picking ? "Click a point on the canvas to use as the centre, or press Esc to cancel" : "Click a point on the canvas to use as the centre; it snaps to endpoints, centres and the origin"}
    onClick={() => bridge.onPicking(!bridge.picking)}
  ><CommandIcon name="coincident" />{bridge.picking ? "Click the centre on the canvas…" : "Pick on canvas"}</button>;
}

/** The centre on the canvas: a ring and cross where the fields say it is, and a lighter one under the pointer while a pick is under way. */
export function CentreMarker(props: { readonly centre: Vec2 | undefined; readonly hover: Vec2 | undefined; readonly px: number }): React.JSX.Element | null {
  const { centre, hover, px } = props;
  if (centre === undefined && hover === undefined) return null;
  const mark = (point: Vec2, className: string): React.JSX.Element => <g className={className} transform={`translate(${point[0]} ${-point[1]})`}>
    <circle r={7 * px} />
    <line x1={-12 * px} y1={0} x2={12 * px} y2={0} />
    <line x1={0} y1={-12 * px} x2={0} y2={12 * px} />
  </g>;
  return <g className="centre-marker" pointerEvents="none" aria-hidden="true">
    {centre !== undefined && mark(centre, "centre-marker-current")}
    {hover !== undefined && mark(hover, "centre-marker-hover")}
  </g>;
}
