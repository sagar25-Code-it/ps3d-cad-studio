import { useEffect, useMemo, useRef, useState } from "react";
import type { SketchDimensionName, SketchEntity, Vec2, WorkbenchSketch, WorkbenchSketchConstraint } from "../../../../../packages/workbench-core/src/index.js";
import { measureDimensionConstraint } from "../../../../../packages/workbench-core/src/sketch-measure.js";
import { splineEndFrame, type SplinePoint } from "../../../../../packages/workbench-core/src/spline-curvature.js";
import type { SketchEditPlan } from "../../../../../packages/workbench-sketch/src/edit-tools.js";
import {
  angleDimensionLayout,
  arcLengthDimensionLayout,
  arrowHead,
  dimensionLayout,
  perimeterDimensionLayout,
  type DimensionLayout
} from "../../../../../packages/workbench-sketch/src/dimension-layout.js";
import { minimumRadiusCheck, nearestSmoothJoint, setSplineEndCurvature, setSplineTangent, splineTangentHandles } from "../../../../../packages/workbench-sketch/src/spline-helpers.js";
import { createPierceEdit, type PierceHit } from "../../../../../packages/workbench-geometry/src/sketch-pierce.js";

/** What the Sketch workspace needs from the project to offer Pierce: the crossings on offer, and the edit that keeps Pierce points on theirs. */
export interface ConstraintExtrasBridge {
  /** Changes with every project revision, so Pierce points are re-checked when the model moves under them. */
  readonly revision: number;
  /** Every construction-axis and body-edge crossing of the sketch plane. Only called when the person asks for the list. */
  readonly pierceHits: () => readonly PierceHit[];
  /** The edit that moves stale Pierce points back onto their crossings, or undefined when they are all in place. */
  readonly pierceRefresh: () => SketchEditPlan | undefined;
  /** Pierce constraints whose axis or edge is gone or no longer crosses the plane. */
  readonly pierceUnresolved: () => readonly { readonly constraintId: string; readonly message: string }[];
}

export type SetDimensionRequest = (entityId: string, dimension: SketchDimensionName, value: number, extra?: { readonly secondEntityId?: string; readonly driven?: boolean; readonly expression?: string }) => void;

const format = (value: number): string => String(Number(value.toFixed(3)));

type Line = Extract<SketchEntity, { kind: "line" }>;

/** The layout of any angle, arc-length or perimeter dimension, and of a driven radius or length, from the constraint and its live measurement. */
export function extraDimensionLayout(sketch: Pick<WorkbenchSketch, "entities">, constraint: WorkbenchSketchConstraint, px: number): { readonly layout: DimensionLayout; readonly entityIds: readonly string[] } | undefined {
  const driven = constraint.driven === true;
  const entities = constraint.entityIds.map((id) => sketch.entities.find((entity) => entity.id === id));
  if (entities.some((entity) => entity === undefined || entity.visible === false)) return undefined;
  const [first, second] = entities as readonly SketchEntity[];
  const value = driven ? measureDimensionConstraint(sketch, constraint) : constraint.kind === "angle" ? constraint.valueDeg : constraint.valueMm;
  if (value === undefined || first === undefined) return undefined;
  let layout: DimensionLayout | undefined;
  if (constraint.kind === "angle" && first.kind === "line" && second?.kind === "line") layout = angleDimensionLayout(first as Line, second as Line, value, px, driven);
  else if (constraint.kind === "arc-length" && entities.length === 1) {
    if (first.kind === "arc") layout = arcLengthDimensionLayout(first, value, px, driven);
    else if (first.kind === "line") layout = withBrackets(dimensionLayout(first, "length", value, px), driven);
  } else if (constraint.kind === "perimeter" && entities.length === 1) layout = perimeterDimensionLayout(first, value, px, driven);
  else if (driven && constraint.kind === "distance" && constraint.dimension !== undefined && (constraint.dimension === "length" || constraint.dimension === "width" || constraint.dimension === "height")) layout = withBrackets(dimensionLayout(first, constraint.dimension, value, px), true);
  else if (driven && constraint.kind === "radius" && (first.kind === "circle")) layout = withBrackets(dimensionLayout(first, "radius", value, px), true);
  return layout === undefined ? undefined : { layout, entityIds: constraint.entityIds };
}

function withBrackets(layout: DimensionLayout | undefined, reference: boolean): DimensionLayout | undefined {
  return layout === undefined || !reference ? layout : { ...layout, reference: true, label: `(${layout.label})` };
}

function arcPath(layout: DimensionLayout): string | undefined {
  const arc = layout.arc;
  if (arc === undefined) return undefined;
  const at = (angle: number): string => `${arc.center[0] + arc.radiusMm * Math.cos(angle)},${-(arc.center[1] + arc.radiusMm * Math.sin(angle))}`;
  const sweep = Math.max(1e-6, Math.min(arc.sweepRad, Math.PI * 2 - 1e-6));
  // The sketch is drawn with y up, so a counter-clockwise sweep is sweep-flag 0 in the flipped SVG space.
  return `M ${at(arc.fromRad)} A ${arc.radiusMm} ${arc.radiusMm} 0 ${sweep > Math.PI ? 1 : 0} 0 ${at(arc.fromRad + sweep)}`;
}

/** Angle, arc-length and perimeter dimensions (and driven ones of every kind) drawn like the other driving dimensions; driving text opens the value editor. */
export function ExtraDimensionMarks(props: {
  readonly sketch: WorkbenchSketch;
  readonly px: number;
  readonly onEdit?: (constraint: WorkbenchSketchConstraint, anchor: Vec2) => void;
  /** With this, a press on the text selects the dimension and a double-click edits it (reference dimensions too). Without it a press edits a driving dimension, as before. */
  readonly onSelect?: (constraintId: string, additive: boolean) => void;
  readonly selectedIds?: readonly string[];
}): React.JSX.Element {
  const { sketch, px } = props;
  const marks = sketch.constraints.flatMap((constraint) => {
    const isExtra = constraint.kind === "angle" || constraint.kind === "arc-length" || constraint.kind === "perimeter";
    if (!isExtra && constraint.driven !== true) return [];
    const found = extraDimensionLayout(sketch, constraint, px);
    return found === undefined ? [] : [{ constraint, ...found }];
  });
  return <>{marks.map(({ constraint, layout }) => {
    const driven = constraint.driven === true;
    const path = arcPath(layout);
    const flip = (point: Vec2): string => `${point[0]},${-point[1]}`;
    const textWidth = (layout.label.length * 7.4 + 12) * px;
    const selecting = props.onSelect !== undefined;
    return <g key={constraint.id} className={`driving-dimension extra${driven ? " reference" : ""}${constraint.suppressed === true ? " relaxed" : ""}${props.selectedIds?.includes(constraint.id) === true ? " selected" : ""}`} data-dimension-constraint={constraint.id} pointerEvents={selecting ? undefined : props.onEdit === undefined || driven ? "none" : undefined}>
      {layout.extensionLines.map((segment, index) => <line key={index} x1={segment.from[0]} y1={-segment.from[1]} x2={segment.to[0]} y2={-segment.to[1]} />)}
      {path === undefined
        ? <line x1={layout.dimensionLine.from[0]} y1={-layout.dimensionLine.from[1]} x2={layout.dimensionLine.to[0]} y2={-layout.dimensionLine.to[1]} />
        : <path d={path} fill="none" />}
      {layout.arrows.map((arrow, index) => <polygon key={index} className="arrow" points={arrowHead(arrow, px).map(flip).join(" ")} />)}
      {(selecting || !driven) && <rect className="driving-dimension-hit" x={layout.textAt[0] - textWidth / 2} y={-layout.textAt[1] - 11 * px} width={textWidth} height={20 * px} onPointerDown={(event) => { if (event.button !== 0) return; event.stopPropagation(); if (props.onSelect !== undefined) props.onSelect(constraint.id, event.shiftKey || event.ctrlKey || event.metaKey); else props.onEdit?.(constraint, layout.textAt); }} onDoubleClick={(event) => { event.stopPropagation(); props.onEdit?.(constraint, layout.textAt); }} />}
      <text className="driving-dimension-text" x={layout.textAt[0]} y={-layout.textAt[1] + 4 * px} style={{ fontSize: 12.5 * px, strokeWidth: 3.5 * px }} pointerEvents="none">{layout.label}</text>
    </g>;
  })}</>;
}

interface ExtrasProps {
  readonly sketch: WorkbenchSketch;
  /** The selected curves in the order they were picked. */
  readonly selected: readonly SketchEntity[];
  readonly bridge: ConstraintExtrasBridge;
  readonly onSetDimension: SetDimensionRequest;
  readonly onAddConstraint: (constraint: WorkbenchSketchConstraint) => void;
  readonly onApplyEdit: (plan: SketchEditPlan) => boolean | void;
  readonly onMessage: (message: string) => void;
}

/** What the selection can be dimensioned with here: an angle between two lines, an arc length, or a perimeter. */
function dimensionTarget(selected: readonly SketchEntity[]): { readonly name: SketchDimensionName; readonly first: SketchEntity; readonly second?: SketchEntity; readonly label: string; readonly unit: string } | undefined {
  const last = selected.at(-1);
  const before = selected.at(-2);
  if (last?.kind === "line" && before?.kind === "line") return { name: "angle", first: before, second: last, label: "Angle between the last two lines", unit: "°" };
  if (selected.length === 1 && last !== undefined) {
    if (last.kind === "arc") return { name: "arc-length", first: last, label: "Arc length", unit: "mm" };
    if (last.kind === "line" || last.kind === "spline") return { name: "arc-length", first: last, label: last.kind === "line" ? "Length (reference)" : "Spline length (reference)", unit: "mm" };
    if (last.kind === "circle" || last.kind === "rectangle" || last.kind === "ellipse") return { name: "perimeter", first: last, label: "Perimeter", unit: "mm" };
  }
  return undefined;
}

/**
 * Inspector sections for the constraint work: angle, arc-length and perimeter dimensions (driving or reference), Smooth (G2) between a
 * spline and its neighbour, spline helpers (end curvature, tangent handles, minimum-radius check) and Pierce points.
 */
export function ConstraintExtras(props: ExtrasProps): React.JSX.Element {
  return <>
    <ExtraDimensionSection {...props} />
    <SmoothSection {...props} />
    <RefractionSection {...props} />
    <SplineHelperSection {...props} />
    <PierceSection {...props} />
  </>;
}

function ExtraDimensionSection(props: ExtrasProps): React.JSX.Element {
  const target = dimensionTarget(props.selected);
  const probe: WorkbenchSketchConstraint | undefined = target === undefined ? undefined : {
    id: "constraint:probe",
    kind: target.name === "angle" ? "angle" : target.name === "arc-length" ? "arc-length" : "perimeter",
    entityIds: target.second === undefined ? [target.first.id] : [target.first.id, target.second.id],
    driven: true
  };
  const measured = probe === undefined ? undefined : measureDimensionConstraint(props.sketch, probe);
  const [text, setText] = useState(() => (measured === undefined ? "" : format(measured)));
  const key = target === undefined ? "" : `${target.name}:${probe!.entityIds.join("|")}`;
  useEffect(() => { setText(measured === undefined ? "" : format(measured)); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const existing = props.sketch.constraints.filter((constraint) => (constraint.kind === "angle" || constraint.kind === "arc-length" || constraint.kind === "perimeter") && constraint.entityIds.some((id) => props.selected.some((entity) => entity.id === id)));
  const drivingAllowed = target !== undefined && !(target.name === "arc-length" && target.first.kind !== "arc");
  return <section className="inspector-section extra-dimension-controller">
    <header><strong>Angle, arc length, perimeter</strong><span>{target === undefined ? "select" : target.unit}</span></header>
    {target === undefined
      ? <p className="empty-copy">Select two lines for an angle, an arc for its length, or a circle, rectangle or ellipse for its perimeter. Reference dimensions measure and never move anything.</p>
      : <form className="dimension-field" onSubmit={(event) => {
        event.preventDefault();
        const value = Number(text.trim());
        if (!Number.isFinite(value) || (target.name !== "angle" && value <= 0)) { props.onMessage(target.name === "angle" ? "Type an angle in degrees, 0 up to 360." : "Type a length greater than zero."); return; }
        props.onSetDimension(target.first.id, target.name, value, { ...(target.second === undefined ? {} : { secondEntityId: target.second.id }) });
      }}>
        <label><span>{target.label}</span><div>
          <input aria-label={`${target.label} (${target.unit})`} inputMode="decimal" value={text} disabled={!drivingAllowed} onChange={(event) => setText(event.target.value)} />
          <small>{target.unit}</small>
          <button type="submit" disabled={!drivingAllowed} title="Drive the geometry to this value and hold it">Drive</button>
          <button type="button" title="Measure only: a reference dimension never moves the geometry" onClick={() => props.onSetDimension(target.first.id, target.name, measured ?? 1, { driven: true, ...(target.second === undefined ? {} : { secondEntityId: target.second.id }) })}>Reference</button>
        </div></label>
        {measured !== undefined && <small className="extra-measure">Now measures {format(measured)} {target.unit}.</small>}
      </form>}
    {existing.length > 0 && <ul className="extra-dimension-list">{existing.map((constraint) => {
      const value = measureDimensionConstraint(props.sketch, constraint);
      const unit = constraint.kind === "angle" ? "°" : " mm";
      const first = props.sketch.entities.find((entity) => entity.id === constraint.entityIds[0]);
      const second = props.sketch.entities.find((entity) => entity.id === constraint.entityIds[1]);
      const name: SketchDimensionName = constraint.kind === "angle" ? "angle" : constraint.kind === "arc-length" ? "arc-length" : "perimeter";
      return <li key={constraint.id}>
        <b>{constraint.kind}</b>
        <span>{constraint.driven === true ? "reference" : "driving"} {value === undefined ? "" : `${format(value)}${unit}`}</span>
        {first !== undefined && constraint.entityIds.length <= 2 && <button type="button" title={constraint.driven === true ? "Make it a driving dimension at the measured value" : "Stop driving: keep the geometry and measure it"} onClick={() => props.onSetDimension(first.id, name, value ?? 1, { driven: constraint.driven !== true, ...(second === undefined ? {} : { secondEntityId: second.id }) })}>{constraint.driven === true ? "Make driving" : "Make reference"}</button>}
      </li>;
    })}</ul>}
  </section>;
}

function SmoothSection(props: ExtrasProps): React.JSX.Element {
  const last = props.selected.at(-1);
  const before = props.selected.at(-2);
  const pair = last !== undefined && before !== undefined ? [before, last] as const : undefined;
  const spline = pair === undefined ? undefined : pair[0].kind === "spline" ? pair[0] : pair[1].kind === "spline" ? pair[1] : undefined;
  const other = pair === undefined || spline === undefined ? undefined : pair[0] === spline ? pair[1] : pair[0];
  const joint = spline === undefined || other === undefined ? undefined : nearestSmoothJoint(spline, other);
  const usable = spline !== undefined && other !== undefined && joint !== undefined && (other.kind === "line" || other.kind === "arc" || other.kind === "spline");
  const existing = props.sketch.constraints.filter((constraint) => constraint.kind === "smooth" && constraint.entityIds.some((id) => id === spline?.id));
  return <section className="inspector-section smooth-controller">
    <header><strong>Smooth (G2)</strong><span>{existing.length} on this spline</span></header>
    <p className="profile-help">Blends the end of a spline into a line, arc or spline: the ends meet, leave along the same tangent and have the same curvature. The spline adapts; the other curve stays.</p>
    <button type="button" disabled={!usable} title={usable ? "Join the nearest ends with position, tangent and curvature continuity" : "Select a spline, then Shift-click a line, arc or spline."} onClick={() => {
      if (!usable || joint === undefined || spline === undefined || other === undefined) return;
      props.onAddConstraint({ id: `constraint:user-${crypto.randomUUID()}`, kind: "smooth", entityIds: [spline.id, other.id], points: joint.points });
    }}>Smooth the nearest ends{usable && joint !== undefined ? ` (${format(joint.gapMm)} mm apart)` : ""}</button>
  </section>;
}

function RefractionSection(props: ExtrasProps): React.JSX.Element {
  const lines = props.selected.slice(-3);
  const ready = lines.length === 3 && lines.every((entity) => entity.kind === "line");
  const [ratio, setRatio] = useState("1.5");
  const existing = props.sketch.constraints.filter((constraint) => constraint.kind === "refraction" && constraint.entityIds.some((id) => props.selected.some((entity) => entity.id === id)));
  return <section className="inspector-section refraction-controller">
    <header><strong>Refraction</strong><span>{existing.length} on this selection</span></header>
    <p className="profile-help">Bends the second line at the third (the interface) by Snell's law. Select the incident line, the refracted line, then the interface line. The ratio is n2 / n1; the refracted line starts where the incident line ends.</p>
    <div className="extra-row">
      <input aria-label="Refractive index ratio n2 over n1" inputMode="decimal" value={ratio} onChange={(event) => setRatio(event.target.value)} />
      <button type="button" disabled={!ready} title={ready ? "Hold the refraction" : "Select three lines: incident, refracted, interface."} onClick={() => {
        const value = Number(ratio);
        if (!ready || !Number.isFinite(value) || value < 0.05 || value > 20) { props.onMessage("Type an index ratio between 0.05 and 20."); return; }
        props.onAddConstraint({ id: `constraint:user-${crypto.randomUUID()}`, kind: "refraction", entityIds: lines.map((entity) => entity.id), ratio: value });
      }}>Add refraction</button>
    </div>
    {existing.length > 0 && <ul className="extra-dimension-list">{existing.map((constraint) => <li key={constraint.id}><b>ratio</b><span>{format(constraint.ratio ?? 1)}</span></li>)}</ul>}
  </section>;
}

function SplineHelperSection(props: ExtrasProps): React.JSX.Element {
  const spline = props.selected.length === 1 && props.selected[0]!.kind === "spline" ? props.selected[0]! as Extract<SketchEntity, { kind: "spline" }> : undefined;
  const [limit, setLimit] = useState("5");
  const [pointIndex, setPointIndex] = useState(0);
  const [angle, setAngle] = useState("0");
  const [reach, setReach] = useState("5");
  const [startCurvature, setStartCurvature] = useState("0");
  const [endCurvature, setEndCurvature] = useState("0");
  const limitMm = Number(limit);
  const check = useMemo(() => (Number.isFinite(limitMm) && limitMm > 0 ? minimumRadiusCheck(props.sketch, limitMm) : undefined), [props.sketch.entities, limitMm]); // eslint-disable-line react-hooks/exhaustive-deps
  const handles = useMemo(() => (spline === undefined ? [] : splineTangentHandles(spline)), [spline]);
  const handle = handles[Math.min(pointIndex, Math.max(0, handles.length - 1))];
  const startFrame = spline === undefined ? undefined : splineEndFrame(spline.fitPoints as readonly SplinePoint[], "start");
  const endFrame = spline === undefined ? undefined : splineEndFrame(spline.fitPoints as readonly SplinePoint[], "end");
  useEffect(() => {
    if (handle === undefined) return;
    setAngle(format((Math.atan2(handle.tangent[1], handle.tangent[0]) * 180) / Math.PI));
    setReach(format(Math.hypot(handle.tangent[0], handle.tangent[1])));
  }, [spline?.id, handle?.index]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    setStartCurvature(startFrame === undefined ? "0" : format(startFrame.curvature));
    setEndCurvature(endFrame === undefined ? "0" : format(endFrame.curvature));
  }, [spline?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const commit = (label: string, result: { readonly ok: true; readonly fitPoints: readonly Vec2[] } | { readonly ok: false; readonly message: string }): void => {
    if (!result.ok) { props.onMessage(result.message); return; }
    if (spline === undefined) return;
    props.onApplyEdit({ label, removeEntityIds: [], addEntities: [], addConstraints: [], updateEntities: [{ ...spline, fitPoints: result.fitPoints }] });
  };
  return <section className="inspector-section spline-helper-controller">
    <header><strong>Spline helpers</strong><span>{spline === undefined ? "min radius" : `${spline.fitPoints.length} fit points`}</span></header>
    <label className="extra-row"><span>Minimum radius</span><input aria-label="Minimum radius limit in millimetres" inputMode="decimal" value={limit} onChange={(event) => setLimit(event.target.value)} /><small>mm</small></label>
    {check === undefined
      ? <p className="empty-copy">Type a positive radius to check the sketch against.</p>
      : check.ok
        ? <p className="profile-help">Every curve keeps a radius of {format(check.limitMm)} mm or more{check.entities[0] === undefined ? "." : `; the tightest is ${format(check.entities[0].minRadiusMm)} mm.`}</p>
        : <ul className="extra-dimension-list">{check.violations.map((report) => <li key={report.entityId}>
          <b>{report.kind}</b>
          <span>tightest {format(report.minRadiusMm)} mm at ({format(report.at[0])}, {format(report.at[1])}){report.tight.length > 1 ? `, ${report.tight.length} tight stretches` : ""}</span>
        </li>)}</ul>}
    {spline !== undefined && <>
      <div className="extra-row"><span>End curvature</span>
        <input aria-label="Curvature at the start (1/mm)" inputMode="decimal" value={startCurvature} onChange={(event) => setStartCurvature(event.target.value)} />
        <button type="button" onClick={() => { const value = Number(startCurvature); if (Number.isFinite(value)) commit("Set spline start curvature", setSplineEndCurvature(spline, "start", value)); }}>Start</button>
        <input aria-label="Curvature at the end (1/mm)" inputMode="decimal" value={endCurvature} onChange={(event) => setEndCurvature(event.target.value)} />
        <button type="button" onClick={() => { const value = Number(endCurvature); if (Number.isFinite(value)) commit("Set spline end curvature", setSplineEndCurvature(spline, "end", value)); }}>End</button>
      </div>
      <small className="extra-measure">Curvature is 1/radius in 1/mm; positive turns left along the fit points.</small>
      <div className="extra-row"><span>Tangent handle</span>
        <select aria-label="Fit point" value={handle?.index ?? 0} onChange={(event) => setPointIndex(Number(event.target.value))}>{handles.map((item) => <option key={item.index} value={item.index}>Point {item.index + 1}</option>)}</select>
        <input aria-label="Tangent direction in degrees" inputMode="decimal" value={angle} onChange={(event) => setAngle(event.target.value)} /><small>°</small>
        <input aria-label="Tangent reach in millimetres" inputMode="decimal" value={reach} onChange={(event) => setReach(event.target.value)} /><small>mm</small>
        <button type="button" onClick={() => {
          const degrees = Number(angle);
          const length = Number(reach);
          if (!Number.isFinite(degrees) || !Number.isFinite(length) || length <= 0 || handle === undefined) { props.onMessage("Type a direction in degrees and a reach greater than zero."); return; }
          const radians = (degrees * Math.PI) / 180;
          commit("Set spline tangent", setSplineTangent(spline, handle.index, [length * Math.cos(radians), length * Math.sin(radians)]));
        }}>Set</button>
      </div>
      {handle !== undefined && <small className="extra-measure">Point {handle.index + 1}: curvature {format(handle.curvature)} 1/mm. At an end the next fit point moves; inside, both neighbours move equally and oppositely.</small>}
    </>}
  </section>;
}

function PierceSection(props: ExtrasProps): React.JSX.Element {
  const [hits, setHits] = useState<readonly PierceHit[]>([]);
  const [choice, setChoice] = useState(0);
  const pierceCount = props.sketch.constraints.filter((constraint) => constraint.kind === "pierce").length;
  const unresolved = props.bridge.pierceUnresolved();
  const lastTried = useRef("");
  // Pierce points follow their axis or edge whenever the model, or the sketch plane, has moved them off it.
  useEffect(() => {
    const plan = props.bridge.pierceRefresh();
    if (plan === undefined) { lastTried.current = ""; return; }
    const signature = JSON.stringify(plan.updateEntities);
    if (signature === lastTried.current) return;
    lastTried.current = signature;
    props.onApplyEdit(plan);
  }, [props.bridge.revision]); // eslint-disable-line react-hooks/exhaustive-deps
  return <section className="inspector-section pierce-controller">
    <header><strong>Pierce</strong><span>{pierceCount} placed</span></header>
    <p className="profile-help">Puts a sketch point where a construction axis or a body edge crosses the sketch plane, and holds it there as the plane or the model changes.</p>
    <div className="extra-row">
      <button type="button" onClick={() => { const found = props.bridge.pierceHits(); setHits(found); setChoice(0); props.onMessage(found.length === 0 ? "No construction axis or body edge crosses this sketch plane." : `${found.length} crossing${found.length === 1 ? "" : "s"} found on this sketch plane.`); }}>Find crossings</button>
      {hits.length > 0 && <>
        <select aria-label="Crossing" value={choice} onChange={(event) => setChoice(Number(event.target.value))}>{hits.map((hit, index) => <option key={index} value={index}>{hit.label} ({format(hit.pointMm[0])}, {format(hit.pointMm[1])})</option>)}</select>
        <button type="button" onClick={() => {
          const hit = hits[Math.min(choice, hits.length - 1)];
          if (hit === undefined) return;
          const { kind: _kind, ...plan } = createPierceEdit(hit, { entityId: `entity:user-${crypto.randomUUID()}`, constraintId: `constraint:user-${crypto.randomUUID()}` });
          props.onApplyEdit(plan);
        }}>Add Pierce point</button>
      </>}
    </div>
    {unresolved.length > 0 && <ul className="extra-dimension-list">{unresolved.map((item) => <li key={item.constraintId}><b>lost</b><span>{item.message}</span></li>)}</ul>}
  </section>;
}
