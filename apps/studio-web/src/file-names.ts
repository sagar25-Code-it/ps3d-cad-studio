/** Export file naming: every download is named after the project, not a fixed sample name. */

/** A filesystem-safe stem from a project name; never empty. */
export function safeFileStem(value: string): string {
  const stem = value.trim().replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "");
  return stem.length === 0 ? "ps3d-model" : stem.slice(0, 80);
}

/** `My Plate` + `drawing` + `svg` → `My-Plate-drawing.svg`; an empty suffix gives `My-Plate.svg`. */
export function exportFileName(projectName: string, suffix: string, extension: string): string {
  const stem = safeFileStem(projectName);
  return `${stem}${suffix === "" ? "" : `-${suffix}`}.${extension}`;
}
