import { intlLocale, useI18n } from "../../i18n";
import { useStore } from "../../store/useStore";
import type { Message, ScheduledTaskMessageMarker } from "../../types";
import { formatScheduleDate } from "../scheduled-tasks/scheduleFormat";
import { MessageEntry, StatusMark } from "../ui/fieldwork";

export function ScheduledTaskMarker({
  marker,
  message,
}: {
  marker: ScheduledTaskMessageMarker;
  message: Message;
}) {
  const { t, locale } = useI18n();
  const timezone = useStore((state) => state.user?.timezone || "");
  const time = formatScheduleDate(
    marker.scheduled_for || (message.created_at ? new Date(message.created_at * 1000).toISOString() : ""),
    intlLocale(locale),
    timezone,
  );
  const name = marker.name || t("scheduledTasks.title");

  return <MessageEntry kind="system"
 status={<StatusMark>{t("scheduledTasks.marker")}</StatusMark>} timestamp={time ? <time dateTime={marker.scheduled_for}>{time}</time> : undefined}>
 <div role="note" aria-label={t("scheduledTasks.markerLabel",{name,time})} data-schedule-id={String(marker.schedule_id)} data-schedule-run-id={String(marker.schedule_run_id)}><strong>{name}</strong></div>
 </MessageEntry>;
}
