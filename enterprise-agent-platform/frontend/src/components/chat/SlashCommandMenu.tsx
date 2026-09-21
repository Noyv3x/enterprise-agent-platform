import { useI18n } from "../../i18n";

export function SlashCommandMenu({ visible, onChoose, menuId, optionId }: { visible: boolean; onChoose: () => void; menuId: string; optionId: string }) {
  const { t } = useI18n();
  return <div className="wf-draft-options" role="listbox" id={menuId} aria-label={t("chat.commands.label")} hidden={!visible}>
    {visible && <button className="wf-draft-option" type="button" role="option" id={optionId} tabIndex={-1} aria-selected="true"
      onMouseDown={(event) => event.preventDefault()} onClick={onChoose}>
      <code>/compact</code><span className="wf-draft-option-description">{t("chat.commands.compactDescription")}</span>
    </button>}
  </div>;
}
