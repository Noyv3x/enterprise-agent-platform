import { useI18n } from "../../i18n";
import { Overlay } from "../ui/beautiful/Overlay";
import type { DialogProps } from "./Dialog";

export function Drawer(props: DialogProps) {
  const { t } = useI18n();
  return <Overlay {...props} closeLabel={t("common.close")} placement="right" />;
}
