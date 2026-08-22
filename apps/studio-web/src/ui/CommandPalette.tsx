import { useEffect, useMemo, useState } from "react";
import { CAD_COMMANDS, type CadCommandRecord, type WorkspaceId } from "../../../../packages/workbench-core/src/index.js";
import { CommandIcon, inferCommandIcon } from "./CommandIcon.js";
import { useDialogFocus } from "./useDialogFocus.js";

const FILTERS: readonly { readonly id: "all" | WorkspaceId; readonly label: string; readonly icon: string }[] = [
  { id: "all", label: "All", icon: "command" },
  { id: "sketch", label: "Sketch", icon: "sketch" },
  { id: "part", label: "Part", icon: "part" },
  { id: "assembly", label: "Assembly", icon: "assembly" },
  { id: "surface", label: "Surface", icon: "surface" },
  { id: "drawing", label: "Drawing", icon: "drawing" },
  { id: "electrical", label: "Electrical", icon: "electrical" },
  { id: "vehicle", label: "Vehicle", icon: "vehicle" },
  { id: "automate", label: "Automate", icon: "automate" }
];

interface CommandPaletteProps {
  readonly open: boolean;
  readonly workspace: WorkspaceId;
  readonly onClose: () => void;
  readonly onCommand: (command: CadCommandRecord) => void;
}

export function CommandPalette({ open, workspace, onClose, onCommand }: CommandPaletteProps): React.JSX.Element | null {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | WorkspaceId>("all");
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setScope(workspace);
    setActiveIndex(0);
  }, [open, workspace]);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const queryTokens = normalized.split(/[^a-z0-9]+/u).filter(Boolean);
    return CAD_COMMANDS.filter((command) => {
      if (scope !== "all" && command.workspace !== scope) return false;
      const searchTokens = `${command.name} ${command.description} ${command.workspace} ${command.category} ${command.level} ${command.keywords.join(" ")}`.toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
      return queryTokens.every((token) => searchTokens.some((candidate) => candidate.startsWith(token)));
    });
  }, [query, scope]);

  useEffect(() => { setActiveIndex(0); }, [query, scope]);
  if (!open) return null;

  const execute = (command: CadCommandRecord): void => {
    onCommand(command);
    onClose();
  };

  return <div className="palette-backdrop" role="presentation" onMouseDown={onClose}>
    <section ref={dialogRef} tabIndex={-1} className="command-palette" role="dialog" aria-modal="true" aria-label="Command launcher" data-workspace={workspace} onMouseDown={(event) => event.stopPropagation()}>
      <header className="palette-header">
        <span className="palette-symbol"><CommandIcon name="command" /></span>
        <label>
          <span>All-command search</span>
          <input
            data-dialog-initial-focus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && filtered.length > 0) { event.preventDefault(); setActiveIndex((current) => Math.min(current + 1, filtered.length - 1)); }
              if (event.key === "ArrowUp" && filtered.length > 0) { event.preventDefault(); setActiveIndex((current) => Math.max(current - 1, 0)); }
              if (event.key === "Enter" && filtered[activeIndex] !== undefined) { event.preventDefault(); execute(filtered[activeIndex]); }
            }}
            placeholder="Type a tool, operation, workspace, or shortcut…"
            aria-label="Search all CAD commands"
            role="combobox"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls="command-results"
            aria-activedescendant={filtered[activeIndex] === undefined ? undefined : `command-option-${filtered[activeIndex].id}`}
          />
        </label>
        <kbd>Ctrl K</kbd>
      </header>
      <div className="command-filter-row" role="tablist" aria-label="Command workspace filter">
        {FILTERS.map((filter) => <button
          key={filter.id}
          role="tab"
          aria-selected={scope === filter.id}
          className={scope === filter.id ? "active" : ""}
          data-workspace={filter.id === "all" ? undefined : filter.id}
          onClick={() => setScope(filter.id)}
        ><CommandIcon name={filter.icon} /><span>{filter.label}</span></button>)}
      </div>
      <div className="command-results" id="command-results" role="listbox" aria-label="Matching commands">
        {filtered.map((command, index) => <button
          id={`command-option-${command.id}`}
          key={command.id}
          role="option"
          aria-selected={index === activeIndex}
          className={index === activeIndex ? "active" : ""}
          data-workspace={command.workspace}
          onMouseMove={() => setActiveIndex(index)}
          onClick={() => execute(command)}
        >
          <span className="command-code"><CommandIcon name={inferCommandIcon(`${command.name} ${command.category}`, command.workspace)} /></span>
          <span><strong>{command.name}</strong><small>{command.description}</small><em><b className={`command-level ${command.level}`}>{command.level}</b>{command.workspace} · {command.category}{command.shortcut === undefined ? "" : ` · ${command.shortcut}`}</em></span>
          <kbd>{command.shortcut ?? "↵"}</kbd>
        </button>)}
        {filtered.length === 0 && <p><CommandIcon name="inspect" />No bounded command matches that search.</p>}
      </div>
      <footer><span><strong>{filtered.length}</strong> of {CAD_COMMANDS.length} original commands</span><span>↑ ↓ navigate · Enter run</span><span>Capability level stays explicit</span><button onClick={onClose}>Esc close</button></footer>
    </section>
  </div>;
}
