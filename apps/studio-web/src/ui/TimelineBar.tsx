import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { DesignFeature, DesignHistory } from "../../../../packages/workbench-core/src/index.js";
import { isFeatureActive, isHealthNote, reorderProblem } from "../../../../packages/workbench-core/src/index.js";
import { CommandIcon } from "./CommandIcon.js";
import { InlineRename } from "./InlineRename.js";
import { nearestSlot, placeMenu, type MenuPlacement } from "./menu-placement.js";
import { dragHasStarted, dropIndexFor, edgeScroll, keyboardMoveTarget, markerKeyTarget } from "./timeline-drag.js";
import { groupIsOpen, timelineGroups, type TimelineGroup } from "./timeline-groups.js";
import { groupMenuModel } from "./timeline-group-actions.js";

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
  /** Move a step to another place (its final index). The step is refused with a reason when the move would put it before what it is built on. */
  readonly onMove?: (feature: DesignFeature, toIndex: number) => void;
  /** Suppress or unsuppress every copy of a folded pattern group as one change. Without it the group menu has no Suppress entry. */
  readonly onSuppressGroup?: (members: readonly DesignFeature[], suppressed: boolean) => void;
  /** Delete every copy of a folded pattern group (after the confirmation the host shows). Without it the group menu has no Delete entry. */
  readonly onDeleteGroup?: (group: TimelineGroup) => void;
}

/** The glyph of each step kind (HS-26): kinds that share one are the same operation in two forms (a fillet and an edge blend), not a borrowed icon. */
export const TIMELINE_ICONS: Readonly<Record<DesignFeature["kind"], string>> = { sketch: "sketch", extrude: "extrude", revolve: "revolve", sweep: "sweep", loft: "loft", "edge-fillet": "fillet", "edge-chamfer": "chamfer", shell: "shell", draft: "draft", "move-body": "move", "scale-body": "scale", "move-face": "move-face", "offset-face": "offset-face", helix: "helix", thread: "thread", rib: "rib", dome: "dome", emboss: "emboss", indent: "indent", combine: "unite", "sheet-base": "sheet-base", "sheet-flange": "sheet-flange", "sheet-hem": "sheet-hem", "sheet-edge-flange": "sheet-edge-flange", hole: "bore", pattern: "pattern", "edge-blend": "fillet", "offset-region": "offset-region", "replace-face": "replace-face", web: "web", wrap: "wrap", flex: "flex", "sheet-jog": "sheet-jog", "sheet-lofted-bend": "sheet-lofted-bend" };
const ICONS = TIMELINE_ICONS;

/**
 * The parametric timeline: one chip per step, a rollback marker you can drag (or click a slot, or use the step buttons) to see the
 * model as it was, and a menu on each step to edit it or its profile sketch, suppress, rename, roll the marker to it, find it in the
 * browser or delete it. A step after the marker is rolled back (dimmed, its solid hidden); a suppressed
 * step is skipped; a step whose last rebuild failed is flagged in red with the reason.
 */
export function TimelineBar(props: TimelineBarProps): React.JSX.Element {
  const { history } = props;
  const [menu, setMenu] = useState<{ readonly feature: DesignFeature; readonly x: number; readonly y: number; /** Set when the menu belongs to a folded group: it then acts on every copy and does not unfold the group. */ readonly group?: TimelineGroup } | undefined>(undefined);
  const [renaming, setRenaming] = useState<string | undefined>(undefined);
  const menuRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  /** Where the context menu sits once it has been measured; it is kept whole inside the window. */
  const [placement, setPlacement] = useState<MenuPlacement | undefined>(undefined);
  /** The slot the rollback marker would land in while it is being dragged. */
  const [drag, setDrag] = useState<{ readonly slot: number } | undefined>(undefined);
  /** A step being dragged along the strip: where it would land, and the reason that place is closed (when it is). */
  const [chipDrag, setChipDrag] = useState<{ readonly id: string; readonly toIndex: number; readonly refusal: string | undefined } | undefined>(undefined);
  /** A press on a step that may become a drag; it becomes one once the pointer has moved a few pixels. */
  const [press, setPress] = useState<{ readonly id: string; readonly x: number } | undefined>(undefined);
  const suppressClick = useRef(false);
  /** Set while the rollback marker is being moved with the keyboard, so focus follows it to the next slot. */
  const followMarkerFocus = useRef(false);
  /** The pattern groups the person opened (HS-19); a group that is not in here is folded into one item. */
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(new Set());
  const toggleGroup = (groupId: string): void => setOpenGroups((current) => { const next = new Set(current); if (next.has(groupId)) next.delete(groupId); else next.add(groupId); return next; });
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

  // Dragging a step: the strip scrolls under the pointer near its ends, the place the step would land in is shown on the strip itself, and the
  // move is made once, on release. A place the dependency rule closes is drawn as closed, and the reason is shown when it is let go there.
  useEffect(() => {
    if (press === undefined) return undefined;
    let started = false;
    // A folded group counts once for each step it holds, all at its own centre, so a drop lands before or after the whole group.
    const centersWithout = (id: string): readonly number[] => [...(trackRef.current?.querySelectorAll<HTMLElement>("[data-chip-id]") ?? [])]
      .filter((element) => element.dataset["chipId"] !== id)
      .flatMap((element) => { const box = element.getBoundingClientRect(); return Array.from({ length: Number(element.dataset["chipCount"] ?? 1) }, () => box.left + box.width / 2); });
    const landing = (x: number): { readonly toIndex: number; readonly refusal: string | undefined } => {
      const toIndex = dropIndexFor(centersWithout(press.id), x);
      const from = history.features.findIndex((feature) => feature.id === press.id);
      return { toIndex, refusal: toIndex === from ? undefined : reorderProblem(history, press.id, toIndex)?.message };
    };
    const move = (event: PointerEvent): void => {
      if (!started && !dragHasStarted(event.clientX - press.x)) return;
      started = true;
      const track = trackRef.current;
      if (track !== null) { const box = track.getBoundingClientRect(); track.scrollLeft += edgeScroll(box.left, box.right, event.clientX); }
      setChipDrag({ id: press.id, ...landing(event.clientX) });
    };
    const finish = (event: PointerEvent): void => {
      const wasDrag = started;
      setPress(undefined);
      setChipDrag(undefined);
      if (!wasDrag) return;
      // The click that follows a release over the same step must not select or open it.
      suppressClick.current = true;
      window.setTimeout(() => { suppressClick.current = false; }, 0);
      const feature = history.features.find((candidate) => candidate.id === press.id);
      const { toIndex } = landing(event.clientX);
      if (feature !== undefined && toIndex !== history.features.indexOf(feature)) props.onMove?.(feature, toIndex);
    };
    const cancelKey = (event: KeyboardEvent): void => { if (event.key === "Escape") { setPress(undefined); setChipDrag(undefined); } };
    const cancelPointer = (): void => { setPress(undefined); setChipDrag(undefined); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cancelPointer);
    window.addEventListener("keydown", cancelKey, true);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cancelPointer);
      window.removeEventListener("keydown", cancelKey, true);
    };
  }, [press?.id, press?.x, history]);

  /** Focus left a marker for something that is not a marker: the marker no longer pulls focus after it. */
  const leaveMarkers = (event: React.FocusEvent<HTMLElement>): void => {
    const next = event.relatedTarget;
    if (!(next instanceof Element) || next.closest(".timeline-marker") === null) followMarkerFocus.current = false;
  };
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
      onBlur={leaveMarkers}
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
      // Keyboard use: focus follows the marker. The marker is a different element in every slot, so the new one takes focus when it is
      // mounted (the ref below) for as long as focus stays on the markers; leaving them for anything else stops the following.
      ref={(element) => { if (element !== null && followMarkerFocus.current && globalThis.document.activeElement !== element) element.focus(); }}
      onBlur={leaveMarkers}
      onKeyDown={(event) => {
        const to = markerKeyTarget(event.key, index, features.length);
        if (to === undefined) return;
        event.preventDefault();
        followMarkerFocus.current = true;
        props.onRollback(to);
      }}
    />;
  };

  // Pattern groups: a run of copies made by one command is one folded item until it is opened.
  const groups = timelineGroups(history);
  const groupOf = new Map<string, TimelineGroup>();
  for (const group of groups) for (const id of group.ids) groupOf.set(id, group);
  const groupOpenNow = (group: TimelineGroup): boolean => groupIsOpen(history, group, openGroups, [renaming, chipDrag?.id, press?.id, menu?.group === undefined ? menu?.feature.id : undefined]);
  /** The step whose slot shows a step: itself, or the first step of the folded group it is inside. */
  const anchorOf = (id: string): string => { const group = groupOf.get(id); return group !== undefined && !groupOpenNow(group) ? group.ids[0]! : id; };

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
            const group = groupOf.get(feature.id);
            const folded = group !== undefined && !groupOpenNow(group);
            if (folded && group.ids[0] !== feature.id) return null;
            const active = isFeatureActive(history, feature.id);
            const selected = props.selectedFeatureId === feature.id;
            const rolledBack = index >= history.rollbackIndex;
            const dragged = chipDrag?.id === feature.id;
            const classes = ["timeline-chip", selected ? "selected" : "", dragged ? "dragging" : "", feature.suppressed ? "suppressed" : "", rolledBack ? "rolled-back" : "", feature.health !== undefined ? (isHealthNote(feature.health.message) ? "note" : "error") : "", !active && !rolledBack && !feature.suppressed ? "inactive" : ""].filter(Boolean).join(" ");
            // While a step is dragged, the slot it would land in shows a bar before it (or after the last one); a closed place shows it in red.
            const others = chipDrag === undefined ? [] : features.filter((candidate) => candidate.id !== chipDrag.id);
            const landsBefore = chipDrag !== undefined && !dragged && others[chipDrag.toIndex] !== undefined && anchorOf(others[chipDrag.toIndex]!.id) === feature.id;
            const landsAfter = chipDrag !== undefined && !dragged && chipDrag.toIndex >= others.length && others.length > 0 && anchorOf(others[others.length - 1]!.id) === feature.id;
            const closed = (landsBefore || landsAfter) && chipDrag?.refusal !== undefined;
            const slotClasses = ["timeline-slot", landsBefore ? "land-before" : "", landsAfter ? "land-after" : "", closed ? "closed" : ""].filter(Boolean).join(" ");
            if (folded) {
              const members = group.ids.map((id) => features.find((candidate) => candidate.id === id)!);
              const worst = members.find((member) => member.health !== undefined && !isHealthNote(member.health.message));
              const groupClasses = ["timeline-chip", "group", members.some((member) => member.id === props.selectedFeatureId) ? "selected" : "", members.every((member) => member.suppressed) ? "suppressed" : "", group.firstIndex >= history.rollbackIndex ? "rolled-back" : "", worst !== undefined ? "error" : ""].filter(Boolean).join(" ");
              return <span key={`group:${group.groupId}`} className={slotClasses} role="listitem">
                {marker(index)}
                <button
                  className={groupClasses}
                  disabled={props.busy}
                  data-chip-id={feature.id}
                  data-chip-count={members.length}
                  data-group-id={group.groupId}
                  aria-expanded={false}
                  aria-label={`${group.label}, folded: ${members.length} steps${worst === undefined ? "" : `, ${worst.name} needs attention: ${worst.health!.message}`}`}
                  title={`${group.label}: ${members.length} copies made by one pattern. Click to show the steps, double-click to edit the pattern, right-click for more.`}
                  onClick={() => toggleGroup(group.groupId)}
                  onDoubleClick={() => props.onEdit(feature)}
                  onContextMenu={(event) => { event.preventDefault(); setMenu({ feature, group, x: event.clientX, y: event.clientY }); }}
                >
                  <CommandIcon name={ICONS[feature.kind]} />
                  <span className="timeline-label">{group.label}</span>
                  <b className="timeline-badge group-count" aria-hidden="true">+</b>
                  {worst !== undefined && <b className="timeline-badge" aria-hidden="true">!</b>}
                </button>
              </span>;
            }
            return <span key={feature.id} className={slotClasses} role="listitem" {...(closed && chipDrag?.refusal !== undefined ? { title: chipDrag.refusal } : {})}>
              {marker(index)}
              {group !== undefined && group.ids[0] === feature.id && <button className="timeline-group-toggle" aria-expanded={true} title={`Fold ${group.label} back into one item`} aria-label={`Fold ${group.label}`} onClick={() => toggleGroup(group.groupId)}>‹</button>}
              {renaming === feature.id
                ? <InlineRename className="timeline-rename" ariaLabel={`Rename ${feature.name}`} initial={feature.name} onCommit={(name) => { props.onRename(feature, name); setRenaming(undefined); }} onCancel={() => setRenaming(undefined)} />
                : <button
                  className={classes}
                  disabled={props.busy}
                  title={`${feature.name}${feature.suppressed ? " (suppressed)" : ""}${rolledBack ? " (rolled back)" : ""}${feature.health === undefined ? "" : ` - ${feature.health.message}`}\nDouble-click to edit, drag to move, right-click for more.`}
                  data-chip-id={feature.id}
                  aria-label={`${feature.name}${feature.health === undefined ? "" : `, ${isHealthNote(feature.health.message) ? "" : "needs attention: "}${feature.health.message}`}`}
                  aria-pressed={selected}
                  onPointerDown={(event) => { if (event.button === 0 && event.pointerType !== "touch" && props.onMove !== undefined) setPress({ id: feature.id, x: event.clientX }); }}
                  onClickCapture={(event) => { if (suppressClick.current) { event.preventDefault(); event.stopPropagation(); } }}
                  onClick={() => props.onSelect(feature)}
                  onDoubleClick={() => props.onEdit(feature)}
                  onContextMenu={(event) => { event.preventDefault(); setMenu({ feature, x: event.clientX, y: event.clientY }); }}
                  onKeyDown={(event) => {
                    if (event.key === "F2") { event.preventDefault(); setRenaming(feature.id); }
                    else if (event.key === "Delete") { event.preventDefault(); props.onDelete(feature); }
                    else if (event.key === "Enter" && event.shiftKey) { event.preventDefault(); props.onEdit(feature); }
                    else if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight") && props.onMove !== undefined) {
                      event.preventDefault();
                      const to = keyboardMoveTarget(index, features.length, event.key === "ArrowLeft" ? "left" : "right");
                      if (to !== undefined) props.onMove(feature, to);
                    }
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
    {menu !== undefined && menu.group === undefined && createPortal(<TimelineMenu
      menuRef={menuRef}
      feature={menu.feature}
      history={history}
      placement={placement}
      onClose={() => setMenu(undefined)}
      onEdit={props.onEdit}
      onSuppress={props.onSuppress}
      onRename={(feature) => { setRenaming(feature.id); }}
      onRollback={props.onRollback}
      onDelete={props.onDelete}
      {...(props.onReveal === undefined ? {} : { onReveal: props.onReveal })}
      {...(props.onMove === undefined ? {} : { onMove: props.onMove })}
    />, menuHost(trackRef.current))}
    {menu?.group !== undefined && createPortal(<TimelineGroupMenu
      menuRef={menuRef}
      group={menu.group}
      history={history}
      placement={placement}
      onClose={() => setMenu(undefined)}
      onEdit={props.onEdit}
      onShow={(group) => setOpenGroups((current) => new Set(current).add(group.groupId))}
      onRollback={props.onRollback}
      {...(props.onSuppressGroup === undefined ? {} : { onSuppressGroup: props.onSuppressGroup })}
      {...(props.onDeleteGroup === undefined ? {} : { onDeleteGroup: props.onDeleteGroup })}
      {...(props.onReveal === undefined ? {} : { onReveal: props.onReveal })}
    />, menuHost(trackRef.current))}
  </section>;
}

/**
 * Where the step menu is mounted: the app root, outside the strip. The strip is `position: fixed` with its own z-index, which makes a
 * stacking context, so a menu inside it could never paint above the docked Edit panel or the command panel however high its own z-index
 * was. At the app root it competes with them directly (and still gets the `.studio-app` styles).
 */
export function menuHost(inside: Element | null): Element {
  return inside?.closest(".studio-app") ?? globalThis.document.body;
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
  readonly onMove?: (feature: DesignFeature, toIndex: number) => void;
}

/** The right-click menu of a step. It is fixed to the window and kept inside it; its list scrolls when the window is short. */
export function TimelineMenu({ menuRef, feature, history, placement, onClose, onEdit, onSuppress, onRename, onRollback, onDelete, onReveal, onMove }: TimelineMenuProps): React.JSX.Element {
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
    {onMove !== undefined && <MoveItems feature={feature} index={index} history={history} onMove={(to) => run(() => onMove(feature, to))()} />}
    <button role="menuitem" className="danger" onClick={run(() => onDelete(feature))}>Delete</button>
  </div>;
}

interface TimelineGroupMenuProps {
  readonly menuRef: React.RefObject<HTMLDivElement | null>;
  readonly group: TimelineGroup;
  readonly history: DesignHistory;
  readonly placement: MenuPlacement | undefined;
  readonly onClose: () => void;
  readonly onEdit: (feature: DesignFeature) => void;
  readonly onShow: (group: TimelineGroup) => void;
  readonly onRollback: (index: number) => void;
  readonly onSuppressGroup?: (members: readonly DesignFeature[], suppressed: boolean) => void;
  readonly onDeleteGroup?: (group: TimelineGroup) => void;
  readonly onReveal?: (feature: DesignFeature) => void;
}

/**
 * The right-click menu of a folded pattern group. The chip stands for every copy, so every entry acts on the whole group and says so;
 * a single copy is reached by showing the copies first. Opening this menu does not unfold the group.
 */
export function TimelineGroupMenu({ menuRef, group, history, placement, onClose, onEdit, onShow, onRollback, onSuppressGroup, onDeleteGroup, onReveal }: TimelineGroupMenuProps): React.JSX.Element {
  const model = groupMenuModel(history, group);
  const first = model.members[0];
  const run = (action: () => void): (() => void) => () => { action(); onClose(); };
  const markerHere = history.rollbackIndex === model.rollbackIndex;
  return <div
    ref={menuRef}
    className="timeline-menu"
    role="menu"
    aria-label={model.menuLabel}
    style={placement === undefined ? { left: 0, top: 0, visibility: "hidden" } : { left: placement.left, top: placement.top, maxHeight: placement.maxHeight }}
    onKeyDown={(event) => {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const items = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not(:disabled)') ?? [])];
      const at = items.indexOf(document.activeElement as HTMLElement);
      items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }}
  >
    {first !== undefined && <button role="menuitem" onClick={run(() => onEdit(first))}>{model.editLabel}</button>}
    <button role="menuitem" onClick={run(() => onShow(group))}>{model.showLabel}</button>
    {onSuppressGroup !== undefined && <button role="menuitem" onClick={run(() => onSuppressGroup(model.members, model.suppressTo))}>{model.suppressLabel}</button>}
    <button role="menuitem" disabled={markerHere} title={markerHere ? "The rollback marker is already right after this group." : "Roll the model back to just after the last copy"} onClick={run(() => onRollback(model.rollbackIndex))}>Roll marker after the group</button>
    {onReveal !== undefined && first !== undefined && <button role="menuitem" onClick={run(() => onReveal(first))}>Find in browser</button>}
    {onDeleteGroup !== undefined && <button role="menuitem" className="danger" onClick={run(() => onDeleteGroup(group))}>{model.deleteLabel}</button>}
  </div>;
}

/** Move earlier and Move later: the same move as a drag, for a keyboard or a touch screen. A closed move says why in its tooltip. */
function MoveItems({ feature, index, history, onMove }: { readonly feature: DesignFeature; readonly index: number; readonly history: DesignHistory; readonly onMove: (toIndex: number) => void }): React.JSX.Element {
  const item = (label: string, to: number): React.JSX.Element => {
    const problem = to < 0 ? `${feature.name} is the first step.` : to >= history.features.length ? `${feature.name} is the last step.` : reorderProblem(history, feature.id, to)?.message;
    return <button role="menuitem" disabled={problem !== undefined} title={problem ?? `Move ${feature.name} one place ${to < index ? "earlier" : "later"}`} onClick={() => onMove(to)}>{label}</button>;
  };
  return <>{item("Move earlier", index - 1)}{item("Move later", index + 1)}</>;
}
