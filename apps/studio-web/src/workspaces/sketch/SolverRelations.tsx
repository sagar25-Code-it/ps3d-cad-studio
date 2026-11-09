import { useEffect, useMemo, useState } from "react";
import {
  SKETCH_AXIS_X_ID,
  SKETCH_AXIS_Y_ID,
  SKETCH_ORIGIN_ID,
  SOLVABLE_POINT_REFS,
  constraintFit,
  type SketchDimensionName,
  type SketchEntity,
  type SketchPointRef,
  type WorkbenchSketch,
  type WorkbenchSketchConstraint
} from "../../../../../packages/workbench-core/src/index.js";
import { entityNames } from "../../../../../packages/workbench-core/src/index.js";
import { measureDimensionConstraint } from "../../../../../packages/workbench-core/src/sketch-measure.js";
import { describeLength, formatLength, getDimensionLabelUnit, unitWord } from "../../../../../packages/workbench-sketch/src/sketch-units.js";
import { circleDimensionFacts } from "../../../../../packages/workbench-sketch/src/dimension-edit-model.js";
import { dimensionAllowsZero } from "../../../../../packages/workbench-sketch/src/dimension-text.js";
import { BoundDimensionField } from "./BoundDimensionField.js";
import { applyOf, boundExpressionOf, circleDiameterApply, circleDiameterExpression, type AcceptedDimensionRead } from "./dimension-requests.js";

/**
 * Inspector section for the solver's location tools: distances between two points (aligned, horizontal, vertical), from the sketch
 * origin, from a point to a line and between two lines; the origin and axes as things to join; point on curve; Fix of a single point;
 * and the sizes the canvas dimension tool does not offer (arc radius, circle diameter, an ellipse's axes and rotation).
 * Everything goes through the same operations the canvas uses, so it is solved, named and undone like any other edit.
 */

export type SolverSetDimension = (entityId: string, dimension: SketchDimensionName, value: number, extra?: { readonly secondEntityId?: string; readonly driven?: boolean; readonly expression?: string; readonly points?: readonly SketchPointRef[] }) => void;

export interface SolverRelationsProps {
  readonly sketch: WorkbenchSketch;
  readonly selected: readonly SketchEntity[];
  readonly onSetDimension: SolverSetDimension;
  readonly onAddConstraint: (constraint: WorkbenchSketchConstraint) => void;
  readonly onMessage: (message: string) => void;
}

const POINT_LABELS: Readonly<Record<SketchPointRef, string>> = {
  start: "Start", end: "End", mid: "Midpoint", center: "Centre", self: "Point", curve: "Curve",
  "corner-0": "Corner 1", "corner-1": "Corner 2", "corner-2": "Corner 3", "corner-3": "Corner 4"
};

const format = (value: number): string => String(Number(value.toFixed(3)));
/** A length in millimetres as the text of a field, in the unit the sketch is shown in. */
const lengthText = (valueMm: number): string => formatLength(valueMm, getDimensionLabelUnit());
const newId = (): string => `constraint:user-${crypto.randomUUID()}`;

function pointChoices(entity: SketchEntity): readonly SketchPointRef[] {
  return SOLVABLE_POINT_REFS[entity.kind];
}

function PointSelect(props: { readonly label: string; readonly entity: SketchEntity; readonly value: SketchPointRef | undefined; readonly onChange: (ref: SketchPointRef) => void }): React.JSX.Element | null {
  const choices = pointChoices(props.entity);
  if (choices.length === 0) return null;
  return <label className="extra-row"><span>{props.label}</span>
    <select aria-label={props.label} value={props.value ?? choices[0]} onChange={(event) => props.onChange(event.target.value as SketchPointRef)}>
      {choices.map((choice) => <option key={choice} value={choice}>{POINT_LABELS[choice]}</option>)}
    </select>
  </label>;
}

export function SolverRelations(props: SolverRelationsProps): React.JSX.Element {
  const names = useMemo(() => entityNames(props.sketch), [props.sketch.entities]); // eslint-disable-line react-hooks/exhaustive-deps
  const [first, second] = [props.selected.at(-2) ?? props.selected.at(-1), props.selected.length >= 2 ? props.selected.at(-1) : undefined];
  const one = props.selected.length === 1 ? props.selected[0] : undefined;
  const [firstRef, setFirstRef] = useState<SketchPointRef | undefined>(undefined);
  const [secondRef, setSecondRef] = useState<SketchPointRef | undefined>(undefined);
  const [orientation, setOrientation] = useState<"aligned" | "horizontal" | "vertical">("aligned");
  const selectionKey = props.selected.map((entity) => entity.id).join("|");
  useEffect(() => { setFirstRef(undefined); setSecondRef(undefined); }, [selectionKey]);

  // What a distance would be between the current selection.
  const plan = useMemo(() => {
    if (props.selected.length === 1 && one !== undefined && pointChoices(one).length > 0) {
      const ref = firstRef ?? pointChoices(one)[0]!;
      return { kind: "origin" as const, entityIds: [SKETCH_ORIGIN_ID, one.id], points: ["self", ref] as readonly SketchPointRef[], dimension: orientation as SketchDimensionName, label: `Distance from the origin to ${names.get(one.id) ?? one.id}` };
    }
    if (props.selected.length === 2 && first !== undefined && second !== undefined) {
      if (first.kind === "line" && second.kind === "line") return { kind: "lines" as const, entityIds: [first.id, second.id], points: undefined, dimension: "line-line" as SketchDimensionName, label: `Distance between ${names.get(first.id)} and ${names.get(second.id)}` };
      if (second.kind === "line" && pointChoices(first).length > 0) {
        return { kind: "point-line" as const, entityIds: [first.id, second.id], points: [firstRef ?? pointChoices(first)[0]!] as readonly SketchPointRef[], dimension: "point-line" as SketchDimensionName, label: `Distance from ${names.get(first.id)} to ${names.get(second.id)}` };
      }
      if (pointChoices(first).length > 0 && pointChoices(second).length > 0) {
        return { kind: "points" as const, entityIds: [first.id, second.id], points: [firstRef ?? pointChoices(first)[0]!, secondRef ?? pointChoices(second)[0]!] as readonly SketchPointRef[], dimension: orientation as SketchDimensionName, label: `Distance between ${names.get(first.id)} and ${names.get(second.id)}` };
      }
    }
    return undefined;
  }, [selectionKey, firstRef, secondRef, orientation, names]); // eslint-disable-line react-hooks/exhaustive-deps

  const probe: WorkbenchSketchConstraint | undefined = plan === undefined ? undefined : { id: "constraint:probe", kind: "distance", dimension: plan.dimension as NonNullable<WorkbenchSketchConstraint["dimension"]>, entityIds: plan.entityIds, ...(plan.points === undefined ? {} : { points: plan.points }), driven: true };
  const measured = probe === undefined ? undefined : measureDimensionConstraint(props.sketch, probe);
  const fit = probe === undefined ? undefined : constraintFit("distance", probe.entityIds.map((id) => (id === SKETCH_ORIGIN_ID ? "origin" : props.sketch.entities.find((entity) => entity.id === id)?.kind)), probe.points, { dimension: plan?.dimension as SketchDimensionName });
  /** A distance is driven by a number or a parameter expression, or made a reference (measured only). */
  const apply = (read: AcceptedDimensionRead | "reference"): void => {
    if (plan === undefined) return;
    const between = { secondEntityId: plan.entityIds[1]!, ...(plan.points === undefined ? {} : { points: plan.points }) };
    if (read === "reference") { props.onSetDimension(plan.entityIds[0]!, plan.dimension, measured ?? 0, { ...between, driven: true }); return; }
    const request = applyOf(plan.dimension, read);
    props.onSetDimension(plan.entityIds[0]!, plan.dimension, request.valueMm, { ...between, ...(request.expression === undefined ? {} : { expression: request.expression }) });
  };
  const planBound = plan === undefined ? undefined : boundExpressionOf(props.sketch, { entityId: plan.entityIds[0]!, dimension: plan.dimension, secondEntityId: plan.entityIds[1]!, ...(plan.points === undefined ? {} : { points: plan.points }) });

  const requestRelation = (constraint: WorkbenchSketchConstraint): void => props.onAddConstraint(constraint);
  const ref1 = one === undefined ? undefined : firstRef ?? pointChoices(one)[0];
  const sizeFor = (entity: SketchEntity | undefined): readonly { readonly label: string; readonly dimension: SketchDimensionName; readonly value: number }[] => {
    if (entity === undefined) return [];
    if (entity.kind === "circle") return [{ label: "Diameter", dimension: "diameter", value: entity.radiusMm * 2 }];
    if (entity.kind === "arc") {
      const probeRadius = measureDimensionConstraint(props.sketch, { id: "constraint:probe", kind: "radius", entityIds: [entity.id], dimension: "radius", driven: true });
      return probeRadius === undefined ? [] : [{ label: "Arc radius", dimension: "radius", value: probeRadius }];
    }
    if (entity.kind === "ellipse") return [
      { label: "Major radius", dimension: "major-radius", value: entity.majorRadiusMm },
      { label: "Minor radius", dimension: "minor-radius", value: entity.minorRadiusMm },
      { label: "Rotation (°)", dimension: "angle", value: ((entity.rotationDeg % 360) + 360) % 360 }
    ];
    return [];
  };
  const sizes = sizeFor(one);

  return <section className="inspector-section solver-relations">
    <header><strong>Position and relations</strong><span>{props.selected.length === 0 ? "select" : `${props.selected.length} selected`}</span></header>
    {plan === undefined
      ? <p className="empty-copy">Select one curve for its distance from the origin, two curves for the distance between them (a point to a point, a point to a line, or two lines), or one curve for its size and relations below.</p>
      : <div className="dimension-field-group">
        <p className="profile-help">{plan.label}.</p>
        {(plan.kind === "origin" || plan.kind === "points" || plan.kind === "point-line") && first !== undefined && <PointSelect label={plan.kind === "origin" ? "Point of the curve" : "Point on the first"} entity={plan.kind === "origin" ? one! : first} value={firstRef} onChange={setFirstRef} />}
        {plan.kind === "points" && second !== undefined && <PointSelect label="Point on the second" entity={second} value={secondRef} onChange={setSecondRef} />}
        {(plan.kind === "origin" || plan.kind === "points") && <label className="extra-row"><span>Direction</span>
          <select aria-label="Distance direction" value={orientation} onChange={(event) => setOrientation(event.target.value as "aligned" | "horizontal" | "vertical")}>
            <option value="aligned">Aligned</option><option value="horizontal">Horizontal</option><option value="vertical">Vertical</option>
          </select></label>}
        <BoundDimensionField
          key={`${selectionKey}|${plan.dimension}|${(plan.points ?? []).join(",")}`}
          label="Distance"
          subject="the distance"
          ariaLabel={`Distance in ${unitWord(getDimensionLabelUnit())}`}
          valueText=""
          boundExpression={planBound}
          unit={getDimensionLabelUnit()}
          unitLabel={getDimensionLabelUnit()}
          zeroAllowed={dimensionAllowsZero(plan.dimension)}
          placeholder={measured === undefined ? "" : lengthText(measured)}
          submitLabel="Drive"
          submitDisabled={fit?.ok === false}
          submitTitle={fit?.ok === false ? fit.reason : "Drive the geometry to this distance and hold it"}
          onMessage={props.onMessage}
          onSubmit={(read) => apply(read)}
        ><button type="button" disabled={fit?.ok === false} title="Measure only: a reference distance never moves the geometry" onClick={() => apply("reference")}>Reference</button></BoundDimensionField>
        {measured !== undefined && <small className="extra-measure">Now {describeLength(measured)}.</small>}
      </div>}

    {sizes.length > 0 && <div className="dimension-stack">{sizes.map((size) => <SizeField key={size.dimension} entity={one!} size={size} sketch={props.sketch} onSetDimension={props.onSetDimension} onMessage={props.onMessage} />)}</div>}

    {one !== undefined && ref1 !== undefined && <div className="extra-row">
      <PointSelect label="Point" entity={one} value={firstRef} onChange={setFirstRef} />
      <button type="button" title="Put this point on the sketch origin" onClick={() => requestRelation({ id: newId(), kind: "coincident", entityIds: [SKETCH_ORIGIN_ID, one.id], points: ["self", ref1] })}>On origin</button>
      <button type="button" title="Put this point on the X axis" onClick={() => requestRelation({ id: newId(), kind: "coincident", entityIds: [one.id, SKETCH_AXIS_X_ID], points: [ref1, "curve"] })}>On X axis</button>
      <button type="button" title="Put this point on the Y axis" onClick={() => requestRelation({ id: newId(), kind: "coincident", entityIds: [one.id, SKETCH_AXIS_Y_ID], points: [ref1, "curve"] })}>On Y axis</button>
      <button type="button" title="Lock only this point; the rest of the curve can still change" onClick={() => requestRelation({ id: newId(), kind: "fixed", entityIds: [one.id], points: [ref1] })}>Fix point</button>
    </div>}
    {props.selected.length === 2 && first !== undefined && second !== undefined && pointChoices(first).length > 0 && (second.kind === "line" || second.kind === "circle" || second.kind === "arc" || second.kind === "ellipse") && <div className="extra-row">
      <PointSelect label="Point" entity={first} value={firstRef} onChange={setFirstRef} />
      <button type="button" title="Put the point of the first curve on the second curve" onClick={() => requestRelation({ id: newId(), kind: "coincident", entityIds: [first.id, second.id], points: [firstRef ?? pointChoices(first)[0]!, "curve"] })}>Point on curve</button>
    </div>}
  </section>;
}

/** The canvas Dimension tool's two-point pick: the distance between the two points (aligned, or its horizontal or vertical part) can be driven. */
export function PointDistanceField(props: { readonly sketch: WorkbenchSketch; readonly between: { readonly entityId: string; readonly secondEntityId: string; readonly points: readonly [SketchPointRef, SketchPointRef] }; readonly measured: number; readonly delta: readonly [number, number]; readonly onSetDimension: SolverSetDimension; readonly onMessage: (message: string) => void }): React.JSX.Element {
  const [direction, setDirection] = useState<"aligned" | "horizontal" | "vertical">("aligned");
  const shown = direction === "horizontal" ? Math.abs(props.delta[0]) : direction === "vertical" ? Math.abs(props.delta[1]) : props.measured;
  const bound = boundExpressionOf(props.sketch, { entityId: props.between.entityId, dimension: direction, secondEntityId: props.between.secondEntityId, points: props.between.points });
  return <div className="dimension-field-group">
    <label className="extra-row"><span>Direction</span>
      <select aria-label="Distance direction" value={direction} onChange={(event) => setDirection(event.target.value as "aligned" | "horizontal" | "vertical")}>
        <option value="aligned">Aligned</option><option value="horizontal">Horizontal</option><option value="vertical">Vertical</option>
      </select></label>
    <BoundDimensionField
      key={direction}
      label="Distance between the two points"
      subject="the distance"
      ariaLabel={`Distance in ${unitWord(getDimensionLabelUnit())}`}
      valueText={lengthText(shown)}
      boundExpression={bound}
      unit={getDimensionLabelUnit()}
      unitLabel={getDimensionLabelUnit()}
      zeroAllowed
      submitLabel="Drive"
      submitTitle="Drive the second curve so the points are this far apart; the first stays"
      onMessage={props.onMessage}
      onSubmit={(read) => {
        const request = applyOf(direction, read);
        props.onSetDimension(props.between.entityId, direction, request.valueMm, { secondEntityId: props.between.secondEntityId, points: props.between.points, ...(request.expression === undefined ? {} : { expression: request.expression }) });
      }}
    />
  </div>;
}

function SizeField(props: { readonly entity: SketchEntity; readonly size: { readonly label: string; readonly dimension: SketchDimensionName; readonly value: number }; readonly sketch: WorkbenchSketch; readonly onSetDimension: SolverSetDimension; readonly onMessage: (message: string) => void }): React.JSX.Element {
  const angle = props.size.dimension === "angle";
  // A circle's Diameter field edits the dimension the circle already has: a Radius dimension takes half of it, so the two never disagree.
  const circle = props.entity.kind === "circle" && props.size.dimension === "diameter" ? circleDimensionFacts(props.sketch, props.entity) : undefined;
  const bound = circle !== undefined ? circleDiameterExpression(circle) : boundExpressionOf(props.sketch, { entityId: props.entity.id, dimension: props.size.dimension });
  return <BoundDimensionField
    key={props.entity.id + props.size.dimension}
    label={props.size.label}
    subject={props.size.label.toLowerCase()}
    ariaLabel={angle ? props.size.label : `${props.size.label} (${getDimensionLabelUnit()})`}
    valueText={angle ? format(props.size.value) : lengthText(props.size.value)}
    boundExpression={bound}
    unit={getDimensionLabelUnit()}
    unitLabel={angle ? "°" : getDimensionLabelUnit()}
    angle={angle}
    submitLabel="Drive"
    onMessage={props.onMessage}
    onSubmit={(read) => {
      const request = circle !== undefined ? circleDiameterApply(read, circle.diameterConstraint) : applyOf(props.size.dimension, read);
      props.onSetDimension(props.entity.id, request.dimension, request.valueMm, request.expression === undefined ? undefined : { expression: request.expression });
    }}
  ><button type="button" title="Measure only" onClick={() => props.onSetDimension(props.entity.id, props.size.dimension, props.size.value, { driven: true })}>Reference</button></BoundDimensionField>;
}
