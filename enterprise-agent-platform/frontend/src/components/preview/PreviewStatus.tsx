import { useI18n } from "../../i18n";
import { StatusMark } from "../ui/fieldwork";
import type { PreviewConnection } from "./useBrowserPreview";

export function PreviewStatus({connection,idle=false}: {connection:PreviewConnection;idle?:boolean}) {
  const {t}=useI18n();
  const text=connection === "connecting" ? t("preview.connecting") : connection === "disconnected" ? t("preview.disconnected") : `${t("preview.connected")} · ${t(idle ? "preview.waiting" : "preview.live")}`;
  return <StatusMark tone={connection === "disconnected" ? "warning" : connection === "connecting" ? "info" : idle ? "neutral" : "success"}>{text}</StatusMark>;
}
