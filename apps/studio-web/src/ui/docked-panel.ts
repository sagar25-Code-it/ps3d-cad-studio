import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from "react";
import { anotherSurfaceOpen, escapeClosesEditPanel, NO_ESCAPE_FLAGS, type EscapeAppFlags } from "../esc-order.js";

/**
 * A docked command panel (Edit Feature) is not a modal dialog: the model stays live behind it, so the Part hotkeys, Ctrl+Z / Ctrl+B,
 * orbiting and the timeline keep working, Tab moves on out of it, and Esc cancels the command from the canvas too. These are the pure
 * rules for that, so they are tested without a window.
 */

/** A key press as the panel sees it. */
export interface DockKeyPress {
  readonly key: string;
  readonly defaultPrevented: boolean;
  /** Another dialog or an open menu owns the keyboard (it has its own Esc). */
  readonly otherSurfaceOpen: boolean;
}

/** Esc closes the docked panel wherever the focus is, unless something else already took the key or another surface is open on top. */
export function dockClosesOnKey(press: DockKeyPress): boolean {
  return press.key === "Escape" && !press.defaultPrevented && !press.otherSurfaceOpen;
}

export interface DockBoundsInput {
  /** The canvas row (below the ribbon and the tabs): its top, right and bottom edges in window pixels. */
  readonly canvas: { readonly top: number; readonly right: number; readonly bottom: number } | undefined;
  /** The timeline strip's top edge in window pixels, when it is shown. */
  readonly timelineTop: number | undefined;
  readonly viewport: { readonly width: number; readonly height: number };
}

/** The gap between the panel and the edges it sits against. */
export const DOCK_GAP = 8;

export interface DockBounds {
  /** Distance from the window's top, right and bottom edges to the panel, in pixels. */
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  /** The tallest the panel may be; taller content scrolls inside it. */
  readonly maxHeight: number;
}

/**
 * Where the panel sits: from the canvas row's top edge down to just above the timeline strip (or the canvas row's bottom when there is
 * none), at the canvas row's right edge. Measured from the window's real chrome, never from fixed offsets, so a header that wraps or a
 * status bar that grows moves it with them. With nothing measured yet it falls back to a margin inside the window.
 */
export function dockBounds(input: DockBoundsInput): DockBounds {
  const { canvas, timelineTop, viewport } = input;
  const top = Math.max(DOCK_GAP, Math.round((canvas?.top ?? 0) + DOCK_GAP));
  const lowestEdge = Math.min(timelineTop ?? viewport.height, canvas === undefined ? viewport.height : Math.max(canvas.bottom, canvas.top));
  const bottom = Math.max(DOCK_GAP, Math.round(viewport.height - lowestEdge + DOCK_GAP));
  const right = Math.max(DOCK_GAP, Math.round(viewport.width - (canvas?.right ?? viewport.width) + DOCK_GAP));
  return { top, right, bottom, maxHeight: Math.max(0, viewport.height - top - bottom) };
}

/** The style the dock's frame takes from its measured bounds. */
export function dockStyle(bounds: DockBounds): CSSProperties {
  return { "--dock-top": `${bounds.top}px`, "--dock-right": `${bounds.right}px`, "--dock-bottom": `${bounds.bottom}px`, "--dock-max-height": `${bounds.maxHeight}px` } as CSSProperties;
}

function isTextField(element: Element | null): boolean {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element instanceof HTMLElement && element.isContentEditable);
}

const FOCUSABLE = "button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]";

/**
 * Behaviour of a docked panel: focus moves to its first field when it opens (and back to where it was when it closes), Esc closes it
 * from anywhere, Tab is never trapped, and the panel's frame follows the canvas row and the timeline strip as the window changes.
 */
export function useDockedPanel<T extends HTMLElement>(open: boolean, onClose: () => void, escapeFlags?: () => EscapeAppFlags): { readonly ref: RefObject<T | null>; readonly style: CSSProperties } {
  const ref = useRef<T>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const flagsRef = useRef(escapeFlags);
  flagsRef.current = escapeFlags;
  const [bounds, setBounds] = useState<DockBounds>(() => dockBounds({ canvas: undefined, timelineTop: undefined, viewport: { width: 1280, height: 800 } }));

  useLayoutEffect(() => {
    if (!open) return undefined;
    const measure = (): void => {
      const grid = globalThis.document.querySelector<HTMLElement>(".workbench-grid");
      const strip = globalThis.document.querySelector<HTMLElement>(".timeline-bar");
      const box = grid?.getBoundingClientRect();
      setBounds(dockBounds({
        canvas: box === undefined ? undefined : { top: box.top, right: box.right, bottom: box.bottom },
        timelineTop: strip?.getBoundingClientRect().top,
        viewport: { width: window.innerWidth, height: window.innerHeight }
      }));
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    for (const selector of [".workbench-grid", ".timeline-bar", ".app-status"]) {
      const element = globalThis.document.querySelector(selector);
      if (element !== null) observer?.observe(element);
    }
    return () => { window.removeEventListener("resize", measure); observer?.disconnect(); };
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const active = globalThis.document.activeElement;
    const returnFocus = active instanceof HTMLElement && active !== globalThis.document.body ? active : null;
    const panel = ref.current;
    const initial = panel?.querySelector<HTMLElement>("[data-dialog-initial-focus]") ?? panel?.querySelector<HTMLElement>(FOCUSABLE) ?? panel;
    queueMicrotask(() => initial?.focus());
    // Esc is read in the capture phase so a handler lower down that stops the event (a React onKeyDown on a toolbar button or the
    // timeline) cannot swallow it, and the decision is the shared Esc order: a dialog or an open menu, a text field being edited
    // elsewhere, a running tool or pick and the command panels all come first (esc-order.ts).
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      const focused = globalThis.document.activeElement;
      const foreignTextFieldFocused = isTextField(focused) && ref.current?.contains(focused) !== true;
      const context = { ...(flagsRef.current?.() ?? NO_ESCAPE_FLAGS), otherSurfaceOpen: anotherSurfaceOpen(globalThis.document), foreignTextFieldFocused, editPanelOpen: true };
      if (!dockClosesOnKey({ key: event.key, defaultPrevented: event.defaultPrevented, otherSurfaceOpen: false }) || !escapeClosesEditPanel(context)) return;
      closeRef.current();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      queueMicrotask(() => { if (returnFocus?.isConnected === true && globalThis.document.querySelector('[role="dialog"]') === null) returnFocus.focus(); });
    };
  }, [open]);

  return { ref, style: dockStyle(bounds) };
}
