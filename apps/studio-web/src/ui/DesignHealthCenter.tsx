import { useMemo, useState } from "react";
import type {
  DesignHealthReport,
  DesignHealthSeverity
} from "../../../../packages/workbench-health/src/index.js";
import type { WorkspaceId } from "../../../../packages/workbench-core/src/index.js";
import { CommandIcon } from "./CommandIcon.js";
import { useDialogFocus } from "./useDialogFocus.js";

interface DesignHealthCenterProps {
  readonly report: DesignHealthReport;
  readonly onClose: () => void;
  readonly onWorkspace: (workspace: WorkspaceId) => void;
}

type FindingFilter = "all" | DesignHealthSeverity;

export function DesignHealthCenter({ report, onClose, onWorkspace }: DesignHealthCenterProps): React.JSX.Element {
  const [filter, setFilter] = useState<FindingFilter>("all");
  const dialogRef = useDialogFocus<HTMLElement>(true, onClose);
  const filtered = useMemo(() => filter === "all" ? report.findings : report.findings.filter((finding) => finding.severity === filter), [filter, report.findings]);
  const currentDependencies = report.dependencies.filter((dependency) => dependency.status === "current").length;
  const detachedDependencies = report.dependencies.filter((dependency) => dependency.status === "detached").length;

  const openWorkspace = (workspace: WorkspaceId): void => {
    onWorkspace(workspace);
    onClose();
  };

  return <div className="design-health-backdrop">
    <section ref={dialogRef} tabIndex={-1} className="design-health-dialog" role="dialog" aria-modal="true" aria-labelledby="design-health-title" aria-describedby="design-health-boundary">
      <header className="design-health-header">
        <div className={`design-health-gauge ${report.overallStatus}`} aria-label={`Design health score ${report.score} of 100`}>
          <strong>{report.score}</strong><span>/ 100</span>
        </div>
        <div className="design-health-heading">
          <span>DETERMINISTIC REBUILD &amp; READINESS REVIEW</span>
          <h2 id="design-health-title">Design Health Center</h2>
          <p>Revision {report.projectRevision} · {report.overallStatus} · all eight workspaces analyzed from the current project snapshot</p>
        </div>
        <button data-dialog-initial-focus className="design-health-close" onClick={onClose} aria-label="Close Design Health Center">×</button>
      </header>

      <div className="design-health-summary" aria-label="Design health summary">
        <HealthFact icon="inspect" label="Blocking" value={report.errors} tone={report.errors > 0 ? "error" : "healthy"} />
        <HealthFact icon="warning" label="Review" value={report.warnings} tone={report.warnings > 0 ? "warning" : "healthy"} />
        <HealthFact icon="command" label="Information" value={report.information} tone="info" />
        <HealthFact icon="assembly" label="Current links" value={currentDependencies} tone="healthy" />
        <HealthFact icon="unlink" label="Detached links" value={detachedDependencies} tone={detachedDependencies > 0 ? "warning" : "healthy"} />
      </div>

      <div className="design-health-layout">
        <section className="design-health-main" aria-label="Workspace health">
          <div className="health-section-title"><div><span>WORKSPACE MATRIX</span><h3>Professional readiness by discipline</h3></div><small>Click a workspace to inspect or repair it</small></div>
          <div className="workspace-health-grid">
            {report.workspaces.map((workspace) => <button key={workspace.workspace} className={`workspace-health-card ${workspace.status}`} onClick={() => openWorkspace(workspace.workspace)}>
              <div><span className={`health-state ${workspace.status}`} /> <strong>{workspace.label}</strong><b>{workspace.score}</b></div>
              <p>{workspace.status === "healthy" ? "No blocking or review findings" : `${workspace.findingIds.length} recorded finding${workspace.findingIds.length === 1 ? "" : "s"}`}</p>
              <dl>
                <div><dt>Qualified</dt><dd>{workspace.capabilityCounts.qualified}</dd></div>
                <div><dt>Preview</dt><dd>{workspace.capabilityCounts.preview}</dd></div>
                <div><dt>Unavailable</dt><dd>{workspace.capabilityCounts.unavailable}</dd></div>
                <div><dt>Last change</dt><dd>{workspace.lastChangedRevision === 0 ? "Seed" : `R${workspace.lastChangedRevision}`}</dd></div>
              </dl>
            </button>)}
          </div>

          <div className="health-section-title compact"><div><span>ASSOCIATIVITY MAP</span><h3>Actual dependency contract</h3></div><small>No inferred links are presented as associative</small></div>
          <div className="dependency-table" role="table" aria-label="Workbench dependency map">
            {report.dependencies.map((dependency) => <div role="row" className={`dependency-row ${dependency.status}`} key={dependency.id}>
              <div role="cell" className="dependency-route"><strong>{dependency.from}</strong><span>→</span><strong>{dependency.to}</strong></div>
              <div role="cell"><b>{dependency.label}</b><small>{dependency.detail}</small></div>
              <div role="cell"><span className={`dependency-status ${dependency.status}`}>{dependency.mode} · {dependency.status}</span></div>
            </div>)}
          </div>
        </section>

        <aside className="design-health-side" aria-label="Findings and rebuild order">
          <div className="health-section-title"><div><span>FINDINGS</span><h3>Repair queue</h3></div><small>{filtered.length} shown</small></div>
          <div className="finding-filters" role="group" aria-label="Filter health findings">
            {(["all", "error", "warning", "info"] as const).map((value) => <button key={value} className={filter === value ? "active" : ""} aria-pressed={filter === value} onClick={() => setFilter(value)}>{value}</button>)}
          </div>
          <div className="health-finding-list">
            {filtered.map((finding) => <article className={`health-finding ${finding.severity}`} key={finding.id}>
              <header><span>{finding.workspace}</span><strong>{finding.title}</strong></header>
              <p>{finding.message}</p>
              <small><b>Evidence</b>{finding.evidence}</small>
              <small><b>Recovery</b>{finding.recovery}</small>
            </article>)}
          </div>
          <div className="rebuild-order-card">
            <span>DETERMINISTIC REVIEW ORDER</span>
            <ol>{report.rebuildOrder.map((workspace, index) => <li key={workspace}><b>{index + 1}</b><span>{workspace}</span></li>)}</ol>
          </div>
        </aside>
      </div>

      <footer className="design-health-footer">
        <p id="design-health-boundary">{report.releaseBoundary}</p>
        <button onClick={onClose}>Close review</button>
      </footer>
    </section>
  </div>;
}

function HealthFact({ icon, label, value, tone }: { readonly icon: string; readonly label: string; readonly value: number; readonly tone: string }): React.JSX.Element {
  return <div className={`health-fact ${tone}`}><span><CommandIcon name={icon} /></span><div><strong>{value}</strong><small>{label}</small></div></div>;
}
