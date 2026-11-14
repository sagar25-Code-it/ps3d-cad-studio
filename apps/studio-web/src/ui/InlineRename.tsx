import { useRef } from "react";
import { createRenameGuard } from "./inline-rename.js";

/** The text field that renames a browser row or a timeline chip in place: Enter or clicking away keeps the name, Escape cancels. */
export function InlineRename(props: {
  readonly initial: string;
  readonly className: string;
  readonly ariaLabel: string;
  readonly onCommit: (name: string) => void;
  readonly onCancel: () => void;
  readonly maxLength?: number;
}): React.JSX.Element {
  const guard = useRef(createRenameGuard(props.initial));
  const settle = (ending: "enter" | "blur" | "escape", typed: string): boolean => {
    const outcome = guard.current.end(ending, typed);
    if (outcome === undefined) return false;
    if (outcome.action === "commit") props.onCommit(outcome.name); else props.onCancel();
    return true;
  };
  return <input
    className={props.className}
    aria-label={props.ariaLabel}
    defaultValue={props.initial}
    maxLength={props.maxLength ?? 120}
    autoFocus
    onFocus={(event) => event.currentTarget.select()}
    onBlur={(event) => { settle("blur", event.currentTarget.value); }}
    onKeyDown={(event) => {
      if (event.key === "Enter") { event.preventDefault(); settle("enter", event.currentTarget.value); }
      else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); settle("escape", event.currentTarget.value); }
    }}
  />;
}
