/**
 * Which build is this tab running, and is a different one live? The build writes dist/version.json (scripts/build-info.mjs) and
 * compiles the same object into the bundle. This module is the pure side: parsing, comparison, the polling rules, the banner
 * state and the reload decision. The React side (ui/useBuildUpdate.ts, ui/UpdateBanner.tsx) only wires timers to it.
 */

export interface BuildInfo {
  readonly schema: "ps3d-build-info-v1";
  readonly version: string;
  /** Full commit hash, or "dev" when the build ran outside git and outside Vercel. */
  readonly commit: string;
  /** Seven characters of the commit, or "dev". */
  readonly commitShort: string;
  /** ISO time the build ran. */
  readonly builtAt: string;
  readonly source: "vercel" | "git" | "dev";
}

/** Replaced by Vite's `define` with the object written to dist/version.json. Absent when the code runs outside a Vite build (tests). */
declare const __PS3D_BUILD_INFO__: unknown;

const SHA = /^[0-9a-f]{7,64}$/u;

/** Reads a version.json document. Anything that is not a well-formed build record is rejected (a 404 page, an HTML fallback, a proxy error). */
export function parseBuildInfo(value: unknown): BuildInfo | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const { schema, version, commit, commitShort, builtAt, source } = record;
  if (schema !== "ps3d-build-info-v1") return undefined;
  if (typeof version !== "string" || version.length === 0 || version.length > 64) return undefined;
  if (typeof commit !== "string" || !(commit === "dev" || SHA.test(commit))) return undefined;
  if (typeof commitShort !== "string" || commitShort !== (commit === "dev" ? "dev" : commit.slice(0, 7))) return undefined;
  if (typeof builtAt !== "string" || !Number.isFinite(Date.parse(builtAt))) return undefined;
  if (source !== "vercel" && source !== "git" && source !== "dev") return undefined;
  return { schema, version, commit, commitShort, builtAt, source };
}

const UNKNOWN_BUILD: BuildInfo = { schema: "ps3d-build-info-v1", version: "0.0.0", commit: "dev", commitShort: "dev", builtAt: "1970-01-01T00:00:00.000Z", source: "dev" };

/** The build this tab is running. */
export function runningBuild(): BuildInfo {
  try {
    return typeof __PS3D_BUILD_INFO__ === "undefined" ? UNKNOWN_BUILD : parseBuildInfo(__PS3D_BUILD_INFO__) ?? UNKNOWN_BUILD;
  } catch {
    return UNKNOWN_BUILD;
  }
}

/** "Build 3f9a1c5 · 9 Nov 2026". The date is the UTC day so every viewer reads the same text. */
export function formatBuildLabel(info: BuildInfo): string {
  return `Build ${info.commitShort} · ${formatBuildDate(info.builtAt)}`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatBuildDate(iso: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "unknown date";
  const date = new Date(time);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** The text the Copy button puts on the clipboard, for a bug report. */
export function buildReportText(info: BuildInfo, origin: string): string {
  return [
    "PS3D CAD Studio",
    `Build ${info.commitShort} (${info.commit})`,
    `Version ${info.version}`,
    `Built ${info.builtAt}`,
    `Source ${info.source}`,
    `Origin ${origin}`
  ].join("\n");
}

export type BuildComparison =
  /** Same commit. */
  | "same"
  /** The server's build is newer than this tab's. */
  | "newer"
  /** The server's build differs and is not newer (a rollback, or a clock difference). */
  | "different"
  /** One side has no commit identity (a local "dev" build), so nothing can be said. */
  | "unknown";

/**
 * Compares the live build with the running one. A "dev" commit on either side is not comparable: a developer's local build must not be
 * told to reload into production, and a production tab must not be told its build differs from a dev server.
 */
export function compareBuilds(running: BuildInfo, live: BuildInfo): BuildComparison {
  if (running.commit === "dev" || live.commit === "dev") return running.commit === live.commit ? "same" : "unknown";
  if (running.commit === live.commit) return "same";
  return Date.parse(live.builtAt) > Date.parse(running.builtAt) ? "newer" : "different";
}

/** How often the page asks the server for version.json. */
export const BUILD_POLL_INTERVAL_MS = 5 * 60_000;
/** A focus event inside this window after a check does not check again (alt-tabbing back and forth must not hammer the server). */
export const BUILD_FOCUS_MIN_GAP_MS = 15_000;

/** Same-origin URL with a cache-busting query, so no cache between the page and the server can hand back an old record. */
export function versionUrl(now: number): string {
  return `/version.json?t=${Math.trunc(now)}`;
}

export function shouldCheckOnFocus(lastCheckedAt: number | undefined, now: number): boolean {
  return lastCheckedAt === undefined || now - lastCheckedAt >= BUILD_FOCUS_MIN_GAP_MS;
}

type FetchLike = (input: string, init?: { readonly cache?: "no-store"; readonly credentials?: "omit"; readonly signal?: AbortSignal }) => Promise<{ readonly ok: boolean; json(): Promise<unknown> }>;

/** Fetches the live build record. Resolves undefined on any failure (offline, a non-JSON body, a malformed record): checking must never break the app. */
export async function fetchLiveBuild(fetchFn: FetchLike, now: number, signal?: AbortSignal): Promise<BuildInfo | undefined> {
  try {
    const response = await fetchFn(versionUrl(now), { cache: "no-store", credentials: "omit", ...(signal === undefined ? {} : { signal }) });
    if (!response.ok) return undefined;
    return parseBuildInfo(await response.json());
  } catch {
    return undefined;
  }
}

/** What the update banner knows. */
export interface UpdateBannerState {
  /** The last live build record fetched, if any check has succeeded. */
  readonly live: BuildInfo | undefined;
  readonly lastCheckedAt: number | undefined;
  /** The commit whose banner the user dismissed; a later deploy with another commit shows the banner again. */
  readonly dismissedCommit: string | undefined;
}

export const INITIAL_BANNER_STATE: UpdateBannerState = { live: undefined, lastCheckedAt: undefined, dismissedCommit: undefined };

export type UpdateBannerEvent =
  | { readonly kind: "checked"; readonly live: BuildInfo | undefined; readonly at: number }
  | { readonly kind: "dismissed" };

export function reduceUpdateBanner(state: UpdateBannerState, event: UpdateBannerEvent): UpdateBannerState {
  if (event.kind === "dismissed") return { ...state, dismissedCommit: state.live?.commit ?? state.dismissedCommit };
  // A failed check records that it ran but keeps what was known.
  return { ...state, live: event.live ?? state.live, lastCheckedAt: event.at };
}

export interface UpdateBannerView {
  readonly visible: boolean;
  readonly comparison: BuildComparison;
  /** "A newer version is available (3f9a1c5)". Empty when hidden. */
  readonly message: string;
}

/** Whether to show the banner: only for a comparable, different build the user has not dismissed. */
export function updateBannerView(state: UpdateBannerState, running: BuildInfo): UpdateBannerView {
  if (state.live === undefined) return { visible: false, comparison: "unknown", message: "" };
  const comparison = compareBuilds(running, state.live);
  const different = comparison === "newer" || comparison === "different";
  if (!different || state.dismissedCommit === state.live.commit) return { visible: false, comparison, message: "" };
  const lead = comparison === "newer" ? "A newer version is available" : "A different version is live";
  return { visible: true, comparison, message: `${lead} (${state.live.commitShort})` };
}

export type ReloadPlan =
  /** Reload now. */
  | { readonly action: "reload" }
  /** Ask first: there are unsaved changes a reload would lose. */
  | { readonly action: "confirm"; readonly warning: string };

/** The Reload button: with unsaved changes the first click warns, the second (confirmed) click reloads. */
export function planReload(dirty: boolean, confirmed: boolean): ReloadPlan {
  if (!dirty || confirmed) return { action: "reload" };
  return { action: "confirm", warning: "You have unsaved changes. Reloading discards them. Save first, or reload anyway." };
}
