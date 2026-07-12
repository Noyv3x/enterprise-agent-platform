/* <MentionMenu/> — the in-field @mention autocomplete popover (legacy
   renderMentionMenu, :1075-1109). role=listbox; channel-only (in private mode the
   mention API is never active so this stays hidden). Positioned absolutely within
   `.composer__field` by CSS (bottom: calc(100% + 8px)).

   Option selection fires on onMouseDown + preventDefault (NOT onClick) so the
   textarea keeps focus and the blur-hide timer never wins first (plan §1.4). */

import { cx } from "../../lib/cx";
import { useI18n } from "../../i18n";
import { initials } from "../../utils/format";
import type { MentionApi } from "../../hooks/useMention";

export function MentionMenu({ mention }: { mention: MentionApi }) {
  const { t } = useI18n();
  const { active, options, selected, menuId, optionId, choose, hover } = mention;
  return (
    <div
      className="mention-menu"
      role="listbox"
      aria-label={t("chat.mentions.label")}
      id={menuId}
      hidden={!active}
    >
      {active &&
        options.map((option, index) => {
          const description = option.kind === "agent" ? t("mention.agentDescription") : option.description;
          return (
          <button
            key={`${option.kind || "user"}:${option.handle}:${index}`}
            className={cx("mention-option", index === selected && "is-active")}
            type="button"
            role="option"
            tabIndex={-1}
            id={optionId(index)}
            aria-selected={index === selected}
            onMouseDown={(event) => {
              event.preventDefault();
              choose(index);
            }}
            onMouseEnter={() => hover(index)}
          >
            <span className={cx("mention-option__avatar", `mention-option__avatar--${option.kind || "user"}`)}>
              {option.kind === "agent" ? "A" : initials(option.label || option.handle)}
            </span>
            <span className="mention-option__main">
              <span className="mention-option__label">{option.label || option.handle}</span>
              <span className="mention-option__meta">{`@${option.handle}`}</span>
            </span>
            {description ? <span className="mention-option__desc">{description}</span> : null}
          </button>
          );
        })}
    </div>
  );
}
