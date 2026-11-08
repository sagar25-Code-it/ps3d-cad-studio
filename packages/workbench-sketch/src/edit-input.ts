/** Reading what a person typed into a field of an edit panel. */

/** A typed number: a comma is accepted as the decimal mark (12,5), and an empty or unreadable field is NaN, never 0. */
export function parseDecimal(text: string): number {
  const trimmed = text.trim();
  if (trimmed === "") return Number.NaN;
  const separated = /^[+-]?\d+,\d+$/u.test(trimmed) ? trimmed.replace(",", ".") : trimmed;
  return Number(separated);
}
