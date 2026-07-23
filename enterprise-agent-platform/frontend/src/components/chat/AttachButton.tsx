/* <AttachButton/> — the composer paperclip that opens the hidden file input
   (legacy composer attach button, :721-728). */

import { useI18n } from "../../i18n";
import { Button, Tooltip } from "antd";
import { Icon } from "../common/Icon";

export function AttachButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t } = useI18n();
  return (
    <Tooltip title={t("chat.attach.add")}>
      <Button
        className="composer__attach"
        type="text"
        shape="circle"
        aria-label={t("chat.attach.add")}
        disabled={disabled}
        icon={<Icon name="paperclip" size={18} />}
        onClick={onClick}
      />
    </Tooltip>
  );
}
