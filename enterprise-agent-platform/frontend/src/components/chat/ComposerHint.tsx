/* <ComposerHint/> — the keyboard hint under the composer field (legacy composer
   hint, :736-739). */

import { useI18n } from "../../i18n";

export function ComposerHint() {
  const { t } = useI18n();
  return (
    <div className="composer__hint">
      <span className="kbd">Enter</span>
      <span>{t("chat.composer.send")}</span>
      <span className="kbd">Shift+Enter</span>
      <span>{t("chat.composer.newLine")}</span>
    </div>
  );
}
