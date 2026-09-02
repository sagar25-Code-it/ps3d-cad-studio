import { kernelSha256 } from "../../exact-kernel-api/src/index.js";
import type { DrawingDocument, ViewId } from "./types.js";

export interface DrawingUpdateReceipt {
  readonly drawingId: string;
  readonly drawingRevision: number;
  readonly modelDocumentId: string;
  readonly modelRevision: number;
  readonly updatedViewIds: readonly ViewId[];
  readonly drawingDigest: string;
  readonly receiptDigest: string;
}

export async function createDrawingUpdateReceipt(document: DrawingDocument, updatedViewIds: readonly ViewId[]): Promise<DrawingUpdateReceipt> {
  const drawingDigest = await kernelSha256(document);
  const content = {
    drawingId: document.id,
    drawingRevision: document.revision,
    modelDocumentId: document.modelDocumentId,
    modelRevision: document.modelRevision,
    updatedViewIds: [...updatedViewIds].sort(),
    drawingDigest
  };
  return { ...content, receiptDigest: await kernelSha256(content) };
}
