import Module from "manifold-3d";
import { canonicalizeJson, canonicalMeshHash, commandJournalPrefixHash, semanticDocumentHash } from "../packages/evidence/src/index.js";
import { CommandSession } from "../packages/commands/src/index.js";
import { exportBinaryStl } from "../packages/import-export/src/index.js";
import { createBracketDocument } from "../packages/model-schema/src/index.js";
import { BracketSolidKernel } from "../packages/solid-bracket-kernel/src/index.js";
import { ManifoldSolidKernel } from "../packages/solid-manifold-adapter/src/adapter.js";
import { combineSolids, extrudeProfileSolid, revolveProfileSolid } from "../packages/solid-manifold-adapter/src/general.js";
import { tessellateExtrude, tessellateRevolve } from "../packages/workbench-geometry/src/index.js";
import type { ModelMesh } from "../packages/solid-kernel-api/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

export const evidenceAndSolidTests: readonly TestCase[] = [
  {
    name: "canonical JSON and semantic hashes are deterministic across property insertion order",
    run: async () => {
      equal(canonicalizeJson({ z: 0, a: [3, { y: true, x: "v" }] }), "{\"a\":[3,{\"x\":\"v\",\"y\":true}],\"z\":0}", "canonical keys should be ordered");
      const first = createBracketDocument("document:test-evidence");
      const second = structuredClone(first);
      const [firstHash, secondHash] = await Promise.all([semanticDocumentHash(first), semanticDocumentHash(second)]);
      equal(firstHash, secondHash, "equivalent semantic documents must hash identically");
      equal(firstHash.length, 64, "SHA-256 hash must contain 64 hexadecimal characters");
    }
  },
  {
    name: "command journal prefix hash binds the complete ordered history",
    run: async () => {
      const first = new CommandSession(createBracketDocument("document:test-journal"));
      const second = new CommandSession(createBracketDocument("document:test-journal"));
      const accept = () => ({ ok: true as const, value: undefined });
      for (const [session, key, interim, final] of [
        [first, "width", "70", "60"],
        [second, "height", "50", "40"]
      ] as const) {
        let result = await session.execute({ protocolVersion: 1, kind: "set-parameter", commandId: `command:${key}-interim`, expectedRevision: 0, parameterKey: key, expression: { decimal: interim, unit: "mm" } }, accept);
        assert(result.ok, "intermediate journal command should commit");
        result = await session.execute({ protocolVersion: 1, kind: "set-parameter", commandId: `command:${key}-restore`, expectedRevision: 1, parameterKey: key, expression: { decimal: final, unit: "mm" } }, accept);
        assert(result.ok, "restoring journal command should commit");
      }
      const firstHash = await commandJournalPrefixHash(first.current.commandJournal);
      const secondHash = await commandJournalPrefixHash(second.current.commandJournal);
      assert(firstHash !== secondHash, "different ordered histories ending at the same dimensions must not collide by construction");
      equal(await commandJournalPrefixHash(first.current.commandJournal), firstHash, "the same journal prefix must hash deterministically");
    }
  },
  {
    name: "canonical mesh hash ignores vertex and triangle insertion order while retaining winding",
    run: async () => {
      const first: ModelMesh = {
        positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
        indices: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 2, 0, 3])
      };
      const second: ModelMesh = {
        positions: new Float64Array([0, 0, 1, 0, 1, 0, 1, 0, 0, 0, 0, 0]),
        indices: new Uint32Array([2, 1, 0, 1, 3, 0, 3, 2, 0, 2, 3, 1])
      };
      equal(await canonicalMeshHash(first), await canonicalMeshHash(second), "mesh hash should normalize stable ordering");
    }
  },
  {
    name: "canonical evidence hashing rejects malformed JSON and mesh payloads before allocation",
    run: async () => {
      const malformedJson: unknown[] = [
        { value: undefined },
        Object.assign(Object.create({ inherited: true }) as object, { value: 1 }),
        Array(2)
      ];
      for (const value of malformedJson) {
        let rejected = false;
        try { canonicalizeJson(value); } catch { rejected = true; }
        assert(rejected, "canonical JSON must reject undefined, non-plain, and sparse input");
      }

      const malformedMeshes: ModelMesh[] = [
        { positions: new Float64Array(), indices: new Uint32Array() },
        { positions: new Float64Array([0, 0]), indices: new Uint32Array([0, 0, 0]) },
        { positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1]) },
        { positions: new Float64Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 3]) },
        { positions: new Float64Array([0, 0, 0, 0, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) },
        { positions: new Float64Array([0, 0, 0, Number.NaN, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }
      ];
      for (const mesh of malformedMeshes) {
        let rejected = false;
        try { await canonicalMeshHash(mesh); } catch { rejected = true; }
        assert(rejected, "canonical mesh hash must reject empty, misaligned, non-triangle, OOB, collapsed, and nonfinite payloads");
      }
      let wrongTypesRejected = false;
      try {
        await canonicalMeshHash({ positions: new Float32Array([0, 0, 0]) as unknown as Float64Array, indices: new Uint32Array([0, 0, 0]) });
      } catch { wrongTypesRejected = true; }
      assert(wrongTypesRejected, "canonical mesh hash must reject the wrong position precision class");
    }
  },
  {
    name: "project-owned f64 bracket kernel has exact bounds, qualified volume, and one passage handle",
    run: async () => {
      const kernel = new BracketSolidKernel();
      const request = {
        bodyId: "body:test-bracket",
        widthMeters: 0.123456789123,
        heightMeters: 0.04,
        thicknessMeters: 0.01,
        holeDiameterMeters: 0.01,
        circularSegments: 96 as const
      };
      const result = await kernel.buildBracket(request);
      assert(result.ok, "bracket should regenerate as a valid solid");
      near(result.value.measurements.boundsMeters.size[0], request.widthMeters, 1e-15, "f64 width should match semantic dimension without render quantization");
      near(result.value.measurements.boundsMeters.size[1], 0.04, 1e-15, "height should match semantic dimension");
      near(result.value.measurements.boundsMeters.size[2], 0.01, 1e-15, "thickness should match semantic dimension");
      const polygonHoleArea = 96 / 2 * 0.005 ** 2 * Math.sin(2 * Math.PI / 96);
      const expectedVolume = request.widthMeters * 0.04 * 0.01 - polygonHoleArea * 0.01;
      near(result.value.measurements.volumeCubicMeters, expectedVolume, 1e-15, "mesh volume should match the fixed 96-segment profile calculation");
      equal(result.value.topology.components, 1, "bracket should contain one connected component");
      equal(result.value.topology.genus, 1, "through-hole bracket should have genus one");
      equal(result.value.topology.closed, true, "bracket should be closed");
      equal(result.value.topology.manifold, true, "bracket should be manifold");
      equal(result.value.topology.triangles, 800, "corner-preserving ring surfaces should contain 800 triangles for a non-square plate");

      const repeat = await kernel.buildBracket(request);
      assert(repeat.ok, "repeated regeneration should succeed");
      equal(await canonicalMeshHash(result.value.mesh), await canonicalMeshHash(repeat.value.mesh), "repeated regeneration should produce identical canonical mesh evidence");

      const stl = exportBinaryStl(result.value, "mm");
      assert(stl.ok, "validated solid should export to STL");
      equal(stl.value.bytes.byteLength, 84 + result.value.topology.triangles * 50, "binary STL length should match its triangle count");
    }
  },
  {
    name: "f64 bracket kernel preserves exact rectangular corners at both supported extreme aspect ratios",
    run: async () => {
      const kernel = new BracketSolidKernel();
      for (const [width, height] of [[0.5, 0.005], [0.005, 0.5]] as const) {
        const thickness = 0.001;
        const radius = 0.0005;
        const result = await kernel.buildBracket({
          bodyId: "body:extreme-bracket",
          widthMeters: width,
          heightMeters: height,
          thicknessMeters: thickness,
          holeDiameterMeters: radius * 2,
          circularSegments: 96
        });
        assert(result.ok, "supported extreme aspect ratio must produce a qualified solid");
        near(result.value.measurements.boundsMeters.size[0], width, 1e-15, "extreme width must retain both exact rectangle corners");
        near(result.value.measurements.boundsMeters.size[1], height, 1e-15, "extreme height must retain both exact rectangle corners");
        const holeArea = 96 / 2 * radius ** 2 * Math.sin(2 * Math.PI / 96);
        const holePerimeter = 2 * 96 * radius * Math.sin(Math.PI / 96);
        const expectedVolume = (width * height - holeArea) * thickness;
        const expectedArea = 2 * (width * height - holeArea) + 2 * (width + height) * thickness + holePerimeter * thickness;
        near(result.value.measurements.volumeCubicMeters, expectedVolume, 1e-15, "extreme solid volume must include the complete rectangle, not an inscribed radial polygon");
        near(result.value.measurements.surfaceAreaSquareMeters, expectedArea, 1e-14, "extreme solid area must match rectangle, regular passage polygon, and both walls");
        equal(result.value.topology.components, 1, "extreme solid must remain one component");
        equal(result.value.topology.genus, 1, "extreme solid must retain one passage handle");
        equal(result.value.topology.closed, true, "extreme solid must remain closed");
      }
    }
  },
  {
    name: "Manifold 3.5.1 candidate adapter restores analytic f64 coordinates before qualification",
    run: async () => {
      const module = await Module();
      module.setup();
      const kernel = new ManifoldSolidKernel(module);
      const result = await kernel.buildBracket({
        bodyId: "body:candidate-bracket",
        widthMeters: 0.123456789123,
        heightMeters: 0.04,
        thicknessMeters: 0.01,
        holeDiameterMeters: 0.01,
        circularSegments: 96
      });
      assert(result.ok, "candidate adapter should qualify the bounded bracket");
      near(result.value.measurements.boundsMeters.size[0], 0.123456789123, 1e-15, "candidate adapter must not promote f32 output as model precision");
    }
  },
  {
    name: "Stage 1 general evaluator extrudes and revolves arbitrary profiles into validated closed solids",
    run: async () => {
      const module = await Module();
      module.setup();
      // Extrude a 20 x 20 mm square to 10 mm -> volume 0.02*0.02*0.01 = 4e-6 m^3.
      const square: readonly (readonly [number, number])[] = [[-0.01, -0.01], [0.01, -0.01], [0.01, 0.01], [-0.01, 0.01]];
      const extruded = extrudeProfileSolid(module, { bodyId: "body:extrude-square", profileMeters: square, heightMeters: 0.01 });
      assert(extruded.ok, "a valid square profile must extrude into a closed solid");
      near(extruded.value.measurements.volumeCubicMeters, 4e-6, 1e-10, "extruded square volume must equal width*height*depth");
      equal(extruded.value.topology.components, 1, "an extruded single profile must produce one closed body");
      equal(extruded.value.topology.genus, 0, "an extruded square must be genus 0");

      // Guards: degenerate inputs fail explicitly.
      assert(!extrudeProfileSolid(module, { bodyId: "body:bad", profileMeters: [[0, 0], [0.01, 0]], heightMeters: 0.01 }).ok, "a profile with fewer than three points must be rejected");
      assert(!extrudeProfileSolid(module, { bodyId: "body:bad", profileMeters: square, heightMeters: 0 }).ok, "a non-positive extrusion height must be rejected");

      // Revolve an annular rectangle (radial 10..20 mm, axial 10 mm) by 360 deg -> a tube/ring solid.
      const ring: readonly (readonly [number, number])[] = [[0.01, -0.005], [0.02, -0.005], [0.02, 0.005], [0.01, 0.005]];
      const revolved = revolveProfileSolid(module, { bodyId: "body:revolve-ring", profileMeters: ring, degrees: 360, circularSegments: 128 });
      assert(revolved.ok, "a valid radial profile must revolve into a closed solid");
      equal(revolved.value.topology.components, 1, "a full revolve of a single profile must produce one closed body");
      // pi*(R^2 - r^2)*h = pi*(0.0004 - 0.0001)*0.01 ~= 9.42e-6; faceted volume is slightly under.
      assert(revolved.value.measurements.volumeCubicMeters > 9.0e-6 && revolved.value.measurements.volumeCubicMeters < 9.5e-6, "revolved ring volume must approximate the analytic annulus");
      assert(!revolveProfileSolid(module, { bodyId: "body:bad", profileMeters: [[-0.01, 0], [0.01, 0], [0, 0.01]], degrees: 360 }).ok, "a profile crossing the revolve axis must be rejected");
    }
  },
  {
    name: "Stage 1 feature evaluator composes primitives, booleans, and plane placement",
    run: async () => {
      const module = await Module();
      module.setup();

      // Primitive box 20 x 20 x 10 mm (centered) -> volume 4e-6 m^3.
      const box = combineSolids(module, "body:box", [{ kind: "box", sizeMeters: [0.02, 0.02, 0.01] }], "union");
      assert(box.ok, "a box primitive must evaluate");
      near(box.value.measurements.volumeCubicMeters, 4e-6, 1e-10, "box volume must equal the product of its sizes");

      // Boolean subtract: 60 x 40 x 10 mm plate minus a Ø10 mm through-bore -> plate with a hole.
      const plate = combineSolids(module, "body:plate", [
        { kind: "box", sizeMeters: [0.06, 0.04, 0.01] },
        { kind: "cylinder", radiusMeters: 0.005, heightMeters: 0.02, circularSegments: 128 }
      ], "subtract");
      assert(plate.ok, "box minus cylinder must evaluate into a plate with a bore");
      equal(plate.value.topology.components, 1, "a plate with a through-bore is a single body");
      equal(plate.value.topology.genus, 1, "a through-bore makes the plate genus 1");
      const expectedPlateVolume = 0.06 * 0.04 * 0.01 - Math.PI * 0.005 * 0.005 * 0.01;
      assert(Math.abs(plate.value.measurements.volumeCubicMeters - expectedPlateVolume) / expectedPlateVolume < 5e-3, "plate-with-bore volume must approximate block minus cylinder");

      // Plane placement: extrude a 20 x 20 mm square to 10 mm on the XZ (Front) plane -> extrude axis is Y.
      const square: readonly (readonly [number, number])[] = [[-0.01, -0.01], [0.01, -0.01], [0.01, 0.01], [-0.01, 0.01]];
      const onFront = combineSolids(module, "body:front", [{ kind: "extrude", profileMeters: square, heightMeters: 0.01, plane: "xz" }], "union");
      assert(onFront.ok, "an XZ-plane extrude must evaluate");
      const size = onFront.value.measurements.boundsMeters.size;
      near(size[1], 0.01, 1e-6, "an XZ-plane extrude must place the 10 mm extrude depth along world Y");
      near(size[0], 0.02, 1e-6, "the profile width must remain along world X");
      near(size[2], 0.02, 1e-6, "the profile height must stand along world Z");

      // Empty feature list is rejected.
      assert(!combineSolids(module, "body:empty", [], "union").ok, "an empty feature list must be rejected");
    }
  },
  {
    name: "browser tessellator matches the Manifold kernel by volume and handles concave profiles",
    run: async () => {
      const module = await Module();
      module.setup();

      // Rectangle 20 x 10 mm extruded 5 mm -> exactly 1000 mm^3.
      const rectangleMm: readonly (readonly [number, number])[] = [[-10, -5], [10, -5], [10, 5], [-10, 5]];
      const rectangleMesh = tessellateExtrude(rectangleMm, 5, "xy");
      near(meshVolumeMm3(rectangleMesh), 1000, 1e-6, "an extruded rectangle must have volume width*height*depth");

      // Same prism through the qualified kernel (metres) must agree with the browser mesh.
      const rectangleMeters = rectangleMm.map(([x, y]) => [x / 1000, y / 1000] as const);
      const kernelPrism = extrudeProfileSolid(module, { bodyId: "body:xcheck", profileMeters: rectangleMeters, heightMeters: 0.005 });
      assert(kernelPrism.ok, "the kernel prism must evaluate");
      near(meshVolumeMm3(rectangleMesh) / 1e9, kernelPrism.value.measurements.volumeCubicMeters, 1e-12, "browser and kernel prism volumes must match");

      // Concave L-shaped profile exercises ear-clipping; volume must equal shoelace area * height.
      const lShapeMm: readonly (readonly [number, number])[] = [[0, 0], [20, 0], [20, 10], [10, 10], [10, 20], [0, 20]];
      const lMesh = tessellateExtrude(lShapeMm, 4, "xy");
      near(meshVolumeMm3(lMesh), shoelaceAreaMm2(lShapeMm) * 4, 1e-6, "a concave extrude volume must equal its planar area times height");
      assert(shoelaceAreaMm2(lShapeMm) > 299 && shoelaceAreaMm2(lShapeMm) < 301, "the L-shape planar area must be 300 mm^2");

      // A full revolve of an off-axis rectangle closes into a solid ring with positive volume.
      const revolveMm: readonly (readonly [number, number])[] = [[10, -2], [20, -2], [20, 2], [10, 2]];
      const ringMesh = tessellateRevolve(revolveMm, 360, "xy");
      // Pappus: V = 2*pi*R_centroid*A = 2*pi*15*(10*4) ~= 3769.9 mm^3; the 64-facet mesh is marginally under.
      assert(meshVolumeMm3(ringMesh) > 3740 && meshVolumeMm3(ringMesh) < 3775, "a revolved ring must approximate the analytic annulus volume");
    }
  }
];

/** Absolute signed volume of a closed triangle mesh, in cubic millimetres. */
function meshVolumeMm3(mesh: { readonly positionsMm: readonly number[]; readonly indices: readonly number[] }): number {
  let total = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i]! * 3;
    const b = mesh.indices[i + 1]! * 3;
    const c = mesh.indices[i + 2]! * 3;
    const ax = mesh.positionsMm[a]!; const ay = mesh.positionsMm[a + 1]!; const az = mesh.positionsMm[a + 2]!;
    const bx = mesh.positionsMm[b]!; const by = mesh.positionsMm[b + 1]!; const bz = mesh.positionsMm[b + 2]!;
    const cx = mesh.positionsMm[c]!; const cy = mesh.positionsMm[c + 1]!; const cz = mesh.positionsMm[c + 2]!;
    total += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return Math.abs(total) / 6;
}

/** Shoelace area of a polygon, in square millimetres. */
function shoelaceAreaMm2(polygon: readonly (readonly [number, number])[]): number {
  let area = 0;
  for (let i = 0; i < polygon.length; i += 1) {
    const current = polygon[i]!;
    const next = polygon[(i + 1) % polygon.length]!;
    area += current[0] * next[1] - next[0] * current[1];
  }
  return Math.abs(area) / 2;
}
