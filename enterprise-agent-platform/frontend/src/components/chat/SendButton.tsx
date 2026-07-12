/* <SendButton/> — the composer submit button (legacy composer send button, :731).
   type="submit" so it triggers the enclosing <form>'s onSubmit. */

import { useI18n } from "../../i18n";
import { Icon } from "../common/Icon";

export function SendButton({ disabled }: { disabled: boolean }) {
  const { t } = useI18n();
  return (
    <button
      className="btn btn--primary composer__send"
      type="submit"
      title={t("chat.composer.sendTitle")}
      aria-label={t("chat.composer.send")}
      disabled={disabled}
    >
      <Icon name="send" size={18} />
    </button>
  );
}
