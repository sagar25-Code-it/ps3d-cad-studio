import assert from "node:assert/strict";
import test from "node:test";
import { createDrawingUpdateReceipt, invalidateDrawing, validateDrawing, type DrawingDocument, type DrawingView } from "../src/index.js";

const base: DrawingView = {
  id: "view:base",
  sheetId: "sheet:1",
  kind: "base",
  sourceEntityIds: ["body:plate"],
  sourceTopologyKeys: ["face:top"],
  camera: { direction: [0, 0, -1], up: [0, 1, 0], targetMeters: [0, 0, 0] },
  position: { xMeters: 0.1, yMeters: 0.1 },
  scale: 1,
  hiddenLines: "removed",
  tangentEdges: "full",
  state: "current",
  sourceModelRevision: 4,
  projectedGeometryDigest: "a".repeat(64),
  diagnostics: []
};

const projected: DrawingView = {
  ...base,
  id: "view:projected",
  kind: "projected",
  parentViewId: "view:base",
  sourceTopologyKeys: [],
  position: { xMeters: 0.2, yMeters: 0.1 }
};

function document(): DrawingDocument {
  return {
    schemaVersion: 1,
    id: "drawing:plate",
    name: "Plate",
    modelDocumentId: "document:plate",
    modelRevision: 4,
    standard: "iso",
    projection: "first-angle",
    sheets: {
      "sheet:1": { id: "sheet:1", name: "Sheet 1", widthMeters: 0.297, heightMeters: 0.21, viewIds: ["view:base", "view:projected"], annotationIds: ["annotation:width"] }
    },
    views: { "view:base": base, "view:projected": projected },
    annotations: {
      "annotation:width": {
        id: "annotation:width",
        sheetId: "sheet:1",
        value: {
          kind: "dimension",
          dimensionType: "linear",
          method: "single",
          associations: [{ viewId: "view:base", modelEntityId: "body:plate", projectedEntityIds: ["curve:1"] }],
          nominalValue: 0.1
        },
        position: { xMeters: 0.1, yMeters: 0.03 },
        state: "current",
        diagnostics: []
      }
    },
    revision: 2
  };
}

test("invalidates a source view, derived view and associative dimension", () => {
  const result = invalidateDrawing(document(), {
    fromModelRevision: 4,
    toModelRevision: 5,
    changedEntityIds: ["body:plate"],
    changedTopologyKeys: []
  });
  assert.deepEqual(result.invalidatedViewIds, ["view:base", "view:projected"]);
  assert.deepEqual(result.invalidatedAnnotationIds, ["annotation:width"]);
  assert.equal(result.document.views["view:base"]?.state, "stale");
  assert.equal(result.document.annotations["annotation:width"]?.state, "stale");
});

test("rejects an out-of-order model change without mutating the drawing", () => {
  const source = document();
  const result = invalidateDrawing(source, { fromModelRevision: 3, toModelRevision: 5, changedEntityIds: [], changedTopologyKeys: [] });
  assert.equal(result.document, source);
  assert.equal(result.diagnostics[0]?.code, "STALE_MODEL_REVISION");
});

test("validates and produces deterministic update receipts", async () => {
  const source = document();
  assert.deepEqual(validateDrawing(source), []);
  const first = await createDrawingUpdateReceipt(source, ["view:projected", "view:base"]);
  const second = await createDrawingUpdateReceipt(source, ["view:base", "view:projected"]);
  assert.equal(first.receiptDigest, second.receiptDigest);
  assert.match(first.receiptDigest, /^[a-f0-9]{64}$/u);
});
