import { intlLocale, useI18n } from "../../i18n";
import { useStore } from "../../store/useStore";
import type { Message, ScheduledTaskMessageMarker } from "../../types";
import { formatScheduleDate } from "../scheduled-tasks/scheduleFormat";
import { Icon } from "../common/Icon";

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

  return (
    <article
      className="scheduled-message-marker"
      role="note"
      aria-label={t("scheduledTasks.markerLabel", { name, time })}
      data-schedule-id={String(marker.schedule_id)}
      data-schedule-run-id={String(marker.schedule_run_id)}
    >
      <span className="scheduled-message-marker__line" aria-hidden="true" />
      <span className="scheduled-message-marker__content">
        <Icon name="calendar" size={13} />
        <span>{t("scheduledTasks.marker")}</span>
        <strong>{name}</strong>
        {time ? <time dateTime={marker.scheduled_for}>{time}</time> : null}
      </span>
      <span className="scheduled-message-marker__line" aria-hidden="true" />
    </article>
  );
}
