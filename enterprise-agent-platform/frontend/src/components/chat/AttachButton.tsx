/* <AttachButton/> — the composer paperclip that opens the hidden file input
   (legacy composer attach button, :721-728). */

import { useI18n } from "../../i18n";
import { Icon } from "../common/Icon";

export function AttachButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <button
      className="icon-btn composer__attach"
      type="button"
      title={t("chat.attach.add")}
      aria-label={t("chat.attach.add")}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name="paperclip" size={18} />
    </button>
  );
}
