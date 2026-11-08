import { failure, type SketchUnderlay, type Vec2, type WorkbenchResult } from "../../workbench-core/src/index.js";
import type { SketchEditPlan } from "./edit-tools.js";

/**
 * Image underlay for tracing: a PNG or JPEG shown behind the sketch, locked so it cannot be picked or dragged, with a scale that is
 * calibrated by two points the user clicks and the real distance between them, and an opacity. Only the placement lives in the sketch
 * (`WorkbenchSketch.underlay`); the picture itself is read from a local file and kept by the application under `imageId`. Nothing is
 * fetched from the network.
 */

export const UNDERLAY_MAX_BYTES = 8 * 1024 * 1024;
export const UNDERLAY_MAX_PIXELS = 16_384;

export interface ImageInfo {
  readonly format: "png" | "jpeg";
  readonly widthPx: number;
  readonly heightPx: number;
}

const bad = (message: string, recovery = "Choose a PNG or JPEG picture."): WorkbenchResult<never> => failure("INVALID_OPERATION", message, [], recovery);

/** Reads the type and pixel size of a PNG or JPEG from its first bytes, without decoding it. */
export function readImageInfo(bytes: Uint8Array): WorkbenchResult<ImageInfo> {
  if (bytes.length > UNDERLAY_MAX_BYTES) return bad(`The picture is ${(bytes.length / (1024 * 1024)).toFixed(1)} MB; the limit is ${UNDERLAY_MAX_BYTES / (1024 * 1024)} MB.`, "Reduce the picture's size or resolution first.");
  if (bytes.length < 24) return bad("The file is too small to be a picture.");
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a;
  if (isPng) {
    const type = String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!);
    if (type !== "IHDR") return bad("The PNG is damaged: its header block is missing.");
    const width = ((bytes[16]! << 24) | (bytes[17]! << 16) | (bytes[18]! << 8) | bytes[19]!) >>> 0;
    const height = ((bytes[20]! << 24) | (bytes[21]! << 16) | (bytes[22]! << 8) | bytes[23]!) >>> 0;
    return sizeOk("png", width, height);
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue; }
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) { offset += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) {
        const height = (bytes[offset + 5]! << 8) | bytes[offset + 6]!;
        const width = (bytes[offset + 7]! << 8) | bytes[offset + 8]!;
        return sizeOk("jpeg", width, height);
      }
      if (length < 2) break;
      offset += 2 + length;
    }
    return bad("The JPEG is damaged: no size information was found.");
  }
  return bad("This is not a PNG or JPEG picture (the first bytes do not match either format).", "Convert the picture to PNG or JPEG and try again.");
}

function sizeOk(format: "png" | "jpeg", width: number, height: number): WorkbenchResult<ImageInfo> {
  if (!(width >= 1 && height >= 1)) return bad("The picture has no pixels.");
  if (width > UNDERLAY_MAX_PIXELS || height > UNDERLAY_MAX_PIXELS) return bad(`The picture is ${width} x ${height} pixels; the limit is ${UNDERLAY_MAX_PIXELS} x ${UNDERLAY_MAX_PIXELS}.`, "Reduce the picture's resolution first.");
  return { ok: true, value: { format, widthPx: width, heightPx: height } };
}

/** A stable name for a picture's bytes (a hash of the content plus the length), used as its key in the image store. */
export function imageIdOf(bytes: Uint8Array): string {
  let high = 0x811c9dc5;
  let low = 0x01000193 ^ bytes.length;
  for (let index = 0; index < bytes.length; index += 1) {
    high = Math.imul(high ^ bytes[index]!, 0x01000193) >>> 0;
    low = Math.imul(low ^ ((bytes[index]! + index) & 0xff), 0x85ebca6b) >>> 0;
  }
  return `img-${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}-${bytes.length.toString(16)}`;
}

/** A new underlay, centred on the origin and sized to about `targetWidthMm` across until it is calibrated. */
export function createUnderlay(info: ImageInfo, imageId: string, name: string, targetWidthMm = 200): SketchUnderlay {
  const mmPerPixel = Math.min(1000, Math.max(1e-4, targetWidthMm / info.widthPx));
  return {
    name: name.replace(/[\u0000-\u001f]/gu, "").slice(0, 120) || "Picture",
    imageId,
    widthPx: info.widthPx,
    heightPx: info.heightPx,
    originMm: [-(info.widthPx * mmPerPixel) / 2, -(info.heightPx * mmPerPixel) / 2],
    mmPerPixel,
    rotationDeg: 0,
    opacity: 0.5,
    locked: true,
    visible: true
  };
}

/** The four corners of the picture in the sketch (lower left, lower right, upper right, upper left). */
export function underlayCorners(underlay: SketchUnderlay): readonly [Vec2, Vec2, Vec2, Vec2] {
  const width = underlay.widthPx * underlay.mmPerPixel;
  const height = underlay.heightPx * underlay.mmPerPixel;
  const radians = (underlay.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const at = (x: number, y: number): Vec2 => [underlay.originMm[0] + x * cos - y * sin, underlay.originMm[1] + x * sin + y * cos];
  return [at(0, 0), at(width, 0), at(width, height), at(0, height)];
}

/** Maps a pixel of the picture (x right, y down from its top left) to the sketch. */
export function underlayPixelToSketch(underlay: SketchUnderlay, pixel: Vec2): Vec2 {
  const radians = (underlay.rotationDeg * Math.PI) / 180;
  const x = pixel[0] * underlay.mmPerPixel;
  const y = (underlay.heightPx - pixel[1]) * underlay.mmPerPixel;
  return [underlay.originMm[0] + x * Math.cos(radians) - y * Math.sin(radians), underlay.originMm[1] + x * Math.sin(radians) + y * Math.cos(radians)];
}

/**
 * Calibrates the scale: `a` and `b` are two points clicked in the sketch on features of the picture whose real distance is
 * `knownMm`. The picture is scaled about `a`, so `a` stays where it was clicked.
 */
export function calibrateUnderlay(underlay: SketchUnderlay, a: Vec2, b: Vec2, knownMm: number): WorkbenchResult<SketchUnderlay> {
  if (![...a, ...b].every(Number.isFinite)) return bad("The two points are not valid.", "Click the two points again.");
  if (!Number.isFinite(knownMm) || knownMm < 0.01 || knownMm > 100_000) return bad("Enter the real distance between the two points, between 0.01 mm and 100000 mm.", "Type the distance in millimetres.");
  const clicked = Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (clicked < 0.01) return bad("The two points are on top of each other.", "Click two points that are far apart on the picture.");
  const factor = knownMm / clicked;
  const mmPerPixel = underlay.mmPerPixel * factor;
  if (mmPerPixel < 1e-4 || mmPerPixel > 1000) return bad(`That would make one pixel ${mmPerPixel.toPrecision(3)} mm, outside 0.0001 to 1000 mm.`, "Check the distance and the two points.");
  const origin: Vec2 = [a[0] + (underlay.originMm[0] - a[0]) * factor, a[1] + (underlay.originMm[1] - a[1]) * factor];
  if (Math.abs(origin[0]) > 100_000 || Math.abs(origin[1]) > 100_000) return bad("The calibrated picture would sit too far from the origin.", "Pick points closer to the origin or a smaller distance.");
  return { ok: true, value: { ...underlay, mmPerPixel, originMm: origin } };
}

/** Moves the picture by a distance. */
export function moveUnderlay(underlay: SketchUnderlay, dxMm: number, dyMm: number): WorkbenchResult<SketchUnderlay> {
  if (!Number.isFinite(dxMm) || !Number.isFinite(dyMm)) return bad("The move distance must be a number.");
  const origin: Vec2 = [underlay.originMm[0] + dxMm, underlay.originMm[1] + dyMm];
  if (Math.abs(origin[0]) > 100_000 || Math.abs(origin[1]) > 100_000) return bad("The picture would move too far from the origin.");
  return { ok: true, value: { ...underlay, originMm: origin } };
}

/** Turns the picture about the point `about` (default its own origin corner). */
export function rotateUnderlay(underlay: SketchUnderlay, degrees: number, about: Vec2 = underlay.originMm): WorkbenchResult<SketchUnderlay> {
  if (!Number.isFinite(degrees) || !about.every(Number.isFinite)) return bad("The angle must be a number.");
  const radians = (degrees * Math.PI) / 180;
  const dx = underlay.originMm[0] - about[0];
  const dy = underlay.originMm[1] - about[1];
  const origin: Vec2 = [about[0] + dx * Math.cos(radians) - dy * Math.sin(radians), about[1] + dx * Math.sin(radians) + dy * Math.cos(radians)];
  const wrapped = (((underlay.rotationDeg + degrees) % 360) + 360) % 360;
  return { ok: true, value: { ...underlay, originMm: origin, rotationDeg: wrapped > 180 ? wrapped - 360 : wrapped } };
}

/** Sets the opacity (0.05 to 1). */
export function setUnderlayOpacity(underlay: SketchUnderlay, opacity: number): WorkbenchResult<SketchUnderlay> {
  if (!Number.isFinite(opacity)) return bad("The opacity must be a number.");
  return { ok: true, value: { ...underlay, opacity: Math.min(1, Math.max(0.05, opacity)) } };
}

/** An edit plan that sets, changes or removes the sketch's underlay. */
export function planUnderlay(underlay: SketchUnderlay | null, label: string): SketchEditPlan {
  return { label: label.slice(0, 80), removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], objects: { underlay } };
}

/** The picture store the application provides (browser storage); tests use `createMemoryImageStore`. */
export interface ImageStore {
  put(imageId: string, bytes: Uint8Array, mime: string): Promise<void>;
  get(imageId: string): Promise<{ readonly bytes: Uint8Array; readonly mime: string } | undefined>;
  remove(imageId: string): Promise<void>;
}

export function createMemoryImageStore(): ImageStore {
  const items = new Map<string, { readonly bytes: Uint8Array; readonly mime: string }>();
  return {
    put: (imageId, bytes, mime) => { items.set(imageId, { bytes: new Uint8Array(bytes), mime }); return Promise.resolve(); },
    get: (imageId) => Promise.resolve(items.get(imageId)),
    remove: (imageId) => { items.delete(imageId); return Promise.resolve(); }
  };
}
