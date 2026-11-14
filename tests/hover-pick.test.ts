import { chainsInBox, classifyHover, edgePickToleranceMm, nearestChainWithin, sameHoverTarget, type HoverCandidateBody, type PickSegmentMm, type ProjectedSegment } from "../packages/viewport-three/src/hover-pick.js";
import { assert, type TestCase } from "./test-kit.js";

/**
 * PT-08: hover pre-highlight and face / edge picking in the 3D view. The classifier decides, for each selection intent,
 * whether the cursor is over an edge chain (within a zoom-scaled tolerance), a named face, or the whole body; the same
 * decision drives the pre-highlight and the click.
 */

const EDGES: readonly PickSegmentMm[] = [
  // Chain 0: the top-front edge of a 100 × 50 plate (two colinear segments).
  { a: [0, 0, 10], b: [50, 0, 10], chain: 0 },
  { a: [50, 0, 10], b: [100, 0, 10], chain: 0 },
  // Chain 3: the top-back edge.
  { a: [0, 50, 10], b: [100, 50, 10], chain: 3 },
  // Chain 7: an inside corner.
  { a: [0, 25, 10], b: [100, 25, 10], chain: 7, concave: true }
];

const BODY: HoverCandidateBody = { edges: EDGES };

export const hoverPickTests: readonly TestCase[] = [
  {
    name: "Edge intent: a hit near an edge picks its whole chain with the distance, a hit far from every edge picks nothing",
    run: () => {
      const near = classifyHover({ bodyId: "general-body:a", pointMm: [30, 1.2, 10], faceIndex: 2 }, BODY, "edge", 2);
      assert(near !== null && near.kind === "edge", "a hit 1.2 mm from the edge is an edge pick at 2 mm tolerance");
      if (near !== null && near.kind === "edge") {
        assert(near.chain === 0, `the nearest chain is the top-front edge, got chain ${near.chain}`);
        assert(near.segments.length === 2, "the pick carries every segment of the chain, not just the nearest one");
        assert(Math.abs(near.distanceMm - 1.2) < 0.01, `the distance to the edge is reported (${near.distanceMm.toFixed(2)} mm)`);
        assert(!near.concave, "the top-front edge is an outside edge");
      }
      const far = classifyHover({ bodyId: "general-body:a", pointMm: [30, 12, 10], faceIndex: 2 }, BODY, "edge", 2);
      assert(far === null, "a hit 12 mm from every edge picks nothing in edge intent");
      const inside = classifyHover({ bodyId: "general-body:a", pointMm: [40, 25.4, 10], faceIndex: 2 }, BODY, "edge", 2);
      assert(inside !== null && inside.kind === "edge" && inside.concave, "an inside corner is picked and marked concave");
    }
  },
  {
    name: "Face intent: the named face under the cursor is picked; a body without face names is not face-pickable",
    run: () => {
      const face = classifyHover({ bodyId: "general-body:a", pointMm: [30, 20, 10], faceIndex: 4 }, BODY, "face", 2);
      assert(face !== null && face.kind === "face" && face.faceIndex === 4, "the hit triangle's face index is the pick");
      const unnamed = classifyHover({ bodyId: "general-body:b", pointMm: [30, 20, 10], faceIndex: null }, undefined, "face", 2);
      assert(unnamed === null, "a body without faceTriangles offers no face to pick (the honest subset)");
    }
  },
  {
    name: "Auto intent: the face lights up when the body has one under the cursor, otherwise the body; body intent always takes the body",
    run: () => {
      const auto = classifyHover({ bodyId: "general-body:a", pointMm: [30, 20, 10], faceIndex: 4 }, BODY, "auto", 2);
      assert(auto !== null && auto.kind === "face", "auto pre-highlights the named face under the cursor");
      const noFaces = classifyHover({ bodyId: "general-body:b", pointMm: [1, 2, 3], faceIndex: null }, undefined, "auto", 2);
      assert(noFaces !== null && noFaces.kind === "body", "auto falls back to the body when there is no named face");
      const body = classifyHover({ bodyId: "general-body:a", pointMm: [30, 0.1, 10], faceIndex: 4 }, BODY, "body", 2);
      assert(body !== null && body.kind === "body", "body intent picks the body even right on an edge");
      assert(classifyHover(undefined, BODY, "auto", 2) === null, "no hit, no hover");
    }
  },
  {
    name: "The edge tolerance follows the zoom (about eight pixels) and stays within sane bounds",
    run: () => {
      const atDefaultZoom = edgePickToleranceMm(0.16, 800);
      assert(atDefaultZoom > 0.8 && atDefaultZoom < 1.6, `at the default zoom the tolerance is about 1 mm (got ${atDefaultZoom.toFixed(2)})`);
      const zoomedIn = edgePickToleranceMm(0.016, 800);
      assert(zoomedIn < atDefaultZoom, "zooming in tightens the tolerance");
      assert(edgePickToleranceMm(0.0001, 10_000) >= 0.25, "the tolerance never collapses below 0.25 mm");
      assert(edgePickToleranceMm(100, 100) <= 50, "the tolerance never grows past 50 mm");
      const nearest = nearestChainWithin(EDGES, [30, 0.5, 10], 1);
      assert(nearest !== undefined && nearest.chain === 0, "nearestChainWithin honours the tolerance it is given");
      assert(nearestChainWithin(EDGES, [30, 5, 10], 1) === undefined, "outside the tolerance there is no chain");
      assert(nearestChainWithin([], [0, 0, 0], 10) === undefined, "no edges, no chain");
    }
  },
  {
    name: "Window and crossing boxes behave like Fusion: left-to-right takes only whole chains inside, right-to-left takes whatever it touches",
    run: () => {
      // Chain 1: fully inside the 100 × 100 box. Chain 2: one segment pokes out. Chain 3: crosses the box's right side without an endpoint inside. Chain 4: far away.
      const segments: readonly ProjectedSegment[] = [
        { bodyId: "b", chain: 1, ax: 10, ay: 10, bx: 90, by: 10 },
        { bodyId: "b", chain: 1, ax: 90, ay: 10, bx: 90, by: 90 },
        { bodyId: "b", chain: 2, ax: 20, ay: 50, bx: 140, by: 50 },
        { bodyId: "b", chain: 3, ax: 80, ay: 120, bx: 120, by: 60 },
        { bodyId: "b", chain: 4, ax: 300, ay: 300, bx: 400, by: 300 }
      ];
      const box = { left: 0, top: 0, right: 100, bottom: 100 };
      const window = chainsInBox(segments, box, false);
      assert(window.length === 1 && window[0]!.chain === 1, `a window box takes only the chain fully inside: ${JSON.stringify(window)}`);
      const crossing = chainsInBox(segments, box, true).map((entry) => entry.chain).sort((a, b) => a - b);
      assert(crossing.join(",") === "1,2,3", `a crossing box takes everything it touches, including a chain that only crosses its side: ${crossing.join(",")}`);
      assert(chainsInBox([], box, true).length === 0, "no segments, no chains");
    }
  },
  {
    name: "sameHoverTarget tells apart faces, chains and bodies so the overlay only rebuilds when the target changes",
    run: () => {
      const faceA = { kind: "face", bodyId: "b", faceIndex: 1, pointMm: [0, 0, 0] } as const;
      const faceA2 = { kind: "face", bodyId: "b", faceIndex: 1, pointMm: [9, 9, 9] } as const;
      const faceB = { kind: "face", bodyId: "b", faceIndex: 2, pointMm: [0, 0, 0] } as const;
      assert(sameHoverTarget(faceA, faceA2), "the same face at another hit point is the same target");
      assert(!sameHoverTarget(faceA, faceB), "another face is another target");
      assert(!sameHoverTarget(faceA, { kind: "body", bodyId: "b" }), "a face and its body are different targets");
      assert(sameHoverTarget(null, null), "no hover equals no hover");
      assert(!sameHoverTarget(faceA, null), "a hover and no hover differ");
      const edge1 = { kind: "edge", bodyId: "b", chain: 1, segments: [], distanceMm: 0.5, concave: false } as const;
      const edge1Again = { kind: "edge", bodyId: "b", chain: 1, segments: [], distanceMm: 1.4, concave: false } as const;
      const edge2 = { kind: "edge", bodyId: "b", chain: 2, segments: [], distanceMm: 0.5, concave: false } as const;
      assert(sameHoverTarget(edge1, edge1Again), "the same chain at another distance is the same target");
      assert(!sameHoverTarget(edge1, edge2), "another chain is another target");
    }
  }
];
