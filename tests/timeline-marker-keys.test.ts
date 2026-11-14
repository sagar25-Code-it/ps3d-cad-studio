import { readFileSync } from "node:fs";
import { markerKeyTarget } from "../apps/studio-web/src/ui/timeline-drag.js";
import { assert, equal, type TestCase } from "./test-kit.js";

/** Review: the rollback marker steps with a held or repeated arrow key, and focus follows it to the next slot. */

/** Presses `key` `times` times, each press moving the marker to where the last one put it (what a held arrow does once focus follows). */
function press(key: string, from: number, count: number, times: number): readonly number[] {
  const visited: number[] = [];
  let at = from;
  for (let step = 0; step < times; step += 1) {
    const to = markerKeyTarget(key, at, count);
    if (to === undefined) break;
    at = to;
    visited.push(at);
  }
  return visited;
}

export const timelineMarkerKeyTests: readonly TestCase[] = [
  {
    name: "Arrow keys move the rollback marker one slot at a time to either end, Home and End jump, and nothing moves past an end",
    run: () => {
      equal(press("ArrowRight", 1, 4, 10).join(","), "2,3,4", "right steps to after the last of four steps, then stops");
      equal(press("ArrowLeft", 3, 4, 10).join(","), "2,1,0", "left steps back to the start, then stops");
      equal(markerKeyTarget("Home", 3, 4), 0, "Home rolls back to the start");
      equal(markerKeyTarget("End", 1, 4), 4, "End rolls forward to the end");
      equal(markerKeyTarget("Home", 0, 4), undefined, "already at the start");
      equal(markerKeyTarget("End", 4, 4), undefined, "already at the end");
      equal(markerKeyTarget("a", 2, 4), undefined, "another key is not the marker's");
      equal(markerKeyTarget("ArrowRight", 0, 0), undefined, "an empty history has nowhere to go");
    }
  },
  {
    name: "The current marker hands focus to the slot it moves to, and stops doing so once focus leaves the markers",
    run: () => {
      const source = readFileSync("apps/studio-web/src/ui/TimelineBar.tsx", "utf8");
      assert(source.includes("followMarkerFocus.current = true") && /ref=\{\(element\) => \{ if \(element !== null && followMarkerFocus\.current/u.test(source), "a key press arms the focus hand-over and the new marker takes focus when it mounts");
      assert(/const leaveMarkers[\s\S]*followMarkerFocus\.current = false/u.test(source) && (source.match(/onBlur=\{leaveMarkers\}/gu) ?? []).length === 2, "both marker kinds stop the following when focus leaves for a non-marker");
    }
  },
];
