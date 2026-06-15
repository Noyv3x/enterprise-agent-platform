/* <MentionMenu/> — the in-field @mention autocomplete popover (legacy
   renderMentionMenu, :1075-1109). role=listbox; channel-only (in private mode the
   mention API is never active so this stays hidden). Positioned absolutely within
   `.composer__field` by CSS (bottom: calc(100% + 8px)).

   Option selection fires on onMouseDown + preventDefault (NOT onClick) so the
   textarea keeps focus and the blur-hide timer never wins first (plan §1.4). */

import { cx } from "../../lib/cx";
import { initials } from "../../utils/format";
import type { MentionApi } from "../../hooks/useMention";

export function MentionMenu({ mention }: { mention: MentionApi }) {
  const { active, options, selected, menuId, optionId, choose, hover } = mention;
  return (
    <div className="mention-menu" role="listbox" id={menuId} hidden={!active}>
      {active &&
        options.map((option, index) => (
          <button
            key={`${option.kind || "user"}:${option.handle}:${index}`}
            className={cx("mention-option", index === selected && "is-active")}
            type="button"
            role="option"
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
            {option.description ? <span className="mention-option__desc">{option.description}</span> : null}
          </button>
        ))}
    </div>
  );
}
