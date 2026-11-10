/**
 * What the status line says when a background step (finishing a sketch, creating a solid, changing the unit, projecting a body)
 * throws instead of returning a refusal. The person is told which step stopped, why in a few words, and what to do, never a stack or an id.
 */
export function describeFailure(error: unknown, what: string): string {
  const raw = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  // Generated ids (entity:user-3f2a..., constraint:auto-...) mean nothing to a person; say "a curve" instead.
  const detail = raw.replace(/\s+/gu, " ").replace(/\b(?:entity|constraint|feature|operation|project|document):[A-Za-z0-9:_-]+/gu, "a sketch item").trim().slice(0, 200);
  return `${what} did not finish${detail === "" ? "" : `: ${detail}`}. The project is as it was before this step. Try again, or press Ctrl+Z if something looks wrong.`;
}
