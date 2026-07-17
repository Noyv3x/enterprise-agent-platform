import type { Translator } from "../../i18n";
import type {
  AgentSchedule,
  AgentScheduleRule,
  AgentScheduleRunStatus,
  AgentScheduleState,
} from "../../types";

export function formatScheduleDate(
  value: string | null | undefined,
  locale: string,
  timezone?: string,
): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const options: Intl.DateTimeFormatOptions = {
    dateStyle: "medium",
    timeStyle: "short",
    ...(timezone ? { timeZone: timezone } : {}),
  };
  try {
    return new Intl.DateTimeFormat(locale, options).format(date);
  } catch {
    delete options.timeZone;
    return new Intl.DateTimeFormat(locale, options).format(date);
  }
}

export function scheduleRuleLabel(
  rule: AgentScheduleRule,
  timezone: string,
  locale: string,
  t: Translator,
): string {
  if (rule.type === "once") {
    return t("scheduledTasks.rule.once", {
      time: formatScheduleDate(rule.at, locale, timezone),
    });
  }
  if (rule.type === "cron") {
    return t("scheduledTasks.rule.cron", { expression: rule.expression });
  }
  const seconds = Math.max(1, Math.floor(Number(rule.every_seconds) || 1));
  if (seconds % 86_400 === 0) {
    return t("scheduledTasks.rule.intervalDays", { count: seconds / 86_400 });
  }
  if (seconds % 3_600 === 0) {
    return t("scheduledTasks.rule.intervalHours", { count: seconds / 3_600 });
  }
  if (seconds % 60 === 0) {
    return t("scheduledTasks.rule.intervalMinutes", { count: seconds / 60 });
  }
  return t("scheduledTasks.rule.intervalSeconds", { count: seconds });
}

export function scheduleStateLabel(state: AgentScheduleState, t: Translator): string {
  if (state === "paused") return t("scheduledTasks.state.paused");
  if (state === "completed") return t("scheduledTasks.state.completed");
  return t("scheduledTasks.state.active");
}

export function scheduleRunStatusLabel(status: AgentScheduleRunStatus, t: Translator): string {
  switch (status) {
    case "queued": return t("scheduledTasks.run.queued");
    case "running": return t("scheduledTasks.run.running");
    case "blocked": return t("scheduledTasks.run.blocked");
    case "needs_review": return t("scheduledTasks.run.needsReview");
    case "succeeded": return t("scheduledTasks.run.succeeded");
    case "failed": return t("scheduledTasks.run.failed");
    case "skipped": return t("scheduledTasks.run.skipped");
    case "cancelled": return t("scheduledTasks.run.cancelled");
    default: return String(status || "-").replace(/_/g, " ");
  }
}

export function scheduleIsRunning(schedule: AgentSchedule): boolean {
  return schedule.last_run?.status === "queued" || schedule.last_run?.status === "running";
}
