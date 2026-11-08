import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesignFeature, DesignHistory } from "../../../../packages/workbench-core/src/index.js";
import { isFeatureActive } from "../../../../packages/workbench-core/src/index.js";
import { CommandIcon } from "./CommandIcon.js";

interface TimelineBarProps {
  readonly history: DesignHistory;
  readonly selectedId: string | null;
  readonly busy: boolean;
  readonly onSelect: (feature: DesignFeature) => void;
  readonly onEdit: (feature: DesignFeature) => void;
  readonly onRollback: (index: number) => void;
  readonly onSuppress: (feature: DesignFeature, suppressed: boolean) => void;
  readonly onDelete: (feature: DesignFeature) => void;
  readonly onRename: (feature: DesignFeature, name: string) => void;
}

const ICONS: Readonly<Record<DesignFeature["kind"], string>> = { sketch: "sketch", extrude: "extrude", revolve: "revolve", sweep: "extrude", loft: "extrude", "edge-fillet": "fillet", "edge-chamfer": "chamfer", shell: "shell", draft: "draft", "move-body": "move", "scale-body": "scale", "move-face": "move", "offset-face": "scale", helix: "revolve", thread: "revolve", rib: "extrude", dome: "extrude", emboss: "move", indent: "chamfer", "sheet-base": "extrude", "sheet-flange": "extrude", "sheet-hem": "extrude", "sheet-edge-flange": "extrude", hole: "bore" };

/**
 * The parametric timeline: one chip per step, a rollback marker you can move to see the model as it was, and a menu on each
 * step to edit, suppress, rename or delete it. A step after the marker is rolled back (dimmed, its solid hidden); a suppressed
 * step is skipped; a step whose last rebuild failed is flagged in red with the reason.
 */
export function TimelineBar(props: TimelineBarProps): React.JSX.Element {
  const { history } = props;
  const [menu, setMenu] = useState<{ readonly feature: DesignFeature; readonly x: number; readonly y: number } | undefined>(undefined);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const features = history.features;
  // The status bar changes height with the responsive layout, so the strip sits on top of wherever it actually is.
  const [bottom, setBottom] = useState(34);
  useLayoutEffect(() => {
    const status = document.querySelector<HTMLElement>(".app-status");
    if (status === null) return undefined;
    const measure = (): void => setBottom(Math.round(status.getBoundingClientRect().height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(status);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (menu === undefined) return undefined;
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof PointerEvent && menuRef.current?.contains(event.target as Node) === true) return;
      setMenu(undefined);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", close, true); };
  }, [menu]);

  const marker = (index: number): React.JSX.Element => <span
    key={`marker-${index}`}
    className={`timeline-marker${history.rollbackIndex === index ? " current" : ""}`}
    role="button"
    tabIndex={history.rollbackIndex === index ? -1 : 0}
    aria-label={history.rollbackIndex === index ? "Rollback marker" : `Roll back to after step ${index}`}
    title={history.rollbackIndex === index ? "Rollback marker: steps after it are off" : "Move the rollback marker here"}
    onClick={() => props.onRollback(index)}
    onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onRollback(index); } }}
  />;

  const stepBy = (delta: number): void => props.onRollback(Math.min(features.length, Math.max(0, history.rollbackIndex + delta)));

  return <section className="timeline-bar" style={{ bottom }} aria-label="Design timeline">
    <div className="timeline-controls" role="group" aria-label="Timeline playback">
      <button onClick={() => props.onRollback(0)} disabled={features.length === 0 || history.rollbackIndex === 0} title="Roll back to the start" aria-label="Roll back to the start"><CommandIcon name="home" /></button>
      <button onClick={() => stepBy(-1)} disabled={history.rollbackIndex === 0} title="Step back" aria-label="Step back">‹</button>
      <button onClick={() => stepBy(1)} disabled={history.rollbackIndex >= features.length} title="Step forward" aria-label="Step forward">›</button>
      <button onClick={() => props.onRollback(features.length)} disabled={history.rollbackIndex >= features.length} title="Roll forward to the end" aria-label="Roll forward to the end"><CommandIcon name="fit" /></button>
    </div>
    <div className="timeline-track" role="list">
      {features.length === 0
        ? <p className="timeline-empty">History starts when you finish a sketch. Extrude or revolve it and every step is recorded here; edit any step later and the steps after it rebuild.</p>
        : <>
          {features.map((feature, index) => {
            const active = isFeatureActive(history, feature.id);
            const selected = props.selectedId === feature.id || (feature.kind !== "sketch" && props.selectedId === feature.bodyId);
            const rolledBack = index >= history.rollbackIndex;
            const classes = ["timeline-chip", selected ? "selected" : "", feature.suppressed ? "suppressed" : "", rolledBack ? "rolled-back" : "", feature.health !== undefined ? "error" : "", !active && !rolledBack && !feature.suppressed ? "inactive" : ""].filter(Boolean).join(" ");
            return <span key={feature.id} className="timeline-slot" role="listitem">
              {marker(index)}
              {renaming === feature.id
                ? <input
                  className="timeline-rename"
                  aria-label={`Rename ${feature.name}`}
                  autoFocus
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => setRenaming(undefined)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") { event.preventDefault(); if (draft.trim().length > 0) props.onRename(feature, draft.trim()); setRenaming(undefined); }
                    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setRenaming(undefined); }
                  }}
                />
                : <button
                  className={classes}
                  disabled={props.busy}
                  title={`${feature.name}${feature.suppressed ? " (suppressed)" : ""}${rolledBack ? " (rolled back)" : ""}${feature.health === undefined ? "" : ` - ${feature.health.message}`}\nDouble-click to edit, right-click for more.`}
                  aria-label={`${feature.name}${feature.health === undefined ? "" : `, needs attention: ${feature.health.message}`}`}
                  aria-pressed={selected}
                  onClick={() => props.onSelect(feature)}
                  onDoubleClick={() => props.onEdit(feature)}
                  onContextMenu={(event) => { event.preventDefault(); setMenu({ feature, x: event.clientX, y: event.clientY }); }}
                  onKeyDown={(event) => {
                    if (event.key === "F2") { event.preventDefault(); setDraft(feature.name); setRenaming(feature.id); }
                    else if (event.key === "Delete") { event.preventDefault(); props.onDelete(feature); }
                    else if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); props.onEdit(feature); }
                  }}
                >
                  <CommandIcon name={ICONS[feature.kind]} />
                  <span className="timeline-label">{feature.name}</span>
                  {feature.health !== undefined && <b className="timeline-badge" aria-hidden="true">!</b>}
                </button>}
            </span>;
          })}
          {marker(features.length)}
        </>}
    </div>
    {menu !== undefined && <div ref={menuRef} className="timeline-menu" role="menu" style={{ left: Math.min(menu.x, window.innerWidth - 190), top: Math.max(8, menu.y - 150) }}>
      <button role="menuitem" onClick={() => { props.onEdit(menu.feature); setMenu(undefined); }}>{menu.feature.kind === "sketch" ? "Edit sketch" : "Edit feature"}</button>
      <button role="menuitem" onClick={() => { props.onSuppress(menu.feature, !menu.feature.suppressed); setMenu(undefined); }}>{menu.feature.suppressed ? "Unsuppress" : "Suppress"}</button>
      <button role="menuitem" onClick={() => { setDraft(menu.feature.name); setRenaming(menu.feature.id); setMenu(undefined); }}>Rename</button>
      <button role="menuitem" className="danger" onClick={() => { props.onDelete(menu.feature); setMenu(undefined); }}>Delete{menu.feature.kind === "sketch" ? " (and what is built on it)" : ""}</button>
    </div>}
  </section>;
}
