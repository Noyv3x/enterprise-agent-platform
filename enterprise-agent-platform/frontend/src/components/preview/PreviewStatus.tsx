import { Badge } from "antd";
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
  const status = connection === "connecting"
    ? "processing"
    : connection === "disconnected" || idle
      ? "warning"
      : "success";
  return (
    <Badge
      className={`preview-status preview-status--${status}`}
      classNames={{ indicator: "preview-status__indicator" }}
      status={status}
      text={<span className="preview-status__label">{label}</span>}
    />
  );
}
