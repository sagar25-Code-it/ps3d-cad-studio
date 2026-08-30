import { useEffect, useRef, useState } from "react";
import type { WorkbenchContextCommand } from "../../../../packages/workbench-core/src/index.js";
import { CommandIcon } from "./CommandIcon.js";

interface WorkbenchContextMenuProps {
  readonly x: number;
  readonly y: number;
  readonly selectionLabel: string;
  readonly commands: readonly WorkbenchContextCommand[];
  readonly onRun: (commandId: string) => void;
  readonly onClose: () => void;
}

export function WorkbenchContextMenu(props: WorkbenchContextMenuProps): React.JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<string>();
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node) !== true) props.onClose();
    };
    const keyboard = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        if (activeSubmenu !== undefined) { event.preventDefault(); setActiveSubmenu(undefined); return; }
        props.onClose();
      }
      if (event.key === "ArrowRight" && globalThis.document.activeElement instanceof HTMLElement) {
        const submenuId = globalThis.document.activeElement.dataset["submenuId"];
        if (submenuId !== undefined) {
          event.preventDefault();
          setActiveSubmenu(submenuId);
          window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLButtonElement>(`[data-submenu-panel="${submenuId}"] button:not(:disabled)`)?.focus());
        }
      }
      if (event.key === "ArrowLeft" && activeSubmenu !== undefined) {
        event.preventDefault();
        const parent = menuRef.current?.querySelector<HTMLButtonElement>(`[data-submenu-id="${activeSubmenu}"]`);
        setActiveSubmenu(undefined);
        window.requestAnimationFrame(() => parent?.focus());
      }
    };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", keyboard, true);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", keyboard, true); };
  }, [activeSubmenu, props.onClose]);
  let priorGroup: WorkbenchContextCommand["group"] | undefined;
  return <div ref={menuRef} className={`workbench-context-menu ${props.x > window.innerWidth - 600 ? "flip-submenus" : ""}`} role="menu" aria-label={`Context commands for ${props.selectionLabel}`} style={{ left: Math.max(8, Math.min(props.x, window.innerWidth - 292)), top: Math.max(8, Math.min(props.y, window.innerHeight - 510)) }}>
    <header><span>CONTEXT</span><strong>{props.selectionLabel}</strong></header>
    <div className="context-command-list">{props.commands.map((command) => {
      const separator = priorGroup !== undefined && priorGroup !== command.group;
      priorGroup = command.group;
      const hasChildren = (command.children?.length ?? 0) > 0;
      return <div key={command.id} className={`${separator ? "context-group-start " : ""}${hasChildren ? "context-submenu-owner" : ""}`.trim()} onMouseEnter={() => { if (hasChildren) setActiveSubmenu(command.id); }}>
        <button role="menuitem" disabled={!command.enabled} className={command.danger === true ? "danger" : ""} title={command.disabledReason} aria-haspopup={hasChildren ? "menu" : undefined} aria-expanded={hasChildren ? activeSubmenu === command.id : undefined} data-submenu-id={hasChildren ? command.id : undefined} onClick={() => { if (!command.enabled) return; if (hasChildren) setActiveSubmenu((current) => current === command.id ? undefined : command.id); else props.onRun(command.id); }}>
          <CommandIcon name={command.icon} /><span>{command.label}</span>{command.shortcut !== undefined && <kbd>{command.shortcut}</kbd>}{hasChildren && <b aria-hidden="true">›</b>}{!command.enabled && <small>Unavailable</small>}
        </button>
        {hasChildren && activeSubmenu === command.id && <div className="context-submenu" role="menu" data-submenu-panel={command.id} aria-label={command.label}>
          <header><span>VIEW</span><strong>{command.label}</strong></header>
          {command.children?.map((child) => <button key={child.id} role="menuitem" disabled={!child.enabled} title={child.disabledReason} onClick={() => { if (child.enabled) props.onRun(child.id); }}><CommandIcon name={child.icon} /><span>{child.label}</span>{child.shortcut !== undefined && <kbd>{child.shortcut}</kbd>}{!child.enabled && <small>Unavailable</small>}</button>)}
        </div>}
        {!command.enabled && command.disabledReason !== undefined && <p>{command.disabledReason}</p>}
      </div>;
    })}</div>
    <footer>Stable command IDs · RMB menu</footer>
  </div>;
}
