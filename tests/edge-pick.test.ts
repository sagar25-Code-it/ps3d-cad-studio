import { ClickTracker, cornerVertices, edgeKey, edgePickTolerancePx, nextCycle, pickEdgeAt, pickEdgeCandidates, pickVertexAt, projectToScreen, tangentChainsFrom, type PickCamera, type PickEdgeSegment } from "../packages/viewport-three/src/edge-pick.js";
import { classifyPointer, flattenPickEdges, stackAtPointer, type HoverCandidateBody } from "../packages/viewport-three/src/hover-pick.js";
import { boxMesh, creaseEdges } from "../packages/workbench-geometry/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

type V3 = readonly [number, number, number];

const WIDTH = 800;
const HEIGHT = 600;

/** A perspective camera looking at `target` from `eye`, z up, as the column-major matrix the picker takes (millimetres in, clip space out). */
function camera(eye: V3, target: V3 = [0, 0, 0], fovDeg = 38): PickCamera {
  const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a: V3): V3 => { const l = Math.hypot(...a); return [a[0] / l, a[1] / l, a[2] / l]; };
  const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const f = norm(sub(target, eye));
  const r = norm(cross(f, [0, 0, 1]));
  const u = cross(r, f);
  // View matrix (row-major rows r, u, -f).
  const view = [r[0], r[1], r[2], -dot(r, eye), u[0], u[1], u[2], -dot(u, eye), -f[0], -f[1], -f[2], dot(f, eye), 0, 0, 0, 1];
  const t = 1 / Math.tan((fovDeg * Math.PI / 180) / 2);
  const near_ = 0.01; const far = 1e6;
  const proj = [t / (WIDTH / HEIGHT), 0, 0, 0, 0, t, 0, 0, 0, 0, (far + near_) / (near_ - far), 2 * far * near_ / (near_ - far), 0, 0, -1, 0];
  // vp = proj * view, row-major, then written column-major.
  const vp = new Array<number>(16).fill(0);
  for (let row = 0; row < 4; row += 1) for (let col = 0; col < 4; col += 1) for (let k = 0; k < 4; k += 1) vp[col * 4 + row]! += proj[row * 4 + k]! * view[k * 4 + col]!;
  return { viewProjection: vp, widthPx: WIDTH, heightPx: HEIGHT };
}

const line = (bodyId: string, chain: number, a: V3, b: V3): PickEdgeSegment => ({ bodyId, chain, a, b });

/** The 12 edges of an axis-aligned cube as segments of 12 chains. */
function cubeEdges(bodyId: string, size: number, centre: V3 = [0, 0, 0]): PickEdgeSegment[] {
  const found = creaseEdges(boxMesh(size, size, size));
  return found.edges.map((edge) => ({ bodyId, chain: edge.chain, a: [edge.a[0] + centre[0], edge.a[1] + centre[1], edge.a[2] + centre[2]] as V3, b: [edge.b[0] + centre[0], edge.b[1] + centre[1], edge.b[2] + centre[2]] as V3 }));
}

const screenOf = (cam: PickCamera, p: V3): { x: number; y: number } => { const s = projectToScreen(cam, p); assert(s !== undefined, "on screen"); return { x: s!.x, y: s!.y }; };

export const edgePickTests: readonly TestCase[] = [
  {
    name: "A 2 mm cube far from the camera is pickable: each of its edges, at its own pixels, and not from 20 px away",
    run: () => {
      for (const distance of [40, 400, 4000]) {
        const size = 2 * distance / 40; // always about the same size on screen: ~ 2 mm at 40 mm away
        const cam = camera([distance * 0.7, -distance * 0.9, distance * 0.6]);
        const edges = cubeEdges("tiny", size);
        // Pick every edge by clicking 2 px beside the middle of it on screen.
        let hits = 0;
        for (const edge of edges) {
          const mid = screenOf(cam, [(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2, (edge.a[2] + edge.b[2]) / 2]);
          const found = pickEdgeAt({ x: mid.x + 2, y: mid.y }, cam, edges, 8);
          if (found !== undefined && found.bodyId === "tiny") hits += 1;
        }
        equal(hits, 12, `every edge is hit from 2 px (distance ${distance} mm, the cube is ${size} mm)`);
        const away = screenOf(cam, [0, 0, 0]);
        assert(pickEdgeAt({ x: away.x + 400, y: away.y + 250 }, cam, edges, 8) === undefined, "far from every edge nothing is picked (a click on empty canvas or the middle of a face picks no edge)");
      }
    }
  },
  {
    name: "The tolerance is in pixels: 7 px away picks, 9 px away does not, with an 8 px tolerance, at any size of part",
    run: () => {
      for (const size of [0.5, 5, 500]) {
        const cam = camera([size * 4, -size * 5, size * 3]);
        const edge = line("a", 0, [-size / 2, 0, 0], [size / 2, 0, 0]);
        const mid = screenOf(cam, [0, 0, 0]);
        assert(pickEdgeAt({ x: mid.x, y: mid.y + 7 }, cam, [edge], 8) !== undefined, `7 px picks (size ${size})`);
        assert(pickEdgeAt({ x: mid.x, y: mid.y + 9 }, cam, [edge], 8) === undefined, `9 px does not (size ${size})`);
        near(pickEdgeAt({ x: mid.x, y: mid.y + 5 }, cam, [edge], 8)!.distancePx, 5, 0.6, "and the distance reported is the pixel distance");
      }
    }
  },
  {
    name: "An edge on the silhouette, with no surface behind the cursor, is pickable (the screen test needs no ray hit)",
    run: () => {
      const cam = camera([0, -100, 0]);
      // A lone edge in empty space: no mesh at all.
      const edge = line("sil", 3, [-10, 0, 10], [10, 0, 10]);
      const at = screenOf(cam, [0, 0, 10]);
      const found = pickEdgeAt({ x: at.x - 1, y: at.y - 3 }, cam, [edge], 8);
      assert(found !== undefined && found.chain === 3, "picked in empty space");
    }
  },
  {
    name: "Nearest wins: two parallel edges 10 px apart, a click 3 px from one picks that one, whichever is listed first",
    run: () => {
      const cam = camera([0, -200, 0]);
      const lower = screenOf(cam, [0, 0, 0]);
      const mmPerPx = 200 * 2 * Math.tan(19 * Math.PI / 180) / HEIGHT;
      const a = line("a", 0, [-20, 0, 0], [20, 0, 0]);
      const b = line("b", 1, [-20, 0, 10 * mmPerPx], [20, 0, 10 * mmPerPx]);
      for (const order of [[a, b], [b, a]]) {
        const near_a = pickEdgeAt({ x: lower.x, y: lower.y - 3 }, cam, order, 8);
        equal(near_a?.bodyId, "a", "3 px from a: a");
        const near_b = pickEdgeAt({ x: lower.x, y: lower.y - 8 }, cam, order, 8);
        equal(near_b?.bodyId, "b", "8 px from a, 2 px from b: b");
      }
    }
  },
  {
    name: "Edges stacked in depth: the nearer to the camera is picked first and repeated clicks cycle through every edge under the pointer, wrapping",
    run: () => {
      const cam = camera([0, -200, 0]);
      // Three edges that cross at one screen position at different depths (all along x, at y = 0, 40 and 80, z = 0).
      const front = line("front", 0, [-20, -30, 0], [20, -30, 0]);
      const middle = line("middle", 1, [-20, 0, 0], [20, 0, 0]);
      const back = line("back", 2, [-20, 40, 0], [20, 40, 0]);
      const at = screenOf(cam, [0, 0, 0]);
      const candidates = pickEdgeCandidates(at, cam, [back, middle, front], 8);
      equal(candidates.map((candidate) => candidate.bodyId).join(","), "front,middle,back", "all three, nearest to the camera first (they are within a pixel or two of each other on screen)");
      equal(pickEdgeAt(at, cam, [back, middle, front], 8)?.bodyId, "front", "the first click picks the nearest");
      equal(pickEdgeAt(at, cam, [back, middle, front], 8, { cycle: 1 })?.bodyId, "middle", "the next click the one behind it");
      equal(pickEdgeAt(at, cam, [back, middle, front], 8, { cycle: 2 })?.bodyId, "back", "then the last");
      equal(pickEdgeAt(at, cam, [back, middle, front], 8, { cycle: 3 })?.bodyId, "front", "then it wraps");
      equal(pickEdgeAt(at, cam, [back, middle, front], 8, { cycle: -1 })?.bodyId, "back", "and wraps backward");
    }
  },
  {
    name: "Hidden edges are not offered: an occluder callback removes the far side of a cube and cycling skips it",
    run: () => {
      const cam = camera([300, -400, 250]);
      const edges = cubeEdges("cube", 40);
      const centre = screenOf(cam, [0, 0, 0]);
      const all = pickEdgeCandidates(centre, cam, edges, 60);
      const visible = pickEdgeCandidates(centre, cam, edges, 60, { isVisible: (point) => point[0] >= 0 || point[1] <= 0 || point[2] >= 0 ? point[0] * 0.6 - point[1] * 0.8 + point[2] * 0.6 >= -1 : false });
      assert(all.length > visible.length && visible.length > 0, `the far edges are filtered out: ${all.length} -> ${visible.length}`);
      const nearCorner = pickEdgeAt(screenOf(cam, [20, -20, 20]), cam, edges, 8, { isVisible: () => false });
      assert(nearCorner === undefined, "when everything is hidden nothing is picked");
    }
  },
  {
    name: "An edge that runs behind the camera is cut at the near plane and its visible part can still be picked",
    run: () => {
      const cam = camera([0, -100, 0]);
      const longEdge = line("long", 0, [0, -100000, 0], [0, 200, 0]); // runs from far behind the camera to in front of it
      const ahead = screenOf(cam, [0, 0, 0]);
      assert(pickEdgeAt({ x: ahead.x + 2, y: ahead.y }, cam, [longEdge], 8) !== undefined, "the part in front is pickable");
      const wholeBehind = line("gone", 1, [0, -500, 0], [0, -300, 0]);
      assert(pickEdgeAt({ x: WIDTH / 2, y: HEIGHT / 2 }, cam, [wholeBehind], 40) === undefined, "an edge wholly behind the camera is never picked");
    }
  },
  {
    name: "Vertices: the nearest corner within the tolerance is picked, hidden ones are skipped, and a cube's corners are found from its edges",
    run: () => {
      const edges = cubeEdges("cube", 30);
      const corners = cornerVertices(edges);
      equal(corners.length, 8, "eight corners (three chains meet at each)");
      const vertices = corners.map((pointMm) => ({ bodyId: "cube", pointMm }));
      const cam = camera([100, -120, 90]);
      const target = screenOf(cam, [15, -15, 15]);
      const found = pickVertexAt({ x: target.x + 3, y: target.y - 2 }, cam, vertices, 8);
      assert(found !== undefined && found.pointMm[0] === 15 && found.pointMm[1] === -15 && found.pointMm[2] === 15, "the corner under the pointer");
      assert(pickVertexAt({ x: target.x + 30, y: target.y + 30 }, cam, vertices, 8) === undefined, "not from 40 px away");
      assert(pickVertexAt(target, cam, vertices, 8, { isVisible: () => false }) === undefined, "a hidden corner is skipped");
    }
  },
  {
    name: "Tangent chains: a run carries on through a junction where another edge continues it straight, and not through a right angle",
    run: () => {
      const segments = [
        line("s", 0, [0, 0, 0], [10, 0, 0]),
        line("s", 1, [10, 0, 0], [20, 0.5, 0]),   // 2.9 degrees off straight: tangent
        line("s", 2, [10, 0, 0], [10, 10, 0]),    // a branch at a right angle
        line("s", 3, [20, 0.5, 0], [20, 10, 0])   // turns a right angle at the far end
      ];
      const run = tangentChainsFrom(segments, 0);
      equal(run.chains.join(","), "0,1", "chain 0 carries on into chain 1 and not the right-angle branches");
      equal(tangentChainsFrom(segments, 2).chains.join(","), "2", "a branch stands alone");
      equal(tangentChainsFrom(segments, 99).chains.length, 1, "an unknown chain is just itself");
    }
  },
  {
    name: "Clicks: the same spot again cycles, a quick second click is a double-click (tangent chain), a click elsewhere starts again",
    run: () => {
      const tracker = new ClickTracker();
      const keys = ["a#0", "b#1", "c#2"];
      const first = tracker.register({ x: 100, y: 100 }, keys, 0);
      equal(first.index, 0, "first click: nearest"); equal(first.doubleClick, false, "not a double-click");
      const dbl = tracker.register({ x: 101, y: 100 }, keys, 200);
      equal(dbl.doubleClick, true, "within 350 ms at the same spot: double-click");
      equal(dbl.index, 0, "it concerns the edge the first click picked");
      const slow = tracker.register({ x: 100, y: 101 }, keys, 1500);
      equal(slow.index, 1, "a slower click at the same spot: the next one in the stack"); equal(slow.doubleClick, false, "not a double-click");
      equal(tracker.register({ x: 100, y: 100 }, keys, 3000).index, 2, "and the next");
      equal(tracker.register({ x: 100, y: 100 }, keys, 4500).index, 0, "then it wraps");
      equal(tracker.register({ x: 300, y: 300 }, keys, 5000).index, 0, "a click elsewhere starts again at the nearest");
      equal(tracker.register({ x: 300, y: 300 }, ["z#9"], 8000).index, 0, "a different stack at the same spot starts again too");
      const state = nextCycle(undefined, { x: 5, y: 5 }, keys);
      equal(nextCycle(state, { x: 6, y: 5 }, keys).index, 1, "the stateless helper agrees");
    }
  },
  {
    name: "Hover and click agree: the screen classifier gives the same target for hover and for the first click, picks edges where no surface was hit, and Auto highlights the body",
    run: () => {
      const cam = camera([120, -150, 100]);
      const edges = cubeEdges("cube", 40);
      const bodies = new Map<string, HoverCandidateBody>([["cube", { edges: edges.map((edge) => ({ a: edge.a, b: edge.b, chain: edge.chain })) }]]);
      const flat = flattenPickEdges(bodies);
      equal(flat.length, edges.length, "flattened");
      const onEdge = screenOf(cam, [20, -20, 0]);
      const input = { pointer: { x: onEdge.x + 1, y: onEdge.y + 1 }, camera: cam, filter: "edge" as const, hit: undefined, edges: flat, vertices: [], tolerancePx: 8 };
      const hover = classifyPointer(input);
      const click = classifyPointer(input, 0);
      assert(hover !== null && hover.kind === "edge" && click !== null && click.kind === "edge" && hover.chain === click.chain, "the click picks exactly what the hover shows");
      const stack = stackAtPointer(input);
      assert(stack.keys.length >= 1 && stack.keys[0] === edgeKey({ bodyId: "cube", chain: hover.kind === "edge" ? hover.chain : -1 }), "the stack's first entry is the hover");
      const auto = classifyPointer({ ...input, filter: "auto", hit: { bodyId: "cube", pointMm: [20, -20, 0], faceIndex: 3 } });
      assert(auto !== null && auto.kind === "body", "Auto lights up the body, which is what a click in Auto selects");
      const face = classifyPointer({ ...input, filter: "face", hit: { bodyId: "cube", pointMm: [20, -20, 0], faceIndex: 3 } });
      assert(face !== null && face.kind === "face" && face.faceIndex === 3, "Face intent still takes the named face");
      const vertex = classifyPointer({ ...input, filter: "vertex", vertices: cornerVertices(edges).map((pointMm) => ({ bodyId: "cube", pointMm })), pointer: screenOf(cam, [20, -20, 20]) });
      assert(vertex !== null && vertex.kind === "vertex", "Vertex intent finds the cube corner under the pointer");
    }
  },
  {
    name: "Tolerance settings stay in bounds and are wider for a finger",
    run: () => {
      equal(edgePickTolerancePx(undefined), 8, "default 8 px");
      equal(edgePickTolerancePx(1), 3, "never under 3");
      equal(edgePickTolerancePx(500), 24, "never over 24");
      equal(edgePickTolerancePx(Number.NaN), 8, "not a number: default");
      assert(edgePickTolerancePx(8, "touch") > 8, "a finger gets a wider tolerance");
    }
  }
];
