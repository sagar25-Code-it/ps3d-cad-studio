import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { DesignFeature, DesignHistory } from "../../../../packages/workbench-core/src/index.js";
import { isFeatureActive, isHealthNote } from "../../../../packages/workbench-core/src/index.js";
import { CommandIcon } from "./CommandIcon.js";
import { nearestSlot, placeMenu, type MenuPlacement } from "./menu-placement.js";

interface TimelineBarProps {
  readonly history: DesignHistory;
  /** The one step the user picked (or the selection resolves to): only its chip shows as selected. */
  readonly selectedFeatureId: string | null;
  readonly busy: boolean;
  readonly onSelect: (feature: DesignFeature) => void;
  readonly onEdit: (feature: DesignFeature) => void;
  readonly onRollback: (index: number) => void;
  readonly onSuppress: (feature: DesignFeature, suppressed: boolean) => void;
  readonly onDelete: (feature: DesignFeature) => void;
  readonly onRename: (feature: DesignFeature, name: string) => void;
  /** Find in browser: select the step's row in the model browser and bring it into view. */
  readonly onReveal?: (feature: DesignFeature) => void;
}

const ICONS: Readonly<Record<DesignFeature["kind"], string>> = { sketch: "sketch", extrude: "extrude", revolve: "revolve", sweep: "extrude", loft: "extrude", "edge-fillet": "fillet", "edge-chamfer": "chamfer", shell: "shell", draft: "draft", "move-body": "move", "scale-body": "scale", "move-face": "move", "offset-face": "scale", helix: "revolve", thread: "revolve", rib: "extrude", dome: "extrude", emboss: "move", indent: "chamfer", combine: "unite", "sheet-base": "extrude", "sheet-flange": "extrude", "sheet-hem": "extrude", "sheet-edge-flange": "extrude", hole: "bore", pattern: "pattern", "edge-blend": "fillet", "offset-region": "offset-face", "replace-face": "replace-face", web: "extrude", wrap: "move", flex: "move", "sheet-jog": "extrude", "sheet-lofted-bend": "extrude" };

/**
 * The parametric timeline: one chip per step, a rollback marker you can drag (or click a slot, or use the step buttons) to see the
 * model as it was, and a menu on each step to edit it or its profile sketch, suppress, rename, roll the marker to it, find it in the
 * browser or delete it. A step after the marker is rolled back (dimmed, its solid hidden); a suppressed
 * step is skipped; a step whose last rebuild failed is flagged in red with the reason.
 */
export function TimelineBar(props: TimelineBarProps): React.JSX.Element {
  const { history } = props;
  const [menu, setMenu] = useState<{ readonly feature: DesignFeature; readonly x: number; readonly y: number } | undefined>(undefined);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const menuRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  /** Where the context menu sits once it has been measured; it is kept whole inside the window. */
  const [placement, setPlacement] = useState<MenuPlacement | undefined>(undefined);
  /** The slot the rollback marker would land in while it is being dragged. */
  const [drag, setDrag] = useState<{ readonly slot: number } | undefined>(undefined);
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

  // The menu closes on Esc, a click outside, a resize and a scroll outside it (it is fixed to the window, so it would be left behind).
  useEffect(() => {
    if (menu === undefined) return undefined;
    const close = (event: Event): void => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if ((event.type === "pointerdown" || event.type === "scroll") && menuRef.current?.contains(event.target as Node) === true) return;
      setMenu(undefined);
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", close, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      window.removeEventListener("pointerdown", close, true);
      window.removeEventListener("keydown", close, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [menu]);
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (menu === undefined || element === null) { setPlacement(undefined); return; }
    setPlacement(placeMenu({ x: menu.x, y: menu.y }, { width: element.offsetWidth, height: element.scrollHeight }, { width: window.innerWidth, height: window.innerHeight }));
    element.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus({ preventScroll: true });
  }, [menu]);

  // Dragging the rollback marker: the slot nearest the pointer is the target; the move is made once, on release.
  const slotCenters = (): readonly number[] => [...(trackRef.current?.querySelectorAll<HTMLElement>("[data-marker-index]") ?? [])]
    .sort((a, b) => Number(a.dataset["markerIndex"]) - Number(b.dataset["markerIndex"]))
    .map((element) => { const box = element.getBoundingClientRect(); return box.left + box.width / 2; });
  useEffect(() => {
    if (drag === undefined) return undefined;
    const cancel = (event: KeyboardEvent): void => { if (event.key === "Escape") setDrag(undefined); };
    window.addEventListener("keydown", cancel, true);
    return () => window.removeEventListener("keydown", cancel, true);
  }, [drag === undefined]);

  const marker = (index: number): React.JSX.Element => {
    const current = history.rollbackIndex === index;
    const target = drag !== undefined && drag.slot === index && !current;
    if (!current) return <span
      key={`marker-${index}`}
      data-marker-index={index}
      className={`timeline-marker${target ? " drop" : ""}`}
      role="button"
      tabIndex={0}
      aria-label={`Roll back to after step ${index}`}
      title="Move the rollback marker here"
      onClick={() => props.onRollback(index)}
      onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); props.onRollback(index); } }}
    />;
    return <span
      key={`marker-${index}`}
      data-marker-index={index}
      className={`timeline-marker current${drag === undefined ? "" : " dragging"}`}
      role="button"
      tabIndex={0}
      aria-label="Rollback marker. Drag it, or press the left and right arrow keys, to roll the model back or forward."
      title="Rollback marker: steps after it are off. Drag it to roll back or forward."
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        setDrag({ slot: index });
      }}
      onPointerMove={(event) => {
        if (drag === undefined) return;
        const slot = nearestSlot(slotCenters(), event.clientX);
        if (slot >= 0 && slot !== drag.slot) setDrag({ slot });
      }}
      onPointerUp={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        const landed = drag?.slot;
        setDrag(undefined);
        if (landed !== undefined && landed !== index) props.onRollback(landed);
      }}
      onPointerCancel={() => setDrag(undefined)}
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" && index > 0) { event.preventDefault(); props.onRollback(index - 1); }
        else if (event.key === "ArrowRight" && index < features.length) { event.preventDefault(); props.onRollback(index + 1); }
      }}
    />;
  };

  const stepBy = (delta: number): void => props.onRollback(Math.min(features.length, Math.max(0, history.rollbackIndex + delta)));

  return <section className="timeline-bar" style={{ bottom }} aria-label="Design timeline">
    <div className="timeline-controls" role="group" aria-label="Timeline playback">
      <button onClick={() => props.onRollback(0)} disabled={features.length === 0 || history.rollbackIndex === 0} title="Roll back to the start" aria-label="Roll back to the start"><CommandIcon name="home" /></button>
      <button onClick={() => stepBy(-1)} disabled={history.rollbackIndex === 0} title="Step back" aria-label="Step back">‹</button>
      <button onClick={() => stepBy(1)} disabled={history.rollbackIndex >= features.length} title="Step forward" aria-label="Step forward">›</button>
      <button onClick={() => props.onRollback(features.length)} disabled={history.rollbackIndex >= features.length} title="Roll forward to the end" aria-label="Roll forward to the end"><CommandIcon name="fit" /></button>
    </div>
    <div ref={trackRef} className="timeline-track" role="list">
      {features.length === 0
        ? <p className="timeline-empty">History starts when you finish a sketch. Extrude or revolve it and every step is recorded here; edit any step later and the steps after it rebuild.</p>
        : <>
          {features.map((feature, index) => {
            const active = isFeatureActive(history, feature.id);
            const selected = props.selectedFeatureId === feature.id;
            const rolledBack = index >= history.rollbackIndex;
            const classes = ["timeline-chip", selected ? "selected" : "", feature.suppressed ? "suppressed" : "", rolledBack ? "rolled-back" : "", feature.health !== undefined ? (isHealthNote(feature.health.message) ? "note" : "error") : "", !active && !rolledBack && !feature.suppressed ? "inactive" : ""].filter(Boolean).join(" ");
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
                  aria-label={`${feature.name}${feature.health === undefined ? "" : `, ${isHealthNote(feature.health.message) ? "" : "needs attention: "}${feature.health.message}`}`}
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
                  {feature.health !== undefined && <b className="timeline-badge" aria-hidden="true">{isHealthNote(feature.health.message) ? "i" : "!"}</b>}
                </button>}
            </span>;
          })}
          {marker(features.length)}
        </>}
    </div>
    {menu !== undefined && <TimelineMenu
      menuRef={menuRef}
      feature={menu.feature}
      history={history}
      placement={placement}
      onClose={() => setMenu(undefined)}
      onEdit={props.onEdit}
      onSuppress={props.onSuppress}
      onRename={(feature) => { setDraft(feature.name); setRenaming(feature.id); }}
      onRollback={props.onRollback}
      onDelete={props.onDelete}
      {...(props.onReveal === undefined ? {} : { onReveal: props.onReveal })}
    />}
  </section>;
}

interface TimelineMenuProps {
  readonly menuRef: React.RefObject<HTMLDivElement | null>;
  readonly feature: DesignFeature;
  readonly history: DesignHistory;
  readonly placement: MenuPlacement | undefined;
  readonly onClose: () => void;
  readonly onEdit: (feature: DesignFeature) => void;
  readonly onSuppress: (feature: DesignFeature, suppressed: boolean) => void;
  readonly onRename: (feature: DesignFeature) => void;
  readonly onRollback: (index: number) => void;
  readonly onDelete: (feature: DesignFeature) => void;
  readonly onReveal?: (feature: DesignFeature) => void;
}

/** The right-click menu of a step. It is fixed to the window and kept inside it; its list scrolls when the window is short. */
export function TimelineMenu({ menuRef, feature, history, placement, onClose, onEdit, onSuppress, onRename, onRollback, onDelete, onReveal }: TimelineMenuProps): React.JSX.Element {
  const index = history.features.findIndex((candidate) => candidate.id === feature.id);
  const profileSketch = feature.kind === "sketch" ? undefined : history.features.find((candidate) => candidate.id === feature.sketchFeatureId && candidate.kind === "sketch");
  const markerHere = history.rollbackIndex === index + 1;
  const run = (action: () => void): (() => void) => () => { action(); onClose(); };
  return <div
    ref={menuRef}
    className="timeline-menu"
    role="menu"
    aria-label={`${feature.name} actions`}
    style={placement === undefined ? { left: 0, top: 0, visibility: "hidden" } : { left: placement.left, top: placement.top, maxHeight: placement.maxHeight }}
    onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }}
  >
    <button role="menuitem" onClick={run(() => onEdit(feature))}>{feature.kind === "sketch" ? "Edit sketch" : "Edit feature"}</button>
    {profileSketch !== undefined && <button role="menuitem" onClick={run(() => onEdit(profileSketch))}>Edit profile sketch</button>}
    <button role="menuitem" onClick={run(() => onSuppress(feature, !feature.suppressed))}>{feature.suppressed ? "Unsuppress" : "Suppress"}</button>
    <button role="menuitem" onClick={run(() => onRename(feature))}>Rename</button>
    <button role="menuitem" disabled={markerHere} title={markerHere ? "The rollback marker is already right after this step." : "Roll the model back to just after this step"} onClick={run(() => onRollback(index + 1))}>Roll marker here</button>
    {onReveal !== undefined && <button role="menuitem" onClick={run(() => onReveal(feature))}>Find in browser</button>}
    <button role="menuitem" className="danger" onClick={run(() => onDelete(feature))}>Delete</button>
  </div>;
}
