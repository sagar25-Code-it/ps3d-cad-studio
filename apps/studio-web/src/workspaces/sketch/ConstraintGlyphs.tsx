import { CommandIcon } from "../../ui/CommandIcon.js";
import {
  CONSTRAINT_GLYPH_INFO,
  CONSTRAINT_LEVELS,
  GEOMETRIC_CONSTRAINT_KINDS,
  type ConstraintDisplayLevel,
  type ConstraintDisplaySettings,
  type ConstraintRow,
  type PlacedGlyph
} from "../../../../../packages/workbench-sketch/src/constraint-glyph-layout.js";
import type { SketchConstraintKind } from "../../../../../packages/workbench-core/src/index.js";

/**
 * The relation glyphs on the sketch canvas (audit Sketch edit E09 and walkthrough item 5). Each glyph can be hovered (the related
 * geometry lights up and a leader line shows where the relation is attached), clicked to select it, and operated from the keyboard.
 * The layout comes from `layoutConstraintGlyphs`, which keeps glyphs from overlapping on small circles.
 */
export function ConstraintGlyphLayer(props: {
  readonly glyphs: readonly PlacedGlyph[];
  readonly px: number;
  readonly selectedIds: readonly string[];
  readonly hoveredId: string | null;
  readonly interactive: boolean;
  readonly titles: ReadonlyMap<string, string>;
  readonly onHover: (id: string | null) => void;
  readonly onSelect: (id: string, additive: boolean) => void;
}): React.JSX.Element {
  const { px } = props;
  return <g className="constraint-glyph-layer">{props.glyphs.map((glyph) => {
    const selected = props.selectedIds.includes(glyph.id);
    const hovered = props.hoveredId === glyph.id;
    const title = props.titles.get(glyph.id) ?? CONSTRAINT_GLYPH_INFO[glyph.kind].name;
    const x = glyph.at[0];
    const y = -glyph.at[1];
    const radius = glyph.radiusPx * px;
    return <g
      key={glyph.id}
      className={`constraint-glyph${glyph.suppressed ? " relaxed" : ""}${glyph.redundant ? " redundant" : ""}${selected ? " selected" : ""}${hovered ? " hover" : ""}${props.interactive ? " interactive" : ""}`}
      data-constraint-id={glyph.id}
      {...(props.interactive ? {
        role: "button",
        tabIndex: 0,
        "aria-label": `${title}${glyph.redundant ? " (redundant)" : ""}${selected ? ", selected" : ""}`,
        "aria-pressed": selected,
        onPointerEnter: () => props.onHover(glyph.id),
        onPointerLeave: () => props.onHover(null),
        onFocus: () => props.onHover(glyph.id),
        onBlur: () => props.onHover(null),
        onPointerDown: (event: React.PointerEvent) => { if (event.button !== 0) return; event.stopPropagation(); props.onSelect(glyph.id, event.shiftKey || event.ctrlKey || event.metaKey); },
        onKeyDown: (event: React.KeyboardEvent) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); props.onSelect(glyph.id, event.shiftKey); } }
      } : {})}
    >
      {(selected || hovered) && <line className="constraint-leader" x1={glyph.anchor[0]} y1={-glyph.anchor[1]} x2={x} y2={y} />}
      {(selected || hovered) && <circle className="constraint-anchor" cx={glyph.anchor[0]} cy={-glyph.anchor[1]} r={2.5 * px} />}
      <circle className="constraint-hit" cx={x} cy={y} r={radius + 3 * px} />
      <circle className="constraint-disc" cx={x} cy={y} r={radius} />
      <text x={x} y={y + radius * 0.5} style={{ fontSize: radius * 1.4 }}>{glyph.label}</text>
      <title>{title}</title>
    </g>;
  })}</g>;
}

/** Constraints display level, per-type show/hide and the glyph legend, for the Sketch palette. */
export function ConstraintDisplayPanel(props: {
  readonly settings: ConstraintDisplaySettings;
  readonly present: readonly SketchConstraintKind[];
  readonly onChange: (settings: ConstraintDisplaySettings) => void;
}): React.JSX.Element {
  const { settings } = props;
  return <details className="palette-constraints" open>
    <summary>Constraints display</summary>
    <div className="palette-segments" role="radiogroup" aria-label="Constraints display level">
      {CONSTRAINT_LEVELS.map((level) => <button
        key={level.id}
        type="button"
        role="radio"
        aria-checked={settings.level === level.id}
        className={settings.level === level.id ? "active" : ""}
        title={level.hint}
        onClick={() => props.onChange({ ...settings, level: level.id as ConstraintDisplayLevel })}
      >{level.label}</button>)}
    </div>
    <ul className="constraint-legend" aria-label="Relation glyph legend">
      {GEOMETRIC_CONSTRAINT_KINDS.map((kind) => {
        const info = CONSTRAINT_GLYPH_INFO[kind];
        const here = props.present.includes(kind);
        const hidden = settings.hiddenKinds.includes(kind);
        return <li key={kind} className={here ? "present" : "absent"}>
          <label title={here ? `${hidden ? "Show" : "Hide"} ${info.name} relations` : `${info.name}: none in this sketch`}>
            <input type="checkbox" checked={!hidden} onChange={() => props.onChange({ ...settings, hiddenKinds: hidden ? settings.hiddenKinds.filter((entry) => entry !== kind) : [...settings.hiddenKinds, kind] })} />
            <b aria-hidden="true">{info.label}</b>
            <span>{info.name}</span>
          </label>
        </li>;
      })}
    </ul>
  </details>;
}

/** Every relation of the sketch with a name a person can read, selectable, and deletable one by one or together. */
export function ConstraintRecordList(props: {
  readonly rows: readonly ConstraintRow[];
  readonly selectedIds: readonly string[];
  readonly redundantIds: ReadonlySet<string>;
  readonly onHover: (id: string | null) => void;
  readonly onSelect: (id: string, additive: boolean) => void;
  readonly onDelete: (ids: readonly string[]) => void;
  readonly onToggleRelaxed: (id: string, relaxed: boolean) => void;
}): React.JSX.Element {
  return <>
    <div className="record-list record-list-scroll" role="list" aria-label="All relations and dimensions">
      {props.rows.map((row) => {
        const selected = props.selectedIds.includes(row.id);
        return <div
          key={row.id}
          role="listitem"
          className={`record-row${selected ? " selected" : ""}${row.suppressed ? " relaxed" : ""}${props.redundantIds.has(row.id) ? " redundant" : ""}`}
          onPointerEnter={() => props.onHover(row.id)}
          onPointerLeave={() => props.onHover(null)}
        >
          <button type="button" className="record-pick" aria-pressed={selected} title="Select this relation and light up its geometry" onClick={(event) => props.onSelect(row.id, event.shiftKey || event.ctrlKey || event.metaKey)}>
            <CommandIcon name={row.dimension ? "dimension" : row.kind} />
            <span>{row.text}{props.redundantIds.has(row.id) ? " · redundant" : ""}{row.suppressed ? " · relaxed" : ""}</span>
          </button>
          <button type="button" className="record-relax" title={row.suppressed ? "Restore this relation" : "Relax this relation (kept, ignored by the solver)"} aria-label={`${row.suppressed ? "Restore" : "Relax"} ${row.text}`} onClick={() => props.onToggleRelaxed(row.id, !row.suppressed)}>{row.suppressed ? "Restore" : "Relax"}</button>
          <button type="button" className="record-delete danger" title="Delete this relation" aria-label={`Delete ${row.text}`} onClick={() => props.onDelete([row.id])}><CommandIcon name="trash" /></button>
        </div>;
      })}
    </div>
    {props.selectedIds.length > 0 && <button type="button" className="palette-action danger" onClick={() => props.onDelete(props.selectedIds)}><CommandIcon name="trash" />Delete {props.selectedIds.length} selected relation{props.selectedIds.length === 1 ? "" : "s"}</button>}
  </>;
}
