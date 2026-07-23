/* <SendButton/> — the composer submit button (legacy composer send button, :731).
   type="submit" so it triggers the enclosing <form>'s onSubmit. */

import { useI18n } from "../../i18n";
import { Button, Tooltip } from "antd";
import { Icon } from "../common/Icon";

export function SendButton({ disabled }: { disabled: boolean }) {
  const { t } = useI18n();
  return (
    <Tooltip title={t("chat.composer.sendTitle")}>
      <Button
        className="composer__send"
        type="primary"
        shape="circle"
        htmlType="submit"
        aria-label={t("chat.composer.send")}
        disabled={disabled}
        icon={<Icon name="send" size={18} />}
      />
    </Tooltip>
  );
}
