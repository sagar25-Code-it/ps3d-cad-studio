import type { SketchDimensionName, SketchEntity, WorkbenchSketch } from "../../../../../packages/workbench-core/src/index.js";
import { arcShape } from "../../../../../packages/workbench-core/src/sketch-measure.js";
import { circleDimensionFacts } from "../../../../../packages/workbench-sketch/src/dimension-edit-model.js";
import { formatLengthField } from "../../../../../packages/workbench-sketch/src/edit-fields.js";
import { CommandIcon } from "../../ui/CommandIcon.js";
import { sketchLength, useSketchUnit } from "../sketch-unit.js";
import { BoundDimensionField } from "./BoundDimensionField.js";
import { applyOf, boundExpressionOf, circleDiameterApply, circleDiameterExpression, circleRadiusApply, circleRadiusExpression, type DimensionApply } from "./dimension-requests.js";

/**
 * The Driving dimensions section of the inspector: the length of a line, the width and height of a rectangle, the diameter and radius of
 * a circle, the radius of an arc. Every field takes a number or a parameter expression, and a circle's two fields agree with the
 * dimension the circle already has (a hole sized as a Diameter on the canvas is edited as a Diameter here too).
 */
export type EntityDimensionName = Extract<SketchDimensionName, "length" | "width" | "height" | "radius" | "diameter">;

export interface DimensionFieldProps {
  readonly label: string;
  readonly dimension: EntityDimensionName;
  readonly entity: SketchEntity;
  readonly sketch: Pick<WorkbenchSketch, "entities" | "constraints">;
  /** The current value in millimetres. */
  readonly value: number;
  readonly onApply: (apply: DimensionApply) => void;
  readonly onMessage: (message: string) => void;
}

export function DimensionField(props: DimensionFieldProps): React.JSX.Element {
  const unit = useSketchUnit();
  const circle = props.entity.kind === "circle" ? circleDimensionFacts(props.sketch, props.entity) : undefined;
  const asDiameter = circle !== undefined && props.dimension === "diameter";
  const asRadius = circle !== undefined && props.dimension === "radius";
  const bound = asDiameter ? circleDiameterExpression(circle) : asRadius ? circleRadiusExpression(circle) : boundExpressionOf(props.sketch, { entityId: props.entity.id, dimension: props.dimension });
  // Fractions and units are read here: 1/2 in, 3/4", 12 mm, 5' 3". A bare number takes the display unit.
  return <BoundDimensionField
    label={props.label}
    ariaLabel={`${props.label} in ${unit === "in" ? "inches" : "millimeters"}`}
    valueText={formatLengthField(props.value, unit)}
    boundExpression={bound}
    unit={unit}
    unitLabel={unit}
    submitIcon={<CommandIcon name="dimension" />}
    onMessage={props.onMessage}
    onSubmit={(read) => props.onApply(asDiameter ? circleDiameterApply(read, circle.diameterConstraint) : asRadius ? circleRadiusApply(read, circle.diameterConstraint) : applyOf(props.dimension, read))}
  />;
}

export function EntityDimensions({ entity, sketch, onApply, onMessage }: { readonly entity: SketchEntity; readonly sketch: Pick<WorkbenchSketch, "entities" | "constraints">; readonly onApply: (apply: DimensionApply) => void; readonly onMessage: (message: string) => void }): React.JSX.Element {
  const common = { entity, sketch, onApply, onMessage };
  if (entity.kind === "line") return <DimensionField {...common} label="Length" dimension="length" value={Math.hypot(entity.end[0] - entity.start[0], entity.end[1] - entity.start[1])} />;
  if (entity.kind === "rectangle") return <div className="dimension-stack"><DimensionField {...common} label="Width" dimension="width" value={entity.widthMm} /><DimensionField {...common} label="Height" dimension="height" value={entity.heightMm} /></div>;
  // A circle is sized by its diameter on the canvas, so the inspector leads with it; the radius field edits the same dimension.
  if (entity.kind === "circle") return <div className="dimension-stack"><DimensionField {...common} label="Diameter" dimension="diameter" value={entity.radiusMm * 2} /><DimensionField {...common} label="Radius" dimension="radius" value={entity.radiusMm} /></div>;
  if (entity.kind === "ellipse") return <div className="dimension-stack"><DerivedLength label="Major radius" valueMm={entity.majorRadiusMm} /><DerivedLength label="Minor radius" valueMm={entity.minorRadiusMm} /></div>;
  if (entity.kind === "arc") {
    const radius = arcShape(entity.start, entity.mid, entity.end)?.radiusMm;
    return radius === undefined ? <div className="derived-dimension"><span>Three-point arc</span><strong>reference only</strong></div> : <DimensionField {...common} label="Radius" dimension="radius" value={radius} />;
  }
  return <div className="derived-dimension"><span>{entity.kind === "spline" ? "Fit-point spline" : "Sketch point"}</span><strong>reference only</strong></div>;
}

export function DerivedLength({ label, valueMm }: { readonly label: string; readonly valueMm: number }): React.JSX.Element {
  const unit = useSketchUnit();
  return <div className="derived-dimension"><span>{label}</span><strong>{sketchLength(valueMm, unit)}</strong></div>;
}
