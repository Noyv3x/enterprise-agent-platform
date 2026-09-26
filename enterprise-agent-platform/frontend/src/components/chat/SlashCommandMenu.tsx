import { useI18n } from "../../i18n";
import { MENU_PANEL, MENU_ROW } from "./composerMenu";

/** Beautiful UI Prompt Bar "/" menu. */
export function SlashCommandMenu({ visible, onChoose, menuId, optionId }: { visible: boolean; onChoose: () => void; menuId: string; optionId: string }) {
  const { t } = useI18n();
  return <div className={MENU_PANEL} role="listbox" id={menuId} aria-label={t("chat.commands.label")} hidden={!visible}>
    {visible && <button className={MENU_ROW} type="button" role="option" id={optionId} tabIndex={-1} aria-selected="true"
      onMouseDown={(event) => event.preventDefault()} onClick={onChoose}>
      <code className="shrink-0 text-[12.5px] font-medium text-ink">/compact</code>
      <span className="min-w-0 flex-1 truncate text-[12px] text-ink-3">{t("chat.commands.compactDescription")}</span>
    </button>}
  </div>;
}
