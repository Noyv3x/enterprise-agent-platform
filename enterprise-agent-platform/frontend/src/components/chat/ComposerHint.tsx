import { useI18n } from "../../i18n";

export function ComposerHint() {
  const { t } = useI18n();
  return <span className="bui-draft-hint"><span><kbd>Enter</kbd> {t("chat.composer.send")}</span><span><kbd>Shift+Enter</kbd> {t("chat.composer.newLine")}</span></span>;
}
