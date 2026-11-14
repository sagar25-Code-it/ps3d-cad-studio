/**
 * Which body a whole-body ribbon command (Hole, Fillet All, Chamfer All, the analytic Edge Blend / Chamfer / Trim) acts on.
 * The selected body of the right kind, else the only candidate; with several candidates, or the wrong kind selected, the command
 * refuses and names the candidates so the user can pick one in the view or the browser and run it again. It never picks silently
 * among several.
 */

export interface NamedBody { readonly id: string; readonly name: string }

export type BodyChoice<T extends NamedBody> =
  | { readonly ok: true; readonly body: T }
  | { readonly ok: false; readonly message: string };

function nameList(names: readonly string[]): string {
  if (names.length <= 6) return names.join(", ");
  return `${names.slice(0, 6).join(", ")} and ${names.length - 6} more`;
}

/**
 * `candidates` are the bodies this command can act on. `otherSelectedName` is the name of the selected thing when it is a body the
 * command cannot act on (for example an analytic block for Hole), so the refusal can say why the selection did not count.
 */
export function chooseBodyFor<T extends NamedBody>(
  command: string,
  candidates: readonly T[],
  selectedId: string | null,
  kindLabel: string,
  otherSelectedName?: string
): BodyChoice<T> {
  const selected = candidates.find((candidate) => candidate.id === selectedId);
  if (selected !== undefined) return { ok: true, body: selected };
  if (candidates.length === 0) {
    return { ok: false, message: `${command} needs ${kindLabel}, and this design has none yet. Create one with Extrude or Revolve first.` };
  }
  if (otherSelectedName === undefined && candidates.length === 1) return { ok: true, body: candidates[0]! };
  const why = otherSelectedName === undefined ? "No body is selected" : `${otherSelectedName} is not ${kindLabel}`;
  const which = candidates.length === 1 ? candidates[0]!.name : `one of ${nameList(candidates.map((candidate) => candidate.name))}`;
  return { ok: false, message: `${command}: ${why}. Select ${which} in the view or the Bodies browser, then run ${command} again.` };
}
