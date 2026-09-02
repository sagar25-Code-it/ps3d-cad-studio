import assert from "node:assert/strict";
import {
  authorizeExchangeJob,
  canonicalRenderExchangeJson,
  createExchangeContentReceipt,
  createRenderProductReceipt,
  renderExchangeSha256,
  renderSourceManifest,
  unsupportedProprietaryFormatDiagnostics,
  validateExchangeContentReceipt,
  validateExchangeJob,
  validateRenderProductReceipt,
  validateRenderRequest,
  validateRenderScene,
  validateTransferReport,
  type RenderScene
} from "../src/index.js";
import {
  DIGEST_A,
  DIGEST_C,
  content,
  nativeNxImportJob,
  pathTraceRequest,
  scene,
  stepExportJob,
  successfulStepReport,
  translatorManifest
} from "./fixtures.js";

export interface TestCase {
  readonly name: string;
  readonly run: () => void | Promise<void>;
}

export const renderExchangeTests: readonly TestCase[] = [{
  name: "render scene keeps engineering materials separate and consumes exact-model derivatives",
  run: () => {
    const value = scene();
    assert.deepEqual(validateRenderScene(value), []);
    assert.equal("density" in value.appearances[0]!, false);
    assert.equal("metallic" in value.physicalMaterials[0]!, false);
    assert.deepEqual(renderSourceManifest(value), {
      exactDocumentId: "document:fixture",
      exactDocumentRevision: 8,
      exactDocumentDigest: DIGEST_A,
      tessellations: [{
        tessellationId: "tessellation:body-1",
        sourceExactShapeDigest: value.tessellations[0]!.sourceExactShapeDigest,
        tessellationDigest: value.tessellations[0]!.tessellationDigest,
        topologyBindingDigest: value.tessellations[0]!.topologyBindingDigest
      }]
    });
  }
}, {
  name: "render validation rejects stale tessellation and embedded editable geometry",
  run: () => {
    const stale = scene();
    const unsafe = {
      ...stale,
      tessellations: [{ ...stale.tessellations[0]!, sourceDocumentRevision: 7, vertices: [0, 1, 2] }]
    } as unknown as RenderScene;
    const diagnostics = validateRenderScene(unsafe);
    assert.ok(diagnostics.some((item) => item.code === "TESSELLATION_REVISION_MISMATCH"));
    assert.ok(diagnostics.some((item) => item.code === "EXACT_SOURCE_REQUIRED" && item.path.endsWith(".vertices")));
  }
}, {
  name: "path trace request and content-addressed asset URI policy are enforced",
  run: () => {
    assert.deepEqual(validateRenderRequest(pathTraceRequest()), []);
    const invalid = pathTraceRequest();
    const changed = {
      ...invalid,
      samplesPerPixel: 0,
      scene: {
        ...invalid.scene,
        textures: [{ ...invalid.scene.textures[0]!, content: content("file:///private/texture.png", DIGEST_C, "image/png") }]
      }
    };
    const diagnostics = validateRenderRequest(changed);
    assert.ok(diagnostics.some((item) => item.path === "request.samplesPerPixel"));
    assert.ok(diagnostics.some((item) => item.code === "ASSET_SCHEME_DENIED"));
  }
}, {
  name: "render receipts are deterministic and tamper evident",
  run: async () => {
    const request = pathTraceRequest();
    const renderer = { implementation: "reference-renderer", version: "1.0.0", buildDigest: DIGEST_A } as const;
    const output = content("asset:renders/hero", DIGEST_C, "image/png");
    const first = await createRenderProductReceipt(request, renderer, output, true);
    const second = await createRenderProductReceipt(request, renderer, output, true);
    assert.deepEqual(first, second);
    assert.deepEqual(await validateRenderProductReceipt(request, first), []);
    const tampered = { ...first, output: { ...first.output, byteLength: first.output.byteLength + 1 } };
    assert.ok((await validateRenderProductReceipt(request, tampered)).some((item) => item.code === "RECEIPT_MISMATCH"));
  }
}, {
  name: "open exchange validates explicit formats and translator preservation capability",
  run: () => {
    const job = stepExportJob();
    assert.deepEqual(validateExchangeJob(job), []);
    const authorization = authorizeExchangeJob(job, translatorManifest(false));
    assert.equal(authorization.authorized, true);
    assert.equal(authorization.capability?.format, "step");
  }
}, {
  name: "native CAD jobs remain blocked until a licensed translator entitlement is active",
  run: () => {
    const job = nativeNxImportJob();
    const denied = authorizeExchangeJob(job, translatorManifest(false));
    assert.equal(denied.authorized, false);
    assert.ok(denied.diagnostics.some((item) => item.code === "LICENSE_ENTITLEMENT_MISSING"));
    const allowed = authorizeExchangeJob(job, translatorManifest(true));
    assert.equal(allowed.authorized, true);
    assert.equal(unsupportedProprietaryFormatDiagnostics("solidworks")[0]?.code, "LICENSED_TRANSLATOR_REQUIRED");
  }
}, {
  name: "exchange reports disclose preservation and bind deterministic content receipts",
  run: async () => {
    const job = stepExportJob();
    const report = successfulStepReport();
    assert.deepEqual(validateTransferReport(job, report), []);
    const first = await createExchangeContentReceipt(job, report);
    const second = await createExchangeContentReceipt(job, report);
    assert.deepEqual(first, second);
    assert.deepEqual(await validateExchangeContentReceipt(job, report, first), []);
    const lossy = {
      ...report,
      preservation: { ...report.preservation, assemblyStructure: "flattened" as const }
    };
    assert.ok(validateTransferReport(job, lossy).some((item) => item.code === "TRANSFER_LOSS" && item.severity === "error"));
  }
}, {
  name: "canonical hashing is independent of object key insertion order",
  run: async () => {
    assert.equal(canonicalRenderExchangeJson({ b: 2, a: 1 }), canonicalRenderExchangeJson({ a: 1, b: 2 }));
    assert.equal(await renderExchangeSha256({ b: 2, a: 1 }), await renderExchangeSha256({ a: 1, b: 2 }));
  }
}];
