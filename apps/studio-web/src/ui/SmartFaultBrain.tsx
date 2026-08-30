import { useEffect, useMemo, useRef, useState } from "react";
import type { WorkspaceId } from "../../../../packages/workbench-core/src/index.js";
import type { DesignHealthReport } from "../../../../packages/workbench-health/src/index.js";
import {
  deriveFaultBrainNotices,
  mergeFaultBrainNotices,
  runtimeFaultNotice,
  type FaultBrainDiagnostic,
  type FaultBrainNotice
} from "./fault-brain.js";

interface SmartFaultBrainProps {
  readonly report: DesignHealthReport;
  readonly diagnostic?: FaultBrainDiagnostic;
  readonly onDesignHealth: () => void;
  readonly onWorkspace: (workspace: WorkspaceId) => void;
}

export function SmartFaultBrain(props: SmartFaultBrainProps): React.JSX.Element {
  const [runtimeNotices, setRuntimeNotices] = useState<readonly FaultBrainNotice[]>([]);
  const [dismissedIds, setDismissedIds] = useState<ReadonlySet<string>>(() => new Set());
  const [open, setOpen] = useState(false);
  const [announcement, setAnnouncement] = useState<FaultBrainNotice>();
  const announcedIds = useRef(new Set<string>());
  const reportNotices = useMemo(() => deriveFaultBrainNotices(props.report, props.diagnostic), [props.diagnostic, props.report]);
  const notices = useMemo(() => mergeFaultBrainNotices([...reportNotices, ...runtimeNotices]), [reportNotices, runtimeNotices]);
  const visible = notices.filter((notice) => !dismissedIds.has(notice.id));
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

  useEffect(() => {
    const activeIds = new Set(notices.map((notice) => notice.id));
    for (const id of announcedIds.current) if (!activeIds.has(id)) announcedIds.current.delete(id);
    const next = notices.find((notice) => !dismissedIds.has(notice.id) && !announcedIds.current.has(notice.id));
    if (next === undefined) return;
    announcedIds.current.add(next.id);
    setAnnouncement(next);
  }, [dismissedIds, notices]);

  const acknowledge = (id: string): void => {
    setDismissedIds((current) => new Set([...current, id]));
    if (announcement?.id === id) setAnnouncement(undefined);
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
      <div><button onClick={() => setOpen(true)}>Review</button><button onClick={() => acknowledge(announcement.id)}>Acknowledge</button></div>
    </div>}
    {open && <aside id="fault-brain-panel" className="fault-brain-panel" role="dialog" aria-label="Smart Brain fault notifications">
      <header><div><span>SMART FAULT BRAIN</span><h2>{visible.length === 0 ? "No active faults" : `${errors} fault · ${visible.length - errors} review`}</h2></div><button onClick={() => setOpen(false)} aria-label="Close Smart Brain">×</button></header>
      <p className="fault-brain-boundary">Deterministic Design Health, dependency, operation, and browser-runtime monitoring. It reports faults; it does not silently repair or change CAD.</p>
      <div className="fault-brain-list">
        {visible.length === 0 ? <div className="fault-brain-clear"><strong>Current checks are clear</strong><span>New warnings and failures will appear here automatically.</span></div> : visible.map((notice) => <article key={notice.id} className={notice.severity}>
          <header><span>{notice.source.replaceAll("-", " ")}</span><b>{notice.severity}</b></header>
          <strong>{notice.title}</strong>
          <p>{notice.message}</p>
          <small>{notice.recovery}</small>
          <footer>{notice.workspace !== undefined && <button onClick={() => { props.onWorkspace(notice.workspace!); setOpen(false); }}>Open {notice.workspace}</button>}<button onClick={() => acknowledge(notice.id)}>Acknowledge</button></footer>
        </article>)}
      </div>
      <footer><button onClick={() => { props.onDesignHealth(); setOpen(false); }}>Open Design Health</button><button disabled={visible.length === 0} onClick={() => { setDismissedIds(new Set(notices.map((notice) => notice.id))); setAnnouncement(undefined); }}>Acknowledge all</button></footer>
    </aside>}
  </section>;
}
