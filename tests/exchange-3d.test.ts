import {
  EXCHANGE_FORMATS,
  buildInteractive3dPdf,
  buildPdfModelPackage,
  formatForFileName,
  metersPerUnit,
  type ExchangeMetrics
} from "../packages/exchange-3d/src/index.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

const METRICS: ExchangeMetrics = {
  objectCount: 2,
  meshCount: 1,
  pointCount: 0,
  lineCount: 0,
  vertexCount: 36,
  triangleCount: 12,
  materialCount: 1,
  bounds: {
    minMeters: [-0.02, -0.015, -0.005],
    maxMeters: [0.02, 0.015, 0.005],
    sizeMeters: [0.04, 0.03, 0.01],
    centerMeters: [0, 0, 0]
  }
};

export const exchange3dTests: readonly TestCase[] = [
  {
    name: "3D exchange registry truthfully separates local, pass-through, converter, and kernel formats",
    run: () => {
      equal(EXCHANGE_FORMATS.length, 20, "format truth table should retain every reviewed family");
      equal(EXCHANGE_FORMATS.filter((format) => format.support === "local" && (format.direction === "import" || format.direction === "both")).length, 14, "fourteen local import families should be explicit");
      equal(formatForFileName("BRACKET.GLB")?.id, "gltf", "extension matching should be case insensitive");
      equal(formatForFileName("housing.step")?.support, "kernel-required", "STEP must not be mislabeled as local support");
      equal(formatForFileName("assembly.sldasm")?.support, "converter-required", "native CAD must require an authorized converter");
      equal(formatForFileName("review.prc")?.support, "pdf-pass-through", "PRC should be accepted only as a PDF payload");
      near(metersPerUnit("mm"), 0.001, 1e-12, "millimeter scale should be exact");
      near(metersPerUnit("in"), 0.0254, 1e-12, "inch scale should be exact");
    }
  },
  {
    name: "PDF model package embeds an associated GLB and valid cross-reference table",
    run: async () => {
      const blob = buildPdfModelPackage({
        title: "PS3D fixture",
        projectName: "PS3D Fixture Study",
        sourceLabel: "test mesh",
        metrics: METRICS,
        preview: { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), width: 1, height: 1 },
        glbBytes: new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]),
        generatedAt: new Date("2026-08-20T00:00:00Z")
      });
      equal(blob.type, "application/pdf", "model package should have a PDF media type");
      const text = new TextDecoder("latin1").decode(await blob.arrayBuffer());
      assert(text.startsWith("%PDF-1.7"), "PDF header should be present");
      assert(text.includes("/EmbeddedFiles"), "catalog should expose the embedded-file name tree");
      assert(text.includes("/AFRelationship /Data"), "GLB should be an associated data file");
      assert(text.includes("(ps3d-model.glb)"), "attachment file name should be deterministic");
      assert(text.includes("/Subtype /model#2Fgltf-binary"), "attachment should identify the GLB media subtype");
      assert(text.includes("This page is not a U3D/PRC interactive annotation."), "report must state the interactive boundary");
      verifyPdfXref(text, 10);
    }
  },
  {
    name: "interactive 3D PDF pass-through writes a U3D annotation without claiming conversion",
    run: async () => {
      const blob = buildInteractive3dPdf({
        title: "PS3D U3D pass-through",
        payloadName: "fixture.u3d",
        payloadBytes: new Uint8Array([0x55, 0x33, 0x44, 0]),
        subtype: "U3D",
        generatedAt: new Date("2026-08-20T00:00:00Z")
      });
      const text = new TextDecoder("latin1").decode(await blob.arrayBuffer());
      assert(text.includes("/Type /Annot /Subtype /3D"), "page should contain a PDF 3D annotation");
      assert(text.includes("/3DD 7 0 R"), "annotation should reference the 3D data stream");
      assert(text.includes("/Type /3D /Subtype /U3D"), "3D stream subtype should match the supplied payload");
      assert(text.includes("PS3D did not re-encode this model."), "page should disclose pass-through fidelity");
      verifyPdfXref(text, 9);
    }
  }
];

function verifyPdfXref(text: string, objectCount: number): void {
  const match = /startxref\s+(\d+)/.exec(text);
  assert(match?.[1] !== undefined, "startxref should be present");
  const xrefOffset = Number(match[1]);
  assert(text.slice(xrefOffset).startsWith("xref"), "startxref should point to the xref table");
  const entries = [...text.slice(xrefOffset).matchAll(/(\d{10}) 00000 n /g)];
  equal(entries.length, objectCount, "xref should contain one in-use entry per object");
  entries.forEach((entry, index) => {
    const offset = Number(entry[1]);
    assert(text.slice(offset).startsWith(`${index + 1} 0 obj`), `xref entry ${index + 1} should point to its object`);
  });
  assert(text.trimEnd().endsWith("%%EOF"), "PDF should end with the EOF marker");
}
