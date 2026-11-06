import type { SketchEntity, Vec2, WorkbenchSketch } from "../packages/workbench-core/src/index.js";
import { createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { inferSketchPoint, type InferenceOptions } from "../packages/workbench-sketch/src/inference.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

function sketchOf(entities: readonly SketchEntity[]): WorkbenchSketch {
  return { ...createWorkbenchProject("project:test-inference").sketch, entities, constraints: [] };
}

const line = (id: string, start: Vec2, end: Vec2): SketchEntity => ({ id, kind: "line", start, end, construction: false });
const circle = (id: string, center: Vec2, radiusMm: number): SketchEntity => ({ id, kind: "circle", center, radiusMm, construction: false });
const reach = (toleranceMm: number, extra: Partial<InferenceOptions> = {}): InferenceOptions => ({ toleranceMm, ...extra });

export const sketchInferenceTests: readonly TestCase[] = [
  {
    name: "inference snaps to endpoints, centres, midpoints and quadrants and names the entity point it landed on",
    run: () => {
      const sketch = sketchOf([line("e:l", [10, 10], [50, 10]), circle("e:c", [100, 40], 20)]);
      const endpoint = inferSketchPoint([10.4, 9.7], sketch, reach(1));
      equal(endpoint.primary?.kind, "endpoint", "a line end is an endpoint");
      equal(endpoint.primary?.selector, "start", "and says which end");
      equal(endpoint.primary?.entityId, "e:l", "and which entity");
      near(endpoint.point[0], 10, 1e-12, "the snapped point is the exact endpoint");
      const finish = inferSketchPoint([49.6, 10.3], sketch, reach(1));
      equal(finish.primary?.selector, "end", "the other end is reported as the end");
      const middle = inferSketchPoint([30.3, 10.4], sketch, reach(1));
      equal(middle.primary?.kind, "midpoint", "the middle of a line is a midpoint");
      near(middle.point[0], 30, 1e-12, "the midpoint is exact");
      const centre = inferSketchPoint([100.3, 39.6], sketch, reach(1));
      equal(centre.primary?.kind, "center", "a circle's middle is its centre");
      equal(centre.primary?.selector, "center", "the centre selector is reported");
      const quadrant = inferSketchPoint([120.4, 40.2], sketch, reach(1));
      equal(quadrant.primary?.kind, "quadrant", "the four compass points of a circle are quadrants");
      near(quadrant.point[0], 120, 1e-12, "the quadrant is exact");
      const origin = inferSketchPoint([0.3, -0.2], sketchOf([]), reach(1));
      equal(origin.primary?.kind, "origin", "the sketch origin is always available");
    }
  },
  {
    name: "inference finds intersections of lines, lines with circles and circles with circles",
    run: () => {
      const crossing = sketchOf([line("e:a", [0, 0], [100, 40]), line("e:b", [0, 60], [100, 0])]);
      const lineLine = inferSketchPoint([60.5, 23.6], crossing, reach(1.5));
      equal(lineLine.primary?.kind, "intersection", "two crossing lines meet at an intersection");
      near(lineLine.point[0], 60, 1e-9, "line-line x");
      near(lineLine.point[1], 24, 1e-9, "line-line y");
      // When an intersection also happens to be a midpoint, the more informative label wins.
      const coincident = sketchOf([line("e:a", [0, 0], [100, 100]), line("e:b", [0, 100], [100, 0])]);
      equal(inferSketchPoint([50.4, 49.7], coincident, reach(1.5)).primary?.kind, "intersection", "an intersection that is also a midpoint is labelled an intersection");
      equal(new Set([lineLine.primary?.entityId, lineLine.primary?.otherEntityId]).size, 2, "both entities are reported");

      const lineCircle = sketchOf([line("e:l", [-30, 0], [30, 0]), circle("e:c", [0, 0], 20)]);
      const hit = inferSketchPoint([20.4, 0.3], lineCircle, reach(1.5));
      equal(hit.primary?.kind, "intersection", "a line cuts a circle");
      near(hit.point[0], 20, 1e-9, "line-circle x");

      const twoCircles = sketchOf([circle("e:a", [0, 0], 10), circle("e:b", [10, 0], 10)]);
      const meet = inferSketchPoint([5.3, 8.5], twoCircles, reach(1.5));
      equal(meet.primary?.kind, "intersection", "two overlapping circles intersect");
      near(meet.point[0], 5, 1e-9, "circle-circle x");
      near(meet.point[1], Math.sqrt(75), 1e-9, "circle-circle y");

      // A segment that stops short of the other never produces an intersection.
      const apart = sketchOf([line("e:a", [0, 0], [10, 0]), line("e:b", [20, -5], [20, 5])]);
      const none = inferSketchPoint([20, 0.2], apart, reach(1.5));
      assert(none.primary?.kind !== "intersection", "segments that do not cross have no intersection");
    }
  },
  {
    name: "an arc contributes its ends, centre, midpoint and only the quadrants it actually sweeps",
    run: () => {
      // Quarter arc of radius 10 centred at the origin, from angle 0 to 90 degrees through 45 degrees.
      const r = 10;
      const arc: SketchEntity = { id: "e:arc", kind: "arc", start: [r, 0], mid: [r * Math.SQRT1_2, r * Math.SQRT1_2], end: [0, r], construction: false };
      const sketch = sketchOf([arc]);
      const centre = inferSketchPoint([0.2, 0.2], sketchOf([arc]), { toleranceMm: 1 });
      assert(centre.primary?.kind === "center" || centre.primary?.kind === "origin", "the arc centre (the origin here) is available");
      const midpoint = inferSketchPoint([r * Math.SQRT1_2 + 0.2, r * Math.SQRT1_2 - 0.1], sketch, reach(1));
      equal(midpoint.primary?.kind, "midpoint", "the arc midpoint is found");
      // The 180 degree quadrant is outside the sweep, so there is nothing to snap to there.
      const outside = inferSketchPoint([-10, 0], sketch, reach(1));
      assert(outside.primary?.kind !== "quadrant", "a quadrant outside the sweep is not offered");
      const end = inferSketchPoint([0.1, 10.2], sketch, reach(1));
      equal(end.primary?.kind, "endpoint", "the arc end is an endpoint");
      equal(end.primary?.selector, "end", "reported as the end");
    }
  },
  {
    name: "named points beat on-curve hints, which beat alignment, which beats the grid; farther than the reach means no snap",
    run: () => {
      const sketch = sketchOf([line("e:l", [0, 0], [40, 0])]);
      // Next to the endpoint and also on the line: the endpoint wins.
      const priority = inferSketchPoint([39.6, 0.1], sketch, reach(1));
      equal(priority.primary?.kind, "endpoint", "endpoint beats on-curve");
      // On the line away from named points: on-curve, even with a grid on.
      const onCurve = inferSketchPoint([13.7, 0.2], sketch, reach(1, { gridMm: 5 }));
      equal(onCurve.primary?.kind, "on-curve", "on-curve beats the grid");
      near(onCurve.point[1], 0, 1e-12, "the point is projected onto the curve");
      // The on-curve reach is shorter than the named-point reach.
      const tooFar = inferSketchPoint([13.7, 0.8], sketch, reach(1));
      assert(tooFar.primary?.kind !== "on-curve", "on-curve needs the pointer closer than a named point does");
      // Empty canvas with a grid.
      const grid = inferSketchPoint([20.3, 30.2], sketchOf([]), reach(1, { gridMm: 5 }));
      equal(grid.primary?.kind, "grid", "grid snap applies when nothing else does");
      equal(grid.point[0], 20, "grid x");
      equal(grid.point[1], 30, "grid y");
      const free = inferSketchPoint([22.4, 31.1], sketchOf([]), reach(1, { gridMm: 5 }));
      equal(free.snapped, false, "outside every reach the pointer is untouched");
      equal(free.point[0], 22.4, "the raw point is returned");
    }
  },
  {
    name: "perpendicular and tangent hints come from the last placed point",
    run: () => {
      const wall = sketchOf([line("e:wall", [0, 0], [100, 0])]);
      // From (40, 30) the foot of the perpendicular onto the wall is (40, 0).
      const foot = inferSketchPoint([40.3, 0.4], wall, reach(1, { anchor: [40, 30] }));
      equal(foot.primary?.kind, "perpendicular", "a perpendicular foot is offered");
      near(foot.point[0], 40, 1e-9, "foot x");
      near(foot.point[1], 0, 1e-9, "foot y");
      // The foot must lie on the segment: from beyond the end it is not offered.
      const beyond = inferSketchPoint([140, 0.2], wall, reach(1, { anchor: [140, 30] }));
      assert(beyond.primary?.kind !== "perpendicular", "no perpendicular foot beyond the end of a segment");

      const ring = sketchOf([circle("e:ring", [0, 0], 10)]);
      // Tangent from (20, 0): cos a = r / d = 0.5, so the touching point is at 60 degrees.
      const touch = inferSketchPoint([5.2, 8.7], ring, reach(1, { anchor: [20, 0] }));
      equal(touch.primary?.kind, "tangent", "a tangent point is offered");
      near(touch.point[0], 5, 1e-9, "tangent x");
      near(touch.point[1], Math.sqrt(75), 1e-9, "tangent y");
      // Without an anchor there is nothing to be perpendicular or tangent to.
      const noAnchor = inferSketchPoint([5.2, 8.7], ring, reach(1));
      assert(noAnchor.primary?.kind !== "tangent", "tangent needs an anchor");
    }
  },
  {
    name: "horizontal and vertical alignment with the last point and with existing points, with guides, and both at once",
    run: () => {
      const sketch = sketchOf([line("e:ref", [100, 50], [140, 50])]);
      // Level with the point just placed.
      const level = inferSketchPoint([60, 20.4], sketch, reach(1, { anchor: [10, 20] }));
      equal(level.primary?.kind, "horizontal", "level with the anchor");
      near(level.point[1], 20, 1e-12, "snapped to the anchor's height");
      equal(level.point[0], 60, "x stays free");
      equal(level.guides.length, 1, "one guide is drawn");
      equal(level.guides[0]?.kind, "horizontal", "a horizontal guide");
      // Straight above an existing endpoint.
      const plumb = inferSketchPoint([100.4, 90], sketch, reach(1));
      equal(plumb.primary?.kind, "vertical", "plumb with an existing endpoint");
      near(plumb.point[0], 100, 1e-12, "snapped to the endpoint's x");
      // Both: a corner lined up with two points.
      const corner = inferSketchPoint([100.3, 20.3], sketch, reach(1, { anchor: [10, 20] }));
      equal(corner.guides.length, 2, "two guides meet at the corner");
      near(corner.point[0], 100, 1e-12, "corner x from the vertical guide");
      near(corner.point[1], 20, 1e-12, "corner y from the horizontal guide");
    }
  },
  {
    name: "hidden and excluded entities never attract the pointer",
    run: () => {
      const hidden: SketchEntity = { ...line("e:hidden", [10, 10], [50, 10]), visible: false };
      equal(inferSketchPoint([10.2, 10.1], sketchOf([hidden]), reach(1)).snapped, false, "a hidden line has no endpoints to snap to");
      const shown = line("e:shown", [10, 10], [50, 10]);
      equal(inferSketchPoint([10.2, 10.1], sketchOf([shown]), reach(1, { excludeEntityIds: ["e:shown"] })).snapped, false, "an excluded line is ignored");
      equal(inferSketchPoint([10.2, 10.1], sketchOf([shown]), reach(1)).snapped, true, "the same line snaps when it is not excluded");
    }
  },
  {
    name: "a dense sketch is inferred within a frame budget",
    run: () => {
      const entities: SketchEntity[] = [];
      for (let index = 0; index < 200; index += 1) {
        entities.push(line(`e:line-${index}`, [index * 3, 0], [index * 3 + 40, 60]));
        entities.push(circle(`e:circle-${index}`, [index * 2, 30], 8 + (index % 7)));
      }
      const sketch = sketchOf(entities);
      const started = Date.now();
      for (let sample = 0; sample < 100; sample += 1) inferSketchPoint([200 + sample * 0.37, 25 + (sample % 9)], sketch, reach(1.2, { anchor: [10, 10], gridMm: 5 }));
      const perCall = (Date.now() - started) / 100;
      assert(perCall < 16, `400 entities infer in ${perCall.toFixed(2)} ms per pointer move (budget 16 ms)`);
    }
  }
];
