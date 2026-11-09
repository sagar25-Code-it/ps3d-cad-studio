import { packMeshes } from "./mesh-pack.js";
import type { WorkbenchProject } from "./types.js";

/**
 * The text a project is saved as. It is the same JSON as before, indented for people to read, except that a list of plain numbers (the
 * vertex and index arrays of a tessellated body, a polyline) is written on one line. Pretty-printing every number on its own line made
 * a mesh body about three times larger than it needs to be, which is what pushed realistic projects past the file limits. Any JSON
 * parser reads the result, and `parseWorkbenchProjectText` accepts both layouts. Tessellated meshes are written packed (base64 typed
 * arrays, see mesh-pack.ts), which is several times smaller again; a file with plain lists, as older versions wrote, opens as before.
 */
export function serializeWorkbenchProject(project: WorkbenchProject): string {
  const pretty = JSON.stringify(packMeshes(project), null, 2);
  return `${collapseNumberLists(pretty)}\n`;
}

const NUMBER_LINE = /^\s*-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?,?$/u;

/** Puts every run of lines that are only numbers (the body of a JSON number array) onto the line of its opening bracket. */
export function collapseNumberLists(pretty: string): string {
  const lines = pretty.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.endsWith("[")) { out.push(line); continue; }
    let end = index + 1;
    while (end < lines.length && NUMBER_LINE.test(lines[end]!)) end += 1;
    const closing = lines[end];
    if (end === index + 1 || closing === undefined || !/^\s*\],?$/u.test(closing)) { out.push(line); continue; }
    const numbers = lines.slice(index + 1, end).map((entry) => entry.trim().replace(/,$/u, ""));
    out.push(`${line}${numbers.join(",")}${closing.trim()}`);
    index = end;
  }
  return out.join("\n");
}
