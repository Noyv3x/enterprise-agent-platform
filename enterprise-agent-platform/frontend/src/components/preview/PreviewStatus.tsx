import { cx } from "../../lib/cx";
import { useI18n } from "../../i18n";
import type { PreviewConnection } from "./useBrowserPreview";

export function PreviewStatus({
  connection,
  idle = false,
}: {
  connection: PreviewConnection;
  idle?: boolean;
}) {
  const { t } = useI18n();
  const label = connection === "connecting"
    ? t("preview.connecting")
    : connection === "disconnected"
      ? t("preview.disconnected")
      : `${t("preview.connected")} · ${idle ? t("preview.waiting") : t("preview.live")}`;
  return (
    <span
      className={cx(
        "status",
        connection === "connected" && !idle && "status--ok",
        (connection === "disconnected" || idle) && "status--warn",
      )}
    >
      <span
        className={cx(
          "dot",
          connection === "connected" && !idle && "dot--pulse",
          (connection === "disconnected" || idle) && "dot--warn",
          connection === "connecting" && "dot--off",
        )}
      />
      {label}
    </span>
  );
}
