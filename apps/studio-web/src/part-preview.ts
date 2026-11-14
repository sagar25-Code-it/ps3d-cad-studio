/**
 * Live preview of a feature, for the Part view: while a command is open, the view shows the RESULT of its current inputs as a
 * translucent ghost and updates it as the inputs change. This file is the scheduling half and the one place a command attaches to.
 *
 * HOW A COMMAND ATTACHES (Fillet, Chamfer, Shell and Hole already do; Extrude and Revolve attach the same way):
 *
 *   const preview = createPreviewController({ onGhost, onState });   // usePartPreview.ts does this and draws the ghost
 *   preview.preview({ key, build });      // the inputs changed; `build` computes the result WITHOUT committing anything
 *   preview.preview({ invalid: "why" });  // the inputs are not complete or not valid: no ghost, the reason is reported
 *   preview.clear();                      // the command closed (OK, Cancel, Esc): the ghost is gone, nothing is left behind
 *
 * `key` is any text that is equal exactly when the result would be equal (the inputs plus the project revision): an unchanged key is
 * not rebuilt. `build` returns the mesh of the result, or why it cannot be built; part-preview-build.ts has the builder that every
 * timeline command shares (it adds the step to a COPY of the project and replays the body, never touching the real one), and
 * usePartPreview.ts is the React hook that feeds a command panel or the Edit Feature dock into it and draws the drag arrow.
 *
 * What the controller promises:
 *  - Debounce: a burst of changes builds once, after a short pause (and at least every `maxWaitMs` during a continuous drag).
 *  - Stale work is dropped: a result for inputs that were replaced meanwhile is never shown; the newest request always wins.
 *  - One build at a time: the kernel runs on the page's thread, so a new request waits for the running build instead of piling up.
 *  - Time budget (default 300 ms): a build that runs over it is refused and the user is told; so is a build that fails. In both
 *    cases the last good ghost stays on screen, greyed, so the view never goes blank while typing. The same inputs are not retried.
 *  - Invalid inputs show no ghost at all (a wrong ghost would mislead more than none).
 *  - The preview never changes the project, the history or the undo stack: committing stays with the command's own OK.
 */

export interface PreviewGhost {
  readonly positionsMm: readonly number[];
  readonly indices: readonly number[];
  /** The solid the ghost stands in for (hidden while it shows); absent when the ghost is a new body. */
  readonly replacesBodyId?: string;
}

export type PreviewBuild =
  | { readonly ok: true; readonly ghost: PreviewGhost; /** A note about the build that does not stop it (a lost reference, a changed fallback). */ readonly note?: string }
  | { readonly ok: false; readonly message: string };

export interface PreviewRequest {
  /** Equal keys mean equal results: the inputs and the project revision as text. */
  readonly key: string;
  /** Computes the ghost. May be slow; `isStale()` turns true once a newer request replaced this one, so it can stop early. */
  readonly build: (control: { readonly isStale: () => boolean }) => Promise<PreviewBuild> | PreviewBuild;
}

/** Inputs that cannot be previewed (nothing picked yet, a value that is not a number): shown at once, no ghost. */
export interface PreviewInvalid { readonly invalid: string }

export type PreviewState =
  | { readonly state: "idle" }
  | { readonly state: "pending" }
  | { readonly state: "ready"; readonly ms: number; readonly note?: string }
  | { readonly state: "invalid"; readonly message: string }
  | { readonly state: "refused"; readonly message: string; readonly showingLast: boolean }
  | { readonly state: "slow"; readonly ms: number; readonly budgetMs: number; readonly showingLast: boolean };

export interface PreviewControllerOptions {
  readonly onGhost: (ghost: PreviewGhost | null, meta: { readonly stale: boolean }) => void;
  readonly onState: (state: PreviewState) => void;
  /** Pause after the last change before building (default 120 ms). */
  readonly debounceMs?: number;
  /** Longest a continuous stream of changes may go without a build (default 250 ms). */
  readonly maxWaitMs?: number;
  /** A build slower than this is refused (default 300 ms). */
  readonly budgetMs?: number;
  /** Clock and timers, replaceable so tests need no real waiting. */
  readonly now?: () => number;
  readonly setTimer?: (action: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

export interface PreviewController {
  preview(request: PreviewRequest | PreviewInvalid): void;
  clear(): void;
  dispose(): void;
}

export const PREVIEW_BUDGET_MS = 300;

/** What the panel says about the preview, one short line (or undefined when there is nothing to say). */
export function previewNote(state: PreviewState): string | undefined {
  switch (state.state) {
    case "idle": return undefined;
    case "pending": return "Updating the preview…";
    case "ready": return state.note === undefined ? "The ghost in the view is the result of these values." : `The ghost in the view is the result of these values. ${state.note}`;
    case "invalid": return `No preview yet: ${state.message}`;
    case "refused": return `The preview could not be built: ${state.message}${state.showingLast ? " The greyed ghost is the last result that worked." : ""}`;
    case "slow": return `The preview needed ${Math.round(state.ms)} ms, over the ${state.budgetMs} ms limit, so it is not shown for these values${state.showingLast ? " (the greyed ghost is the last result that worked)" : ""}. OK still builds the real result.`;
  }
}

export function createPreviewController(options: PreviewControllerOptions): PreviewController {
  const debounceMs = options.debounceMs ?? 120;
  const maxWaitMs = options.maxWaitMs ?? 250;
  const budgetMs = options.budgetMs ?? PREVIEW_BUDGET_MS;
  const now = options.now ?? ((): number => Date.now());
  const setTimer = options.setTimer ?? ((action: () => void, ms: number): unknown => setTimeout(action, ms));
  const clearTimer = options.clearTimer ?? ((handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>));

  let generation = 0;
  let disposed = false;
  let timer: unknown;
  let firstPendingAt = 0;
  let waiting: { readonly generation: number; readonly request: PreviewRequest } | undefined;
  let running = false;
  /** The key last built or refused: the same key again is not rebuilt. */
  let settledKey: string | undefined;
  let lastGood: PreviewGhost | undefined;
  let showing = false;
  /** What the panel was last told once a build finished: said again when the same inputs come back and need no build. */
  let lastSettled: PreviewState = { state: "idle" };
  const tell = (state: PreviewState): void => { if (state.state !== "pending") lastSettled = state; options.onState(state); };

  const emitGhost = (ghost: PreviewGhost | undefined, stale: boolean): void => {
    if (ghost === undefined) { if (showing) { showing = false; options.onGhost(null, { stale: false }); } return; }
    showing = true;
    options.onGhost(ghost, { stale });
  };

  const stopTimer = (): void => { if (timer !== undefined) { clearTimer(timer); timer = undefined; } };

  const settle = async (mine: number, request: PreviewRequest): Promise<void> => {
    running = true;
    options.onState({ state: "pending" });
    const startedAt = now();
    let outcome: PreviewBuild;
    try {
      outcome = await Promise.resolve(request.build({ isStale: () => mine !== generation || disposed }));
    } catch (error) {
      outcome = { ok: false, message: error instanceof Error ? error.message : "The preview failed." };
    }
    running = false;
    const elapsed = now() - startedAt;
    if (!disposed && mine === generation) {
      settledKey = request.key;
      if (!outcome.ok) {
        emitGhost(lastGood, true);
        tell({ state: "refused", message: outcome.message, showingLast: lastGood !== undefined });
      } else if (elapsed > budgetMs) {
        // Built, but too slowly to keep up with typing: not shown, and the user is told why.
        emitGhost(lastGood, true);
        tell({ state: "slow", ms: elapsed, budgetMs, showingLast: lastGood !== undefined });
      } else {
        lastGood = outcome.ghost;
        emitGhost(outcome.ghost, false);
        tell({ state: "ready", ms: elapsed, ...(outcome.note === undefined ? {} : { note: outcome.note }) });
      }
    }
    // A request that arrived while this one ran goes next (the newest only; older ones were replaced).
    const next = waiting;
    waiting = undefined;
    if (!disposed && next !== undefined && next.generation === generation) void settle(next.generation, next.request);
  };

  const fire = (mine: number, request: PreviewRequest): void => {
    timer = undefined;
    if (disposed || mine !== generation) return;
    if (running) { waiting = { generation: mine, request }; return; }
    void settle(mine, request);
  };

  return {
    preview(request) {
      if (disposed) return;
      generation += 1;
      stopTimer();
      waiting = undefined;
      if ("invalid" in request) {
        // Not buildable: no ghost, and nothing to wait for.
        firstPendingAt = 0;
        settledKey = undefined;
        lastGood = undefined;
        emitGhost(undefined, false);
        tell({ state: "invalid", message: request.invalid });
        return;
      }
      if (request.key === settledKey && !running) { firstPendingAt = 0; options.onState(lastSettled); return; }
      const mine = generation;
      const at = now();
      if (firstPendingAt === 0) firstPendingAt = at;
      const delay = Math.max(0, Math.min(debounceMs, firstPendingAt + maxWaitMs - at));
      options.onState({ state: "pending" });
      timer = setTimer(() => { firstPendingAt = 0; fire(mine, request); }, delay);
    },
    clear() {
      generation += 1;
      stopTimer();
      waiting = undefined;
      firstPendingAt = 0;
      settledKey = undefined;
      lastGood = undefined;
      emitGhost(undefined, false);
      tell({ state: "idle" });
    },
    dispose() {
      if (disposed) return;
      stopTimer();
      generation += 1;
      waiting = undefined;
      emitGhost(undefined, false);
      disposed = true;
    }
  };
}
