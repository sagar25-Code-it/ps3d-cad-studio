import { useState } from "react";
import { buildReportText, compareBuilds, formatBuildDate, formatBuildLabel } from "../build-info.js";
import type { BuildUpdate } from "./useBuildUpdate.js";
import { CommandIcon } from "./CommandIcon.js";
import { useDialogFocus } from "./useDialogFocus.js";

interface AboutDialogProps {
  readonly open: boolean;
  readonly update: BuildUpdate;
  readonly onClose: () => void;
}

/** Copies text; falls back to a hidden textarea where the async clipboard is blocked. Resolves whether it worked. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      const ok = document.execCommand("copy");
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

/** Help > About: which build this tab runs, which build is live, and why the two can differ. */
export function AboutDialog(props: AboutDialogProps): React.JSX.Element | null {
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const [checking, setChecking] = useState(false);
  const dialogRef = useDialogFocus<HTMLElement>(props.open, props.onClose);
  if (!props.open) return null;
  const { running, live } = props.update;
  const comparison = live === undefined ? undefined : compareBuilds(running, live);
  const verdict = live === undefined ? "Not checked yet, or the server could not be reached."
    : comparison === "same" ? "Up to date: this tab runs the build that is live."
      : comparison === "unknown" ? "A local development build; it is not compared with the live site."
        : `Live build is ${formatBuildLabel(live)}. Reload this tab to run it.`;
  return <div className="dialog-backdrop save-project-backdrop" role="presentation" onMouseDown={props.onClose}>
    <section ref={dialogRef} tabIndex={-1} className="save-project-dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title" onMouseDown={(event) => event.stopPropagation()}>
      <header><span><CommandIcon name="help" /></span><div><small>HELP / ABOUT</small><h2 id="about-title">PS3D CAD Studio</h2></div><button onClick={props.onClose} aria-label="Close About">×</button></header>
      <div className="save-project-content">
        <dl className="about-build">
          <div><dt>Running build</dt><dd data-about-build="">{formatBuildLabel(running)}</dd></div>
          <div><dt>Commit</dt><dd className="about-commit">{running.commit}</dd></div>
          <div><dt>Version</dt><dd>{running.version}</dd></div>
          <div><dt>Built</dt><dd>{formatBuildDate(running.builtAt)} ({running.builtAt})</dd></div>
          <div><dt>Site</dt><dd>{window.location.origin}</dd></div>
          <div><dt>Live build</dt><dd>{live === undefined ? "unknown" : formatBuildLabel(live)}</dd></div>
        </dl>
        <div className={`about-verdict ${comparison === "newer" || comparison === "different" ? "stale" : ""}`} role="status">{verdict}</div>
        <div className="about-actions">
          <button data-dialog-initial-focus onClick={() => void copyText(buildReportText(running, window.location.origin)).then((ok) => setCopied(ok ? "done" : "failed"))}><CommandIcon name="copy" />{copied === "done" ? "Copied" : copied === "failed" ? "Copy failed, select the text above" : "Copy build info"}</button>
          <button disabled={checking} onClick={() => { setChecking(true); void props.update.checkNow().finally(() => setChecking(false)); }}>{checking ? "Checking" : "Check for a new version"}</button>
          {(comparison === "newer" || comparison === "different") && <button className="primary" onClick={() => window.location.reload()}>Reload</button>}
        </div>
        <div className="save-project-note"><CommandIcon name="shield" /><span>Two windows can show different versions for three reasons: a tab opened before the last deploy keeps running its old build until it is reloaded; projects are saved per site address, so the in-app browser, localhost and the live site each hold their own; and a local build is not the deployed one. Compare the build line above to tell which is which.</span></div>
      </div>
      <footer><button onClick={props.onClose}>Close</button></footer>
    </section>
  </div>;
}
