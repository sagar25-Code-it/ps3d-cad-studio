import type { CapabilityLevel } from "../../../../packages/workbench-core/src/index.js";

export function CapabilityBadge({ level }: { readonly level: CapabilityLevel }): React.JSX.Element {
  return <span className={`capability-badge ${level}`}><span aria-hidden="true" />{level}</span>;
}
