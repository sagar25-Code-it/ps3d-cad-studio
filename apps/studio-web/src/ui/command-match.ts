import type { CadCommandRecord } from "../../../../packages/workbench-core/src/index.js";

/**
 * Whether a command answers a search: every word typed must start a word of the command's name, description, group, shortcut,
 * keywords or guide. The command palette (S) and its tests use this one function, so a command that tests find is a command people find.
 */
export function commandSearchWords(command: CadCommandRecord): readonly string[] {
  const haystack = [
    command.name, command.description, command.workspace, command.category, command.group, command.level,
    command.shortcut ?? "",
    ...command.keywords, command.guide.selection, ...command.guide.steps, command.guide.result, command.guide.boundary
  ].join(" ").toLowerCase();
  return haystack.split(/[^a-z0-9]+/u).filter(Boolean);
}

export function matchesCommandQuery(command: CadCommandRecord, query: string): boolean {
  const queryTokens = query.trim().toLowerCase().split(/[^a-z0-9]+/u).filter(Boolean);
  if (queryTokens.length === 0) return true;
  const words = commandSearchWords(command);
  return queryTokens.every((token) => words.some((candidate) => candidate.startsWith(token)));
}
