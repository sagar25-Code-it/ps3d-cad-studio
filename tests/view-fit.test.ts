import { shouldRefit } from "../apps/studio-web/src/view-fit.js";
import { assert, type TestCase } from "./test-kit.js";

/**
 * PT-03: the view stays where the user left it. The Part viewport fits once per design; a feature commit, edit,
 * rebuild, visibility change or undo pushes the same design again and must not move the camera.
 */
export const viewFitTests: readonly TestCase[] = [
  {
    name: "The Part viewport fits a design once: the first show fits, every later push of the same design leaves the camera, and another design fits again",
    run: () => {
      let lastFitted: string | undefined = undefined;
      const fits: string[] = [];
      const show = (projectId: string): void => {
        if (shouldRefit(lastFitted, projectId)) { lastFitted = projectId; fits.push(projectId); }
      };
      show("project:a"); // first show of the design
      show("project:a"); // a feature commit
      show("project:a"); // a sketch edit and rebuild
      show("project:a"); // an undo
      show("project:b"); // File > New or an opened file
      show("project:b"); // its first edit
      show("project:a"); // reopening the earlier design
      assert(fits.join(",") === "project:a,project:b,project:a", `only the first show of each design fits: ${fits.join(",")}`);
      assert(shouldRefit(undefined, "project:x"), "a fresh session fits the design it opens with");
      assert(!shouldRefit("project:x", "project:x"), "the same design never refits on its own");
    }
  }
];
