import { Spin } from "antd";
import { useI18n } from "../../i18n";

export function Spinner({ size = 18 }: { size?: number }) {
  const { t } = useI18n();
  return (
    <Spin
      className="eap-spinner"
      size={size >= 22 ? "default" : "small"}
      aria-label={t("common.loading")}
    />
  );
}
