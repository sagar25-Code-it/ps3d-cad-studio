import { readFileSync } from "node:fs";
import {
  BUILD_POLL_INTERVAL_MS,
  INITIAL_BANNER_STATE,
  buildReportText,
  compareBuilds,
  fetchLiveBuild,
  formatBuildLabel,
  parseBuildInfo,
  planReload,
  reduceUpdateBanner,
  shouldCheckOnFocus,
  updateBannerView,
  versionUrl,
  type BuildInfo,
  type UpdateBannerState
} from "../apps/studio-web/src/build-info.js";
import { faultDismissalKey, deriveFaultBrainNotices, isNoticeRelevantToWorkspace, loadDismissedFaults, nextAnnouncement, partitionNoticesByWorkspace, saveDismissedFaults, type FaultBrainNotice } from "../apps/studio-web/src/ui/fault-brain.js";
import { buildWorkbenchMenus, type WorkbenchMenuActions, type WorkbenchMenuState } from "../apps/studio-web/src/ui/menu-model.js";
import { DEFAULT_PALETTE_LAYOUT, SketchPrefStore, coercePref } from "../apps/studio-web/src/workspaces/sketch/sketch-prefs.js";
import { DEFAULT_CURVE_OPTION_FIELDS } from "../apps/studio-web/src/workspaces/SketchCurveOptions.js";
import { RELATIONS_EMPTY_HELP, dimensionModeStatus } from "../apps/studio-web/src/sketch-help-text.js";
import { createWorkbenchProject } from "../packages/workbench-core/src/index.js";
import { buildDesignHealthReport } from "../packages/workbench-health/src/index.js";
import { angleDimensionLayout, dimensionLayout } from "../packages/workbench-sketch/src/dimension-layout.js";
import { formatLength, formatLengthWithUnit, mmToUnit, parseAngleText, parseLengthText, setDimensionLabelUnit, unitToMm, unitWord } from "../packages/workbench-sketch/src/sketch-units.js";
import { assert, equal, near, type TestCase } from "./test-kit.js";

const repoFile = (relative: string): string => readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");

const SHA_A = "3377c34920ab6a089eb7c693ce6040d095a31736";
const SHA_B = "9b309bd1e2f3a4b5c6d7e8f901234567890abcde";

function build(commit: string, builtAt: string, source: BuildInfo["source"] = "vercel"): BuildInfo {
  return { schema: "ps3d-build-info-v1", version: "0.2.0-preview.1", commit, commitShort: commit === "dev" ? "dev" : commit.slice(0, 7), builtAt, source };
}

class FakeStorage {
  readonly values = new Map<string, string>();
  throwOnSet = false;
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void {
    if (this.throwOnSet) throw new Error("QuotaExceededError");
    this.values.set(key, value);
  }
}

function notice(id: string, severity: "warning" | "error", workspace?: FaultBrainNotice["workspace"]): FaultBrainNotice {
  return { id, source: "design-health", severity, title: id, message: id, recovery: "", ...(workspace === undefined ? {} : { workspace }) };
}

export const sketchChromeAppTests: TestCase[] = [
  {
    name: "Sketch units E18: lengths convert to and from the display unit, and a typed unit suffix wins over it",
    run: () => {
      near(mmToUnit(25.4, "in"), 1, 1e-12, "25.4 mm is one inch");
      near(unitToMm(2, "in"), 50.8, 1e-12, "two inches");
      equal(formatLength(25.4, "in"), "1", "trailing zeros are dropped");
      equal(formatLength(12.7, "in"), "0.5", "half an inch");
      equal(formatLength(12.34567, "mm"), "12.346", "millimetres keep three decimals");
      equal(formatLengthWithUnit(50.8, "in"), "2 in", "with the unit symbol");
      equal(unitWord("in"), "inches", "the accessible name says inches");
      near(parseLengthText("12", "mm")!, 12, 1e-12, "a bare number is in the display unit (mm)");
      near(parseLengthText("12", "in")!, 304.8, 1e-9, "a bare number is in the display unit (in)");
      near(parseLengthText("0,5 in", "mm")!, 12.7, 1e-9, "a comma decimal and an inch suffix over a metric display unit");
      near(parseLengthText('2"', "mm")!, 50.8, 1e-9, "a double quote means inches");
      near(parseLengthText("25.4mm", "in")!, 25.4, 1e-9, "a millimetre suffix over an inch display unit");
      near(parseLengthText("1.5 cm", "in")!, 15, 1e-9, "centimetres");
      near(parseLengthText("-3", "mm")!, -3, 1e-12, "negative numbers parse (the editor then refuses them with a message)");
      equal(parseLengthText("plate_w / 2", "mm"), undefined, "an expression is left to the expression parser");
      equal(parseLengthText("", "mm"), undefined, "empty text");
      equal(parseLengthText("12 parsecs", "mm"), undefined, "an unknown unit is not guessed");
      equal(parseAngleText("45"), 45, "an angle");
      equal(parseAngleText("90°"), 90, "with a degree sign");
      equal(parseAngleText("12,5 deg"), 12.5, "with a comma and the word");
      equal(parseAngleText("12 mm"), undefined, "a length is not an angle");
    }
  },
  {
    name: "Sketch units E18: driving-dimension text on the canvas follows the display unit, and an angle label stays in degrees",
    run: () => {
      const line = { id: "entity:l", kind: "line" as const, start: [0, 0] as const, end: [25.4, 0] as const, construction: false };
      const second = { id: "entity:m", kind: "line" as const, start: [0, 0] as const, end: [0, 10] as const, construction: false };
      try {
        equal(dimensionLayout(line, "length", 25.4, 0.1)?.label, "25.4", "millimetres by default");
        setDimensionLabelUnit("in");
        equal(dimensionLayout(line, "length", 25.4, 0.1)?.label, "1", "an inch-based sketch reads the line as 1");
        equal(dimensionLayout({ id: "entity:c", kind: "circle", center: [0, 0], radiusMm: 12.7, construction: false }, "radius", 12.7, 0.1)?.label, "Ø1", "a diameter in inches");
        equal(angleDimensionLayout(line, second, 90, 0.1)?.label, "90°", "an angle label is degrees whatever the display unit");
      } finally {
        setDimensionLabelUnit("mm");
      }
      equal(dimensionLayout(line, "length", 25.4, 0.1)?.label, "25.4", "and it can be set back to millimetres");
    }
  },
  {
    name: "Sketch units E18: the dimension editor names its unit (degrees for an angle), is no longer hard-wired to millimetres, and the Sketch palette has a unit switch",
    run: () => {
      const workspace = repoFile("apps/studio-web/src/workspaces/SketchWorkspace.tsx");
      assert(!workspace.includes("aria-label={`${props.label} in millimetres`}"), "the editor's accessible name is no longer always millimetres");
      assert(workspace.includes('unitSymbol={dimensionEdit.dimension === "angle" ? "°" : unit}') && workspace.includes('unitName={dimensionEdit.dimension === "angle" ? "degrees" : unitWord(unit)}'), "an angle is labelled in degrees");
      assert(workspace.includes('aria-label="Sketch display units"'), "the palette can switch the unit without leaving Sketch");
      assert(workspace.includes("parseAngleText(dimensionText)") && workspace.includes("parseLengthText(dimensionText, unit)"), "typed text is read as degrees or as a length in the display unit");
      assert(repoFile("apps/studio-web/src/App.tsx").includes("displayUnit={document.displayUnit}"), "the document's display unit reaches the sketch");
    }
  },
  {
    name: "Version indicator: version.json records are parsed strictly, so an HTML fallback, a 404 body or a tampered record is never taken for a build",
    run: () => {
      const good = build(SHA_A, "2026-11-08T19:12:53.368Z");
      assert(parseBuildInfo(good) !== undefined, "a well-formed record parses");
      equal(parseBuildInfo(build("dev", "2026-11-08T19:12:53.368Z", "dev"))?.commitShort, "dev", "a dev record parses");
      equal(parseBuildInfo(null), undefined, "null");
      equal(parseBuildInfo("<!doctype html>"), undefined, "an HTML string");
      equal(parseBuildInfo({ ...good, schema: "other" }), undefined, "wrong schema");
      equal(parseBuildInfo({ ...good, commit: "not-a-hash" }), undefined, "commit that is not hex");
      equal(parseBuildInfo({ ...good, commitShort: "0000000" }), undefined, "short hash that does not match the commit");
      equal(parseBuildInfo({ ...good, builtAt: "yesterday" }), undefined, "unparseable build time");
      equal(parseBuildInfo({ ...good, source: "cdn" }), undefined, "unknown source");
      equal(formatBuildLabel(good), "Build 3377c34 · 8 Nov 2026", "the footer label is the short hash and the UTC build date");
      const report = buildReportText(good, "https://ps3d.example");
      assert(report.includes(SHA_A) && report.includes("https://ps3d.example") && report.includes("0.2.0-preview.1"), "the copied report carries the full commit, version and origin");
    }
  },
  {
    name: "Version indicator: scripts/build-info.mjs takes the commit from VERCEL_GIT_COMMIT_SHA, else git, else \"dev\"",
    run: async () => {
      const module = await import(new URL("../../scripts/build-info.mjs", import.meta.url).href) as {
        resolveBuildInfo: (options: { env?: Record<string, string | undefined>; now?: Date; git?: () => string | undefined; version?: string }) => BuildInfo;
        BUILD_INFO_SCHEMA: string;
      };
      const now = new Date("2026-11-09T08:30:00.000Z");
      const vercel = module.resolveBuildInfo({ env: { VERCEL_GIT_COMMIT_SHA: SHA_B.toUpperCase() }, now, git: () => SHA_A, version: "1.2.3" });
      equal(vercel.commit, SHA_B, "Vercel's commit wins over local git and is lower-cased");
      equal(vercel.source, "vercel", "source says vercel");
      equal(vercel.commitShort, SHA_B.slice(0, 7), "short hash is seven characters");
      equal(vercel.builtAt, "2026-11-09T08:30:00.000Z", "build time is the injected clock");
      equal(vercel.version, "1.2.3", "version is passed through");
      const git = module.resolveBuildInfo({ env: {}, now, git: () => SHA_A });
      assert(git.commit === SHA_A && git.source === "git", "no Vercel variable: git HEAD");
      const garbage = module.resolveBuildInfo({ env: { VERCEL_GIT_COMMIT_SHA: "main" }, now, git: () => SHA_A });
      equal(garbage.commit, SHA_A, "a Vercel variable that is not a hash is ignored");
      const dev = module.resolveBuildInfo({ env: {}, now, git: () => undefined });
      assert(dev.commit === "dev" && dev.commitShort === "dev" && dev.source === "dev", "no git, no Vercel: \"dev\"");
      for (const record of [vercel, git, dev]) assert(parseBuildInfo(record) !== undefined, "every resolved record is a valid version.json document");
    }
  },
  {
    name: "Version indicator: comparing builds says newer, different, same, or unknown, and a local dev build is never told to reload into production",
    run: () => {
      const old = build(SHA_A, "2026-11-08T10:00:00.000Z");
      const fresh = build(SHA_B, "2026-11-09T10:00:00.000Z");
      equal(compareBuilds(old, fresh), "newer", "a later build time with another commit is newer");
      equal(compareBuilds(fresh, old), "different", "an older live build (a rollback) is different, not newer");
      equal(compareBuilds(old, build(SHA_A, "2026-11-10T00:00:00.000Z")), "same", "same commit is the same build whatever the clock says");
      const dev = build("dev", "2026-11-09T10:00:00.000Z", "dev");
      equal(compareBuilds(dev, fresh), "unknown", "a dev tab cannot be compared with production");
      equal(compareBuilds(old, dev), "unknown", "nor a production tab with a dev server");
      equal(compareBuilds(dev, dev), "same", "dev with dev is simply the same");
    }
  },
  {
    name: "Version indicator: the banner shows for a newer live build, stays through failed checks, can be dismissed for that build only, and returns for the next deploy",
    run: () => {
      const running = build(SHA_A, "2026-11-08T10:00:00.000Z");
      const live = build(SHA_B, "2026-11-09T10:00:00.000Z");
      let state: UpdateBannerState = INITIAL_BANNER_STATE;
      equal(updateBannerView(state, running).visible, false, "nothing is shown before the first check");
      state = reduceUpdateBanner(state, { kind: "checked", live: running, at: 1000 });
      equal(updateBannerView(state, running).visible, false, "an identical live build shows nothing");
      state = reduceUpdateBanner(state, { kind: "checked", live, at: 2000 });
      const shown = updateBannerView(state, running);
      assert(shown.visible, "a newer live build shows the banner");
      equal(shown.message, "A newer version is available (9b309bd)", "the banner text names the live short hash");
      state = reduceUpdateBanner(state, { kind: "checked", live: undefined, at: 3000 });
      assert(updateBannerView(state, running).visible, "a failed check (offline) keeps the banner and the last answer");
      equal(state.lastCheckedAt, 3000, "a failed check still records that it ran");
      state = reduceUpdateBanner(state, { kind: "dismissed" });
      equal(updateBannerView(state, running).visible, false, "dismissing hides the banner");
      state = reduceUpdateBanner(state, { kind: "checked", live, at: 4000 });
      equal(updateBannerView(state, running).visible, false, "the next poll of the same build does not bring it back");
      const next = build("c0ffee0123456789abcdef0123456789abcdef01", "2026-11-10T10:00:00.000Z");
      state = reduceUpdateBanner(state, { kind: "checked", live: next, at: 5000 });
      assert(updateBannerView(state, running).visible, "a further deploy shows the banner again");
      const rolledBack = reduceUpdateBanner(INITIAL_BANNER_STATE, { kind: "checked", live: old(), at: 1 });
      equal(updateBannerView(rolledBack, live).message, "A different version is live (3377c34)", "an older live build is described neutrally");
      const devState = reduceUpdateBanner(INITIAL_BANNER_STATE, { kind: "checked", live, at: 1 });
      equal(updateBannerView(devState, build("dev", "2026-11-09T10:00:00.000Z", "dev")).visible, false, "a dev build never shows the banner");
      function old(): BuildInfo { return build(SHA_A, "2026-11-08T10:00:00.000Z"); }
    }
  },
  {
    name: "Version indicator: polling happens on focus (not more than every 15 s) and every five minutes, with a cache-busting same-origin URL",
    run: () => {
      equal(BUILD_POLL_INTERVAL_MS, 300_000, "five minutes");
      equal(shouldCheckOnFocus(undefined, 10), true, "the first focus checks");
      equal(shouldCheckOnFocus(1_000, 10_000), false, "a focus 9 s after a check does not check again");
      equal(shouldCheckOnFocus(1_000, 16_000), true, "15 s later it does");
      const url = versionUrl(1_700_000_000_123.9);
      equal(url, "/version.json?t=1700000000123", "same-origin path with a cache-busting query");
      assert(!url.startsWith("http"), "no cross-origin URL, so the connect-src 'self' policy holds");
      const policy = JSON.parse(repoFile("vercel.json")) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
      const csp = policy.headers.find((entry) => entry.source === "/(.*)")?.headers.find((header) => header.key === "Content-Security-Policy")?.value ?? "";
      assert(csp.includes("connect-src 'self'"), "the CSP allows same-origin fetches");
      const versionCache = policy.headers.find((entry) => entry.source === "/version.json")?.headers.find((header) => header.key === "Cache-Control")?.value;
      equal(versionCache, "no-store", "vercel.json serves version.json uncached");
      assert(repoFile("scripts/verify-build.mjs").includes("version.json"), "verify-build.mjs knows about version.json");
    }
  },
  {
    name: "Version indicator: fetchLiveBuild asks with no-store, and a 404, an HTML body, bad JSON or a network error all resolve to undefined without throwing",
    run: async () => {
      const live = build(SHA_B, "2026-11-09T10:00:00.000Z");
      const seen: { input: string; cache: string | undefined }[] = [];
      const respond = (ok: boolean, body: () => Promise<unknown>) => async (input: string, init?: { readonly cache?: "no-store" }) => {
        seen.push({ input, cache: init?.cache });
        return { ok, json: body };
      };
      const got = await fetchLiveBuild(respond(true, async () => live), 5000);
      assert(got !== undefined && got.commit === SHA_B, "a good record comes back");
      equal(seen[0]?.input, "/version.json?t=5000", "the request is cache-busted");
      equal(seen[0]?.cache, "no-store", "the request opts out of the HTTP cache");
      equal(await fetchLiveBuild(respond(false, async () => live), 1), undefined, "404");
      equal(await fetchLiveBuild(respond(true, async () => { throw new SyntaxError("Unexpected token <"); }), 1), undefined, "HTML fallback page");
      equal(await fetchLiveBuild(respond(true, async () => ({ hello: "world" })), 1), undefined, "valid JSON that is not a build record");
      equal(await fetchLiveBuild(async () => { throw new TypeError("Failed to fetch"); }, 1), undefined, "offline");
    }
  },
  {
    name: "Version indicator: Reload warns first when the project has unsaved changes, and reloads straight away when it does not",
    run: () => {
      equal(planReload(false, false).action, "reload", "clean project: reload");
      const guarded = planReload(true, false);
      assert(guarded.action === "confirm" && guarded.warning.includes("unsaved"), "dirty project: warn first");
      equal(planReload(true, true).action, "reload", "dirty project, confirmed: reload");
    }
  },
  {
    name: "Version indicator: Help > About lists the build, and the menu item exists only when the app wires it",
    run: () => {
      const calls: string[] = [];
      const noop = (): void => undefined;
      const actions = {
        onUndo: noop, onRedo: noop, onCommandPalette: noop, onNewSketch: () => { calls.push("new-sketch"); }, onCreateSolidFromSketch: noop, onCreatePrimitive: noop,
        onCombine: noop, onInsertToAssembly: noop, onMasterCart: noop, onRenderStudio: noop, onEditSelectedFeature: noop, onChangeParameters: noop,
        onToggleSuppressSelected: noop, onDeleteSelected: noop, onMoveSelectedBody: noop, onResizeSelectedBody: noop, onModifyGeneralBody: noop, onPattern: noop,
        onFit: noop, onHome: noop, onToggleGrid: noop, onWorkspace: noop, onDesignHealth: noop, onMeasure: noop, onExchange: noop, onAccess: noop,
        onConnectAi: noop, onExportStl: noop, onPlateJson: noop, onLearning: noop, onShortcuts: noop
      } as unknown as WorkbenchMenuActions;
      const state = {
        workspace: "sketch", masterCartOpen: false, renderStudioOpen: false, working: false, gridVisible: true, canUndo: false, canRedo: false, generalBodyCount: 0,
        previewBodySelected: false, generalBodySelected: false, selectionDeletable: false, buildLabel: "Build 3377c34 · 8 Nov 2026"
      } as WorkbenchMenuState;
      const without = buildWorkbenchMenus(state, actions).find((menu) => menu.id === "help")!;
      equal(without.items.some((entry) => entry.id === "help.about"), false, "no About item without an action");
      let opened = 0;
      const withAbout = buildWorkbenchMenus(state, { ...actions, onAbout: () => { opened += 1; } }).find((menu) => menu.id === "help")!;
      const about = withAbout.items.find((entry) => entry.id === "help.about");
      assert(about !== undefined, "About is listed in Help");
      equal(about.hint, "Build 3377c34 · 8 Nov 2026", "the item shows the running build");
      about.action();
      equal(opened, 1, "the item opens About");
      // Create > New sketch and the Part ribbon button share the plane dialog (d).
      const create = buildWorkbenchMenus({ ...state, workspace: "part" }, actions).find((menu) => menu.id === "create")!;
      create.items.find((entry) => entry.id === "create.sketch")!.action();
      equal(calls.join(","), "new-sketch", "Create > New sketch opens the plane dialog");
    }
  },
  {
    name: "Toasts (live walkthrough item 5): vehicle and electrical findings are not relevant while sketching or modelling a part, but are in their own workspace",
    run: () => {
      const report = buildDesignHealthReport(createWorkbenchProject("project:test-toast"));
      const notices = deriveFaultBrainNotices(report);
      const vehicleReview = notices.find((entry) => entry.id === "health:health:vehicle-review");
      assert(vehicleReview !== undefined, "the default project carries the 'Vehicle calculations require review' finding that interrupted the walkthrough");
      equal(vehicleReview.workspace, "vehicle", "it belongs to the vehicle study");
      for (const active of ["sketch", "part"] as const) {
        const { relevant, elsewhere } = partitionNoticesByWorkspace(notices, active);
        assert(!relevant.some((entry) => entry.workspace === "vehicle" || entry.workspace === "electrical"), `no vehicle or electrical notice interrupts ${active}`);
        assert(elsewhere.some((entry) => entry.id === vehicleReview.id), `the vehicle notice is held back in ${active}, not lost`);
      }
      assert(partitionNoticesByWorkspace(notices, "vehicle").relevant.some((entry) => entry.id === vehicleReview.id), "the vehicle workspace shows it");
      assert(partitionNoticesByWorkspace(notices, "electrical").relevant.every((entry) => entry.workspace !== "vehicle"), "the electrical workspace does not show vehicle notices");
      const synthetic = [notice("a", "warning", "part"), notice("b", "error"), notice("c", "warning", "drawing"), notice("d", "warning", "assembly")];
      equal(partitionNoticesByWorkspace(synthetic, "sketch").relevant.map((entry) => entry.id).join(","), "a,b", "sketch sees part and workspace-less notices only");
      equal(isNoticeRelevantToWorkspace(notice("x", "error"), "vehicle"), true, "an operation or runtime fault (no workspace) is relevant everywhere");
      equal(partitionNoticesByWorkspace(synthetic, "automate").relevant.length, 4, "Automate sees everything");
    }
  },
  {
    name: "Toasts (live walkthrough item 5): an acknowledged notice stays dismissed when it goes away and comes back, and across a reload of the page store; an escalation to error is new",
    run: () => {
      const warning = notice("health:vehicle-review", "warning", "vehicle");
      let dismissed: ReadonlySet<string> = new Set();
      const announced = new Set<string>();
      const first = nextAnnouncement([warning], dismissed, announced);
      equal(first?.id, warning.id, "a new relevant notice is announced");
      announced.add(faultDismissalKey(warning));
      equal(nextAnnouncement([warning], dismissed, announced), undefined, "it is announced only once");
      dismissed = new Set([faultDismissalKey(warning)]);
      announced.clear();
      equal(nextAnnouncement([], dismissed, announced), undefined, "it disappears (the workspace changed)");
      equal(nextAnnouncement([warning], dismissed, announced), undefined, "it comes back and stays quiet: the old code pruned the dismissal when the notice vanished");
      equal(nextAnnouncement([{ ...warning, message: "7 model warnings remain." }], dismissed, announced), undefined, "a changed count or wording does not reopen it");
      equal(nextAnnouncement([{ ...warning, severity: "error" }], dismissed, announced)?.severity, "error", "the same finding turning into an error is a new event");
      const storage = new FakeStorage();
      saveDismissedFaults(storage, dismissed);
      assert(loadDismissedFaults(storage).has(faultDismissalKey(warning)), "acknowledgements are read back from the session store");
      storage.values.set("ps3d.faultBrain.dismissed.v1", "{not json");
      equal(loadDismissedFaults(storage).size, 0, "a damaged store is an empty set, not an error");
      storage.throwOnSet = true;
      saveDismissedFaults(storage, dismissed);
      equal(loadDismissedFaults(undefined).size, 0, "no store at all is fine");
    }
  },
  {
    name: "Sketch settings E16: toggles and tool settings survive leaving and re-entering the sketch, and reloads, through the same store the workspace uses",
    run: () => {
      const storage = new FakeStorage();
      let store = new SketchPrefStore(storage);
      equal(store.get("snapEnabled", true), true, "the default applies the first time");
      store.set("snapEnabled", false);
      store.set("autoConstrain", false);
      store.set("showDimensions", false);
      store.set("polygonSides", "8");
      store.set("solidOp", "revolve");
      store.set("curveFields", { ...DEFAULT_CURVE_OPTION_FIELDS, cornerRadius: "7" });
      // Leaving the workspace unmounts it; the next mount reads the same store.
      equal(store.get("snapEnabled", true), false, "Snap stays off");
      equal(store.get("autoConstrain", true), false, "Auto-constrain stays off");
      equal(store.get("showDimensions", true), false, "Dimensions stay hidden");
      equal(store.get("polygonSides", "6"), "8", "polygon sides");
      equal(store.get("solidOp", "extrude"), "revolve", "the Create solid operation");
      equal(store.get("curveFields", DEFAULT_CURVE_OPTION_FIELDS).cornerRadius, "7", "curve option fields");
      // A page reload starts from localStorage.
      store = new SketchPrefStore(storage);
      equal(store.get("snapEnabled", true), false, "Snap stays off after a reload");
      equal(store.get("polygonSides", "6"), "8", "polygon sides after a reload");
      equal(store.get("curveFields", DEFAULT_CURVE_OPTION_FIELDS).cornerRadius, "7", "curve option fields after a reload");
      // Geometry ids stay in memory: a Dynamic Mirror axis must not leak into a new page load.
      store.set("dynamicMirrorAxis", "entity:user-1", false);
      equal(store.get<string | null>("dynamicMirrorAxis", null, false), "entity:user-1", "Dynamic Mirror survives leaving the sketch");
      equal(new SketchPrefStore(storage).get<string | null>("dynamicMirrorAxis", null, false), null, "but not a reload");
      assert(!(storage.values.get("ps3d.sketch.prefs.v1") ?? "").includes("dynamicMirrorAxis"), "memory-only values are never written to localStorage");
    }
  },
  {
    name: "Sketch settings E16: damaged or foreign stored values fall back to the default, objects merge field by field, and a failing or missing store never throws",
    run: () => {
      equal(coercePref(true, "yes"), true, "a string where a boolean belongs is ignored");
      equal(coercePref("6", 8), "6", "a number where a string belongs is ignored");
      equal(coercePref(1, Number.POSITIVE_INFINITY), 1, "a non-finite number is ignored");
      const merged = coercePref({ a: "x", b: "y" }, { a: "changed", b: 5, c: "injected" });
      equal(JSON.stringify(merged), JSON.stringify({ a: "changed", b: "y" }), "only known keys of the right type are taken");
      equal(coercePref({ a: "x" }, "oops").a, "x", "a non-object keeps the default object");
      const storage = new FakeStorage();
      storage.values.set("ps3d.sketch.prefs.v1", "[1,2,3]");
      equal(new SketchPrefStore(storage).get("snapEnabled", true), true, "a non-object store is ignored");
      storage.values.set("ps3d.sketch.prefs.v1", "{broken");
      equal(new SketchPrefStore(storage).get("snapEnabled", true), true, "broken JSON is ignored");
      storage.throwOnSet = true;
      const store = new SketchPrefStore(storage);
      store.set("snapEnabled", false);
      equal(store.get("snapEnabled", true), false, "a full store still remembers for the session");
      const bare = new SketchPrefStore(undefined);
      bare.set("snapEnabled", false);
      equal(bare.get("snapEnabled", true), false, "no store at all still remembers for the session");
      bare.clear();
      equal(bare.get("snapEnabled", true), true, "clear forgets everything");
      equal(DEFAULT_PALETTE_LAYOUT.dock, "docked", "the palette is docked by default so it no longer covers the canvas");
      equal(DEFAULT_PALETTE_LAYOUT.collapsed, false, "and expanded");
    }
  },
  {
    name: "Misleading help E26: the help strings point only at controls that exist",
    run: () => {
      assert(!RELATIONS_EMPTY_HELP.includes("Constrain group in the ribbon"), "the Relations tab no longer sends people to a ribbon group");
      assert(RELATIONS_EMPTY_HELP.includes("Selection controller"), "it names the real place");
      const sketchWorkspace = repoFile("apps/studio-web/src/workspaces/SketchWorkspace.tsx");
      assert(sketchWorkspace.includes("<strong>Selection controller</strong>"), "the Selection controller the text names exists");
      const ribbon = repoFile("apps/studio-web/src/ui/WorkbenchRibbon.tsx");
      assert(!ribbon.includes('RibbonGroup label="Constrain"'), "and the ribbon has no group called Constrain");
      const status = dimensionModeStatus("from the ribbon");
      assert(!status.includes("inspector"), "the Sketch Dimension status does not send people to the inspector");
      assert(status.includes("canvas"), "it says the value editor opens on the canvas");
      assert(sketchWorkspace.includes("setDimensionEdit("), "and the canvas editor really is opened by the workspace");
    }
  },
  {
    name: "Sketch plane chrome (a)(b)(d)(e)(f): the ribbon starts with a primary New Sketch and the plane chip, and the same plane dialog serves Create > New Sketch, the Part ribbon and the chip",
    run: () => {
      const ribbon = repoFile("apps/studio-web/src/ui/WorkbenchRibbon.tsx");
      const newSketch = ribbon.indexOf('label="New Sketch" hint="pick plane" primary');
      const createGeometry = ribbon.indexOf('RibbonGroup label="Create geometry"');
      assert(newSketch > 0 && createGeometry > 0 && newSketch < createGeometry, "the primary New Sketch button is the first control of the Sketch ribbon, before the drawing tools");
      assert(ribbon.indexOf("<SketchPlaneChip", newSketch) < createGeometry, "the plane chip sits next to it");
      assert(ribbon.includes("onNewSketch") && ribbon.indexOf('label="New Sketch" hint="plane or face"') > 0, "the Part ribbon still has its New Sketch button");
      const app = repoFile("apps/studio-web/src/App.tsx");
      assert(app.includes('onNewSketch={() => openSketchPlaneDialog("new")}') && app.includes('onChangeSketchPlane={() => openSketchPlaneDialog("set")}'), "the ribbon's New Sketch opens new-sketch mode and the chip opens change mode");
      assert(app.includes('onNewSketch: () => openSketchPlaneDialog("new")'), "Create > New Sketch opens the same dialog in new-sketch mode");
      assert(app.includes("decidePlaneOffer(") && app.includes("planeOfferAfterFinish("), "entering Sketch and Finish Sketch go through the offer rules");
      assert(app.includes("describeSketchPlane(projectRef.current.sketch).status"), "the status line states the plane after choosing");
      assert(app.includes('workspace === "sketch" ? ` ${describeSketchPlane(current.sketch).status}` : ""'), "and when the Sketch workspace is entered without choosing (Continue with the current sketch)");
      const dialog = repoFile("apps/studio-web/src/ui/SketchPlaneDialog.tsx");
      assert(dialog.includes("PlaneDiagram") && dialog.includes("Continue with the current sketch") && dialog.includes("existingPlanes"), "the dialog has the datum-plane diagram, the Continue option and the earlier-sketch planes");
      const workspace = repoFile("apps/studio-web/src/workspaces/SketchWorkspace.tsx");
      assert(workspace.includes("sketch-plane-chip canvas") && workspace.includes("paletteLayout"), "the canvas header chip and the dockable palette are in the workspace");
    }
  }
];
