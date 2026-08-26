import { useEffect, useRef } from "react";
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
  useEffect(() => {
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const close = (event: PointerEvent): void => {
      if (menuRef.current?.contains(event.target as Node) !== true) props.onClose();
    };
    const keyboard = (event: KeyboardEvent): void => { if (event.key === "Escape") props.onClose(); };
    window.addEventListener("pointerdown", close, true);
    window.addEventListener("keydown", keyboard, true);
    return () => { window.removeEventListener("pointerdown", close, true); window.removeEventListener("keydown", keyboard, true); };
  }, [props.onClose]);
  let priorGroup: WorkbenchContextCommand["group"] | undefined;
  return <div ref={menuRef} className="workbench-context-menu" role="menu" aria-label={`Context commands for ${props.selectionLabel}`} style={{ left: Math.max(8, Math.min(props.x, window.innerWidth - 292)), top: Math.max(8, Math.min(props.y, window.innerHeight - 510)) }}>
    <header><span>CONTEXT</span><strong>{props.selectionLabel}</strong></header>
    <div className="context-command-list">{props.commands.map((command) => {
      const separator = priorGroup !== undefined && priorGroup !== command.group;
      priorGroup = command.group;
      return <div key={command.id} className={separator ? "context-group-start" : ""}>
        <button role="menuitem" disabled={!command.enabled} className={command.danger === true ? "danger" : ""} title={command.disabledReason} onClick={() => { if (command.enabled) props.onRun(command.id); }}>
          <CommandIcon name={command.icon} /><span>{command.label}</span>{!command.enabled && <small>Unavailable</small>}
        </button>
        {!command.enabled && command.disabledReason !== undefined && <p>{command.disabledReason}</p>}
      </div>;
    })}</div>
    <footer>Stable command IDs · RMB menu</footer>
  </div>;
}
