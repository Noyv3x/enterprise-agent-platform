import { Button } from "antd";

import { useI18n } from "../../i18n";

export function SlashCommandMenu({
  visible,
  onChoose,
  menuId,
  optionId,
}: {
  visible: boolean;
  onChoose: () => void;
  menuId: string;
  optionId: string;
}) {
  const { t } = useI18n();
  return (
    <div
      className="mention-menu slash-command-menu"
      role="listbox"
      aria-label={t("chat.commands.label")}
      id={menuId}
      hidden={!visible}
    >
      {visible ? (
        <Button
          className="mention-option slash-command-option is-active"
          type="text"
          htmlType="button"
          role="option"
          id={optionId}
          aria-selected="true"
          tabIndex={-1}
          onMouseDown={(event) => {
            event.preventDefault();
          }}
          onClick={onChoose}
        >
          <span className="mention-option__avatar slash-command-option__mark">/</span>
          <span className="mention-option__main">
            <span className="mention-option__label">/compact</span>
            <span className="mention-option__meta">{t("chat.commands.compactDescription")}</span>
          </span>
        </Button>
      ) : null}
    </div>
  );
}
