import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceId } from "../../../../packages/workbench-core/src/index.js";
import type { DesignHealthReport } from "../../../../packages/workbench-health/src/index.js";
import {
  deriveFaultBrainNotices,
  faultDismissalKey,
  loadDismissedFaults,
  mergeFaultBrainNotices,
  nextAnnouncement,
  partitionNoticesByWorkspace,
  runtimeFaultNotice,
  saveDismissedFaults,
  type FaultBrainDiagnostic,
  type FaultBrainNotice
} from "./fault-brain.js";

/** Acknowledgements last for the browser tab's session; a blocked store just means they last until the page closes. */
function sessionStore(): Storage | undefined {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}

interface SmartFaultBrainProps {
  /** The workspace being used. Notices about other studies (vehicle, electrical...) stay out of the way until that workspace is open. */
  readonly workspace: WorkspaceId;
  readonly report: DesignHealthReport;
  readonly diagnostic?: FaultBrainDiagnostic;
  readonly onDesignHealth: () => void;
  readonly onWorkspace: (workspace: WorkspaceId) => void;
}

export function SmartFaultBrain(props: SmartFaultBrainProps): React.JSX.Element {
  const [runtimeNotices, setRuntimeNotices] = useState<readonly FaultBrainNotice[]>([]);
  // Keyed by id + severity (faultDismissalKey), kept for the session and never pruned: a notice that goes away and comes back stays acknowledged.
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => loadDismissedFaults(sessionStore()));
  const [showElsewhere, setShowElsewhere] = useState(false);
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState<FaultBrainNotice>();
  const announcedIds = useRef(new Set<string>());
  const reportNotices = useMemo(() => deriveFaultBrainNotices(props.report, props.diagnostic), [props.diagnostic, props.report]);
  const notices = useMemo(() => mergeFaultBrainNotices([...reportNotices, ...runtimeNotices]), [reportNotices, runtimeNotices]);
  const { relevant, elsewhere } = useMemo(() => partitionNoticesByWorkspace(notices, props.workspace), [notices, props.workspace]);
  const shown = showElsewhere ? notices : relevant;
  const visible = shown.filter((notice) => !dismissedIds.has(faultDismissalKey(notice)));
  const hiddenElsewhere = showElsewhere ? 0 : elsewhere.filter((notice) => !dismissedIds.has(faultDismissalKey(notice))).length;
  const errors = visible.filter((notice) => notice.severity === "error").length;
  const severity = errors > 0 ? "error" : visible.length > 0 ? "warning" : "healthy";

  useEffect(() => {
    const reportRuntime = (notice: FaultBrainNotice): void => {
      setRuntimeNotices((current) => mergeFaultBrainNotices([notice, ...current], 20));
    };
    const onError = (event: ErrorEvent): void => reportRuntime(runtimeFaultNotice("window-error", event.error ?? event.message));
    const onRejection = (event: PromiseRejectionEvent): void => reportRuntime(runtimeFaultNotice("unhandled-rejection", event.reason));
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  // Only a notice that is about the workspace in use, not yet acknowledged and not yet announced interrupts. Each is announced once per session.
  useEffect(() => {
    const next = nextAnnouncement(relevant, dismissedIds, announcedIds.current);
    if (next === undefined) return;
    announcedIds.current.add(faultDismissalKey(next));
    setAnnouncement(next);
  }, [dismissedIds, relevant]);

  // Leaving the workspace a toast was about takes the toast down with it.
  useEffect(() => {
    setAnnouncement((current) => (current === undefined || relevant.some((notice) => notice.id === current.id) ? current : undefined));
  }, [relevant]);

  const acknowledge = (notice: FaultBrainNotice): void => {
    setDismissedIds((current) => {
      const next = new Set([...current, faultDismissalKey(notice)]);
      saveDismissedFaults(sessionStore(), next);
      return next;
    });
    if (announcement?.id === notice.id) setAnnouncement(undefined);
  };
  const acknowledgeAll = (): void => {
    setDismissedIds((current) => {
      const next = new Set([...current, ...visible.map(faultDismissalKey)]);
      saveDismissedFaults(sessionStore(), next);
      return next;
    });
    setAnnouncement(undefined);
  };

  return <section className={`fault-brain-shell ${severity}`} aria-label="Smart fault brain">
    <button className="fault-brain-launcher" onClick={() => { setOpen((current) => !current); setAnnouncement(undefined); }} aria-expanded={open} aria-controls="fault-brain-panel">
      <span className="fault-brain-symbol" aria-hidden="true">◉</span>
      <span><strong>Smart Brain</strong><small>deterministic monitor</small></span>
      <b>{visible.length}</b>
    </button>
    {announcement !== undefined && !open && <div className="fault-brain-announcement" role="status" aria-live="assertive">
      <span>{announcement.severity === "error" ? "FAULT" : "REVIEW"}</span>
      <strong>{announcement.title}</strong>
      <p>{announcement.message}</p>
      <div><button onClick={() => setOpen(true)}>Review</button><button onClick={() => acknowledge(announcement)}>Acknowledge</button></div>
    </div>}
    {open && <aside id="fault-brain-panel" className="fault-brain-panel" role="complementary" aria-label="Smart Brain fault notifications">
      <header><div><span>SMART FAULT BRAIN</span><h2>{visible.length === 0 ? "No active faults" : `${errors} fault · ${visible.length - errors} review`}</h2></div><button onClick={() => setOpen(false)} aria-label="Close Smart Brain">×</button></header>
      <p className="fault-brain-boundary">Deterministic Design Health, dependency, operation, and browser-runtime monitoring. It reports faults; it does not silently repair or change CAD.</p>
      {(hiddenElsewhere > 0 || showElsewhere) && <p className="fault-brain-scope">{showElsewhere ? "Showing every workspace. " : `${hiddenElsewhere} notice${hiddenElsewhere === 1 ? "" : "s"} about other workspaces ${hiddenElsewhere === 1 ? "is" : "are"} hidden while you work in ${props.workspace}. `}<button onClick={() => setShowElsewhere((current) => !current)}>{showElsewhere ? "Only this workspace" : "Show all"}</button></p>}
      <div className="fault-brain-list">
        {visible.length === 0 ? <div className="fault-brain-clear"><strong>Current checks are clear</strong><span>New warnings and failures will appear here automatically.</span></div> : visible.map((notice) => <article key={notice.id} className={notice.severity}>
          <header><span>{notice.source.replaceAll("-", " ")}</span><b>{notice.severity}</b></header>
          <strong>{notice.title}</strong>
          <p>{notice.message}</p>
          <small>{notice.recovery}</small>
          <footer>{notice.workspace !== undefined && <button onClick={() => { props.onWorkspace(notice.workspace!); setOpen(false); }}>Open {notice.workspace}</button>}<button onClick={() => acknowledge(notice)}>Acknowledge</button></footer>
        </article>)}
      </div>
      <footer><button onClick={() => { props.onDesignHealth(); setOpen(false); }}>Open Design Health</button><button disabled={visible.length === 0} onClick={acknowledgeAll}>Acknowledge all</button></footer>
    </aside>}
  </section>;
}
