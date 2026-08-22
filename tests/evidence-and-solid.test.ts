import Module from "manifold-3d";
import { canonicalizeJson, canonicalMeshHash, commandJournalPrefixHash, semanticDocumentHash } from "../packages/evidence/src/index.js";
import { CommandSession } from "../packages/commands/src/index.js";
import { exportBinaryStl } from "../packages/import-export/src/index.js";
import { createBracketDocument } from "../packages/model-schema/src/index.js";
import { BracketSolidKernel } from "../packages/solid-bracket-kernel/src/index.js";
import { ManifoldSolidKernel } from "../packages/solid-manifold-adapter/src/adapter.js";
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
  }
];
