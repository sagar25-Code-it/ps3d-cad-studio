import { useEffect, useMemo, useState } from "react";
import type { CadCommandRecord, WorkspaceId } from "../../../../packages/workbench-core/src/index.js";
import { searchableCommands } from "./sketch-tool-commands.js";
import { matchesCommandQuery } from "./command-match.js";
import { useSketchKeymap } from "../workspaces/sketch/useSketchKeymap.js";
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
  const [showUnavailable, setShowUnavailable] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose);
  // The catalog plus every sketch tool on the ribbon, each carrying its key from the live keymap.
  const sketchKeymap = useSketchKeymap();
  const commands = useMemo(() => searchableCommands(sketchKeymap), [sketchKeymap]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setScope(workspace);
    setShowUnavailable(false);
    setActiveIndex(0);
  }, [open, workspace]);

  const matching = useMemo(() => {
    return commands.filter((command) => (scope === "all" || command.workspace === scope) && matchesCommandQuery(command, query));
  }, [query, scope, commands]);
  // Runnable commands first-class: gated ones are hidden until asked for, so the list is what the app can actually do.
  const filtered = useMemo(() => showUnavailable ? matching : matching.filter((command) => command.level !== "unavailable"), [matching, showUnavailable]);
  const hiddenCount = matching.length - filtered.length;

  useEffect(() => { setActiveIndex(0); }, [query, scope, showUnavailable]);
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
          {filtered.length === 0 && <p><CommandIcon name="inspect" />{hiddenCount === 0 ? "No bounded command matches that search." : `No runnable command matches; ${hiddenCount} gated ${hiddenCount === 1 ? "command" : "commands"} hidden.`}</p>}
        </div>
        <CommandGuide command={filtered[activeIndex]} onRun={execute} />
      </div>
      <footer>
        <span><strong>{filtered.length}</strong> of {commands.length} commands</span>
        <label className="palette-unavailable-toggle"><input type="checkbox" checked={showUnavailable} onChange={(event) => setShowUnavailable(event.target.checked)} />Show gated ({hiddenCount === 0 && !showUnavailable ? "none here" : showUnavailable ? "shown" : hiddenCount})</label>
        <span>↑ ↓ inspect · Enter run · double-click run</span>
        <button onClick={onClose}>Esc close</button>
      </footer>
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
