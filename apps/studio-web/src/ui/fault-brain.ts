import type { DesignHealthReport, DesignHealthSeverity } from "../../../../packages/workbench-health/src/index.js";
import type { WorkspaceId } from "../../../../packages/workbench-core/src/index.js";

export type FaultBrainSource = "design-health" | "dependency" | "operation" | "runtime";

export interface FaultBrainDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly recovery: string;
}

export interface FaultBrainNotice {
  readonly id: string;
  readonly source: FaultBrainSource;
  readonly severity: Exclude<DesignHealthSeverity, "info">;
  readonly title: string;
  readonly message: string;
  readonly recovery: string;
  readonly workspace?: WorkspaceId;
  readonly revision?: number;
}

export function deriveFaultBrainNotices(report: DesignHealthReport, diagnostic?: FaultBrainDiagnostic): readonly FaultBrainNotice[] {
  const health = report.findings
    .filter((finding) => finding.severity !== "info")
    .map((finding): FaultBrainNotice => ({
      id: `health:${finding.id}`,
      source: "design-health",
      severity: finding.severity === "error" ? "error" : "warning",
      title: finding.title,
      message: finding.message,
      recovery: finding.recovery,
      workspace: finding.workspace,
      revision: report.projectRevision
    }));
  const dependencies = report.dependencies
    .filter((dependency) => dependency.status === "stale")
    .map((dependency): FaultBrainNotice => ({
      id: `dependency:${dependency.id}:${dependency.status}`,
      source: "dependency",
      severity: "warning",
      title: `${dependency.label} is ${dependency.status}`,
      message: dependency.detail,
      recovery: `Regenerate the complete ${dependency.from} to ${dependency.to} candidate before release; do not silently patch individual packages.`,
      workspace: dependency.to,
      revision: report.projectRevision
    }));
  const operation = diagnostic === undefined ? [] : [{
    id: `operation:${diagnostic.code}:${stableFaultHash(diagnostic.message)}`,
    source: "operation" as const,
    severity: "error" as const,
    title: diagnostic.code.replaceAll("_", " "),
    message: sanitizeFaultText(diagnostic.message),
    recovery: sanitizeFaultText(diagnostic.recovery),
    revision: report.projectRevision
  }];
  return mergeFaultBrainNotices([...health, ...dependencies, ...operation]);
}

export function runtimeFaultNotice(kind: "window-error" | "unhandled-rejection", value: unknown): FaultBrainNotice {
  const message = sanitizeFaultText(runtimeMessage(value));
  return {
    id: `runtime:${kind}:${stableFaultHash(message)}`,
    source: "runtime",
    severity: "error",
    title: kind === "window-error" ? "Browser runtime error" : "Unhandled background failure",
    message,
    recovery: "Preserve the current project, retry the last bounded action once, and review Design Health before continuing."
  };
}

export function mergeFaultBrainNotices(notices: readonly FaultBrainNotice[], limit = 60): readonly FaultBrainNotice[] {
  const unique = new Map<string, FaultBrainNotice>();
  for (const notice of notices) if (!unique.has(notice.id)) unique.set(notice.id, notice);
  return Array.from(unique.values())
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || left.id.localeCompare(right.id))
    .slice(0, Math.max(1, limit));
}

export function sanitizeFaultText(value: string): string {
  return value
    .replace(/\bBearer\s+\S+/giu, "Bearer [redacted]")
    .replace(/\bps3d_[A-Za-z0-9_-]{12,}\b/gu, "[redacted credential]")
    .replace(/\beyJ[A-Za-z0-9_-]{16,}(?:\.[A-Za-z0-9_-]+){1,2}\b/gu, "[redacted credential]")
    .replace(/(?:file:\/{2,3}|[A-Za-z]:\\)[^\s"'<>]+/gu, "[local path]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 280) || "An unexpected runtime failure was reported without a public message.";
}

function runtimeMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  if (value !== null && typeof value === "object" && "message" in value && typeof value.message === "string") return value.message;
  return "An unexpected runtime failure was reported without a public message.";
}

function severityRank(value: FaultBrainNotice["severity"]): number {
  return value === "error" ? 2 : 1;
}

function stableFaultHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Which workspaces a notice from `noticeWorkspace` is worth interrupting. Vehicle and electrical findings are about those studies
 * only: they must not pop up while someone sketches a mechanical part. Part, Sketch, Assembly, Surface and Drawing share the
 * solid model, so a problem in one is shown in its neighbours. Automate sees everything. A notice with no workspace (an operation
 * failure, a browser runtime fault) is relevant everywhere.
 */
const RELATED_WORKSPACES: Readonly<Record<WorkspaceId, readonly WorkspaceId[]>> = {
  sketch: ["sketch", "part"],
  part: ["part", "sketch", "assembly"],
  assembly: ["assembly", "part"],
  surface: ["surface", "part"],
  drawing: ["drawing", "part"],
  electrical: ["electrical", "assembly"],
  vehicle: ["vehicle"],
  automate: ["sketch", "part", "assembly", "surface", "drawing", "electrical", "vehicle", "automate"]
};

export function isNoticeRelevantToWorkspace(notice: Pick<FaultBrainNotice, "workspace">, active: WorkspaceId): boolean {
  return notice.workspace === undefined || RELATED_WORKSPACES[active].includes(notice.workspace);
}

export interface PartitionedNotices {
  readonly relevant: readonly FaultBrainNotice[];
  readonly elsewhere: readonly FaultBrainNotice[];
}

export function partitionNoticesByWorkspace(notices: readonly FaultBrainNotice[], active: WorkspaceId): PartitionedNotices {
  const relevant: FaultBrainNotice[] = [];
  const elsewhere: FaultBrainNotice[] = [];
  for (const notice of notices) (isNoticeRelevantToWorkspace(notice, active) ? relevant : elsewhere).push(notice);
  return { relevant, elsewhere };
}

/**
 * The key a dismissal is stored under. It is the notice id plus its severity, so acknowledging a warning keeps it quiet however
 * its count or wording changes, while the same finding turning into an error is a new event and is shown again.
 */
export function faultDismissalKey(notice: Pick<FaultBrainNotice, "id" | "severity">): string {
  return `${notice.id}|${notice.severity}`;
}

const DISMISSED_STORAGE_KEY = "ps3d.faultBrain.dismissed.v1";
const DISMISSED_LIMIT = 200;

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** Reads the acknowledged keys; a missing, blocked or damaged store is an empty set. */
export function loadDismissedFaults(storage: StorageLike | undefined): ReadonlySet<string> {
  try {
    const raw = storage?.getItem(DISMISSED_STORAGE_KEY);
    if (raw === null || raw === undefined) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string").slice(-DISMISSED_LIMIT) : []);
  } catch {
    return new Set();
  }
}

export function saveDismissedFaults(storage: StorageLike | undefined, keys: ReadonlySet<string>): void {
  try {
    storage?.setItem(DISMISSED_STORAGE_KEY, JSON.stringify([...keys].slice(-DISMISSED_LIMIT)));
  } catch {
    // A full or blocked store only means the acknowledgement lasts until the page closes.
  }
}

/**
 * The one notice that may interrupt now: the first relevant one that is neither acknowledged nor already announced. `announced` holds
 * dismissal keys and only grows within a session, so a notice that goes away and comes back (a re-render, a revision change) is not
 * announced a second time, and an acknowledged one never is.
 */
export function nextAnnouncement(relevant: readonly FaultBrainNotice[], dismissed: ReadonlySet<string>, announced: ReadonlySet<string>): FaultBrainNotice | undefined {
  return relevant.find((notice) => !dismissed.has(faultDismissalKey(notice)) && !announced.has(faultDismissalKey(notice)));
}
