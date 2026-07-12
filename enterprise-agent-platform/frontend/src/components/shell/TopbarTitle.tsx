/* <TopbarTitle/> — the contextual title + subtitle (legacy topbarInfo +
   renderTopbar title block, legacy-app.js:527-533, 561-571). Uses the topbarInfo
   selector with a shallow comparator so unrelated store changes don't re-render
   the title. When info.hash the prefix is a # span; otherwise an icon. */

import { useI18n } from "../../i18n";
import { topbarInfo } from "../../store/selectors";
import { useStore } from "../../store/useStore";
import type { TopbarInfo } from "../../types";
import { Icon } from "../common/Icon";

function infoEqual(a: TopbarInfo, b: TopbarInfo): boolean {
  return a.title === b.title && a.icon === b.icon && a.hash === b.hash && a.sub === b.sub;
}

export function TopbarTitle() {
  const { t } = useI18n();
  const info = useStore((state) => topbarInfo(state, t), infoEqual);
  return (
    <div className="topbar__title-wrap">
      <div className="topbar__title">
        {info.hash ? (
          <span className="hash">#</span>
        ) : info.icon ? (
          <Icon name={info.icon} size={18} cls="muted" />
        ) : null}
        <span>{info.title}</span>
      </div>
      {info.sub ? <div className="topbar__sub">{info.sub}</div> : null}
    </div>
  );
}
