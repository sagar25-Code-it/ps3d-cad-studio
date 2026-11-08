import { useState } from "react";
import { planReload, type UpdateBannerView } from "../build-info.js";

interface UpdateBannerProps {
  readonly view: UpdateBannerView;
  /** True while the project has changes that are not saved to a file. */
  readonly dirty: boolean;
  readonly onDismiss: () => void;
  readonly onReload?: () => void;
}

/** "A newer version is available (3f9a1c5) · Reload". Persistent until dismissed; dismissing hides it for that build only. */
export function UpdateBanner(props: UpdateBannerProps): React.JSX.Element | null {
  const [warning, setWarning] = useState<string | undefined>(undefined);
  if (!props.view.visible) return null;
  const reload = (confirmed: boolean): void => {
    const plan = planReload(props.dirty, confirmed);
    if (plan.action === "confirm") {
      setWarning(plan.warning);
      return;
    }
    (props.onReload ?? (() => window.location.reload()))();
  };
  return <div className="update-banner" role="status" aria-live="polite" data-update-banner="">
    <strong>{props.view.message}</strong>
    {warning === undefined
      ? <button className="update-banner-reload" onClick={() => reload(false)}>Reload</button>
      : <><span className="update-banner-warning">{warning}</span><button className="update-banner-reload" onClick={() => reload(true)}>Reload anyway</button><button onClick={() => setWarning(undefined)}>Keep working</button></>}
    <button className="update-banner-dismiss" onClick={props.onDismiss} aria-label="Dismiss the new version notice">×</button>
  </div>;
}
