import { useI18n } from "../../i18n";

const KEY = "rounded-[4px] bg-field px-1 py-px font-mono text-[10.5px] text-ink-2 shadow-hairline";

export function ComposerHint() {
  const { t } = useI18n();
  return <span className="flex flex-wrap gap-3">
    <span><kbd className={KEY}>Enter</kbd> {t("chat.composer.send")}</span>
    <span><kbd className={KEY}>Shift+Enter</kbd> {t("chat.composer.newLine")}</span>
  </span>;
}
