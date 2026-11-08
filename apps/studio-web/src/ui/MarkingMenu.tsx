import { useEffect, useRef, useState } from "react";
import { CommandIcon } from "./CommandIcon.js";
import { clampMenuCenter, nextSlot, slotFromPointer, slotOffset, type MarkingKey, type MarkingMenuModel } from "./marking-menu.js";

interface MarkingMenuProps {
  readonly x: number;
  readonly y: number;
  readonly model: MarkingMenuModel;
  readonly onRun: (commandId: string) => void;
  /** Opens the ordinary list menu at the same place. */
  readonly onMore: () => void;
  readonly onClose: () => void;
}

const RADIUS = 124;
/** A button released after being held this long, over a slot, runs that slot (the press-and-flick gesture). */
const FLICK_HOLD_MS = 220;

/**
 * Radial context menu: eight commands round the click point. Pick one with the mouse, by flicking out towards it while
 * the button is held, with the arrow keys and Enter, or with the digits 1-8. Esc closes; the centre opens the full list.
 */
export function MarkingMenu(props: MarkingMenuProps): React.JSX.Element {
  const { model } = props;
  const center = clampMenuCenter(props.x, props.y, { width: window.innerWidth, height: window.innerHeight });
  const [active, setActive] = useState<number>(() => Math.max(0, model.items.findIndex((item) => item.enabled)));
  const opened = useRef(performance.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef(model);
  modelRef.current = model;
  const activeRef = useRef(active);
  activeRef.current = active;
  const onRunRef = useRef(props.onRun); onRunRef.current = props.onRun;
  const onCloseRef = useRef(props.onClose); onCloseRef.current = props.onClose;
  const onMoreRef = useRef(props.onMore); onMoreRef.current = props.onMore;

  useEffect(() => {
    rootRef.current?.querySelector<HTMLButtonElement>(`[data-slot="${activeRef.current}"]`)?.focus();
  }, [active]);

  useEffect(() => {
    const run = (slot: number): void => {
      const item = modelRef.current.items[slot];
      if (item === undefined || !item.enabled) return;
      onRunRef.current(item.id);
    };
    const keyboard = (event: KeyboardEvent): void => {
      const items = modelRef.current.items;
      if (event.key === "Escape") { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); run(activeRef.current); return; }
      if (event.key === "Tab" && !event.shiftKey) { event.preventDefault(); setActive(nextSlot(activeRef.current, "Tab", items)); return; }
      if (event.key === "Tab" && event.shiftKey) { event.preventDefault(); setActive(nextSlot(activeRef.current, "Shift+Tab", items)); return; }
      if (event.key === "m" || event.key === "M") { event.preventDefault(); onMoreRef.current(); return; }
      if (["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        setActive(nextSlot(activeRef.current, event.key as MarkingKey, items));
        return;
      }
      if (/^[1-8]$/.test(event.key)) {
        event.preventDefault();
        const slot = Number(event.key) - 1;
        if (slot < items.length) { setActive(slot); run(slot); }
      }
    };
    const pointerDown = (event: PointerEvent): void => {
      if (rootRef.current?.contains(event.target as Node) !== true) onCloseRef.current();
    };
    const pointerUp = (event: PointerEvent): void => {
      // Press-and-flick: releasing a held button out in a direction runs that slot.
      if (performance.now() - opened.current < FLICK_HOLD_MS) return;
      if (event.button !== 2) return;
      const slot = slotFromPointer(event.clientX - center.x, event.clientY - center.y, modelRef.current.items.length);
      if (slot !== null) run(slot); else onCloseRef.current();
    };
    window.addEventListener("keydown", keyboard, true);
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("pointerup", pointerUp, true);
    return () => {
      window.removeEventListener("keydown", keyboard, true);
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("pointerup", pointerUp, true);
    };
  }, [center.x, center.y]);

  const activeItem = model.items[active];
  return <div ref={rootRef} className="marking-menu" role="menu" aria-label={`${model.title} marking menu`} style={{ left: center.x, top: center.y }}>
    <div className="marking-ring" aria-hidden="true" />
    <button type="button" className="marking-hub" onClick={props.onMore} title="Open the full menu (M)">More&hellip;</button>
    {model.items.map((item, slot) => {
      const offset = slotOffset(slot, RADIUS);
      return <button
        key={item.id}
        type="button"
        role="menuitem"
        data-slot={slot}
        className={`marking-item ${slot === active ? "active" : ""}`}
        style={{ left: offset.x, top: offset.y }}
        disabled={!item.enabled}
        title={item.enabled ? `${item.label} (${slot + 1})` : item.disabledReason ?? "Unavailable"}
        onMouseEnter={() => setActive(slot)}
        onClick={() => { if (item.enabled) props.onRun(item.id); }}
      >
        <CommandIcon name={item.icon} /><span>{item.label}</span>{item.shortcut !== undefined && <kbd>{item.shortcut}</kbd>}
      </button>;
    })}
    <div className="marking-caption" aria-live="polite">{activeItem === undefined ? model.title : activeItem.enabled ? `${slotNumber(active)} ${activeItem.label}` : activeItem.disabledReason ?? "Unavailable"}</div>
  </div>;
}

function slotNumber(slot: number): string {
  return `${slot + 1}.`;
}
