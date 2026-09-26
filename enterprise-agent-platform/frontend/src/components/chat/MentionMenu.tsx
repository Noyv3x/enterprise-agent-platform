import { useI18n } from "../../i18n";
import type { MentionApi } from "../../hooks/useMention";
import { MENU_PANEL, MENU_ROW } from "./composerMenu";

/** Beautiful UI Prompt Bar "@" menu: rows grow up from the bar; the keyboard-selected row carries the hover fill. */
export function MentionMenu({ mention }: { mention: MentionApi }) {
  const { t } = useI18n();
  return <div className={MENU_PANEL} id={mention.menuId} role="listbox" aria-label={t("chat.mentions.label")} hidden={!mention.active}>
    {mention.active && mention.options.map((option, index) => <button
      type="button" role="option" tabIndex={-1}
      className={MENU_ROW} key={`${option.kind}:${option.handle}:${index}`}
      id={mention.optionId(index)} aria-selected={index === mention.selected}
      onMouseDown={(event) => { event.preventDefault(); mention.choose(index); }}
      onMouseEnter={() => mention.hover(index)}
    >
      <span className="shrink-0 text-[12.5px] font-medium text-ink">{option.label || option.handle}</span>
      <span className="shrink-0 font-mono text-[11.5px] text-ink-3">@{option.handle}</span>
      {(option.kind === "agent" || option.description) && <span className="min-w-0 flex-1 truncate text-right text-[12px] text-ink-3">{option.kind === "agent" ? t("mention.agentDescription") : option.description}</span>}
    </button>)}
  </div>;
}
