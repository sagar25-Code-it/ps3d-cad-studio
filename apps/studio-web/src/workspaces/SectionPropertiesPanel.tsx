import { useMemo } from "react";
import { resolveProfileRegion, type SketchProfile } from "../../../../packages/workbench-sketch/src/index.js";
import { sectionPropertiesOfRegion } from "../../../../packages/workbench-sketch/src/section-properties.js";
import { useSketchUnit } from "./sketch-unit.js";

/**
 * Section properties of the selected region (the outer profile with the profiles inside it as holes): area, perimeter, centroid and the
 * second moments of area about the centroid, in the sketch's display unit.
 */
export function SectionPropertiesPanel({ profiles, selectedProfileIds }: { readonly profiles: readonly SketchProfile[]; readonly selectedProfileIds: readonly string[] }): React.JSX.Element | null {
  const unit = useSketchUnit();
  const properties = useMemo(() => {
    if (selectedProfileIds.length === 0) return undefined;
    const region = resolveProfileRegion(profiles, selectedProfileIds, { includeIslands: selectedProfileIds.length === 1 });
    return region.ok ? sectionPropertiesOfRegion(region.value.outer, region.value.holes) : undefined;
  }, [profiles, selectedProfileIds]);
  if (properties === undefined) return null;
  const length = unit === "in" ? 1 / 25.4 : 1;
  const text = (value: number, power: number): string => String(Number((value * length ** power).toPrecision(6)));
  const suffix = (power: number): string => `${unit}${power === 1 ? "" : power === 2 ? "²" : power === 4 ? "⁴" : `^${power}`}`;
  return <section className="inspector-section section-properties" aria-label="Section properties">
    <header><strong>Section properties</strong><span>{unit}</span></header>
    <dl className="compact-facts">
      <div><dt>Area</dt><dd>{text(properties.areaMm2, 2)} {suffix(2)}</dd></div>
      <div><dt>Perimeter</dt><dd>{text(properties.perimeterMm, 1)} {suffix(1)}</dd></div>
      <div><dt>Centroid</dt><dd>{text(properties.centroidMm[0], 1)}, {text(properties.centroidMm[1], 1)} {suffix(1)}</dd></div>
      <div><dt>Ixx</dt><dd>{text(properties.ixxMm4, 4)} {suffix(4)}</dd></div>
      <div><dt>Iyy</dt><dd>{text(properties.iyyMm4, 4)} {suffix(4)}</dd></div>
      <div><dt>Ixy</dt><dd>{text(properties.ixyMm4, 4)} {suffix(4)}</dd></div>
      <div><dt>Polar J</dt><dd>{text(properties.polarMm4, 4)} {suffix(4)}</dd></div>
      <div><dt>Principal</dt><dd>{text(properties.principalMm4[0], 4)} / {text(properties.principalMm4[1], 4)} {suffix(4)} at {Number(properties.principalAngleDeg.toFixed(2))}°</dd></div>
      <div><dt>Gyration</dt><dd>{text(properties.gyrationMm.x, 1)} / {text(properties.gyrationMm.y, 1)} {suffix(1)}</dd></div>
    </dl>
  </section>;
}
