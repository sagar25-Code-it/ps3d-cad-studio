/**
 * Names of solid bodies. A body has a name of its own: the new-body step that made it names it "Body 1", "Body 2", ... and the
 * person can rename it; renaming a timeline step does not rename the body, and a rebuild keeps whatever name the body has.
 */
const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The next free "Body N": one more than the highest number in use, and never a name that is already taken. */
export function nextBodyName(existingNames: readonly string[]): string {
  let highest = 0;
  for (const name of existingNames) {
    const match = /^body (\d+)$/iu.exec(name.trim());
    if (match !== null) highest = Math.max(highest, Number(match[1]));
  }
  let candidate = Math.max(highest, existingNames.length) + 1;
  while (existingNames.some((name) => sameName(name, `Body ${candidate}`))) candidate += 1;
  return `Body ${candidate}`;
}

/** `name` if no other body has it, otherwise the same name with " (2)", " (3)" ... added. */
export function uniqueBodyName(otherNames: readonly string[], name: string): string {
  if (!otherNames.some((other) => sameName(other, name))) return name;
  for (let copy = 2; copy < 1_000; copy += 1) {
    const candidate = `${name} (${copy})`;
    if (!otherNames.some((other) => sameName(other, candidate))) return candidate;
  }
  return name;
}
