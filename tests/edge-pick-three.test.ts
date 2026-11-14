import * as THREE from "three";
import { creaseEdgesOfMeshes, makeVisibilityTest, meshTrianglesMm, pickCameraOf } from "../packages/viewport-three/src/three-pick.js";
import { cornerVertices, pickEdgeAt, pickEdgeCandidates, pickVertexAt, projectToScreen, type PickEdgeSegment } from "../packages/viewport-three/src/edge-pick.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

const WIDTH = 800;
const HEIGHT = 600;

function orbitCamera(kind: "perspective" | "orthographic", radiusM: number, azimuthDeg = -45, elevationDeg = 30): THREE.Camera {
  const azimuth = THREE.MathUtils.degToRad(azimuthDeg);
  const elevation = THREE.MathUtils.degToRad(elevationDeg);
  const camera = kind === "perspective" ? new THREE.PerspectiveCamera(38, WIDTH / HEIGHT, 0.0001, 100) : new THREE.OrthographicCamera(-1, 1, 1, -1, 0.0001, 100);
  if (camera instanceof THREE.OrthographicCamera) {
    const half = radiusM * Math.tan(THREE.MathUtils.degToRad(19));
    camera.left = -half * WIDTH / HEIGHT; camera.right = half * WIDTH / HEIGHT; camera.top = half; camera.bottom = -half;
    camera.updateProjectionMatrix();
  }
  camera.position.set(radiusM * Math.cos(elevation) * Math.cos(azimuth), radiusM * Math.cos(elevation) * Math.sin(azimuth), radiusM * Math.sin(elevation));
  camera.up.set(0, 0, 1);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

/** A body mesh as the viewport holds it: millimetre sizes drawn in metres, with a semantic id. */
function bodyMesh(geometry: THREE.BufferGeometry, id: string, at: readonly [number, number, number] = [0, 0, 0]): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial());
  mesh.position.set(at[0] / 1000, at[1] / 1000, at[2] / 1000);
  mesh.userData["semanticId"] = id;
  mesh.userData["selectionKind"] = "body";
  mesh.updateMatrixWorld(true);
  return mesh;
}

const clientOf = (camera: THREE.Camera, pointMm: readonly [number, number, number]): { x: number; y: number } => {
  const v = new THREE.Vector3(pointMm[0] / 1000, pointMm[1] / 1000, pointMm[2] / 1000).project(camera);
  return { x: (v.x + 1) / 2 * WIDTH, y: (1 - v.y) / 2 * HEIGHT };
};

export const edgePickThreeTests: readonly TestCase[] = [
  {
    name: "pickCameraOf agrees with three.js projection for the perspective and the orthographic camera",
    run: () => {
      for (const kind of ["perspective", "orthographic"] as const) {
        const camera = orbitCamera(kind, 0.12);
        const pick = pickCameraOf(camera, WIDTH, HEIGHT);
        for (const point of [[0, 0, 0], [20, -10, 5], [-30, 25, 40]] as const) {
          const expected = clientOf(camera, point);
          const got = projectToScreen(pick, point);
          assert(got !== undefined, "projects");
          near(got!.x, expected.x, 1e-6, `${kind} x`);
          near(got!.y, expected.y, 1e-6, `${kind} y`);
        }
      }
    }
  },
  {
    name: "Creased edges are found on three.js primitives (box, cylinder) drawn as bodies with no named faces, in world millimetres",
    run: () => {
      const box = bodyMesh(new THREE.BoxGeometry(0.02, 0.01, 0.006), "primitive:box", [100, 0, 0]);
      const found = creaseEdgesOfMeshes([box], 30);
      equal(found.edges.length, 12, "a box has 12 edges");
      const xs = found.edges.flatMap((edge) => [edge.a[0], edge.b[0]]);
      near(Math.min(...xs), 90, 1e-3, "world position: the box is centred 100 mm along x and 20 mm wide");
      near(Math.max(...xs), 110, 1e-3, "world position, far side");
      const cylinder = bodyMesh(new THREE.CylinderGeometry(0.004, 0.004, 0.01, 32).rotateX(Math.PI / 2), "primitive:cyl");
      const rims = creaseEdgesOfMeshes([cylinder], 30);
      assert(rims.edges.length >= 64 && new Set(rims.edges.map((edge) => edge.chain)).size === 2, "a cylinder has its two rims, one chain each");
      const fine = creaseEdgesOfMeshes([cylinder], 5);
      assert(fine.edges.length > rims.edges.length, "a smaller crease angle offers the facet seams too");
      const two = creaseEdgesOfMeshes([box, cylinder], 30);
      equal(new Set(two.edges.map((edge) => edge.chain)).size >= 14, true, "chains stay distinct between the meshes of one body");
      assert(meshTrianglesMm(box)!.indices.length === 36, "triangles are read from the geometry");
    }
  },
  {
    name: "A real click on an edge of a small drawn body picks it: project the edge as the canvas would, click 3 px off, with the hidden-edge test on the real mesh",
    run: () => {
      const mesh = bodyMesh(new THREE.BoxGeometry(0.003, 0.002, 0.0015), "primitive:tiny"); // 3 x 2 x 1.5 mm
      const camera = orbitCamera("perspective", 0.03);
      const edges: PickEdgeSegment[] = creaseEdgesOfMeshes([mesh], 30).edges.map((edge) => ({ bodyId: "primitive:tiny", chain: edge.chain, a: edge.a, b: edge.b }));
      const pick = pickCameraOf(camera, WIDTH, HEIGHT);
      const visible = makeVisibilityTest(new THREE.Raycaster(), camera, [mesh]);
      let picked = 0; let seen = 0;
      for (const edge of edges) {
        const mid: [number, number, number] = [(edge.a[0] + edge.b[0]) / 2, (edge.a[1] + edge.b[1]) / 2, (edge.a[2] + edge.b[2]) / 2];
        const client = clientOf(camera, mid);
        const lit = visible(mid, "primitive:tiny");
        if (lit) seen += 1;
        const found = pickEdgeAt({ x: client.x + 2, y: client.y + 2 }, pick, edges, 8, { isVisible: visible });
        if (lit && found !== undefined) picked += 1;
        if (!lit) assert(found === undefined || found.chain !== edge.chain, "a hidden edge is not the one picked");
      }
      assert(seen >= 9 && seen <= 10, `a box seen from a corner shows 9 edges to the camera (${seen})`);
      equal(picked, seen, "every visible edge of the 3 mm box is picked by a click 3 px off it");
      const all = pickEdgeCandidates(clientOf(camera, [0, 0, 0]), pick, edges, 200, { isVisible: visible });
      assert(all.length < 12, "the hidden edges never join the stack");
    }
  },
  {
    name: "Corner vertices of a drawn box are picked by their pixels and the corner behind the box is not offered",
    run: () => {
      const mesh = bodyMesh(new THREE.BoxGeometry(0.02, 0.02, 0.02), "primitive:cube");
      const camera = orbitCamera("perspective", 0.1);
      const edges = creaseEdgesOfMeshes([mesh], 30).edges.map((edge) => ({ bodyId: "primitive:cube", chain: edge.chain, a: edge.a, b: edge.b }));
      const vertices = cornerVertices(edges).map((pointMm) => ({ bodyId: "primitive:cube", pointMm }));
      equal(vertices.length, 8, "eight corners");
      const pick = pickCameraOf(camera, WIDTH, HEIGHT);
      const visible = makeVisibilityTest(new THREE.Raycaster(), camera, [mesh]);
      const near_corner = pickVertexAt(clientOf(camera, [10, -10, 10]), pick, vertices, 8, { isVisible: visible });
      assert(near_corner !== undefined && Math.abs(near_corner.pointMm[0] - 10) < 1e-3 && Math.abs(near_corner.pointMm[1] + 10) < 1e-3 && Math.abs(near_corner.pointMm[2] - 10) < 1e-3, "the corner facing the camera");
      const far_corner = pickVertexAt(clientOf(camera, [-10, 10, -10]), pick, vertices, 8, { isVisible: visible });
      assert(far_corner === undefined || Math.abs(far_corner.pointMm[0] + 10) > 1e-3 || Math.abs(far_corner.pointMm[2] + 10) > 1e-3, "the corner on the far side, hidden behind the cube, is not picked");
    }
  },
  {
    name: "Orthographic view picks the same way",
    run: () => {
      const mesh = bodyMesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), "primitive:o");
      const camera = orbitCamera("orthographic", 0.06);
      const edges = creaseEdgesOfMeshes([mesh], 30).edges.map((edge) => ({ bodyId: "primitive:o", chain: edge.chain, a: edge.a, b: edge.b }));
      const pick = pickCameraOf(camera, WIDTH, HEIGHT);
      const visible = makeVisibilityTest(new THREE.Raycaster(), camera, [mesh]);
      const top = clientOf(camera, [0, 0, 5]);
      const found = pickEdgeAt({ x: top.x + 40, y: top.y }, pick, edges, 8, { isVisible: visible });
      assert(found === undefined || found.distancePx <= 8, "whatever is returned is within the tolerance");
      const corner = clientOf(camera, [5, -5, 5]);
      assert(pickEdgeAt({ x: corner.x + 1, y: corner.y }, pick, edges, 8, { isVisible: visible }) !== undefined, "a corner of the near top is picked in orthographic view");
    }
  }
];
