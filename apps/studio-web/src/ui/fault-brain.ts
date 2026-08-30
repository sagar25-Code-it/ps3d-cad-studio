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
    .filter((dependency) => dependency.status !== "current")
    .map((dependency): FaultBrainNotice => ({
      id: `dependency:${dependency.id}:${dependency.status}`,
      source: "dependency",
      severity: dependency.status === "stale" ? "error" : "warning",
      title: `${dependency.label} is ${dependency.status}`,
      message: dependency.detail,
      recovery: `Review the ${dependency.from} to ${dependency.to} dependency and rebuild or relink it before release.`,
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
