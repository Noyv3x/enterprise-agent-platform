import { useI18n } from "../../i18n";
import type { MentionApi } from "../../hooks/useMention";

export function MentionMenu({ mention }: { mention: MentionApi }) {
  const { t } = useI18n();
  return <div className="wf-draft-options" id={mention.menuId} role="listbox" aria-label={t("chat.mentions.label")} hidden={!mention.active}>
    {mention.active && mention.options.map((option, index) => <button
      type="button" role="option" tabIndex={-1}
      className="wf-draft-option" key={`${option.kind}:${option.handle}:${index}`}
      id={mention.optionId(index)} aria-selected={index === mention.selected}
      onMouseDown={(event) => { event.preventDefault(); mention.choose(index); }}
      onMouseEnter={() => mention.hover(index)}
    >
      <span><strong>{option.label || option.handle}</strong><span className="wf-draft-option-meta">@{option.handle}</span></span>
      {(option.kind === "agent" || option.description) && <span className="wf-draft-option-description">{option.kind === "agent" ? t("mention.agentDescription") : option.description}</span>}
    </button>)}
  </div>;
}
