/* <SendButton/> — type="submit" triggers the enclosing form's onSubmit. */

import { useI18n } from "../../i18n";
import { Button, Tooltip } from "antd";
import { Icon } from "../common/Icon";

export function SendButton({ disabled, loading = false }: { disabled: boolean; loading?: boolean }) {
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
        loading={loading}
        icon={<Icon name="send" size={18} />}
      />
    </Tooltip>
  );
}
