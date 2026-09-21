import { Button } from "antd";
import { useI18n } from "../../i18n";
import { Glyph } from "../ui/fieldwork";

/** Icon-only submit; the visible name lives in the composer hint and the accessible name in `aria-label`. */
export function SendButton({ disabled, loading = false }: { disabled: boolean; loading?: boolean }) {
  const { t } = useI18n();
  return <Button className="wf-composer-send" type="primary" shape="circle" htmlType="submit" disabled={disabled} loading={loading}
    aria-label={t("chat.composer.send")} title={t("chat.composer.sendTitle")} icon={<Glyph name="arrowUp" size={18} />} />;
}
