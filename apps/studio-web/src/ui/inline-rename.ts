/**
 * An inline rename field ends exactly once, and how it ends decides what happens to the typed name: Enter and clicking away both keep
 * the name (clicking away used to throw it away), Escape cancels. After one ending the other events the browser still fires while the
 * field unmounts (a blur after Enter or Escape) are ignored, so a name is never committed twice and never committed after Escape.
 */

export type RenameEnding = "enter" | "blur" | "escape";

export type RenameOutcome =
  | { readonly action: "commit"; readonly name: string }
  | { readonly action: "cancel" };

export interface RenameGuard {
  /** The outcome of the first ending; undefined for every later one. */
  readonly end: (ending: RenameEnding, typed: string) => RenameOutcome | undefined;
}

export function createRenameGuard(current: string): RenameGuard {
  let settled = false;
  return {
    end: (ending, typed) => {
      if (settled) return undefined;
      settled = true;
      if (ending === "escape") return { action: "cancel" };
      const name = typed.trim();
      return name.length > 0 && name !== current ? { action: "commit", name } : { action: "cancel" };
    }
  };
}
