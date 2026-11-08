import type { SketchUnderlay, Vec2, WorkbenchOperation, WorkbenchProject } from "../packages/workbench-core/src/index.js";
import { applyWorkbenchOperation, createWorkbenchProject, validateWorkbenchProject } from "../packages/workbench-core/src/index.js";
import type { SketchEditPlan } from "../packages/workbench-sketch/src/edit-tools.js";
import { calibrateUnderlay, createMemoryImageStore, createUnderlay, imageIdOf, moveUnderlay, planUnderlay, readImageInfo, rotateUnderlay, setUnderlayOpacity, UNDERLAY_MAX_BYTES, underlayCorners, underlayPixelToSketch } from "../packages/workbench-sketch/src/underlay.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

let counter = 0;

function emptyProject(): WorkbenchProject {
  const base = createWorkbenchProject("project:test-underlay");
  return { ...base, sketch: { ...base.sketch, entities: [], constraints: [] } };
}

function must<T>(result: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly diagnostics: readonly { readonly message: string }[] }): T {
  if (!result.ok) throw new Error(`expected success but got: ${result.diagnostics[0]?.message ?? "no message"}`);
  return result.value;
}

function messageOf(result: { readonly ok: boolean; readonly diagnostics?: readonly { readonly message: string }[] }): string {
  return result.ok ? "" : result.diagnostics?.[0]?.message ?? "";
}

function applyPlan(project: WorkbenchProject, plan: SketchEditPlan): WorkbenchProject {
  const applied = applyWorkbenchOperation(project, { kind: "apply-sketch-edit", operationId: `operation:underlay-${(counter += 1)}`, expectedRevision: project.revision, ...plan } as WorkbenchOperation);
  if (!applied.ok) throw new Error(`the sketch edit was refused: ${applied.diagnostics[0]?.message ?? "no reason"}`);
  const again = validateWorkbenchProject(JSON.parse(JSON.stringify(applied.value.project)) as unknown);
  if (!again.ok) throw new Error(`the project no longer validates: ${again.diagnostics[0]?.message ?? "no reason"}`);
  return again.value;
}

function png(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function jpeg(width: number, height: number): Uint8Array {
  // SOI, an APP0 segment, then SOF0 with the size.
  const bytes = new Uint8Array(40);
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  bytes.set([0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03], 20);
  return bytes;
}

const INFO = { format: "png" as const, widthPx: 800, heightPx: 600 };

export const sketchUnderlayTests: readonly TestCase[] = [
  {
    name: "underlay: PNG and JPEG sizes are read from the header, and other or damaged files are refused with the reason",
    run: () => {
      const a = must(readImageInfo(png(1280, 720)));
      equal(a.format, "png", "png"); equal(a.widthPx, 1280, "width"); equal(a.heightPx, 720, "height");
      const b = must(readImageInfo(jpeg(640, 480)));
      equal(b.format, "jpeg", "jpeg"); equal(b.widthPx, 640, "jpeg width"); equal(b.heightPx, 480, "jpeg height");
      const gif = new Uint8Array(40); gif.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
      assert(messageOf(readImageInfo(gif)).includes("not a PNG or JPEG"), "a GIF is named as unsupported");
      assert(messageOf(readImageInfo(new Uint8Array(5))).includes("too small"), "a tiny file");
      assert(messageOf(readImageInfo(new Uint8Array(UNDERLAY_MAX_BYTES + 1))).includes("limit"), "an over-large file names the limit");
      assert(messageOf(readImageInfo(png(20000, 100))).includes("16384"), "a huge picture names the pixel limit");
      assert(messageOf(readImageInfo(png(0, 100))).includes("no pixels"), "an empty picture");
      const broken = png(10, 10); broken[12] = 0x58;
      assert(messageOf(readImageInfo(broken)).includes("damaged"), "a PNG without IHDR");
      const noFrame = jpeg(10, 10); noFrame[20] = 0x00; noFrame[21] = 0x00;
      assert(messageOf(readImageInfo(noFrame)).includes("damaged"), "a JPEG without a frame header");
      assert(imageIdOf(png(1, 1)) !== imageIdOf(png(1, 2)) && imageIdOf(png(5, 5)) === imageIdOf(png(5, 5)), "the image id depends on the content and is stable");
      assert(/^img-[0-9a-f]+-[0-9a-f]+$/u.test(imageIdOf(png(5, 5))), "and has the stored form");
    }
  },
  {
    name: "underlay: a new picture is locked, half transparent, centred and sized until it is calibrated",
    run: () => {
      const underlay = createUnderlay(INFO, imageIdOf(png(800, 600)), "front view.png");
      equal(underlay.locked, true, "locked"); equal(underlay.visible, true, "visible"); equal(underlay.opacity, 0.5, "half transparent");
      near(underlay.widthPx * underlay.mmPerPixel, 200, 1e-9, "about 200 mm across");
      const [a, , c] = underlayCorners(underlay);
      near((a[0] + c[0]) / 2, 0, 1e-9, "centred (x)"); near((a[1] + c[1]) / 2, 0, 1e-9, "centred (y)");
      equal(createUnderlay(INFO, "img-aaaa", "bad\u0001name\n").name, "badname", "control characters are removed from the name");
    }
  },
  {
    name: "underlay calibration: two clicked points and a known distance set the scale, keeping the first point where it was clicked",
    run: () => {
      const underlay = createUnderlay(INFO, imageIdOf(png(800, 600)), "part.png");
      // Two features of the picture, 200 px apart horizontally, the left one at pixel (100, 300).
      const featureA = underlayPixelToSketch(underlay, [100, 300]);
      const featureB = underlayPixelToSketch(underlay, [300, 300]);
      const clicked = Math.hypot(featureB[0] - featureA[0], featureB[1] - featureA[1]);
      near(clicked, 200 * underlay.mmPerPixel, 1e-9, "the clicked distance is 200 pixels at the starting scale");
      const calibrated = must(calibrateUnderlay(underlay, featureA, featureB, 80));
      near(calibrated.mmPerPixel, 0.4, 1e-12, "80 mm over 200 pixels is 0.4 mm per pixel");
      const movedA = underlayPixelToSketch(calibrated, [100, 300]);
      const movedB = underlayPixelToSketch(calibrated, [300, 300]);
      near(movedA[0], featureA[0], 1e-9, "the first point stays where it was clicked (x)"); near(movedA[1], featureA[1], 1e-9, "(y)");
      near(Math.hypot(movedB[0] - movedA[0], movedB[1] - movedA[1]), 80, 1e-9, "and the two features are now 80 mm apart");
      // A diagonal pair works the same way.
      const diagonal = must(calibrateUnderlay(underlay, [0, 0], [30, 40], 100));
      near(diagonal.mmPerPixel, underlay.mmPerPixel * 2, 1e-12, "50 mm clicked for 100 mm real doubles the scale");
      assert(!calibrateUnderlay(underlay, [1, 1], [1, 1], 10).ok, "two identical points are refused");
      assert(messageOf(calibrateUnderlay(underlay, [0, 0], [10, 0], 0)).includes("real distance"), "a zero distance asks for the real distance");
      assert(!calibrateUnderlay(underlay, [0, 0], [10, 0], Number.NaN).ok, "NaN distance");
      assert(!calibrateUnderlay(underlay, [Number.NaN, 0], [10, 0], 5).ok, "NaN point");
      assert(messageOf(calibrateUnderlay(underlay, [0, 0], [0.011, 0], 100000)).includes("pixel"), "an absurd scale names the pixel size");
    }
  },
  {
    name: "underlay: move, rotate and opacity keep the picture valid; corners follow the rotation",
    run: () => {
      const underlay = createUnderlay({ format: "png", widthPx: 100, heightPx: 50 }, "img-abcdef01", "p.png", 100);
      const moved = must(moveUnderlay(underlay, 10, -5));
      near(moved.originMm[0], underlay.originMm[0] + 10, 1e-9, "moved x");
      assert(!moveUnderlay(underlay, Number.NaN, 0).ok && !moveUnderlay(underlay, 1e9, 0).ok, "NaN and absurd moves are refused");
      const turned = must(rotateUnderlay({ ...underlay, originMm: [0, 0] }, 90, [0, 0]));
      near(turned.rotationDeg, 90, 1e-9, "rotation stored");
      const corners = underlayCorners(turned);
      near(corners[1][0], 0, 1e-9, "after 90 degrees the lower right corner is straight above the origin (x)"); near(corners[1][1], 100, 1e-9, "(y)");
      equal(must(setUnderlayOpacity(underlay, 5)).opacity, 1, "opacity is capped at 1"); equal(must(setUnderlayOpacity(underlay, 0)).opacity, 0.05, "and kept visible at the low end");
      assert(!setUnderlayOpacity(underlay, Number.NaN).ok, "NaN opacity");
    }
  },
  {
    name: "underlay: stored in the sketch through apply-sketch-edit, survives a JSON round trip, commit and reopen, and a new sketch starts without it",
    run: () => {
      const underlay = createUnderlay(INFO, imageIdOf(png(800, 600)), "tracing.png");
      const project = applyPlan(emptyProject(), planUnderlay(underlay, "Added a tracing picture"));
      equal(project.sketch.underlay?.imageId, underlay.imageId, "the underlay is on the sketch");
      equal(project.sketch.entities.length, 0, "it adds no curves, so it can never form a profile");
      const calibrated = must(calibrateUnderlay(project.sketch.underlay!, [0, 0], [100, 0], 50));
      const next = applyPlan(project, planUnderlay(calibrated, "Calibrated"));
      near(next.sketch.underlay!.mmPerPixel, calibrated.mmPerPixel, 1e-12, "the calibration is stored");
      const committed = applyWorkbenchOperation(next, { kind: "commit-design-sketch", operationId: "operation:underlay-commit", expectedRevision: next.revision, featureId: "feature:sketch-trace", name: "Trace" });
      // An empty sketch cannot be finished; give it one curve first.
      assert(!committed.ok, "an empty sketch cannot be finished (the picture alone is not geometry)");
      const withLine = applyPlan(next, { label: "Traced a line", removeEntityIds: [], updateEntities: [], addEntities: [{ id: "entity:trace-line", kind: "line", start: [0, 0], end: [10, 0], construction: false }], addConstraints: [] });
      const done = applyWorkbenchOperation(withLine, { kind: "commit-design-sketch", operationId: "operation:underlay-commit2", expectedRevision: withLine.revision, featureId: "feature:sketch-trace", name: "Trace" });
      assert(done.ok, "with geometry it finishes");
      if (!done.ok) return;
      const fresh = applyWorkbenchOperation(done.value.project, { kind: "new-design-sketch", operationId: "operation:underlay-new", expectedRevision: done.value.project.revision, plane: "datum:xy" });
      assert(fresh.ok && fresh.value.project.sketch.underlay === undefined, "a new sketch has no picture");
      if (!fresh.ok) return;
      const reopened = applyWorkbenchOperation(fresh.value.project, { kind: "edit-design-sketch", operationId: "operation:underlay-edit", expectedRevision: fresh.value.project.revision, featureId: "feature:sketch-trace" });
      assert(reopened.ok && reopened.value.project.sketch.underlay?.imageId === underlay.imageId, "reopening the sketch brings the picture back");
      const removed = applyPlan(next, planUnderlay(null, "Removed the picture"));
      equal(removed.sketch.underlay, undefined, "null removes it");
    }
  },
  {
    name: "underlay: bad records are refused by validation (zero scale, opacity out of range, odd ids, extra keys)",
    run: () => {
      const underlay = createUnderlay(INFO, imageIdOf(png(800, 600)), "tracing.png");
      const attempt = (patch: Record<string, unknown>) => validateWorkbenchProject({ ...emptyProject(), sketch: { ...emptyProject().sketch, underlay: { ...underlay, ...patch } } });
      assert(attempt({}).ok, "the unchanged record passes");
      assert(!attempt({ mmPerPixel: 0 }).ok, "zero scale"); assert(!attempt({ mmPerPixel: 5000 }).ok, "huge scale");
      assert(!attempt({ opacity: 0 }).ok, "invisible opacity"); assert(!attempt({ opacity: 1.5 }).ok, "opacity over 1");
      assert(!attempt({ imageId: "../../etc/passwd" }).ok, "an image id that is a path");
      assert(!attempt({ widthPx: 0 }).ok, "zero width"); assert(!attempt({ widthPx: 1.5 }).ok, "fractional width");
      assert(!attempt({ originMm: [Number.NaN, 0] }).ok, "NaN origin");
      assert(!attempt({ source: "http://example.com/x.png" }).ok, "an extra key (no URL can be smuggled in)");
      assert(!attempt({ locked: "yes" }).ok, "a non-boolean flag");
      const viaOperation = applyWorkbenchOperation(emptyProject(), { kind: "apply-sketch-edit", operationId: "operation:underlay-bad", expectedRevision: 0, removeEntityIds: [], updateEntities: [], addEntities: [], addConstraints: [], label: "bad", objects: { underlay: { ...underlay, opacity: 7 } } } as WorkbenchOperation);
      assert(!viaOperation.ok, "an operation with a bad underlay is refused, not thrown");
    }
  },
  {
    name: "underlay: the image store keeps bytes under the image id and forgets them on request",
    run: async () => {
      const store = createMemoryImageStore();
      const bytes = png(40, 30);
      const id = imageIdOf(bytes);
      equal(await store.get(id), undefined, "nothing before");
      await store.put(id, bytes, "image/png");
      const back = await store.get(id);
      assert(back !== undefined && back.mime === "image/png" && back.bytes.length === bytes.length && back.bytes !== bytes, "stored as a copy");
      await store.remove(id);
      equal(await store.get(id), undefined, "gone after remove");
    }
  }
];

export type { SketchUnderlay, Vec2 };
