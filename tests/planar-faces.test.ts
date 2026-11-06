import { axisAlignedPlanarFaces, planeOffsetForCoordinate, planeWorldCoordinate } from "../packages/workbench-core/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

// A closed 60 × 40 × 10 box, x ∈ [−30, 30], y ∈ [−20, 20], z ∈ [0, 10], with outward triangle winding.
const BOX_POSITIONS: readonly number[] = [
  -30, -20, 0, 30, -20, 0, 30, 20, 0, -30, 20, 0,
  -30, -20, 10, 30, -20, 10, 30, 20, 10, -30, 20, 10
];
const BOX_INDICES: readonly number[] = [
  4, 5, 6, 4, 6, 7, // top (+z)
  0, 2, 1, 0, 3, 2, // bottom (−z)
  0, 1, 5, 0, 5, 4, // front (−y)
  2, 3, 7, 2, 7, 6, // back (+y)
  1, 2, 6, 1, 6, 5, // right (+x)
  0, 4, 7, 0, 7, 3 // left (−x)
];

export const planarFaceTests: readonly TestCase[] = [
  {
    name: "a box has six axis-aligned faces, largest first, each mapped to the sketch plane that sits on it",
    run: () => {
      const faces = axisAlignedPlanarFaces(BOX_POSITIONS, BOX_INDICES);
      equal(faces.length, 6, "six faces");
      near(faces[0]!.areaMm2, 2400, 0.01, "the big z faces come first");
      near(faces[2]!.areaMm2, 600, 0.01, "then the y faces");
      near(faces[4]!.areaMm2, 400, 0.01, "then the x faces");
      const top = faces.find((face) => face.axisName === "z" && face.outwardPositive);
      assert(top !== undefined, "the top face is found");
      equal(top.plane, "datum:xy", "the top face is XY-parallel");
      near(top.coordinateMm, 10, 1e-9, "at z = 10");
      near(top.offsetMm, 10, 1e-9, "reached by sketching on XY offset 10");
      const front = faces.find((face) => face.axisName === "y" && face.coordinateMm < 0);
      assert(front !== undefined, "the y = −20 face is found");
      equal(front.plane, "datum:xz", "it is XZ-parallel");
      near(front.offsetMm, 20, 1e-9, "the XZ normal points along −Y, so y = −20 is offset +20");
      equal(front.outwardPositive, false, "and it looks along −y");
      const right = faces.find((face) => face.axisName === "x" && face.coordinateMm > 0);
      assert(right !== undefined, "the x = 30 face is found");
      equal(right.plane, "datum:yz", "it is YZ-parallel");
      near(right.offsetMm, 30, 1e-9, "offset +30");
    }
  },
  {
    name: "small faces can be filtered out, and a tilted triangle never becomes a face",
    run: () => {
      equal(axisAlignedPlanarFaces(BOX_POSITIONS, BOX_INDICES, 500).length, 4, "the 400 mm² x faces drop below a 500 mm² floor");
      const positions = [...BOX_POSITIONS, 100, 100, 100, 110, 100, 100, 100, 110, 105];
      const indices = [...BOX_INDICES, 8, 9, 10];
      equal(axisAlignedPlanarFaces(positions, indices).length, 6, "the tilted triangle is left out");
    }
  },
  {
    name: "plane offsets and world coordinates convert both ways, including the flipped XZ normal",
    run: () => {
      equal(planeWorldCoordinate("datum:xy", 25).axisName, "z", "XY offsets move along z");
      near(planeWorldCoordinate("datum:xy", 25).valueMm, 25, 1e-12, "by the offset");
      near(planeWorldCoordinate("datum:xz", 20).valueMm, -20, 1e-12, "XZ offsets move along −y");
      near(planeWorldCoordinate("datum:yz", -5).valueMm, -5, 1e-12, "YZ offsets move along x");
      near(planeOffsetForCoordinate("datum:xz", -20), 20, 1e-12, "y = −20 is XZ offset +20");
      near(planeOffsetForCoordinate("datum:xy", 7), 7, 1e-12, "z = 7 is XY offset 7");
    }
  }
];
