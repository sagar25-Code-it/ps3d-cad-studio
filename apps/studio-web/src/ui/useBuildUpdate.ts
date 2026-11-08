import { useCallback, useEffect, useReducer, useRef } from "react";
import {
  BUILD_POLL_INTERVAL_MS,
  INITIAL_BANNER_STATE,
  fetchLiveBuild,
  reduceUpdateBanner,
  runningBuild,
  shouldCheckOnFocus,
  updateBannerView,
  type BuildInfo,
  type UpdateBannerView
} from "../build-info.js";

export interface BuildUpdate {
  /** The build this tab is running. */
  readonly running: BuildInfo;
  /** The build the server last reported, once a check has succeeded. */
  readonly live: BuildInfo | undefined;
  readonly lastCheckedAt: number | undefined;
  readonly banner: UpdateBannerView;
  /** Asks the server now (the About dialog's "Check now"). */
  readonly checkNow: () => Promise<void>;
  readonly dismiss: () => void;
}

/**
 * Polls /version.json (same origin, cache-busted) when the window gains focus and every five minutes, and tells the page whether a
 * different build is live. A failed check (offline, blocked) is silent and keeps the last known answer.
 */
export function useBuildUpdate(): BuildUpdate {
  const [state, dispatch] = useReducer(reduceUpdateBanner, INITIAL_BANNER_STATE);
  const running = runningBuild();
  const lastCheckedRef = useRef<number | undefined>(undefined);
  const inFlight = useRef(false);

  const check = useCallback(async (): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const now = Date.now();
      const live = await fetchLiveBuild((input, init) => window.fetch(input, init), now);
      lastCheckedRef.current = now;
      dispatch({ kind: "checked", live, at: now });
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void check();
    const timer = window.setInterval(() => void check(), BUILD_POLL_INTERVAL_MS);
    const onFocus = (): void => {
      if (shouldCheckOnFocus(lastCheckedRef.current, Date.now())) void check();
    };
    const onVisible = (): void => {
      if (document.visibilityState === "visible") onFocus();
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  return {
    running,
    live: state.live,
    lastCheckedAt: state.lastCheckedAt,
    banner: updateBannerView(state, running),
    checkNow: check,
    dismiss: useCallback(() => dispatch({ kind: "dismissed" }), [])
  };
}
