import * as THREE from "three";
import { applyZebraToObject } from "../packages/viewport-three/src/zebra-materials.js";
import { buildAnalysisGroup, disposeAnalysisGroup } from "../packages/viewport-three/src/analysis-overlay.js";
import { analyzeDraft, draftColor } from "../packages/workbench-geometry/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";
import { boxMeshAt, draftedBlock } from "./analysis-meshes.js";

const OPTIONS = { axis: "z", frequency: 6 } as const;

function plainGeometry(withNormals: boolean): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  if (withNormals) geometry.setAttribute("normal", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  return geometry;
}

/** What the renderer does: hand the material's compile hook a shader and read what came back. */
function compiled(material: THREE.Material): { uniforms: Record<string, { value: unknown }>; fragmentShader: string } {
  const shader = { uniforms: {} as Record<string, { value: unknown }>, fragmentShader: "void main() {\n#include <opaque_fragment>\n}" };
  (material.onBeforeCompile as (shader: unknown, renderer: unknown) => void)(shader, undefined);
  return shader;
}

export const viewportAnalysisTests: readonly TestCase[] = [
  {
    name: "zebra stripes reach every material type: lit ones are patched, unlit and imported ones are swapped and restored",
    run: () => {
      const root = new THREE.Group();
      const standard = new THREE.Mesh(plainGeometry(true), new THREE.MeshStandardMaterial({ color: "#336699" }));
      const physical = new THREE.Mesh(plainGeometry(true), new THREE.MeshPhysicalMaterial());
      const phong = new THREE.Mesh(plainGeometry(true), new THREE.MeshPhongMaterial());
      const basicMaterial = new THREE.MeshBasicMaterial({ color: "#ff0000", transparent: true, opacity: 0.5, side: THREE.DoubleSide });
      const basic = new THREE.Mesh(plainGeometry(false), basicMaterial);
      const multi = new THREE.Mesh(plainGeometry(true), [new THREE.MeshNormalMaterial(), new THREE.MeshStandardMaterial()]);
      const helper = new THREE.Mesh(plainGeometry(true), new THREE.MeshBasicMaterial());
      helper.userData["ps3dExchangeHelper"] = true;
      const line = new THREE.Line(plainGeometry(true), new THREE.LineBasicMaterial());
      root.add(standard, physical, phong, basic, multi, helper, line);
      const originalStandard = standard.material;
      const originalMultiFirst = (multi.material as THREE.Material[])[0]!;

      equal(applyZebraToObject(root, OPTIONS), 5, "five meshes striped; the helper and the line are left alone");
      const standardShader = compiled(standard.material as THREE.Material);
      assert(standardShader.fragmentShader.includes("zebraBand") && standardShader.fragmentShader.includes("uniform vec3 uZebraAxis"), "a standard material gets the stripe shader");
      equal((standardShader.uniforms["uZebraFrequency"] as { value: number }).value, 6, "with the frequency");
      assert(standard.material === originalStandard, "its material object is kept");
      assert(compiled(physical.material as THREE.Material).fragmentShader.includes("zebraBand"), "physical too");
      assert(compiled(phong.material as THREE.Material).fragmentShader.includes("zebraBand"), "and Phong");
      assert(basic.material instanceof THREE.MeshStandardMaterial, "an unlit imported mesh is given a lit stand-in");
      assert(compiled(basic.material as THREE.Material).fragmentShader.includes("zebraBand"), "that carries the stripes");
      const stand = basic.material as THREE.MeshStandardMaterial;
      equal(stand.transparent, true, "the stand-in keeps transparency");
      near(stand.opacity, 0.5, 1e-12, "and opacity");
      equal(stand.side, THREE.DoubleSide, "and sidedness");
      assert(basic.geometry.getAttribute("normal") !== undefined, "a mesh without normals gets them so it can be shaded");
      const slots = multi.material as THREE.Material[];
      assert(slots[0] instanceof THREE.MeshStandardMaterial && slots[0] !== originalMultiFirst, "a multi-material mesh has its unlit slot swapped");
      assert(compiled(slots[1]!).fragmentShader.includes("zebraBand"), "and its lit slot patched");
      assert(helper.material instanceof THREE.MeshBasicMaterial, "the helper keeps its basic material");

      // Changing the options re-patches without swapping again.
      applyZebraToObject(root, { axis: "x", frequency: 12 });
      equal((compiled(basic.material as THREE.Material).uniforms["uZebraFrequency"] as { value: number }).value, 12, "new frequency reaches the stand-in");
      assert(basic.material === stand, "and the stand-in is reused");

      equal(applyZebraToObject(root, null), 0, "turning stripes off stripes nothing");
      assert(basic.material === basicMaterial, "the original unlit material is back");
      assert((multi.material as THREE.Material[])[0] === originalMultiFirst, "and the original array slot");
      assert(!compiled(standard.material as THREE.Material).fragmentShader.includes("zebraBand"), "standard shading is back");
      assert(!compiled(slots[1]!).fragmentShader.includes("zebraBand"), "in every slot");
    }
  },
  {
    name: "analysis overlay builds coloured, metre-scaled meshes and highlight lines and disposes them",
    run: () => {
      const block = draftedBlock(40, 20, 5);
      const analysis = analyzeDraft(block.positionsMm, block.indices, { pullDirection: [0, 0, 1], requiredDraftDeg: 2 });
      const colors = analysis.triangleAngleDeg.map((angle) => draftColor(angle, 2));
      const group = buildAnalysisGroup({
        meshes: [{ id: "body:a", positionsMm: block.positionsMm, indices: block.indices, triangleColors: colors }],
        lines: [{ id: "edges", segmentsMm: [0, 0, 0, 10, 0, 0, 10, 0, 0, 10, 10, 0], color: "#ff0000" }]
      });
      equal(group.children.length, 2, "one mesh and one line set");
      const mesh = group.children[0] as THREE.Mesh;
      const position = mesh.geometry.getAttribute("position");
      equal(position.count, 12 * 3, "twelve triangles, three corners each (flat colours need unshared corners)");
      const xs = Array.from({ length: position.count }, (_, index) => position.getX(index));
      near(Math.max(...xs), 0.02, 1e-6, "millimetres become metres: the 40 mm block reaches 20 mm");
      const color = mesh.geometry.getAttribute("color");
      // Triangle 0 is the bottom (undercut, red); triangle 2 the top (enough draft, green).
      assert(color.getX(0) > color.getY(0), "the bottom is red");
      assert(color.getY(6) > color.getX(6), "the top is green");
      const wall = analysis.triangleAngleDeg.indexOf(analysis.triangleAngleDeg.find((angle) => Math.abs(angle - 5) < 1e-9)!);
      assert(wall >= 4, "a side wall carries the draft");
      const lines = group.children[1] as THREE.LineSegments;
      equal(lines.geometry.getAttribute("position").count, 4, "two segments, four points");
      equal((lines.material as THREE.LineBasicMaterial).depthTest, false, "highlights draw through the model by default");
      const smooth = buildAnalysisGroup({ meshes: [{ id: "v", positionsMm: boxMeshAt([0, 0, 0], [1, 1, 1]).positionsMm, indices: [0, 1, 2], vertexColors: [[1, 0, 0], [0, 1, 0], [0, 0, 1], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]] }], lines: [] });
      const vc = (smooth.children[0] as THREE.Mesh).geometry.getAttribute("color");
      equal(`${vc.getX(0)},${vc.getY(1)},${vc.getZ(2)}`, "1,1,1", "per-vertex colours follow the vertex index");
      disposeAnalysisGroup(group);
      equal(group.children.length, 0, "disposal empties the group");
      const none = buildAnalysisGroup({ meshes: [{ id: "empty", positionsMm: [], indices: [] }], lines: [{ id: "none", segmentsMm: [], color: "#fff" }] });
      equal(none.children.length, 0, "empty entries add nothing");
    }
  }
];
