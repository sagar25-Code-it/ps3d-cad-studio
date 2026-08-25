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
    const queryTokens = query.trim().toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
    return CAD_COMMANDS.filter((command) => {
      if (scope !== "all" && command.workspace !== scope) return false;
      const haystack = [
        command.name, command.description, command.workspace, command.category, command.group, command.level,
        ...command.keywords, command.guide.selection, ...command.guide.steps, command.guide.result, command.guide.boundary
      ].join(" ").toLowerCase();
      const searchTokens = haystack.split(/[^a-z0-9]+/u).filter(Boolean);
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
    <section ref={dialogRef} tabIndex={-1} className="command-palette" role="dialog" aria-modal="true" aria-label="All Commands" data-workspace={workspace} onMouseDown={(event) => event.stopPropagation()}>
      <header className="palette-header">
        <span className="palette-symbol"><CommandIcon name="command" /></span>
        <label>
          <span>All Commands · search and usage guide</span>
          <input
            data-dialog-initial-focus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown" && filtered.length > 0) { event.preventDefault(); setActiveIndex((current) => Math.min(current + 1, filtered.length - 1)); }
              if (event.key === "ArrowUp" && filtered.length > 0) { event.preventDefault(); setActiveIndex((current) => Math.max(current - 1, 0)); }
              if (event.key === "Enter" && filtered[activeIndex] !== undefined) { event.preventDefault(); execute(filtered[activeIndex]); }
            }}
            placeholder="Type a tool, operation, workspace, prerequisite, or shortcut…"
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
      <div className="command-browser-main">
        <div className="command-results" id="command-results" role="listbox" aria-label="Matching commands">
          {filtered.map((command, index) => <button
            id={`command-option-${command.id}`}
            key={command.id}
            role="option"
            aria-selected={index === activeIndex}
            className={index === activeIndex ? "active" : ""}
            data-workspace={command.workspace}
            onMouseMove={() => setActiveIndex(index)}
            onClick={() => setActiveIndex(index)}
            onDoubleClick={() => execute(command)}
          >
            <span className="command-code"><CommandIcon name={inferCommandIcon(`${command.name} ${command.category}`, command.workspace)} /></span>
            <span><strong>{command.name}</strong><small>{command.description}</small><em><b className={`command-level ${command.level}`}>{command.level}</b>{command.group}{command.shortcut === undefined ? "" : ` · ${command.shortcut}`}</em></span>
            <kbd>{command.shortcut ?? "↵"}</kbd>
          </button>)}
          {filtered.length === 0 && <p><CommandIcon name="inspect" />No bounded command matches that search.</p>}
        </div>
        <CommandGuide command={filtered[activeIndex]} onRun={execute} />
      </div>
      <footer><span><strong>{filtered.length}</strong> of {CAD_COMMANDS.length} commands</span><span>↑ ↓ inspect · Enter run · double-click run</span><span>Capability state is explicit</span><button onClick={onClose}>Esc close</button></footer>
    </section>
  </div>;
}

function CommandGuide({ command, onRun }: { readonly command: CadCommandRecord | undefined; readonly onRun: (command: CadCommandRecord) => void }): React.JSX.Element {
  if (command === undefined) return <aside className="command-guide empty"><CommandIcon name="inspect" /><strong>No command selected</strong><span>Change the search or workspace filter.</span></aside>;
  const available = command.level !== "unavailable";
  return <aside className="command-guide" data-workspace={command.workspace}>
    <header><span className="command-guide-icon"><CommandIcon name={inferCommandIcon(`${command.name} ${command.category}`, command.workspace)} /></span><div><small>{command.group}</small><strong>{command.name}</strong></div><b className={`command-level ${command.level}`}>{command.level}</b></header>
    <section><h3>Selection</h3><p>{command.guide.selection}</p></section>
    <section><h3>How to use</h3><ol>{command.guide.steps.map((step, index) => <li key={`${command.id}:step:${index}`}>{step}</li>)}</ol></section>
    <section><h3>Result</h3><p>{command.guide.result}</p></section>
    <section className={`command-boundary ${available ? "preview" : "unavailable"}`}><h3>{available ? "Verification boundary" : "Why execution is gated"}</h3><p>{command.guide.boundary}</p></section>
    <button className="command-run" onClick={() => onRun(command)}><CommandIcon name={available ? "arrow-right" : "inspect"} />{available ? `Run ${command.name}` : "Show implementation boundary"}</button>
  </aside>;
}
