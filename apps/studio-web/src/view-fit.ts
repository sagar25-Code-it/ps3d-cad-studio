/**
 * PT-03: the camera never moves on its own while the user works. The Part viewport is fitted once when a design is
 * first shown (a new design, an opened file), and after that only the explicit Fit command moves the camera; feature
 * commits, edits, rebuilds, visibility toggles, undo and timeline work leave the view where the user put it.
 */

/** Whether showing `next` in the Part viewport should fit the camera: only when it is not the design last fitted. */
export function shouldRefit(lastFittedProjectId: string | undefined, next: string): boolean {
  return lastFittedProjectId !== next;
}
